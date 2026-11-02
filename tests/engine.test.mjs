// Engine regression suite (2026-10-31 hardening).  node tests/engine.test.mjs
// Covers: per-deal random streams (audit M-02), percent fields (QA H5), funded / uncalled
// clamps (QA H6), the terms.ltv alias, the loan-shaped IRR flag (audit M-26) and the other
// input warnings buildBook now raises. The calendar is pinned to 2026-10-31 so the results
// do not depend on the day the suite runs.
import fs from 'fs'; import vm from 'vm'; import path from 'path'; import { fileURLToPath } from 'url';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = { console, Math, Date, process: { env: { PD_AS_OF: '2026-10-31' } } };
ctx.globalThis = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(dir, 'engine.js'), 'utf8') + ';globalThis.Engine=Engine;', ctx);
const E = ctx.Engine;

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL', m); } };
const near = (a, b, t) => Math.abs(a - b) <= t;

// The example book, enriched the way app.js enrich() does it.
const idx = JSON.parse(fs.readFileSync(path.join(dir, 'deals', 'index.json'), 'utf8'));
const enrich = (rows) => rows.map((r) => {
  const hit = E.matchDeal(r.name, idx);
  return hit ? E.applyDealFile(r, JSON.parse(fs.readFileSync(path.join(dir, 'deals', hit.slug + '.json'), 'utf8'))) : r;
});
const rows = enrich(JSON.parse(fs.readFileSync(path.join(dir, 'example-book.json'), 'utf8')));
const book = E.buildBook(rows);
ok(book.length === 12, 'example book has 12 positions: ' + book.length);
ok(E.calendarNow().year === 2026, 'calendar pinned to 2026');

/* ── M-02: each deal has its own stream ─────────────────────────────────── */
{
  const P = 400;
  const tiny = E.buildBook([{ name: 'Tiny test deal', commitment: 1, funded: 1, yearFunded: 2026, assetClass: 'VC', moic: 3, hold: 4 }]);
  ok(tiny.length === 1, 'tiny deal builds');
  // (a) Per deal, per path: the draws (timing, outcome, multiple) of every existing deal are
  // identical with and without the extra deal, wherever it is inserted.
  let drawDiffs = 0, flowDiffs = 0;
  const withEnd = book.concat(tiny), withFront = tiny.concat(book);
  for (let p = 0; p < P; p++) {
    const a = E.pathDraws(book, p), b = E.pathDraws(withEnd, p), c = E.pathDraws(withFront, p);
    for (let i = 0; i < book.length; i++) {
      const same = (x, y) => x.off === y.off && x.m === y.m && x.drawn.v === y.drawn.v && x.drawn.abs === y.drawn.abs;
      if (!same(a[i], b[i]) || !same(a[i], c[i + 1])) drawDiffs++;
      // and the deal's own signed cash flow on that path, built from those draws
      const fa = JSON.stringify(E.dealStream(book[i], a[i].off, a[i].m));
      const fb = JSON.stringify(E.dealStream(withEnd[i], b[i].off, b[i].m));
      if (fa !== fb) flowDiffs++;
    }
  }
  ok(drawDiffs === 0, 'adding a $1 deal leaves every other deal\'s draws identical (' + drawDiffs + ' differ)');
  ok(flowDiffs === 0, 'adding a $1 deal leaves every other deal\'s per-path cash flows identical (' + flowDiffs + ' differ)');

  // (b) The book's per-path cash is additive: book + tiny = book alone + tiny alone, path by
  // path and year by year. Under the old single stream 399 of 400 paths moved.
  const sA = E.simulate(book, { paths: P, capturePaths: true });
  const sB = E.simulate(withEnd, { paths: P, capturePaths: true });
  const sT = E.simulate(tiny, { paths: P, capturePaths: true });
  ok(sA.years.join() === sB.years.join(), 'same calendar with the tiny deal');
  let worst = 0;
  for (let p = 0; p < P; p++) {
    for (let yi = 0; yi < sA.years.length; yi++) {
      const ty = sT.years.indexOf(sA.years[yi]);
      const t = ty >= 0 ? sT.pathRows[p][ty] : 0;
      worst = Math.max(worst, Math.abs(sB.pathRows[p][yi] - sA.pathRows[p][yi] - t));
    }
  }
  ok(worst < 1e-6, 'per-path cash: (book + tiny) - book = tiny alone, worst gap ' + worst);
  let moved = 0;
  for (let p = 0; p < P; p++) {
    const tot = (r) => r.reduce((x, v) => x + v, 0);
    if (Math.abs(tot(sB.pathRows[p]) - tot(sA.pathRows[p])) > 100) moved++;
  }
  ok(moved === 0, 'no path of the existing book moves by more than $100 after adding a $1 deal (' + moved + ')');

  // (c) Order does not matter: the reversed book gives the same futures.
  const sR = E.simulate(book.slice().reverse(), { paths: P, capturePaths: true });
  let orderGap = 0;
  for (let p = 0; p < P; p++) for (let yi = 0; yi < sA.years.length; yi++) orderGap = Math.max(orderGap, Math.abs(sR.pathRows[p][yi] - sA.pathRows[p][yi]));
  ok(orderGap < 1e-6, 'reordering the book changes no path: ' + orderGap);

  // (d) Removing a deal leaves the others alone too.
  const drop = book.slice(1);
  let dropDiffs = 0;
  for (let p = 0; p < P; p++) {
    const a = E.pathDraws(book, p), b = E.pathDraws(drop, p);
    for (let i = 1; i < book.length; i++) if (a[i].m !== b[i - 1].m || a[i].off !== b[i - 1].off) dropDiffs++;
  }
  ok(dropDiffs === 0, 'removing a deal leaves the others\' draws identical');
}

