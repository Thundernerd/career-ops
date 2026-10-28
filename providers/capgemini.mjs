// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { fetchJsonWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';
import { htmlToText } from './_html-to-text.mjs';
import { safeEncodeURIComponent } from './_safe-url.mjs';
import { coerceId } from './_ids.mjs';

// Capgemini group job platform — single-company adapter (→ tracked_companies:).
//
// Every Capgemini group careers site (capgemini.com, and the brand sites such
// as sogeti.nl, which run the same "cg-jobs" WordPress plugin) renders its job
// search client-side from one public, no-auth JSON API:
//
//   GET https://cg-jobstream-api.azurewebsites.net/api/job-search
//       ?page=<1-based>&size=<n>&country_code=<cc>&brand=<Brand>&search=<kw>
//   → {"count": N, "data": [{ id, ref, source, brand, country_code, title,
//        location, description, apply_job_url, indexed_at, updated_at, … }],
//      "total": …, "took": …}
//
// Endpoint and parameters were read from the plugin's own frontend bundle
// (cg-jobs-search-frontend.build.js, observed 2026-10-28). The brand sites
// differ only in the filters they send: sogeti.nl pins `brand=Sogeti` and
// `country_code=nl-nl`; the global capgemini.com search sends neither.
// `brand` is case-sensitive (`Sogeti` matches, `sogeti` returns 0) and both
// filters take a comma-joined list. Observed values: brands Capgemini,
// Capgemini Engineering, Capgemini Invent, Sogeti, frog; country codes are
// locale-shaped and irregular (nl-nl, fr-fr, en-in, se-en, DE, …) — copy them
// from the site, don't construct them.
//
// Configure via a `capgemini:` block on the entry:
//
//   - name: Sogeti (Netherlands)
//     provider: capgemini              # sogeti.nl is a branded host — required
//     careers_url: https://www.sogeti.nl/werken-bij/vacatures/
//     capgemini:
//       brand: Sogeti                  # string or list; case-sensitive
//       country_code: nl-nl            # string or list
//       search: ""                     # optional server-side keyword
//
// Omit `brand` / `country_code` to widen the search (the unfiltered feed is
// the whole group, ~6,800 postings — bounded by max_pages below).
//
// detect() auto-claims only hosts that identify the platform unambiguously:
// capgemini.com itself (careers_url) and the API host (api). A brand site on
// its own domain (sogeti.nl, frog.co, …) is NOT matched — set
// `provider: capgemini` explicitly.
//
// Posting URL: each row's `apply_job_url` — the employer's own ATS posting
// page (SAP SuccessFactors RMK at careers.capgemini.com for almost every row,
// a Greenhouse board for a few Capgemini Invent Germany rows). It is
// server-rendered and 302s to an error page once the posting closes, so the
// liveness checker can read it; the brand site's /jobs/{ref}+{source}/ page is
// a client-side shell that answers 200 for any id. Its tracking parameters
// (utm_*, feedId, tcsource) are stripped so the URL is a stable dedup key.
// When apply_job_url is missing or not on a known employer host, the brand
// site's own posting path is built instead, the way the plugin's job card does.
//
// The API is fixed-host (the URL is assembled from a literal), so no
// per-entry host allowlist is needed for the request itself; an `api:` on the
// entry is only accepted when it names that same host.

const API_HOST = 'cg-jobstream-api.azurewebsites.net';
const API_URL = `https://${API_HOST}/api/job-search`;

// The API honours size up to at least 1000, but a row carries the full JD
// HTML (~13 KB), so 100 keeps each page near 1.3 MB.
const PAGE_SIZE = 100;
// Sogeti NL is 114 postings (2 pages); the unfiltered group feed was 6,796
// (68 pages) on 2026-10-28.
const DEFAULT_MAX_PAGES = 20; // 2,000 postings
const MAX_PAGES_CAP = 100; // 10,000 postings — hard ceiling for an override
const INTER_PAGE_DELAY_MS = 200;

const FALLBACK_SITE_ORIGIN = 'https://www.capgemini.com';
const TRACKING_PARAMS = new Set(['feedid', 'tcsource']);

/** @param {unknown} raw @returns {string} */
function clean(raw) {
  return typeof raw === 'string' ? decodeEntities(raw).replace(/\s+/g, ' ').trim() : '';
}

/**
 * Normalize a string-or-list config filter into the comma-joined form the API
 * takes. A wrong-typed value throws: silently dropping a filter would widen a
 * Sogeti-NL entry into the whole group's feed.
 * @param {unknown} value @param {string} key @returns {string}
 */
function filterValue(value, key) {
  if (value == null) return '';
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const v of list) {
    if (typeof v !== 'string') throw new Error(`capgemini: ${key} must be a string or a list of strings, got ${typeof v}`);
    const t = v.trim();
    if (t) out.push(t);
  }
  return out.join(',');
}

