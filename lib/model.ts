// Token Radar model v2 ("radar-2-comps"): a comparables-fitted value curve.
//
// The snapshot's own traded-token protocols are the comparables. At runtime the model fits
//   log10(mcap) = a + b * log10(TVL)
// by ordinary least squares over every protocol with a market cap and positive TVL, then adjusts
// each pre-token protocol by its category's median residual (shrunk, clamped), its 7-day growth,
// its age with no token (inverted-U maturity), and its chain breadth. No protocol name is ever
// special-cased: the same fitted curve scores every row, so a future snapshot re-fits itself.
//
// Validation is computed at runtime from the same comps and reported in board.json and on the
// dashboard: leave-one-out refits, a walk-forward split (listed before 2025-01-01 vs on/after),
// and a flat 0.25x TVL baseline scored on the same out-of-sample sets.

export interface SnapshotProtocol {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
}
export interface Snapshot {
  as_of: string; source: string; floor_usd: number;
  protocols: SnapshotProtocol[]; watchlist: string[];
}
export const MODEL_VERSION = 'radar-2-comps';
export const LIVE_ROWS = 24;
export const MAX_AGE_DAYS = 1851; // snapshot max age; the maturity decay floor
export const WALK_FORWARD_CUT = '2025-01-01';
export const FLAT_MULTIPLE = 0.25;

export interface FittedCurve { a: number; b: number; r2: number; n: number; }
export interface ErrorStats { n: number; median_abs_log10_error: number; mape_pct: number; }
export interface Validation {
  loo: ErrorStats; walk_forward: ErrorStats;
  flat_loo: ErrorStats; flat_walk_forward: ErrorStats;
  walk_forward_train_n: number; walk_forward_test_n: number;
  note: string;
}
export interface FarmStep { text: string; cost: string; time: string; }
export interface BoardRow {
  rank: number; slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
  token_status: 'pre-token'; age_days: number | null; implied_value_usd: number;
  model: {
    base_usd: number; curve_a: number; curve_b: number; category_adjustment_dex: number;
    growth_pct: number; growth_multiplier: number; maturity_multiplier: number;
    breadth_multiplier: number; age_days: number | null;
  };
  farm_steps: string[];
}
export interface RadarRow {
  rank: number; slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; listed_at: string | null; age_days: number | null;
  implied_value_usd: number; base_usd: number; curve_a: number; curve_b: number;
  category_adjustment_dex: number; growth_pct: number; growth_multiplier: number;
  maturity_multiplier: number; breadth_multiplier: number; gas_cost_usd: number;
  farm_steps: string[];
}
export interface LiveRow {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; mcap_usd: number | null; change_7d: number | null;
}
export interface RadarData {
  as_of: string; source: string; floor_usd: number; model_version: string;
  watchlist_size: number; board_size: number; early_size: number; live_size: number;
  fitted: FittedCurve; validation: Validation; category_adjustments: Record<string, number>;
  scatter: { t: number; m: number }[]; watchlist_slugs: string[];
  rows: RadarRow[]; live: LiveRow[];
}
export class SnapshotError extends Error {
  constructor(m: string) { super(m); this.name = 'SnapshotError'; }
}

