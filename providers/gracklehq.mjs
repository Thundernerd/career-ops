// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
/** @typedef {import('./_types.js').Job} Job */

// Grackle provider — a games-industry job board (https://gracklehq.com/jobs)
// that lists openings from game studios' own careers sites (Ubisoft, Riot,
// Valve, Jam City, ...): 2,403 postings on 2026-11-10. Wire in via a
// `job_boards:` entry with `provider: gracklehq` (or a `careers_url` on the
// board's host, auto-detected).
//
// LISTING. The site is server-rendered ASP.NET with no JSON API. `/jobs`
// shows 30 `div.joblisting` cards per page, newest first, paged with
// `?pageidx=N` (1-based; 0 renders page 1 as well). The last page's "Next"
// button carries `class="… disabled"`; a page past the end renders the same
// shell with no cards. A full walk was 82 requests, 145 s at 250 ms pacing
// (1–3 s per response), on 2026-11-10. An optional `gracklehq.search` narrows
// the walk with the board's own title search (`searchstring=`), which pages
// the same way. robots.txt is a 404.
//
// PARSING CONTRACT. Each card is
//   <div class="joblisting"><a href="/rd/{id}">{title}</a>
//     <div>{Company} - {Location}</div>
//     <div class="bottomright">{age}</div></div>
// where every one of the 2,403 cards carried exactly one " - " and the age is
// `<1d` or `{N}d`. The age becomes an approximate `postedAt` (day precision),
// which matters here: the board keeps postings up to 2,753 days old, and only
// 990 of 2,403 were 45 days old or newer, so `max_posting_age_days` does most
// of the filtering. A page that still carries `/rd/` links but parses to zero
// cards THROWS — a markup change must look like a broken board, never like an
// empty one. "0 results" with no card is the empty-board `[]`.
//
// URL. `/rd/{id}` is a 302 to the posting on the employer's own site or ATS
// (jobs.smartrecruiters.com, jobs.lever.co, jobs.jobvite.com, riotgames.com,
// and some LinkedIn or plain-http links). Source Indexing Policy rule 2 wants
// that employer URL as `url`, and it is what dedups against the ATS providers,
// so the provider reads each redirect's Location with a `redirect: 'manual'`
// request — never following it — for the postings the scan's title filter
// keeps (`ctx.titleWanted`), newest first, up to `gracklehq.resolveLimit`
// (default 50) per scan, 250 ms apart. A target never changes for an id, so
// each one is cached in `ctx.idCache` and costs one request ever. A posting
// left unresolved (over the limit, a failed request, a target that is not an
// absolute http(s) URL off this host) keeps the board's `/rd/{id}` URL, which
// still lands the user on the posting. Resolution is skipped while probing and
// with `resolveRedirects: false`.

import { fetchTextWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';
import { cachedLookup } from './_cached-lookup.mjs';

const ORIGIN = 'https://gracklehq.com';
const LISTING_URL = `${ORIGIN}/jobs`;
const TRUSTED_HOSTS = new Set(['gracklehq.com', 'www.gracklehq.com']);

/** 100 pages × 30 = 3,000 postings — the 2,403-posting board plus headroom. */
const DEFAULT_MAX_PAGES = 100;
/** Hard ceiling even for an explicit `max_pages` override. */
const MAX_PAGES_CAP = 200;
const INTER_PAGE_DELAY_MS = 250;
const PAGE_TIMEOUT_MS = 20_000;

const DEFAULT_RESOLVE_LIMIT = 50;
const RESOLVE_LIMIT_CAP = 500;
const RESOLVE_DELAY_MS = 250;
const RESOLVE_TIMEOUT_MS = 15_000;
/** A redirect target does not change for an id; recheck yearly at most. */
const RESOLVE_CACHE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

const DAY_MS = 86_400_000;

const CARD_RE = /<div\b[^>]*\bclass="joblisting"[^>]*>\s*<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>\s*<div\b[^>]*>([\s\S]*?)<\/div>(?:\s*<div\b[^>]*\bclass="bottomright"[^>]*>([\s\S]*?)<\/div>)?/gi;
/** The board's redirect path: `/rd/{digits}`, nothing else. */
const RD_PATH_RE = /^\/rd\/(\d{1,12})$/;
/** Listing signal for the silent-zero guard. */
const RD_HREF_RE = /href="\/rd\/\d+"/i;
const RESULTS_RE = /\bclass="jobsresultscountrow"[^>]*>\s*([\d,]+)\s+results?\b/i;
const NEXT_RE = /<a\b[^>]*\bhref="[^"]*pageidx=(\d+)"[^>]*\bclass="([^"]*)"[^>]*>\s*Next\s*<\/a>/i;
const AGE_RE = /^(?:(<)\s*)?(\d{1,5})\s*d$/i;

/**
 * Collapse a markup fragment to its visible text.
 * @param {string} fragment
 */
function visibleText(fragment) {
  return decodeEntities(String(fragment ?? '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The card's age badge (`<1d`, `12d`) as an approximate epoch ms.
 * Anything else → undefined, which the scan treats as "no date".
 * @param {string} text - Decoded badge text.
 * @param {number} [now]
 * @returns {number | undefined}
 */
export function parseAge(text, now = Date.now()) {
  const m = AGE_RE.exec(String(text ?? '').trim());
  if (!m) return undefined;
  const days = Number(m[2]);
  if (!Number.isFinite(days)) return undefined;
  if (m[1]) return now; // "<1d"
  return now - days * DAY_MS;
}

/**
 * Parse one listing page.
 *
 * `recognized` is false when the page carries neither a card nor the
 * "N results" row (a redesign, or not the listing page at all). `lastPage` is
 * true when the "Next" button is disabled or absent.
 *
 * @param {string} html
 * @param {number} [now]
 * @returns {{ jobs: (Job & { rdId: string })[], rawCount: number, recognized: boolean, total: number | null, lastPage: boolean }}
 */
export function parseListingPage(html, now = Date.now()) {
  const source = String(html ?? '');
  /** @type {(Job & { rdId: string })[]} */
  const jobs = [];
  let rawCount = 0;
  for (const m of source.matchAll(CARD_RE)) {
    rawCount++;
    const rd = RD_PATH_RE.exec(decodeEntities(m[1]).trim());
    if (!rd) continue;
    const title = visibleText(m[2]);
    if (!title) continue;
    const line = visibleText(m[3]);
    const sep = line.indexOf(' - ');
    const company = sep >= 0 ? line.slice(0, sep).trim() : line;
    const location = sep >= 0 ? line.slice(sep + 3).trim() : '';
    /** @type {Job & { rdId: string }} */
    const job = { title, url: `${ORIGIN}/rd/${rd[1]}`, company, location, rdId: rd[1] };
    const postedAt = m[4] === undefined ? undefined : parseAge(visibleText(m[4]), now);
    if (postedAt !== undefined) job.postedAt = postedAt;
    jobs.push(job);
  }
  const results = RESULTS_RE.exec(source);
  const total = results ? Number(results[1].replace(/,/g, '')) : null;
  const next = NEXT_RE.exec(source);
  const lastPage = !next || /\bdisabled\b/.test(next[2]);
  return { jobs, rawCount, recognized: rawCount > 0 || total !== null, total, lastPage };
}

/**
 * Throw when a page still carries `/rd/` links but no card parsed — the
 * markup changed, and returning [] would read as an empty board.
 * @param {string} html
 * @param {string} url
 */
export function assertParsedSomething(html, url) {
  if (!RD_HREF_RE.test(String(html ?? ''))) return;
  throw new Error(`gracklehq: ${url} still contains posting links but none could be parsed — the listing markup changed`);
}

/**
 * The employer URL a `/rd/{id}` Location points at, or null when it is not an
 * absolute http(s) URL off the board's own host.
 * @param {unknown} location
 * @returns {string | null}
 */
export function acceptRedirectTarget(location) {
  if (typeof location !== 'string' || !location.trim()) return null;
  let u;
  try {
    u = new URL(location.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!u.hostname || TRUSTED_HOSTS.has(u.hostname.toLowerCase())) return null;
  if (u.username || u.password) return null;
  return u.href;
}

/**
 * @param {unknown} v
 * @param {number} dflt
 * @param {number} min
 * @param {number} max
 */
function intInRange(v, dflt, min, max) {
  return Number.isInteger(v) && /** @type {number} */ (v) >= min ? Math.min(/** @type {number} */ (v), max) : dflt;
}

/** @param {any} entry */
function resolveConfig(entry) {
  const cfg = entry?.gracklehq && typeof entry.gracklehq === 'object' ? entry.gracklehq : {};
  const search = typeof cfg.search === 'string' ? cfg.search.trim() : '';
  return {
    maxPages: intInRange(entry?.max_pages, DEFAULT_MAX_PAGES, 1, MAX_PAGES_CAP),
    // Config-derived: encoded once, and a broken value throws here, loudly.
    searchParam: search ? `searchstring=${encodeURIComponent(search)}&` : '',
    resolveRedirects: cfg.resolveRedirects !== false,
    resolveLimit: intInRange(cfg.resolveLimit, DEFAULT_RESOLVE_LIMIT, 1, RESOLVE_LIMIT_CAP),
  };
}

/** @param {unknown} raw */
function isBoardUrl(raw) {
  if (typeof raw !== 'string' || !raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && TRUSTED_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Read one `/rd/{id}` redirect's Location without following it.
 * @param {any} ctx
 * @param {string} rdUrl
 * @returns {Promise<string>}
 */
async function readRedirect(ctx, rdUrl) {
  try {
    await fetchTextWithRetry(ctx, rdUrl, { redirect: 'manual', timeoutMs: RESOLVE_TIMEOUT_MS });
  } catch (err) {
    const status = /** @type {any} */ (err)?.status;
    if (typeof status === 'number' && status >= 300 && status < 400) {
      const target = acceptRedirectTarget(/** @type {any} */ (err).location);
      if (target) return target;
      throw new Error(`gracklehq: ${rdUrl} redirects to an unusable target`);
    }
    throw err;
  }
  throw new Error(`gracklehq: ${rdUrl} answered without a redirect`);
}

/**
 * Swap `/rd/{id}` URLs for the employer URLs they redirect to, for the
 * postings the scan's title filter keeps, bounded by `limit`.
 * @param {(Job & { rdId?: string })[]} jobs
 * @param {any} ctx
 * @param {string} name
 * @param {number} limit
 */
async function resolveUrls(jobs, ctx, name, limit) {
  const titleWanted = typeof ctx?.titleWanted === 'function' ? ctx.titleWanted : null;
  const wanted = titleWanted ? jobs.filter((job) => titleWanted(job.title)) : jobs;
  let requests = 0;
  let resolved = 0;
  let skipped = 0;
  for (const job of wanted) {
    const id = job.rdId;
    if (!id) continue;
    const key = `rd:${id}`;
    const cached = ctx?.idCache?.get(key);
    const isCached = typeof cached?.id === 'string' && acceptRedirectTarget(cached.id) !== null;
    if (!isCached && requests >= limit) {
      skipped++;
      continue;
    }
    if (!isCached) {
      if (requests > 0) await sleep(RESOLVE_DELAY_MS, ctx);
      requests++;
    }
    try {
      job.url = await cachedLookup(ctx?.idCache, key, () => readRedirect(ctx, job.url), {
        isValid: (v) => typeof v === 'string' && acceptRedirectTarget(v) !== null,
        maxAgeMs: RESOLVE_CACHE_MAX_AGE_MS,
      });
      resolved++;
    } catch {
      // Keep the board's /rd/{id} URL: it still lands on the posting.
    }
  }
  if (skipped > 0) {
    console.error(`⚠️  gracklehq: ${name} resolved ${resolved} employer URLs; ${skipped} more kept the board's /rd/ link — raise gracklehq.resolveLimit on this entry to resolve them`);
  }
}

/** @type {Provider} */
export default {
  id: 'gracklehq',

  detect(entry) {
    if (entry?.provider === 'gracklehq' || isBoardUrl(entry?.careers_url) || isBoardUrl(entry?.api)) {
      return { url: LISTING_URL };
    }
    return null;
  },

  async fetch(entry, ctx) {
    const name = entry?.name || 'Grackle';
    const cfg = resolveConfig(entry);
    // ctx.maxPages is set only by verify-portals' liveness probe.
    const probing = Number.isInteger(ctx?.maxPages) && /** @type {number} */ (ctx.maxPages) > 0;
    const pagesToFetch = probing ? Math.min(cfg.maxPages, /** @type {number} */ (ctx.maxPages)) : cfg.maxPages;
    const opts = { redirect: /** @type {const} */ ('error'), timeoutMs: PAGE_TIMEOUT_MS };
    const now = Date.now();
    const pageUrl = (/** @type {number} */ page) => `${LISTING_URL}?${cfg.searchParam}pageidx=${page}`;

    // Page 1 is never wrapped: if the board can't be read at all, that is a
    // failure, not an empty board.
    let page = 1;
    let url = pageUrl(page);
    let html = await fetchTextWithRetry(ctx, url, opts);
    let parsed = parseListingPage(html, now);
    if (parsed.jobs.length === 0) assertParsedSomething(html, url);
    if (!parsed.recognized) {
      throw new Error(`gracklehq: ${url} is not a job listing (no job cards, no results count)`);
    }

    /** @type {(Job & { rdId?: string })[]} */
    const jobs = [];
    const seen = new Set();
    /** @type {'complete' | 'cap' | 'fetch-error' | 'unrecognized'} */
    let stopReason = 'complete';
    for (;;) {
      for (const job of parsed.jobs) {
        // New postings shift the list while it is walked; a card can repeat.
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        jobs.push(job);
      }
      if (parsed.lastPage || parsed.jobs.length === 0) break;
      if (page >= pagesToFetch) {
        if (!probing) stopReason = 'cap';
        break;
      }
      page++;
      url = pageUrl(page);
      await sleep(INTER_PAGE_DELAY_MS, ctx);
      try {
        html = await fetchTextWithRetry(ctx, url, opts);
      } catch (err) {
        if (probing) throw err;
        console.error(`⚠️  gracklehq: ${name} stopped at page ${page} (${jobs.length} jobs kept): ${(err && /** @type {any} */ (err).message) || err}`);
        stopReason = 'fetch-error';
        break;
      }
      parsed = parseListingPage(html, now);
      if (!parsed.recognized || (parsed.jobs.length === 0 && RD_HREF_RE.test(html))) {
        console.error(`⚠️  gracklehq: ${name} page ${page} could not be parsed — kept ${jobs.length} jobs from earlier pages`);
        stopReason = 'unrecognized';
        break;
      }
    }

    if (stopReason === 'cap') {
      console.error(`⚠️  gracklehq: ${name} truncated at max_pages=${cfg.maxPages} (${jobs.length} jobs) — raise max_pages on this entry for more`);
    }

    if (!probing && cfg.resolveRedirects) await resolveUrls(jobs, ctx, name, cfg.resolveLimit);
    for (const job of jobs) delete job.rdId;
    return jobs;
  },
};
