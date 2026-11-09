import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBuild } from './build-market-data.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iw-build-'));
const universeFile = path.join(root, 'universe.json');
const pricesDir = path.join(root, 'prices');
const indicatorsDir = path.join(root, 'indicators');
const date = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());
const prior = new Date(Date.parse(date) - 86400000).toISOString().slice(0, 10);
const responseFor = (days) => days.map(day =>
  `<item data="${day.replaceAll('-', '')}|10|12|9|11|100"/>`).join('');
let days = [prior, date];
const originalFetch = globalThis.fetch;

try {
  fs.writeFileSync(universeFile, JSON.stringify({ symbols: [{ ticker: '005930', market: 'KRX' }] }));
  globalThis.fetch = async () => ({ ok: true, text: async () => responseFor(days) });
  const options = { universeFile, pricesDir, indicatorsDir };
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
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(root, { recursive: true, force: true });
}
