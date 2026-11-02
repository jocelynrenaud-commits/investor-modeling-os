// Retirement Simulator hardening: one regression check per audit finding.  node tests/runway.test.mjs
//
// Model checks load engine.js, history.js, markets.js, runway.js and runway-ui.js into a bare
// vm context, the pattern tests/taxes.test.mjs uses. Most use a deterministic sleeve (zero
// volatility, so a lognormal draw returns exactly mu) so a dollar figure can be checked to the
// cent. DOM checks boot the whole app in jsdom through tests/harness.mjs and are reported as
// skipped when jsdom cannot be found (set JSDOM_DIR to a node_modules folder that has it).
// IDs in the messages are the audit's: M-nn (math audit), C/H/M/L (QA), UX-nn (UX review).
import fs from 'fs'; import vm from 'vm'; import path from 'path'; import { fileURLToPath } from 'url';
import { boot, demo, tab } from './harness.mjs';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function load() {
  const ctx = { console, Math, Date }; ctx.globalThis = ctx; ctx.window = ctx; vm.createContext(ctx);
  for (const f of ['engine.js', 'history.js', 'markets.js', 'runway.js', 'runway-ui.js']) {
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8') + (f === 'engine.js' ? ';globalThis.Engine=Engine;' : ''), ctx, { filename: f });
  }
  return ctx;
}
const X = load(), R = X.Runway, UI = X.RunwayUI, Hist = X.History;
let fails = 0, checks = 0, skipped = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL', m); } };
const near = (a, b, t) => Math.abs(a - b) <= t;
const Y = 2026;

/* A plan with one deterministic sleeve: cash, no volatility, no yield, so each year's return
   is exactly mu. `over` patches the config. */
const flat = (over) => Object.assign({
  thisYear: Y, birthYear: 1970, stopYear: Y + 5, planToAge: 61, spend: 100000, floorSpend: 80000,
  benefitAge: 99, benefitAnnual: 0, mode: 'fixed', paths: 20, inflPre: 0, inflPost: 0,
  sleeves: [{ id: 'cash', label: 'Cash', kind: 'cash', balance: 1000000, mu: 0, sd: 0, yield: 0, taxMix: { preTax: 1, roth: 0, taxable: 0 } }],
}, over || {});
const sim = (over) => R.simulate(flat(over));
const traced = (over) => R.simulate(flat(Object.assign({ trace: true, traceAt: 0 }, over || {})));

/* M-01 / QA C2: money going out before the stop year is paid from every sleeve, grossed up. */
{
  const r = traced({ dated: { [Y]: { net: -100000, items: [] } } });
  ok(near(r.traceRunup[0].balance, 1000000 - 100000 / 0.78, 0.01), 'M-01: a $100k run-up bill costs $100k / (1 - 22%) of a pre-tax sleeve: ' + r.traceRunup[0].balance);
  const two = {
    sleeves: [
      { id: 'cash', label: 'Cash', kind: 'cash', balance: 50000, mu: 0, sd: 0, yield: 0, taxMix: { preTax: 0, roth: 1, taxable: 0 } },
      { id: 'growth', label: 'Growth', kind: 'growth', balance: 950000, mu: 0, sd: 0, yield: 0, taxMix: { preTax: 0, roth: 1, taxable: 0 } },
    ], rebalance: 'none',
  };
  const a = traced(Object.assign({}, two, { dated: { [Y]: { net: -50000, items: [] } } }));
  const b = traced(Object.assign({}, two, { dated: { [Y]: { net: -300000, items: [] } } }));
  ok(near(a.traceRunup[0].balance, 950000, 0.01) && near(b.traceRunup[0].balance, 700000, 0.01),
    'C2: a bill larger than the first sleeve is carried on to the next sleeve in draw order');
  ok(b.terminal.p50 < a.terminal.p50, 'C2: a bigger run-up outflow always costs more');
  const huge = traced({ dated: { [Y]: { net: -5000000, items: [] } } });
  ok(huge.neverShort === 0 && huge.preStop && huge.preStop.share === 1 && huge.traceRunup[0].unmet > 1000000,
    'M-01: what no sleeve can cover is recorded as a shortfall, not dropped');
  // Monotone on a stochastic plan: never short can only fall as the outflow grows.
  const sto = (amt) => R.simulate({ thisYear: Y, birthYear: 1972, stopYear: 2035, planToAge: 92, spend: 150000, floorSpend: 120000, benefitAge: 67, benefitAnnual: 42000, paths: 300,
    sleeves: [{ id: 'growth', kind: 'growth', balance: 2000000 }, { id: 'cash', kind: 'cash', balance: 100000 }], dated: amt ? { [Y + 1]: { net: -amt, items: [] } } : null });
  const seq = [0, 150000, 300000, 600000, 1000000].map((a2) => sto(a2));
  ok(seq.every((r2, i) => i === 0 || (r2.neverShort <= seq[i - 1].neverShort && r2.terminal.p50 <= seq[i - 1].terminal.p50)),
    'C2: never short and ending wealth are non-increasing in the size of a run-up outflow: ' + seq.map((r2) => r2.neverShort.toFixed(3)).join(' '));
}

