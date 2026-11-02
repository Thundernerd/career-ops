// tests/providers/gamejobs.test.mjs — provider-contract tests for the
// GameJobs.co board (providers/gamejobs.mjs).
//
// Fixtures reproduce shapes measured on the live site on 2026-11-02:
//
//   - the Atom feed (`?format=atom`, `/search?…&format=atom`) has 100 entries
//     per page, each with a "{title} at {company}" <title>, a rel="alternate"
//     link to the posting page and an <updated> date, plus a feed-level
//     rel="next" link while more pages follow;
//   - a filtered search ends on a short page with no next link; the
//     unfiltered feed serves page 1 again past its end;
//   - a posting page carries one JobPosting JSON-LD block (country as an ISO
//     code or a name; `jobLocationType: TELECOMMUTE` plus
//     `applicantLocationRequirements` for remote roles) and an Apply link to
//     the employer's ATS.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — gamejobs');

const ORIGIN = 'https://gamejobs.co';

/**
 * @param {string} slug
 * @param {{ title?: string, updated?: string, href?: string }} [o]
 */
function entry(slug, o = {}) {
  const { title = 'Gameplay Programmer at Acme Games', updated = '2026-11-01T10:00:00+00:00', href = `${ORIGIN}/${slug}` } = o;
  return `  <entry>
    <title>${title}</title>
    <id>${href}</id>
    <link rel="alternate" href="${href}"></link>
    <updated>${updated}</updated>
  </entry>`;
}

/**
 * @param {string[]} entries
 * @param {string | null} [next]
 */
const feed = (entries, next = null) => `<feed xmlns="http://www.w3.org/2005/Atom">
  <title>GameJobs.co Jobs</title>
  <id>${ORIGIN}</id>
  <link rel="alternate" href="${ORIGIN}" type="text/html"></link>
  <link rel="self" href="${ORIGIN}/?format=atom" type="application/atom+xml"></link>
  ${next ? `<link rel="next" href="${next}" type="application/atom+xml"></link>` : ''}
  <updated>2026-11-02T12:00:00+00:00</updated>
${entries.join('\n')}
</feed>`;

/** A full page of 100 distinct entries. */
const fullPage = (/** @type {string} */ prefix, /** @type {boolean} */ next = true) =>
  feed(Array.from({ length: 100 }, (_, i) => entry(`${prefix}-${i}`)), next ? `${ORIGIN}/?p=2&amp;format=atom` : null);

/** @param {string} url */
const pageOf = (url) => Number(new URL(url).searchParams.get('p') || '1');

/**
 * @param {any} posting
 * @param {string} [apply]
 */
const detailPage = (posting, apply = 'https://boards.greenhouse.io/acme/jobs/1') => `<html><head>
<script type="application/ld+json">${JSON.stringify({ '@context': 'http://schema.org', '@type': 'JobPosting', ...posting })}</script>
</head><body><a class="btn" href="${ORIGIN}/jobs/1/save">Save</a>
<a class="btn-primary" href="${apply}" target="_blank" rel="noopener nofollow">Apply</a></body></html>`;

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

