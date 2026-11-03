// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Tweakers Carrière provider — the IT job board at
// https://tweakers.net/carriere/it-banen/zoeken/ (4,417 postings on
// 2026-11-03), mostly Dutch employers and recruiters. Wire in via a
// `job_boards:` entry with `provider: tweakers` (or a `careers_url` under
// tweakers.net/carriere, auto-detected).
//
//   job_boards:
//     - name: Tweakers Carrière
//       provider: tweakers
//       tweakers:
//         searches:            # optional; omitted = the whole board
//           - { query: developer, province: Zuid-Holland }
//           - { query: developer, workingPlace: Werken op afstand }
//
// A search takes the board's own filters: `query` (keywords), `province`,
// `contractType` (Vast, Freelance, …), `careerLevel` (Starter, Ervaren, …),
// `workingPlace` (Hybride, Werken op afstand, Werken op locatie) and
// `educationLevel` (WO, HBO, …). Every filter but `query` also takes a list,
// which the API reads as "any of these".
//
// Why this API: the Tweakers page sends no listings in its HTML. A Nationale
// Vacaturebank widget (both are DPG Media sites) loads them in the browser
// from api.nationalevacaturebank.nl, filtered to `tweakers:true`. Its JSON
// carries the whole posting — title, company, place, salary, description —
// and the employer's own apply link, so one request per page of 100 is all a
// scan costs (45 pages for the whole board, measured 2026-11-03). The API
// refuses `limit` above 500 and `page` above 100.
//
// FORK-ONLY: api.nationalevacaturebank.nl/robots.txt (fetched 2026-11-03) is
// `User-agent: *` / `Disallow: /`, which covers this endpoint, so the source
// fails Source Indexing Policy rule 6 and this provider is not for upstream.

import { countryNameFromIso } from './_country.mjs';
import { htmlToText } from './_html-to-text.mjs';
import { fetchJsonWithRetry, sleep } from './_http.mjs';
import { safeEncodeURIComponent } from './_safe-url.mjs';

const API_URL = 'https://api.nationalevacaturebank.nl/api/jobs/v3/sites/nationalevacaturebank.nl/jobs';
const BOARD_URL = 'https://tweakers.net/carriere/it-banen/zoeken/';
const DETAIL_ORIGIN = 'https://www.nationalevacaturebank.nl';
const TRUSTED_HOSTS = new Set(['tweakers.net', 'www.tweakers.net']);

/** The widget's own option lists (tweakers-jobs-search-widget build 164). */
const FILTER_VALUES = {
  province: ['Drenthe', 'Flevoland', 'Friesland', 'Gelderland', 'Groningen', 'Limburg', 'Noord-Brabant',
    'Noord-Holland', 'Overijssel', 'Utrecht', 'Zeeland', 'Zuid-Holland'],
  contractType: ['Bijbaan', 'Freelance', 'Interim', 'Leer-werk overeenkomst', 'Stage', 'Thuiswerk', 'Tijdelijk',
    'Vakantiewerk', 'Vast', 'Vrijwilliger', 'ZZP', 'Zelfstandig/Franchise'],
  careerLevel: ['Geen ervaring', 'Starter', 'Ervaren', 'Leidinggevend', 'Senior management', 'Directie'],
  workingPlace: ['Hybride', 'Werken op afstand', 'Werken op locatie'],
  educationLevel: ['Postdoctoraal', 'WO', 'HBO', 'MBO', 'VWO', 'HAVO', 'VMBO/MAVO', 'LBO', 'Lagere school'],
};
const SEARCH_KEYS = ['query', ...Object.keys(FILTER_VALUES)];
const MAX_QUERY = 256;

const PAGE_SIZE = 100;
/** Per search; the whole board was 45 pages on 2026-11-03. */
const DEFAULT_MAX_PAGES = 60;
/** The API answers 400 past page 100. */
const MAX_PAGES_CAP = 100;
const INTER_PAGE_DELAY_MS = 250;

/** Annualization per `salary.type`; any other type ("unspecified") leaves the salary off. */
const SALARY_MULTIPLIERS = { hourly: 2080, monthly: 12, yearly: 1 };

