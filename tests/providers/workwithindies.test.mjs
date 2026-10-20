// tests/providers/workwithindies.test.mjs — provider-contract tests for the
// Work With Indies board (providers/workwithindies.mjs).
//
// Fixtures reproduce shapes measured on the live site on 2026-10-20:
//
//   - every open posting is an `<a class="job-card">` in one Webflow
//     collection list on the homepage; the card's mobile block carries title,
//     studio and location, the desktop block the "join their team in" (on-site)
//     vs "work from" (remote) phrasing, the unused one hidden with
//     `w-condition-invisible`;
//   - Webflow caps a list at 100 items and paginates with a
//     `?{listId}_page=N` link on `a.w-pagination-next` (the list held 99 that
//     day, so the pagination fixture follows Webflow's documented markup);
//   - an empty collection renders a `w-dyn-empty` block.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — workwithindies');

const ORIGIN = 'https://www.workwithindies.com';
const LIST_ID = '3f2a9c1b';

/**
 * One card as the site renders it.
 * @param {string} slug
 * @param {{ title?: string, company?: string, place?: string, remote?: boolean }} [o]
 */
function card(slug, o = {}) {
  const { title = 'Gameplay Programmer', company = 'Acme Games', place = 'Berlin, DE', remote = false } = o;
  const onsite = remote ? 'job-card-text w-condition-invisible' : 'job-card-text';
  const away = remote ? 'job-card-text' : 'job-card-text w-condition-invisible';
  return `<div role="listitem" class="w-dyn-item"><div class="html-embed-3 w-embed"><input type="hidden" class="jetboost-list-item" value="${slug}" /></div>`
    + `<a data-w-id="6ab70431" href="/careers/${slug}" class="job-card w-inline-block"><img alt="${company}" src="https://cdn.example/logo.png" class="company-logo"/>`
    + `<div class="job-link-desktop"><div class="job-card-text bold">${company}</div><div class="job-card-text"> is hiring a </div>`
    + `<div class="text-block-28">${title}</div><div class="${onsite}">to join their team in</div><div class="${away}">to work from</div>`
    + `<div class="job-card-text w-condition-invisible">the</div><div class="job-card-text bold">${place}</div></div>`
    + `<div class="job-link-mobile"><div class="text-block-14">${title}</div><div class="job-card-text-smol">${company}</div>`
    + `<div class="job-card-text-smol"> | </div><div class="job-card-text-smol">${place}</div></div>`
    + `<div class="div-block-7"><div style="opacity:0" class="learn-more-button">Learn More</div></div></a></div>`;
}

/**
 * @param {string[]} cards
 * @param {number | null} [nextPage]
 */
const listPage = (cards, nextPage = null) => `<html><body><div class="collection-list-wrapper w-dyn-list"><div role="list" class="w-dyn-items">
${cards.join('\n')}
</div><div role="navigation" aria-label="List" class="w-pagination-wrapper">${nextPage
    ? `<a href="?${LIST_ID}_page=${nextPage}" aria-label="Next Page" class="w-pagination-next next"><div class="w-inline-block">Next</div></a>`
    : ''}</div></div></body></html>`;

const EMPTY_PAGE = `<html><body><div class="collection-list-wrapper w-dyn-list"><div class="w-dyn-empty"><div>No items found.</div></div></div></body></html>`;

/** @param {string} url */
const pageOf = (url) => Number(new URL(url).searchParams.get(`${LIST_ID}_page`) || '1');

/**
 * A ctx stub that records every request and its options.
 * @param {(url: string) => string | Promise<string>} respond
 * @param {object} [extra]
 */
function makeCtx(respond, extra = {}) {
  /** @type {{url: string, opts: any}[]} */
  const calls = [];
  return {
    calls,
    sleep: async () => {},
    fetchText: async (/** @type {string} */ url, /** @type {any} */ opts) => {
      calls.push({ url, opts });
      return respond(url);
    },
    ...extra,
  };
}

