// What the plan reads and includes: percent cells, dates, which household, dated cash, the
// deal tester's rules and the reset hook. Pure functions in a bare vm context, no DOM.
//   node tests/plan.test.mjs
import fs from 'fs'; import vm from 'vm'; import path from 'path'; import { fileURLToPath } from 'url';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = { console, Math, Date }; ctx.globalThis = ctx; ctx.window = ctx; vm.createContext(ctx);
for (const f of ['engine.js', 'history.js', 'markets.js', 'runway.js', 'portfolio.js', 'includes.js']) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8') + (f === 'engine.js' ? ';globalThis.Engine=Engine;' : ''), ctx);
}
const { Markets: M, Portfolio: P, PlanIncludes: PI, AppState: AS, Engine: E } = ctx;
let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL', m); } };
const near = (a, b, t) => Math.abs(a - b) <= (t || 1e-12);

/* M-03 / QA H4: one percent rule, the same in markets.js and portfolio.js. */
const CASES = [['1%', 0.01], ['1.2%', 0.012], ['0.5%', 0.005], ['150%', 1.5], [' 7 % ', 0.07], [1.2, 0.012], ['1.2', 0.012],
  [0.012, 0.012], [8, 0.08], ['8', 0.08], [1, 0.01], [0.07, 0.07], [-0.05, -0.05], ['-5%', -0.05], [-5, -0.05]];
CASES.forEach(([v, want]) => {
  ok(near(M.pctIn(v), want), 'Markets.pctIn(' + JSON.stringify(v) + ') = ' + M.pctIn(v) + ', want ' + want);
  ok(near(P.pctOf(v), want), 'Portfolio.pctOf(' + JSON.stringify(v) + ') = ' + P.pctOf(v) + ', want ' + want);
});
ok(M.pctIn('') === null && M.pctIn(null) === null && M.pctIn('n/a') === null, 'a blank or unreadable percent is null');
['1%', '8%', '0.5%'].forEach((v) => ok(near(M.pctIn(v), E.num(v)), 'text with % agrees with Engine.num: ' + v));
const you = P.parseYou({ You: [['Inflation until stop', '1%'], ['Inflation after', '1.5%'], ['Birth year', 1980]] });
ok(near(you.inflPre, 0.01) && near(you.inflPost, 0.015), 'You tab: "1%" inflation is 1%, not 100%');
const bal = P.parseBalances({ B: [['Account', 'Sleeve', 'Value', 'Yield', 'Expected return', 'Vol'], ['IRA', 'Income', 100000, '1%', '0.5%', 12]] });
ok(near(bal.rows[0].yield, 0.01) && near(bal.rows[0].ret, 0.005) && near(bal.rows[0].vol, 0.12), 'Balances tab percents');
const hold = M.holdingsFromSheets({ H: [['Symbol', 'Account', 'Market value', 'Yield', 'Expected return', 'Volatility'], ['BND', 'Brokerage', 100000, '1%', 1.2, 1.4]] });
ok(near(hold.rows[0].y, 0.01) && near(hold.rows[0].mu, 0.012) && near(hold.rows[0].sd, 0.014), 'QA H4 Holdings: "1%", 1.2, 1.4 read as 1%, 1.2%, 1.4%');
const loud = []; M.holdingsFromSheets({ H: [['Symbol', 'Market value', 'Expected return'], ['X', 1000, '70%']] }, loud);
ok(loud.length === 1 && /read as 70\.0%/.test(loud[0]), 'an implausible percent is said out loud');

/* Dates without a time-zone shift (QA M9). */
[['01/01/2027', '2027-01-01'], ['12/31/2026', '2026-12-31'], ['2027-01-01', '2027-01-01'], ['Jan 1, 2027', '2027-01-01'], ['1 Jan 2027', '2027-01-01'],
  [46388, '2027-01-01'], ['1/1/27', '2027-01-01'], ['2027-02-30', null], ['soon', null]].forEach(([v, want]) => ok(M.toDate(v) === want, 'toDate(' + v + ') = ' + M.toDate(v)));

/* Which household (QA H3, M13, H9). */
const BAL = { Balances: [['Account', 'Account type', 'Sleeve', 'Label', 'Value', 'As of'], ['Fidelity 401k', '401k', 'Growth', 'Index', 800000, '2026-09-30'], ['Schwab', 'Taxable', 'Cash', 'MMF', 50000, '2026-09-30']] };
let L = M.load(BAL);
ok(L.source === 'balances' && !L.isDemo && L.holdings.length === 2 && L.holdings.reduce((a, h) => a + h.value, 0) === 850000, 'a Balances tab is the household');
ok(L.holdings[0].acctType === 'preTax' && L.holdings[1].cls === 'cash' && L.holdings[0].cls === 'usEquity', 'Balances rows keep their tax bucket and sleeve');
ok(L.history.length === 0, 'a Balances tab is not read as balance history');
ok(M.historyFromSheets(BAL) === null, 'historyFromSheets refuses a Balances layout');
const HIST = { History: [['Date', 'Account', 'Balance'], ['2025-12-31', 'IRA', 1000], ['2026-06-30', 'IRA', 1100]] };
ok(M.historyFromSheets(Object.assign({}, BAL, HIST)).length === 2, 'a real History tab is still read beside Balances');
const HOLD = { Holdings: [['Symbol', 'Account', 'Market value'], ['VOO', 'Roth IRA', 5000]] };
L = M.load(Object.assign({}, BAL, HOLD));
ok(L.source === 'balances' && L.notes.some((n) => /were not used/.test(n)), 'Balances wins over Holdings, and says so');
ok(P.parseBalances(HOLD) === null, 'portfolio.js does not read a Holdings tab as Balances');
L = M.load(HOLD); ok(L.source === 'holdings' && L.holdings.length === 1, 'a Holdings tab without Balances');
L = M.load({ Holdings: [['Symbol', 'Account', 'Market value'], ['', '', '']] });
ok(L.source === 'holdings' && L.holdings.length === 0 && !L.isDemo, 'QA M13 an empty Holdings tab means no public holdings');
L = M.load({ Holdings: [['Symbol', 'Account', 'Market value'], ['MARGIN', 'Brokerage', -50000], ['BND', 'Brokerage', 100000]] });
ok(L.holdings.length === 1 && L.notes.some((n) => /negative value \(-\$50,000\)/.test(n)), 'QA H9 negative rows are left out with a note');
ok(M.portfolioStats([{ cls: 'cash', value: -5 }]) === null, 'portfolioStats of nothing positive is null (callers guard)');
L = M.load({}); ok(L.source === 'sample' && L.isDemo && L.history.length > 0, 'no tabs: the sample household');
L = M.load({ Holdings: HOLD.Holdings, History: [['Date', 'Balance'], ['2025-12-31', 4000], ['2026-06-30', 5000]] });
ok(L.history.every((r) => r.account === 'Roth IRA'), 'QA L10 a history without accounts belongs to the only public account');