/* QA H8 / M-13: a dated outflow in a year before this one is charged in the first year;
   a past inflow is assumed to be in the balances already. */
{
  const now = sim({ dated: { [Y]: { net: -100000, items: [] } } });
  const past = sim({ dated: { [Y - 6]: { net: -100000, items: [] } } });
  const none = sim({});
  const pastIn = sim({ dated: { [Y - 6]: { net: 100000, items: [] } } });
  ok(near(past.terminal.p50, now.terminal.p50, 0.01) && past.terminal.p50 < none.terminal.p50, 'H8: a past-dated outflow is charged, as if dated this year');
  ok(near(pastIn.terminal.p50, none.terminal.p50, 0.01), 'H8: a past-dated inflow is not added on top of the balances');
  // Already retired (stop year before this year): the fold lands in the first drawing year.
  const ret = R.simulate(flat({ stopYear: Y - 2, planToAge: Y - 2 - 1970 + 3, dated: { [Y - 10]: { net: -100000, items: [] } }, trace: true }));
  ok(ret && ret.trace[0].bills === 100000, 'H8: with the stop year past, the folded outflow is a bill in the first year simulated');
}

/* M-06: paying a bill is not spending delivered. */
{
  const one = traced({ stopYear: Y, planToAge: Y - 1970, sleeves: [{ id: 'cash', kind: 'cash', balance: 100000, mu: 0, sd: 0, yield: 0 }],
    tax: { on: false }, dated: { [Y]: { net: -50000, items: [] } } });
  ok(near(one.share, 0.5, 1e-9) && one.fullYears === 0 && one.neverShort === 0,
    'M-06: $100k plan, $50k bill, $100k available: half the spending delivered, not "paid in full": ' + one.share);
  ok(one.trace[0].billsPaid === 50000 && near(one.trace[0].spending, 50000, 0.01), 'M-06: bills are paid first, spending gets the rest');
  const calls = {}; for (let y = Y + 6; y < Y + 20; y++) calls[y] = { net: -150000, items: [] };
  const big = R.simulate(flat({ planToAge: 90, sleeves: [{ id: 'g', kind: 'growth', balance: 6000000, mu: 0.05, sd: 0, yield: 0 }], dated: calls }));
  ok(big.share <= 1 + 1e-9, 'M-06: share of target never exceeds 100% with $150k a year of bills: ' + big.share);
}

