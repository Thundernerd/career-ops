// tests/providers/werkenbijdeoverheid.test.mjs — provider-contract tests for
// the Dutch government vacancy portal (providers/werkenbijdeoverheid.mjs).
//
// Fixtures reproduce shapes measured on the live portal on 2026-10-20:
//
//   - cards are `<section class="vacancy">` blocks served by a Bloomreach
//     component-rendering URL, 20 per page; the title anchor's href and the
//     footer link point at the same posting, so a naive href scan double-counts;
//   - the place is the value span after the `title="Locatie"` icon, the date the
//     Dutch "Plaatsingsdatum: 20 oktober 2026" label;
//   - a page past the end answers 200 with a `vacancy-list-no-result` block;
//   - the listing's tie order is not stable between requests, which is why a
//     complete walk is reconciled against `sitemap-vacatures.xml`.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — werkenbijdeoverheid');

const ORIGIN = 'https://www.werkenbijdeoverheid.nl';

/**
 * One card as the portal renders it (trimmed: icons and salary rows dropped,
 * structure kept).
 * @param {string} slug
 * @param {{ title?: string, employer?: string, location?: string, date?: string }} [o]
 */
function card(slug, o = {}) {
  const { title = 'Adviseur Data', employer = 'Gemeente Acme', location = 'Den Haag', date = '20 oktober 2026' } = o;
  return `
<li class="vacancy-list__item--positioning vacancy-list__item" data-govan-component="search-result-item">
<section class="vacancy" data-baanpleinId="01482-20261006-2026" data-aanjagerType="searchresult-jobs">
<h2 class="vacancy__title" >
<a data-govan-action="view-card" href="/vacatures/${slug}">${title}</a>
</h2>
<p class="vacancy__employer" >${employer}</p>
<ul class="job-short-info--width">
<li class="job-short-info__item job-short-info__item-icon">
<span role="img" title="Locatie" aria-label="Locatie" class="job-short-info__icon job-short-info__icon-color ro_icon-locatiemarker"></span>
<span class="job-short-info__value job-short-info__value-icon">${location}</span>
</li>
</ul>
<div class="job-short-info__top">
Plaatsingsdatum: ${date}
</div>
<div class="vacancy-footer">
<a class="vacancy-footer__link" href="/vacatures/${slug}" aria-label="Bekijk vacature">Bekijk vacature</a>
</div>
</section>
</li>`;
}

/** @param {string[]} cards */
const listPage = (cards) => `
<div id="vacancy-results-container">
<ul id="vacancies-list" class="vacancy-list list_view"
data-resource="${ORIGIN}/vacatures?_hn:type=resource&amp;_hn:ref=r18_r1_r4&amp;_hn:rid=append-next-page-results">
<span id="page1" class="pageIndication"></span>
${cards.join('\n')}
</ul></div>`;

const NO_RESULT_PAGE = `<div id="vacancy-results-container"><div class="vacancy-list-container">
<div class="vacancy-list-no-result"><p>Geen vacatures gevonden</p></div></div></div>`;

/** @param {number} n @param {string} prefix */
const cards = (n, prefix) => Array.from({ length: n }, (_, i) => card(`${prefix}-${i}-ACME-2026-${1000 + i}`, { title: `${prefix} ${i}` }));