/* M-29a: a stated beta comes back as stated. */
[0.5, 1, 1.7, 2.2].forEach((b) => ok(near(M.holdingStats({ cls: 'stock', beta: b }).beta, b, 1e-9), 'beta ' + b + ' round-trips'));

/* M-14: a cashflow that inflates grows; one that does not stays flat. */
const flows = { CF: [['Label', 'Starts', 'Ends', 'Amount', 'Inflates'], ['Pension', 2036, 2040, 30000, 'yes'], ['Annuity', 2036, 2040, 10000, 'no']] };
const dated = P.datedFlows(P.build(flows, []), null, { thisYear: 2026, inflPre: 0.03, inflPost: 0.02, stopYear: 2038 });
const pen = (y) => dated[y].items.find((i) => i.label === 'Pension').amount;
ok(pen(2036) === Math.round(30000 * Math.pow(1.03, 10)), 'pension grows at the pre-stop rate to 2036: ' + pen(2036));
ok(pen(2040) === Math.round(30000 * Math.pow(1.03, 12) * Math.pow(1.02, 2)), 'and at the post-stop rate after 2038: ' + pen(2040));
ok(dated[2040].items.find((i) => i.label === 'Annuity').amount === 10000, 'a flow marked no does not inflate');

/* The deal tester's rules (QA H8, M4, C2), with the year read from the clock. */
const y0 = E.calendarNow().year;
const good = { commitment: 50000, paid: 50000, year: y0 };
ok(PI.validateDeal(good).ok, 'a sound deal passes');
ok(PI.validateDeal(Object.assign({}, good, { year: y0 - 1 })).errors.year, 'QA H8 last year is refused');
ok(PI.validateDeal(Object.assign({}, good, { year: y0 + 11 })).errors.year, 'more than ten years out is refused');
ok(PI.validateDeal(Object.assign({}, good, { commitment: -1 })).errors.commitment && PI.validateDeal(Object.assign({}, good, { commitment: 0 })).errors.commitment, 'QA M4 a zero or negative commitment is refused');
ok(PI.validateDeal(Object.assign({}, good, { paid: 60000 })).errors.paid && PI.validateDeal(Object.assign({}, good, { paid: -1 })).errors.paid, 'paid in outside 0..commitment is refused');
ok(PI.validateDeal(good, 40000).errors.commitment && PI.validateDeal(good, 60000).ok, 'QA C2 a commitment above the public investments is refused');
const fakeBook = [{ name: 'X', commitment: 50000 }];
ok(PI.consider(Object.assign({ name: 'Past', book: fakeBook }, good, { year: 2020 })) === false && PI.considered === null, 'consider() refuses a past-year deal and leaves the plan alone');
ok(PI.consider(Object.assign({ name: 'Now', book: fakeBook }, good)) === true && PI.considered.name === 'Now', 'consider() adds a sound deal');

/* The reset hook (QA H2, M1). */
const seen = [];
const off = AS.onReset((r) => seen.push(r));
ctx.APP_RESET_HOOKS = [() => seen.push('early')];
const b1 = [{ name: 'a' }], b2 = [{ name: 'b' }];
PI.remember({ book: b1 }); PI.S.calls = false;
ok(PI.considered !== null && seen.length === 0, 'the first book seen resets nothing');
PI.remember({ book: b1 });
ok(seen.length === 0, 'the same book again resets nothing');
PI.remember({ book: b2 });
ok(seen.join(',') === 'new book,early', 'a new book runs every hook once, including APP_RESET_HOOKS: ' + seen.join(','));
ok(PI.considered === null && PI.S.calls === true && PI.ctx.book === b2, 'PlanIncludes is back to defaults and remembers the new book');
AS.reset('user'); ok(seen.length === 4, 'AppState.reset() can be called directly');
off(); AS.reset('user'); ok(seen.length === 5 && seen[4] === 'early', 'onReset returns an unregister function');
ctx.APP_RESET_HOOKS = [() => { throw new Error('boom'); }, () => seen.push('after')];
AS.reset('x'); ok(seen[seen.length - 1] === 'after', 'one failing hook does not stop the others');

console.log('plan: ' + checks + ' checks, ' + fails + ' failures');
process.exit(fails ? 1 : 0);
