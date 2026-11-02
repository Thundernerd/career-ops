// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// GameJobs.co provider — a games-industry job board (https://gamejobs.co)
// that lists studio openings (7,270 postings on 2026-11-02) and links each one
// to the studio's own ATS or careers page. Wire in via a `job_boards:` entry
// with `provider: gamejobs` (or a `careers_url` on the board's host,
// auto-detected).
//
//   job_boards:
//     - name: GameJobs.co
//       provider: gamejobs
//       gamejobs:
//         searches:            # optional; omitted = the whole board
//           - { t: Engineering, w: Netherlands }
//           - { t: Engineering, w: Remote }
//         fetchDetails: true   # optional; location + employer link per posting
//         detailLimit: 100     # 1..1000, default 100 uncached lookups per scan
//
// A search takes the site's own filter keys: `q` (keywords), `w` (where — a
// proximity search, so "Netherlands" also returns Belgian cities), `t` (team:
// Engineering, Art, Design, …), `e` (experience: Senior, Lead, …), `k` (kind:
// Full Time, Contract, …) and `c` (company).
//
// Why the Atom feed: the HTML search results show 100 postings and send page 2
// to a login page; the site's own advertised feed (`format=atom`, with
// `rel="next"` page links) serves every page without an account. Its entries
// carry only "{title} at {company}", the posting link and a date — no
// location. Measured 2026-11-02: `t=Engineering` was 1,677 postings over 17
// pages, ending on a short page with no next link. The unfiltered feed does
// not end: past its last page it serves page 1 again with a next link to
// page 2, so a page carrying no posting new to the walk ends it.
//
// Location and the employer link come from each posting's page, whose JSON-LD
// JobPosting names the place (`jobLocation`, `jobLocationType: TELECOMMUTE`
// plus `applicantLocationRequirements` for remote roles) and whose Apply
// button links the studio's ATS. That is one request per posting, so it is the
// `fetchDetails` opt-in, capped by `detailLimit` and cached in `ctx.idCache`
// so each posting is looked up once: after the first scan only new postings
// cost a request. A posting not looked up yet keeps an empty location (a
// strict `location_filter` skips it, and the next scan looks it up). With a
// detail, `url` is the employer's link (Source Indexing Policy rule 2) and the
// board's page is the fallback.
//
// robots.txt (fetched 2026-11-02) disallows only `/jobs/*/save` under
// `User-agent: *`; it blocks named AI crawlers (GPTBot, ClaudeBot, …) and SEO
// bots from the whole site.

import { intInRange } from './_config-utils.mjs';
import { countryName } from './_country.mjs';
import { decodeEntities } from './_html-entities.mjs';
import { fetchTextWithRetry, sleep } from './_http.mjs';

const ORIGIN = 'https://gamejobs.co';
const TRUSTED_HOSTS = new Set(['gamejobs.co', 'www.gamejobs.co']);
const SEARCH_KEYS = ['q', 'w', 't', 'e', 'k', 'c'];
const MAX_SEARCH_VALUE = 256;

/** The feed's page size. */
const PAGE_SIZE = 100;
/** Per search; the unfiltered board was 73 pages on 2026-11-02. */
const DEFAULT_MAX_PAGES = 100;
/** Hard ceiling even for an explicit `max_pages` override. */
const MAX_PAGES_CAP = 200;
const INTER_PAGE_DELAY_MS = 250;

const DEFAULT_DETAIL_LIMIT = 100;
const MAX_DETAIL_LIMIT = 1000;
const DETAIL_DELAY_MS = 250;
/** A posting's place and apply link don't change; a closed one leaves the feed. */
const DETAIL_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

const ENTRY_RE = /<entry\b[^>]*>[\s\S]*?<\/entry>/gi;
const LINK_TAG_RE = /<link(?=[\s/>])[^>]*>/gi;
const ATTR_RE = /([a-z][a-z0-9:-]*)\s*=\s*"([^"]*)"/gi;
/** A posting page: one path segment, nothing else. */
const POSTING_PATH_RE = /^\/[^/?#]+$/;
const JSON_LD_RE = /<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
const APPLY_LINK_RE = /<a\b[^>]*\bhref="([^"]+)"[^>]*>\s*Apply\b/gi;

/**
 * @param {string} tag
 * @returns {Record<string, string>}
 */
