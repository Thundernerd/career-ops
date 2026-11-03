// tests/providers/tweakers.test.mjs — provider-contract tests for the
// Tweakers Carrière board (providers/tweakers.mjs).
//
// Fixtures reproduce shapes measured on the live API on 2026-11-03:
//
//   - `GET …/jobs?limit=100&page=N&sort=date&filters=tweakers:true …` answers
//     `{page, limit, pages, total, _links, _embedded: {jobs: [...]}}`; the
//     whole board was 4,417 jobs over 45 pages of 100;
//   - each job carries `title`, `dcoTitle`, `company.name`, `workLocation`
//     (`displayName`, `province`, `country.iso`), `workingPlace`, `startDate`,
//     `salary` (`type: monthly | unspecified`), HTML `description`,
//     `apply: {option: 'external', url}` and `_links.detail.href`;
//   - some scraped postings carry a clipped `title` ("Stack Developer") whose
//     full form ends `dcoTitle` ("Full Stack Developer").
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — tweakers');

const API = 'https://api.nationalevacaturebank.nl/api/jobs/v3/sites/nationalevacaturebank.nl/jobs';

/**
 * @param {string} id
 * @param {object} [o]
 */
function job(id, o = {}) {
  return {
    id,
    title: 'Backend Developer',
    dcoTitle: 'Backend Developer',
    company: { name: 'Acme BV', type: 'direct_employer' },
    workLocation: { displayName: 'Rotterdam', city: 'Rotterdam', province: 'Zuid-Holland', country: { iso: 'NL', name: 'Nederland' } },
    workingPlace: null,
    startDate: '2026-11-02T23:00:00Z',
    salary: { min: 4000, max: 5500, type: 'monthly' },
    description: '<p>Bouw mee aan onze API&#39;s</p><ul><li>Node.js</li></ul>',
    apply: { option: 'external', url: `https://jobs.example.com/acme/${id}?utm_source=intermediair&utm_medium=cpc&ref=7` },
    _links: { detail: { href: `https://www.intermediair.nl/vacature/${id}/backend-developer` } },
    ...o,
  };
}

/**
 * @param {any[]} jobs
 * @param {object} [o]
 */
const page = (jobs, o = {}) => ({ page: 1, limit: 100, pages: 1, total: jobs.length, _links: {}, _embedded: { jobs }, ...o });

/** A full page of 100 distinct jobs. */
const fullPage = (/** @type {string} */ prefix, /** @type {number} */ pages = 99) =>
  page(Array.from({ length: 100 }, (_, i) => job(`${prefix}-${i}`)), { pages });

/** @param {string} url */
const pageOf = (url) => Number(new URL(url).searchParams.get('page'));

/**
 * A ctx stub that records every request and its options.
 * @param {(url: string) => any} respond
 * @param {object} [extra]
 */