const DAY_MS = 86_400_000;
const r4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const r2d = (n: number): number => Math.round(n * 100) / 100;
function finite(v: unknown, fb: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fb;
}
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`), b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** OLS fit of log10(mcap) on log10(TVL) over the given comps. */
export function fitCurve(comps: SnapshotProtocol[]): FittedCurve {
  const pts = comps.filter((p) => (p.mcap_usd ?? 0) > 0 && p.tvl_usd > 0)
    .map((p) => ({ x: Math.log10(p.tvl_usd), y: Math.log10(p.mcap_usd!) }));
  const n = pts.length;
  if (n < 10) return { a: 0, b: 1, r2: 0, n };
  const mx = mean(pts.map((p) => p.x)), my = mean(pts.map((p) => p.y));
  let sxx = 0, sxy = 0, sst = 0;
  for (const p of pts) { sxx += (p.x - mx) ** 2; sxy += (p.x - mx) * (p.y - my); sst += (p.y - my) ** 2; }
  const b = sxx === 0 ? 0 : sxy / sxx;
  const a = my - b * mx;
  let sse = 0;
  for (const p of pts) sse += (p.y - (a + b * p.x)) ** 2;
  return { a: r4(a), b: r4(b), r2: r4(sst === 0 ? 0 : 1 - sse / sst), n };
}

function predict(fit: FittedCurve, tvl: number): number {
  return 10 ** (fit.a + fit.b * Math.log10(Math.max(1, tvl)));
}

/** Per-category median residual (log10 actual - predicted), >=5 comps, shrunk n/(n+5), clamped +-0.30 dex. */
export function categoryAdjustments(comps: SnapshotProtocol[], fit: FittedCurve): Record<string, number> {
  const byCat = new Map<string, number[]>();
  for (const p of comps) {
    if ((p.mcap_usd ?? 0) <= 0 || p.tvl_usd <= 0) continue;
    const cat = p.category ?? 'Other';
    const res = Math.log10(p.mcap_usd!) - Math.log10(predict(fit, p.tvl_usd));
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat)!.push(res);
  }
  const out: Record<string, number> = {};
  for (const [cat, res] of [...byCat.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    if (res.length < 5) continue;
    const adj = median(res) * (res.length / (res.length + 5));
    out[cat] = r4(Math.max(-0.3, Math.min(0.3, adj)));
  }
  return out;
}

function errorStats(actual: number[], predicted: number[]): ErrorStats {
  const logErr: number[] = [], pctErr: number[] = [];
  for (let i = 0; i < actual.length; i++) {
    if (actual[i]! <= 0 || predicted[i]! <= 0) continue;
    logErr.push(Math.abs(Math.log10(actual[i]!) - Math.log10(predicted[i]!)));
    pctErr.push(Math.abs(actual[i]! - predicted[i]!) / actual[i]! * 100);
  }
  return { n: logErr.length, median_abs_log10_error: r4(median(logErr)), mape_pct: r2d(mean(pctErr)) };
}

function flatStats(comps: SnapshotProtocol[]): ErrorStats {
  return errorStats(comps.map((p) => p.mcap_usd!), comps.map((p) => p.tvl_usd * FLAT_MULTIPLE));
}

/** LOO (refit without each comp), walk-forward (pre-2025 fit, post-2025 test), flat baseline on both. */
export function validate(comps: SnapshotProtocol[]): Validation {
  const usable = comps.filter((p) => (p.mcap_usd ?? 0) > 0 && p.tvl_usd > 0);
  const looActual: number[] = [], looPred: number[] = [];
  for (let i = 0; i < usable.length; i++) {
    const rest = usable.filter((_, j) => j !== i);
    const fit = fitCurve(rest);
    looActual.push(usable[i]!.mcap_usd!);
    looPred.push(predict(fit, usable[i]!.tvl_usd));
  }
  const loo = errorStats(looActual, looPred);
  const train = usable.filter((p) => p.listed_at !== null && p.listed_at < WALK_FORWARD_CUT);
  const test = usable.filter((p) => p.listed_at !== null && p.listed_at >= WALK_FORWARD_CUT);
  let wf: ErrorStats = { n: 0, median_abs_log10_error: 0, mape_pct: 0 };
  let flatWf: ErrorStats = { n: 0, median_abs_log10_error: 0, mape_pct: 0 };
  let note = '';
  if (train.length >= 10 && test.length >= 5) {
    const fit = fitCurve(train);
    wf = errorStats(test.map((p) => p.mcap_usd!), test.map((p) => predict(fit, p.tvl_usd)));
    flatWf = errorStats(test.map((p) => p.mcap_usd!), test.map((p) => p.tvl_usd * FLAT_MULTIPLE));
  } else {
    note = `Walk-forward split too small (train ${train.length}, test ${test.length}); walk-forward stats are not reported.`;
  }
  return {
    loo, walk_forward: wf, flat_loo: flatStats(usable), flat_walk_forward: flatWf,
    walk_forward_train_n: train.length, walk_forward_test_n: test.length, note,
  };
}

/** Growth multiplier: upside at 0.6x the rate, downside penalised at 0.9x. */
export function growthMultiplier(change7d: number | null): { pct: number; mult: number } {
  const pct = Math.min(120, Math.max(-60, finite(change7d, 0)));
  const mult = pct >= 0 ? 1 + 0.6 * (pct / 100) : 1 + 0.9 * (pct / 100);
  return { pct: r2d(pct), mult: r4(mult) };
}

/** Inverted-U maturity: ramp 0.70->1.00 over 0-180d, plateau to 1095d, decay to 0.70 at 1851d. */
export function maturityMultiplier(age: number | null): number {
  const d = age ?? 365;
  if (d <= 0) return 0.7;
  if (d < 180) return r4(0.7 + 0.3 * (d / 180));
  if (d <= 1095) return 1;
  return r4(Math.max(0.7, 1 - 0.3 * ((d - 1095) / (MAX_AGE_DAYS - 1095))));
}

export function breadthMultiplier(chains: string[]): number {
  return r4(1 + 0.03 * Math.min(chains.length, 5) - 0.03);
}

export interface Scored {
  implied: number; base: number; catAdj: number; growthPct: number; growthMult: number;
  maturityMult: number; breadthMult: number; age: number | null;
}

export function scoreProtocol(p: SnapshotProtocol, asOf: string, fit: FittedCurve, catAdj: Record<string, number>): Scored {
  const base = predict(fit, p.tvl_usd);
  const adj = catAdj[p.category ?? 'Other'] ?? 0;
  const { pct, mult } = growthMultiplier(p.change_7d);
  const age = ageDays(asOf, p.listed_at);
  const mat = maturityMultiplier(age);
  const br = breadthMultiplier(p.chains);
  let implied = base * 10 ** adj * mult * mat * br;
  implied = Math.min(implied, 20 * p.tvl_usd, 1e14);
  implied = Math.max(1, Math.round(implied));
  return { implied, base: Math.round(base), catAdj: adj, growthPct: pct, growthMult: mult, maturityMult: mat, breadthMult: br, age };
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** The watchlist rule, applied to the whole board: a wrapped, staked or bridged product of a
 *  token that already trades is not a protocol still waiting on a launch of its own (the
 *  snapshot's own field guide: WBTC is Bitcoin on Ethereum, staked ETH is ETH in a staking
 *  product). Categories are DefiLlama's; the name rules mirror the watchlist definition. */
const LAUNCH_EXCLUDED_CATEGORIES = new Set([
  'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX',
]);
const WRAPPED_OR_STAKED = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
export function isLaunchExcluded(p: SnapshotProtocol): boolean {
  if (p.category !== null && LAUNCH_EXCLUDED_CATEGORIES.has(p.category)) return true;
  if (WRAPPED_OR_STAKED.test(p.name)) return true;
  return EXCHANGE_PREFIXES.some((e) => p.name.startsWith(e));
}
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && !isLaunchExcluded(p) && !VERSIONED.test(p.name);
}

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral') || c.includes('uncollateralized')) return `Supply $${capital} of USDC to ${n} on ${chain} and keep the position open; borrow a small amount once to register as a borrower.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm') || c.includes('farm') || c.includes('liquidity manager')) return `Provide $${capital} of liquidity to ${n}'s main pool on ${chain} and keep the position open through at least one fee cycle.`;
  if (c.includes('bridge') || c.includes('cross chain')) return `Bridge $${capital} of USDC to ${chain} through ${n} and use the bridged funds in its app, not just hold them.`;
  if (c.includes('stak') || c.includes('restak') || c.includes('anchor btc') || c.includes('decentralized btc')) return `Stake $${capital} of the chain's staking asset through ${n} and keep the receipt token in the same wallet.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options') || c.includes('synthetic')) return `Deposit $${capital} of USDC as margin on ${n} and open one small hedged position, then close it in profit or at a small loss.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${n}, then settle or exit it before expiry.`;
  if (c.includes('allocator') || c.includes('curator') || c.includes('risk curators') || c.includes('indexes')) return `Deposit $${capital} into a ${n} vault on ${chain} and keep the shares for the full hold period.`;
  if (c.includes('stable') || c.includes('algo-stable') || c.includes('dual-token')) return `Mint or deposit $${capital} of the stable asset through ${n} on ${chain} and hold it in the farming wallet.`;
  if (c.includes('rwa') || c.includes('reserve currency')) return `Mint $${capital} of the protocol's yield-bearing asset on ${chain} and hold it for the full hold period.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${n} on ${chain} and keep the policy active for the hold period.`;
  if (c.includes('launchpad')) return `Stake or deposit $${capital} through ${n} on ${chain} and join one launch allocation if one opens.`;
  if (c.includes('nft')) return `List or buy one low-priced item through ${n} on ${chain} for about $${capital} and keep the receipt.`;
  if (c.includes('payment') || c.includes('card')) return `Spend about $${capital} through ${n} on ${chain} and keep the transaction receipt in the farming wallet.`;
  if (c.includes('privacy')) return `Run one private transaction of about $${capital} through ${n} on ${chain} and keep the receipt.`;
  if (c.includes('ai agent') || c.includes('decentralized ai')) return `Use $${capital} of the agent service on ${n} on ${chain} and keep the session receipt in the farming wallet.`;
  if (c.includes('chain')) return `Bridge $${capital} to ${n}'s chain and use one of its native apps, keeping the funds in the farming wallet.`;
  if (c.includes('basis trading') || c.includes('cede')) return `Deposit $${capital} into ${n} on ${chain} and keep the position open for the full hold period.`;
  if (c.includes('governance') || c.includes('dor') || c.includes('token locker') || c.includes('otc')) return `Deposit $${capital} through ${n} on ${chain} and vote or lock once so the wallet registers activity.`;
  return `Deposit $${capital} of USDC into ${n} on ${chain} and keep the position open.`;
}
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** Total gas for a farm plan, from the same figures farmSteps uses (kept in one place). */
export function farmGas(p: SnapshotProtocol, age: number | null): number {
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const weeks = Math.max(1, Math.round(hold / 7));
  return 3 + (capital >= 150 ? 8 : 4) + 2 * weeks + 4;
}

