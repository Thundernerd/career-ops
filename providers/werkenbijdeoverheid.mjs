// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Werken bij de Overheid provider — the Dutch government's national vacancy
// portal (https://www.werkenbijdeoverheid.nl/vacatures), where ministries,
// executive agencies, provinces, water boards, municipalities and the
// judiciary post their own openings. Wire in via a `job_boards:` entry with
// `provider: werkenbijdeoverheid` (or a `careers_url` on the portal's host,
// auto-detected). Optional `searchKeywords` narrows the listing server-side
// through the same `term` parameter the portal's own search box sets.
//
// Why HTML: the portal has no public JSON API. Measured on 2026-10-20, the
// /vacatures page itself carries no cards — it loads them from a Bloomreach
// (Hippo) component-rendering URL,
// `/vacatures?_hn:type=component-rendering&_hn:ref=r18_r1_r4&pagina=N`, which
// answers a plain HTTPS GET with server-rendered HTML: no cookie, no session,
// no JS. 20 cards per page; the unfiltered board was 73 pages (1,457
// postings), and a page past the end answers 200 with an explicit
// `vacancy-list-no-result` block. robots.txt (fetched 2026-10-20) disallows
// nothing under `User-agent: *` and states `Request-rate: 10/1`.
//
// COMPLETENESS. The listing's ordering is not stable between requests: ties
// (same Plaatsingsdatum, same organisation, …) come back in a different order
// on every call, so a page walk sees postings twice and skips others. Measured
// 2026-10-20: every walk served all 1,458 cards, but only 1,258–1,399 distinct
// ones depending on `sortering`, and two walks with the same sort agreed on
// only 48 of 73 pages. No sort order, and no union of a few walks, closed the
// gap. The portal's own `sitemap-vacatures.xml` does list the live inventory
// exactly (1,458 URLs, none outside what the listing serves), so after a
// complete unfiltered walk the provider reads the sitemap and fetches the
// detail page of each posting the walk missed (~5–10% of the board), bounded by
// `MAX_RESIDUE_DETAILS` and paced like the listing. This is inventory recall,
// not description enrichment: no description is fetched for any posting.
// It is skipped while probing, after a truncated walk, and when
// `searchKeywords` narrows the listing (the sitemap is unfiltered).
//
// The `_hn:ref` is the CMS's id for the listing component, not a stable API
// contract — a page-layout change can renumber it. DEFAULT_COMPONENT_REF is
// the fast path; when page 1 comes back unrecognized, the provider re-reads
// the ref once from the async placeholder divs on /vacatures (the same
// self-heal shape vdab.mjs uses for its rotating frontend key).
//
// PARSING CONTRACT. Each card is a `<section class="vacancy" …>`; inside it the
// title anchor sits in `h2.vacancy__title` and points at
// `/vacatures/{slug}-{ORG}-{YYYY}-{NNNN}`, the employer is `p.vacancy__employer`,
// the place is the value next to the `title="Locatie"` icon, and the
// publication date is the "Plaatsingsdatum: 20 oktober 2026" label. A page that
// still carries posting hrefs but parses to zero cards THROWS — a markup change
// must look like a broken board, never like an empty one.

import { fetchTextWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

const ORIGIN = 'https://www.werkenbijdeoverheid.nl';
const LISTING_PAGE_URL = `${ORIGIN}/vacatures`;
const SITEMAP_URL = `${ORIGIN}/sitemap-vacatures.xml`;
const TRUSTED_HOSTS = new Set(['www.werkenbijdeoverheid.nl', 'werkenbijdeoverheid.nl']);

/** The listing component's CMS ref, observed live 2026-10-20. */
const DEFAULT_COMPONENT_REF = 'r18_r1_r4';

/** Cards per page, fixed by the portal (verified: 20 on every full page). */
const PAGE_SIZE = 20;

/** 100 pages = 2,000 postings — the whole board (73 pages measured 2026-10-20). */
const DEFAULT_MAX_PAGES = 100;
/** Hard ceiling even for an explicit `max_pages` override. */
const MAX_PAGES_CAP = 200;

/** Well inside robots.txt's `Request-rate: 10/1`; no throttling observed. */
const INTER_PAGE_DELAY_MS = 250;

/**
 * Ceiling on detail fetches for postings the walk missed. ~100 were missed per
 * walk on 2026-10-20; a residue past this means the walk itself broke.
 */
const MAX_RESIDUE_DETAILS = 300;

const CARD_OPEN_RE = /<section\b[^>]*\bclass="vacancy"[^>]*>/gi;
const TITLE_RE = /<h2[^>]*\bclass="vacancy__title"[^>]*>\s*<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i;
const EMPLOYER_RE = /<p[^>]*\bclass="vacancy__employer"[^>]*>([\s\S]*?)<\/p>/i;
const LOCATION_RE = /title="Locatie"[^>]*>\s*<\/span>\s*<span[^>]*\bclass="job-short-info__value[^"]*"[^>]*>([\s\S]*?)<\/span>/i;
const POSTED_RE = /Plaatsingsdatum:\s*(\d{1,2})\s+([a-z]+)\s+(\d{4})/i;
/** A posting detail path: a slug only, no query/fragment, no traversal. */
const POSTING_PATH_RE = /^\/vacatures\/[A-Za-z0-9._~%-]+$/;
/** Listing signal for the silent-zero guard: a detail href ending in the vacancy number. */
const POSTING_HREF_RE = /href="\/vacatures\/[A-Za-z0-9._~%-]+-\d{4}-\d+"/i;
const NO_RESULT_RE = /\bvacancy-list-no-result\b/;
const LIST_CONTAINER_RE = /\bid="vacancies-list"/;
const COMPONENT_REF_RE = /id="\/vacatures\?_hn:type=component-rendering&(?:amp;)?_hn:ref=([A-Za-z0-9_]+)"/g;
const SITEMAP_LOC_RE = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
const OG_TITLE_RE = /<meta\b[^>]*\bproperty="og:title"[^>]*\bcontent="([^"]*)"/i;
const OG_TITLE_SUFFIX_RE = /\s*\|\s*Werken bij de Overheid\s*$/i;

const DUTCH_MONTHS = /** @type {Record<string, number>} */ ({
  januari: 0, februari: 1, maart: 2, april: 3, mei: 4, juni: 5,
  juli: 6, augustus: 7, september: 8, oktober: 9, november: 10, december: 11,
});

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
 * "20 oktober 2026" → epoch ms (UTC midnight). Unparseable → undefined.
 * @param {string} text
 * @returns {number | undefined}
 */
export function parsePlaatsingsdatum(text) {
  const m = POSTED_RE.exec(String(text ?? ''));
  if (!m) return undefined;
  const month = Object.hasOwn(DUTCH_MONTHS, m[2].toLowerCase()) ? DUTCH_MONTHS[m[2].toLowerCase()] : undefined;
  if (month === undefined) return undefined;
  const day = Number(m[1]);
  const year = Number(m[3]);
  const ms = Date.UTC(year, month, day);
  // Reject a rolled-over date ("31 februari" → 3 March) rather than invent one.
  return new Date(ms).getUTCDate() === day ? ms : undefined;
}

/**
 * Build the component-rendering URL for one listing page.
 * @param {{ searchKeywords?: unknown }} entry
 * @param {number} page - 1-based
 * @param {string} [ref]
 */
export function buildListUrl(entry, page, ref = DEFAULT_COMPONENT_REF) {
  const params = new URLSearchParams({ '_hn:type': 'component-rendering', '_hn:ref': ref });
  const term = typeof entry?.searchKeywords === 'string' ? entry.searchKeywords.trim() : '';
  if (term) params.set('term', term);
  if (page > 1) params.set('pagina', String(page));
  return `${LISTING_PAGE_URL}?${params}`;
}

/**
 * Parse one listing page.
 *
 * `rawCount` is the number of card sections the SOURCE returned — the
 * short-page stop reads it, never the post-filter `jobs.length`. `recognized`
 * is false when the page is neither a card list nor the explicit no-result
 * block (wrong component ref, or a redesign).
 *
 * @param {string} html
 * @returns {{ jobs: {title: string, url: string, company: string, location: string, postedAt?: number}[], rawCount: number, recognized: boolean }}
 */
