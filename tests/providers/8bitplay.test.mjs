// tests/providers/8bitplay.test.mjs — provider-contract tests for the 8Bit
// Agency job board (providers/8bitplay.mjs).
//
// Fixtures reproduce shapes measured on the live site on 2026-11-10:
//
//   - /jobs/ holds a table of `a.acf-jobs__table-row--job` rows, 10 a page
//     (`?paged=N`), each with `<h3>` title and platform / work mode / place
//     cells; the place is `<span>Country</span>` or `<span>Country,</span>
//     <span class="acf-jobs__city-flb">city</span>`, the city lowercased;
//   - rows link either `/job/{slug}/` (a studio's own posting) or
//     `/jobs/{slug}/` (an agency mandate with the employer withheld);
//   - the same page carries "job board" cards (`div.acf-job-board__offer`,
//     6 a page, `?job-board-paged=N`) naming the company under the logo;
//   - a page past the last keeps the `.acf-jobs` block with no table;
//   - a `/job/` detail page links the studio's ATS from
//     `a.btn.acf-job-board__single-button` with utm_* params appended.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — 8bitplay');

const ORIGIN = 'https://8bitplay.com';

/**
 * One table row as the site renders it.
 * @param {string} path  e.g. `job/acme-artist` or `jobs/lead-engineer`
 * @param {{ title?: string, mode?: string, country?: string, city?: string }} [o]
 */
function row(path, o = {}) {
  const { title = 'Game Designer', mode = 'Remote', country = 'Poland', city = '' } = o;
  const place = city
    ? `<span>${country},</span>\n<span class="acf-jobs__city-flb">${city}</span>`
    : `<span>${country}</span>`;
  return `<a href="${ORIGIN}/${path}/" class="acf-jobs__table-row acf-jobs__table-row--job">
      <h3>${title}</h3>
      <div>
        PC/Console      </div>
      <div>
        ${mode}      </div>
      <div>
        ${place}
      </div>
      <div class="acf-jobs__see-wrapper"><div class="acf-jobs__see">See <svg width="7"><path d="M5"/></svg></div></div>
    </a>`;
}

/**
 * One "job board" card.
 * @param {string} path
 * @param {string} company
 */
function offer(path, company) {
  return `<div class="acf-job-board__offer">
    <a href="${ORIGIN}/${path}/" class="post__similar-job">
      <div class="acf-job-board__top"><div class="acf-job-board__logo">
        <img src="${ORIGIN}/wp-content/uploads/logo.jpg" class="acf-job-board__img wp-post-image" alt="logo" />
        <p class="acf-job-board__img-text">${company}</p>
      </div></div>
      <h3 class="t--h3 post__similar-job-title acf-jtw__title">Role</h3>
    </a>
  </div>`;
}

/**
 * @param {string[]} rows
 * @param {string[]} [offers]
 */
const listPage = (rows, offers = []) => `<html><body>
<div class="acf-job-board__offers acf-jtw__list">${offers.join('\n')}</div>
<section class="acf-jobs"><div class="acf-jobs__filters"></div>
${rows.length ? `<div class="acf-jobs__table t--p2">${rows.join('\n')}</div>` : ''}
</section></body></html>`;

/** @param {string} url */
const pageOf = (url) => Number(new URL(url).searchParams.get('paged') || '1');

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

/**
 * A board of `total` rows, 10 a page, every `/job/` row also a card (6 a page).
 * @param {number} total
 */
