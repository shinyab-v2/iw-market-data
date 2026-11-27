// IW-OPS-10: pure candidate implementation. No network, filesystem, or production writes.
// Sessions must be independently verified, ordered, completed, eligible trading sessions.
// Basis must identify a verified provider/adjustment contract and corporate-action epoch.
import {createHash} from 'node:crypto';
const MAX_BARS = 500;
const digest = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const MODES = new Set(['FULL', 'DELTA', 'GAP', 'REPAIR']);
function fail(code) { throw new Error(code); }
function validDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s;
}
function identity(x, requireBasis = true) {
  if (!x || typeof x.ticker !== 'string' || !/^[A-Z0-9][A-Z0-9.\-]*$/.test(x.ticker)) fail('INVALID_TICKER');
  if (!['US','KRX'].includes(x.market) || x.currency !== (x.market === 'US' ? 'USD' : 'KRW')) fail('INVALID_MARKET_CURRENCY');
  if (requireBasis && (typeof x.basis !== 'string' || !x.basis.trim())) fail('UNVERIFIED_BASIS');
}
function sameIdentity(a,b) { return a.ticker === b.ticker && a.market === b.market && a.currency === b.currency; }
function sessionsOf(sessions) {
  if (!Array.isArray(sessions) || !sessions.length || sessions.some((s,i) => !validDate(s) || (i && s <= sessions[i-1]))) fail('INVALID_SESSION_CALENDAR');
  return sessions.slice(-MAX_BARS);
}
function validateRows(rows, expected) {
  if (!Array.isArray(rows)) fail('INVALID_ROWS');
  let prev = '';
  const allowed = new Set(expected);
  return rows.map(r => {
    if (!r || !validDate(r.d) || r.d <= prev || !allowed.has(r.d)) fail('INVALID_BAR_SESSION');
    for (const k of ['o','h','l','c']) if (!Number.isFinite(r[k]) || r[k] <= 0) fail('INVALID_OHLC');
    if (r.h < Math.max(r.o,r.c,r.l) || r.l > Math.min(r.o,r.c,r.h) || !Number.isFinite(r.v) || r.v < 0) fail('INVALID_OHLCV');
    prev = r.d;
    return {d:r.d,o:r.o,h:r.h,l:r.l,c:r.c,v:r.v};
  });
}
export function planPriceUpdate({target, state, existing, sessions, overlap=(state==='REACTIVATING'?5:4), forceRepair=false}) {
  if (!['NEW','ACTIVE','INACTIVE','REACTIVATING'].includes(state)) fail('INVALID_STATE');
  identity(target, state !== 'INACTIVE');
  if (state === 'INACTIVE') {
    return {mode:'SKIP', reason:'INACTIVE_PRESERVE', requested:[]};
  }
  if (!Number.isInteger(overlap) || overlap < 1 || overlap > MAX_BARS) fail('INVALID_OVERLAP');
  const expected = sessionsOf(sessions);
  const baselineHash = digest(existing ?? null);
  if (existing && !sameIdentity(existing,target)) fail('IDENTITY_MISMATCH');
  const full = (mode,reason) => ({mode,reason,requested:expected.slice(),expected:expected.slice(),baselineHash});
  if (forceRepair) return full('REPAIR','FORCED_REPAIR');
  if (!existing || !Array.isArray(existing.rows) || !existing.rows.length) return full('FULL','NO_HISTORY');
  if (typeof existing.basis !== 'string' || !existing.basis.trim()) return full('REPAIR','LEGACY_BASIS_UNVERIFIED');
  if (existing.basis !== target.basis) return full('REPAIR','BASIS_CHANGED');
  // Old bars outside the retention window are ignored, but malformed/future bars never silently accepted.
  const dates = existing.rows.map(r=>r?.d);
  if (dates.some((d,i)=>!validDate(d)||(i&&d<=dates[i-1])||d>expected.at(-1))) fail('INVALID_EXISTING_HISTORY');
  const rows = validateRows(existing.rows.filter(r=>r.d>=expected[0]), expected);
  if (!rows.length) return full('FULL','HISTORY_OUTSIDE_WINDOW');
  const present = new Set(rows.map(r=>r.d));
  const missing = expected.filter(d=>!present.has(d));
  const overlapStart = Math.max(0, expected.indexOf(rows.at(-1).d)-overlap+1);
  const firstMissing = missing.length ? expected.indexOf(missing[0]) : expected.length;
  const start = Math.min(overlapStart, firstMissing);
  const hasGap = state === 'REACTIVATING' || missing.length > 1 || missing.some(d => d < rows.at(-1).d);
  return {
    mode: hasGap ? 'GAP' : 'DELTA',
    reason: missing.length ? 'MISSING_SESSIONS' : 'OVERLAP_CHECK',
    requested: expected.slice(start),
    expected,
    baselineHash
  };
}
export function mergePriceUpdate({target, plan, existing, fetched}) {
  identity(target); identity(fetched);
  if (!sameIdentity(target,fetched)||target.basis!==fetched.basis) fail('FETCH_IDENTITY_OR_BASIS_MISMATCH');
  if (!plan || !MODES.has(plan.mode)) fail('INVALID_PLAN');
  if (digest(existing ?? null)!==plan.baselineHash) fail('BASELINE_CHANGED_REPLAN');
  const expected=sessionsOf(plan.expected);
  if (!Array.isArray(plan.requested)||!plan.requested.length||plan.requested.some((d,i)=>!expected.includes(d)||(i&&d<=plan.requested[i-1]))) fail('INVALID_REQUEST');
  const incoming=validateRows(fetched.rows,expected);
  const got=new Set(incoming.map(r=>r.d));
  if (plan.requested.some(d=>!got.has(d))) fail('INCOMPLETE_FETCH');
  const map=new Map();
  if (plan.mode==='DELTA'||plan.mode==='GAP') {
    identity(existing);
    if (!sameIdentity(existing,target)||existing.basis!==target.basis) fail('EXISTING_IDENTITY_OR_BASIS_MISMATCH');
    const retained=validateRows(existing.rows.filter(r=>r.d>=expected[0]),expected);
    for (const r of retained) map.set(r.d,r);
  }
  const requested=new Set(plan.requested);
  for (const r of incoming) if (requested.has(r.d)) map.set(r.d,r);
  if (expected.some(d=>!map.has(d))) fail('INCOMPLETE_MERGE');
  return {...target, rows:expected.map(d=>map.get(d))};
}
// A cooperative admission helper: caller owns persistent queue and measured stage timings.
// Never interprets elapsed limits as a guarantee of cancelling synchronous I/O.
export function canStartPriceItem({nowMs,deadlineMs,reserveMs=30000,estimatedMs}) {
  if (![nowMs,deadlineMs,reserveMs,estimatedMs].every(Number.isFinite)||reserveMs<0||estimatedMs<=0) return false;
  return nowMs+reserveMs+estimatedMs<deadlineMs;
}