/** @param {string[]} urls */
const sitemap = (urls) => `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc><lastmod>2026-10-02T10:45:05Z</lastmod></url>`).join('\n')}
</urlset>`;

/** @param {string} title @param {string} employer */
const detailPage = (title, employer) => `<html><head>
<meta property="og:title" content="${title} • ${employer} | Werken bij de Overheid"/>
</head><body><h1 class="o-header__content">Werken bij de Overheid</h1>
<span role="img" title="Locatie" aria-label="Locatie" class="job-short-info__icon ro_icon-locatiemarker"></span>
<span class="job-short-info__value job-short-info__value-icon">Utrecht</span>
<span class="job-short-info__value job-short-info__value-icon">&nbsp;-&nbsp; <a href="https://maps.example">route</a></span>
<span>Plaatsingsdatum: 3 september 2026</span></body></html>`;

/** @param {string} url */
const pageOf = (url) => Number(new URL(url).searchParams.get('pagina') || '1');
const isList = (/** @type {string} */ url) => url.includes('_hn:type=component-rendering') || url.includes('_hn%3Atype=component-rendering');

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
  const mod = await import(pathToFileURL(join(ROOT, 'providers/werkenbijdeoverheid.mjs')).href);
  const wbdo = mod.default;
  const { parseListingPage, buildListUrl, parsePlaatsingsdatum, assertParsedSomething, extractComponentRefs, parseSitemap, parseDetailPage } = mod;

  if (wbdo.id === 'werkenbijdeoverheid') pass('id is "werkenbijdeoverheid"');
  else fail(`id is ${JSON.stringify(wbdo.id)}`);

  // ── detect() ──
  {
    const want = `${ORIGIN}/vacatures`;
    const positives = [
      { provider: 'werkenbijdeoverheid' },
      { careers_url: 'https://www.werkenbijdeoverheid.nl/vacatures' },
      { careers_url: 'https://werkenbijdeoverheid.nl' },
      { api: 'https://www.werkenbijdeoverheid.nl/vacatures?term=data' },
    ];
    if (positives.every((e) => wbdo.detect(e)?.url === want)) pass('detect() claims provider:, the portal host, and the bare host');
    else fail(`detect() positives: ${JSON.stringify(positives.map((e) => wbdo.detect(e)))}`);

    const negatives = [
      {},
      { careers_url: 'http://www.werkenbijdeoverheid.nl/vacatures' },
      { careers_url: 'https://www.werkenbijdeoverheid.nl.evil.example/vacatures' },
      { careers_url: 'https://evilwerkenbijdeoverheid.nl/' },
      { careers_url: 'not a url' },
      { careers_url: null },
      { careers_url: 42 },
      { provider: 'itviec' },
    ];
    let threw = false;
    let results = [];
    try { results = negatives.map((e) => wbdo.detect(e)); } catch { threw = true; }
    if (!threw && results.every((r) => r === null) && wbdo.detect(null) === null && wbdo.detect(undefined) === null) {
      pass('detect() returns null (never throws) for http, look-alike hosts, junk and missing input');
    } else {
      fail(`detect() negatives: threw=${threw} ${JSON.stringify(results)}`);
    }
  }

  // ── buildListUrl() ──
  {
    const u1 = new URL(buildListUrl({}, 1));
    const u2 = new URL(buildListUrl({ searchKeywords: '  data & AI ' }, 3, 'r9_x'));
    if (u1.origin === ORIGIN && u1.pathname === '/vacatures'
        && u1.searchParams.get('_hn:type') === 'component-rendering'
        && u1.searchParams.get('_hn:ref') === 'r18_r1_r4'
        && !u1.searchParams.has('pagina') && !u1.searchParams.has('term')) {
      pass('buildListUrl(): page 1 is the bare component-rendering URL');
    } else {
      fail(`buildListUrl page 1 drift: ${u1}`);
    }
    if (u2.searchParams.get('pagina') === '3' && u2.searchParams.get('term') === 'data & AI' && u2.searchParams.get('_hn:ref') === 'r9_x') {
      pass('buildListUrl(): pagina, a trimmed and escaped term, and an overridden ref');
    } else {
      fail(`buildListUrl page 3 drift: ${u2}`);
    }
  }

  // ── parsePlaatsingsdatum() ──
  {
    const ok = parsePlaatsingsdatum('Plaatsingsdatum: 20 oktober 2026') === Date.UTC(2026, 9, 20)
      && parsePlaatsingsdatum('Plaatsingsdatum: 1 Januari 2027') === Date.UTC(2027, 0, 1);
    if (ok) pass('parsePlaatsingsdatum() reads Dutch month names, case-insensitively');
    else fail('parsePlaatsingsdatum() drift on a valid label');
    if (parsePlaatsingsdatum('Plaatsingsdatum: 31 februari 2026') === undefined
        && parsePlaatsingsdatum('Plaatsingsdatum: 3 constructor 2026') === undefined
        && parsePlaatsingsdatum('Plaatsingsdatum: binnenkort') === undefined
        && parsePlaatsingsdatum(undefined) === undefined) {
      pass('parsePlaatsingsdatum(): rolled-over dates, prototype names and junk yield undefined');
    } else {
      fail('parsePlaatsingsdatum() invented a date');
    }
  }

  // ── parseListingPage() ──
  {
    const html = listPage([
      card('data-engineer-RVDK-2026-2903', { title: 'Data &amp; AI Engineer', employer: 'Raad voor de Kinderbescherming', location: '&#39;s-Hertogenbosch' }),
      card('beleidsadviseur-UBX-2026-9616', { title: 'Beleidsadviseur', date: 'binnenkort' }),
      card('../../etc-ACME-2026-0001', { title: 'Traversal' }),
      card('x-ACME-2026-0002?utm=1', { title: 'With query' }),
    ]);
    const { jobs, rawCount, recognized } = parseListingPage(html);
    if (recognized && rawCount === 4 && jobs.length === 2) {
      pass('parseListingPage(): one job per card (not per href), bad paths dropped, rawCount counts source cards');
    } else {
      fail(`parseListingPage(): recognized=${recognized} rawCount=${rawCount} jobs=${JSON.stringify(jobs)}`);
    }
    const first = jobs[0];
    if (first && first.title === 'Data & AI Engineer' && first.company === 'Raad voor de Kinderbescherming'
        && first.location === "'s-Hertogenbosch" && first.url === `${ORIGIN}/vacatures/data-engineer-RVDK-2026-2903`
        && first.postedAt === Date.UTC(2026, 9, 20)) {
      pass('parseListingPage(): title/employer/location entity-decoded, absolute URL, postedAt');
    } else {
      fail(`first card drift: ${JSON.stringify(first)}`);
    }
    if (jobs[1] && !('postedAt' in jobs[1])) pass('an unparseable Plaatsingsdatum omits postedAt');
    else fail(`second card drift: ${JSON.stringify(jobs[1])}`);

    const empty = parseListingPage(NO_RESULT_PAGE);
    if (empty.recognized && empty.rawCount === 0 && empty.jobs.length === 0) pass('the no-result block is a recognized, empty page');
    else fail(`no-result drift: ${JSON.stringify(empty)}`);
    if (!parseListingPage('<html><body>Onderhoud</body></html>').recognized) pass('a page with no cards, no list and no no-result block is unrecognized');
    else fail('an unrelated page must not be recognized as a listing');
  }

  // ── assertParsedSomething(): the silent-zero guard ──
  {
    let threw = false;
    try { assertParsedSomething('<div><a href="/vacatures/adviseur-BD-2026-2724">x</a></div>', 'u'); } catch { threw = true; }
    if (threw) pass('assertParsedSomething() throws when vacancy links are present but no card parsed');
    else fail('a page full of vacancy links must not read as empty');
    let threwEmpty = false;
    try { assertParsedSomething(`${NO_RESULT_PAGE}<a href="/vacatures/bewaard">Bewaard</a>`, 'u'); } catch { threwEmpty = true; }
    if (!threwEmpty) pass('assertParsedSomething() lets an empty page through (non-posting /vacatures links do not count)');
    else fail('an empty page threw');
  }

  // ── extractComponentRefs() / parseSitemap() / parseDetailPage() ──
  {
    const page = `<div style="display:none;" id="/vacatures?_hn:type=component-rendering&amp;_hn:ref=r20_r1_r5" class="Async"></div>
