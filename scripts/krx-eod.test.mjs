import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBuild, computeRowsHash } from './build-market-data.mjs';

const originalFetch = globalThis.fetch;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iw-krx-eod-'));
let cases = 0;
async function check({ time, api = false, days, expected, existing, failed = false }) {
  const dir = path.join(root, String(cases++));
  const pricesDir = path.join(dir, 'prices');
  const indicatorsDir = path.join(dir, 'indicators');
  fs.mkdirSync(pricesDir, { recursive: true });
  fs.mkdirSync(indicatorsDir, { recursive: true });
  const universeFile = path.join(dir, 'universe.json');
  const ticker = api ? '0111P0' : '005930';
  fs.writeFileSync(universeFile, JSON.stringify({ symbols: [{ ticker, market: 'KRX' }] }));
  const priceFile = path.join(pricesDir, ticker + '.json');
  const indicatorFile = path.join(indicatorsDir, ticker + '.json');
  if (existing) {
    fs.writeFileSync(priceFile, JSON.stringify(existing));
    fs.writeFileSync(indicatorFile, '{"sentinel":"preserve"}');
  }
  const before = existing && fs.readFileSync(priceFile, 'utf8');
  let requestedCount;
  globalThis.fetch = async url => {
    if (url.includes('fchart.')) {
      requestedCount = new URL(url).searchParams.get('count');
      if (api) return { ok: false };
      return { ok: true, text: async () => days.map(d =>
        `<item data="${d.replaceAll('-', '')}|10|12|9|11|100"/>`).join('') };
    }
    return { ok: true, json: async () => ({ priceInfos: days.map(d => ({
      localDate: d, openPrice: 10, highPrice: 12, lowPrice: 9,
      closePrice: 11, accumulatedTradingVolume: 100
    })) }) };
  };
  const options = { universeFile, pricesDir, indicatorsDir, now: new Date(time) };
  const result = await runBuild(options);
  assert.equal(requestedCount, '501', 'one spare bar preserves 500 completed bars');
  assert.equal(result.failed, failed ? 1 : 0);
  if (failed) {
    if (existing) {
      assert.equal(fs.readFileSync(priceFile, 'utf8'), before);
      assert.equal(fs.readFileSync(indicatorFile, 'utf8'), '{"sentinel":"preserve"}');
    } else {
      assert.equal(fs.existsSync(priceFile), false);
      assert.equal(fs.existsSync(indicatorFile), false);
    }
    return;
  }
  const prices = JSON.parse(fs.readFileSync(priceFile, 'utf8'));
  const indicators = JSON.parse(fs.readFileSync(indicatorFile, 'utf8'));
  assert.deepEqual(prices.rows.map(r => r.d), expected);
  assert.equal(prices.ticker, ticker);
  assert.equal(typeof prices.ticker, 'string');
  assert.equal(indicators.price_date, expected.at(-1));
  assert.equal(indicators.price_rows, expected.length);
  assert.equal(indicators.current_price, prices.rows.at(-1).c);
  assert.equal(prices.rows_hash, computeRowsHash(prices.rows));
  assert.equal(indicators.rows_hash, prices.rows_hash);
  const repeat = await runBuild(options);
  assert.equal(repeat.pricesUnchanged, 1);
  assert.equal(repeat.indicatorsUnchanged, 1);
}

try {
  const prior = '2026-11-19', today = '2026-11-20';
  for (const time of ['2026-11-19T22:00:00Z', '2026-11-20T00:00:00Z',
    '2026-11-20T03:20:00Z', '2026-11-20T06:29:59Z']) {
    await check({ time, days: [prior, today], expected: [prior] });
  }
  // Both Naver provider paths must apply the same pre-close exclusion.
  await check({ time: '2026-11-20T03:20:00Z', api: true,
    days: [prior, today], expected: [prior] });
  for (const time of ['2026-11-20T06:30:00Z', '2026-11-20T07:00:00Z']) {
    await check({ time, days: [prior, today], expected: [prior, today] });
  }
  // KST midnight, Monday/weekend and holiday/no new bar remain calendar-safe.
  await check({ time: '2026-11-19T15:00:00Z', days: [prior, today], expected: [prior] });
  await check({ time: '2026-11-23T02:00:00Z', days: [today, '2026-11-23'], expected: [today] });
  await check({ time: '2026-11-20T02:00:00Z', days: [prior], expected: [prior] });
  const history = Array.from({ length: 501 }, (_, i) =>
    new Date(Date.parse(today) - (500 - i) * 86400000).toISOString().slice(0, 10));
  await check({ time: '2026-11-20T03:00:00Z', days: history, expected: history.slice(0, -1),
    existing: { rows: history.slice(0, -1).map(d => ({ d })) } });
  await check({ time: '2026-11-20T07:00:00Z', days: history, expected: history.slice(1) });
  // Do not loosen existing safety gates when filtering leaves insufficient data.
  await check({ time: '2026-11-20T03:00:00Z', days: [today], failed: true });
  await check({ time: '2026-11-20T03:00:00Z', days: [prior, today],
    existing: { rows: [{ d: prior }, { d: today }] }, failed: true });
  await check({ time: '2026-11-20T03:00:00Z', days: history.slice(1),
    existing: { rows: history.slice(0, -1).map(d => ({ d })) }, failed: true });
  await check({ time: '2026-11-20T03:00:00Z', days: ['2026-11-15', today], failed: true });
  await check({ time: '2026-11-20T03:00:00Z', days: [prior, today, '2026-11-21'], failed: true });
  console.log(`PASS: ${cases} KRX EOD cases, paired hashes and idempotent reruns`);
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(root, { recursive: true, force: true });
}
