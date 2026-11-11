// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// 8Bit provider — the job board of 8Bit Agency, a games-industry recruitment
// agency (https://8bitplay.com/jobs/). Wire in via a `job_boards:` entry with
// `provider: 8bitplay` (or a `careers_url` on the site's host, auto-detected).
//
// TWO KINDS OF POSTING share the one table, told apart by path:
//   - `/job/{slug}/` (WordPress post type `job-post`): a studio's own opening
//     listed on the board. Its detail page links straight to the studio's ATS
//     or careers page (11 bit studios on Recruitee, CI Games on Teamtailor,
//     Papaya, Flix Interactive, ...). 46 of the 69 rows on 2026-11-10.
//   - `/jobs/{slug}/` (post type `job`): one of the agency's own client
//     mandates. The detail page names no employer ("Our client is looking
//     for...") and is applied to through 8Bit's own CV form. 23 rows that day.
// Both are returned. A mandate's `company` is '' (not the agency's name — the
// agency is not the employer), so scan.mjs dedups it by URL only.
//
// WHY HTML. The site is WordPress, but neither post type is in the REST API
// (`/wp-json/wp/v2/types` lists only post/page/product/...; `product` is the
// WooCommerce shop), and the Yoast sitemaps (`job-sitemap.xml`,
// `job-post-sitemap.xml`) carry no title, place or employer. robots.txt
// (fetched 2026-11-10) disallows only /cgi-bin/ and /_old/.
//
// TWO PAGINATED LISTS on /jobs/, walked together:
//   - the table (`a.acf-jobs__table-row--job`, `?paged=N`, 10 rows a page,
//     7 pages on 2026-11-10): every posting, with title, platform, work mode
//     (Remote / Hybrid / On-site) and place, but no employer;
//   - the "job board" cards (`div.acf-job-board__offer`, `?job-board-paged=N`,
//     6 a page, 9 pages): a subset (49 of the 69) that names each posting's
//     company under its logo (`p.acf-job-board__img-text`). Mandates read
//     "8Bit" there, which is not used.
// One request `/jobs/?paged=N&job-board-paged=N` returns page N of both, so
// the walk costs max(table pages, card pages) requests. A list is finished on
// a page that comes back empty or shorter than its first page.
// A `/job/` row the cards do not cover keeps `company: ''`, unless
// fetchDetails reads its page: that page's og:image is the studio's logo,
// and a card for another posting by the same studio names it (logo upload
// path → company, learned from every card walked).
//
// PARSING CONTRACT. A table row is `<a href="https://8bitplay.com/{job|jobs}/
// {slug}/" class="acf-jobs__table-row acf-jobs__table-row--job">` holding
// `<h3>{title}</h3>` and three `<div>` cells: platform, work mode, place,
// inside the `.acf-jobs` block. A page past the last keeps that block with no
// table, which reads as the end of the list. The place is
// `<span>{Country}</span>` or `<span>{Country},</span><span
// class="acf-jobs__city-flb">{city, lowercased}</span>`; a city of "remote"
// is not a place. A first page that still carries posting links but parses
// to no row THROWS — a markup change must look like a broken board, never
// like an empty one. A later page whose rows parse to nothing, or that has
// no `.acf-jobs` block at all, stops the walk with the rows already read.
//
// OPT-IN DETAIL ENRICHMENT (`8bitplay: { fetchDetails: true, detailLimit }`).
// The list carries no description and no employer link, so with fetchDetails
// each wanted posting's detail page fills `description`, and a `/job/`
// posting's `url` becomes the studio's own apply link (Source Indexing Policy
// rule 2) with `utm_*` removed — kept on 8Bit's page when that link is
// missing, not https, or a mailto. Bounded by `detailLimit` (default 25,
// 1..100), limited to postings the scan would add (`ctx.postingWanted`, else
// the title filter's `ctx.titleWanted`), paced, and
// skipped while a health probe runs.

import { fetchTextWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';
import { htmlToText, visibleText } from './_html-to-text.mjs';
import { intInRange } from './_config-utils.mjs';
import { markTruncated } from '../lib/board-truncation.mjs';

const ORIGIN = 'https://8bitplay.com';
const LISTING_URL = `${ORIGIN}/jobs/`;
const TRUSTED_HOSTS = new Set(['8bitplay.com', 'www.8bitplay.com']);

/** 20 pages of 10 rows — about three times the board on 2026-11-10 (7 pages). */
const DEFAULT_MAX_PAGES = 20;
/** Hard ceiling even for an explicit `max_pages` override. */
const MAX_PAGES_CAP = 50;

const INTER_PAGE_DELAY_MS = 250;
const DETAIL_DELAY_MS = 250;

const ROW_RE = /<a\b[^>]*\bhref="([^"]*)"[^>]*\bclass="acf-jobs__table-row acf-jobs__table-row--job"[^>]*>([\s\S]*?)<\/a>/gi;
const ROW_TITLE_RE = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i;
const ROW_CELL_RE = /<div>([\s\S]*?)<\/div>/gi;
const SPAN_RE = /<span\b([^>]*)>([\s\S]*?)<\/span>/gi;
const OFFER_SPLIT = /\bclass="acf-job-board__offer"/;
const OFFER_LINK_RE = /<a\b[^>]*\bhref="([^"]*)"[^>]*\bclass="post__similar-job"/i;
const OFFER_COMPANY_RE = /<p\b[^>]*\bclass="acf-job-board__img-text"[^>]*>([\s\S]*?)<\/p>/i;
const OFFER_LOGO_RE = /<div\b[^>]*\bclass="acf-job-board__logo"[^>]*>[\s\S]*?<img\b[^>]*\bsrc="([^"]*)"/i;
const DETAIL_OG_IMAGE_RE = /<meta\b[^>]*\bproperty="og:image"[^>]*\bcontent="([^"]*)"/i;
/** A posting page: either post type, one slug segment, nothing else. */
const POSTING_URL_RE = /^https:\/\/(?:www\.)?8bitplay\.com\/(jobs?)\/([a-z0-9][a-z0-9-]*)\/?$/i;
/** Listing signal for the silent-zero guard. */
const POSTING_HREF_RE = /href="https:\/\/(?:www\.)?8bitplay\.com\/jobs?\/[a-z0-9][a-z0-9-]*\/?"/i;
/** The job section itself; a page past the last one keeps it but has no table. */
const SECTION_RE = /\bclass="acf-jobs"/;

const DETAIL_CONTENT_RE = /<div\b[^>]*\bclass="post__content-inner\b[^"]*"[^>]*>([\s\S]*?)(?:<a\b[^>]*\bclass="btn\b[^"]*(?:post__more-button|acf-job-board__single-button)|<\/section>)/i;
const DETAIL_HEADING_RE = /<h2\b[^>]*\bclass="[^"]*\bpost__job-content-title\b[^"]*"[^>]*>[\s\S]*?<\/h2>/gi;
const APPLY_LINK_RE = /<a\b(?=[^>]*\bclass="btn acf-job-board__single-button")[^>]*\bhref="([^"]*)"/i;

/**
 * `warsaw` → `Warsaw`, `new york` → `New York`. The site stores cities
 * lowercased; spelling slips (`warsaaw`) are left as they are.
 * @param {string} s
 */