/* M-04: deal proceeds taxed by bucket, Social Security at 85% of the pre-tax rate. */
{
  const deals = { years: [Y + 5], pathRows: [[100000]] };
  const spendYear = (over) => traced(Object.assign({ dealSim: deals }, over)).trace[0];
  ok(near(spendYear({}).deals, 78000, 0.01) && near(spendYear({}).dealsTax, 22000, 0.01), 'M-04: with no bucket given, deal proceeds are taxed as pre-tax (22%), the conservative default');
  ok(near(spendYear({ dealTax: { preTax: 0, taxable: 1, roth: 0 } }).deals, 85000, 0.01), 'M-04: proceeds landing in a taxable account are taxed at 15%');
  ok(near(spendYear({ dealTax: 0 }).deals, 100000, 0.01), 'M-04: a stated rate of 0 is respected (a Roth deal)');
  ok(near(spendYear({ dealTax: 0.3 }).deals, 70000, 0.01), 'M-04: a per-book effective rate can be passed directly');
  const half = traced({ dealSim: { years: [Y + 5], pathRows: [[300000]] } }).trace[0];
  ok(near(half.dealsGross, 100000 / 0.78, 0.01) && near(half.sweptIn, 300000 - 100000 / 0.78, 0.01),
    'M-04: only the part spent is taxed now; the rest is swept, untaxed, into the first sleeve');
  const ss = traced({ benefitAge: 0, benefitAnnual: 40000 }).trace[0];
  ok(near(ss.benefit, 40000 * (1 - 0.85 * 0.22), 0.01), 'M-04: Social Security reaches spending after tax at 85% x 22%: ' + ss.benefit);
  ok(near(traced({ benefitAge: 0, benefitAnnual: 40000, tax: { on: false } }).trace[0].benefit, 40000, 0.01), 'M-04: with tax off the benefit is spent in full');
  const r = traced({ dealSim: deals });
  ok(near(r.tax.deals, 0.22, 1e-12) && near(r.tax.benefit, 0.187, 1e-12), 'M-04: the result reports the deal and benefit rates it used (methodology text reads them)');
  // The tax mix the Retirement tab builds from the deals' Account column.
  const mix = UI.dealTaxMix([{ account: 'Self-Directed IRA', commitment: 100 }, { account: 'Private Deals', commitment: 300 }, { account: '', commitment: 100 }]);
  ok(mix && near(mix.preTax, 0.4, 1e-12) && near(mix.taxable, 0.6, 1e-12), 'M-04: deal tax mix is weighted by commitment, a blank account counting as the Self-Directed IRA');
  ok(UI.dealTaxMix([]) === null, 'M-04: an empty book gives no mix (the simulator then assumes pre-tax)');
}

/* The traced ledger foots, and its last row ends on the headline (M-24). */
{
  const cfg = { thisYear: Y, birthYear: 1972, stopYear: 2035, planToAge: 92, spend: 180000, floorSpend: 140000, benefitAge: 67, benefitAnnual: 42000, paths: 301,
    sleeves: [{ id: 'growth', kind: 'growth', balance: 1500000, taxMix: { preTax: 0.7, roth: 0, taxable: 0.3 } }, { id: 'income', kind: 'income', balance: 300000 }, { id: 'cash', kind: 'cash', balance: 120000 }],
    dated: { 2029: { net: -60000, items: [] }, 2038: { net: 250000, items: [] }, 2041: { net: -40000, items: [] } },
    dealSim: { years: [2036, 2040], pathRows: Array.from({ length: 50 }, (_, i) => [i * 4000, 90000]) } };
  const mt = R.medianTrace(cfg);
  const full = R.simulate(cfg);
  let foots = true, chains = true;
  mt.rows.forEach((row, i) => {
    const ret = row.sleeves.reduce((a, s) => a + s.growth + s.income, 0);
    const gross = row.sleeves.reduce((a, s) => a + s.yield + s.principal, 0);
    const close = row.sleeves.reduce((a, s) => a + s.balanceAfter, 0);
    if (!near(row.opening + ret - gross + row.sweptIn, close, 0.5)) foots = false;
    if (i && !near(mt.rows[i - 1].sleeves.reduce((a, s) => a + s.balanceAfter, 0), row.opening, 0.5)) chains = false;
    if (!near(row.paid, row.benefit + row.datedIn + row.deals + (gross - (row.tax - row.benefitTax - row.dealsTax)), 0.5)) foots = false;
  });
  ok(foots, 'ledger: opening + return - withdrawn + swept in = closing, and paid = its sources, every row');
  ok(chains, 'ledger: each closing balance is the next opening');
  ok(near(mt.terminal, full.terminal.p50, 1e-6) && near(mt.rows[mt.rows.length - 1].sleeves.reduce((a, s) => a + s.balanceAfter, 0), full.terminal.p50, 0.5),
    'M-24: the traced "median" path ends exactly on terminal.p50');
  const again = R.simulate(cfg);
  ok(again.neverShort === full.neverShort && again.terminal.p50 === full.terminal.p50, 'same inputs and seed give the same answer');
}

