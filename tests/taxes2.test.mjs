// Tax Strategies hardening: one regression check per audit finding.  node tests/taxes2.test.mjs
// Model checks run taxplay.js and taxes-ui.js in a bare vm context, like taxes.test.mjs. The
// focus and inline-message checks need a DOM: they use jsdom when it can be found (set
// JSDOM_DIR to a node_modules folder that has it), and say so when they are skipped.
import fs from 'fs'; import vm from 'vm'; import path from 'path'; import { fileURLToPath } from 'url'; import { createRequire } from 'module';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = ['taxplay.js', 'taxes-ui.js'].map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
/* A fresh sandbox; `now` pins the clock (a Date whose no-argument form returns that time). */
function sandbox(now) {
  let D = Date;
  if (now) { const fixed = new Date(now).getTime(); D = class extends Date { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } }; }
  const ctx = { console, Math, Date: D }; ctx.globalThis = ctx; ctx.window = ctx; vm.createContext(ctx);
  for (const [f, s] of SRC) vm.runInContext(s, ctx, { filename: f });
  return ctx;
}
let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL', m); } };
const near = (a, b, t) => Math.abs(a - b) <= t;
const ctx = sandbox(), TP = ctx.TaxPlay, T = ctx.TaxStrategies;
const Y = new Date().getFullYear();
const prof = { status: 'mfj', persded: 32200 };
const flatOf = (v) => { const o = {}; for (let y = Y; y < Y + 80; y++) o[y] = v; return o; };
const flat = flatOf(400000);
const stubHost = () => ({ innerHTML: '', querySelector: () => null, querySelectorAll: () => [] });
const BOOK0 = [];   // one book for the whole run: a different book starts a new plan
const html = (book) => { const h = stubHost(); T.render(h, { book: book || BOOK0 }); return h.innerHTML; };
const textOf = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const def = (id) => T.STRATEGIES.find((d) => d.id === id);
const runOne = (id, over, income, p, start) => def(id).run({ uid: 1, id, startYear: start || Y, repeat: 1, inputs: Object.assign({}, def(id).defaults, over || {}) }, income || flat, p || prof);

/* QA H1: the plan starts empty, nothing reaches Retirement, and the tab invites a first strategy. */
ok(T.S.plan.length === 0, 'H1: a fresh load has an empty plan');
ok(T.dated({}) === null, 'H1: an empty plan hands Retirement nothing');
{
  const h = html();
  ok(/Your Tax Plan Is Empty/.test(h) && /data-txlib[^>]*>Add a strategy</.test(h), 'H1: empty state with an "Add a strategy" call to action');
  ok(/data-txadd="hm"[^>]*>Try Heavy Machinery/.test(h), 'H1: a visible "Try Heavy Machinery" button keeps the example meaningful');
  ok(!/Combined Tax Impact/.test(h), 'H1: no results card for an empty plan');
}

/* M-05: cost segregation "Keep" runs to the recovery life and gives the extra deduction back. */
{
  const fee = def('costseg').defaults.fee;
  const k5 = runOne('costseg', { end: 'keep', hold: 5 }), k40 = runOne('costseg', { end: 'keep', hold: 40 });
  ok(k5.cs.owed === 0 && near(k5.cs.net, k40.cs.net, 1e-6), 'M-05: keep ignores the years held (same result at 5 and 40): ' + Math.round(k5.cs.net));
  ok(k5.cs.years === 28 && k5.years[k5.years.length - 1].year >= Y + 27, 'M-05: keep runs the 27.5-year life (28 calendar years)');
  ok(k5.cs.net < 0 && k5.cs.net > -fee, 'M-05: over the full life a keeper nets about minus the fee after its deduction: ' + Math.round(k5.cs.net));
  ok(k5.cs.pv > k5.cs.net, 'M-05: the value of keeping is the timing, worth more today than its undiscounted net');
  const kc = runOne('costseg', { end: 'keep', type: 'com' });
  ok(kc.cs.years === 39, 'M-05: commercial keep runs 39 years');
  const s40 = runOne('costseg', { end: 'sell', hold: 40 });
  ok(s40.years.filter((o) => o.year >= Y + 28 && o.year < Y + 39).every((o) => Math.abs(o.saved + o.extra) < 1e-6), 'M-05: no depreciation difference after the basis is used up (hold 40, sell)');
  const s10 = runOne('costseg', {});
  const B = 800000, R = 200000, ded1 = 600000 / 27.5 + 200000 - 800000 / 27.5 + fee;
  ok(near(s10.cs.y1Ded, ded1, 0.01), 'M-05: the sell case is unchanged in year one');
  T.S.plan.length = 0; const it = T.addStrategy('costseg'); it.inputs.end = 'keep';
  const h = html();
  ok(/given back as smaller deductions/.test(h) && !/permanent/.test(h), 'M-05: the keep card says the deduction is given back, never "permanent"');
  T.S.plan.length = 0;
  void B; void R;
}

