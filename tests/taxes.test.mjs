// Tax Strategies: the Roth conversion model and the stacking order.  node tests/taxes.test.mjs
import fs from 'fs'; import vm from 'vm'; import path from 'path'; import { fileURLToPath } from 'url';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = { console, Math, Date }; ctx.globalThis = ctx; ctx.window = ctx; vm.createContext(ctx);
for (const f of ['taxplay.js', 'taxes-ui.js']) vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx);
const TP = ctx.TaxPlay, T = ctx.TaxStrategies;
let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL', m); } };
const near = (a, b, t) => Math.abs(a - b) <= t;
const Y = new Date().getFullYear();
const prof = { status: 'mfj', persded: 32200 };
const flat = {}; for (let y = Y; y < Y + 60; y++) flat[y] = 400000;

// One $100k conversion on $400k of W-2: taxable income $367,800, so $35,750 at 24% and $64,250 at 32%.
const one = { uid: 1, id: 'roth', startYear: Y, repeat: 1, inputs: { amount: 100000, growth: 0.06, laterRate: 0.24, drawStart: Y + 14, drawYears: 20 } };
const r1 = T.rothRun(one, flat, prof);
ok(near(r1.roth.paid, 35750 * 0.24 + 64250 * 0.32, 0.01), 'conversion tax follows the brackets: ' + r1.roth.paid);
ok(near(r1.next[Y], 500000, 1e-6) && r1.next[Y + 1] === 400000, 'conversion adds to that year only');
// The fair test: discounted at the growth rate, the gain is amount x (later rate - rate now).
ok(near(r1.roth.pv, 100000 * 0.24 - r1.roth.paid, 1e-6), 'pv = A x laterRate - tax now');
ok(near(T.presentValue([{ label: 'r', years: r1.years }], 0.06), r1.roth.pv, 0.5), 'year-by-year flows discount back to the same pv');
ok(r1.years.filter((o) => o.saved > 0).length === 20 && r1.years[1].year === Y + 14, 'withdrawals run over the drawing years');
// Converting at a low rate wins: $40k of income, $100k converted, 24% later.
const low = {}; for (let y = Y; y < Y + 60; y++) low[y] = 40000;
ok(T.rothRun(one, low, prof).roth.pv > 0, 'a cheap year makes converting pay');

