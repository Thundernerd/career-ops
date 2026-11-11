// tests/providers/gracklehq.test.mjs — provider-contract tests for the
// Grackle games-industry board (providers/gracklehq.mjs).
//
// Fixtures reproduce shapes measured on the live site on 2026-11-10:
//
//   - `/jobs?pageidx=N` (1-based) server-renders 30 `div.joblisting` cards,
//     each `<a href="/rd/{id}">{title}</a>`, `<div>{Company} - {Location}</div>`
//     and `<div class="bottomright">{&lt;1d | Nd}</div>`;
//   - a "N results" row above the list, Previous/Next buttons below it, the
//     last page's Next carrying `class="btn btn-default disabled"`;
//   - `/rd/{id}` answers 302 with the employer posting in Location.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — gracklehq');

const ORIGIN = 'https://gracklehq.com';
const DAY = 86_400_000;

/**
 * One card as the site renders it.
 * @param {number} id
 * @param {{ title?: string, line?: string, age?: string }} [o]
 */
function card(id, o = {}) {
  const { title = 'Gameplay Programmer', line = 'Acme Games - Berlin, Germany', age = '&lt;1d' } = o;
  return `            <div class="joblisting">
                <a href="/rd/${id}"
                   target="_blank">
                    ${title}
                </a>
                <div>${line}</div>
                <div class="bottomright">
                    ${age}
                </div>
            </div>`;
}

/**
 * @param {string[]} cards
 * @param {{ page?: number, last?: boolean, total?: number }} [o]
 */
function listPage(cards, o = {}) {
  const { page = 1, last = true, total = cards.length } = o;
  return `<html><body><h1>Active Job Listings</h1>
<form action="./jobs" method="get"><input type="text" name="searchstring" /></form>
<div class="jobsresultscountrow">
    ${total} results
</div>
<div class="jobsindexrow">
    <div class="column jobs">
${cards.join('\n')}
    </div>
</div>
<a href="./jobs?pageidx=${page - 1}"
   class="btn btn-default ${page === 1 ? 'disabled' : ''}">
    Previous
</a>
<a href="./jobs?pageidx=${page + 1}"
   class="btn btn-default ${last ? 'disabled' : ''}">
    Next
</a>
</body></html>`;
}

/** @param {string} url */
const pageOf = (url) => Number(new URL(url).searchParams.get('pageidx'));

/**
 * A ctx stub that records every request and its options.
 * @param {(url: string, opts: any) => string | Promise<string>} respond
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
      return respond(url, opts);
    },
    ...extra,
  };
}

/** A redirect-inspection response as _http.mjs raises it under redirect:'manual'. */
function redirectTo(/** @type {string | null} */ location, status = 302) {
  return Object.assign(new Error(`HTTP ${status} Found`), { status, location });
}