/* M-07: the unused standard deduction absorbs new income first. */
{
  const zero = flatOf(0);
  const one = { uid: 1, id: 'roth', startYear: Y, repeat: 1, inputs: { amount: 100000, growth: 0.06, laterRate: 0.24, drawStart: Y + 14, drawYears: 20 } };
  const r = T.rothRun(one, zero, prof);
  ok(near(r.roth.paid, TP.tax(100000 - 32200, 'mfj'), 0.01), 'M-07: $100k converted with no other income is taxed on $67,800: ' + Math.round(r.roth.paid));
  const r2 = T.rothRun(one, flatOf(20000), prof);
  ok(near(r2.roth.paid, TP.tax(120000 - 32200, 'mfj'), 0.01), 'M-07: with $20k of income, the other $12,200 of deduction still counts');
  const og = runOne('energy', {}, zero);
  const prodTax = og.years.filter((o) => o.year > Y).reduce((a, o) => a + o.extra, 0);
  ok(prodTax === 0, 'M-07: production income below the standard deduction is not taxed in a zero-income year');
}

/* M-08: a Heavy Machinery exit hands its recapture on to the next strategy. */
{
  const p2 = (sy) => ({ uid: 0, id: 'hm', startYear: sy, repeat: 1, inputs: Object.assign({}, TP.KINDS.hm.defaults) });
  const plan = [p2(Y), p2(Y)]; plan[0].uid = 101; plan[1].uid = 102;
  const runs = T.runPlan(flat, prof, plan);
  const old = TP.stack([{ kind: 'hm', startYear: Y }, { kind: 'hm', startYear: Y }], flat).runs.map((r) => TP.summary(r));
  ok(near(runs[0].sum.owedBack, old[0].recapTax + old[0].ltcgTax, 1e-6), 'M-08: the first play is unchanged');
  ok(runs[1].sum.owedBack > old[1].recapTax + old[1].ltcgTax + 1000, 'M-08: the second play prices its recapture above the first one\u2019s: ' + Math.round(runs[1].sum.owedBack) + ' vs ' + Math.round(old[1].recapTax + old[1].ltcgTax));
  /* a cost segregation sale after an HM exit in the same year sees the HM recapture */
  const cs = { uid: 103, id: 'costseg', startYear: Y - 4 + 0, repeat: 1, inputs: Object.assign({}, def('costseg').defaults, { hold: 2 }) };
  cs.startYear = Y + 4;   // its sale lands in Y + 5, the HM exit year
  const withHM = T.runPlan(flat, prof, [plan[0], cs]).find((r) => r.label === 'Cost segregation');
  const alone = T.runPlan(flat, prof, [cs]).find((r) => r.label === 'Cost segregation');
  ok(withHM.sum.owedBack > alone.sum.owedBack, 'M-08: a later strategy\u2019s recapture is priced above an earlier exit\u2019s recapture');
}