/**
 * Resolve the entry into request filters + the brand-site origin for fallback
 * posting URLs. Throws on a config error, before any request is made.
 * @param {import('./_types.js').PortalEntry & { capgemini?: any }} entry
 */
export function resolveConfig(entry) {
  if (entry?.api != null && entry.api !== '') {
    let host = '';
    try {
      const u = new URL(String(entry.api));
      host = u.protocol === 'https:' ? u.hostname.toLowerCase() : '';
    } catch {
      host = '';
    }
    if (host !== API_HOST) {
      throw new Error(`capgemini: api must be https://${API_HOST}/api (got ${JSON.stringify(entry.api)})`);
    }
  }
  const block = entry?.capgemini && typeof entry.capgemini === 'object' ? entry.capgemini : {};
  if (block.search != null && typeof block.search !== 'string') {
    throw new Error(`capgemini: search must be a string, got ${typeof block.search}`);
  }

  // Only the hostname is taken from careers_url; it never reaches a request.
  let siteOrigin = FALLBACK_SITE_ORIGIN;
  try {
    const u = new URL(String(entry?.careers_url ?? ''));
    if (u.protocol === 'https:' && u.hostname) siteOrigin = `https://${u.hostname.toLowerCase()}`;
  } catch {
    // keep the fallback
  }

  return {
    brand: filterValue(block.brand, 'brand'),
    countryCode: filterValue(block.country_code, 'country_code'),
    search: typeof block.search === 'string' ? block.search.trim() : '',
    siteOrigin,
  };
}

/**
 * @param {{ brand: string, countryCode: string, search: string }} cfg
 * @param {number} page 1-based
 */
export function buildSearchUrl(cfg, page) {
  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('size', String(PAGE_SIZE));
  if (cfg.countryCode) params.set('country_code', cfg.countryCode);
  if (cfg.brand) params.set('brand', cfg.brand);
  if (cfg.search) params.set('search', cfg.search);
  return `${API_URL}?${params.toString()}`;
}

/** @param {string} hostname */
function isEmployerHost(hostname) {
  return hostname === 'capgemini.com'
    || hostname.endsWith('.capgemini.com')
    || /^(job-boards(\.eu)?|boards)\.greenhouse\.io$/.test(hostname);
}

/**
 * The row's employer ATS link with tracking params stripped, or null when it is
 * absent, not https, or not on a known employer host.
 * @param {unknown} raw @returns {string | null}
 */
export function cleanApplyUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !isEmployerHost(u.hostname.toLowerCase())) return null;
  for (const k of [...u.searchParams.keys()]) {
    const lk = k.toLowerCase();
    if (lk.startsWith('utm_') || TRACKING_PARAMS.has(lk)) u.searchParams.delete(k);
  }
  u.hash = '';
  return u.toString();
}

// The plugin's job card builds the slug the same way.
/** @param {string} title */
function cardSlug(title) {
  return title.toLowerCase().replace(/ /g, '-').replace(/[^\w-]+/g, '') || '-';
}

/**
 * The brand site's own posting path, as the plugin's job card links it:
 * {origin}/jobs/{ref}+{source lowercased}/{slug}/. Null when ref/source
 * won't encode.
 * @param {any} row @param {string} title @param {string} siteOrigin
 */
function sitePostingUrl(row, title, siteOrigin) {
  const ref = coerceId(row.ref);
  const source = typeof row.source === 'string' ? row.source.trim().toLowerCase() : '';
  if (!ref || !source) return null;
  const refSeg = safeEncodeURIComponent(ref);
  const sourceSeg = safeEncodeURIComponent(source);
  if (refSeg === null || sourceSeg === null) return null;
  return `${siteOrigin}/jobs/${refSeg}+${sourceSeg}/${cardSlug(title)}/`;
}

let regionNames = null;
/**
 * Country display name for a row's locale-shaped country_code ("nl-nl" →
 * "Netherlands", "se-en" → "Sweden", "DE" → "Germany"). The region is usually
 * the last part, but some codes put the language there ("se-en"), so the first
 * part is tried when the last isn't a known region. '' when neither is.
 * @param {unknown} code @returns {string}
 */
export function countryName(code) {
  if (typeof code !== 'string' || !code.trim()) return '';
  try {
    regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return '';
  }
  const parts = code.trim().split('-');
  for (const p of [parts[parts.length - 1], parts[0]]) {
    if (!/^[a-z]{2}$/i.test(p)) continue;
    const upper = p.toUpperCase();
    if (upper === 'ZZ') continue; // CLDR's "Unknown Region"
    try {
      const name = regionNames.of(upper);
      if (name && name !== upper) return name;
    } catch {
      // not a region code
    }
  }
  return '';
}