/** @param {unknown} value */
function str(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** @param {unknown} value */
function toEpochMs(value) {
  if (!value || typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * An https URL with its utm_* tracking params removed, or null.
 * @param {unknown} raw
 */
function cleanHttpsUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    // encodeURI throws on a lone surrogate, which new URL() would silently
    // replace — drop that link rather than store a degraded key.
    encodeURI(raw);
    const u = new URL(raw);
    if (u.protocol !== 'https:') return null;
    for (const key of [...u.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_')) u.searchParams.delete(key);
    }
    return u.href;
  } catch {
    return null;
  }
}

/**
 * "City, Province, Country", prefixed with "Remote, " for a remote posting.
 * @param {any} job
 */
export function formatLocation(job) {
  const loc = job?.workLocation && typeof job.workLocation === 'object' ? job.workLocation : {};
  const country = countryNameFromIso(loc.country?.iso) || str(loc.country?.name);
  const parts = [str(loc.displayName) || str(loc.city), str(loc.province), country].filter(Boolean);
  const unique = parts.filter((p, i) => parts.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i);
  const place = unique.join(', ');
  if (str(job?.workingPlace) === 'Werken op afstand') return place ? `Remote, ${place}` : 'Remote';
  return place;
}

/** @param {any} salary */
function annualSalary(salary) {
  if (!salary || typeof salary !== 'object') return undefined;
  const mult = /** @type {Record<string, number>} */ (SALARY_MULTIPLIERS)[salary.type];
  if (!mult) return undefined;
  const min = Number.isFinite(salary.min) && salary.min > 0 ? salary.min * mult : undefined;
  const max = Number.isFinite(salary.max) && salary.max > 0 ? salary.max * mult : undefined;
  if (min === undefined && max === undefined) return undefined;
  return { min: min ?? max, max: max ?? min, currency: 'EUR' };
}

/**
 * The posting's title. Some scraped postings carry a clipped `title`
 * ("Stack Developer", "Engineer") whose full form is the end of the API's
 * own `dcoTitle` classification ("Full Stack Developer", "Devops Engineer");
 * only then is `dcoTitle` used, since it is otherwise a generic label that
 * can differ from the employer's title.
 * @param {any} raw
 */
export function postingTitle(raw) {
  const title = htmlToText(raw?.title, { cap: Infinity });
  const dco = htmlToText(raw?.dcoTitle, { cap: Infinity });
  if (title && dco.length > title.length && dco.toLowerCase().endsWith(` ${title.toLowerCase()}`)) return dco;
  return title;
}

/**
 * Normalize one API job, or null when it lacks a title or a usable URL.
 *
 * `url` is the employer's apply link (Source Indexing Policy rule 2); the
 * posting's own Nationale Vacaturebank / Intermediair page is the fallback.
 * @param {any} raw
 */
export function normalizeJob(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = postingTitle(raw);
  if (!title) return null;
  let url = raw.apply?.option === 'external' ? cleanHttpsUrl(raw.apply.url) : null;
  // A bare homepage ("https://vacatures-in-hoofddorp.nl/") is shared by every
  // posting of that employer, so as the dedup key it would fold them into one.
  if (url && new URL(url).pathname === '/' && !new URL(url).search) url = null;
  if (!url) url = cleanHttpsUrl(raw._links?.detail?.href);
  if (!url) {
    const id = safeEncodeURIComponent(raw.id);
    if (!id) return null;
    url = `${DETAIL_ORIGIN}/vacature/${id}`;
  }
  /** @type {import('./_types.js').Job} */
  const job = { title, url, company: htmlToText(raw.company?.name, { cap: Infinity }), location: formatLocation(raw) };
  const postedAt = toEpochMs(raw.startDate);
  if (postedAt !== undefined) job.postedAt = postedAt;
  const description = htmlToText(raw.description);
  if (description) job.description = description;
  const salary = annualSalary(raw.salary);
  if (salary) job.salary = salary;
  if (typeof raw.id === 'string' && raw.id) job.externalId = raw.id;
  return job;
}

/**
 * Parse one API page. Throws when the envelope is not the documented shape.
 * `rawCount` is the number of jobs the source sent, before malformed ones are
 * dropped.
 * @param {any} json
 */
export function parsePage(json) {
  const rows = json && json._embedded && Array.isArray(json._embedded.jobs) ? json._embedded.jobs : null;
  if (!rows) {
    const got = json && typeof json === 'object' ? Object.keys(json).join(', ') : typeof json;
    throw new Error(`tweakers: unexpected response — expected _embedded.jobs[], got: [${got}]`);
  }
  const pages = Number.isInteger(json.pages) && json.pages > 0 ? json.pages : undefined;
  return { jobs: rows.map(normalizeJob).filter(Boolean), rawCount: rows.length, pages };
}

/**
 * Reads and checks the entry's `tweakers:` block. A malformed search throws:
 * a config mistake is reported once, loudly, instead of silently widening the
 * walk to the whole board.
 * @param {any} entry
 */
export function parseConfig(entry) {
  const cfg = (entry && entry.tweakers) || {};
  const raw = cfg.searches == null ? [] : cfg.searches;
  if (!Array.isArray(raw)) throw new Error('tweakers: tweakers.searches must be a list');
  const searches = raw.map((s, i) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(`tweakers: tweakers.searches[${i}] must be a mapping`);
    /** @type {Record<string, string | string[]>} */
    const params = {};
    for (const [key, value] of Object.entries(s)) {
      if (!SEARCH_KEYS.includes(key)) {
        throw new Error(`tweakers: tweakers.searches[${i}] has unknown key "${key}" (allowed: ${SEARCH_KEYS.join(', ')})`);
      }
      if (key === 'query') {
        const v = typeof value === 'string' ? value.trim() : '';
        if (!v || v.length > MAX_QUERY) {
          throw new Error(`tweakers: tweakers.searches[${i}].query must be a non-empty string of at most ${MAX_QUERY} characters`);
        }
        params.query = v;
        continue;
      }
      const allowed = /** @type {Record<string, string[]>} */ (FILTER_VALUES)[key];
      const list = Array.isArray(value) ? value : [value];
      const picked = list.map((v) => allowed.find((a) => typeof v === 'string' && a.toLowerCase() === v.trim().toLowerCase()));
      if (!list.length || picked.some((v) => !v)) {
        throw new Error(`tweakers: tweakers.searches[${i}].${key} must be one or more of: ${allowed.join(', ')}`);
      }
      params[key] = /** @type {string[]} */ ([...new Set(picked)]);
    }
    if (!Object.keys(params).length) throw new Error(`tweakers: tweakers.searches[${i}] is empty`);
    return params;
  });
  return { searches };
}

/**
 * An API page URL. Filters go in one `filters` param as space-separated
 * `key:value` pairs, a list joined by commas, with `:` in a value escaped —
 * the widget's own encoding.
 * @param {Record<string, string | string[]> | null} search - null = the whole board.
 * @param {number} page
 */
export function buildPageUrl(search, page) {
  const { query, ...filters } = search || {};
  const pairs = ['tweakers:true'];
  for (const [key, value] of Object.entries(filters)) {
    pairs.push(`${key}:${[value].flat().join(',').replace(/:/g, '\\:')}`);
  }
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), page: String(page), sort: 'date' });
  if (typeof query === 'string') params.set('query', query);
  params.set('filters', pairs.join(' '));
  return `${API_URL}?${params}`;
}