/* M-09 and M-10: one discount rate for every "worth today" figure, the Roth card included. */
{
  const it = (rep) => ({ uid: 1, id: 'roth', startYear: Y, repeat: rep, inputs: { amount: 100000, growth: 0.06, laterRate: 0.24, drawStart: Y + 14, drawYears: 20 } });
  const r3 = T.rothRun(it(3), flat, prof);
  ok(near(r3.roth.pv, T.presentValue([{ label: 'r', years: r3.years }], 0.06), 1e-6), 'M-09: the Roth card pv is its own flows discounted to today');
  const fair = r3.years.filter((o) => o.extra < 0).reduce((a, o) => a + (100000 * 0.24 + o.extra) / Math.pow(1.06, o.year - Y), 0);
  ok(near(r3.roth.pv, fair, 0.5), 'M-09: at discount = growth, pv = sum of (amount x later rate - tax now), each discounted from its year: ' + Math.round(r3.roth.pv));
  const r9 = T.rothRun(it(1), flat, Object.assign({}, prof, { discount: 0.09 }));
  ok(near(r9.roth.pv, T.presentValue([{ label: 'r', years: r9.years }], 0.09), 1e-6) && r9.roth.discount === 0.09, 'M-10: the Roth card follows the tab discount rate, not its growth rate');
  T.S.plan.length = 0; T.addStrategy('hm'); const rr = T.addStrategy('roth'); rr.inputs.growth = 0.09;
  const h = html();
  ok(/every year\u2019s net discounted at 6\.0% a year/.test(h) && !/discounted at 9\.0%/.test(h), 'M-10: adding a Roth at 9% growth does not change the plan\u2019s discount rate');
  ok(/Discount rate/.test(h) && /Retirement\u2019s \u201ctoday\u2019s dollars\u201d is a different measure/.test(h), 'M-10: the convention is stated on the tab');
  ok(!/in today\u2019s dollars<\/span>/.test(h), 'M-10: no strategy pill calls its present value "today\u2019s dollars"');
  T.S.plan.length = 0;
}

/* M-11: two break-even rates are found and reported honestly. */
{
  const row = (year, v) => ({ year, down: v < 0 ? v : 0, saved: v > 0 ? v : 0, extra: 0, cash: 0, sale: 0, owed: 0, items: [] });
  const rows = [row(2026, -100000), row(2027, 230000), row(2028, -132000)];
  const cp = T.compound(rows, 0.07);
  ok(cp.roots.length === 2 && near(cp.roots[0], 0.10, 1e-6) && near(cp.roots[1], 0.20, 1e-6), 'M-11: both roots found: ' + cp.roots.map((r) => r.toFixed(4)).join(', '));
  ok(cp.be === null && cp.signChanges === 2, 'M-11: no single break-even claimed; two sign changes counted');
  const t = T.compoundText(cp, 0.07);
  ok(/between 10\.0% and 20\.0%/.test(t) && !/no break-even/i.test(t), 'M-11: the sentence says ahead only between 10% and 20%: ' + textOf(t).slice(0, 120));
  ok(/ends <b>\$390<\/b> behind/.test(t), 'M-11: and says the plan ends behind at 7% (-100k x 1.07^2 + 230k x 1.07 - 132k = -390)');
  T.S.plan.length = 0; T.addStrategy('hm');
  const one = T.compound(T.yearly(T.runPlan(flat, prof)), 0.07);
  ok(one.roots.length === 1 && one.be != null && one.rising, 'M-11: a one-root plan still reports its single rate');
  T.S.plan.length = 0;
}

/* M-12: solar gain above the basis is taxed as a capital gain; a loss is deducted; a clawback restores basis. */
{
  const at = (sp) => runOne('solar', { salePct: sp });
  const a = at(0.85), b = at(1.0), c = at(1.5);
  ok(a.sum.owedBack < b.sum.owedBack && b.sum.owedBack < c.sum.owedBack, 'M-12: more sale price, more tax owed back: ' + [a, b, c].map((x) => Math.round(x.sum.owedBack)).join(' < '));
  ok(near(c.sol.cgTaxAll, 65000 * 0.15, 1), 'M-12: $65k above the $85k basis is taxed at 15%: ' + Math.round(c.sol.cgTaxAll));
  ok(near(at(0.30).sol.cgTaxAll, 0, 1e-9), 'M-12: the default sale (below basis) has no capital gain');
  const lossy = runOne('solar', { bonus: 0, hold: 2, salePct: 0 });
  const yr = lossy.years.find((o) => o.year === Y + 1);
  ok(yr.saved > 0 && yr.owed < 0, 'M-12: selling for nothing deducts the remaining basis as an ordinary loss (and the clawback still applies)');
  const k1 = runOne('solar', { hold: 1, salePct: 1.0 });
  ok(near(k1.sol.cgTaxAll, (100000 - (85000 + 15000)) * 0.15, 1), 'M-12: a full clawback adds half the credit back to basis before the gain');
}

