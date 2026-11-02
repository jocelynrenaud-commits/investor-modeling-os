// Parity: the ported tax math must equal the published tools' own runModel, year by year.
// Runs the ORIGINAL page code (from the saved live pages) in a sandbox beside taxplay.js.
import fs from 'node:fs'; import vm from 'node:vm'; import path from 'node:path'; import { createRequire } from 'node:module';
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const require = createRequire(import.meta.url);
const TP = require(path.join(here, '..', 'taxplay.js'));
function original(file, startMarker, endFn) {
  const html = fs.readFileSync(path.join(here, 'fixtures', file), 'utf8');
  const s = html.indexOf(startMarker), e = html.indexOf('return{inp,years', html.indexOf('function ' + endFn + '(inp)'));
  let code = html.slice(s, html.indexOf(String.fromCharCode(10) + '}', e) + 2);
  code = code.split('\n').filter((l) => !/^(buildIncome|buildDepSched)\(\);/.test(l.trim())).join('\n');
  const ctx = { document: { getElementById: () => null }, Math, console };
  vm.createContext(ctx); vm.runInContext(code + '\n;this.__run=' + endFn + ';', ctx);
  return ctx.__run;
}
let fails = 0, checks = 0;
function cmp(name, a, b) {
  a.years.forEach((ra, i) => { const rb = b.years[i];
    for (const k of Object.keys(ra)) { if (typeof ra[k] !== 'number') continue; checks++;
      if (Math.abs(ra[k] - rb[k]) > 1e-6) { fails++; if (fails < 10) console.log('MISMATCH', name, 'y' + (i + 1), k, ra[k], rb[k]); } } });
}
const incomes = [[400000, 410000, 420000, 430000, 440000, 450000, 460000, 470000, 480000, 490000], [180000, 0, 0, 250000, 900000, 0, 120000, 0, 0, 0], new Array(10).fill(0)];
const wfh = original('gc-wfh-tax-model-v1.2.html', 'const BR=', 'runModel');
for (const [i, w2] of incomes.entries()) for (const extra of [{}, { depMethod: 'macrs' }, { paydown: true }, { status: 'single', exit: 4, residual: 600000 }]) {
  const inp = Object.assign({}, TP.KINDS.wfh.defaults, extra, { w2 });
  cmp('wfh#' + i + JSON.stringify(extra), wfh(JSON.parse(JSON.stringify(inp))), TP.runWFH(inp));
}
const hm = original('gc-hm-tax-model-v1.0.html', 'const BR=', 'runModel');
for (const [i, w2] of incomes.entries()) for (const extra of [{}, { depMethod: 'macrs' }, { status: 'single', exit: 3, buybackPct: 1.2 }]) {
  const inp = Object.assign({}, TP.KINDS.hm.defaults, extra, { w2: w2.slice(0, 8) });
  cmp('hm#' + i + JSON.stringify(extra), hm(JSON.parse(JSON.stringify(inp))), TP.runHM(inp));
}
// Stacking: two identical plays in the same year must save less in total than 2x one play.
const inc = {}; for (let y = 2026; y < 2040; y++) inc[y] = 450000;
const one = TP.stack([{ kind: 'hm', startYear: 2026 }], inc).runs[0];
const two = TP.stack([{ kind: 'hm', startYear: 2026 }, { kind: 'hm', startYear: 2026 }], inc).runs;
const s1 = TP.summary(one).y1TaxSaved, s2 = two.reduce((a, r) => a + TP.summary(r).y1TaxSaved, 0);
checks++; if (!(s2 < 2 * s1 - 1)) { fails++; console.log('STACK FAIL', s1, s2); }
console.log(`taxplay parity: ${checks} checks, ${fails} failures` + `  (one HM play saves ${Math.round(s1)} in Y1; two stacked save ${Math.round(s2)})`);
process.exit(fails ? 1 : 0);
