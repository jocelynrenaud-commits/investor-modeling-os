// TEST HARNESS: boots the prototype's index.html in jsdom with every script evaluated in the
// page's own order (read from index.html, so a new script tag is picked up), XLSX stubbed so a
// workbook can be fed in as arrays of rows, fetch served from disk, and Date pinnable.
// Adapted from the QA audit harness (2026-10-31). jsdom is resolved from this project if it
// is installed here, else from APEX's node_modules (set JSDOM_FROM to override).
import fs from 'fs'; import path from 'path'; import { createRequire } from 'module'; import { fileURLToPath } from 'url';
export const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let JSDOM;
for (const base of [process.env.JSDOM_FROM, path.join(DIR, 'node_modules') + '/', 'C:/Users/jocel/OneDrive/Personal/6_APEX/node_modules/'].filter(Boolean)) {
  try { ({ JSDOM } = createRequire(base)('jsdom')); break; } catch (e) { /* try the next */ }
}
if (!JSDOM) { console.log('jsdom not found: npm install jsdom, or set JSDOM_FROM'); process.exit(1); }
const INDEX = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
/* Local scripts and inline blocks, in page order (the CDN XLSX is stubbed instead). */
const ORDER = [...INDEX.matchAll(/<script(?:\s+src="([^"?]+)[^"]*")?\s*>([\s\S]*?)<\/script>/g)]
  .map((m) => (m[1] ? (/^https?:/.test(m[1]) ? null : m[1]) : { inline: m[2] })).filter(Boolean);

export async function boot(opts = {}) {
  let html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  const errors = [];
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost:8791/' });
  const w = dom.window;
  w.addEventListener('error', (e) => errors.push('window.error: ' + (e.error && e.error.stack || e.message)));
  w.console.error = (...a) => errors.push('console.error: ' + a.join(' '));
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.scrollTo = function () {};
  w.URL.createObjectURL = () => 'blob:x';
  if (opts.now) {
    const RealDate = w.Date; let fixed = new RealDate(opts.now).getTime(); w.__setNow = (s) => { fixed = new RealDate(s).getTime(); };
    class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } }
    w.Date = FakeDate;
  }
  w.__fetchLog = [];
  w.fetch = async (u) => {
    const p = String(u).split('?')[0].replace(/^http:\/\/localhost:8791\//, '');
    w.__fetchLog.push(p);
    if (opts.fetchFail && opts.fetchFail(p)) {
      if (opts.fetchFail(p) === 'reject') throw new TypeError('Failed to fetch');
      return { ok: false, status: 404, json: async () => { throw new SyntaxError('Unexpected token < in JSON'); } };
    }
    const f = path.join(DIR, p);
    if (!fs.existsSync(f)) return { ok: false, status: 404, json: async () => { throw new SyntaxError('Unexpected token <'); } };
    const txt = fs.readFileSync(f, 'utf8');
    const body = opts.patch && opts.patch(p, txt) || txt;
    return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
  };
  w.XLSX = { read: () => w.__nextWB, utils: { sheet_to_json: (ws) => ws.aoa } };
  for (const f of ORDER) {
    if (typeof f === 'object') { if (/APP_TAB_LABELS/.test(f.inline)) w.eval(f.inline); continue; }   // the cache-refresh fetch is skipped
    const el = w.document.createElement('script'); el.textContent = fs.readFileSync(path.join(DIR, f), 'utf8') + '\n//# sourceURL=' + f;
    w.document.body.appendChild(el);
  }
  // ux.js waits for DOMContentLoaded
  await new Promise((r) => setTimeout(r, 0));
  if (w.document.readyState === 'loading') await new Promise((r) => w.document.addEventListener('DOMContentLoaded', r));
  return { w, dom, errors, $: (s) => w.document.querySelector(s), $$: (s) => [...w.document.querySelectorAll(s)] };
}
export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
export async function settle(w, n = 30) { for (let i = 0; i < n; i++) await tick(5); }
export async function demo(H) { H.$('#demo').click(); await settle(H.w, 60); }
export async function upload(H, sheets) {
  H.w.__nextWB = { SheetNames: Object.keys(sheets), Sheets: Object.fromEntries(Object.entries(sheets).map(([k, v]) => [k, { aoa: v }])) };
  const file = new H.w.File(['x'], 't.xlsx');
  Object.defineProperty(H.$('#file'), 'files', { value: [file], configurable: true });
  H.$('#file').dispatchEvent(new H.w.Event('change'));
  await settle(H.w, 80);
}
export async function tab(H, id) { const b = H.$('#out [data-tab="' + id + '"]'); if (!b) return false; b.click(); await settle(H.w, 40); return true; }
export const text = (H) => (H.$('#tabbody') || {}).textContent || '';