<div style="display:none;" id="/vacatures?_hn:type=component-rendering&amp;_hn:ref=r20_r1_r9" class="Async"></div>`;
    const refs = extractComponentRefs(page);
    if (JSON.stringify(refs) === '["r20_r1_r5","r20_r1_r9"]') pass('extractComponentRefs() reads async component refs in document order');
    else fail(`extractComponentRefs drift: ${JSON.stringify(refs)}`);

    const urls = parseSitemap(sitemap([
      `${ORIGIN}/vacatures/a-ACME-2026-0001`,
      `${ORIGIN}/vacatures/a-ACME-2026-0001`,
      `${ORIGIN}/vacatures`,
      `${ORIGIN}/vacatures/b-ACME-2026-0002?x=1`,
      'https://evil.example/vacatures/c-ACME-2026-0003',
      'not a url',
    ]));
    if (JSON.stringify(urls) === JSON.stringify([`${ORIGIN}/vacatures/a-ACME-2026-0001`])) {
      pass('parseSitemap() keeps only this origin’s posting paths, deduped');
    } else {
      fail(`parseSitemap drift: ${JSON.stringify(urls)}`);
    }
    let threw = false;
    try { parseSitemap('<html>Not found</html>'); } catch { threw = true; }
    if (threw) pass('parseSitemap() throws on a non-<urlset> document');
    else fail('parseSitemap() accepted a non-sitemap');

    const job = parseDetailPage(detailPage('R&amp;D Adviseur', 'Ministerie van Acme'), 'U');
    if (job && job.title === 'R&D Adviseur' && job.company === 'Ministerie van Acme' && job.location === 'Utrecht'
        && job.postedAt === Date.UTC(2026, 8, 3) && job.url === 'U') {
      pass('parseDetailPage(): og:title split into title/employer, location and date from the page');
    } else {
      fail(`parseDetailPage drift: ${JSON.stringify(job)}`);
    }
    if (parseDetailPage('<html>404</html>', 'U') === null) pass('parseDetailPage() returns null without og:title');
    else fail('parseDetailPage() invented a job');
  }

  // ── fetch(): walk, short-page stop, sitemap reconciliation, redirect:'error' ──
  {
    const missed = `${ORIGIN}/vacatures/missed-ACME-2026-9999`;
    const gone = `${ORIGIN}/vacatures/gone-ACME-2026-9998`;
    const ctx = makeCtx((url) => {
      if (isList(url)) {
        const p = pageOf(url);
        if (p === 1) return listPage(cards(20, 'p1'));
        if (p === 2) return listPage([...cards(19, 'p2'), card('p1-0-ACME-2026-1000', { title: 'repeat' })]);
        return listPage(cards(3, 'p3'));
      }
      if (url.endsWith('/sitemap-vacatures.xml')) return sitemap([`${ORIGIN}/vacatures/p1-0-ACME-2026-1000`, missed, gone]);
      if (url === missed) return detailPage('Gemiste vacature', 'Waterschap Acme');
      if (url === gone) throw Object.assign(new Error('HTTP 404'), { status: 404 });
      throw new Error(`unexpected ${url}`);
    });
    const { result: jobs, lines } = await captureStderr(() => wbdo.fetch({ name: 'WbdO' }, ctx));
    const listCalls = ctx.calls.filter((c) => isList(c.url));
    if (listCalls.length === 3) pass('fetch() walks until a short page (20 → 20 → 3)');
    else fail(`fetch() list calls: ${listCalls.length}`);
    if (jobs.length === 20 + 19 + 3 + 1) pass('fetch() dedups a repeated card and adds the sitemap-only posting');
    else fail(`fetch() returned ${jobs.length}`);
    const recovered = jobs.find((j) => j.url === missed);
    if (recovered && recovered.company === 'Waterschap Acme') pass('a posting the walk missed is recovered from its detail page');
    else fail(`sitemap residue drift: ${JSON.stringify(recovered)}`);
    if (ctx.calls.some((c) => c.url === gone) && lines.some((l) => /1 of 2 sitemap-only postings could not be read/.test(l))) {
      pass('a failed detail fetch is tolerated and reported, the sweep finishes');
    } else {
      fail(`detail failure handling: ${JSON.stringify(lines)}`);
    }
    if (ctx.calls.length > 0 && ctx.calls.every((c) => c.opts && c.opts.redirect === 'error')) {
      pass('every request (list pages, sitemap, details) passes redirect: "error"');
    } else {
      fail(`redirect option drift: ${JSON.stringify(ctx.calls.map((c) => c.opts && c.opts.redirect))}`);
    }
    if (!lines.some((l) => /max_pages/.test(l))) pass('a naturally-ended walk does not warn about max_pages');
    else fail('max_pages warning fired on a complete walk');
  }

  // ── fetch(): an empty board ──
  {
    const ctx = makeCtx((url) => (isList(url) ? NO_RESULT_PAGE : sitemap([])));
    const jobs = await wbdo.fetch({ name: 'WbdO' }, ctx);
    if (Array.isArray(jobs) && jobs.length === 0) pass('fetch() returns [] for an explicit no-result page');
    else fail(`empty board drift: ${JSON.stringify(jobs)}`);
  }

  // ── fetch(): markup change on page 1 throws ──
  {
    const broken = '<div id="vacancies-list"><li><div class="card-new"><a href="/vacatures/adviseur-BD-2026-2724">Adviseur</a></div></li></div>';
    const ctx = makeCtx((url) => (isList(url) ? broken : ''));
    let msg = '';
    try { await wbdo.fetch({ name: 'WbdO' }, ctx); } catch (err) { msg = String(err && err.message); }
    if (/markup changed/.test(msg)) pass('fetch() throws when page 1 has vacancy links but no parseable card');
    else fail(`markup-change drift: ${msg || 'no throw'}`);
  }

  // ── fetch(): component ref self-heal ──
  {
    const bootstrap = '<div style="display:none;" id="/vacatures?_hn:type=component-rendering&amp;_hn:ref=r30_r2_r1" class="Async"></div>';
    const ctx = makeCtx((url) => {
      if (isList(url)) {
        const ref = new URL(url).searchParams.get('_hn:ref');
        return ref === 'r30_r2_r1' ? listPage(cards(2, 'heal')) : '<html><body></body></html>';
      }
      if (url === `${ORIGIN}/vacatures`) return bootstrap;
      return sitemap([]);
    });
    const jobs = await wbdo.fetch({ name: 'WbdO' }, ctx);
    if (jobs.length === 2 && ctx.calls.some((c) => c.url === `${ORIGIN}/vacatures`)) {
      pass('fetch() re-reads a renumbered component ref from /vacatures once and continues');
    } else {
      fail(`self-heal drift: ${jobs.length} jobs, calls ${JSON.stringify(ctx.calls.map((c) => c.url))}`);
    }

    const dead = makeCtx((url) => (url === `${ORIGIN}/vacatures` ? bootstrap.replace('r30_r2_r1', 'r18_r1_r4') : '<html></html>'));
    let msg = '';
    try { await wbdo.fetch({ name: 'WbdO' }, dead); } catch (err) { msg = String(err && err.message); }
    if (/not a vacancy listing/.test(msg)) pass('fetch() throws when no ref yields a listing');
    else fail(`unrecognized drift: ${msg || 'no throw'}`);
  }

  // ── fetch(): page ceilings ──
  {
    const endless = () => makeCtx((url) => (isList(url) ? listPage(cards(20, `p${pageOf(url)}`)) : sitemap([])));
    const ctxA = endless();
    const { lines } = await captureStderr(() => wbdo.fetch({ name: 'WbdO' }, ctxA));
    const listA = ctxA.calls.filter((c) => isList(c.url)).length;
    if (listA === 100 && lines.some((l) => /raise max_pages/.test(l))) pass('DEFAULT_MAX_PAGES (100) stops a board that never runs short, and warns');
    else fail(`default ceiling drift: ${listA} pages, ${JSON.stringify(lines)}`);
    if (!ctxA.calls.some((c) => c.url.endsWith('/sitemap-vacatures.xml'))) pass('a truncated walk skips sitemap reconciliation');
    else fail('sitemap fetched after a capped walk');

    const ctxB = endless();
    await captureStderr(() => wbdo.fetch({ name: 'WbdO', max_pages: 999 }, ctxB));
    const listB = ctxB.calls.filter((c) => isList(c.url)).length;
    if (listB === 200) pass('an over-large max_pages is clamped to MAX_PAGES_CAP (200)');
    else fail(`cap drift: ${listB} pages`);
  }

  // ── fetch(): the health probe ──
  {
    const ctx = makeCtx((url) => (isList(url) ? listPage(cards(20, `p${pageOf(url)}`)) : sitemap([`${ORIGIN}/vacatures/x-ACME-2026-0001`])), { maxPages: 1 });
    const { lines } = await captureStderr(() => wbdo.fetch({ name: 'WbdO' }, ctx));
    if (ctx.calls.length === 1 && isList(ctx.calls[0].url)) pass('ctx.maxPages: 1 → exactly one list request, no sitemap or detail fetches');
    else fail(`probe drift: ${JSON.stringify(ctx.calls.map((c) => c.url))}`);
    if (!lines.some((l) => /max_pages/.test(l))) pass('the probe cap does not fire the max_pages warning');
    else fail('max_pages warning fired under a probe');

    class ProbeBudget extends Error {}
    const sentinel = new ProbeBudget('budget');
    const probe2 = makeCtx((url) => {
      if (pageOf(url) === 2) throw sentinel;
      return listPage(cards(20, 'p1'));
    }, { maxPages: 2 });
    let caught;
    try { await wbdo.fetch({ name: 'WbdO' }, probe2); } catch (err) { caught = err; }
    if (caught === sentinel) pass('a ctx.fetch* rejection while probing propagates unwrapped');
    else fail(`probe rejection was wrapped or swallowed: ${caught}`);
  }

  // ── fetch(): fetch error on a later page keeps earlier pages ──
  {
    const ctx = makeCtx((url) => {
      if (!isList(url)) return sitemap([]);
      if (pageOf(url) === 2) throw Object.assign(new Error('HTTP 503'), { status: 503 });
      return listPage(cards(20, 'p1'));
    });
    const { result: jobs, lines } = await captureStderr(() => wbdo.fetch({ name: 'WbdO' }, ctx));
    if (jobs.length === 20 && lines.some((l) => /stopped at page 2/.test(l)) && !lines.some((l) => /raise max_pages/.test(l))) {
      pass('a page-2 failure that retry cannot clear keeps page 1 and warns, without the max_pages warning');
    } else {
      fail(`fetch-error drift: ${jobs.length} jobs, ${JSON.stringify(lines)}`);
    }
    if (!ctx.calls.some((c) => c.url.endsWith('/sitemap-vacatures.xml'))) pass('a fetch-error stop skips sitemap reconciliation');
    else fail('sitemap fetched after a broken walk');
    if (ctx.calls.filter((c) => pageOf(c.url) === 2).length === 3) pass('the failing page was retried (default policy: 2 retries)');
    else fail(`retry drift: ${ctx.calls.filter((c) => pageOf(c.url) === 2).length} attempts`);
  }

  // ── fetch(): searchKeywords narrows server-side and skips the sitemap ──
  {
    const ctx = makeCtx((url) => (isList(url) ? listPage(cards(2, 'kw')) : sitemap([`${ORIGIN}/vacatures/other-ACME-2026-0001`])));
    const jobs = await wbdo.fetch({ name: 'WbdO', searchKeywords: 'data' }, ctx);
    if (new URL(ctx.calls[0].url).searchParams.get('term') === 'data' && jobs.length === 2 && ctx.calls.length === 1) {
      pass('searchKeywords sets term= and skips the (unfiltered) sitemap');
    } else {
      fail(`searchKeywords drift: ${JSON.stringify(ctx.calls.map((c) => c.url))}`);
    }
  }
} catch (err) {
  fail(`werkenbijdeoverheid provider tests crashed: ${err && err.stack ? err.stack : err}`);
}