/** Eight concrete, costed farm steps derived from the protocol's own record. Returns steps + total gas. */
export function farmSteps(p: SnapshotProtocol, age: number | null, implied: number): { steps: FarmStep[]; gasTotal: number } {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const weeks = Math.max(1, Math.round(hold / 7));
  const s2gas = capital >= 150 ? 8 : 4;
  const gasTotal = farmGas(p, age);
  const second = p.chains.length >= 2
    ? `Open a second position of $25 on ${p.chains[1]} through ${p.name}, the protocol's second chain, so activity spans two chains.`
    : `Deepen the first position by $25 on ${chain} so the wallet shows a second, later deposit.`;
  const steps: FarmStep[] = [
    { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
    { text: actionFor(p, capital, chain), cost: `$${capital} of capital and about $${s2gas} of gas`, time: '15 minutes to set up' },
    { text: `Make one qualifying action each week for ${weeks} weeks, such as a deposit, a borrow, a swap or a vote on ${p.name}.`, cost: 'about $2 of gas a week', time: '10 minutes a week' },
    { text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`, cost: `the $${capital} stays in the position`, time: `${hold} days` },
    { text: second, cost: '$25 of capital and about $4 of gas', time: '10 minutes' },
    { text: `Open ${p.name}'s own points or rewards page and check your standing; claim only from the link it publishes.`, cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
    { text: `Farm cost is about $${gasTotal} gas (+ $${capital + 25} capital, returned on unwind). The plan pays for its gas if your eventual allocation is worth more than $${gasTotal}; the model's implied value for ${p.name} is $${implied.toLocaleString('en-US')}.`, cost: `$${gasTotal} of gas in total`, time: '5 minutes to add up' },
    { text: 'Write the wallet, the dates and every transaction hash in a farm log, then unwind in two tranches and keep a dust position until the snapshot after the claim.', cost: 'nothing but the log', time: '5 minutes' },
  ];
  return { steps, gasTotal };
}

export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d }));
}

