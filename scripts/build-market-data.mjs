import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const PRICES_DIR = path.join(ROOT_DIR, 'prices');
const INDICATORS_DIR = path.join(ROOT_DIR, 'indicators');
const UNIVERSE_FILE = path.join(ROOT_DIR, 'universe', 'active.json');

export function normalizeTickerString(ticker) {
  if (ticker === null || ticker === undefined) return '';
  const s = String(ticker).trim().toUpperCase();
  if (/^\d{1,5}$/.test(s)) return s.padStart(6, '0');
  return s;
}

export function formatNyDate(epochSec) {
  if (!Number.isFinite(epochSec) || epochSec <= 0) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(epochSec * 1000));
}

export function formatIsoDateText(compactDate) {
  const s = String(compactDate || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  return null;
}

export function validateAndSanitizeRows(rows, maxDays = 500) {
  if (!Array.isArray(rows)) return [];
  const byDate = new Map();
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const d = formatIsoDateText(r.d);
    if (!d) continue;

    const o = Number(r.o);
    const h = Number(r.h);
    const l = Number(r.l);
    const c = Number(r.c);
    const v = Number(r.v);

    if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c) || !Number.isFinite(v)) {
      continue;
    }
    if (o <= 0 || h <= 0 || l <= 0 || c <= 0 || v < 0) {
      continue;
    }
    if (h < Math.max(o, c) * 0.999 || l > Math.min(o, c) * 1.001) {
      continue;
    }

    byDate.set(d, {
      d,
      o: Math.round(o * 1000) / 1000,
      h: Math.round(h * 1000) / 1000,
      l: Math.round(l * 1000) / 1000,
      c: Math.round(c * 1000) / 1000,
      v: Math.round(v)
    });
  }
  return [...byDate.values()].sort((a, b) => a.d.localeCompare(b.d)).slice(-maxDays);
}

export function parseNaverFchart(text, maxDays = 500) {
  const matches = [...String(text || '').matchAll(/<item\s+data="([^"]+)"/g)];
  const rawRows = [];
  for (const m of matches) {
    const parts = m[1].split('|');
    if (parts.length < 6) continue;
    rawRows.push({
      d: parts[0],
      o: Number(parts[1]),
      h: Number(parts[2]),
      l: Number(parts[3]),
      c: Number(parts[4]),
      v: Number(parts[5])
    });
  }
  return validateAndSanitizeRows(rawRows, maxDays);
}

export function parseNaverApiJson(data, maxDays = 500) {
  const list = data?.priceInfos || [];
  const rawRows = list.map(item => ({
    d: item.localDate,
    o: item.openPrice,
    h: item.highPrice,
    l: item.lowPrice,
    c: item.closePrice,
    v: item.accumulatedTradingVolume
  }));
  return validateAndSanitizeRows(rawRows, maxDays);
}

export function parseYahooChart(data, maxDays = 500) {
  const result = data?.chart?.result?.[0];
  if (!result) return [];
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const rawRows = [];
  for (let i = 0; i < timestamps.length; i++) {
    const d = formatNyDate(timestamps[i]);
    if (!d) continue;
    rawRows.push({
      d,
      o: quote.open?.[i],
      h: quote.high?.[i],
      l: quote.low?.[i],
      c: quote.close?.[i],
      v: quote.volume?.[i] ?? 0
    });
  }
  return validateAndSanitizeRows(rawRows, maxDays);
}

async function fetchDomestic(ticker, count = 500) {
  const sym = normalizeTickerString(ticker);
  try {
    const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${sym}&timeframe=day&count=${count}&requestType=0`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.ok) {
      const text = await res.text();
      const rows = parseNaverFchart(text, count);
      if (rows.length > 0) return { ok: true, provider: 'NAVER_FCHART', rows };
    }
  } catch (err) {}

  try {
    const now = new Date();
    const start = new Date(now.getTime() - 400 * 86400000);
    const s = start.toISOString().slice(0, 10).replace(/-/g, '');
    const e = now.toISOString().slice(0, 10).replace(/-/g, '');
    const url = `https://api.stock.naver.com/chart/domestic/item/${sym}?periodType=dayCandle&startDateTime=${s}&endDateTime=${e}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.ok) {
      const data = await res.json();
      const rows = parseNaverApiJson(data, count);
      if (rows.length > 0) return { ok: true, provider: 'NAVER_API', rows };
    }
  } catch (err) {
    return { ok: false, error: err.message, rows: [] };
  }
  return { ok: false, error: 'NO_ROWS', rows: [] };
}