/* M-15: today's dollars follow the simulator's own inflation path. */
{
  const C = { thisYear: Y, birthYear: 1972, stopYear: 2035, planToAge: 92, spend: 200000, floorSpend: 160000, benefitAge: 67, benefitAnnual: 42000, paths: 50, inflPre: 0.035, inflPost: 0.03,
    sleeves: [{ id: 'growth', kind: 'growth', balance: 3000000 }] };
  const r = R.simulate(C);
  const last = r.byYear[r.byYear.length - 1];
  ok(near(UI.real(last.need, last.year, C), 200000, 0.01), 'M-15: the 2064 target deflates back to the $200,000 typed: ' + UI.real(last.need, last.year, C));
  ok(near(UI.real(last.need, last.year, C, r), 200000, 0.01), 'M-15: the same through the run\'s own price index');
  ok(r.curve.every((c) => near(c.index, Math.pow(1.035, Math.min(c.year, 2035) - Y) * Math.pow(1.03, Math.max(0, c.year - 2035)), 1e-9)), 'M-15: curve price index = inflPre to the stop year, inflPost after');
}

/* M-19: an inflation of exactly 0 is kept. */
{
  const r = R.simulate(flat({ inflPre: 0, inflPost: 0, stopYear: Y + 10, planToAge: Y + 12 - 1970 }));
  ok(near(r.byYear[0].need, 100000, 1e-9) && near(r.byYear[2].need, 100000, 1e-9), 'M-19: 0% inflation is 0%, not the 3.5% default');
}

/* M-17: lognormal draws, no floor, mean preserved. */
{
  const lp = R.logParams(0.08, 0.6);
  ok(near(Math.exp(lp.m + lp.s * lp.s / 2) - 1, 0.08, 1e-12), 'M-17: logParams keeps the arithmetic mean');
  ok(near(R.logParams(0.07, 0.16).m, X.Markets.logParams(0.07, 0.16).m, 1e-15) && near(R.logParams(0.07, 0.16).s, X.Markets.logParams(0.07, 0.16).s, 1e-15),
    'M-17: the runway uses the same lognormal as the Equity Curve cone');
  // One year of a crypto-like sleeve: mean 8%, volatility 60%, many paths.
  const r = R.simulate({ thisYear: Y, birthYear: 1970, stopYear: Y + 1, planToAge: Y + 1 - 1970, spend: 0, floorSpend: 0, benefitAnnual: 0, mode: 'fixed', paths: 40000,
    sleeves: [{ id: 'c', kind: 'growth', balance: 1000000, mu: 0.08, sd: 0.6, yield: 0 }] });
  const ends = r.terminalByPath;
  const avg = ends.reduce((a, v) => a + v, 0) / ends.length;
  ok(near(avg / 1e6, 1.08 * 1.08, 0.03), 'M-17: two years at 8% mean compound to 1.166, not the floored normal\'s ~1.21: ' + (avg / 1e6).toFixed(4));
  ok(Math.min.apply(null, ends) > 0, 'M-17: no year loses more than everything');
}

