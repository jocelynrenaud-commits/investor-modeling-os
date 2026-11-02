// Markets statistics + the simulator's correlation hook.  node tests/markets.test.mjs [old-runway.js]
import fs from 'fs'; import vm from 'vm'; import path from 'path'; import { fileURLToPath } from 'url';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
function load(runwayFile) {
  const ctx = { console, Math, Date }; ctx.globalThis = ctx; ctx.window = ctx; vm.createContext(ctx);
  for (const f of ['engine.js', 'history.js']) vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8') + (f === 'engine.js' ? ';globalThis.Engine=Engine;' : ''), ctx);
  vm.runInContext(fs.readFileSync(runwayFile, 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(dir, 'markets.js'), 'utf8'), ctx);
  return ctx;
}
let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL', m); } };
const near = (a, b, t) => Math.abs(a - b) <= t;

const C = load(path.join(dir, 'runway.js')); const M = C.Markets;
const d = M.load({});
const ps = M.portfolioStats(d.holdings);
ok(near(ps.rows.reduce((a, h) => a + h.risk, 0), 1, 1e-9), 'risk contributions sum to 1');
ok(ps.sd > 0.10 && ps.sd < 0.25, 'portfolio volatility plausible: ' + ps.sd);
ok(near(M.holdingStats({ cls: 'usEquity' }).beta, 1, 1e-9), 'US stocks beta is 1');
ok(near(M.portfolioStats([{ cls: 'usEquity', value: 1 }]).sd, 0.16, 1e-9), 'one-holding portfolio keeps its volatility');
ok(M.classify('GLD') === 'gold' && M.classify('NVDA') === 'stock' && M.classify('XYZ', 'Long-term Treasury') === 'treasLong', 'classify');
ok(M.acctType('Rollover IRA') === 'preTax' && M.acctType('Roth IRA') === 'roth' && M.acctType('Brokerage') === 'taxable', 'account tax type');
ok(M.acctType('IRA') === 'preTax' && M.acctType('Self-Directed IRA') === 'preTax', 'IRA and Self-Directed IRA are pre-tax');
ok(JSON.stringify([...new Set(d.holdings.map((h) => h.account))]) === JSON.stringify(['IRA', 'Roth IRA', 'Brokerage']), 'sample public accounts');
// Private deals: two accounts, by tax treatment. A blank account is the Self-Directed IRA.
ok(M.privateAccount('') === 'Self-Directed IRA' && M.privateAccount('SDIRA') === 'Self-Directed IRA' && M.privateAccount('Checkbook LLC IRA') === 'Self-Directed IRA', 'private deals in an IRA');
ok(M.privateAccount('Private Deals') === 'Private Deals' && M.privateAccount('Taxable') === 'Private Deals' && M.privateAccount('Joint') === 'Private Deals', 'private deals held personally');
const ph = M.privateHoldings([{ name: 'A', funded: 10, account: '' }, { name: 'B', funded: 5, account: 'Private Deals' }, { name: 'C', funded: 0 }]);
ok(ph.length === 2 && ph[0].acctType === 'preTax' && ph[1].acctType === 'taxable' && ph[1].account === 'Private Deals', 'private holdings carry their tax bucket');
const book = JSON.parse(fs.readFileSync(path.join(dir, 'example-book.json'), 'utf8'));
ok(book.every((r) => r.account === 'Self-Directed IRA' || r.account === 'Private Deals') && book.some((r) => r.account === 'Private Deals'), 'example book uses both private accounts');
const sv = M.toSleeves(d.holdings);
ok(near(sv.sleeves.reduce((a, s) => a + s.balance, 0), ps.value, 1e-6), 'sleeves add up to the holdings');
sv.sleeves.forEach((a) => sv.sleeves.forEach((b) => {
  ok(near(sv.corr[a.id][b.id], sv.corr[b.id][a.id], 1e-12), 'corr symmetric');
  ok(sv.corr[a.id][b.id] <= 1 + 1e-9 && sv.corr[a.id][b.id] >= -1 - 1e-9, 'corr in range');
}));
const c = M.cone({ start: 1e6, mu: 0.07, sd: 0.16, months: 24 });
ok(c.every((p) => p.p5 <= p.p25 && p.p25 <= p.p50 && p.p50 <= p.p75 && p.p75 <= p.p95), 'cone percentiles ordered');
ok(near(c[12].p50 / 1e6 - 1, Math.exp(M.logParams(0.07, 0.16).m) - 1, 0.02), 'cone median after a year matches the lognormal median');

