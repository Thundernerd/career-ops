// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Work With Indies provider — a job board for independent game studios
// (https://www.workwithindies.com), where studios post their own openings
// (art, audio, design, programming, production, QA, writing, marketing). Wire
// in via a `job_boards:` entry with `provider: workwithindies` (or a
// `careers_url` on the board's host, auto-detected).
//
// Why HTML and not the RSS feed: the site is Webflow, and its
// `/careers/rss.xml` is a fixed 100-item window by publication date that
// keeps closed postings. Measured 2026-10-20: the feed held 100 items, 18 of
// them closed (their detail pages show the "closed" notice), while 17 open
// postings from early September were missing from it. The homepage instead
// renders every open posting in one Webflow collection list — 99 cards that
// day, none closed, no pagination. Webflow caps a collection list at 100
// items per page and paginates past that with a `?{listId}_page=N` link
// (`a.w-pagination-next`), so the provider follows that link, bounded by its
// own page ceiling. The `/categories/*` pages are filtered views of the same
// list and are never read. robots.txt (fetched 2026-10-20) disallows nothing.
//
// PARSING CONTRACT. Each card is an `<a href="/careers/{slug}" class="job-card
// …">`. Its mobile block holds the title (`div.text-block-14`) and, as
// `div.job-card-text-smol` cells, the studio name and location. The desktop
// block phrases the card as either "…to join their team in {place}" (on-site
// or hybrid) or "…to work from {place}" (remote); the phrase not in use is
// hidden with `w-condition-invisible`, and a remote card's location reads
// `Remote` or `Remote · {region/timezone}`. A page that still carries posting
// hrefs but parses to zero cards THROWS — a markup change must look like a
// broken board, never like an empty one. An empty collection renders
// Webflow's `w-dyn-empty` block, which is the empty-board `[]`.
//
// The apply link (often an email address or a Google Form) lives only on the
// detail page, so `url` is the board's own posting page; the list carries no
// date either.

import { fetchTextWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

const ORIGIN = 'https://www.workwithindies.com';
const LISTING_URL = `${ORIGIN}/`;
const TRUSTED_HOSTS = new Set(['www.workwithindies.com', 'workwithindies.com']);

/** 10 pages of Webflow's 100-item maximum — ten times the board on 2026-10-20. */
const DEFAULT_MAX_PAGES = 10;
/** Hard ceiling even for an explicit `max_pages` override. */
const MAX_PAGES_CAP = 30;

const INTER_PAGE_DELAY_MS = 250;

const CARD_RE = /<a\b[^>]*\bhref="(\/careers\/[^"]*)"[^>]*\bclass="job-card\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
// The capture keeps the last cell's own `</div>`; only the block's is outside it.
const MOBILE_RE = /<div\b[^>]*\bclass="job-link-mobile"[^>]*>([\s\S]*?<\/div>)\s*<\/div>/i;
const DESKTOP_RE = /<div\b[^>]*\bclass="job-link-desktop"[^>]*>([\s\S]*?<\/div>)\s*<\/div>/i;
const MOBILE_TITLE_RE = /<div\b[^>]*\bclass="text-block-14"[^>]*>([\s\S]*?)<\/div>/i;
const SMOL_CELL_RE = /<div\b[^>]*\bclass="job-card-text-smol"[^>]*>([\s\S]*?)<\/div>/gi;
const DESKTOP_CELL_RE = /<div\b[^>]*\bclass="([^"]*)"[^>]*>([\s\S]*?)<\/div>/gi;
/** A posting detail path: one slug segment, no query/fragment, no traversal. */
const POSTING_PATH_RE = /^\/careers\/[a-z0-9][a-z0-9-]*$/i;
/** Listing signal for the silent-zero guard. */
const POSTING_HREF_RE = /href="\/careers\/[a-z0-9][a-z0-9-]*"/i;
const EMPTY_LIST_RE = /\bclass="[^"]*\bw-dyn-empty\b/;
const LIST_ITEM_RE = /\bclass="[^"]*\bw-dyn-item\b/;
const NEXT_LINK_RE = /<a\b[^>]*\bclass="[^"]*\bw-pagination-next\b[^>]*>/i;
const HREF_ATTR_RE = /\bhref="([^"]*)"/i;
/** Webflow's pagination query: `?{listId}_page=N`, nothing else. */
const PAGE_QUERY_RE = /^\?([A-Za-z0-9]+)_page=(\d+)$/;
const ANYWHERE_RE = /^anywhere$/i;

/**
 * Collapse a markup fragment to its visible text.
 * @param {string} fragment
 */