/* M-25: a sequence horizon longer than the record is refused with a reason. */
{
  const long = { thisYear: Y, birthYear: 2000, stopYear: 2060, planToAge: 130, spend: 1, floorSpend: 1, sampling: 'sequence', sleeves: [{ id: 'g', kind: 'growth', balance: 1e6 }] };
  ok(R.simulate(long) === null && R.diagnose(long).why === 'history-too-short', 'M-25: a 106-year sequence run returns null and diagnose() names why');
}

/* M-28: a matrix that is not a correlation matrix is refused, not clamped. */
{
  ok(R.cholesky([[1, 0.9, -0.9], [0.9, 1, 0.9], [-0.9, 0.9, 1]]) === null, 'M-28: cholesky returns null for a non-PSD matrix');
  ok(R.cholesky([[1, 0.5], [0.5, 1]]) !== null, 'M-28: a valid matrix still factors');
  const bad = R.simulate({ thisYear: Y, birthYear: 1972, stopYear: 2035, planToAge: 92, spend: 100000, floorSpend: 80000, paths: 50,
    sleeves: [{ id: 'a', kind: 'growth', balance: 1e6 }, { id: 'b', kind: 'bonds', balance: 1e6 }, { id: 'c', kind: 'cash', balance: 1e6 }],
    corr: { a: { b: 0.9, c: -0.9 }, b: { a: 0.9, c: 0.9 }, c: { a: -0.9, b: 0.9 } } });
  ok(bad && bad.corrRejected && !bad.correlated, 'M-28: the run says the correlation was ignored');
}

/* M-29(b): byYear.need is the median target, not the last path's. */
{
  const cfg = { thisYear: Y, birthYear: 1972, stopYear: 2030, planToAge: 70, spend: 100000, floorSpend: 80000, sampling: 'historical', paths: 3,
    sleeves: [{ id: 'g', kind: 'growth', balance: 3e6 }] };
  const needs = [0, 1, 2].map((i) => R.simulate(Object.assign({}, cfg, { trace: true, traceAt: i })).trace[3].fullTarget).sort((a, b) => a - b);
  ok(near(R.simulate(cfg).byYear[3].need, needs[1], 1e-6), 'M-29b: historical-mode need is the median across paths');
}

/* M-27: historical mode honours a sleeve's stated return and volatility. */
{
  const h = (sd) => R.simulate({ thisYear: Y, birthYear: 1972, stopYear: 2035, planToAge: 92, spend: 0, floorSpend: 0, benefitAnnual: 0, sampling: 'historical', paths: 300,
    sleeves: [{ id: 'g', kind: 'growth', balance: 2e6, mu: 0.07, sd, yield: 0 }] });
  const lo = h(0.16), hi = h(0.6);
  const spread = (r) => Math.log(r.terminal.p90 / r.terminal.p10);
  ok(spread(hi) > 2 * spread(lo), 'M-27: a 60% volatility sleeve replays history with a far wider (log) range than a 16% one');
}

/* history.js: a block never wraps from 2025 back to 1928. */
{
  let s = 1; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const p = Hist.blockPath(rnd, 20000, 10);
  let wraps = 0;
  for (let i = 0; i < p.length; i += 10) for (let k = 1; k < 10 && i + k < p.length; k++) if (p[i + k] !== p[i + k - 1] + 1) wraps++;
  ok(wraps === 0 && p.every((v) => v >= 0 && v < Hist.N), 'history: blocks are consecutive real years and never wrap: ' + wraps);
  ok(Hist.sequences(Hist.N + 1).length === 0 && Hist.sequences(10).length === Hist.N - 9, 'history: sequences() counts every complete window');
}