/** A Map-backed idCache stub. */
function makeCache(/** @type {Record<string, any>} */ seed = {}) {
  const store = new Map(Object.entries(seed));
  return { store, get: (/** @type {string} */ k) => store.get(k), set: (/** @type {string} */ k, /** @type {any} */ v) => store.set(k, v), delete: (/** @type {string} */ k) => store.delete(k) };
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
  const mod = await import(pathToFileURL(join(ROOT, 'providers/gracklehq.mjs')).href);
  const grackle = mod.default;
  const { parseListingPage, parseAge, assertParsedSomething, acceptRedirectTarget } = mod;

  if (grackle.id === 'gracklehq') pass('id is "gracklehq"');
  else fail(`id is ${JSON.stringify(grackle.id)}`);

  // ── detect() ──
  {
    const want = `${ORIGIN}/jobs`;
    const positives = [
      { provider: 'gracklehq' },
      { careers_url: 'https://gracklehq.com/jobs' },
      { careers_url: 'https://www.gracklehq.com/jobs?city=Austin, TX, USA' },
      { api: 'https://gracklehq.com/' },
    ];
    if (positives.every((e) => grackle.detect(e)?.url === want)) pass('detect() claims provider:, the board host and www');
    else fail(`detect() positives: ${JSON.stringify(positives.map((e) => grackle.detect(e)))}`);

    const negatives = [
      {},
      { careers_url: 'http://gracklehq.com/jobs' },
      { careers_url: 'https://gracklehq.com.evil.example/jobs' },
      { careers_url: 'https://notgracklehq.com/jobs' },
      { careers_url: 'not a url' },
      { careers_url: 42 },
      { careers_url: null },
      { provider: 'greenhouse' },
    ];
    let threw = false;
    let hits = [];
    try {
      hits = negatives.map((e) => grackle.detect(/** @type {any} */ (e)));
    } catch {
      threw = true;
    }
    if (!threw && hits.every((h) => h === null)) pass('detect() returns null (no throw) for http, look-alike hosts, junk and missing input');
    else fail(`detect() negatives: threw=${threw} ${JSON.stringify(hits)}`);
    if (grackle.detect(/** @type {any} */ (null)) === null) pass('detect(null) → null');
    else fail('detect(null) did not return null');
  }

  // ── parseAge() ──
  {
    const now = Date.UTC(2026, 10, 10);
    const ok = parseAge('<1d', now) === now && parseAge('1d', now) === now - DAY && parseAge('2753d', now) === now - 2753 * DAY;
    const junk = [parseAge('', now), parseAge('yesterday', now), parseAge('3w', now), parseAge(/** @type {any} */ (null), now)];
    if (ok && junk.every((v) => v === undefined)) pass('parseAge(): "<1d" → now, "Nd" → N days back, anything else → undefined');
    else fail(`parseAge: ok=${ok} junk=${JSON.stringify(junk)}`);
  }

  // ── parseListingPage() ──
  {
    const now = Date.UTC(2026, 10, 10);
    const html = listPage([
      card(384634, { title: 'Test Lead (Dayshift)', line: 'Amber - Manila, Philippines' }),
      card(384632, { title: 'Senior UX and Core Tools C&#x2B;&#x2B; Engineer [Snowdrop]', line: 'Ubisoft - Bucharest, Romania', age: '3d' }),
      card(1175, { title: 'Steam Software Engineer', line: 'Valve Software - Remote', age: '2753d' }),
    ], { total: 2403, last: false });
    const { jobs, rawCount, recognized, total, lastPage } = parseListingPage(html, now);
    const [a, b, c] = jobs;
    if (recognized && rawCount === 3 && jobs.length === 3 && total === 2403 && lastPage === false) pass('parses every card, the results count and an enabled Next');
    else fail(`parse: recognized=${recognized} rawCount=${rawCount} jobs=${jobs.length} total=${total} last=${lastPage}`);
    if (a?.title === 'Test Lead (Dayshift)' && a.company === 'Amber' && a.location === 'Manila, Philippines'
      && a.url === `${ORIGIN}/rd/384634` && a.postedAt === now) pass('card: title, company, location, /rd/ URL and "<1d" age');
    else fail(`card: ${JSON.stringify(a)}`);
    if (b?.title === 'Senior UX and Core Tools C++ Engineer [Snowdrop]' && b.postedAt === now - 3 * DAY) pass('entities are decoded; "3d" → three days back');
    else fail(`entities/age: ${JSON.stringify(b)}`);
    if (c?.location === 'Remote' && c.postedAt === now - 2753 * DAY) pass('old postings keep their age, so max_posting_age_days can drop them');
    else fail(`old card: ${JSON.stringify(c)}`);
    if (parseListingPage(listPage([card(1)], { last: true })).lastPage === true) pass('a disabled Next marks the last page');
    else fail('disabled Next not read as the last page');
  }
  {
    const bad = listPage([
      card(1),
      card(2, { title: '' }),
      card(3).replace('href="/rd/3"', 'href="https://evil.example/rd/3"'),
      card(4).replace('href="/rd/4"', 'href="/rd/4?x=1"'),
      card(5, { line: 'No Separator Studio', age: 'soon' }),
    ]);
    const { jobs, rawCount } = parseListingPage(bad);
    const sep = jobs.find((j) => j.url.endsWith('/rd/5'));
    if (rawCount === 5 && jobs.length === 2 && jobs[0].url === `${ORIGIN}/rd/1`) pass('drops cards with no title or a non-/rd/{id} href; rawCount still counts them');
    else fail(`malformed rows: rawCount=${rawCount} ${JSON.stringify(jobs)}`);
    if (sep?.company === 'No Separator Studio' && sep.location === '' && !('postedAt' in sep)) pass('a line without " - " is the company; an unknown age leaves postedAt off');
    else fail(`no separator: ${JSON.stringify(sep)}`);
  }

  // ── acceptRedirectTarget() ──
  {
    const ok = acceptRedirectTarget('https://jobs.lever.co/jamcity/bc2e8e13') === 'https://jobs.lever.co/jamcity/bc2e8e13'
      && acceptRedirectTarget('http://www.fireflygames.com/applyjob.php?id=23') === 'http://www.fireflygames.com/applyjob.php?id=23';
    const rejected = ['/rd/5', 'https://gracklehq.com/jobs', 'https://www.gracklehq.com/x', 'javascript:alert(1)', 'mailto:a@b.c',
      'https://user:pw@example.com/', '', null, 42].map((v) => acceptRedirectTarget(/** @type {any} */ (v)));
    if (ok && rejected.every((v) => v === null)) pass('acceptRedirectTarget() keeps absolute http(s) employer URLs only');
    else fail(`acceptRedirectTarget: ok=${ok} ${JSON.stringify(rejected)}`);
  }

  // ── empty vs broken ──
  {
    const ctx = makeCtx(() => listPage([], { total: 0 }));
    const jobs = await grackle.fetch({ name: 'Grackle', provider: 'gracklehq' }, ctx);
    if (Array.isArray(jobs) && jobs.length === 0 && ctx.calls.length === 1) pass('"0 results" with no card → [] in one request');
    else fail(`empty board: ${JSON.stringify(jobs)} calls=${ctx.calls.length}`);
  }
  {
    const broken = listPage([]).replace('<div class="column jobs">', '<div class="column jobs"><div class="redesigned"><a href="/rd/42">Artist</a></div>');
    let threw = null;
    try {
      await grackle.fetch({ provider: 'gracklehq' }, makeCtx(() => broken));
    } catch (err) {
      threw = err;
    }
    if (threw && /markup changed/.test(String(threw))) pass('/rd/ links with zero parsed cards → throws (markup change, not an empty board)');
    else fail(`silent-zero guard: ${threw}`);
    let quiet = true;
    try {
      assertParsedSomething(listPage([], { total: 0 }), ORIGIN);
    } catch {
      quiet = false;
    }
    if (quiet) pass('assertParsedSomething() stays quiet on a page with no posting links');
    else fail('assertParsedSomething() threw on an empty board');
  }
  {
    let threw = null;
    try {
      await grackle.fetch({ provider: 'gracklehq' }, makeCtx(() => '<html><body><h1>Maintenance</h1></body></html>'));
    } catch (err) {
      threw = err;
    }
    if (threw && /not a job listing/.test(String(threw))) pass('a page with no cards and no results count → throws');
    else fail(`unrecognized page: ${threw}`);
  }
  {
    const boom = Object.assign(new Error('HTTP 503'), { status: 503 });
    let caught = null;
    try {
      await grackle.fetch({ provider: 'gracklehq' }, makeCtx(() => { throw boom; }, { }));
    } catch (err) {
      caught = err;
    }
    // fetchTextWithRetry retries a 503 and rethrows the last failure.
    if (caught && /** @type {any} */ (caught).status === 503) pass('a first-page failure propagates (never an empty board)');
    else fail(`first-page failure: ${caught}`);
  }

  // ── pagination ──
  /** @param {number} pages */
  const paged = (pages) => (/** @type {string} */ url) => {
    const p = pageOf(url);
    if (p > pages) return listPage([], { page: p, total: pages });
    return listPage([card(p, { title: `Role ${p}` })], { page: p, last: p === pages, total: pages });
  };
  {
    const ctx = makeCtx(paged(3));
    const jobs = await grackle.fetch({ name: 'Grackle', provider: 'gracklehq', gracklehq: { resolveRedirects: false } }, ctx);
    if (jobs.length === 3 && ctx.calls.map((c) => pageOf(c.url)).join(',') === '1,2,3') pass('walks pageidx=1.. until Next is disabled');
    else fail(`pagination: jobs=${jobs.length} pages=${ctx.calls.map((c) => pageOf(c.url))}`);
    if (ctx.calls[0].url === `${ORIGIN}/jobs?pageidx=1` && ctx.calls[2].url === `${ORIGIN}/jobs?pageidx=3`) pass('page URLs are built on the fixed origin');
    else fail(`page URLs: ${ctx.calls.map((c) => c.url)}`);
    if (ctx.calls.every((c) => c.opts?.redirect === 'error')) pass('every list request passes redirect: "error"');
    else fail(`redirect opts: ${JSON.stringify(ctx.calls.map((c) => c.opts))}`);
  }
  {
    // A Next button that never disables: a page with no card ends the walk.
    const ctx = makeCtx((url) => {
      const p = pageOf(url);
      return p <= 2 ? listPage([card(p)], { page: p, last: false }) : listPage([], { page: p, last: false });
    });
    const jobs = await grackle.fetch({ provider: 'gracklehq', gracklehq: { resolveRedirects: false } }, ctx);
    if (jobs.length === 2 && ctx.calls.length === 3) pass('a page past the end (no card) stops the walk');
    else fail(`past-the-end: jobs=${jobs.length} calls=${ctx.calls.length}`);
  }
  {
    // New postings shift the list mid-walk: a card seen on page 1 reappears on page 2.
    const ctx = makeCtx((url) => (pageOf(url) === 1
      ? listPage([card(10), card(9)], { page: 1, last: false })
      : listPage([card(9), card(8)], { page: 2, last: true })));
    const jobs = await grackle.fetch({ provider: 'gracklehq', gracklehq: { resolveRedirects: false } }, ctx);
    if (jobs.map((j) => j.url.split('/').pop()).join(',') === '10,9,8') pass('a card repeated across pages is kept once');
    else fail(`dedup: ${jobs.map((j) => j.url)}`);
  }
  {
    const ctx = makeCtx(paged(500));
    const { result, lines } = await captureStderr(() => grackle.fetch({ name: 'Grackle', provider: 'gracklehq', gracklehq: { resolveRedirects: false } }, ctx));
    if (ctx.calls.length === 100 && result.length === 100 && lines.some((l) => /raise max_pages/.test(l))) pass('DEFAULT_MAX_PAGES (100) stops a list that keeps paginating, and warns');
    else fail(`default cap: calls=${ctx.calls.length} jobs=${result.length} lines=${lines}`);
  }
  {
    const ctx = makeCtx(paged(500));
    const { result } = await captureStderr(() => grackle.fetch({ provider: 'gracklehq', max_pages: 1000, gracklehq: { resolveRedirects: false } }, ctx));
    if (ctx.calls.length === 200 && result.length === 200) pass('max_pages override is clamped to MAX_PAGES_CAP (200)');
    else fail(`override cap: calls=${ctx.calls.length}`);
  }
  {
    const ctx = makeCtx(paged(2));
    const { lines } = await captureStderr(() => grackle.fetch({ provider: 'gracklehq', max_pages: 2, gracklehq: { resolveRedirects: false } }, ctx));
    if (ctx.calls.length === 2 && !lines.some((l) => /raise max_pages/.test(l))) pass('a list that ends exactly at max_pages is complete — no cap warning');
    else fail(`boundary: calls=${ctx.calls.length} lines=${lines}`);
  }
  {
    const ctx = makeCtx((url) => {
      if (pageOf(url) === 2) throw Object.assign(new Error('HTTP 404'), { status: 404 });
      return paged(5)(url);
    });
    const { result, lines } = await captureStderr(() => grackle.fetch({ name: 'Grackle', provider: 'gracklehq', gracklehq: { resolveRedirects: false } }, ctx));
    if (result.length === 1 && lines.some((l) => /stopped at page 2/.test(l)) && !lines.some((l) => /raise max_pages/.test(l))) {
      pass('a page-2 failure keeps page 1 and warns, without the max_pages warning');
    } else fail(`page-2 failure: jobs=${result.length} lines=${lines}`);
  }
  {
    const ctx = makeCtx(paged(1));
    await grackle.fetch({ provider: 'gracklehq', gracklehq: { search: 'C++ & tools', resolveRedirects: false } }, ctx);
    if (ctx.calls[0].url === `${ORIGIN}/jobs?searchstring=C%2B%2B%20%26%20tools&pageidx=1`) pass('gracklehq.search is encoded into searchstring=');
    else fail(`search URL: ${ctx.calls[0]?.url}`);
  }

  // ── redirect resolution ──
  /** Pages answer the list; /rd/{id} answers a 302 to an employer URL. */
  const board = (/** @type {number[]} */ ids, /** @type {Record<number, any>} */ targets = {}) => (/** @type {string} */ url) => {
    const rd = /\/rd\/(\d+)$/.exec(url);
    if (rd) {
      const t = targets[Number(rd[1])];
      if (t instanceof Error) throw t;
      throw redirectTo(t === undefined ? `https://jobs.lever.co/acme/${rd[1]}` : t);
    }
    return listPage(ids.map((id) => card(id, { title: id % 2 ? 'Gameplay Programmer' : 'Office Manager' })));
  };
  {
    const cache = makeCache();
    const ctx = makeCtx(board([1, 2, 3]), { idCache: cache, titleWanted: (/** @type {string} */ t) => /programmer/i.test(t) });
    const jobs = await grackle.fetch({ provider: 'gracklehq' }, ctx);
    const rdCalls = ctx.calls.filter((c) => c.url.includes('/rd/'));
    if (jobs[0].url === 'https://jobs.lever.co/acme/1' && jobs[2].url === 'https://jobs.lever.co/acme/3' && jobs[1].url === `${ORIGIN}/rd/2`) {
      pass('title-wanted postings get the employer URL; others keep /rd/');
    } else fail(`resolution: ${jobs.map((j) => j.url)}`);
    if (rdCalls.length === 2 && rdCalls.every((c) => c.opts?.redirect === 'manual')) pass('redirects are read with redirect: "manual", never followed');
    else fail(`rd calls: ${JSON.stringify(rdCalls)}`);
    if (cache.store.get('rd:1')?.id === 'https://jobs.lever.co/acme/1' && !cache.store.has('rd:2')) pass('resolved targets are cached per /rd/ id');
    else fail(`cache: ${JSON.stringify([...cache.store])}`);
    if (jobs.every((j) => !('rdId' in j))) pass('no internal field leaks into the returned jobs');
    else fail('rdId leaked');

    const again = makeCtx(board([1, 2, 3]), { idCache: cache, titleWanted: (/** @type {string} */ t) => /programmer/i.test(t) });
    const jobs2 = await grackle.fetch({ provider: 'gracklehq' }, again);
    if (again.calls.filter((c) => c.url.includes('/rd/')).length === 0 && jobs2[0].url === 'https://jobs.lever.co/acme/1') pass('a cached target costs no request on the next scan');
    else fail(`cache reuse: ${again.calls.map((c) => c.url)}`);
  }
  {
    // postingWanted (scan.mjs: title + location + age + dedup) wins over
    // titleWanted, so the budget skips postings the scan drops later.
    const ctx = makeCtx(board([1, 3, 5]), {
      titleWanted: () => true,
      postingWanted: (/** @type {any} */ job) => job.url.endsWith('/rd/3'),
    });
    const jobs = await grackle.fetch({ provider: 'gracklehq', gracklehq: { resolveLimit: 1 } }, ctx);
    const rdCalls = ctx.calls.filter((c) => c.url.includes('/rd/'));
    if (rdCalls.length === 1 && rdCalls[0].url.endsWith('/rd/3') && jobs.find((j) => j.title && j.url === 'https://jobs.lever.co/acme/3')) {
      pass('postingWanted decides which postings spend the lookup budget, over titleWanted');
    } else fail(`postingWanted: ${rdCalls.map((c) => c.url)} / ${jobs.map((j) => j.url)}`);
  }
  {
    const ctx = makeCtx(board([1, 3, 5], {
      1: 'https://gracklehq.com/jobs',
      3: Object.assign(new Error('HTTP 404'), { status: 404 }),
      5: 'javascript:alert(1)',
    }));
    const jobs = await grackle.fetch({ provider: 'gracklehq' }, ctx);
    if (jobs.every((j) => /\/rd\/\d+$/.test(j.url))) pass('a self-redirect, a failed request or a non-http target keeps the /rd/ URL');
    else fail(`unusable targets: ${jobs.map((j) => j.url)}`);
  }
  {
    const ids = [1, 3, 5, 7, 9];
    const ctx = makeCtx(board(ids));
    const { result, lines } = await captureStderr(() => grackle.fetch({ name: 'Grackle', provider: 'gracklehq', gracklehq: { resolveLimit: 2 } }, ctx));
    const resolved = result.filter((/** @type {any} */ j) => j.url.startsWith('https://jobs.lever.co/')).length;
    if (resolved === 2 && ctx.calls.filter((c) => c.url.includes('/rd/')).length === 2 && lines.some((l) => /raise gracklehq\.resolveLimit/.test(l))) {
      pass('resolveLimit bounds the redirect requests (newest first) and warns about the rest');
    } else fail(`resolveLimit: resolved=${resolved} lines=${lines}`);
  }
  {
    const ctx = makeCtx(board([1, 3]));
    const jobs = await grackle.fetch({ provider: 'gracklehq', gracklehq: { resolveRedirects: false } }, ctx);
    if (ctx.calls.length === 1 && jobs.every((j) => j.url.includes('/rd/'))) pass('resolveRedirects: false makes no redirect request');
    else fail(`resolveRedirects false: calls=${ctx.calls.length}`);
  }

  // ── probe cooperation ──
  {
    const ctx = makeCtx((url) => (url.includes('/rd/') ? board([])(url) : paged(5)(url)), { maxPages: 1 });
    const { result, lines } = await captureStderr(() => grackle.fetch({ provider: 'gracklehq' }, ctx));
    if (ctx.calls.length === 1 && result.length === 1 && lines.length === 0) pass('ctx.maxPages: 1 → exactly one list request, no redirect lookups, no warning');
    else fail(`probe: calls=${ctx.calls.map((c) => c.url)} lines=${lines}`);
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
      await grackle.fetch({ provider: 'gracklehq' }, ctx);
    } catch (err) {
      caught = err;
    }
    if (caught === budget) pass('a ctx.fetch rejection while probing propagates unwrapped');
    else fail(`probe rejection: ${caught}`);
  }
} catch (err) {
  fail(`gracklehq tests crashed: ${err && /** @type {any} */ (err).stack || err}`);
}