/** @param {unknown} value @returns {number | undefined} */
function toEpochMs(value) {
  if (typeof value !== 'string' || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Parse one job-search page. Throws when the envelope is not the documented
 * `{data: []}` shape; drops a malformed row.
 * @param {any} json
 * @param {{ siteOrigin: string }} cfg
 * @param {string} company
 * @returns {{ rawCount: number, jobs: Array<import('./_types.js').Job & { _id: string }> }}
 */
export function parseJobSearch(json, cfg, company) {
  const rows = json && typeof json === 'object' && Array.isArray(json.data) ? json.data : null;
  if (!rows) {
    const got = json && typeof json === 'object' ? Object.keys(json).join(', ') : typeof json;
    throw new Error(`capgemini: unexpected response — expected data[], got: [${got}]`);
  }
  const jobs = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = coerceId(row.id);
    const title = clean(row.title);
    if (!id || !title) continue;
    const url = cleanApplyUrl(row.apply_job_url) ?? sitePostingUrl(row, title, cfg.siteOrigin);
    if (!url) continue;

    const city = clean(row.location);
    const country = clean(row.country_name) || countryName(row.country_code);
    const location = city && country && !city.toLowerCase().includes(country.toLowerCase())
      ? `${city}, ${country}`
      : city || country;

    /** @type {import('./_types.js').Job & { _id: string }} */
    const job = { _id: id, title, url, company, location };
    // No publish date in the payload; indexed_at is when the feed first
    // indexed the posting (never later than updated_at, spread over months
    // on a live board), the closest field to one.
    const postedAt = toEpochMs(row.indexed_at);
    if (postedAt !== undefined) job.postedAt = postedAt;
    const description = htmlToText(row.description);
    if (description) job.description = description;
    job.externalId = id;
    // ref is "<requisition>-<locale>" (e.g. "580648-nl_NL"). The locale is
    // the requisition's posting locale, NOT the text's language (en_GB rows on
    // Sogeti NL are written in Dutch), so it is not reported as `language`.
    const req = typeof row.ref === 'string' ? /^(\d+)-/.exec(row.ref.trim()) : null;
    if (req) job.requisitionId = req[1];
    jobs.push(job);
  }
  return { rawCount: rows.length, jobs };
}

/** @param {any} entry */
export function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

/** @type {Provider} */
export default {
  id: 'capgemini',

  detect(entry) {
    for (const raw of [entry?.api, entry?.careers_url]) {
      if (typeof raw !== 'string' || !raw) continue;
      let u;
      try {
        u = new URL(raw);
      } catch {
        continue;
      }
      if (u.protocol !== 'https:') continue;
      const host = u.hostname.toLowerCase();
      if (raw === entry?.api && host === API_HOST) return { url: API_URL };
      if (raw === entry?.careers_url && (host === 'capgemini.com' || host === 'www.capgemini.com')) return { url: API_URL };
    }
    return null;
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry);
    const company = entry?.name || 'Capgemini';
    const maxPages = resolveMaxPages(entry);
    const ctxCap = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : Infinity;
    const probing = ctxCap !== Infinity;
    const pagesToFetch = Math.min(maxPages, ctxCap);

    /** @type {import('./_types.js').Job[]} */
    const jobs = [];
    const seen = new Set();
    // complete | cap | fetch-error — drives the warning and the truncation tag.
    let stopReason = 'complete';
    let lastRawCount = 0;
    let page = 1;
    for (; page <= pagesToFetch; page++) {
      if (page > 1) await sleep(INTER_PAGE_DELAY_MS, ctx);
      let json;
      try {
        json = await fetchJsonWithRetry(ctx, buildSearchUrl(cfg, page), {
          redirect: 'error',
          headers: { accept: 'application/json' },
        });
      } catch (err) {
        // First page or a health probe: propagate unwrapped (a dead feed must
        // not read as an empty board, and ProbePageBudgetReached must keep its
        // identity). A later page in a real scan: keep what was collected.
        if (page === 1 || probing) throw err;
        console.error(`⚠️  capgemini: ${company} truncated at page ${page} (${jobs.length} jobs kept): ${/** @type {Error} */ (err).message}`);
        stopReason = 'fetch-error';
        break;
      }
      const { rawCount, jobs: pageJobs } = parseJobSearch(json, cfg, company);
      lastRawCount = rawCount;
      for (const job of pageJobs) {
        const { _id, ...rest } = job;
        if (seen.has(_id)) continue;
        seen.add(_id);
        jobs.push(rest);
      }
      // A short (or empty) page — counted on the source's own rows — is the
      // natural end. The API's `count` is not used to bound the walk.
      if (rawCount < PAGE_SIZE) break;
    }
    // Ran out of page budget with the last page full: a cap stop, unless it
    // was the probe's cap rather than the entry's.
    if (stopReason === 'complete' && page > pagesToFetch && lastRawCount >= PAGE_SIZE && !probing) {
      stopReason = 'cap';
      console.error(`⚠️  capgemini: ${company} truncated at max_pages=${maxPages} (${jobs.length} jobs) — raise max_pages on this entry for more`);
    }
    if (stopReason === 'cap' || stopReason === 'fetch-error') /** @type {any} */ (jobs).capgeminiTruncated = true;
    return jobs;
  },
};