export function parseListingPage(html) {
  const source = String(html ?? '');
  const starts = [...source.matchAll(CARD_OPEN_RE)].map((m) => m.index ?? 0);
  const jobs = [];
  for (let i = 0; i < starts.length; i++) {
    const card = source.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : source.length);
    const titleMatch = TITLE_RE.exec(card);
    if (!titleMatch) continue;
    const path = decodeEntities(titleMatch[1]).trim();
    if (!POSTING_PATH_RE.test(path)) continue;
    const title = visibleText(titleMatch[2]);
    if (!title) continue;
    const employer = EMPLOYER_RE.exec(card);
    const location = LOCATION_RE.exec(card);
    const postedAt = parsePlaatsingsdatum(card);
    jobs.push({
      title,
      url: `${ORIGIN}${path}`,
      company: employer ? visibleText(employer[1]) : '',
      location: location ? visibleText(location[1]) : '',
      ...(postedAt === undefined ? {} : { postedAt }),
    });
  }
  const recognized = starts.length > 0 || LIST_CONTAINER_RE.test(source) || NO_RESULT_RE.test(source);
  return { jobs, rawCount: starts.length, recognized };
}

/**
 * Throw when a page still carries posting links but no card parsed — the
 * markup changed, and returning [] would read as an empty board.
 * @param {string} html
 * @param {string} url
 */
export function assertParsedSomething(html, url) {
  if (!POSTING_HREF_RE.test(String(html ?? ''))) return;
  throw new Error(`werkenbijdeoverheid: ${url} still contains vacancy links but none could be parsed — the listing markup changed`);
}

/**
 * Read the async component refs off the /vacatures page, in document order.
 * @param {string} html
 * @returns {string[]}
 */
export function extractComponentRefs(html) {
  return [...new Set([...String(html ?? '').matchAll(COMPONENT_REF_RE)].map((m) => m[1]))];
}

/**
 * Posting URLs from `sitemap-vacatures.xml`, restricted to this origin's
 * detail-page shape. Throws when the document is not a sitemap at all.
 * @param {string} xml
 * @returns {string[]}
 */
export function parseSitemap(xml) {
  const source = String(xml ?? '');
  if (!/<urlset\b/i.test(source)) throw new Error('werkenbijdeoverheid: sitemap-vacatures.xml is not a <urlset> document');
  const urls = new Set();
  for (const m of source.matchAll(SITEMAP_LOC_RE)) {
    let u;
    try {
      u = new URL(decodeEntities(m[1]));
    } catch {
      continue;
    }
    if (u.origin !== ORIGIN || u.search || u.hash || !POSTING_PATH_RE.test(u.pathname)) continue;
    urls.add(`${ORIGIN}${u.pathname}`);
  }
  return [...urls];
}

/**
 * One posting's detail page → Job. The title and employer come from
 * `og:title` ("{title} • {employer} | Werken bij de Overheid"); location and
 * date use the same markup as the listing cards. Null when no title.
 * @param {string} html
 * @param {string} url
 * @returns {{title: string, url: string, company: string, location: string, postedAt?: number} | null}
 */
export function parseDetailPage(html, url) {
  const source = String(html ?? '');
  const og = OG_TITLE_RE.exec(source);
  if (!og) return null;
  const full = decodeEntities(og[1]).replace(OG_TITLE_SUFFIX_RE, '').trim();
  const sep = full.lastIndexOf(' • ');
  const title = (sep >= 0 ? full.slice(0, sep) : full).trim();
  if (!title) return null;
  const location = LOCATION_RE.exec(source);
  const postedAt = parsePlaatsingsdatum(source);
  return {
    title,
    url,
    company: sep >= 0 ? full.slice(sep + 3).trim() : '',
    location: location ? visibleText(location[1]) : '',
    ...(postedAt === undefined ? {} : { postedAt }),
  };
}

/** @param {any} entry */
function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

