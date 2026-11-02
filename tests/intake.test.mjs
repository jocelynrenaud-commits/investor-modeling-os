// Intake regression suite (2026-10-31 hardening).  node tests/intake.test.mjs
// Loads engine.js and app.js into a vm with a small stub DOM (no jsdom needed) and drives the
// real upload path: FileReader -> XLSX -> readWorkbook -> load -> enrich -> validate -> render.
// Covers QA C1 (every sheet reaches the plugins, whatever its order), the H5/H6 warnings on
// screen, a failed upload changing nothing (M2), the deal-index failure not being cached (M10),
// escaping, the template link, and the no-em-dash rule for app.js.
import fs from 'fs'; import vm from 'vm'; import path from 'path'; import { fileURLToPath } from 'url';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL', m); } };

/* ── a stub DOM: just enough for app.js to boot, load and render ─────────── */
function makeEl(tag) {
  const attrs = {};
  const el = {
    tagName: String(tag || 'div').toUpperCase(), nodeType: 1, style: {}, children: [], innerHTML: '', textContent: '',
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); }, toggle(c) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } },
    setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return k in attrs ? attrs[k] : null; },
    hasAttribute(k) { return k in attrs; }, removeAttribute(k) { delete attrs[k]; },
    addEventListener() {}, removeEventListener() {}, appendChild(c) { el.children.push(c); return c; },
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
    scrollIntoView() {}, click() { if (typeof el.onclick === 'function') el.onclick({ target: el }); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 400, right: 800, bottom: 400 }; },
    offsetWidth: 800, offsetHeight: 400, clientWidth: 800,
  };
  return el;
}
function boot(opts = {}) {
  const els = {};
  const document = {
    readyState: 'complete',
    body: makeEl('body'),
    createElement: makeEl, createElementNS: (ns, t) => makeEl(t),
    querySelector: (s) => (els[s] = els[s] || makeEl('div')),
    querySelectorAll: () => [],
    getElementById: (id) => (els['#' + id] = els['#' + id] || makeEl('div')),
    addEventListener() {},
  };
  const events = [];
  const fetchLog = [];
  const ctx = {
    console, Math, Date, JSON, Promise, setTimeout, clearTimeout, Intl,
    process: { env: { PD_AS_OF: '2026-10-31' } },
    document, innerWidth: 1200, innerHeight: 800,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: (f) => setTimeout(f, 0),
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    dispatchEvent: (e) => { events.push(e); return true; },
    addEventListener() {},
    fetch: async (u) => {
      const p = String(u).split('?')[0];
      fetchLog.push(p);
      if (opts.fetchFail && opts.fetchFail(p)) throw new TypeError('Failed to fetch');
      const f = path.join(dir, p);
      if (!fs.existsSync(f)) return { ok: false, status: 404, json: async () => { throw new SyntaxError('Unexpected token <'); } };
      const body = fs.readFileSync(f, 'utf8');
      return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
    },
    FileReader: class { readAsArrayBuffer() { setTimeout(() => this.onload({ target: { result: new ArrayBuffer(1) } }), 0); } },
    XLSX: { read: () => ctx.__nextWB, utils: { sheet_to_json: (ws) => ws.aoa } },
    PlanIncludes: { remembered: [], remember(c) { this.remembered.push(c); } },
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(dir, 'engine.js'), 'utf8') + ';globalThis.Engine=Engine;', ctx, { filename: 'engine.js' });
  vm.runInContext(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
  const $ = (s) => document.querySelector(s);
  const settle = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 2)); };
  const upload = async (sheets) => {
    ctx.__nextWB = { SheetNames: Object.keys(sheets), Sheets: Object.fromEntries(Object.entries(sheets).map(([k, v]) => [k, { aoa: v }])) };
    $('#file').onchange({ target: { files: [{ name: 't.xlsx' }], value: 't.xlsx' } });
    await settle();
  };
  return { ctx, $, upload, settle, events, fetchLog };
}

/* ── the shipped template's sheet order, with a filled You and Balances tab ── */
const HDR = ['Deal name', 'Account', 'Asset class', 'Commitment', 'Funded to date', 'Uncalled', 'Year funded', 'Hold', 'Coupon %', 'Sponsor MOIC'];
const positions = [['TRACKER v1.8'], HDR,
  ['Alpha Venture', 'Self-Directed IRA', 'VC', 100000, 100000, 0, 2024, 6, '', 4],
  ['Beta Credit', 'Private Deals', 'Private Credit', 50000, 50000, 0, 2025, 5, '9%', '']];