function board(total) {
  const all = Array.from({ length: total }, (_, i) => (i % 3 === 0 ? `jobs/mandate-${i}` : `job/acme-role-${i}`));
  const cards = all.filter((p) => p.startsWith('job/'));
  return (/** @type {string} */ url) => {
    const u = new URL(url);
    const p = Number(u.searchParams.get('paged') || '1');
    const c = Number(u.searchParams.get('job-board-paged') || '1');
    return listPage(
      all.slice((p - 1) * 10, p * 10).map((path, i) => row(path, { title: `Role ${(p - 1) * 10 + i}` })),
      cards.slice((c - 1) * 6, c * 6).map((path) => offer(path, 'Acme Games')),
    );
  };
}

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/8bitplay.mjs')).href);
  const bit = mod.default;
  const { parseListingPage, parseDetailPage, cleanApplyUrl, buildLocation, assertParsedSomething } = mod;

  if (bit.id === '8bitplay') pass('id is "8bitplay"');
  else fail(`id is ${JSON.stringify(bit.id)}`);

  // ── detect() ──
  {
    const want = `${ORIGIN}/jobs/`;
    const positives = [
      { provider: '8bitplay' },
      { careers_url: 'https://8bitplay.com/jobs/' },
      { careers_url: 'https://www.8bitplay.com' },
      { api: 'https://8bitplay.com/job/some-role/' },
    ];
    if (positives.every((e) => bit.detect(e)?.url === want)) pass('detect() claims provider:, the site host and www');
    else fail(`detect() positives: ${JSON.stringify(positives.map((e) => bit.detect(e)))}`);

    const negatives = [
      {},
      { careers_url: 'http://8bitplay.com/jobs/' },
      { careers_url: 'https://8bitplay.com.evil.example/jobs/' },
      { careers_url: 'https://not8bitplay.com/' },
      { careers_url: 'not a url' },
      { careers_url: 42 },
      { careers_url: null },
      { provider: 'greenhouse' },
    ];
    let threw = false;
    let hits = [];
    try {
      hits = negatives.map((e) => bit.detect(/** @type {any} */ (e)));
    } catch {
      threw = true;
    }
    if (!threw && hits.every((h) => h === null)) pass('detect() returns null (no throw) for http, look-alike hosts, junk and missing input');
    else fail(`detect() negatives: threw=${threw} ${JSON.stringify(hits)}`);
    if (bit.detect(/** @type {any} */ (null)) === null) pass('detect(null) → null');
    else fail('detect(null) did not return null');
  }

  // ── buildLocation() ──
  {
    const cases = [
      [buildLocation('<span>Poland,</span><span class="acf-jobs__city-flb">warsaw</span>', 'Hybrid'), 'Warsaw, Poland'],
      [buildLocation('<span>Poland,</span><span class="acf-jobs__city-flb">warsaw</span>', 'Remote'), 'Remote, Warsaw, Poland'],
      [buildLocation('<span>Germany,</span><span class="acf-jobs__city-flb">remote</span>', 'Remote'), 'Remote, Germany'],
      [buildLocation('<span>United Kingdom</span>', 'On-site'), 'United Kingdom'],
      [buildLocation('<span>Iceland,</span><span class="acf-jobs__city-flb">new reykjavik</span>', 'On-site'), 'New Reykjavik, Iceland'],
      [buildLocation('', 'Remote'), 'Remote'],
      [buildLocation('', 'Hybrid'), ''],
    ];
    const bad = cases.filter(([got, want]) => got !== want);
    if (bad.length === 0) pass('location: "City, Country" with the city capitalised, a "remote" city dropped, Remote work mode prefixed');
    else fail(`buildLocation: ${JSON.stringify(bad)}`);
  }

  // ── parseListingPage() ──
  {
    const html = listPage([
      row('job/acme-gameplay-programmer', { title: 'Gameplay Programmer', mode: 'Hybrid', country: 'Poland', city: 'warsaw' }),
      row('jobs/lead-engineer', { title: 'Lead Engineer', mode: 'Remote', country: 'Europe' }),
      row('job/bigco-writer', { title: 'Writer &amp; Narrative Designer &#x2013; Senior', mode: 'On-site', country: 'Germany' }),
    ], [
      offer('job/acme-gameplay-programmer', 'Acme Games S.A.'),
      offer('job/bigco-writer', 'BigCo &amp; Friends'),
      offer('jobs/lead-engineer', '8Bit'),
    ]);
    const { jobs, rawRows, rawOffers, companies, recognized } = parseListingPage(html);
    const [a, b, c] = jobs;
    if (recognized && rawRows === 3 && jobs.length === 3 && rawOffers === 3) pass('parses every row and card on a page');
    else fail(`parse: recognized=${recognized} rawRows=${rawRows} jobs=${jobs.length} rawOffers=${rawOffers}`);
    if (a?.title === 'Gameplay Programmer' && a.location === 'Warsaw, Poland' && a.url === `${ORIGIN}/job/acme-gameplay-programmer/` && a.kind === 'board') {
      pass('a /job/ row: title, place and canonical URL, kind "board"');
    } else fail(`/job/ row: ${JSON.stringify(a)}`);
    if (b?.url === `${ORIGIN}/jobs/lead-engineer/` && b.kind === 'mandate' && b.location === 'Remote, Europe') pass('a /jobs/ row is an agency mandate');
    else fail(`/jobs/ row: ${JSON.stringify(b)}`);
    if (c?.title === 'Writer & Narrative Designer – Senior') pass('entities in a title are decoded before any keyword match');
    else fail(`entities: ${JSON.stringify(c)}`);
    if (companies.get(`${ORIGIN}/job/acme-gameplay-programmer/`) === 'Acme Games S.A.'
      && companies.get(`${ORIGIN}/job/bigco-writer/`) === 'BigCo & Friends'
      && !companies.has(`${ORIGIN}/jobs/lead-engineer/`)) {
      pass('card companies are read for /job/ postings; the "8Bit" label on a mandate is not');
    } else fail(`companies: ${JSON.stringify([...companies])}`);
  }
  {
    const bad = listPage([
      row('job/acme-ok', { title: 'OK' }),
      row('job/acme-no-title', { title: '' }),
      row('job/../../etc', { title: 'Traversal' }),
      row('blog/acme-post', { title: 'Blog' }),
    ]);
    const { jobs, rawRows } = parseListingPage(bad);
    if (rawRows === 4 && jobs.length === 1 && jobs[0].url === `${ORIGIN}/job/acme-ok/`) pass('drops rows with no title or a non-posting path; rawRows still counts them');
    else fail(`malformed rows: rawRows=${rawRows} ${JSON.stringify(jobs)}`);
  }

  // ── fetch(): companies, pagination ──
  {
    const ctx = makeCtx(board(25));
    const jobs = await bit.fetch({ name: '8Bit', provider: '8bitplay' }, ctx);
    const boardJobs = jobs.filter((j) => j.url.includes('/job/'));
    const mandates = jobs.filter((j) => j.url.includes('/jobs/'));
    if (jobs.length === 25 && ctx.calls.length === 3) pass('walks the table until its short last page (25 rows → 3 requests)');
    else fail(`walk: jobs=${jobs.length} calls=${ctx.calls.length}`);
    if (boardJobs.every((j) => j.company === 'Acme Games') && mandates.every((j) => j.company === '')) {
      pass('a /job/ posting takes its card\'s company; a mandate\'s company stays "" (employer withheld)');
    } else fail(`companies: ${JSON.stringify(jobs.map((j) => [j.url, j.company]))}`);
    if (jobs.every((j) => !('kind' in j))) pass('the internal kind field is not returned');
    else fail('kind leaked into the Job rows');
    if (ctx.calls[0].url === `${ORIGIN}/jobs/` && ctx.calls[1].url === `${ORIGIN}/jobs/?paged=2&job-board-paged=2`) pass('page N requests both lists at once on the fixed origin');
    else fail(`page URLs: ${ctx.calls.map((c) => c.url)}`);
    if (ctx.calls.every((c) => c.opts?.redirect === 'error')) pass('every list request passes redirect: "error"');
    else fail(`redirect opts: ${JSON.stringify(ctx.calls.map((c) => c.opts))}`);
  }
  {
    // 10 rows on the only table page, but 2 pages of cards: the walk goes on
    // for the cards, and a full table page followed by an empty one ends cleanly.
    const ctx = makeCtx(board(10));
    const { result, lines } = await captureStderr(() => bit.fetch({ provider: '8bitplay' }, ctx));
    if (result.length === 10 && ctx.calls.length === 2 && lines.length === 0 && !result.truncated) pass('a table ending on a full page stops at the next, empty page without a warning');
    else fail(`full last page: jobs=${result.length} calls=${ctx.calls.length} lines=${lines}`);
  }
  {
    const ctx = makeCtx(() => listPage([]));
    const jobs = await bit.fetch({ provider: '8bitplay' }, ctx);
    if (Array.isArray(jobs) && jobs.length === 0 && ctx.calls.length === 1) pass('an empty job section → []');
    else fail(`empty board: ${JSON.stringify(jobs)}`);
  }
  {
    const broken = listPage([]).replace('<section class="acf-jobs">', `<section class="acf-jobs"><a href="${ORIGIN}/job/acme-artist/" class="redesigned-row">Artist</a>`);
    let threw = null;
    try {
      await bit.fetch({ provider: '8bitplay' }, makeCtx(() => broken));
    } catch (err) {
      threw = err;
    }
    if (threw && /markup changed/.test(String(threw))) pass('posting hrefs with zero parsed rows → throws (markup change, not an empty board)');
    else fail(`silent-zero guard: ${threw}`);
    let quiet = true;
    try {
      assertParsedSomething(listPage([]), ORIGIN);
    } catch {
      quiet = false;
    }
    if (quiet) pass('assertParsedSomething() stays quiet on a page with no posting links');
    else fail('assertParsedSomething() threw on an empty section');
  }
  {
    let threw = null;
    try {
      await bit.fetch({ provider: '8bitplay' }, makeCtx(() => '<html><body><h1>Maintenance</h1></body></html>'));
    } catch (err) {
      threw = err;
    }
    if (threw && /not the job listing/.test(String(threw))) pass('a page with no job section → throws');
    else fail(`unrecognized page: ${threw}`);
  }
  {
    const boom = Object.assign(new Error('HTTP 503'), { status: 503 });
    let caught = null;
    try {
      await bit.fetch({ provider: '8bitplay' }, makeCtx(() => { throw boom; }));
    } catch (err) {
      caught = err;
    }
    if (caught === boom) pass('a first-page failure propagates (never an empty board)');
    else fail(`first-page failure: ${caught}`);
  }
  {
    const ctx = makeCtx(board(1000));
    const { result, lines } = await captureStderr(() => bit.fetch({ name: '8Bit', provider: '8bitplay' }, ctx));
    if (ctx.calls.length === 20 && result.length === 200 && lines.some((l) => /raise max_pages/.test(l)) && result.truncated?.reason === 'page-cap') {
      pass('DEFAULT_MAX_PAGES (20) stops a table that keeps going, warns and marks the result truncated');
    } else fail(`default cap: calls=${ctx.calls.length} jobs=${result.length} lines=${lines} truncated=${JSON.stringify(result.truncated)}`);
  }
  {
    const ctx = makeCtx(board(1000));
    await captureStderr(() => bit.fetch({ provider: '8bitplay', max_pages: 1000 }, ctx));
    if (ctx.calls.length === 50) pass('max_pages override is clamped to MAX_PAGES_CAP (50)');
    else fail(`override cap: calls=${ctx.calls.length}`);
  }
  {
    const ctx = makeCtx((url) => {
      if (pageOf(url) === 2) throw Object.assign(new Error('HTTP 503'), { status: 503 });
      return board(50)(url);
    });
    const { result, lines } = await captureStderr(() => bit.fetch({ name: '8Bit', provider: '8bitplay' }, ctx));
    if (result.length === 10 && lines.some((l) => /stopped at page 2/.test(l)) && !lines.some((l) => /raise max_pages/.test(l))
      && result.truncated?.reason === 'fetch-error') {
      pass('a page-2 failure keeps page 1 and warns, without the max_pages warning');
    } else fail(`page-2 failure: jobs=${result.length} lines=${lines}`);
  }

  // ── probe cooperation ──
  {
    const ctx = makeCtx(board(50), { maxPages: 1 });
    const { result, lines } = await captureStderr(() => bit.fetch({ provider: '8bitplay', '8bitplay': { fetchDetails: true } }, ctx));
    if (ctx.calls.length === 1 && result.length === 10 && lines.length === 0) pass('ctx.maxPages: 1 → exactly one list request, no detail requests, no warning');
    else fail(`probe: calls=${ctx.calls.length} lines=${lines}`);
  }
  {
    class ProbePageBudgetReached extends Error {}
    const budget = new ProbePageBudgetReached('budget');
    const ctx = makeCtx((url) => {
      if (pageOf(url) === 2) throw budget;
      return board(50)(url);
    }, { maxPages: 2 });
    let caught = null;
    try {
      await bit.fetch({ provider: '8bitplay' }, ctx);
    } catch (err) {
      caught = err;
    }
    if (caught === budget) pass('a ctx.fetch rejection while probing propagates unwrapped');
    else fail(`probe rejection: ${caught}`);
  }

  // ── detail enrichment ──
  const detailPage = (/** @type {string} */ applyHref) => `<html><body><main class="post__main">
<section class="post__header"><h1 class="t--h0 post__title">Role</h1></section>
<section class="post__content wrapper"><div class="post__similar"></div>
<div class="post__content-inner gutenberg gutenberg--job">
<h2 class="t--h5-caps clr--pink post__job-content-title">Description</h2>
<p>We build <strong>Unreal</strong> games &amp; tools.</p><ul><li>C++</li></ul>
${applyHref ? `<a\n href="${applyHref}"\n class="btn acf-job-board__single-button"\n target="_blank"\n id="apply"><span>Apply now</span></a>` : `<a href="${ORIGIN}/jobs/#jobs" class="btn btn--transparent post__more-button"><span>see more offers</span></a>`}
</div></section></main>
<div class="wrapper post__apply" id="apply"><form>Your Name</form></div></body></html>`;
  {
    const d = parseDetailPage(detailPage('https://acme.example/careers/role?utm_source=8bitplay.com&amp;utm_medium=jobboard&amp;id=7'));
    if (d.description === 'We build Unreal games & tools. C++' && d.applyUrl === 'https://acme.example/careers/role?id=7') {
      pass('detail: description text without the "Description" heading or the form; apply link with utm_* removed');
    } else fail(`detail: ${JSON.stringify(d)}`);
    const m = parseDetailPage(detailPage(''));
    if (m.description === 'We build Unreal games & tools. C++' && m.applyUrl === '') pass('detail: a mandate page has a description and no apply link');
    else fail(`mandate detail: ${JSON.stringify(m)}`);
    const rejects = ['mailto:jobs@acme.example', 'http://acme.example/apply', `${ORIGIN}/contact/`, 'not a url', ''].map(cleanApplyUrl);
    if (rejects.every((r) => r === '')) pass('cleanApplyUrl() refuses mailto, http, links back to 8Bit and junk');
    else fail(`cleanApplyUrl rejects: ${JSON.stringify(rejects)}`);
  }
  {
    const lists = board(5);
    const ctx = makeCtx((url) => {
      if (url.includes('/jobs/mandate-')) return detailPage('');
      if (url.includes('acme-role-2')) throw Object.assign(new Error('HTTP 500'), { status: 500 });
      if (url.includes('/job/acme-role-1/')) return detailPage('mailto:jobs@acme.example');
      if (url.includes('/job/acme-role-')) return detailPage('https://acme.example/apply?utm_source=8bitplay.com');
      return lists(url);
    });
    const jobs = await bit.fetch({ provider: '8bitplay', '8bitplay': { fetchDetails: true } }, ctx);
    const byTitle = Object.fromEntries(jobs.map((j) => [j.title, j]));
    const detailCalls = ctx.calls.filter((c) => !c.url.startsWith(`${ORIGIN}/jobs/?`) && c.url !== `${ORIGIN}/jobs/`);
    // acme-role-2 answers 500, which the shared retry tries again.
    if (new Set(detailCalls.map((c) => c.url)).size === 5 && detailCalls.every((c) => c.opts?.redirect === 'error')) pass('fetchDetails: a detail request per posting, each with redirect: "error"');
    else fail(`detail calls: ${JSON.stringify(detailCalls)}`);
    if (byTitle['Role 0'].url === `${ORIGIN}/jobs/mandate-0/` && byTitle['Role 0'].description) pass('fetchDetails: a mandate gains a description and keeps 8Bit\'s page as its URL');
    else fail(`mandate: ${JSON.stringify(byTitle['Role 0'])}`);
    if (byTitle['Role 4'].url === 'https://acme.example/apply' && byTitle['Role 4'].description) pass('fetchDetails: a /job/ posting\'s URL becomes the studio\'s apply link (rule 2)');
    else fail(`board posting: ${JSON.stringify(byTitle['Role 4'])}`);
    if (byTitle['Role 1'].url === `${ORIGIN}/job/acme-role-1/`) pass('fetchDetails: a mailto apply link keeps 8Bit\'s page as the URL');
    else fail(`mailto: ${JSON.stringify(byTitle['Role 1'])}`);
    if (byTitle['Role 2'].url === `${ORIGIN}/job/acme-role-2/` && !byTitle['Role 2'].description && jobs.length === 5) pass('fetchDetails: a failed detail request keeps the listing row as it was');
    else fail(`failed detail: ${JSON.stringify(byTitle['Role 2'])}`);
  }
  {
    const lists = board(40);
    const ctx = makeCtx((url) => (url.includes('/jobs/?') || url === `${ORIGIN}/jobs/` ? lists(url) : detailPage('')));
    await bit.fetch({ provider: '8bitplay', '8bitplay': { fetchDetails: true, detailLimit: 10 } }, ctx);
    const details = ctx.calls.filter((c) => !c.url.startsWith(`${ORIGIN}/jobs/?`) && c.url !== `${ORIGIN}/jobs/`);
    if (details.length === 10) pass('detailLimit caps the detail requests (40 postings, limit 10 → 10)');
    else fail(`detailLimit: ${details.length}`);
  }
  {
    const lists = board(20);
    const ctx = makeCtx((url) => (url.includes('/jobs/?') || url === `${ORIGIN}/jobs/` ? lists(url) : detailPage('')), {
      titleWanted: (/** @type {string} */ t) => t === 'Role 4' || t === 'Role 7',
    });
    const jobs = await bit.fetch({ provider: '8bitplay', '8bitplay': { fetchDetails: true } }, ctx);
    const details = ctx.calls.filter((c) => !c.url.startsWith(`${ORIGIN}/jobs/?`) && c.url !== `${ORIGIN}/jobs/`);
    if (details.length === 2 && jobs.length === 20) pass('fetchDetails reads only postings ctx.titleWanted keeps, and still returns every row');
    else fail(`titleWanted: details=${details.length} jobs=${jobs.length}`);
  }
  {
    const ctx = makeCtx(board(5));
    await bit.fetch({ provider: '8bitplay' }, ctx);
    if (ctx.calls.every((c) => c.url === `${ORIGIN}/jobs/` || c.url.startsWith(`${ORIGIN}/jobs/?`))) pass('without fetchDetails no detail page is requested');
    else fail(`default detail calls: ${ctx.calls.length}`);
  }
} catch (err) {
  fail(`8bitplay tests crashed: ${err && /** @type {any} */ (err).stack || err}`);
}
