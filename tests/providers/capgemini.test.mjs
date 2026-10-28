// tests/providers/capgemini.test.mjs — Capgemini group job platform
// (cg-jobstream-api job-search, used by capgemini.com and brand sites such as
// sogeti.nl). Fixture shape mirrors the live response observed 2026-10-28;
// names and ids are fictional.
import { pass, fail, ROOT, captureConsoleErrors } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — capgemini (Capgemini group cg-jobstream job-search API)');

/** @param {boolean} cond @param {string} label @param {unknown} [got] */
function check(cond, label, got) {
  if (cond) pass(label);
  else fail(`${label} — got ${JSON.stringify(got)}`);
}

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/capgemini.mjs')).href);
  const cg = mod.default;
  const { resolveConfig, buildSearchUrl, cleanApplyUrl, countryName, parseJobSearch } = mod;

  check(cg.id === 'capgemini', 'capgemini.id is "capgemini"', cg.id);

  // ── detect() ──
  const API = 'https://cg-jobstream-api.azurewebsites.net/api/job-search';
  check(cg.detect({ careers_url: 'https://www.capgemini.com/careers/join-capgemini/job-search/' })?.url === API,
    'detect() claims the capgemini.com job-search landing URL');
  check(cg.detect({ careers_url: 'https://capgemini.com/careers/' })?.url === API, 'detect() claims bare capgemini.com');
  check(cg.detect({ api: 'https://cg-jobstream-api.azurewebsites.net/api' })?.url === API, 'detect() claims the API host via api:');
  const rejects = [
    { careers_url: 'https://www.exampleco.nl/werken-bij/vacatures/' }, // branded brand site → explicit provider only
    { careers_url: 'http://www.capgemini.com/careers/' },
    { careers_url: 'https://evilcapgemini.com/careers/' },
    { careers_url: 'https://www.capgemini.com.evil.example/careers/' },
    { api: 'https://cg-jobstream-api.azurewebsites.net.evil.example/api' },
    { api: 'https://other.azurewebsites.net/api' },
    { careers_url: 'not a url' },
    { careers_url: null },
    { careers_url: 42 },
    {},
    null,
    undefined,
  ];
  let detectOk = true;
  for (const e of rejects) {
    try {
      if (cg.detect(e) !== null) detectOk = false;
    } catch {
      detectOk = false;
    }
  }
  check(detectOk, 'detect() returns null (no throw) for branded/untrusted/non-https/malformed/missing input');

  // ── resolveConfig / buildSearchUrl ──
  const cfg = resolveConfig({
    name: 'Acme NL',
    careers_url: 'https://www.exampleco.nl:8443/werken-bij/vacatures/?x=1',
    capgemini: { brand: ['Acme', ' Acme Labs '], country_code: 'xx-nl', search: ' data ' },
  });
  check(cfg.brand === 'Acme,Acme Labs' && cfg.countryCode === 'xx-nl' && cfg.search === 'data',
    'resolveConfig() joins list filters with commas and trims', cfg);
  check(cfg.siteOrigin === 'https://www.exampleco.nl', 'resolveConfig() rebuilds the site origin from the hostname only (no port/path)', cfg.siteOrigin);
  check(resolveConfig({ name: 'X' }).siteOrigin === 'https://www.capgemini.com', 'resolveConfig() falls back to www.capgemini.com without a careers_url');
  const url = new URL(buildSearchUrl(cfg, 2));
  check(url.origin + url.pathname === API && url.searchParams.get('page') === '2' && url.searchParams.get('size') === '100'
    && url.searchParams.get('brand') === 'Acme,Acme Labs' && url.searchParams.get('country_code') === 'xx-nl'
    && url.searchParams.get('search') === 'data', 'buildSearchUrl() sends page/size/brand/country_code/search', url.toString());
  const bare = new URL(buildSearchUrl(resolveConfig({ name: 'X' }), 1));
  check(!bare.searchParams.has('brand') && !bare.searchParams.has('country_code') && !bare.searchParams.has('search'),
    'buildSearchUrl() omits unset filters', bare.toString());

  // Config errors throw before any request.
  for (const [label, entry] of [
    ['api: on a foreign host', { name: 'X', provider: 'capgemini', api: 'https://evil.example/api' }],
    ['api: on http', { name: 'X', provider: 'capgemini', api: 'http://cg-jobstream-api.azurewebsites.net/api' }],
    ['a non-string brand', { name: 'X', provider: 'capgemini', capgemini: { brand: 7 } }],
    ['a non-string country_code entry', { name: 'X', provider: 'capgemini', capgemini: { country_code: ['nl-nl', {}] } }],
    ['a non-string search', { name: 'X', provider: 'capgemini', capgemini: { search: 1 } }],
  ]) {
    let calls = 0;
    let threw = false;
    try {
      await cg.fetch(entry, { sleep: async () => {}, fetchJson: async () => { calls++; return { data: [] }; } });
    } catch {
      threw = true;
    }
    check(threw && calls === 0, `fetch() rejects ${label} before any request`, { threw, calls });
  }

  // ── cleanApplyUrl / countryName ──
  check(cleanApplyUrl('https://careers.capgemini.com/job/Utrecht-Data-Engineer/1000000001/?feedId=1&utm_source=CareerSite&tcsource=apply')
    === 'https://careers.capgemini.com/job/Utrecht-Data-Engineer/1000000001/', 'cleanApplyUrl() strips feedId/utm_*/tcsource');
  check(cleanApplyUrl('https://job-boards.eu.greenhouse.io/acme/jobs/123?gh_jid=123&utm_medium=x')
    === 'https://job-boards.eu.greenhouse.io/acme/jobs/123?gh_jid=123', 'cleanApplyUrl() keeps a non-tracking param');
  check(cleanApplyUrl('http://careers.capgemini.com/job/x/1/') === null && cleanApplyUrl('https://evil.example/job/1') === null
    && cleanApplyUrl('https://evilcapgemini.com/job/1') === null && cleanApplyUrl('') === null && cleanApplyUrl(null) === null,
  'cleanApplyUrl() rejects http, off-host, look-alike and empty URLs');
  check(countryName('nl-nl') === 'Netherlands' && countryName('se-en') === 'Sweden' && countryName('DE') === 'Germany'
    && countryName('') === '' && countryName('zz-qq') === '', 'countryName() resolves locale-shaped codes, empty for unknown');

  // ── parseJobSearch ──
  const row = (over = {}) => ({
    id: '100001-xx_XX_SAPBTP', ref: '100001-xx_XX', source: 'SAP_BTP', brand: 'Acme', country_code: 'nl-nl', country_name: '',
    title: 'Data Engineer', location: 'Utrecht',
    description: '<div><H2>Job Description</H2><div>Build R&amp;D pipelines.</div></div>',
    indexed_at: '2026-10-21T09:54:50.000Z', updated_at: '2026-10-27T12:45:49.000Z',
    apply_job_url: 'https://careers.capgemini.com/job/Utrecht-Data-Engineer/1000000001/?feedId=1&utm_source=CareerSite&tcsource=apply',
    ...over,
  });
  const siteCfg = { siteOrigin: 'https://www.exampleco.nl' };
  const parsed = parseJobSearch({ count: 6, data: [
    row(),
    row({ id: '100002-xx_XX_SAPBTP', ref: '100002-xx_XX', title: 'R&amp;D Lead &amp; Architect', apply_job_url: '', location: 'Utrecht, Amsterdam' }),
    row({ id: '100003-xx_XX_SAPBTP', ref: '100003-xx_XX', apply_job_url: 'https://evil.example/x', indexed_at: 'not a date' }),
    row({ id: '', title: 'No id' }),
    row({ id: '100005-xx_XX_SAPBTP', title: '   ' }),
    'garbage',
  ] }, siteCfg, 'Acme NL');
  const [j1, j2, j3] = parsed.jobs;
  check(parsed.rawCount === 6 && parsed.jobs.length === 3, 'parseJobSearch() counts raw rows and drops rows without id/title', parsed.rawCount);
  check(j1.title === 'Data Engineer' && j1.company === 'Acme NL' && j1.location === 'Utrecht, Netherlands'
    && j1.url === 'https://careers.capgemini.com/job/Utrecht-Data-Engineer/1000000001/', 'parseJobSearch() normalizes title/company/location/url', j1);
  check(j1.postedAt === Date.parse('2026-10-21T09:54:50.000Z'), 'parseJobSearch() maps indexed_at to postedAt', j1.postedAt);
  check(j1.description === 'Job Description Build R&D pipelines.', 'parseJobSearch() fills description from the free list payload as plain text', j1.description);
  check(j1.requisitionId === '100001' && j1.externalId === '100001-xx_XX_SAPBTP' && !('language' in j1),
    'parseJobSearch() sets requisitionId from ref, externalId from id, no language', j1);
  check(j2.title === 'R&D Lead & Architect', 'parseJobSearch() decodes entities in the title', j2.title);
  check(j2.url === 'https://www.exampleco.nl/jobs/100002-xx_XX+sap_btp/rd-lead--architect/',
    'parseJobSearch() falls back to the brand-site posting path when apply_job_url is empty', j2.url);
  check(j3.url.startsWith('https://www.exampleco.nl/jobs/100003-xx_XX+sap_btp/'), 'parseJobSearch() ignores an off-host apply_job_url', j3.url);
  check(!('postedAt' in j3), 'parseJobSearch() omits postedAt for an unparseable date', j3.postedAt);

  // Empty vs broken envelope.
  check(parseJobSearch({ count: 0, data: [] }, siteCfg, 'Acme').jobs.length === 0, 'parseJobSearch() returns [] for a present-and-empty data[]');
  for (const [label, body] of [['{}', {}], ['{data:null}', { data: null }], ['{data:{}}', { data: {} }], ['""', ''], ['42', 42], ['null', null]]) {
    let threw = null;
    try {
      parseJobSearch(body, siteCfg, 'Acme');
    } catch (e) {
      threw = e;
    }
    check(threw instanceof Error && /capgemini: unexpected response/.test(threw.message), `parseJobSearch() throws descriptively on ${label}`, threw?.message);
  }

  // ── fetch(): pagination, redirect:'error', probe, failures ──
  const mk = (n, prefix) => Array.from({ length: n }, (_, i) => row({ id: `${prefix}${i}-x_SAPBTP`, ref: `${prefix}${i}-x`, title: `Job ${prefix}${i}`,
    apply_job_url: `https://careers.capgemini.com/job/X/${prefix}${i}/` }));
  const entry = { name: 'Acme NL', provider: 'capgemini', careers_url: 'https://www.exampleco.nl/vacatures/', capgemini: { brand: 'Acme', country_code: 'nl-nl' } };

  const seenUrls = [];
  let allRedirectError = true;
  const twoPage = await cg.fetch(entry, {
    sleep: async () => {},
    fetchJson: async (u, opts) => {
      seenUrls.push(u);
      if (opts?.redirect !== 'error') allRedirectError = false;
      const page = Number(new URL(u).searchParams.get('page'));
      return { count: 114, data: page === 1 ? mk(100, '1') : page === 2 ? mk(14, '2') : [] };
    },
  });
  check(twoPage.length === 114 && seenUrls.length === 2, 'fetch() walks pages until a short page (100 + 14 → 2 requests)', { n: twoPage.length, calls: seenUrls.length });
  check(seenUrls.map((u) => new URL(u).searchParams.get('page')).join() === '1,2', 'fetch() pages are 1-based');
  check(allRedirectError, "fetch() passes redirect:'error' on every request");
  check(seenUrls.every((u) => new URL(u).searchParams.get('brand') === 'Acme'), 'fetch() forwards the brand filter on every page');
  check(!('_id' in twoPage[0]), 'fetch() strips the internal _id key from returned jobs');

  // Page overlap is de-duplicated, but the short-page stop reads the raw count.
  let overlapCalls = 0;
  const overlap = await cg.fetch(entry, {
    sleep: async () => {},
    fetchJson: async () => { overlapCalls++; return { data: overlapCalls === 1 ? mk(100, 'a') : overlapCalls === 2 ? [...mk(50, 'a'), ...mk(50, 'b')] : mk(3, 'c') }; },
  });
  check(overlap.length === 153 && overlapCalls === 3, 'fetch() de-dups repeated postings and keeps walking past an overlapping full page', { n: overlap.length, overlapCalls });

  // DEFAULT_MAX_PAGES caps an endless board and warns.
  let endlessCalls = 0;
  const endless = () => ({ sleep: async () => {}, fetchJson: async () => { endlessCalls++; return { count: 1e7, data: mk(100, `e${endlessCalls}-`) }; } });
  const { result: capped, errors: capWarn } = await captureConsoleErrors(() => cg.fetch(entry, endless()));
  check(endlessCalls === 20 && capped.length === 2000, 'fetch() stops at DEFAULT_MAX_PAGES (20) whatever count the source reports', { endlessCalls, n: capped.length });
  check(capWarn.some((w) => /raise max_pages/.test(w)) && capped.capgeminiTruncated === true, 'fetch() warns and tags capgeminiTruncated on a cap stop', capWarn);

  endlessCalls = 0;
  await captureConsoleErrors(() => cg.fetch({ ...entry, max_pages: 100_000 }, endless()));
  check(endlessCalls === 100, 'fetch() caps an absurd max_pages at MAX_PAGES_CAP (100)', endlessCalls);

  endlessCalls = 0;
  await captureConsoleErrors(() => cg.fetch({ ...entry, max_pages: 3 }, endless()));
  check(endlessCalls === 3, 'fetch() honors a smaller entry max_pages', endlessCalls);

  // A short final page at the cap boundary is complete, not a cap stop.
  let boundaryCalls = 0;
  const { result: boundary, errors: boundaryWarn } = await captureConsoleErrors(() => cg.fetch({ ...entry, max_pages: 2 }, {
    sleep: async () => {},
    fetchJson: async () => { boundaryCalls++; return { data: boundaryCalls === 1 ? mk(100, 'f') : mk(7, 'g') }; },
  }));
  check(boundary.length === 107 && boundaryWarn.length === 0 && !boundary.capgeminiTruncated, 'fetch() treats a short page at the cap boundary as complete', boundaryWarn);

  // Probe: ctx.maxPages: 1 → exactly one request, no max_pages warning.
  endlessCalls = 0;
  const { result: probe, errors: probeWarn } = await captureConsoleErrors(() => cg.fetch(entry, { ...endless(), maxPages: 1 }));
  check(endlessCalls === 1 && probe.length === 100 && !probeWarn.some((w) => /raise max_pages/.test(w)),
    'fetch() under ctx.maxPages: 1 issues exactly one list request and no max_pages warning', { endlessCalls, probeWarn });

  // Probe: a ctx.fetch* rejection propagates unwrapped, even past page 1.
  class ProbeBudget extends Error {}
  const budgetErr = new ProbeBudget('budget');
  let probeCalls = 0;
  let caught = null;
  try {
    await cg.fetch(entry, { maxPages: 2, sleep: async () => {}, fetchJson: async () => { probeCalls++; if (probeCalls === 1) return { data: mk(100, 'p') }; throw budgetErr; } });
  } catch (e) {
    caught = e;
  }
  check(caught === budgetErr, 'fetch() propagates a ctx.fetch* rejection unwrapped while probing', caught?.message);

  // First-page failure throws (a dead feed is not an empty board).
  let firstCaught = null;
  try {
    await cg.fetch(entry, { sleep: async () => {}, fetchJson: async () => { const e = new Error('Not Found'); e.status = 404; throw e; } });
  } catch (e) {
    firstCaught = e;
  }
  check(firstCaught?.message === 'Not Found', 'fetch() rethrows a first-page failure', firstCaught?.message);

  // Mid-walk failure that exhausts retry: keep pages so far, warn, no max_pages advice.
  let midCalls = 0;
  const { result: mid, errors: midWarn } = await captureConsoleErrors(() => cg.fetch(entry, {
    sleep: async () => {},
    fetchJson: async () => { midCalls++; if (midCalls === 1) return { data: mk(100, 'm') }; throw new Error('upstream 503'); },
  }));
  check(mid.length === 100 && midCalls === 4, 'fetch() keeps page 1 when page 2 exhausts retries (1 + 3 attempts)', { n: mid.length, midCalls });
  check(midWarn.some((w) => /truncated at page 2/.test(w)) && !midWarn.some((w) => /raise max_pages/.test(w)) && mid.capgeminiTruncated === true,
    'fetch() warns on a fetch-error stop without the max_pages advice, and tags it truncated', midWarn);

  // A transient failure that retry clears is silent and complete.
  let retryCalls = 0;
  const { result: recovered, errors: recoveredWarn } = await captureConsoleErrors(() => cg.fetch(entry, {
    sleep: async () => {},
    fetchJson: async () => { retryCalls++; if (retryCalls === 1) { const e = new Error('Too Many Requests'); e.status = 429; throw e; } return { data: mk(5, 'r') }; },
  }));
  check(recovered.length === 5 && retryCalls === 2 && recoveredWarn.length === 0, 'fetch() retries a 429 and recovers silently', { retryCalls, recoveredWarn });
} catch (e) {
  fail(`capgemini provider tests crashed: ${e.stack || e.message}`);
}
