import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeRowsHash, formatNyDate, runBuild } from './build-market-data.mjs';
import './price-incremental.test.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iw-build-'));
const universeFile = path.join(root, 'universe.json');
const pricesDir = path.join(root, 'prices');
const indicatorsDir = path.join(root, 'indicators');
const date = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date('2026-11-20T07:00:00Z'));
const prior = new Date(Date.parse(date) - 86400000).toISOString().slice(0, 10);
const responseFor = (days) => days.map(day =>
  `<item data="${day.replaceAll('-', '')}|10|12|9|11|100"/>`).join('');
let days = [prior, date];
const originalFetch = globalThis.fetch;

try {
  fs.writeFileSync(universeFile, JSON.stringify({ symbols: [{ ticker: '005930', market: 'KRX' }] }));
  globalThis.fetch = async () => ({ ok: true, text: async () => responseFor(days) });
  const options = { universeFile, pricesDir, indicatorsDir, now: new Date('2026-11-20T07:00:00Z') };
  const first = await runBuild(options);
  assert.equal(first.pricesUpdated, 1);
  assert.equal(first.indicatorsUpdated, 1);
  const pricesFile = path.join(pricesDir, '005930.json');
  const rawPrices = fs.readFileSync(pricesFile, 'utf8');
  const prices = JSON.parse(rawPrices);
  const indicators = JSON.parse(fs.readFileSync(path.join(indicatorsDir, '005930.json'), 'utf8'));
  assert.equal(prices.ticker, '005930');
  assert.equal(indicators.price_date, prices.rows.at(-1).d);
  assert.match(prices.rows_hash, /^[a-f0-9]{64}$/);
  assert.equal(indicators.rows_hash, prices.rows_hash);
  const rerun = await runBuild(options);
  assert.equal(rerun.pricesUnchanged, 1);
  assert.equal(rerun.indicatorsUnchanged, 1);
  days = [prior];
  const regression = await runBuild(options);
  assert.equal(regression.failed, 1);
  assert.equal(regression.details[0].error, 'UNSAFE_HISTORY');
  assert.equal(fs.readFileSync(pricesFile, 'utf8'), rawPrices);

  // Stage a verified legacy replacement followed by a bounded DELTA. The adapter
  // supplies synthetic evidence here. The ordinary scheduled path never opts in.
  const sessions = [prior, date];
  const requests = [];
  let state = 'ACTIVE';
  let fetchedBasis = 'KR-TEST-SPLIT-EPOCH';
  let race = false;
  const incremental = {
    readEvidence: async () => ({sessions, basis:'KR-TEST-SPLIT-EPOCH', state}),
    fetchVerified: async (target, requested) => {
      requests.push(requested.slice());
      if (race) fs.appendFileSync(pricesFile, '\n');
      return {...target, basis:fetchedBasis, rows:requested.map(d=>({d,o:10,h:12,l:9,c:11,v:100}))};
    }
  };
  const verifiedOptions = {...options, incremental, count:6};
  assert.equal((await runBuild(verifiedOptions)).details[0].mode,'REPAIR');
  const verified = JSON.parse(fs.readFileSync(pricesFile, 'utf8'));
  assert.equal(verified.basis,'KR-TEST-SPLIT-EPOCH');
  assert.equal(verified.rows_hash,computeRowsHash(verified.rows));
  sessions.push('2026-11-23');
  assert.equal((await runBuild({...verifiedOptions,now:new Date('2026-11-23T07:00:00Z')})).details[0].mode,'DELTA');
  assert.deepEqual(requests,[sessions.slice(0,2),sessions]);
  const stagedBefore = fs.readFileSync(pricesFile, 'utf8');
  const indicatorFile = path.join(indicatorsDir,'005930.json');
  const indicatorBefore = fs.readFileSync(indicatorFile, 'utf8');
  assert.equal(JSON.parse(stagedBefore).rows_hash,JSON.parse(indicatorBefore).rows_hash);
  state = 'INACTIVE';
  assert.equal((await runBuild(verifiedOptions)).details[0].status,'SKIPPED');
  assert.equal(requests.length,2);
  state = 'ACTIVE';
  fetchedBasis = 'OTHER_SOURCE';
  assert.equal((await runBuild(verifiedOptions)).details[0].error,'FETCH_IDENTITY_OR_BASIS_MISMATCH');
  assert.equal(fs.readFileSync(pricesFile,'utf8'),stagedBefore);
  assert.equal(fs.readFileSync(indicatorFile,'utf8'),indicatorBefore);
  fetchedBasis = 'KR-TEST-SPLIT-EPOCH';
  race = true;
  assert.equal((await runBuild(verifiedOptions)).details[0].error,'BASELINE_CHANGED_REPLAN');
  assert.equal(fs.readFileSync(pricesFile,'utf8'),stagedBefore+'\n');
  assert.equal(fs.readFileSync(indicatorFile,'utf8'),indicatorBefore);
  const corrupt = {...JSON.parse(stagedBefore), rows_hash:'bad'};
  fs.writeFileSync(pricesFile,JSON.stringify(corrupt));
  assert.equal((await runBuild(verifiedOptions)).details[0].error,'PUBLISHED_PRICE_HASH_INVALID');
  assert.equal(requests.length,4);
  await assert.rejects(runBuild({incremental}), /INCREMENTAL_REQUIRES_STAGING_DIRECTORIES/);

  fs.writeFileSync(universeFile, JSON.stringify({ symbols: [{ ticker: 'SOXL', market: 'US' }] }));
  const nyDate = formatNyDate(options.now.getTime() / 1000);
  const lastBar = Date.parse(nyDate + 'T16:00:00Z') / 1000;
  function yahooBars(count) {
    const timestamp = Array.from({length: count}, (_, i) => lastBar - (count - 1 - i) * 86400);
    const quote = Object.fromEntries(Object.entries({open: 10, high: 12, low: 9, close: 11, volume: 100})
      .map(([field, value]) => [field, Array(count).fill(value)]));
    return {chart: {result: [{timestamp, indicators: {quote: [quote]}}]}};
  }
  const usPricesFile = path.join(pricesDir, 'SOXL.json');
  const existing = {rows: Array.from({length: 500}, () => ({d: nyDate}))};
  fs.writeFileSync(usPricesFile, JSON.stringify(existing));
  globalThis.fetch = async url => ({
    ok: true,
    json: async () => yahooBars(new URL(url).searchParams.get('range') === '5y' ? 520 : 499)
  });
  const us = await runBuild(options);
  assert.equal(us.failed, 0);
  const usPrices = JSON.parse(fs.readFileSync(usPricesFile, 'utf8'));
  const usIndicators = JSON.parse(fs.readFileSync(path.join(indicatorsDir, 'SOXL.json'), 'utf8'));
  assert.equal(usPrices.rows.length, 500);
  assert.equal(usPrices.rows.at(-1).d, nyDate);
  assert.equal(usIndicators.rows_hash, usPrices.rows_hash);
  globalThis.fetch = async () => ({ok: true, json: async () => yahooBars(499)});
  const truncated = await runBuild(options);
  assert.equal(truncated.failed, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(usPricesFile, 'utf8')), usPrices);
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(root, { recursive: true, force: true });
}