/** @param {any} search */
function describe(search) {
  return search ? Object.entries(search).map(([k, v]) => `${k}=${[v].flat().join(',')}`).join('&') : 'whole board';
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
    return u.protocol === 'https:' && TRUSTED_HOSTS.has(u.hostname.toLowerCase())
      && (u.pathname === '/carriere' || u.pathname.startsWith('/carriere/'));
  } catch {
    return false;
  }
}

/** @type {Provider} */
export default {
  id: 'tweakers',

  detect(entry) {
    if (entry?.provider === 'tweakers' || isBoardUrl(entry?.careers_url) || isBoardUrl(entry?.api)) {
      return { url: BOARD_URL };
    }
    return null;
  },

  async fetch(entry, ctx) {
    const name = entry?.name || 'Tweakers Carrière';
    const { searches } = parseConfig(entry);
    const maxPages = resolveMaxPages(entry);
    // ctx.maxPages is set only by verify-portals' liveness probe.
    const probing = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0;
    const pagesToFetch = probing ? Math.min(maxPages, ctx.maxPages) : maxPages;
    const opts = { redirect: 'error', timeoutMs: 20_000 };
    const passes = searches.length ? searches : [null];

    const jobs = [];
    const seen = new Set();
    let requests = 0;
    for (const [index, search] of passes.entries()) {
      if (probing && index > 0) break;
      /** @type {'complete' | 'cap' | 'fetch-error'} */
      let stopReason = 'complete';
      for (let page = 1; ; page++) {
        const url = buildPageUrl(search, page);
        if (requests > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
        requests++;
        let parsed;
        try {
          parsed = parsePage(await fetchJsonWithRetry(ctx, url, opts));
        } catch (err) {
          // The first page of the first search is never wrapped: a board that
          // can't be read at all is a failure, not an empty board.
          if (probing || (index === 0 && page === 1)) throw err;
          console.error(`⚠️  tweakers: ${name} (${describe(search)}) stopped at page ${page} (${jobs.length} jobs kept): ${(err && err.message) || err}`);
          stopReason = 'fetch-error';
          break;
        }
        for (const job of parsed.jobs) {
          if (seen.has(job.url)) continue;
          seen.add(job.url);
          jobs.push(job);
        }
        if (parsed.rawCount < PAGE_SIZE || (parsed.pages !== undefined && page >= parsed.pages)) break;
        if (page >= pagesToFetch) {
          if (!probing) stopReason = 'cap';
          break;
        }
      }
      if (stopReason === 'cap') {
        const hint = maxPages >= MAX_PAGES_CAP ? 'the API serves no page past 100 — narrow this search' : 'raise max_pages on this entry for more';
        console.error(`⚠️  tweakers: ${name} (${describe(search)}) truncated at max_pages=${maxPages} — ${hint}`);
      }
    }
    return jobs;
  },
};