/* Input bounds: every typed value is clamped with a message; blanks keep the old value. */
{
  const hm = def('hm'), down = hm.fields.find((f) => f.key === 'down');
  const v1 = T.validate(down, '150', 0.1);
  ok(v1.value === 1 && /between 0% and 100%; set to 100%/.test(v1.msg), 'bounds: a 150% down payment becomes 100% with a message');
  ok(T.validate(down, '-5', 0.1).value === 0, 'bounds: a negative percent becomes the minimum');
  const v2 = T.validate(down, '', 0.1);
  ok(v2.value === 0.1 && /needs a number/.test(v2.msg), 'bounds: a blank keeps the previous value and says so');
  ok(T.validate(down, '12.5%', 0.1).value === 0.125 && T.validate(down, '12.5', 0.1).msg === null, 'bounds: a "%" sign is ignored; a valid entry has no message');
  const price = hm.fields.find((f) => f.key === 'price');
  ok(T.validate(price, '-500000', 500000).value === 0 && T.validate(price, '$1,250,000', 0).value === 1250000, 'bounds: money is floored at zero and separators are read');
  ok(T.validate(hm.fields.find((f) => f.key === 'exit'), '9', 6).value === 8, 'bounds: an HM sale after the 8 modelled years is pulled back to year 8');
  ok(T.validate(def('wfh').fields.find((f) => f.key === 'exit'), '11', 9).value === 10, 'bounds: a WFH sale after the 10 modelled years is pulled back to year 10');
  ok(T.validate(T.ITEM_FIELDS.repeat, '400', 1).value === 20 && T.validate(T.ITEM_FIELDS.startYear, '1999', Y).value === Y && T.validate(T.ITEM_FIELDS.startYear, '3000', Y).value === Y + 40, 'bounds: repeat 1 to 20, first year this year to 40 years out');
  ok(T.validate(T.ITEM_FIELDS.repeat, '2.6', 1).value === 3, 'bounds: whole-number fields are rounded');
  const w2 = T.PROFILE_FIELDS.find((f) => f.key === 'w2Now');
  ok(T.validate(w2, '-100000', 400000).value === 0, 'bounds: W-2 income cannot be negative');
  const every = T.STRATEGIES.every((d) => d.fields.every((f) => f.type === 'select' || f.type === 'bool' || (f.min != null && f.max != null)))
    && T.PROFILE_FIELDS.every((f) => f.min != null && f.max != null);
  ok(every, 'bounds: every numeric field declares a min and a max');
  const og = def('energy'), inp = Object.assign({}, og.defaults, { idc: 0.9 });
  const m = og.fix(inp, 'idc');
  ok(near(inp.idc, 0.8, 1e-9) && /cannot be more than 100%/.test(m), 'bounds: drilling costs plus equipment are held to 100%');
}

/* M-22: a zero conversion prints no NaN. */
{
  const r = T.rothRun({ uid: 1, id: 'roth', startYear: Y, repeat: 2, inputs: { amount: 0, growth: 0.06, laterRate: 0.24, drawStart: Y + 14, drawYears: 20 } }, flat, prof);
  ok(r.roth.avgNow === 0 && r.roth.worst === 0 && isFinite(r.roth.pv), 'M-22: amount 0 gives zero rates, not NaN');
  T.S.plan.length = 0; const it = T.addStrategy('roth'); it.inputs.amount = 0;
  ok(!/NaN|Infinity|undefined/.test(textOf(html())), 'M-22: the Roth card renders without NaN');
  T.S.plan.length = 0;
}