/* Dated items flagged to inflate are today's dollars on the path's own price level. */
{
  const r = traced({ inflPre: 0.03, dated: { [Y + 3]: { net: 10000, items: [{ label: 'Pension', amount: 10000, inflates: true }] } } });
  ok(near(r.traceRunup[3].flow, 10000 * Math.pow(1.03, 3), 1e-6), 'inflating dated item grows at the path\'s inflation: ' + r.traceRunup[3].flow);
  const plain = traced({ inflPre: 0.03, dated: { [Y + 3]: { net: 10000, items: [{ label: 'Sale', amount: 10000 }] } } });
  ok(near(plain.traceRunup[3].flow, 10000, 1e-9), 'an unflagged dated item stays nominal');
}

/* Floor above target and levers copy (UX-35, UX-30). */
{
  const lv = R.levers({ thisYear: Y, birthYear: 1972, stopYear: 2035, planToAge: 92, spend: 150000, floorSpend: 120000, benefitAge: 67, benefitAnnual: 42000,
    mode: 'fixed', sleeves: [{ id: 'g', kind: 'growth', balance: 2e6 }] }, { paths: 100 });
  const names = lv.levers.map((l) => l.label);
  ok(names.includes('Start Social Security at 70') && names.includes('Spend only the must-have amount'), 'UX-23/UX-30: lever labels name Social Security and the must-have amount');
  ok(!lv.levers.some((l) => /never short, at the price/.test(l.note)), 'UX-30: the floor lever no longer claims "never short"');
}

/* No em or en dashes in anything these files can put on screen (UX-24). */
{
  for (const f of ['runway.js', 'runway-ui.js', 'history.js']) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    ok(!/[–—]|&mdash;|&ndash;/.test(src), 'UX-24: no em or en dash in ' + f);
  }
}