/* ── Determinism and the seed ───────────────────────────────────────────── */
{
  const a = E.simulate(book, { paths: 1000 }), b = E.simulate(book, { paths: 1000 });
  ok(a.totals.p10 === b.totals.p10 && a.totals.p50 === b.totals.p50 && a.totals.p90 === b.totals.p90, 'two runs agree exactly');
  ok(E.CFG.seed === 20260922, 'base seed unchanged');
  const c = E.simulate(book, { paths: 1000, seed: E.CFG.seed }), d = E.simulate(book, { paths: 1000, seed: 7 });
  ok(c.totals.p50 === a.totals.p50, 'opts.seed defaults to CFG.seed');
  ok(d.totals.p50 !== a.totals.p50, 'a different seed gives different futures');
  ok(a.ties, 'cumulative table ties to the totals');
  // Streams are distinct across keys and paths, and stable for one (key, path).
  const r1 = E.streamFor('aerolane', 3)(), r2 = E.streamFor('aerolane', 3)(), r3 = E.streamFor('aerolane', 4)(), r4 = E.streamFor('stix', 3)();
  ok(r1 === r2 && r1 !== r3 && r1 !== r4, 'streamFor is stable per (key, path) and differs across them');
  // Uniformity sanity: the first draw of 20,000 streams averages one half.
  let s = 0; for (let p = 0; p < 20000; p++) s += E.streamFor('k', p)();
  ok(near(s / 20000, 0.5, 0.01), 'first draws of the streams are uniform on average: ' + (s / 20000).toFixed(4));
}

/* ── pathDraws is what simulate() uses (the replay contract for markets.js) ── */
{
  const P = 50;
  const sim = E.simulate(book, { paths: P, capturePaths: true });
  let worst = 0;
  for (let p = 0; p < P; p++) {
    const dr = E.pathDraws(book, p);
    const yr = {}; for (const y of sim.years) yr[y] = 0;
    book.forEach((b, i) => {
      const m = dr[i].m;
      if (b.coupon > 0) { const pf = E.prefFactor(b, m); if (pf > 0) for (let k = 1; k <= b.hold; k++) { const y = b.fy + k; if (yr[y] != null) yr[y] += E.prefInYear(b, k) * pf; } }
      const cash = b.commitment * m;
      if (cash > 0) for (const [y, w] of E.exitPlan(b, dr[i].off)) if (yr[y] != null) yr[y] += cash * w;
    });
    sim.years.forEach((y, yi) => { worst = Math.max(worst, Math.abs(yr[y] - sim.pathRows[p][yi])); });
  }
  ok(worst < 1e-6, 'a replay built on Engine.pathDraws reproduces simulate() path for path: ' + worst);
  // Shared fate: two tranches of one deal draw once per path.
  const two = E.buildBook([{ name: 'Same Co', commitment: 50000, funded: 50000, yearFunded: 2025, moic: 4 },
                           { name: 'Same Co', commitment: 25000, funded: 25000, yearFunded: 2026, moic: 4 }]);
  let split = 0;
  for (let p = 0; p < 200; p++) { const d = E.pathDraws(two, p); if (d[0].m !== d[1].m || d[0].off !== d[1].off) split++; }
  ok(two[0].groupKey === two[1].groupKey && split === 0, 'tranches of one deal share one fate on every path');
}