async function fetchUs(ticker, count = 500) {
  const sym = normalizeTickerString(ticker);
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=2y`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return { ok: false, error: `HTTP_${res.status}`, rows: [] };
    const data = await res.json();
    const rows = parseYahooChart(data, count);
    if (rows.length > 0) return { ok: true, provider: 'YAHOO_CHART', rows };
    return { ok: false, error: 'NO_VALID_OHLCV', rows: [] };
  } catch (err) {
    return { ok: false, error: err.message, rows: [] };
  }
}

// -------------------------------------------------------------
// Technical Indicators Pre-computation Engine
// -------------------------------------------------------------

export function sma(a, n) {
  const o = Array(a.length).fill(null);
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    s += Number(a[i]);
    if (i >= n) s -= Number(a[i - n]);
    if (i >= n - 1) o[i] = s / n;
  }
  return o;
}

export function bollinger(a, n = 20, k = 2) {
  const m = sma(a, n);
  const u = Array(a.length).fill(null);
  const l = Array(a.length).fill(null);
  for (let i = n - 1; i < a.length; i++) {
    const w = a.slice(i - n + 1, i + 1);
    const mean = m[i];
    const sd = Math.sqrt(w.reduce((acc, x) => acc + (x - mean) * (x - mean), 0) / (n - 1));
    u[i] = mean + k * sd;
    l[i] = mean - k * sd;
  }
  return { mid: m, upper: u, lower: l };
}

export function rsi(a, n = 14) {
  const o = Array(a.length).fill(null);
  if (a.length <= n) return o;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) {
    const d = a[i] - a[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  let ag = g / n, al = l / n;
  o[n] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = n + 1; i < a.length; i++) {
    const d = a[i] - a[i - 1];
    ag = (ag * (n - 1) + Math.max(d, 0)) / n;
    al = (al * (n - 1) + Math.max(-d, 0)) / n;
    o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return o;
}

export function atr(rows, n = 14) {
  const tr = rows.map((r, i) => i ? Math.max(r.h - r.l, Math.abs(r.h - rows[i - 1].c), Math.abs(r.l - rows[i - 1].c)) : r.h - r.l);
  const o = Array(rows.length).fill(null);
  if (rows.length < n) return o;
  let a = tr.slice(0, n).reduce((acc, v) => acc + v, 0) / n;
  o[n - 1] = a;
  for (let i = n; i < tr.length; i++) {
    a = (a * (n - 1) + tr[i]) / n;
    o[i] = a;
  }
  return o;
}

export function dmi(rows, n = 14) {
  const len = rows.length;
  const adx = Array(len).fill(null);
  if (len < n + 1) return { adx };
  const tr = atr(rows, n);
  const pdm = Array(len).fill(0);
  const mdm = Array(len).fill(0);
  for (let i = 1; i < len; i++) {
    const up = rows[i].h - rows[i - 1].h;
    const down = rows[i - 1].l - rows[i].l;
    pdm[i] = up > down && up > 0 ? up : 0;
    mdm[i] = down > up && down > 0 ? down : 0;
  }
  const ps = sma(pdm, n);
  const ms = sma(mdm, n);
  const dx = Array(len).fill(null);
  for (let i = 0; i < len; i++) {
    if (tr[i] && ps[i] != null && ms[i] != null) {
      const pi = 100 * ps[i] / tr[i];
      const mi = 100 * ms[i] / tr[i];
      dx[i] = (pi + mi) ? 100 * Math.abs(pi - mi) / (pi + mi) : 0;
    }
  }
  const safe = dx.map(x => x == null ? 0 : x);
  const av = sma(safe, n);
  for (let i = 2 * n - 2; i < len; i++) adx[i] = av[i];
  return { adx };
}

export function calcTrendScore(s, ma30, i) {
  let x = 50;
  x += s.price > s.ma30 ? 8 : -8;
  x += (s.ma30 && s.ma60 && s.ma30 > s.ma60) ? 7 : -5;
  x += (s.ma60 && s.ma200 && s.ma60 > s.ma200) ? 7 : -5;
  if (s.rsi14 >= 50 && s.rsi14 <= 70) x += 5;
  if (s.rsi14 > 75) x -= 4;
  if (s.adx14 >= 25) x += 5;
  if (i >= 5 && ma30[i] && ma30[i - 5]) x += (ma30[i] / ma30[i - 5] - 1) > 0 ? 6 : -6;
  return Math.max(0, Math.min(100, Math.round(x)));
}

function roundDec(val, dec = 2) {
  if (val === null || val === undefined || !Number.isFinite(val)) return null;
  const factor = Math.pow(10, dec);
  return Math.round(val * factor) / factor;
}

export function computeTechnicalSnapshot(ticker, rows, currency = 'USD', market = 'US') {
  if (!Array.isArray(rows) || !rows.length) return null;
  const i = rows.length - 1;
  const closes = rows.map(r => r.c);
  const highs = rows.map(r => r.h);
  const lows = rows.map(r => r.l);
  const volumes = rows.map(r => r.v);

  const ma20Arr = sma(closes, 20);
  const ma30Arr = sma(closes, 30);
  const ma60Arr = sma(closes, 60);
  const ma120Arr = sma(closes, 120);
  const ma200Arr = sma(closes, 200);
  const rsiArr = rsi(closes, 14);
  const bb = bollinger(closes, 20, 2);
  const atrArr = atr(rows, 14);
  const dmiRes = dmi(rows, 14);
  const volMa20Arr = sma(volumes, 20);

  const current = closes[i];
  const ma20 = ma20Arr[i];
  const ma30 = ma30Arr[i];
  const ma60 = ma60Arr[i];
  const ma120 = ma120Arr[i];
  const ma200 = ma200Arr[i];
  const rsi14 = rsiArr[i];
  const atr14 = atrArr[i];
  const adx14 = dmiRes.adx[i];
  const vol = volumes[i];
  const volMa20 = volMa20Arr[i];
  const volRatio = volMa20 && volMa20 > 0 ? vol / volMa20 : null;

  const high52 = Math.max(...highs.slice(-252));
  const low52 = Math.min(...lows.slice(-252));
  const support20 = Math.min(...lows.slice(-20));
  const support60 = Math.min(...lows.slice(-60));
  const resistance20 = Math.max(...highs.slice(-20));
  const resistance60 = Math.max(...highs.slice(-60));

  const bbMid = bb.mid[i];
  const bbUpper = bb.upper[i];
  const bbLower = bb.lower[i];
  const bbPercentB = (bbUpper != null && bbLower != null && bbUpper !== bbLower)
    ? (current - bbLower) / (bbUpper - bbLower)
    : null;
  const bbWidthPct = (bbMid && bbUpper != null && bbLower != null)
    ? ((bbUpper - bbLower) / bbMid) * 100
    : null;

  const ma20GapPct = ma20 ? (current / ma20 - 1) * 100 : null;
  const ma30GapPct = ma30 ? (current / ma30 - 1) * 100 : null;
  const ma60GapPct = ma60 ? (current / ma60 - 1) * 100 : null;
  const ma200GapPct = ma200 ? (current / ma200 - 1) * 100 : null;
  const ma30Slope5dPct = (i >= 5 && ma30 && ma30Arr[i - 5])
    ? (ma30 / ma30Arr[i - 5] - 1) * 100
    : null;

  const volSignal = volRatio == null
    ? 'N/A'
    : volRatio >= 1.5
      ? 'HIGH'
      : volRatio <= 0.7
        ? 'LOW'
        : 'NORMAL';

  const trendInput = {
    price: current,
    ma20,
    ma30,
    ma60,
    ma120,
    ma200,
    rsi14,
    atr14,
    adx14,
    volume: vol,
    volumeMA20: volMa20,
    volumeRatio: volRatio,
    high52,
    low52,
    from52HighPct: high52 ? current / high52 - 1 : null
  };
  const trendScore = calcTrendScore(trendInput, ma30Arr, i);
  const trendLabel = trendScore >= 70 ? 'ACCUMULATE' : trendScore >= 50 ? 'HOLD' : trendScore >= 30 ? 'WATCH' : 'REDUCE';
  const technicalAction = trendScore >= 70 ? 'ADD' : trendScore >= 50 ? 'HOLD' : trendScore >= 30 ? 'WATCH' : 'TRIM';

  const nowIso = new Date().toISOString();
  const priceDate = rows[i].d;

  return {
    schema_version: '1.0',
    ticker: normalizeTickerString(ticker),
    updated_at_utc: nowIso,
    source: 'IW_MARKET_DATA_CDN',
    source_status: 'available',
    price_date: priceDate,
    current_price: current,
    avg_price: null,
    quantity: null,
    position_return_pct: null,

    ma20: roundDec(ma20),
    ma30: roundDec(ma30),
    ma60: roundDec(ma60),
    ma120: roundDec(ma120),
    ma200: roundDec(ma200),
    ma20_gap_pct: roundDec(ma20GapPct),
    ma30_gap_pct: roundDec(ma30GapPct),
    ma60_gap_pct: roundDec(ma60GapPct),
    ma200_gap_pct: roundDec(ma200GapPct),
    ma30_slope_5d_pct: roundDec(ma30Slope5dPct),

    rsi14: roundDec(rsi14),
    bb_mid: roundDec(bbMid),
    bb_upper: roundDec(bbUpper),
    bb_lower: roundDec(bbLower),
    bb_percent_b: roundDec(bbPercentB, 4),
    bb_width_pct: roundDec(bbWidthPct),

    volume: vol,
    volume_ma20: roundDec(volMa20),
    volume_ratio: roundDec(volRatio, 3),
    volume_signal: volSignal,

    atr14: roundDec(atr14),
    adx14: roundDec(adx14),

    high52: roundDec(high52),
    low52: roundDec(low52),
    from_high52_pct: high52 ? roundDec((current / high52 - 1) * 100) : null,
    from_low52_pct: low52 ? roundDec((current / low52 - 1) * 100) : null,

    support_20: roundDec(support20),
    support_60: roundDec(support60),
    resistance_20: roundDec(resistance20),
    resistance_60: roundDec(resistance60),

    trend_score: trendScore,
    trend_label: trendLabel,
    technical_action: technicalAction,
    price_rows: rows.length,

    // camelCase aliases for direct object property access
    currentPrice: current,
    priceDate: priceDate,
    ma20GapPct: roundDec(ma20GapPct),
    ma30GapPct: roundDec(ma30GapPct),
    ma60GapPct: roundDec(ma60GapPct),
    ma200GapPct: roundDec(ma200GapPct),
    ma30Slope5dPct: roundDec(ma30Slope5dPct),
    bbMid: roundDec(bbMid),
    bbUpper: roundDec(bbUpper),
    bbLower: roundDec(bbLower),
    bbPercentB: roundDec(bbPercentB, 4),
    bbWidthPct: roundDec(bbWidthPct),
    volumeMA20: roundDec(volMa20),
    volumeRatio: roundDec(volRatio, 3),
    volumeSignal: volSignal,
    fromHigh52Pct: high52 ? roundDec((current / high52 - 1) * 100) : null,
    fromLow52Pct: low52 ? roundDec((current / low52 - 1) * 100) : null,
    support20: roundDec(support20),
    support60: roundDec(support60),
    resistance20: roundDec(resistance20),
    resistance60: roundDec(resistance60),
    trendScore: trendScore,
    trendLabel: trendLabel,
    technicalAction: technicalAction,
    priceRows: rows.length,
    sourceStatus: 'available',

    currency: currency,
    market: market,
    quality: {
      currency: currency,
      priceDataAvailable: true,
      ma200Available: ma200 != null,
      bbAvailable: bbUpper != null && bbLower != null,
      rsiAvailable: rsi14 != null
    }
  };
}

export function computeObjectHash(obj) {
  // Strip updatedAtUtc before hashing so deterministic
  const copy = { ...obj };
  delete copy.updated_at_utc;
  delete copy.updatedAt;
  return crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex');
}

export function computeRowsHash(rows) {
  return crypto.createHash('sha256').update(JSON.stringify(rows || [])).digest('hex');
}

export async function runBuild({
  universeFile = UNIVERSE_FILE,
  pricesDir = PRICES_DIR,
  indicatorsDir = INDICATORS_DIR,
  count = 500,
  dryRun = false
} = {}) {
  if (!fs.existsSync(pricesDir)) {
    fs.mkdirSync(pricesDir, { recursive: true });
  }
  if (!fs.existsSync(indicatorsDir)) {
    fs.mkdirSync(indicatorsDir, { recursive: true });
  }

  const universe = JSON.parse(fs.readFileSync(universeFile, 'utf8'));
  const symbols = universe.symbols || [];
  console.log(`Starting market data build for ${symbols.length} tickers (prices & indicators)...`);

  const summary = {
    total: symbols.length,
    pricesUpdated: 0,
    pricesUnchanged: 0,
    indicatorsUpdated: 0,
    indicatorsUnchanged: 0,
    failed: 0,
    details: []
  };

  for (const item of symbols) {
    const ticker = normalizeTickerString(item.ticker);
    const isKr = item.market === 'KRX' || /^\d{6}$/.test(ticker) || /^\d{4}[A-Z0-9]{2}$/.test(ticker);
    const currency = item.currency || (isKr ? 'KRW' : 'USD');
    const market = isKr ? 'KRX' : 'US';

    let result = null;
    if (isKr) {
      result = await fetchDomestic(ticker, count);
    } else {
      result = await fetchUs(ticker, count);
    }

    if (!result || !result.ok || !result.rows.length) {
      console.warn(`[FAIL] ${ticker}: ${result?.error || 'No rows returned'}`);
      summary.failed++;
      summary.details.push({ ticker, status: 'FAILED', error: result?.error });
      continue;
    }

    // 1. Price Payload
    const priceTargetFile = path.join(pricesDir, `${ticker}.json`);
    const newPriceHash = computeRowsHash(result.rows);

    let existingPrice = null;
    if (fs.existsSync(priceTargetFile)) {
      try {
        existingPrice = JSON.parse(fs.readFileSync(priceTargetFile, 'utf8'));
      } catch (err) {}
    }

    const lastRow = result.rows.at(-1);
    const previousRows = existingPrice?.rows || [];
    const lastPublished = previousRows.at(-1)?.d;
    const now = new Date();
    const today = isKr
      ? new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'}).format(now)
      : formatNyDate(now.getTime() / 1000);
    const age = (Date.parse(today) - Date.parse(lastRow.d)) / 86400000;
    if (!(age >= 0 && age <= 4) || (lastPublished && lastRow.d < lastPublished) ||
        result.rows.length < Math.min(count, previousRows.length)) {
      console.warn(`[FAIL] ${ticker}: stale, regressed, or truncated history`);
      summary.failed++;
      summary.details.push({ ticker, status: 'FAILED', error: 'UNSAFE_HISTORY' });
      continue;
    }

    if (existingPrice?.rows_hash === newPriceHash && computeRowsHash(previousRows) === newPriceHash &&
        existingPrice.currency === currency && existingPrice.market === market && existingPrice.ticker === ticker) {
      summary.pricesUnchanged++;
    } else {
      const pricePayload = {
        ticker,
        updatedAt: new Date().toISOString(),
        currency,
        market,
        rows_hash: newPriceHash,
        rows: result.rows
      };
      if (!dryRun) {
        fs.writeFileSync(priceTargetFile, JSON.stringify(pricePayload, null, 2), 'utf8');
      }
      summary.pricesUpdated++;
    }

    // 2. Indicators Payload
    const indicatorTargetFile = path.join(indicatorsDir, `${ticker}.json`);
    const techSnapshot = computeTechnicalSnapshot(ticker, result.rows, currency, market);
    techSnapshot.rows_hash = newPriceHash;
    const newIndicatorHash = computeObjectHash(techSnapshot);

    let existingIndicatorHash = null;
    if (fs.existsSync(indicatorTargetFile)) {
      try {
        const existing = JSON.parse(fs.readFileSync(indicatorTargetFile, 'utf8'));
        existingIndicatorHash = computeObjectHash(existing);
      } catch (err) {}
    }

    if (existingIndicatorHash === newIndicatorHash) {
      summary.indicatorsUnchanged++;
    } else {
      if (!dryRun) {
        fs.writeFileSync(indicatorTargetFile, JSON.stringify(techSnapshot, null, 2), 'utf8');
      }
      summary.indicatorsUpdated++;
    }

    console.log(`[OK] ${ticker}: ${result.rows.length} rows, Close: ${lastRow.c}, TrendScore: ${techSnapshot.trend_score} (${techSnapshot.trend_label})`);
    summary.details.push({
      ticker,
      rows: result.rows.length,
      lastClose: lastRow.c,
      trendScore: techSnapshot.trend_score,
      trendLabel: techSnapshot.trend_label
    });
  }

  console.log(`\nBuild complete: Total ${summary.total}, Prices (Updated ${summary.pricesUpdated}, Unchanged ${summary.pricesUnchanged}), Indicators (Updated ${summary.indicatorsUpdated}, Unchanged ${summary.indicatorsUnchanged}), Failed ${summary.failed}`);
  return summary;
}

if (process.argv[1] && process.argv[1].endsWith('build-market-data.mjs')) {
  runBuild().then(summary => {
    if (summary.failed || !summary.total) process.exitCode = 1;
  }).catch(err => {
    console.error('Fatal build error:', err);
    process.exit(1);
  });
}