/* "This year" is read when needed, not frozen at load. */
{
  const late = sandbox('2026-12-31T23:50:00'), L = late.TaxStrategies;
  L.addStrategy('hm');
  ok(L.S.plan[0].startYear === 2026 && L.STRATEGIES.find((d) => d.id === 'roth').defaults.drawStart === 2040, 'year: before midnight the plan starts in 2026');
  const next = sandbox('2027-01-01T00:10:00');
  ok(next.TaxStrategies.nowYear() === 2027 && next.TaxStrategies.STRATEGIES.find((d) => d.id === 'roth').defaults.drawStart === 2041, 'year: defaults follow the clock');
  /* the same session across midnight: the clock moves under a live module */
  let now = new Date('2026-12-31T23:50:00').getTime();
  const D = class extends Date { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } };
  const c2 = { console, Math, Date: D }; c2.globalThis = c2; c2.window = c2; vm.createContext(c2);
  for (const [f, s] of SRC) vm.runInContext(s, c2, { filename: f });
  c2.TaxStrategies.addStrategy('hm');
  now = new Date('2027-01-01T00:10:00').getTime();
  const dd = c2.TaxStrategies.dated({});
  ok(Math.min(...Object.keys(dd).map(Number)) === 2027 && c2.TaxStrategies.S.plan[0].startYear === 2027, 'year: after midnight the plan and its dated cash start in 2027');
  ok(c2.TaxStrategies.ITEM_FIELDS.startYear.min() === 2027, 'year: the first-year minimum moves with the clock');
}

/* Brackets indexed for the models written here; income after the stop year is an input. */
{
  const yr = Y + 4, idx = 0.10, f = Math.pow(1 + idx, yr - 2026);
  const it = { uid: 1, id: 'roth', startYear: yr, repeat: 1, inputs: { amount: 100000, growth: 0.06, laterRate: 0.24, drawStart: yr + 10, drawYears: 20 } };
  const r = T.rothRun(it, flat, Object.assign({}, prof, { bracketIndex: idx }));
  const want = f * (TP.tax((500000) / f - 32200, 'mfj') - TP.tax(400000 / f - 32200, 'mfj'));
  ok(near(r.roth.paid, want, 0.01), 'brackets: a conversion in a later year is priced on indexed brackets and deduction');
  ok(r.roth.paid < T.rothRun(it, flat, prof).roth.paid, 'brackets: indexing lowers the tax on the same nominal income');
  T.S.local.retireIncome = 90000; T.S.local.bracketIndex = 0.02;
  const inc = T.incomeMap({});   // no Retirement loaded: no stop year, W-2 runs on
  ok(near(inc[Y + 1], 400000 * 1.03, 1e-6), 'income: W-2 grows at its own rate with no stop year');
  T.S.local.retireIncome = 0; T.S.local.bracketIndex = 0.025;
  T.S.plan.length = 0; T.addStrategy('hm');
  const h = textOf(html());
  ok(/Taxable income after you stop/.test(h) && /keep 2026 brackets in every year/.test(h) && /index the 2026 brackets/.test(h), 'brackets: the methodology says which models index and which do not');
  T.S.plan.length = 0;
}

/* A new book starts a new plan. */
{
  const A = [{}], B = [{}];
  T.reset(); html(A); T.addStrategy('hm');
  ok(T.S.plan.length === 1, 'book: a strategy added for book A');
  html(A);
  ok(T.S.plan.length === 1, 'book: re-drawing the same book keeps it');
  html(B);
  ok(T.S.plan.length === 0, 'book: a different book starts empty');
}

/* No en or em dash anywhere a reader can see, or in the source. */
{
  T.S.plan.length = 0; ['hm', 'wfh', 'roth', 'costseg', 'energy', 'solar'].forEach((id) => T.addStrategy(id));
  const h = html();
  ok(!/[\u2013\u2014]|&[mn]dash;/.test(h), 'dashes: none in the rendered tab with every strategy');
  ok(SRC.every(([, s]) => !/[\u2013\u2014]|\\u201[34]/.test(s)), 'dashes: none in taxes-ui.js or taxplay.js');
  ok(!/NaN|Infinity|undefined/.test(textOf(h)), 'render: every strategy together prints no NaN');
  T.S.plan.length = 0;
}