const template = {
  'Read me': [['How to use this tracker'], ['Fill in the Positions tab.']],
  'Positions': positions,
  'What you get back': [['Nothing to fill in here']],
  'You': [['Field', 'Value'], ['Birth year', 1980], ['Stop working', 2040], ['Spending', 120000]],
  'Balances': [['Label', 'Account', 'Account type', 'Value'], ['Fidelity 401k', 'IRA', 'Pre-tax', 800000]],
  'Holdings': [['Symbol', 'Quantity', 'Price'], ['VTI', 10, 300]],
};

// 1. readWorkbook (pure): every sheet is kept whatever its order (QA C1)
{
  const H = boot();
  const AI = H.ctx.AppIntake;
  ok(AI && typeof AI.readWorkbook === 'function', 'AppIntake test hook is exposed');
  H.ctx.__nextWB = null;
  const wb = { SheetNames: Object.keys(template), Sheets: Object.fromEntries(Object.entries(template).map(([k, v]) => [k, { aoa: v }])) };
  const r = AI.readWorkbook(wb);
  ok(r.rows && r.rows.length === 2, 'positions found on the second sheet: ' + (r.rows && r.rows.length));
  ok(r.sheet === 'Positions', 'positions sheet named');
  ok(Object.keys(r.sheets).join('|') === Object.keys(template).join('|'), 'every sheet is kept, in workbook order: ' + Object.keys(r.sheets).join('|'));
  ok(r.sheets.You && r.sheets.You[1][1] === 1980 && r.sheets.Balances[1][3] === 800000, 'You and Balances after Positions arrive intact');
  // Positions LAST also works, and a header-only sheet before it does not win
  const order2 = { 'Empty positions': [HDR], 'Balances': template.Balances, 'Positions': positions };
  const wb2 = { SheetNames: Object.keys(order2), Sheets: Object.fromEntries(Object.entries(order2).map(([k, v]) => [k, { aoa: v }])) };
  const r2 = AI.readWorkbook(wb2);
  ok(r2.sheet === 'Positions' && Object.keys(r2.sheets).length === 3, 'a header-only sheet is skipped, and every sheet is still kept');
  const r3 = AI.readWorkbook({ SheetNames: ['Notes'], Sheets: { Notes: { aoa: [['hello']] } } });
  ok(r3.error && !r3.rows && r3.sheets.Notes, 'no positions anywhere returns an error and still the sheets');
}

// 2. The real upload path: plugins get every sheet
const H = boot();
{
  await H.upload(template);
  const rem = H.ctx.PlanIncludes.remembered;
  ok(rem.length === 1, 'PlanIncludes.remember is told about the new book on load (QA H2): ' + rem.length);
  const ctxSheets = rem.length ? rem[0].sheets : {};
  ok(['Read me', 'Positions', 'What you get back', 'You', 'Balances', 'Holdings'].every((k) => ctxSheets[k]), 'ctx.sheets carries every sheet, including those after Positions: ' + Object.keys(ctxSheets).join('|'));
  ok(rem.length && rem[0].book.length === 2, 'ctx.book is the uploaded book');
  ok(H.events.some((e) => e.type === 'privatedeals:book' && e.detail && e.detail.sheets && e.detail.sheets.Balances), 'privatedeals:book event carries the sheets');
  ok(!/Could not/.test(H.$('#intakeErr').innerHTML), 'a clean upload raises no intake error');
}

// 3. H5 and H6 warnings reach the screen
{
  const bad = [HDR,
    ['Plain Eight', '', 'Private Credit', 100000, 100000, 0, 2025, 5, 8, ''],
    ['Neg Funded', '', 'VC', 100000, -20000, '', 2025, 6, '', 3],
    ['Big Uncalled', '', 'VC', 100000, 0, 250000, 2025, 6, '', 3],
    ['<img src=x onerror=alert(1)>', '', 'VC', 100000, 100000, 0, 2025, 6, 7, 3]];
  await H.upload({ Positions: bad });
  const msg = H.$('#intakeErr').innerHTML;
  ok(/Plain Eight: a preferred return of 8 was read as 8%/.test(msg), 'a bare 8 coupon is reported on screen');
  ok(/Neg Funded: funded to date of -\$20,000 is negative/.test(msg), 'negative funded is reported on screen');
  ok(/Big Uncalled: uncalled of \$250,000 is more than the \$100,000 left to call/.test(msg), 'uncalled above the commitment is reported on screen');
  ok(!/<img/.test(msg) && /&lt;img/.test(msg), 'a hostile deal name is escaped in the problem list');
  const book = H.ctx.PlanIncludes.remembered.slice(-1)[0].book;
  const pe = book.find((b) => b.name === 'Plain Eight');
  ok(pe && Math.abs(pe.coupon - 0.08) < 1e-12, 'the book the tabs render runs the bare 8 as 8%');
  ok(book.every((b) => b.funded >= 0 && b.uncalled <= b.commitment - b.funded + 1e-6), 'the book the tabs render has funded and uncalled in range');
  ok(/worth fixing/.test(msg), 'shown in the existing "worth fixing" panel');
}