/** @param {unknown} raw */
function isPortalUrl(raw) {
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
  id: 'werkenbijdeoverheid',

  detect(entry) {
    if (entry?.provider === 'werkenbijdeoverheid' || isPortalUrl(entry?.careers_url) || isPortalUrl(entry?.api)) {
      return { url: LISTING_PAGE_URL };
    }
    return null;
  },

  async fetch(entry, ctx) {
    const name = entry?.name || 'Werken bij de Overheid';
    const maxPages = resolveMaxPages(entry);
    // ctx.maxPages is set only by verify-portals' liveness probe.
    const probing = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0;
    const pagesToFetch = probing ? Math.min(maxPages, ctx.maxPages) : maxPages;
    const opts = { redirect: 'error', timeoutMs: 15_000 };

    let ref = DEFAULT_COMPONENT_REF;
    /** @param {number} page */
    const getPage = (page) => fetchTextWithRetry(ctx, buildListUrl(entry, page, ref), opts);

    // Page 1 is never wrapped: if the board can't be read at all, that is a
    // failure, not an empty board.
    let html = await getPage(1);
    let parsed = parseListingPage(html);
    if (!parsed.recognized) {
      // The component ref may have been renumbered by a CMS layout change:
      // re-read it once from /vacatures (a bootstrap carrying no listings).
      const page = await fetchTextWithRetry(ctx, LISTING_PAGE_URL, opts);
      const fresh = extractComponentRefs(page).find((r) => r !== ref);
      if (fresh) {
        ref = fresh;
        html = await getPage(1);
        parsed = parseListingPage(html);
      }
      if (!parsed.recognized) {
        assertParsedSomething(html, buildListUrl(entry, 1, ref));
        throw new Error(`werkenbijdeoverheid: ${buildListUrl(entry, 1, ref)} is not a vacancy listing (no cards, no list container, no no-result block)`);
      }
    }
    if (parsed.jobs.length === 0) assertParsedSomething(html, buildListUrl(entry, 1, ref));

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
      // A short (or empty) page ends the board on its own, even at the cap.
      if (parsed.rawCount < PAGE_SIZE) break;
      if (page >= pagesToFetch) {
        if (!probing) stopReason = 'cap';
        break;
      }
      page++;
      await sleep(INTER_PAGE_DELAY_MS, ctx);
      try {
        html = await getPage(page);
      } catch (err) {
        if (probing) throw err;
        console.error(`⚠️  werkenbijdeoverheid: ${name} stopped at page ${page} (${jobs.length} jobs kept): ${(err && err.message) || err}`);
        stopReason = 'fetch-error';
        break;
      }
      parsed = parseListingPage(html);
      if (!parsed.recognized) {
        console.error(`⚠️  werkenbijdeoverheid: ${name} page ${page} is not a vacancy listing — kept ${jobs.length} jobs from earlier pages`);
        stopReason = 'unrecognized';
        break;
      }
    }

    if (stopReason === 'cap') {
      console.error(`⚠️  werkenbijdeoverheid: ${name} truncated at max_pages=${maxPages} (${jobs.length} jobs) — raise max_pages on this entry for more`);
    }

    // Sitemap reconciliation (see COMPLETENESS above): only after a walk that
    // ended on its own, over the unfiltered board, outside a probe.
    const filtered = typeof entry?.searchKeywords === 'string' && entry.searchKeywords.trim() !== '';
    if (stopReason !== 'complete' || probing || filtered) return jobs;

    let residue;
    try {
      await sleep(INTER_PAGE_DELAY_MS, ctx);
      residue = parseSitemap(await fetchTextWithRetry(ctx, SITEMAP_URL, opts)).filter((u) => !seen.has(u));
    } catch (err) {
      console.error(`⚠️  werkenbijdeoverheid: ${name} sitemap unavailable, returning the listing walk only (${jobs.length} jobs): ${(err && err.message) || err}`);
      return jobs;
    }
    if (residue.length > MAX_RESIDUE_DETAILS) {
      console.error(`⚠️  werkenbijdeoverheid: ${name} listing walk missed ${residue.length} sitemap postings — fetching the first ${MAX_RESIDUE_DETAILS} only`);
      residue = residue.slice(0, MAX_RESIDUE_DETAILS);
    }
    let failed = 0;
    for (const url of residue) {
      await sleep(INTER_PAGE_DELAY_MS, ctx);
      try {
        const job = parseDetailPage(await fetchTextWithRetry(ctx, url, opts), url);
        if (job) jobs.push(job);
        else failed++;
      } catch {
        // Best-effort: a posting closed since the sitemap was built 404s here.
        failed++;
      }
    }
    if (failed) {
      console.error(`⚠️  werkenbijdeoverheid: ${name} ${failed} of ${residue.length} sitemap-only postings could not be read`);
    }
    return jobs;
  },
};