/* ── H5: percent fields ─────────────────────────────────────────────────── */
{
  const one = (extra) => E.buildBook([Object.assign({ name: 'P', commitment: 100000, funded: 100000, yearFunded: 2025, hold: 5 }, extra)])[0];
  const c8 = one({ coupon: 8 });
  ok(near(c8.coupon, 0.08, 1e-12), 'a bare 8 in Coupon % is 8%: ' + c8.coupon);
  ok(c8.warnings.length === 1 && /read as 8%/.test(c8.warnings[0]), 'and it says so: ' + c8.warnings.join(' | '));
  ok(near(one({ coupon: '8' }).coupon, 0.08, 1e-12) && one({ coupon: '8' }).warnings.length === 1, 'the text "8" is 8%, with a warning');
  ok(near(one({ coupon: '8%' }).coupon, 0.08, 1e-12) && one({ coupon: '8%' }).warnings.length === 0, '"8%" is 8%, no warning');
  ok(near(one({ coupon: 0.08 }).coupon, 0.08, 1e-12) && one({ coupon: 0.08 }).warnings.length === 0, '0.08 is 8%, no warning');
  ok(near(one({ coupon: '0.5%' }).coupon, 0.005, 1e-12), '"0.5%" is half a percent');
  ok(one({ coupon: 1 }).coupon === 1 && one({ coupon: 1 }).warnings.length === 0, 'a bare 1 is a decimal (100%)');
  ok(near(one({ coupon: '150%' }).coupon, 1.5, 1e-12), '"150%" is still 150%');
  ok(near(one({ coupon: 12.5 }).coupon, 0.125, 1e-12), 'a bare 12.5 is 12.5%');
  const neg = one({ coupon: -5 });
  ok(neg.coupon === 0 && neg.kind === 'venture' && neg.warnings.length >= 1, 'a negative coupon is 0, with a warning');
  // the end-to-end symptom from the QA report: $100k at a bare 8 no longer simulates millions
  const s8 = E.simulate([c8], { paths: 2000 });
  ok(s8.totals.p50 < 300000, 'a $100k position at a bare 8 no longer returns millions: median ' + Math.round(s8.totals.p50));
  ok(near(one({ ltv: 65 }).ltv, 0.65, 1e-12), 'a bare 65 LTV is 65%');
  ok(near(one({ uncalledYieldPct: 6.5 }).uncalledYieldPct, 0.065, 1e-12), 'a bare 6.5 uncalled yield is 6.5%');
  ok(near(one({ callPctPerYear: 20 }).callPctPerYear, 0.2, 1e-12), 'a bare 20 call pace is 20%');
  ok(E.pctField(8, 'x', 'x', null) === 0.08 && E.pctField('', 'x', 'x', null) === 0, 'pctField is exported and quiet without a reporter');
}

/* ── H6: funded and uncalled kept in range ──────────────────────────────── */
{
  const sink = [];
  const b = E.buildBook([
    { name: 'Neg funded', commitment: 100000, funded: -20000, yearFunded: 2025, moic: 2 },
    { name: 'Big uncalled', commitment: 100000, funded: 0, uncalled: 250000, yearFunded: 2025, moic: 2 },
    { name: 'Over funded', commitment: 100000, funded: 150000, yearFunded: 2025, moic: 2 },
    { name: 'Clean', commitment: 100000, funded: 40000, uncalled: 60000, yearFunded: 2025, moic: 2 },
    { name: 'Neg uncalled', commitment: 100000, uncalled: -5, yearFunded: 2025, moic: 2 },
  ], { warnings: sink });
  const by = Object.fromEntries(b.map((x) => [x.name, x]));
  ok(by['Neg funded'].funded === 0 && by['Neg funded'].uncalled === 100000, 'negative funded reads as 0, uncalled is the rest');
  ok(by['Neg funded'].warnings.some((w) => /negative/.test(w)), 'negative funded is reported');
  ok(by['Big uncalled'].uncalled === 100000 && by['Big uncalled'].warnings.some((w) => /more than/.test(w)), 'uncalled above the commitment is capped and reported');
  ok(by['Over funded'].funded === 100000 && by['Over funded'].uncalled === 0 && by['Over funded'].warnings.length >= 1, 'funded above the commitment is capped and reported');
  ok(by['Clean'].warnings.length === 0, 'a clean row raises nothing');
  ok(by['Neg uncalled'].uncalled === 0 && by['Neg uncalled'].funded === 100000 && by['Neg uncalled'].warnings.length >= 1, 'negative uncalled reads as 0 and is reported');
  ok(b.every((x) => x.funded >= 0 && x.funded <= x.commitment && x.uncalled >= 0 && x.uncalled <= x.commitment - x.funded + 1e-6), 'invariant: 0 <= funded <= commitment, 0 <= uncalled <= commitment - funded');
  const s = E.simulate(b, { paths: 200 });
  ok(s.totals.uncalled <= s.totals.committed - s.totals.funded + 1e-6, 'still callable never exceeds committed less funded');
  ok(sink.length === E.bookWarnings(b).length && sink.every((w) => w.name && w.field && w.msg), 'warnings reach opts.warnings with name, field and message');
  ok(E.bookWarnings(b).every((w) => /^[^:]+: /.test(w)), 'bookWarnings lines read "Name: message"');
}