/** A Map-backed ctx.idCache. */
function makeCache(/** @type {[string, any][]} */ seed = []) {
  const map = new Map(seed);
  return { map, get: (/** @type {string} */ k) => map.get(k), set: (/** @type {string} */ k, /** @type {any} */ v) => map.set(k, v), delete: (/** @type {string} */ k) => map.delete(k) };
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
  const mod = await import(pathToFileURL(join(ROOT, 'providers/gamejobs.mjs')).href);
  const gj = mod.default;
  const { parseFeedPage, parseDetailPage, formatLocation, splitTitle, buildFeedUrl, parseConfig } = mod;

  if (gj.id === 'gamejobs') pass('id is "gamejobs"');
  else fail(`id is ${JSON.stringify(gj.id)}`);

  // ── detect() ──
  {
    const want = `${ORIGIN}/?format=atom`;
    const positives = [
      { provider: 'gamejobs' },
      { careers_url: 'https://gamejobs.co' },
      { careers_url: 'https://gamejobs.co/search?t=Engineering' },
      { api: 'https://www.gamejobs.co/?format=atom' },
    ];
    if (positives.every((e) => gj.detect(e)?.url === want)) pass('detect() claims provider:, the board host and www');
    else fail(`detect() positives: ${JSON.stringify(positives.map((e) => gj.detect(e)))}`);

    const negatives = [
      {},
      { careers_url: 'http://gamejobs.co' },
      { careers_url: 'https://gamejobs.co.evil.example/' },
      { careers_url: 'https://notgamejobs.co/' },
      { careers_url: 'not a url' },
      { careers_url: 42 },
      { careers_url: null },
      { provider: 'greenhouse' },
    ];
    let threw = false;
    let hits = [];
    try {
      hits = negatives.map((e) => gj.detect(/** @type {any} */ (e)));
    } catch {
      threw = true;
    }
    if (!threw && hits.every((h) => h === null)) pass('detect() returns null (no throw) for http, look-alike hosts, junk and missing input');
    else fail(`detect() negatives: threw=${threw} ${JSON.stringify(hits)}`);
    if (gj.detect(/** @type {any} */ (null)) === null) pass('detect(null) → null');
    else fail('detect(null) did not return null');
  }

  // ── splitTitle() ──
  {
    const a = splitTitle('Tools Engineer at Acme at Night');
    const b = splitTitle('Gameplay Programmer');
    if (a.title === 'Tools Engineer at Acme' && a.company === 'Night' && b.title === 'Gameplay Programmer' && b.company === '') {
      pass('splitTitle() splits on the last " at " and keeps a title without one whole');
    } else fail(`splitTitle: ${JSON.stringify([a, b])}`);
  }

  // ── parseFeedPage() ──
  {
    const xml = feed([
      entry('Gameplay-Programmer-at-Acme-Games'),
      entry('Tools-Engineer-at-BigCo', { title: 'Tools &amp; Pipeline Engineer at BigCo &amp; Friends', updated: 'not a date' }),
      entry('elsewhere', { href: 'https://gamejobs.co.evil.example/Job' }),
      entry('http', { href: 'http://gamejobs.co/Job' }),
      entry('deep', { href: `${ORIGIN}/jobs/1/save` }),
      entry('query', { href: `${ORIGIN}/Job?ref=feed` }),
      entry('untitled', { title: '' }),
      entry('surrogate', { href: `${ORIGIN}/Bad-\uD800-Job` }),
    ], `${ORIGIN}/?p=2&amp;format=atom`);
    const { jobs, rawCount, hasNext } = parseFeedPage(xml);
    const [first, second] = jobs;
    if (rawCount === 8 && jobs.length === 2) pass('parseFeedPage() counts every entry and drops off-host, http, nested, query, untitled and lone-surrogate rows');
    else fail(`parseFeedPage counts: raw=${rawCount} jobs=${JSON.stringify(jobs)}`);
    if (first?.title === 'Gameplay Programmer' && first.company === 'Acme Games' && first.location === ''
      && first.url === `${ORIGIN}/Gameplay-Programmer-at-Acme-Games` && first.postedAt === Date.parse('2026-11-01T10:00:00+00:00')) {
      pass('parseFeedPage() maps title, company, posting URL and date; location is empty');
    } else fail(`parseFeedPage first: ${JSON.stringify(first)}`);
    if (second?.title === 'Tools & Pipeline Engineer' && second.company === 'BigCo & Friends' && !('postedAt' in second)) {
      pass('parseFeedPage() decodes entities before splitting and leaves an unparseable date out');
    } else fail(`parseFeedPage second: ${JSON.stringify(second)}`);
    if (hasNext) pass('parseFeedPage() sees the feed-level rel="next" link');
    else fail('parseFeedPage missed rel="next"');
    if (!parseFeedPage(feed([entry('Only-at-Acme')])).hasNext) pass('entry rel="alternate" links are not mistaken for a next link');
    else fail('hasNext true on a feed without a next link');

    const empty = parseFeedPage(feed([]));
    if (empty.jobs.length === 0 && empty.rawCount === 0) pass('a feed with no entries parses as empty');
    else fail(`empty feed: ${JSON.stringify(empty)}`);
    const notFeed = [
      () => parseFeedPage('<html><body>Login</body></html>'),
      () => parseFeedPage(''),
    ].map((f) => {
      try {
        f();
        return null;
      } catch (err) {
        return String(err);
      }
    });
    if (notFeed.every((e) => e && /not an Atom feed/.test(e))) pass('a body without <feed> throws (login page, empty body)');
    else fail(`not-a-feed: ${JSON.stringify(notFeed)}`);
  }

  // ── buildFeedUrl() / parseConfig() ──
  {
    const whole = buildFeedUrl(null, 1);
    const search = buildFeedUrl({ t: 'Engineering', w: 'The Hague & Delft' }, 3);
    const u = new URL(search);
    if (whole === `${ORIGIN}/?format=atom` && u.pathname === '/search' && u.searchParams.get('p') === '3'
      && u.searchParams.get('t') === 'Engineering' && u.searchParams.get('w') === 'The Hague & Delft' && u.searchParams.get('format') === 'atom') {
      pass('buildFeedUrl() builds the board feed and an encoded search feed with its page');
    } else fail(`buildFeedUrl: ${whole} ${search}`);

    const cfg = parseConfig({ gamejobs: { searches: [{ t: ' Engineering ' }], fetchDetails: true, detailLimit: 5000 } });
    const none = parseConfig({});
    if (cfg.searches[0].t === 'Engineering' && cfg.fetchDetails && cfg.detailLimit === 1000
      && none.searches.length === 0 && !none.fetchDetails && none.detailLimit === 100) {
      pass('parseConfig() trims searches, clamps detailLimit to 1000 and defaults to the whole board without details');
    } else fail(`parseConfig: ${JSON.stringify([cfg, none])}`);

    const bad = [
      { gamejobs: { searches: 'Engineering' } },
      { gamejobs: { searches: [{ team: 'Engineering' }] } },
      { gamejobs: { searches: [{ t: '' }] } },
      { gamejobs: { searches: [{}] } },
      { gamejobs: { searches: [['t', 'Engineering']] } },
    ];
    const results = [];
    for (const e of bad) {
      const ctx = makeCtx(() => fullPage('x'));
      const err = await thrown(() => gj.fetch(e, ctx));
      results.push(!!err && ctx.calls.length === 0);
    }
    if (results.every(Boolean)) pass('a malformed gamejobs.searches throws before any request');
    else fail(`config errors: ${JSON.stringify(results)}`);
  }

  // ── formatLocation() / parseDetailPage() ──
  {
    const onsite = formatLocation({ jobLocation: { address: { addressLocality: 'Utrecht', addressCountry: 'NL' } } });
    const multi = formatLocation({ jobLocation: [
      { address: { addressLocality: 'Warsaw', addressCountry: 'Poland' } },
      { address: { addressLocality: 'Kraków', addressRegion: 'Kraków', addressCountry: 'PL' } },
    ] });
    const remote = formatLocation({
      jobLocation: { address: { addressRegion: 'California', addressCountry: 'US' } },
      jobLocationType: 'TELECOMMUTE',
      applicantLocationRequirements: [{ '@type': 'Country', name: 'NL' }, { '@type': 'Country', name: 'Belgium' }],
    });
    const remoteNoReq = formatLocation({ jobLocation: { address: { addressCountry: 'DE' } }, jobLocationType: 'TELECOMMUTE' });
    const bare = formatLocation({ jobLocationType: ['TELECOMMUTE'] });
    if (/^Utrecht, Netherlands$/.test(onsite) && /^Warsaw, Poland \/ Kraków, Poland$/.test(multi)
      && /^Remote, Netherlands \/ Belgium$/.test(remote) && remoteNoReq === 'Remote, Germany' && bare === 'Remote' && formatLocation({}) === '') {
      pass('formatLocation() resolves ISO codes, joins places, drops a repeated region and formats remote roles');
    } else fail(`formatLocation: ${JSON.stringify([onsite, multi, remote, remoteNoReq, bare])}`);

    const d = parseDetailPage(detailPage({
      title: 'Tools &amp; Pipeline Engineer',
      hiringOrganization: { '@type': 'Organization', name: 'Acme Games' },
      jobLocation: { '@type': 'Place', address: { addressLocality: 'Rotterdam', addressCountry: 'The Netherlands' } },
    }));
    if (d.title === 'Tools & Pipeline Engineer' && d.company === 'Acme Games' && d.location === 'Rotterdam, The Netherlands'
      && d.applyUrl === 'https://boards.greenhouse.io/acme/jobs/1') {
      pass('parseDetailPage() reads the JobPosting and the employer Apply link');
    } else fail(`parseDetailPage: ${JSON.stringify(d)}`);
    const selfLink = parseDetailPage(detailPage({ title: 'X' }, `${ORIGIN}/login`));
    const mailto = parseDetailPage(detailPage({ title: 'X' }, 'mailto:jobs@example.com'));
    if (selfLink.applyUrl === '' && mailto.applyUrl === '') pass('an Apply link back to the board or to mailto: is not an employer URL');
    else fail(`apply link filter: ${JSON.stringify([selfLink, mailto])}`);
    let threw = null;
    try {
      parseDetailPage('<html><script type="application/ld+json">{"@type":"Organization"}</script></html>');
    } catch (err) {
      threw = err;
    }
    if (threw && /no JobPosting/.test(String(threw))) pass('a posting page without JobPosting JSON-LD throws');
    else fail(`detail without JobPosting: ${threw}`);
  }

  // ── fetch(): walking ──
  {
    const ctx = makeCtx(() => feed([entry('A-at-Acme'), entry('B-at-Acme')]));
    const { result, lines } = await captureStderr(() => gj.fetch({ name: 'GJ', provider: 'gamejobs' }, ctx));
    if (result.length === 2 && ctx.calls.length === 1 && lines.length === 0) pass('a short page with no next link ends the walk, no warning');
    else fail(`short page: jobs=${result.length} calls=${ctx.calls.length} lines=${lines}`);
    if (ctx.calls.every((c) => c.opts?.redirect === 'error')) pass('list requests pass redirect: "error"');
    else fail(`redirect opts: ${JSON.stringify(ctx.calls.map((c) => c.opts))}`);
  }
  {
    const ctx = makeCtx(() => feed([]));
    const result = await gj.fetch({ provider: 'gamejobs' }, ctx);
    if (Array.isArray(result) && result.length === 0) pass('an empty feed → [] (empty board)');
    else fail(`empty feed: ${JSON.stringify(result)}`);
  }
  {
    const ctx = makeCtx(() => feed([entry('x', { href: 'https://elsewhere.example/Job' }), entry('y', { href: 'https://elsewhere.example/Job2' })]));
    const err = await thrown(() => gj.fetch({ provider: 'gamejobs' }, ctx));
    if (err && /none could be parsed/.test(String(err))) pass('entries present but none parsed on page 1 → throws (format change, not an empty board)');
    else fail(`unparseable page 1: ${err}`);
  }
  {
    const ctx = makeCtx(() => '<html><body>Login</body></html>');
    const err = await thrown(() => gj.fetch({ provider: 'gamejobs' }, ctx));
    if (err && /not an Atom feed/.test(String(err))) pass('page 1 that is not a feed → throws');
    else fail(`page 1 not a feed: ${err}`);
  }
  {
    // The unfiltered feed past its end serves page 1 again with a next link.
    const ctx = makeCtx((url) => (pageOf(url) === 2 ? fullPage('p2') : fullPage('p1')));
    const { result, lines } = await captureStderr(() => gj.fetch({ name: 'GJ', provider: 'gamejobs' }, ctx));
    if (result.length === 200 && ctx.calls.length === 3 && lines.length === 0) pass('a page with nothing new to the walk (the feed wrapping to page 1) ends it, no warning');
    else fail(`wrap: jobs=${result.length} calls=${ctx.calls.length} lines=${lines}`);
  }
  {
    const ctx = makeCtx((url) => fullPage(`p${pageOf(url)}`));
    const { result, lines } = await captureStderr(() => gj.fetch({ name: 'GJ', provider: 'gamejobs' }, ctx));
    if (ctx.calls.length === 100 && result.length === 10000 && lines.some((l) => /raise max_pages/.test(l))) pass('DEFAULT_MAX_PAGES (100) stops a feed that keeps paginating, and warns');
    else fail(`default cap: calls=${ctx.calls.length} jobs=${result.length} lines=${lines}`);
  }
  {
    const ctx = makeCtx((url) => fullPage(`p${pageOf(url)}`));
    const { lines } = await captureStderr(() => gj.fetch({ name: 'GJ', provider: 'gamejobs', max_pages: 5000 }, ctx));
    if (ctx.calls.length === 200 && lines.some((l) => /raise max_pages/.test(l))) pass('max_pages is capped at 200');
    else fail(`max cap: calls=${ctx.calls.length}`);
  }
  {
    const ctx = makeCtx((url) => (pageOf(url) === 1 ? fullPage('p1') : feed([entry('Last-at-Acme')])));
    const { result, lines } = await captureStderr(() => gj.fetch({ name: 'GJ', provider: 'gamejobs', max_pages: 2 }, ctx));
    if (result.length === 101 && ctx.calls.length === 2 && !lines.some((l) => /raise max_pages/.test(l))) pass('a short final page at max_pages is complete — no cap warning');
    else fail(`boundary: jobs=${result.length} calls=${ctx.calls.length} lines=${lines}`);
  }
  {
    const ctx = makeCtx((url) => {
      if (pageOf(url) === 2) throw Object.assign(new Error('HTTP 503'), { status: 503 });
      return fullPage('p1');
    });
    const { result, lines } = await captureStderr(() => gj.fetch({ name: 'GJ', provider: 'gamejobs' }, ctx));
    if (result.length === 100 && lines.some((l) => /stopped at page 2/.test(l)) && !lines.some((l) => /raise max_pages/.test(l))) {
      pass('a page-2 failure keeps page 1 and warns, without the max_pages warning');
    } else fail(`page-2 failure: jobs=${result.length} lines=${lines}`);
  }
  {
    // Search B's first page is all postings search A already returned; its
    // page 2 still holds new ones.
    const ctx = makeCtx((url) => {
      const u = new URL(url);
      const w = u.searchParams.get('w');
      if (w === 'A') return feed([entry('Shared-at-Acme')]);
      return pageOf(url) === 1
        ? feed([entry('Shared-at-Acme'), ...Array.from({ length: 99 }, (_, i) => entry(`B1-${i}`))], `${ORIGIN}/search?p=2`)
        : feed([entry('B2-only-at-Acme')]);
    });
    const result = await gj.fetch({ provider: 'gamejobs', gamejobs: { searches: [{ w: 'A' }, { t: 'Engineering', w: 'B' }] } }, ctx);
    const urls = result.map((/** @type {any} */ j) => j.url);
    if (ctx.calls.length === 3 && result.length === 101 && urls.includes(`${ORIGIN}/B2-only-at-Acme`)
      && new URL(ctx.calls[1].url).searchParams.get('t') === 'Engineering') {
      pass('each search walks its own pages; one overlapping an earlier search still returns its deeper postings, de-duplicated');
    } else fail(`multi-search: calls=${ctx.calls.map((c) => c.url)} jobs=${result.length}`);
  }

  // ── fetch(): details ──
  const DETAIL = detailPage({
    title: 'Gameplay Programmer',
    hiringOrganization: { name: 'Acme Games' },
    jobLocation: { address: { addressLocality: 'Rotterdam', addressCountry: 'NL' } },
  }, 'https://jobs.ashbyhq.com/acme/123');
  /** @param {number} n */
  const listing = (n) => feed(Array.from({ length: n }, (_, i) => entry(`Job-${i}-at-Acme`)));
  /** @param {string} url */
  const isDetail = (url) => !new URL(url).searchParams.has('format');
  {
    const ctx = makeCtx((url) => (isDetail(url) ? DETAIL : listing(3)));
    const result = await gj.fetch({ provider: 'gamejobs' }, ctx);
    if (ctx.calls.length === 1 && result.every((/** @type {any} */ j) => j.location === '')) pass('without fetchDetails no posting page is requested');
    else fail(`no details: calls=${ctx.calls.length}`);
  }
  {
    const cache = makeCache();
    const ctx = makeCtx((url) => (isDetail(url) ? DETAIL : listing(3)), { idCache: cache });
    const result = await gj.fetch({ provider: 'gamejobs', gamejobs: { fetchDetails: true } }, ctx);
    const [job] = result;
    if (job?.location === 'Rotterdam, Netherlands' && job.url === 'https://jobs.ashbyhq.com/acme/123' && job.company === 'Acme Games'
      && ctx.calls.length === 4 && ctx.calls.every((c) => c.opts?.redirect === 'error') && cache.map.size === 3) {
      pass('fetchDetails fills location, uses the employer link as url, caches each posting, and passes redirect: "error"');
    } else fail(`details: ${JSON.stringify(job)} calls=${ctx.calls.length} cache=${cache.map.size}`);

    const again = makeCtx((url) => (isDetail(url) ? DETAIL : listing(3)), { idCache: cache });
    const second = await gj.fetch({ provider: 'gamejobs', gamejobs: { fetchDetails: true } }, again);
    if (again.calls.length === 1 && second[0].location === 'Rotterdam, Netherlands' && second[0].url === 'https://jobs.ashbyhq.com/acme/123') {
      pass('a cached posting is applied on the next scan without a request');
    } else fail(`cache reuse: calls=${again.calls.length} ${JSON.stringify(second[0])}`);
  }
  {
    const stale = { title: 'Old', company: 'Old', location: 'Oldtown', applyUrl: '', checkedAt: '2020-01-01T00:00:00.000Z' };
    const cache = makeCache([['/Job-0-at-Acme', stale]]);
    const ctx = makeCtx((url) => (isDetail(url) ? DETAIL : listing(1)), { idCache: cache });
    const [job] = await gj.fetch({ provider: 'gamejobs', gamejobs: { fetchDetails: true } }, ctx);
    if (ctx.calls.length === 2 && job.location === 'Rotterdam, Netherlands') pass('a cache entry older than 180 days is looked up again');
    else fail(`stale cache: calls=${ctx.calls.length} ${JSON.stringify(job)}`);
  }
  {
    const ctx = makeCtx((url) => (isDetail(url) ? DETAIL : listing(40)));
    const { result, lines } = await captureStderr(() => gj.fetch({ name: 'GJ', provider: 'gamejobs', gamejobs: { fetchDetails: true, detailLimit: 10 } }, ctx));
    const filled = result.filter((/** @type {any} */ j) => j.location).length;
    if (ctx.calls.filter((c) => isDetail(c.url)).length === 10 && filled === 10 && result.length === 40 && lines.some((l) => /30 more have no location/.test(l))) {
      pass('detailLimit caps the lookups at 10 of 40 postings and says how many are left');
    } else fail(`detailLimit: details=${ctx.calls.filter((c) => isDetail(c.url)).length} filled=${filled} lines=${lines}`);
  }
  {
    const cache = makeCache();
    let detailCalls = 0;
    const ctx = makeCtx((url) => {
      if (!isDetail(url)) return listing(3);
      detailCalls++;
      if (url.includes('Job-0')) throw Object.assign(new Error('HTTP 404'), { status: 404 });
      if (url.includes('Job-1')) return '<html><body>No data</body></html>';
      return DETAIL;
    }, { idCache: cache });
    const { result, lines } = await captureStderr(() => gj.fetch({ name: 'GJ', provider: 'gamejobs', gamejobs: { fetchDetails: true } }, ctx));
    if (result.length === 3 && result[0].url === `${ORIGIN}/Job-0-at-Acme` && result[0].location === '' && result[1].location === ''
      && result[2].location === 'Rotterdam, Netherlands' && detailCalls === 3 && cache.map.size === 1 && lines.length === 2) {
      pass('a failed or unreadable posting page keeps the row as listed, is not cached, and the sweep finishes');
    } else fail(`detail failure: ${JSON.stringify(result.map((/** @type {any} */ j) => [j.url, j.location]))} cache=${cache.map.size} lines=${lines}`);
  }

  // ── probe cooperation ──
  {
    const ctx = makeCtx((url) => (isDetail(url) ? DETAIL : fullPage(`p${pageOf(url)}`)), { maxPages: 1 });
    const { result, lines } = await captureStderr(() => gj.fetch({ provider: 'gamejobs', gamejobs: { searches: [{ t: 'Engineering' }, { t: 'Art' }], fetchDetails: true } }, ctx));
    if (ctx.calls.length === 1 && result.length === 100 && lines.length === 0) pass('ctx.maxPages: 1 → exactly one list request, no detail lookups, no warning');
    else fail(`probe: calls=${ctx.calls.length} lines=${lines}`);
  }
  {
    class ProbePageBudgetReached extends Error {}
    const budget = new ProbePageBudgetReached('budget');
    const ctx = makeCtx((url) => {
      if (pageOf(url) === 2) throw budget;
      return fullPage('p1');
    }, { maxPages: 2 });
    const caught = await thrown(() => gj.fetch({ provider: 'gamejobs' }, ctx));
    if (caught === budget) pass('a ctx.fetch rejection while probing propagates unwrapped');
    else fail(`probe rejection: ${caught}`);
  }
} catch (err) {
  fail(`gamejobs tests crashed: ${err && /** @type {any} */ (err).stack || err}`);
}