function attrsOf(tag) {
  /** @type {Record<string, string>} */
  const attrs = {};
  for (const m of tag.matchAll(ATTR_RE)) {
    const key = m[1].toLowerCase();
    if (!(key in attrs)) attrs[key] = decodeEntities(m[2]);
  }
  return attrs;
}

/**
 * @param {string} block
 * @param {string} tag
 */
function tagText(block, tag) {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  if (!m) return '';
  return decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).replace(/\s+/g, ' ').trim();
}

/** @param {unknown} value */
function toEpochMs(value) {
  if (!value || typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * The board's posting URL for an href, or null when it is not one.
 * @param {string} href
 */
function postingUrl(href) {
  try {
    // encodeURI throws on a lone surrogate, which new URL() would silently
    // replace — drop that posting rather than store a degraded key.
    encodeURI(href);
    const u = new URL(href, ORIGIN);
    if (u.protocol !== 'https:' || !TRUSTED_HOSTS.has(u.hostname.toLowerCase())) return null;
    if (!POSTING_PATH_RE.test(u.pathname) || u.search || u.hash) return null;
    return `${ORIGIN}${u.pathname}`;
  } catch {
    return null;
  }
}

/**
 * Split the feed's "{title} at {company}" on its last " at ".
 * @param {string} raw
 */
export function splitTitle(raw) {
  const i = raw.lastIndexOf(' at ');
  if (i <= 0) return { title: raw, company: '' };
  return { title: raw.slice(0, i).trim(), company: raw.slice(i + 4).trim() };
}

/**
 * Parse one Atom feed page.
 *
 * Throws when the body is not an Atom feed. `rawCount` is the number of
 * `<entry>` blocks the source sent, before malformed ones are dropped.
 *
 * @param {string} xml
 * @returns {{ jobs: {title: string, url: string, company: string, location: string, postedAt?: number}[], rawCount: number, hasNext: boolean }}
 */
export function parseFeedPage(xml) {
  const source = String(xml ?? '');
  if (!/<feed\b/i.test(source)) {
    throw new Error(`gamejobs: response is not an Atom feed (${source.trim() ? 'no <feed> element' : 'empty body'})`);
  }
  const blocks = source.match(ENTRY_RE) || [];
  const jobs = [];
  for (const block of blocks) {
    const links = (block.match(LINK_TAG_RE) || []).map(attrsOf);
    const link = links.find((l) => (l.rel || 'alternate') === 'alternate' && l.href) || null;
    const url = link ? postingUrl(link.href) : null;
    if (!url) continue;
    const raw = tagText(block, 'title');
    if (!raw) continue;
    const { title, company } = splitTitle(raw);
    if (!title) continue;
    /** @type {{title: string, url: string, company: string, location: string, postedAt?: number}} */
    const job = { title, url, company, location: '' };
    const postedAt = toEpochMs(tagText(block, 'updated'));
    if (postedAt !== undefined) job.postedAt = postedAt;
    jobs.push(job);
  }
  // Only the feed-level <link rel="next">: entries carry rel="alternate" links.
  const head = source.replace(ENTRY_RE, '');
  const hasNext = (head.match(LINK_TAG_RE) || []).map(attrsOf).some((l) => l.rel === 'next' && l.href);
  return { jobs, rawCount: blocks.length, hasNext };
}

/** @param {unknown} value */
function asArray(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

/** @param {unknown} value */
function str(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** A country as a name: ISO codes are resolved, names kept as written. */
function country(value) {
  const raw = str(value && typeof value === 'object' ? /** @type {any} */ (value).name : value);
  return countryName(raw) || raw;
}

/**
 * Format a JobPosting's place: "City, Region, Country" per location, and
 * "Remote, {country}" for a TELECOMMUTE posting.
 * @param {any} posting
 */
export function formatLocation(posting) {
  const places = [];
  for (const place of asArray(posting?.jobLocation)) {
    const addr = place?.address;
    if (!addr || typeof addr !== 'object') continue;
    const parts = [str(addr.addressLocality), str(addr.addressRegion), country(addr.addressCountry)].filter(Boolean);
    const unique = parts.filter((p, i) => parts.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i);
    if (unique.length) places.push(unique.join(', '));
  }
  const remote = asArray(posting?.jobLocationType).some((t) => str(t).toUpperCase() === 'TELECOMMUTE');
  if (remote) {
    const regions = asArray(posting?.applicantLocationRequirements).map(country).filter(Boolean);
    const where = regions.length ? regions : places;
    return where.length ? `Remote, ${[...new Set(where)].join(' / ')}` : 'Remote';
  }
  return [...new Set(places)].join(' / ');
}

/**
 * Read a posting page: its JobPosting JSON-LD and its Apply link.
 *
 * Throws when the page carries no JobPosting, so a markup change is not
 * cached as "no location".
 *
 * @param {string} html
 * @returns {{ title: string, company: string, location: string, applyUrl: string }}
 */
export function parseDetailPage(html) {
  const source = String(html ?? '');
  let posting = null;
  for (const m of source.matchAll(JSON_LD_RE)) {
    let data;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const nodes = asArray(data).flatMap((d) => (d && Array.isArray(d['@graph']) ? d['@graph'] : [d]));
    posting = nodes.find((n) => n && asArray(n['@type']).includes('JobPosting')) || null;
    if (posting) break;
  }
  if (!posting) throw new Error('gamejobs: posting page has no JobPosting JSON-LD');

  let applyUrl = '';
  for (const m of source.matchAll(APPLY_LINK_RE)) {
    try {
      const u = new URL(decodeEntities(m[1]));
      if (u.protocol !== 'https:' || TRUSTED_HOSTS.has(u.hostname.toLowerCase())) continue;
      applyUrl = u.href;
      break;
    } catch {
      continue;
    }
  }
  return {
    title: decodeEntities(str(posting.title)),
    company: decodeEntities(str(posting.hiringOrganization?.name)),
    location: formatLocation(posting),
    applyUrl,
  };
}

/**
 * Reads and checks the entry's `gamejobs:` block. A malformed search throws:
 * a config mistake is reported once, loudly, instead of silently widening the
 * walk to the whole board.
 * @param {any} entry
 */
export function parseConfig(entry) {
  const cfg = (entry && entry.gamejobs) || {};
  const raw = cfg.searches == null ? [] : cfg.searches;
  if (!Array.isArray(raw)) throw new Error('gamejobs: gamejobs.searches must be a list');
  const searches = raw.map((s, i) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(`gamejobs: gamejobs.searches[${i}] must be a mapping`);
    /** @type {Record<string, string>} */
    const params = {};
    for (const [key, value] of Object.entries(s)) {
      if (!SEARCH_KEYS.includes(key)) {
        throw new Error(`gamejobs: gamejobs.searches[${i}] has unknown key "${key}" (allowed: ${SEARCH_KEYS.join(', ')})`);
      }
      const v = typeof value === 'string' ? value.trim() : '';
      if (!v || v.length > MAX_SEARCH_VALUE) {
        throw new Error(`gamejobs: gamejobs.searches[${i}].${key} must be a non-empty string of at most ${MAX_SEARCH_VALUE} characters`);
      }
      params[key] = v;
    }
    if (!Object.keys(params).length) throw new Error(`gamejobs: gamejobs.searches[${i}] is empty`);
    return params;
  });
  return {
    searches,
    fetchDetails: cfg.fetchDetails === true,
    detailLimit: intInRange(cfg.detailLimit, DEFAULT_DETAIL_LIMIT, 1, MAX_DETAIL_LIMIT),
  };
}

/**
 * A feed page URL. Page 1 carries no `p`, like the site's own links.
 * @param {Record<string, string> | null} search - null = the whole board.
 * @param {number} page
 */
export function buildFeedUrl(search, page) {
  const params = new URLSearchParams();
  if (page > 1) params.set('p', String(page));
  for (const [key, value] of Object.entries(search || {})) params.set(key, value);
  params.set('format', 'atom');
  return `${ORIGIN}/${search ? 'search' : ''}?${params}`;
}

/** @param {any} search */
function describe(search) {
  return search ? Object.entries(search).map(([k, v]) => `${k}=${v}`).join('&') : 'whole board';
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

/** @param {unknown} value */
function isCachedDetail(value) {
  const v = /** @type {any} */ (value);
  return !!v && typeof v === 'object' && typeof v.location === 'string' && typeof v.applyUrl === 'string'
    && Number.isFinite(Date.parse(v.checkedAt ?? ''));
}

/**
 * Apply a posting page's details to its row.
 * @param {{title: string, url: string, company: string, location: string}} job
 * @param {{ title?: string, company?: string, location: string, applyUrl: string }} detail
 */
function applyDetail(job, detail) {
  if (detail.title) job.title = detail.title;
  if (detail.company) job.company = detail.company;
  if (detail.location) job.location = detail.location;
  if (detail.applyUrl) job.url = detail.applyUrl;
}

/** @type {Provider} */
export default {
  id: 'gamejobs',

  detect(entry) {
    if (entry?.provider === 'gamejobs' || isBoardUrl(entry?.careers_url) || isBoardUrl(entry?.api)) {
      return { url: `${ORIGIN}/?format=atom` };
    }
    return null;
  },

  async fetch(entry, ctx) {
    const name = entry?.name || 'GameJobs.co';
    const { searches, fetchDetails, detailLimit } = parseConfig(entry);
    const maxPages = resolveMaxPages(entry);
    // ctx.maxPages is set only by verify-portals' liveness probe.
    const probing = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0;
    const pagesToFetch = probing ? Math.min(maxPages, ctx.maxPages) : maxPages;
    const opts = { redirect: 'error', timeoutMs: 15_000 };
    const passes = searches.length ? searches : [null];

    const jobs = [];
    const seen = new Set();
    let requests = 0;
    for (const [index, search] of passes.entries()) {
      if (probing && index > 0) break;
      // Per pass: the unfiltered feed wraps back to page 1 past its end, so a
      // page with nothing new to this pass ends it. Output de-dup is separate.
      const passSeen = new Set();
      /** @type {'complete' | 'cap' | 'fetch-error'} */
      let stopReason = 'complete';
      for (let page = 1; ; page++) {
        const url = buildFeedUrl(search, page);
        if (requests > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
        requests++;
        let parsed;
        try {
          parsed = parseFeedPage(await fetchTextWithRetry(ctx, url, opts));
        } catch (err) {
          // The first page of the first search is never wrapped: a board that
          // can't be read at all is a failure, not an empty board.
          if (probing || (index === 0 && page === 1)) throw err;
          console.error(`⚠️  gamejobs: ${name} (${describe(search)}) stopped at page ${page} (${jobs.length} jobs kept): ${(err && err.message) || err}`);
          stopReason = 'fetch-error';
          break;
        }
        if (parsed.rawCount > 0 && parsed.jobs.length === 0) {
          if (index === 0 && page === 1) {
            throw new Error(`gamejobs: ${url} has ${parsed.rawCount} feed entries but none could be parsed — the feed format changed`);
          }
          console.error(`⚠️  gamejobs: ${name} (${describe(search)}) page ${page} could not be parsed — kept ${jobs.length} jobs`);
          stopReason = 'fetch-error';
          break;
        }
        let fresh = 0;
        for (const job of parsed.jobs) {
          if (passSeen.has(job.url)) continue;
          passSeen.add(job.url);
          fresh++;
          if (seen.has(job.url)) continue;
          seen.add(job.url);
          jobs.push(job);
        }
        if (!fresh || !parsed.hasNext || parsed.rawCount < PAGE_SIZE) break;
        if (page >= pagesToFetch) {
          if (!probing) stopReason = 'cap';
          break;
        }
      }
      if (stopReason === 'cap') {
        console.error(`⚠️  gamejobs: ${name} (${describe(search)}) truncated at max_pages=${maxPages} — raise max_pages on this entry for more`);
      }
    }

    if (!fetchDetails || probing) return jobs;

    let looked = 0;
    let pending = 0;
    for (const job of jobs) {
      const key = new URL(job.url).pathname;
      const cached = ctx?.idCache?.get(key);
      if (isCachedDetail(cached) && Date.now() - Date.parse(cached.checkedAt) < DETAIL_MAX_AGE_MS) {
        applyDetail(job, cached);
        continue;
      }
      if (looked >= detailLimit) {
        pending++;
        continue;
      }
      await sleep(DETAIL_DELAY_MS, ctx);
      looked++;
      try {
        const detail = parseDetailPage(await fetchTextWithRetry(ctx, job.url, opts));
        applyDetail(job, detail);
        ctx?.idCache?.set(key, { ...detail, checkedAt: new Date().toISOString() });
      } catch (err) {
        // Best effort: the row stays as the feed gave it.
        console.error(`⚠️  gamejobs: ${name} could not read ${job.url}: ${(err && err.message) || err}`);
      }
    }
    if (pending) {
      console.error(`⚠️  gamejobs: ${name} looked up ${looked} postings (detailLimit=${detailLimit}); ${pending} more have no location until the next scan — raise detailLimit to look them up now`);
    }
    return jobs;
  },
};