/* Low: large values get B and T, and -0 is never printed. */
ok(T.short(2.5e12) === '$2.50T' && T.short(3.4e9) === '$3.40B' && T.short(-0.2) === '$0', 'format: B and T steps, no "-$0"');
ok(T.pct(-0.0001) === '0.0%', 'format: no "-0.0%"');

/* Focus and inline messages in a real DOM (jsdom). */
async function domChecks() {
  const cands = [process.env.JSDOM_DIR, path.join(dir, 'node_modules'), path.join(dir, '..', '..', '..', 'node_modules'), 'C:/Users/jocel/OneDrive/Personal/6_APEX/node_modules'].filter(Boolean);
  let JSDOM = null;
  for (const c of cands) { try { JSDOM = createRequire(path.join(c, 'x.js'))('jsdom').JSDOM; break; } catch (e) { /* next */ } }
  if (!JSDOM) { console.log('jsdom not found: focus and inline-message checks skipped (set JSDOM_DIR)'); return; }
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.HTMLElement.prototype.scrollIntoView = function () {};
  for (const [f, s] of SRC) w.eval(s);
  const X = w.TaxStrategies, host = w.document.getElementById('host'), c = { book: [] };
  const tick = () => new Promise((r) => setTimeout(r, 5));
  X.render(host, c);
  host.querySelector('[data-txlib]').click();
  ok(w.document.activeElement && w.document.activeElement.getAttribute('data-txadd') === 'hm', 'DOM: "Add a strategy" moves focus to the library');
  host.querySelector('.tx-empty [data-txadd="hm"]').click();
  ok(X.S.plan.length === 1, 'DOM: "Try Heavy Machinery" adds the example');
  const u = X.S.plan[0].uid;
  ok(w.document.activeElement && w.document.activeElement.getAttribute('data-txs') === u + '.startYear', 'DOM: focus lands on the new strategy\u2019s first field');
  let el = host.querySelector('[data-tx="' + u + '.down"]');
  el.focus(); el.value = '150'; el.dispatchEvent(new w.Event('change'));
  await tick();
  ok(X.S.plan[0].inputs.down === 1, 'DOM: a 150% down payment is stored as 100%');
  const msg = host.querySelector('[data-tx="' + u + '.down"]').closest('label').querySelector('.tx-msg');
  ok(msg && /between 0% and 100%/.test(msg.textContent), 'DOM: the message shows under the field');
  ok(w.document.activeElement === host.querySelector('[data-tx="' + u + '.down"]'), 'DOM: focus stays on the edited field after the re-draw');
  /* Tab to the next field: the change fires, focus moves, then the re-draw keeps the new field focused */
  el = host.querySelector('[data-tx="' + u + '.price"]');
  el.focus(); el.value = '600000'; el.dispatchEvent(new w.Event('change'));
  host.querySelector('[data-tx="' + u + '.lease"]').focus();
  await tick();
  ok(w.document.activeElement === host.querySelector('[data-tx="' + u + '.lease"]') && X.S.plan[0].inputs.price === 600000, 'DOM: tabbing on keeps focus on the next field');
  el = host.querySelector('[data-tx="' + u + '.down"]');
  el.focus(); el.value = '20'; el.dispatchEvent(new w.Event('change'));
  await tick();
  ok(!host.querySelector('[data-tx="' + u + '.down"]').closest('label').querySelector('.tx-msg'), 'DOM: a valid entry clears the message');
  el = host.querySelector('[data-txp="discount"]');
  el.focus(); el.value = '40'; el.dispatchEvent(new w.Event('change'));
  await tick();
  ok(X.S.local.discount === 0.15 && /between 0% and 15%/.test(host.textContent), 'DOM: the discount rate is bounded too');
  host.querySelector('[data-txdel="' + u + '"]').click();
  ok(X.S.plan.length === 0 && /Your Tax Plan Is Empty/.test(host.textContent), 'DOM: removing the last strategy brings back the empty state');
  w.close();
}
await domChecks();

console.log('taxes2: ' + checks + ' checks, ' + fails + ' failures');
process.exit(fails ? 1 : 0);