/* ── Other input warnings ───────────────────────────────────────────────── */
{
  const one = (extra) => E.buildBook([Object.assign({ name: 'Q', commitment: 100000, funded: 100000, yearFunded: 2025 }, extra)])[0];
  const h = one({ hold: -5, moic: 2 });
  ok(h.hold === 10 && h.warnings.some((w) => /hold/.test(w)), 'a negative hold falls back to 10 years, reported');
  const m = one({ moic: -2, hold: 5 });
  ok(m.moic === 5 && m.moicAssumed && m.warnings.some((w) => /multiple/.test(w)), 'a negative multiple is ignored and reported');
  const x = one({ moic: 2, exitLikely: 2020 });
  ok(x.warnings.some((w) => /already passed/.test(w)), 'a likely exit already gone is reported');
  ok(E.exitPlan(x, 0)[0][0] === 2026, 'and still lands this year');
  ok(one({ moic: 2, yearFunded: 1850 }).warnings.some((w) => /mistyped/.test(w)), 'an implausible year funded is reported');
  ok(one({ moic: 2, yearFunded: '' }).fy === 2026, 'a blank year funded is this calendar year');
  ok(E.bookWarnings(book).length === 0, 'the example book raises no input warnings: ' + E.bookWarnings(book).join(' | '));
}

/* ── Deal file: terms.ltv alias ─────────────────────────────────────────── */
{
  const row = { name: 'Prop', commitment: 100000 };
  ok(E.applyDealFile(row, { slug: 'x', terms: { ltv: 0.72 } }).ltv === 0.72, 'terms.ltv is read');
  ok(E.applyDealFile(row, { slug: 'x', terms: { ltvPct: 0.6, ltv: 0.72 } }).ltv === 0.6, 'terms.ltvPct wins over terms.ltv');
  ok(E.applyDealFile({ name: 'Prop', commitment: 1, ltv: 0.5 }, { slug: 'x', terms: { ltv: 0.72 } }).ltv === 0.5, 'a typed LTV still wins');
  ok(E.applyDealFile(row, { slug: 'x', terms: {} }).ltv === undefined, 'no LTV in the file leaves it blank');
  const acfe = JSON.parse(fs.readFileSync(path.join(dir, 'deals', 'asilia-credit-fund-evergreen.json'), 'utf8'));
  ok(E.applyDealFile({ name: 'A', commitment: 1 }, acfe).ltv === 0.4, 'the Asilia Evergreen file\'s LTV now arrives: 0.4');
  // the RE table at a typed 80% LTV carries the high zero weight
  const re = E.buildBook([{ name: 'RE', commitment: 100000, funded: 100000, yearFunded: 2025, assetClass: 'Real Estate', moic: 2, ltv: 80 }])[0];
  ok(near(re.branches[0][0], E.CFG.reLtv.zeroHigh, 1e-12), 'a bare 80 LTV moves the real estate table to its high-leverage zero weight');
  // overrides read the typed rate with the same rule
  const ov = E.applyDealFile({ name: 'C', commitment: 1, coupon: 12 }, { slug: 'c', terms: { couponPct: 0.12 } });
  ok(!ov._ovr.some((o) => o.key === 'coupon'), 'a bare 12 against a file\'s 0.12 is not an override');
  const ov2 = E.applyDealFile({ name: 'C', commitment: 1, coupon: 10 }, { slug: 'c', terms: { couponPct: 0.12 } });
  ok(ov2._ovr.some((o) => o.key === 'coupon' && near(o.yours, 0.10, 1e-12)), 'a bare 10 against 0.12 is an override, shown as 10%');
}

/* ── IRR flags ──────────────────────────────────────────────────────────── */
{
  const a = E.irrOf([[0, 100], [1, -110]], 0);
  ok(a.r === null && a.flag === 'loan-shaped', 'money back first, money in later is loan-shaped, not a total loss: ' + JSON.stringify(a));
  const b = E.irrOf([[0, -100], [1, 110]], 0);
  ok(b.flag === 'ok' && near(b.r, 0.10, 1e-6), 'a plain 10% stream solves');
  const c = E.irrOf([[0, -100], [1, 0]], 0);
  ok(c.r === -1 && c.flag === 'total-loss', 'nothing back is a total loss');
  const d = E.irrOf([[0, -100], [1, 5], [2, -10]], 0);
  ok(d.r === -1 && d.flag === 'total-loss', 'money in first and ending with money out is still a total loss');
  ok(E.irrOf([[0, 100]], 0).flag === 'no-contribution', 'no money in has no IRR');
}

console.log('engine: ' + checks + ' checks, ' + fails + ' failures');
process.exit(fails ? 1 : 0);