// 4. A failed upload changes nothing (QA M2) and links the template, not "the repository"
{
  const before = H.ctx.PlanIncludes.remembered.length;
  await H.upload({ Notes: [['nothing here'], ['at all']] });
  const msg = H.$('#intakeErr').innerHTML;
  ok(/Could not find your positions/.test(msg), 'a file with no positions says so');
  ok(/href="tracker-template\.xlsx"/.test(msg) && /download/.test(msg), 'and links the downloadable template');
  ok(!/repository/i.test(msg), 'and no longer mentions a repository');
  ok(H.ctx.PlanIncludes.remembered.length === before, 'and the book and sheets are left as they were');
}

// 5. A deal index that fails to load is reported, and is not cached (QA M10)
{
  let fail = true;
  const F = boot({ fetchFail: (p) => fail && p === 'deals/index.json' });
  await F.upload({ Positions: positions });
  ok(/Could not load the shared deal list/.test(F.$('#intakeErr').innerHTML), 'an index failure is said plainly');
  ok(!/That is fine, and it is normal/.test(F.$('#intakeErr').innerHTML), 'and is not called normal');
  fail = false;
  const n0 = F.fetchLog.filter((p) => p === 'deals/index.json').length;
  await F.upload({ Positions: positions });
  const n1 = F.fetchLog.filter((p) => p === 'deals/index.json').length;
  ok(n1 === n0 + 1, 'the next load retries the index');
  ok(!/Could not load the shared deal list/.test(F.$('#intakeErr').innerHTML), 'and the note goes once it loads');
}

// 6. The example book loads through the same door with no input warnings
{
  const D = boot();
  D.$('#demo').onclick();
  await D.settle(60);
  const rem = D.ctx.PlanIncludes.remembered;
  ok(rem.length === 1 && rem[0].book.length === 12, 'the example book loads 12 positions');
  ok(rem.length && Object.keys(rem[0].sheets).length === 0, 'the demo hands plugins no sheets');
  ok(!/was read as|is negative|left to call/.test(D.$('#intakeErr').innerHTML), 'and raises no input warnings');
  ok(D.$('#tabbody').innerHTML.length > 1000, 'and the Deals tab renders');
  ok(!/\u2014/.test(D.$('#tabbody').innerHTML), 'the rendered Deals tab has no em dash');
}

// 7. House rule: no em dash anywhere in app.js (the empty-cell glyph is an en dash)
{
  const src = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
  ok(!/\u2014|&mdash;|\\u2014|&#8212;/.test(src), 'app.js contains no em dash, literal or escaped');
  ok(!/in the repository/.test(src), 'app.js no longer points members at a repository');
}

// 8. validate() on its own: the SHORT case is still reported, the oversized one is left to the engine
{
  const AI = H.ctx.AppIntake;
  const p1 = AI.validate([{ name: 'Short', commitment: 100000, funded: 20000, uncalled: 30000, moic: 2, yearFunded: 2025 }], []);
  ok(p1.some((x) => /does not equal/.test(x)), 'funded plus uncalled short of the commitment is reported');
  const p2 = AI.validate([{ name: 'Over', commitment: 100000, funded: 80000, uncalled: 80000, moic: 2, yearFunded: 2025 }], []);
  ok(!p2.some((x) => /does not equal/.test(x)), 'the oversized case is not reported twice (buildBook reports it)');
  const p3 = AI.validate([{ name: 'NoYear', commitment: 1, moic: 2 }], []);
  ok(p3.some((x) => /treated as funded in 2026/.test(x)), 'a blank year funded names this calendar year');
}

console.log('intake: ' + checks + ' checks, ' + fails + ' failures');
process.exit(fails ? 1 : 0);