function makeCtx(respond, extra = {}) {
  /** @type {{url: string, opts: any}[]} */
  const calls = [];
  return {
    calls,
    sleep: async () => {},
    fetchJson: async (/** @type {string} */ url, /** @type {any} */ opts) => {
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

/** Await a promise and return what it threw, or null. */
async function thrown(/** @type {() => Promise<any>} */ fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/tweakers.mjs')).href);
  const tw = mod.default;
  const { normalizeJob, parsePage, parseConfig, buildPageUrl, formatLocation, postingTitle } = mod;

  if (tw.id === 'tweakers') pass('id is "tweakers"');
  else fail(`id is ${JSON.stringify(tw.id)}`);

  // ── detect() ──
  {
    const want = 'https://tweakers.net/carriere/it-banen/zoeken/';
    const positives = [
      { provider: 'tweakers' },
      { careers_url: 'https://tweakers.net/carriere/it-banen/zoeken/' },
      { careers_url: 'https://tweakers.net/carriere' },
      { api: 'https://www.tweakers.net/carriere/it-banen/' },
    ];
    if (positives.every((e) => tw.detect(e)?.url === want)) pass('detect() claims provider: and tweakers.net/carriere URLs');
    else fail(`detect() positives: ${JSON.stringify(positives.map((e) => tw.detect(e)))}`);

    const negatives = [
      {},
      { careers_url: 'http://tweakers.net/carriere/' },
      { careers_url: 'https://tweakers.net/nieuws/' },
      { careers_url: 'https://tweakers.net/carrierefoo' },
      { careers_url: 'https://tweakers.net.evil.example/carriere/' },
      { careers_url: 'https://nottweakers.net/carriere/' },
      { careers_url: 'not a url' },
      { careers_url: 42 },
      { careers_url: null },
      { provider: 'gamejobs' },
    ];
    let ok = true;
    for (const e of negatives) {
      try {
        if (tw.detect(e) !== null) ok = false;
      } catch {
        ok = false;
      }
    }
    if (ok && tw.detect(null) === null && tw.detect(undefined) === null) pass('detect() → null on other hosts, other paths, http, junk, null');
    else fail('detect() negatives');
  }

  // ── normalizeJob() ──
  {
    const j = normalizeJob(job('a1'));
    if (j.title === 'Backend Developer' && j.company === 'Acme BV' && j.url === 'https://jobs.example.com/acme/a1?ref=7'
      && j.location === 'Rotterdam, Zuid-Holland, Netherlands' && j.postedAt === Date.parse('2026-11-02T23:00:00Z')
      && j.description === "Bouw mee aan onze API's Node.js" && j.externalId === 'a1'
      && j.salary?.min === 48000 && j.salary?.max === 66000 && j.salary?.currency === 'EUR') {
      pass('normalizeJob: employer link without utm_*, place, date, decoded description, annual salary');
    } else fail(`normalizeJob: ${JSON.stringify(j)}`);
  }
  {
    const detail = normalizeJob(job('a2', { apply: { option: 'internal', url: 'https://jobs.example.com/x' } }));
    const insecure = normalizeJob(job('a3', { apply: { option: 'external', url: 'http://jobs.example.com/x' } }));
    const fromId = normalizeJob(job('a4', { apply: null, _links: {} }));
    const homepage = normalizeJob(job('a5', { apply: { option: 'external', url: 'https://jobs.example.com/?utm_source=x' } }));
    if (detail.url === 'https://www.intermediair.nl/vacature/a2/backend-developer'
      && insecure.url === 'https://www.intermediair.nl/vacature/a3/backend-developer'
      && fromId.url === 'https://www.nationalevacaturebank.nl/vacature/a4'
      && homepage.url === 'https://www.intermediair.nl/vacature/a5/backend-developer') {
      pass('normalizeJob: no usable or only a homepage employer link → the posting page, else one built from the id');
    } else fail(`url fallback: ${detail.url} ${insecure.url} ${fromId.url}`);
  }
  {
    const surrogate = normalizeJob(job('\uD800', { apply: null, _links: {} }));
    const noTitle = normalizeJob(job('b1', { title: '  ' }));
    if (surrogate === null && noTitle === null && normalizeJob(null) === null) pass('normalizeJob: no title or no encodable URL → null');
    else fail(`normalizeJob drops: ${JSON.stringify([surrogate, noTitle])}`);
  }
  {
    const entity = normalizeJob(job('e1', { title: 'R&amp;D Engineer', dcoTitle: '', company: { name: 'Smith &amp; Co' } }));
    if (entity.title === 'R&D Engineer' && entity.company === 'Smith & Co') pass('entities in title and company are decoded');
    else fail(`entities: ${entity.title} / ${entity.company}`);
  }
  {
    const unspecified = normalizeJob(job('s1', { salary: { min: 0, max: 0, type: 'unspecified' } }));
    const hourly = normalizeJob(job('s2', { salary: { min: 50, type: 'hourly' } }));
    if (!('salary' in unspecified) && hourly.salary?.min === 104000 && hourly.salary?.max === 104000) {
      pass('salary: an unknown type is left off; a one-sided range is filled from the other bound');
    } else fail(`salary: ${JSON.stringify([unspecified.salary, hourly.salary])}`);
  }
  {
    const clipped = postingTitle({ title: 'Stack Developer', dcoTitle: 'Full Stack Developer' });
    const generic = postingTitle({ title: 'Bureauhoofd Functioneel Beheer', dcoTitle: 'Teamleider Functioneel Beheer' });
    const partWord = postingTitle({ title: 'Ops Engineer', dcoTitle: 'DevOps Engineer' });
    if (clipped === 'Full Stack Developer' && generic === 'Bureauhoofd Functioneel Beheer' && partWord === 'Ops Engineer') {
      pass('postingTitle: dcoTitle only repairs a title that is its whole-word ending');
    } else fail(`postingTitle: ${clipped} / ${generic} / ${partWord}`);
  }
  {
    const remote = formatLocation({ workingPlace: 'Werken op afstand', workLocation: { displayName: 'Utrecht', province: 'Utrecht', country: { iso: 'NL' } } });
    const bare = formatLocation({ workingPlace: 'Werken op afstand' });
    const none = formatLocation({});
    if (remote === 'Remote, Utrecht, Netherlands' && bare === 'Remote' && none === '') pass('formatLocation: remote prefix, duplicate city/province collapsed, empty when absent');
    else fail(`formatLocation: ${remote} / ${bare} / ${none}`);
  }

  // ── parsePage(): empty vs broken ──
  {
    const empty = parsePage(page([]));
    const bad = parsePage(page([job('ok'), { id: 'x' }, null]));
    if (empty.jobs.length === 0 && empty.rawCount === 0 && bad.jobs.length === 1 && bad.rawCount === 3) {
      pass('parsePage: an empty jobs[] is an empty board; malformed rows are dropped, counted in rawCount');
    } else fail(`parsePage: ${JSON.stringify([empty, bad.rawCount])}`);
    const broken = [{}, { _embedded: {} }, { _embedded: { jobs: {} } }, { msg: 'Page number must not be greater than 100' }, '', 7, null];
    const errs = broken.map((b) => { try { parsePage(b); return null; } catch (e) { return /** @type {Error} */ (e).message; } });
    if (errs.every((m) => m && m.startsWith('tweakers: unexpected response')) && errs[3].includes('msg')) {
      pass('parsePage: a missing or wrong-typed _embedded.jobs throws, naming what came back');
    } else fail(`parsePage broken: ${JSON.stringify(errs)}`);
  }

  // ── parseConfig() / buildPageUrl() ──
  {
    const { searches } = parseConfig({ tweakers: { searches: [{ query: ' developer ', province: 'zuid-holland', contractType: ['Vast', 'freelance'] }] } });
    const url = new URL(buildPageUrl(searches[0], 3));
    const whole = new URL(buildPageUrl(null, 1));
    if (url.origin + url.pathname === API && url.searchParams.get('limit') === '100' && url.searchParams.get('page') === '3'
      && url.searchParams.get('query') === 'developer' && url.searchParams.get('sort') === 'date'
      && url.searchParams.get('filters') === 'tweakers:true province:Zuid-Holland contractType:Vast,Freelance'
      && whole.searchParams.get('filters') === 'tweakers:true' && !whole.searchParams.has('query')) {
      pass('parseConfig + buildPageUrl: values canonicalized, filters encoded the widget\'s way');
    } else fail(`buildPageUrl: ${url} / ${whole}`);
  }
  {
    const bad = [
      { searches: 'x' },
      { searches: [[]] },
      { searches: [{}] },
      { searches: [{ q: 'dev' }] },
      { searches: [{ query: '' }] },
      { searches: [{ province: 'Brabant' }] },
      { searches: [{ workingPlace: [] }] },
      { searches: [{ contractType: ['Vast', 3] }] },
    ];
    const allThrow = bad.map((t) => { try { parseConfig({ tweakers: t }); return false; } catch { return true; } });
    if (allThrow.every(Boolean) && parseConfig({}).searches.length === 0) pass('parseConfig: unknown keys, unknown values and empty searches throw');
    else fail(`parseConfig throws: ${JSON.stringify(allThrow)}`);
  }

  // ── fetch(): pagination, redirect, dedup ──
  {
    const ctx = makeCtx((url) => (pageOf(url) < 3 ? fullPage(`p${pageOf(url)}`, 3) : page([job('last')], { pages: 3 })));
    const { result, lines } = await captureStderr(() => tw.fetch({ provider: 'tweakers' }, ctx));
    if (result.length === 201 && ctx.calls.length === 3 && ctx.calls.every((c) => c.opts?.redirect === 'error') && lines.length === 0) {
      pass('fetch walks to the short last page, every request with redirect: "error"');
    } else fail(`walk: jobs=${result.length} calls=${ctx.calls.length} lines=${lines}`);
  }
  {
    const ctx = makeCtx((url) => fullPage(`p${pageOf(url)}`, 2));
    const result = await tw.fetch({ provider: 'tweakers' }, ctx);
    if (ctx.calls.length === 2 && result.length === 200) pass('fetch stops at the source\'s page count even on a full page');
    else fail(`pages stop: calls=${ctx.calls.length}`);
  }
  {
    const ctx = makeCtx((url) => fullPage(`p${pageOf(url)}`, 999));
    const { lines } = await captureStderr(() => tw.fetch({ provider: 'tweakers' }, ctx));
    const ctx2 = makeCtx((url) => fullPage(`p${pageOf(url)}`, 999));
    const { lines: lines2 } = await captureStderr(() => tw.fetch({ provider: 'tweakers', max_pages: 5000 }, ctx2));
    if (ctx.calls.length === 60 && lines.length === 1 && lines[0].includes('raise max_pages')
      && ctx2.calls.length === 100 && lines2.length === 1 && lines2[0].includes('no page past 100')) {
      pass('the provider\'s own page ceilings stop a source reporting 999 pages, and warn');
    } else fail(`ceiling: ${ctx.calls.length}/${lines} ${ctx2.calls.length}/${lines2}`);
  }
  {
    const ctx = makeCtx((url) => {
      const q = new URL(url).searchParams.get('query');
      if (q === 'a') return page([job('shared'), job('a-only')]);
      // The second search's first page is fully covered by the first search.
      return pageOf(url) === 1 ? { ...fullPage('dup', 2), _embedded: { jobs: Array.from({ length: 100 }, () => job('shared')) } } : page([job('b-deep')]);
    });
    const result = await tw.fetch({ provider: 'tweakers', tweakers: { searches: [{ query: 'a' }, { query: 'b' }] } }, ctx);
    const ids = result.map((/** @type {any} */ j) => j.externalId);
    if (ids.join(',') === 'shared,a-only,b-deep' && ctx.calls.length === 3) pass('a search whose first page repeats an earlier one still walks its deeper pages; output is de-duplicated');
    else fail(`multi-search: ${ids} calls=${ctx.calls.length}`);
  }

  // ── fetch(): failures ──
  {
    const err = Object.assign(new Error('HTTP 503'), { status: 503 });
    const ctx = makeCtx((url) => {
      if (pageOf(url) === 2) throw err;
      return fullPage('p1', 5);
    });
    const { result, lines } = await captureStderr(() => tw.fetch({ name: 'TW', provider: 'tweakers' }, ctx));
    if (result.length === 100 && lines.length === 1 && lines[0].includes('stopped at page 2') && !lines.some((l) => l.includes('max_pages'))) {
      pass('a page-2 failure that retry cannot clear keeps page 1 and warns, without the max_pages hint');
    } else fail(`page-2 failure: jobs=${result.length} lines=${lines}`);
  }
  {
    const ctx = makeCtx(() => ({ msg: 'boom' }));
    const caught = await thrown(() => tw.fetch({ provider: 'tweakers' }, ctx));
    if (caught && /unexpected response/.test(caught.message)) pass('an unreadable first page fails the target loudly');
    else fail(`first page: ${caught}`);
  }
  {
    const ctx = makeCtx(() => page([]));
    const result = await tw.fetch({ provider: 'tweakers' }, ctx);
    if (Array.isArray(result) && result.length === 0 && ctx.calls.length === 1) pass('an empty board returns []');
    else fail(`empty board: ${JSON.stringify(result)}`);
  }

  // ── probe cooperation ──
  {
    const ctx = makeCtx((url) => fullPage(`p${pageOf(url)}`, 9), { maxPages: 1 });
    const { result, lines } = await captureStderr(() => tw.fetch({ provider: 'tweakers', tweakers: { searches: [{ query: 'a' }, { query: 'b' }] } }, ctx));
    if (ctx.calls.length === 1 && result.length === 100 && lines.length === 0) pass('ctx.maxPages: 1 → exactly one list request, no warning');
    else fail(`probe: calls=${ctx.calls.length} lines=${lines}`);
  }
  {
    class ProbePageBudgetReached extends Error {}
    const budget = new ProbePageBudgetReached('budget');
    const ctx = makeCtx((url) => {
      if (pageOf(url) === 2) throw budget;
      return fullPage('p1', 9);
    }, { maxPages: 2 });
    const caught = await thrown(() => tw.fetch({ provider: 'tweakers' }, ctx));
    if (caught === budget) pass('a ctx.fetch rejection while probing propagates unwrapped');
    else fail(`probe rejection: ${caught}`);
  }
} catch (err) {
  fail(`tweakers tests crashed: ${err && /** @type {any} */ (err).stack || err}`);
}