export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const comps = snapshot.protocols.filter((p) => (p.mcap_usd ?? 0) > 0 && p.tvl_usd > 0);
  const fit = fitCurve(comps);
  const catAdj = categoryAdjustments(comps, fit);
  const scored = snapshot.protocols.filter(isRankable).map((p) => {
    const s = scoreProtocol(p, snapshot.as_of, fit, catAdj);
    return { p, s };
  });
  scored.sort((a, b) => b.s.implied - a.s.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  // Enforce strictly decreasing implied values by rank.
  let prev = Infinity;
  return scored.map((x, i) => {
    let implied = x.s.implied;
    if (implied >= prev) implied = Math.max(1, prev - 1);
    prev = implied;
    const { steps } = farmSteps(x.p, x.s.age, implied);
    return {
      rank: i + 1, slug: x.p.slug, name: x.p.name, category: x.p.category, chains: x.p.chains,
      tvl_usd: x.p.tvl_usd, change_7d: x.p.change_7d, mcap_usd: x.p.mcap_usd,
      listed_at: x.p.listed_at, gecko_id: x.p.gecko_id, symbol: x.p.symbol,
      token_status: 'pre-token', age_days: x.s.age, implied_value_usd: implied,
      model: {
        base_usd: x.s.base, curve_a: fit.a, curve_b: fit.b, category_adjustment_dex: x.s.catAdj,
        growth_pct: x.s.growthPct, growth_multiplier: x.s.growthMult,
        maturity_multiplier: x.s.maturityMult, breadth_multiplier: x.s.breadthMult, age_days: x.s.age,
      },
      farm_steps: steps.map(stepText),
    };
  });
}

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const comps = snapshot.protocols.filter((p) => (p.mcap_usd ?? 0) > 0 && p.tvl_usd > 0);
  const fit = fitCurve(comps);
  const catAdj = categoryAdjustments(comps, fit);
  const validation = validate(comps);
  const board = buildBoard(snapshot);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const rows: RadarRow[] = board.map((r) => {
    const proto: SnapshotProtocol = { slug: r.slug, name: r.name, category: r.category, chains: r.chains, tvl_usd: r.tvl_usd, change_7d: r.change_7d, mcap_usd: null, listed_at: r.listed_at, gecko_id: null, symbol: null };
    const gasTotal = farmGas(proto, r.age_days);
    return {
      rank: r.rank, slug: r.slug, name: r.name, category: r.category, chains: r.chains,
      tvl_usd: r.tvl_usd, change_7d: r.change_7d, listed_at: r.listed_at, age_days: r.age_days,
      implied_value_usd: r.implied_value_usd, base_usd: r.model.base_usd, curve_a: r.model.curve_a,
      curve_b: r.model.curve_b, category_adjustment_dex: r.model.category_adjustment_dex,
      growth_pct: r.model.growth_pct, growth_multiplier: r.model.growth_multiplier,
      maturity_multiplier: r.model.maturity_multiplier, breadth_multiplier: r.model.breadth_multiplier,
      gas_cost_usd: gasTotal, farm_steps: r.farm_steps,
    };
  });
  const radar: RadarData = {
    as_of: snapshot.as_of, source: snapshot.source, floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION, watchlist_size: snapshot.watchlist.length,
    board_size: board.length, early_size: early, live_size: live.length,
    fitted: fit, validation, category_adjustments: catAdj,
    scatter: comps.map((p) => ({ t: p.tvl_usd, m: p.mcap_usd! })),
    watchlist_slugs: snapshot.watchlist.slice().sort(), rows, live,
  };
  return { board, radar };
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new SnapshotError('snapshot.json is not JSON'); }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    return {
      slug: p.slug, name: p.name, category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return `all ${board.length} rows share the same implied value`;
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