// The private cone replays the Liquidity Outlook's futures. Run to the last year anything can
// pay, every position has exited, so each future's value is its total cash: the end of the cone
// must equal simulate()'s own totals, percentile for percentile.
{
  const E = C.Engine;
  const book = E.buildBook(JSON.parse(fs.readFileSync(path.join(dir, 'example-book.json'), 'utf8')));
  const sim = E.simulate(book);
  const Y0 = E.calendarNow().year, last = sim.years[sim.years.length - 1];
  const pc = M.privateCone(book, { paths: E.CFG.paths, months: (last - Y0 + 1) * 12, t0: new Date((Y0 - 1) + '-12-31T12:00:00').getTime() });
  const end = pc.cone[pc.cone.length - 1];
  const qq = (pp) => end.sorted[Math.floor(pp * (end.sorted.length - 1))];
  ok(near(qq(0.5), sim.totals.p50, 0.01) && near(qq(0.1), sim.totals.p10, 0.01) && near(qq(0.9), sim.totals.p90, 0.01),
    'private cone ends on the Liquidity Outlook totals: ' + Math.round(qq(0.5)) + ' vs ' + Math.round(sim.totals.p50));
  ok(near(pc.start, book.filter((b) => b.fy < Y0).reduce((a, b) => a + b.funded, 0), 1e-6), 'cone starts at cost');
  ok(pc.cone.every((p) => p.p5 <= p.p50 && p.p50 <= p.p95), 'private cone ordered');
}

// Without a correlation matrix the simulator must give exactly what it gave before.
const cfg = { birthYear: 1972, stopYear: 2035, planToAge: 92, spend: 200000, floorSpend: 160000, benefitAge: 67, benefitAnnual: 42000, paths: 400, thisYear: 2026,
  sleeves: [{ id: 'growth', kind: 'growth', balance: 1100000 }, { id: 'income', kind: 'income', balance: 350000 }, { id: 'cash', kind: 'cash', balance: 150000 }] };
const oldFile = process.argv[2];
if (oldFile) {
  const O = load(oldFile);
  const a = C.Runway.simulate(cfg), b = O.Runway.simulate(cfg);
  ok(a && b && a.neverShort === b.neverShort && a.terminal.p50 === b.terminal.p50, 'no-corr run identical to the previous simulator');
}
const withCorr = C.Runway.simulate(Object.assign({}, cfg, { sleeves: sv.sleeves, corr: sv.corr }));
ok(withCorr && withCorr.neverShort >= 0 && withCorr.neverShort <= 1, 'correlated run completes');
// 2026-10-31 (audit M-03 / QA H4, M-29a, QA M9, H9): percent cells, a stated beta, dates, negatives.
[['1%', 0.01], ['1.2%', 0.012], [1.2, 0.012], [0.012, 0.012], ['150%', 1.5], ['8', 0.08]].forEach(([v, want]) =>
  ok(near(M.pctIn(v), want, 1e-12), 'pctIn(' + JSON.stringify(v) + ') = ' + M.pctIn(v)));
ok(near(M.holdingStats({ cls: 'stock', beta: 1.7 }).beta, 1.7, 1e-9), 'a stated beta of 1.7 comes back as 1.7');
ok(M.toDate('01/01/2027') === '2027-01-01' && M.toDate('2027-01-01') === '2027-01-01', 'text dates stay on their calendar day');
{ const n = []; const t = M.holdingsFromSheets({ H: [['Symbol', 'Market value'], ['MARGIN', -50000], ['VOO', 1000]] }, n);
  ok(t.rows.length === 1 && n.length === 1, 'a negative holding is left out with a note'); }
console.log('markets: ' + checks + ' checks, ' + fails + ' failures');
process.exit(fails ? 1 : 0);