/* DOM checks: the Retirement tab on the example book. */
async function domChecks() {
  const H = await boot();
  if (!H) { console.log('jsdom not found: DOM checks skipped (set JSDOM_DIR)'); skipped = 1; return; }
  const w = H.w;
  await demo(H); await tab(H, 'runway');
  const anchor = w.RunwayUI.stopYear(w.PlanIncludes.ctx);
  const body = () => H.$('#tabbody');
  ok(!/[–—]|NaN|undefined|Infinity/.test(body().innerHTML), 'UX-24: the rendered tab has no em or en dash, NaN or undefined');
  ok(!H.errors.length, 'no script errors: ' + H.errors.slice(0, 2).join(' | '));

  // UX-17: the comparison row for the current stop year IS the headline.
  const kpiText = (key) => { const el = body().querySelector('[data-rwkpi="' + key + '"]'); return el ? el.textContent : ''; };
  const head = parseInt(kpiText('neverShort'), 10);
  const hiRow = body().querySelector('tr.hi');
  const rowNS = hiRow ? parseInt(hiRow.children[2].textContent, 10) : NaN;
  ok(Number.isFinite(head) && head === rowNS, 'UX-17: headline never short (' + head + '%) = the highlighted stop-year row (' + rowNS + '%)');
  const PI = w.PlanIncludes;
  const res = PI.run(PI.ctx, {}, 1200);
  ok(Math.round(res.r.neverShort * 100) === head, 'UX-17: the headline matches PlanIncludes.run, so the other tabs agree');
  const leftTxt = kpiText('left').replace(/[^0-9]/g, '');
  ok(Number(leftTxt) === Math.round(PI.ending(res)), 'M-15: "Left at the end" = PlanIncludes.ending (today\'s dollars, one deflator): ' + leftTxt);

  // UX-35: the floor is capped at the target and disabled when the mode ignores it.
  let fl = body().querySelector('[data-rw="floorSpend"]'), sp = body().querySelector('[data-rw="spend"]');
  ok(fl.disabled && /Income floor first/.test(fl.closest('label').textContent), 'UX-35: in Guardrails the floor slider is disabled and says which mode uses it');
  ok(Number(fl.max) <= Number(sp.value), 'UX-35: the floor slider cannot go above the target');
  const mb = body().querySelector('[data-rwmode="floor"]'); mb.focus(); mb.click();
  fl = body().querySelector('[data-rw="floorSpend"]');
  ok(!fl.disabled, 'UX-35: in "Income floor first" the floor slider is live');
  ok(w.document.activeElement && w.document.activeElement.getAttribute('data-rwmode') === 'floor', 'H7: a mode button keeps focus after the re-render');
  // Lower the target below the floor: the floor follows it down.
  sp = body().querySelector('[data-rw="spend"]'); sp.value = sp.min; sp.dispatchEvent(new w.Event('change'));
  const C = w.RunwayUI.baseConfig(PI.ctx).C;
  ok(C.floorSpend <= C.spend, 'UX-35: lowering the target below the floor moves the floor down: ' + C.floorSpend + ' <= ' + C.spend);

  // H7: input updates the label only; change recomputes and keeps focus on the same slider.
  let s = body().querySelector('[data-rw="stopYear"]'); s.focus();
  const before = body().innerHTML;
  s.value = String(Number(s.value) + 1); s.dispatchEvent(new w.Event('input'));
  ok(s.isConnected && body().querySelector('[data-rwval="stopYear"]').textContent === s.value && w.document.activeElement === s, 'H7: an input tick does not re-render or drop focus');
  ok(before.replace(/data-rwval="stopYear">\d+/, '') === body().innerHTML.replace(/data-rwval="stopYear">\d+/, ''), 'H7: an input tick changes nothing but the value label');
  s.dispatchEvent(new w.Event('change'));
  const a = w.document.activeElement;
  ok(a && a.getAttribute('data-rw') === 'stopYear' && a !== s, 'H7: after change the tab re-renders and focus returns to the same slider');
  ok(Number(body().querySelector('[data-rw="stopYear"]').min) >= 2026, 'UX-40: the stop-year slider does not offer a past year');

  // UX-16: the methodology lists the sleeves in this run under the Holdings names.
  const sv = w.RunwayUI.baseConfig(PI.ctx).C.sleeves.map((x) => x.label);
  const method = body().querySelector('#fpos-method').textContent;
  ok(sv.length > 1 && sv.every((l) => method.includes(l)), 'UX-16: methodology names the same sleeves as Holdings: ' + sv.join(', '));
  ok(/taxed at \d/.test(method) && /85%/.test(method), 'M-04: the methodology states the deal and Social Security tax');

  // L12: names in the include panel are escaped.
  const bk = PI.ctx.book;
  PI.consider({ name: '<img src=x id=pwn>', commitment: 1000, paid: 0, year: new w.Date().getFullYear(), account: '', book: [bk[0]] });
  await tab(H, 'dash'); await tab(H, 'runway');
  ok(!body().querySelector('#pwn') && body().innerHTML.includes('&lt;img src=x id=pwn&gt;'), 'L12: a deal name is escaped in "Included in This Plan"');
  PI.consider(null);

  // QA M1: a new book clears the slider overrides.
  s = body().querySelector('[data-rw="stopYear"]'); s.value = String(Number(s.value) + 2); s.dispatchEvent(new w.Event('change'));
  ok(w.RunwayUI.stopYear(PI.ctx) === anchor + 3, 'M1: the slider moved the stop year (test precondition)');
  const plug = w.APP_PLUGINS.find((p) => p.id === 'runway');
  const ctx2 = Object.assign({}, PI.ctx, { book: bk.slice() });
  plug.render(body(), ctx2);
  ok(w.RunwayUI.stopYear(ctx2) === anchor && !body().querySelector('[data-rwreset]'), 'M1: a new book starts from the tracker, not the sliders of the last book');
}

await domChecks();
console.log('runway: ' + checks + ' checks, ' + fails + ' failures' + (skipped ? ' (DOM checks skipped)' : ''));
process.exit(fails ? 1 : 0);