function visibleText(fragment) {
  return decodeEntities(String(fragment ?? '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether the card's visible desktop phrasing is the remote one ("to work from").
 * @param {string} card
 */
function isRemoteCard(card) {
  const desktop = DESKTOP_RE.exec(card);
  if (!desktop) return false;
  for (const m of desktop[1].matchAll(DESKTOP_CELL_RE)) {
    if (/\bw-condition-invisible\b/.test(m[1])) continue;
    if (/^to work from$/i.test(visibleText(m[2]))) return true;
  }
  return false;
}

/**
 * Parse one listing page.
 *
 * `recognized` is false when the page carries neither a card nor Webflow's
 * empty-collection block (a redesign, or not the listing page at all).
 *
 * @param {string} html
 * @returns {{ jobs: {title: string, url: string, company: string, location: string}[], rawCount: number, recognized: boolean, nextQuery: string | null }}
 */
export function parseListingPage(html) {
  const source = String(html ?? '');
  const jobs = [];
  let rawCount = 0;
  for (const m of source.matchAll(CARD_RE)) {
    rawCount++;
    const path = decodeEntities(m[1]).trim();
    if (!POSTING_PATH_RE.test(path)) continue;
    const card = m[2];
    const mobile = MOBILE_RE.exec(card);
    if (!mobile) continue;
    const titleMatch = MOBILE_TITLE_RE.exec(mobile[1]);
    const title = titleMatch ? visibleText(titleMatch[1]) : '';
    if (!title) continue;
    // Cells: studio, " | ", location.
    const cells = [...mobile[1].matchAll(SMOL_CELL_RE)].map((c) => visibleText(c[1])).filter((t) => t && t !== '|');
    const company = cells[0] || '';
    const place = cells[1] || '';
    let location = place;
    if (isRemoteCard(card)) {
      location = !place || ANYWHERE_RE.test(place) ? 'Remote' : `Remote · ${place}`;
    }
    jobs.push({ title, url: `${ORIGIN}${path.toLowerCase()}`, company, location });
  }
  const recognized = rawCount > 0 || LIST_ITEM_RE.test(source) || EMPTY_LIST_RE.test(source);
  return { jobs, rawCount, recognized, nextQuery: parseNextQuery(source) };
}

/**
 * The `?{listId}_page=N` query of the collection list's "next" link, or null
 * when there is none (the last page) or it is not in Webflow's shape.
 * @param {string} html
 * @returns {string | null}
 */
export function parseNextQuery(html) {
  const tag = NEXT_LINK_RE.exec(String(html ?? ''));
  if (!tag) return null;
  const href = HREF_ATTR_RE.exec(tag[0]);
  if (!href) return null;
  const query = decodeEntities(href[1]).trim();
  return PAGE_QUERY_RE.test(query) ? query : null;
}

/**
 * Throw when a page still carries posting links but no card parsed — the
 * markup changed, and returning [] would read as an empty board.
 * @param {string} html
 * @param {string} url
 */
export function assertParsedSomething(html, url) {
  if (!POSTING_HREF_RE.test(String(html ?? ''))) return;
  throw new Error(`workwithindies: ${url} still contains posting links but none could be parsed — the listing markup changed`);
}

/** @param {any} entry */
function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
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

/** @type {Provider} */
export default {
  id: 'workwithindies',

  detect(entry) {
    if (entry?.provider === 'workwithindies' || isBoardUrl(entry?.careers_url) || isBoardUrl(entry?.api)) {
      return { url: LISTING_URL };
    }
    return null;
  },

  async fetch(entry, ctx) {
    const name = entry?.name || 'Work With Indies';
    const maxPages = resolveMaxPages(entry);
    // ctx.maxPages is set only by verify-portals' liveness probe.
    const probing = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0;
    const pagesToFetch = probing ? Math.min(maxPages, ctx.maxPages) : maxPages;
    const opts = { redirect: 'error', timeoutMs: 15_000 };

    // Page 1 is never wrapped: if the board can't be read at all, that is a
    // failure, not an empty board.
    let url = LISTING_URL;
    let html = await fetchTextWithRetry(ctx, url, opts);
    let parsed = parseListingPage(html);
    if (parsed.jobs.length === 0) assertParsedSomething(html, url);
    if (!parsed.recognized) {
      throw new Error(`workwithindies: ${url} is not a job listing (no job cards, no collection list)`);
    }

    const jobs = [];
    const seen = new Set();
    /** @type {'complete' | 'cap' | 'fetch-error' | 'unrecognized'} */
    let stopReason = 'complete';
    let page = 1;
    for (;;) {
      for (const job of parsed.jobs) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        jobs.push(job);
      }
      // No "next" link: the list ended on its own, even at the cap.
      const next = parsed.nextQuery;
      if (!next || Number(PAGE_QUERY_RE.exec(next)?.[2]) !== page + 1) break;
      if (page >= pagesToFetch) {
        if (!probing) stopReason = 'cap';
        break;
      }
      page++;
      url = `${ORIGIN}/${next}`;
      await sleep(INTER_PAGE_DELAY_MS, ctx);
      try {
        html = await fetchTextWithRetry(ctx, url, opts);
      } catch (err) {
        if (probing) throw err;
        console.error(`⚠️  workwithindies: ${name} stopped at page ${page} (${jobs.length} jobs kept): ${(err && err.message) || err}`);
        stopReason = 'fetch-error';
        break;
      }
      parsed = parseListingPage(html);
      if (!parsed.recognized || (parsed.jobs.length === 0 && POSTING_HREF_RE.test(html))) {
        console.error(`⚠️  workwithindies: ${name} page ${page} could not be parsed — kept ${jobs.length} jobs from earlier pages`);
        stopReason = 'unrecognized';
        break;
      }
    }

    if (stopReason === 'cap') {
      console.error(`⚠️  workwithindies: ${name} truncated at max_pages=${maxPages} (${jobs.length} jobs) — raise max_pages on this entry for more`);
    }
    return jobs;
  },
};
