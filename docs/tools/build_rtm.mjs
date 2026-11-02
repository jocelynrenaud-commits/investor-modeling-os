// Builds docs/RTM.md from the requirement definitions in docs/tools/rtm/*.mjs.
// Every worked example is COMPUTED here by running the prototype's own modules: the page is
// booted in jsdom through tests/harness.mjs with the clock pinned to 2026-11-01 12:00 local,
// the example book is loaded with "Run the example book", and each example calls the real
// functions (Engine, Markets, Runway, Portfolio, TaxPlay, TaxStrategies, PlanIncludes, ...) or
// reads the rendered page. Nothing in an example's output is typed by hand.
//
//   node docs/tools/build_rtm.mjs            writes docs/RTM.md
//
// Needs jsdom (see tests/harness.mjs for where it is looked up).
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
import { boot, demo, tab, text, settle, upload } from '../../tests/harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'RTM.md');
const NOW = '2026-11-01T12:00:00';

const H = await boot({ now: NOW });
await demo(H);
const w = H.w;
const g = (n) => w.eval(n);

/* Formatting for the examples (plain text, no em or en dashes). */
const $ = (v) => (v < 0 ? '-$' : '$') + Math.round(Math.abs(v)).toLocaleString('en-US');
const $2 = (v) => (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pc = (v, d = 1) => (v * 100).toFixed(d) + '%';
const x2 = (v) => v.toFixed(2) + 'x';
const n4 = (v) => (Math.round(v * 1e4) / 1e4).toString();
const n6 = (v) => (Math.round(v * 1e6) / 1e6).toString();
const J = (o) => JSON.stringify(o);

const K = {
  H, w, g, $, $2, pc, x2, n4, n6, J, NOW,
  E: g('Engine'), M: w.Markets, P: w.Portfolio, R: w.Runway, RU: w.RunwayUI, PI: w.PlanIncludes,
  TS: w.TaxStrategies, TP: w.TaxPlay, AI: w.AppIntake, AS: w.AppState, CU: w.ConsiderUI, MU: w.MarketsUI,
  HIST: g('History'),
  get ctx() { return w.PlanIncludes.ctx; },
  get book() { return w.PlanIncludes.ctx.book; },
  tab: async (id) => { await tab(H, id); return text(H); },
  text: () => text(H),
  settle: () => settle(w, 40),
  upload: (sheets) => upload(H, sheets),
  demo: () => demo(H),
  bootWith: (o) => boot(Object.assign({ now: NOW }, o)),
  demoOn: (h) => demo(h),
  tabOn: async (h, id) => { await tab(h, id); await settle(h.w, 40); },
  /* A KPI tile on the current tab by its label: the big figure and its sub-line. */
  kpi(label) {
    const tiles = H.$$('#tabbody .mk-kpi, #tabbody .kpi > div');
    for (const t of tiles) {
      const s = t.querySelector('small');
      if (s && s.textContent.trim() === label) {
        const v = t.querySelector('b, span');
        const sub = t.querySelector('b + span');
        return { v: v ? v.textContent.trim() : '', sub: sub ? sub.textContent.trim() : '' };
      }
    }
    return { v: '(not found)', sub: '' };
  },
  /* Rows of the first table under a card whose heading matches. */
  table(heading) {
    const card = H.$$('#tabbody .card').find((c) => { const h = c.querySelector('h2'); return h && h.textContent.trim() === heading; });
    if (!card) return [];
    const t = card.querySelector('table');
    return t ? [...t.querySelectorAll('tr')].map((r) => [...r.children].map((c) => c.textContent.trim())) : [];
  },
  card(heading) {
    return H.$$('#tabbody .card').find((c) => { const h = c.querySelector('h2'); return h && h.textContent.trim() === heading; }) || null;
  },
};

const sectionFiles = fs.readdirSync(path.join(HERE, 'rtm')).filter((f) => /^\d\d_.*\.mjs$/.test(f)).sort();
const sections = [];
for (const f of sectionFiles) {
  const mod = await import('./rtm/' + f);
  sections.push(...(await mod.default(K)));
}
const header = (await import('./rtm/header.mjs')).default;
const footer = (await import('./rtm/footer.mjs')).default;

/* ── render ─────────────────────────────────────────────────────────────── */
const SUITE = { E: 'engine.test.mjs', I: 'intake.test.mjs', M: 'markets.test.mjs', P: 'plan.test.mjs', R: 'runway.test.mjs',
  T1: 'taxes.test.mjs', T2: 'taxes2.test.mjs', TP: 'taxplay_parity.test.mjs', U: 'ui.test.mjs' };
const trace = [];
const counts = [];
let out = header(K);

for (const s of sections) {
  out += '\n---\n\n## ' + s.title + '\n\n' + s.intro.trim() + '\n\n';
  if (s.screen) {
    out += '**Screens.** Desktop: `docs/screens/' + s.screen + '.png`. Phone: `docs/screens/' + s.screen + '-mobile.png`.\n\n';
    out += '![' + s.title + '](screens/' + s.screen + '.png)\n\n';
    if (s.regions && s.regions.length) {
      out += 'Numbered regions, top to bottom on the desktop screenshot:\n\n| Region | What it is | Requirements |\n|---|---|---|\n';
      s.regions.forEach((r, i) => { out += '| ' + (i + 1) + ' | ' + r[0] + ' | ' + r[1] + ' |\n'; });
      out += '\n';
    }
  }
  const st = { Implemented: 0, Partial: 0, Gap: 0 };
  for (const r of s.reqs) {
    let ex;
    try { ex = typeof r.ex === 'function' ? await r.ex(K) : r.ex; } catch (e) { ex = 'EXAMPLE FAILED: ' + e.message; console.error(r.id, e.stack); }
    const tcs = (r.tests && r.tests.length)
      ? r.tests.map((t, i) => 'TC-' + r.id + '-' + String(i + 1).padStart(2, '0') + ': ' + SUITE[t[0]] + ', check \'' + t[1] + '\'')
      : ['TC-' + r.id + '-01: TO WRITE'];
    st[r.status] = (st[r.status] || 0) + 1;
    trace.push([r.id, tcs.map((t) => t.split(':')[0]).join(', '), r.tests && r.tests.length ? 'covered' : 'TO WRITE', r.status]);
    out += '### ' + r.id + '. ' + r.title + '\n\n';
    out += '- **Requirement:** ' + r.req + '\n';
    out += '- **Rule or formula:** ' + r.rule + '\n';
    out += '- **Worked example:** ' + String(ex).trim() + '\n';
    out += '- **Acceptance:** Given ' + r.given + '; when ' + r.when + '; then ' + r.then + '.\n';
    out += '- **Test cases:** ' + tcs.join('; ') + '\n';
    out += '- **Source:** ' + r.src + '\n';
    out += '- **Status:** ' + r.status + '\n\n';
  }
  counts.push([s.title, s.reqs.length, st.Implemented, st.Partial, st.Gap]);
}

out += footer(K, trace, counts);
if (/[–—]/.test(out)) {
  const m = out.match(/.{0,60}[–—].{0,20}/);
  console.error('em or en dash found: ' + (m ? m[0] : ''));
  out = out.replace(/[–—]/g, '-');
}
fs.writeFileSync(OUT, out);
console.log('wrote ' + OUT + ': ' + trace.length + ' requirements');
counts.forEach((c) => console.log(c.join(' | ')));
if (H.errors.length) console.log('page errors: ' + H.errors.slice(0, 3).join(' | '));
process.exit(0);