/** Silence and collect provider warnings for one call. */
async function captureStderr(/** @type {() => Promise<any>} */ fn) {
  const orig = console.error;
  /** @type {string[]} */
  const lines = [];
  console.error = (...a) => { lines.push(a.join(' ')); };
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = orig;
  }
}

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/workwithindies.mjs')).href);
  const wwi = mod.default;
  const { parseListingPage, parseNextQuery, assertParsedSomething } = mod;

  if (wwi.id === 'workwithindies') pass('id is "workwithindies"');
  else fail(`id is ${JSON.stringify(wwi.id)}`);

  // ── detect() ──
  {
    const want = `${ORIGIN}/`;
    const positives = [
      { provider: 'workwithindies' },
      { careers_url: 'https://www.workwithindies.com' },
      { careers_url: 'https://workwithindies.com/categories/programming' },
      { api: 'https://www.workwithindies.com/careers/rss.xml' },
    ];
    if (positives.every((e) => wwi.detect(e)?.url === want)) pass('detect() claims provider:, the board host, and the bare host');
    else fail(`detect() positives: ${JSON.stringify(positives.map((e) => wwi.detect(e)))}`);

    const negatives = [
      {},
      { careers_url: 'http://www.workwithindies.com' },
      { careers_url: 'https://www.workwithindies.com.evil.example/' },
      { careers_url: 'https://notworkwithindies.com/' },
      { careers_url: 'not a url' },
      { careers_url: 42 },
      { careers_url: null },
      { provider: 'greenhouse' },
    ];
    let threw = false;
    let hits = [];
    try {
      hits = negatives.map((e) => wwi.detect(/** @type {any} */ (e)));
    } catch {
      threw = true;
    }
    if (!threw && hits.every((h) => h === null)) pass('detect() returns null (no throw) for http, look-alike hosts, junk and missing input');
    else fail(`detect() negatives: threw=${threw} ${JSON.stringify(hits)}`);
    if (wwi.detect(/** @type {any} */ (null)) === null) pass('detect(null) → null');
    else fail('detect(null) did not return null');
  }

  // ── parseListingPage() ──
  {
    const html = listPage([
      card('acme-games-gameplay-programmer'),
      card('acme-games-pixel-artist', { title: 'Pixel Artist', remote: true, place: 'Anywhere' }),
      card('bigco-writer', { title: 'Writer &amp; Narrative Designer', company: 'BigCo &amp; Friends', place: 'CET ± 2 hours', remote: true }),
    ]);
    const { jobs, rawCount, recognized, nextQuery } = parseListingPage(html);
    const [a, b, c] = jobs;
    if (recognized && rawCount === 3 && jobs.length === 3 && nextQuery === null) pass('parses every card on a single-page list');
    else fail(`parse: recognized=${recognized} rawCount=${rawCount} jobs=${jobs.length} next=${nextQuery}`);
    if (a?.title === 'Gameplay Programmer' && a.company === 'Acme Games' && a.location === 'Berlin, DE'
      && a.url === `${ORIGIN}/careers/acme-games-gameplay-programmer`) pass('on-site card: title, studio, place and absolute URL');
    else fail(`on-site card: ${JSON.stringify(a)}`);
    if (b?.location === 'Remote') pass('remote card in "Anywhere" → location "Remote"');
    else fail(`remote Anywhere: ${JSON.stringify(b)}`);
    if (c?.location === 'Remote · CET ± 2 hours') pass('remote card with a region keeps it: "Remote · {region}"');
    else fail(`remote region: ${JSON.stringify(c)}`);
    if (c?.title === 'Writer & Narrative Designer' && c.company === 'BigCo & Friends') pass('entities in title and studio are decoded');
    else fail(`entities: ${JSON.stringify(c)}`);
  }

  {
    const bad = listPage([
      card('acme-games-ok'),
      card('acme-games-no-title', { title: '' }),
      card('../../etc', { title: 'Traversal' }),
      card('acme-games-query', { title: 'Query' }).replace('href="/careers/acme-games-query"', 'href="/careers/acme-games-query?x=1"'),
    ]);
    const { jobs, rawCount } = parseListingPage(bad);
    if (rawCount === 4 && jobs.length === 1 && jobs[0].url.endsWith('/careers/acme-games-ok')) pass('drops cards with no title or a non-slug path; rawCount still counts them');
    else fail(`malformed rows: rawCount=${rawCount} ${JSON.stringify(jobs)}`);
  }

  // ── parseNextQuery() ──
  {
    const ok = parseNextQuery(listPage([], 2));
    const junk = parseNextQuery('<a href="https://evil.example/?a_page=2" class="w-pagination-next">Next</a>');
    const none = parseNextQuery(listPage([]));
    if (ok === `?${LIST_ID}_page=2` && junk === null && none === null) pass('parseNextQuery() accepts only Webflow\'s ?{listId}_page=N');
    else fail(`parseNextQuery: ok=${ok} junk=${junk} none=${none}`);
  }

  // ── empty vs broken ──
  {
    const ctx = makeCtx(() => EMPTY_PAGE);
    const jobs = await wwi.fetch({ name: 'Work With Indies', provider: 'workwithindies' }, ctx);
    if (Array.isArray(jobs) && jobs.length === 0) pass('an empty collection (w-dyn-empty) → []');
    else fail(`empty collection: ${JSON.stringify(jobs)}`);
  }
  {
    const broken = '<html><body><div class="w-dyn-list"><a href="/careers/acme-games-artist" class="redesigned-card">Artist</a></div></body></html>';
    let threw = null;
    try {
      await wwi.fetch({ provider: 'workwithindies' }, makeCtx(() => broken));
    } catch (err) {
      threw = err;
    }
    if (threw && /markup changed/.test(String(threw))) pass('posting hrefs with zero parsed cards → throws (markup change, not an empty board)');
    else fail(`silent-zero guard: ${threw}`);
    let quiet = true;
    try {
      assertParsedSomething(EMPTY_PAGE, ORIGIN);
    } catch {
      quiet = false;
    }
    if (quiet) pass('assertParsedSomething() stays quiet on a page with no posting links');
    else fail('assertParsedSomething() threw on an empty collection');
  }
  {
    let threw = null;
    try {
      await wwi.fetch({ provider: 'workwithindies' }, makeCtx(() => '<html><body><h1>Maintenance</h1></body></html>'));
    } catch (err) {
      threw = err;
    }
    if (threw && /not a job listing/.test(String(threw))) pass('a page with no cards and no collection list → throws');
    else fail(`unrecognized page: ${threw}`);
  }
  {
    const boom = Object.assign(new Error('HTTP 503'), { status: 503 });
    let caught = null;
    try {
      await wwi.fetch({ provider: 'workwithindies' }, makeCtx(() => { throw boom; }));
    } catch (err) {
      caught = err;
    }
    if (caught === boom) pass('a first-page failure propagates (never an empty board)');
    else fail(`first-page failure: ${caught}`);
  }

  // ── pagination ──
  /** @param {number} pages */
  const paged = (pages) => (/** @type {string} */ url) => {
    const p = pageOf(url);
    return listPage([card(`acme-games-role-${p}`, { title: `Role ${p}` })], p < pages ? p + 1 : null);
  };
  {
    const ctx = makeCtx(paged(3));
    const jobs = await wwi.fetch({ name: 'Work With Indies', provider: 'workwithindies' }, ctx);
    if (jobs.length === 3 && ctx.calls.map((c) => pageOf(c.url)).join(',') === '1,2,3') pass('follows the next link page by page until it disappears');
    else fail(`pagination: jobs=${jobs.length} pages=${ctx.calls.map((c) => pageOf(c.url))}`);
    if (ctx.calls[0].url === `${ORIGIN}/` && ctx.calls[1].url === `${ORIGIN}/?${LIST_ID}_page=2`) pass('page URLs are built on the fixed origin');
    else fail(`page URLs: ${ctx.calls.map((c) => c.url)}`);
    if (ctx.calls.every((c) => c.opts?.redirect === 'error')) pass('every request passes redirect: "error"');
    else fail(`redirect opts: ${JSON.stringify(ctx.calls.map((c) => c.opts))}`);
  }
  {
    const ctx = makeCtx(paged(50));
    const { result, lines } = await captureStderr(() => wwi.fetch({ name: 'WWI', provider: 'workwithindies' }, ctx));
    if (ctx.calls.length === 10 && result.length === 10 && lines.some((l) => /raise max_pages/.test(l))) pass('DEFAULT_MAX_PAGES (10) stops a list that keeps paginating, and warns');
    else fail(`default cap: calls=${ctx.calls.length} jobs=${result.length} lines=${lines}`);
  }
  {
    const ctx = makeCtx(paged(50));
    const { result } = await captureStderr(() => wwi.fetch({ provider: 'workwithindies', max_pages: 1000 }, ctx));
    if (ctx.calls.length === 30 && result.length === 30) pass('max_pages override is clamped to MAX_PAGES_CAP (30)');
    else fail(`override cap: calls=${ctx.calls.length}`);
  }
  {
    const ctx = makeCtx(paged(2));
    const { lines } = await captureStderr(() => wwi.fetch({ provider: 'workwithindies', max_pages: 2 }, ctx));
    if (ctx.calls.length === 2 && !lines.some((l) => /raise max_pages/.test(l))) pass('a list that ends exactly at max_pages is complete — no cap warning');
    else fail(`boundary: calls=${ctx.calls.length} lines=${lines}`);
  }
  {
    const ctx = makeCtx((url) => {
      if (pageOf(url) === 2) throw Object.assign(new Error('HTTP 503'), { status: 503 });
      return paged(5)(url);
    });
    const { result, lines } = await captureStderr(() => wwi.fetch({ name: 'WWI', provider: 'workwithindies' }, ctx));
    if (result.length === 1 && lines.some((l) => /stopped at page 2/.test(l)) && !lines.some((l) => /raise max_pages/.test(l))) {
      pass('a page-2 failure keeps page 1 and warns, without the max_pages warning');
    } else fail(`page-2 failure: jobs=${result.length} lines=${lines}`);
  }

  // ── probe cooperation ──
  {
    const ctx = makeCtx(paged(5), { maxPages: 1 });
    const { result, lines } = await captureStderr(() => wwi.fetch({ provider: 'workwithindies' }, ctx));
    if (ctx.calls.length === 1 && result.length === 1 && lines.length === 0) pass('ctx.maxPages: 1 → exactly one list request, no warning');
    else fail(`probe: calls=${ctx.calls.length} lines=${lines}`);
  }
  {
    class ProbePageBudgetReached extends Error {}
    const budget = new ProbePageBudgetReached('budget');
    const ctx = makeCtx((url) => {
      if (pageOf(url) === 2) throw budget;
      return paged(5)(url);
    }, { maxPages: 2 });
    let caught = null;
    try {
      await wwi.fetch({ provider: 'workwithindies' }, ctx);
    } catch (err) {
      caught = err;
    }
    if (caught === budget) pass('a ctx.fetch rejection while probing propagates unwrapped');
    else fail(`probe rejection: ${caught}`);
  }
} catch (err) {
  fail(`workwithindies tests crashed: ${err && /** @type {any} */ (err).stack || err}`);
}