function titleCase(s) {
  return s.replace(/(^|[\s-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
}

/**
 * `{Country}` / `{Country},` + `{city}` → `City, Country`; work mode Remote
 * adds a `Remote, ` prefix (`Remote` alone when no place is given).
 * @param {string} placeCell
 * @param {string} workMode
 */
export function buildLocation(placeCell, workMode) {
  let country = '';
  let city = '';
  for (const m of String(placeCell ?? '').matchAll(SPAN_RE)) {
    const text = visibleText(m[2]).replace(/,\s*$/, '').trim();
    if (!text) continue;
    if (/\bacf-jobs__city-flb\b/.test(m[1])) city = text;
    else if (!country) country = text;
  }
  if (/^remote$/i.test(city)) city = '';
  const place = [city ? titleCase(city) : '', country].filter(Boolean).join(', ');
  if (/^remote$/i.test(workMode)) return place ? `Remote, ${place}` : 'Remote';
  return place;
}

/**
 * A studio logo's identity: its uploads path with WordPress's `-{w}x{h}`
 * size suffix dropped, so a card's thumbnail and a detail page's og:image of
 * the same upload compare equal. '' for anything else.
 * @param {string} raw
 */
export function logoKey(raw) {
  try {
    const u = new URL(decodeEntities(String(raw ?? '')).replace(/\\\//g, '/'), ORIGIN);
    if (!TRUSTED_HOSTS.has(u.hostname.toLowerCase())) return '';
    const m = /\/wp-content\/uploads\/(.+?)(?:-\d+x\d+)?(\.[a-z0-9]+)$/i.exec(u.pathname);
    return m ? `${m[1]}${m[2]}`.toLowerCase() : '';
  } catch {
    return '';
  }
}

/**
 * Parse one /jobs/ page: its table rows and its "job board" cards.
 *
 * `rawRows` / `rawOffers` count what the page carried, before any row was
 * dropped, so a malformed row cannot end the walk early.
 *
 * @param {string} html
 * `logos` maps each studio card's logo (`logoKey`) to the company named
 * under it, for a `/job/` row no card covers: its detail page shows the same
 * logo as og:image.
 *
 * @returns {{ jobs: {title: string, url: string, company: string, location: string, kind: 'board' | 'mandate'}[], rawRows: number, rawOffers: number, companies: Map<string, string>, logos: Map<string, string>, recognized: boolean }}
 */
export function parseListingPage(html) {
  const source = String(html ?? '');
  const jobs = [];
  let rawRows = 0;
  for (const m of source.matchAll(ROW_RE)) {
    rawRows++;
    const url = canonicalPostingUrl(decodeEntities(m[1]).trim());
    if (!url) continue;
    const titleMatch = ROW_TITLE_RE.exec(m[2]);
    const title = titleMatch ? visibleText(titleMatch[1]) : '';
    if (!title) continue;
    const cells = [...m[2].matchAll(ROW_CELL_RE)].map((c) => c[1]);
    const workMode = visibleText(cells[1] ?? '');
    const location = buildLocation(cells[2] ?? '', workMode);
    const kind = /\/job\//.test(url) ? 'board' : 'mandate';
    jobs.push({ title, url, company: '', location, kind });
  }

  const companies = new Map();
  const logos = new Map();
  const offers = source.split(OFFER_SPLIT).slice(1);
  for (const offer of offers) {
    const link = OFFER_LINK_RE.exec(offer);
    const url = link ? canonicalPostingUrl(decodeEntities(link[1]).trim()) : null;
    if (!url || !/\/job\//.test(url)) continue; // mandates read "8Bit" — the agency, not the employer
    const company = OFFER_COMPANY_RE.exec(offer);
    const name = company ? visibleText(company[1]) : '';
    if (!name) continue;
    companies.set(url, name);
    const logo = OFFER_LOGO_RE.exec(offer);
    const key = logo ? logoKey(logo[1]) : '';
    if (key && !logos.has(key)) logos.set(key, name);
  }

  const recognized = rawRows > 0 || SECTION_RE.test(source);
  return { jobs, rawRows, rawOffers: offers.length, companies, logos, recognized };
}

/**
 * The canonical `https://8bitplay.com/{job|jobs}/{slug}/` form of a posting
 * href, or null when it is not a posting page on this site.
 * @param {string} href
 */
function canonicalPostingUrl(href) {
  const m = POSTING_URL_RE.exec(href);
  return m ? `${ORIGIN}/${m[1].toLowerCase()}/${m[2].toLowerCase()}/` : null;
}

/**
 * Throw when a page still carries posting links but no row parsed — the
 * markup changed, and returning [] would read as an empty board.
 * @param {string} html
 * @param {string} url
 */
export function assertParsedSomething(html, url) {
  if (!POSTING_HREF_RE.test(String(html ?? ''))) return;
  throw new Error(`8bitplay: ${url} still contains posting links but none could be parsed — the listing markup changed`);
}

/**
 * Description text, on a `/job/` page the studio's apply link, and the
 * page's og:image as a `logoKey` (the studio's logo on a `/job/` page).
 * @param {string} html
 * @returns {{ description: string, applyUrl: string, logo: string }}
 */
export function parseDetailPage(html) {
  const source = String(html ?? '');
  const content = DETAIL_CONTENT_RE.exec(source);
  const description = content ? htmlToText(content[1].replace(DETAIL_HEADING_RE, ' ')) : '';
  const apply = APPLY_LINK_RE.exec(source);
  const og = DETAIL_OG_IMAGE_RE.exec(source);
  return {
    description,
    applyUrl: apply ? cleanApplyUrl(decodeEntities(apply[1]).trim()) : '',
    logo: og ? logoKey(og[1]) : '',
  };
}

/**
 * An https apply link with `utm_*` removed, or '' (missing, not https,
 * mailto, malformed, or back on 8Bit's own site).
 * @param {string} raw
 */
export function cleanApplyUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || TRUSTED_HOSTS.has(u.hostname.toLowerCase())) return '';
    for (const key of [...u.searchParams.keys()]) {
      if (/^utm_/i.test(key)) u.searchParams.delete(key);
    }
    return u.href;
  } catch {
    return '';
  }
}

/** @param {any} entry */
function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

/** @param {any} entry */
function parseConfig(entry) {
  const cfg = entry?.['8bitplay'] || {};
  return {
    fetchDetails: cfg.fetchDetails === true,
    detailLimit: intInRange(cfg.detailLimit, 25, 1, 100),
  };
}

/** @param {unknown} raw */
function isSiteUrl(raw) {
  if (typeof raw !== 'string' || !raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && TRUSTED_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** @param {number} page */
function pageUrl(page) {
  return page === 1 ? LISTING_URL : `${LISTING_URL}?paged=${page}&job-board-paged=${page}`;
}

/** @type {Provider} */
export default {
  id: '8bitplay',

  detect(entry) {
    if (entry?.provider === '8bitplay' || isSiteUrl(entry?.careers_url) || isSiteUrl(entry?.api)) {
      return { url: LISTING_URL };
    }
    return null;
  },

  async fetch(entry, ctx) {
    const name = entry?.name || '8Bit';
    const maxPages = resolveMaxPages(entry);
    // ctx.maxPages is set only by verify-portals' liveness probe.
    const probing = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0;
    const pagesToFetch = probing ? Math.min(maxPages, ctx.maxPages) : maxPages;
    const opts = { redirect: /** @type {'error'} */ ('error'), timeoutMs: 15_000 };

    // Page 1 is never wrapped: if the board can't be read at all, that is a
    // failure, not an empty board.
    let url = pageUrl(1);
    let html = await fetchTextWithRetry(ctx, url, opts);
    let parsed = parseListingPage(html);
    if (parsed.jobs.length === 0) assertParsedSomething(html, url);
    if (!parsed.recognized) {
      throw new Error(`8bitplay: ${url} is not the job listing (no job section)`);
    }

    const rowPageSize = parsed.rawRows;
    const offerPageSize = parsed.rawOffers;
    /** @type {{title: string, url: string, company: string, location: string, kind: 'board' | 'mandate'}[]} */
    const rows = [];
    const companies = new Map();
    /** @type {Map<string, string>} */
    const logos = new Map();
    const seen = new Set();
    let rowsDone = false;
    let offersDone = false;
    /** @type {'complete' | 'cap' | 'fetch-error' | 'unrecognized'} */
    let stopReason = 'complete';
    let page = 1;
    for (;;) {
      if (!rowsDone) {
        for (const job of parsed.jobs) {
          if (seen.has(job.url)) continue;
          seen.add(job.url);
          rows.push(job);
        }
        rowsDone = parsed.rawRows === 0 || parsed.rawRows < rowPageSize;
      }
      if (!offersDone) {
        for (const [k, v] of parsed.companies) companies.set(k, v);
        for (const [k, v] of parsed.logos) if (!logos.has(k)) logos.set(k, v);
        offersDone = parsed.rawOffers === 0 || parsed.rawOffers < offerPageSize;
      }
      if (rowsDone && offersDone) break;
      if (page >= pagesToFetch) {
        // Only an unfinished table is a truncated board; unfinished cards
        // only cost some company names.
        if (!rowsDone && !probing) stopReason = 'cap';
        break;
      }
      page++;
      url = pageUrl(page);
      await sleep(INTER_PAGE_DELAY_MS, ctx);
      try {
        html = await fetchTextWithRetry(ctx, url, opts);
      } catch (err) {
        if (probing) throw err;
        console.error(`⚠️  8bitplay: ${name} stopped at page ${page} (${rows.length} jobs kept): ${(err && err.message) || err}`);
        if (!rowsDone) stopReason = 'fetch-error';
        break;
      }
      parsed = parseListingPage(html);
      if (!rowsDone && (!parsed.recognized || (parsed.jobs.length === 0 && parsed.rawRows > 0))) {
        console.error(`⚠️  8bitplay: ${name} page ${page} could not be parsed — kept ${rows.length} jobs from earlier pages`);
        stopReason = 'unrecognized';
        break;
      }
    }

    const jobs = rows.map(({ kind, ...job }) => ({ ...job, company: kind === 'board' ? companies.get(job.url) || '' : '' }));

    const { fetchDetails, detailLimit } = parseConfig(entry);
    if (fetchDetails && !probing) {
      // ctx.postingWanted (scan.mjs) also applies location, posting age and
      // dedup; ctx.titleWanted is the fallback for a caller without it.
      const postingWanted = typeof ctx?.postingWanted === 'function' ? ctx.postingWanted : null;
      const titleWanted = typeof ctx?.titleWanted === 'function' ? ctx.titleWanted : null;
      const pool = postingWanted
        ? jobs.filter((job) => postingWanted(job))
        : titleWanted ? jobs.filter((job) => titleWanted(job.title)) : jobs;
      const wanted = pool.slice(0, detailLimit);
      for (let i = 0; i < wanted.length; i++) {
        const job = wanted[i];
        if (i > 0) await sleep(DETAIL_DELAY_MS, ctx);
        try {
          const detail = parseDetailPage(await fetchTextWithRetry(ctx, job.url, opts));
          if (detail.description) job.description = detail.description;
          const studioPosting = /\/job\//.test(job.url);
          // A studio posting no card named: its page shows the studio's logo,
          // which a card elsewhere on the board names. Mandates stay ''.
          if (studioPosting && !job.company && detail.logo) job.company = logos.get(detail.logo) || '';
          if (detail.applyUrl && studioPosting) job.url = detail.applyUrl;
        } catch {
          // Detail lookup is opt-in enrichment. Keep the listing row on failure.
        }
      }
    }

    if (stopReason === 'cap') {
      console.error(`⚠️  8bitplay: ${name} truncated at max_pages=${maxPages} (${jobs.length} jobs) — raise max_pages on this entry for more`);
      markTruncated(jobs, 'page-cap', { fetched: jobs.length });
    } else if (stopReason !== 'complete') {
      markTruncated(jobs, stopReason, { fetched: jobs.length });
    }
    return jobs;
  },
};