// Heavy Machinery alone matches the published model through the common Run shape.
T.S.plan.length = 0; T.addStrategy('hm');
const hm = T.runPlan(flat, prof);
const ref = TP.summary(TP.stack([{ kind: 'hm', startYear: Y, inputs: {} }], flat, prof).runs[0]);
ok(near(hm[0].sum.allIn, ref.allIn, 1e-6) && near(hm[0].sum.y1TaxSaved, ref.y1TaxSaved, 1e-6), 'HM through runPlan = TaxPlay: ' + hm[0].sum.allIn);
// A conversion is counted first wherever it sits in the list, so a deduction can absorb it.
T.addStrategy('roth'); T.S.plan[1].repeat = 1;
const a = T.runPlan(flat, prof);
T.S.plan.reverse();
const b = T.runPlan(flat, prof);
const tot = (runs) => runs.reduce((s, r) => s + r.sum.allIn, 0);
ok(near(tot(a), tot(b), 1e-6), 'stacking order does not depend on list order');
ok(a.find((r) => r.label === 'Heavy Machinery').sum.y1TaxSaved > ref.y1TaxSaved, 'HM saves more when a conversion raises the income it offsets');
// Cost segregation, against a hand calculation. $1M building, 20% land, 25% reclassified,
// 100% bonus, $8k fee, residential (27.5 years), held 10 years.
const csDef = T.STRATEGIES.find((d) => d.id === 'costseg');
const cs = (over) => csDef.run({ uid: 9, id: 'costseg', startYear: Y, repeat: 1, inputs: Object.assign({}, csDef.defaults, over || {}) }, flat, prof);
const a1 = cs();
const ded = 600000 / 27.5 + 200000 - 800000 / 27.5 + 8000;
ok(near(a1.cs.y1Ded, ded, 0.01), 'year-1 extra deduction: ' + a1.cs.y1Ded);
ok(near(a1.years[0].saved, TP.tax(367800, 'mfj') - TP.tax(367800 - ded, 'mfj'), 0.01), 'year-1 saving priced through the brackets');
ok(a1.years[1].extra < 0 && a1.cs.owed > 0, 'later years deduct less, and a sale brings recapture');
const keep = cs({ end: 'keep' });
// Keep or 1031: no recapture, but the comparison runs to the end of the 27.5-year life, where the
// extra and missing depreciation cancel. Over its life it nets about minus the fee; the value is the
// timing, which only the discounted figure shows. (The old test asserted a permanent saving.)
ok(keep.cs.owed === 0 && keep.cs.net < 0 && keep.cs.net > -8000 && keep.cs.pv > keep.cs.net, 'keep or 1031: no recapture, the deduction is given back later: net ' + Math.round(keep.cs.net) + ', worth today ' + Math.round(keep.cs.pv));
const pas = cs({ use: 'passive' });
ok(pas.years[0].saved === 0 && pas.years.some((o) => o.saved > 0 && o.year === Y + 9), 'passive: nothing against W-2, loss released at the sale');
ok(near(cs({ reclass: 0, fee: 0 }).cs.net, 0, 0.01), 'no reclassification, no fee: no difference');
// Oil and gas: $100k program, 75% intangible drilling costs, 20% equipment at 100% bonus.
const ogDef = T.STRATEGIES.find((d) => d.id === 'energy');
const og = (over) => ogDef.run({ uid: 8, id: 'energy', startYear: Y, repeat: 1, inputs: Object.assign({}, ogDef.defaults, over || {}) }, flat, prof);
const g1 = og();
ok(near(g1.og.y1Ded, 95000, 0.01) && near(g1.years[0].saved, 95000 * 0.24, 0.01), 'year-1 deduction 95k, all in the 24% bracket: ' + g1.og.y1Saved);
ok(near(g1.og.cashAll, 22000 * (1 - Math.pow(0.82, 12)) / 0.18, 0.01), 'production cash follows the decline curve');
const g2 = og({ interest: 'limited' });
ok(g2.years[0].saved === 0 && g2.og.pv < g1.og.pv && near(g2.og.cashAll, g1.og.cashAll, 1e-6), 'limited partner: no year-1 saving, same cash, worth less');
ok(og({ yield1: 0 }).og.net < -50000, 'a dry program loses most of the money even with the deduction');
// Solar: $100k equipment, 30% credit, 100% bonus on cost less half the credit, sold in year 6.
const solDef = T.STRATEGIES.find((d) => d.id === 'solar');
const sol = (over, yr) => solDef.run({ uid: 7, id: 'solar', startYear: yr || Y, repeat: 1, inputs: Object.assign({}, solDef.defaults, over || {}) }, flat, prof);
const s1 = sol();
ok(near(s1.years[0].saved, 30000 + 85000 * 0.24, 0.01), 'year one: 30k credit + 85k basis at 24%: ' + s1.sol.y1Saved);
ok(s1.sol.clawAll === 0 && near(sol({ hold: 3 }).sol.clawAll, 18000, 0.01) && near(sol({ hold: 1 }).sol.clawAll, 30000, 0.01), 'credit clawback follows the 5-year schedule');
ok(sol({}, 2028).sol.creditAll === 0 && sol({}, 2028).sol.late, 'in service after 2027: no credit');
const sp = sol({ use: 'passive' });
ok(sp.years[0].saved === 0 && sp.sol.lostAll > 0, 'passive: nothing against W-2 in year one');
// Invest what it saves: the side account ends at zero exactly at the break-even rate, and a
// deferral-shaped plan (Heavy Machinery: saving first, tax later) gains from faster growth.
T.S.plan.length = 0; T.addStrategy('hm');
const rowsHM = T.yearly(T.runPlan(flat, prof));
const cpHM = T.compound(rowsHM, 0.07);
ok(cpHM.rising && cpHM.be != null, 'Heavy Machinery is deferral-shaped, with a break-even rate: ' + (cpHM.be * 100).toFixed(1) + '%');
const atBe = T.compound(rowsHM, cpHM.be);
ok(near(atBe.pts[atBe.pts.length - 1].inv, 0, 1), 'side account ends at zero at the break-even rate');
ok(near(T.compound(rowsHM, 0).pts.slice(-1)[0].inv, rowsHM.reduce((a, r) => a + r.saved + r.extra + r.cash + r.sale + r.down + r.owed, 0), 1e-6), 'at 0% growth it is the plain total');
T.S.plan.length = 0; T.addStrategy('energy');
ok(!T.compound(T.yearly(T.runPlan(flat, prof)), 0.07).rising, 'oil and gas is investment-shaped');
console.log('taxes: ' + checks + ' checks, ' + fails + ' failures');
process.exit(fails ? 1 : 0);
