// Helpers shared by the section files. expectedOf is the same arithmetic as app.js expectedOf
// (app.js does not export it); it calls the engine's own prefInYear and prefFactor.
export function expectedOf(E, x) {
  let acc = 0, e = 0;
  for (const br of x.branches) { acc += br[0]; e += br[0] * (x.scales && br[2] !== true ? br[1] * x.exitMult : br[1]); }
  e += (1 - acc) * x.exitMult;
  let pref = 0;
  for (let k = 1; k <= x.hold; k++) pref += E.prefInYear(x, k);
  let pw = 0, pacc = 0;
  for (const br of x.branches) { const m = x.scales && br[2] !== true ? br[1] * x.exitMult : br[1]; pacc += br[0]; pw += br[0] * E.prefFactor(x, m); }
  pw += (1 - pacc) * E.prefFactor(x, x.exitMult);
  return { mult: e, exit: x.commitment * e, pref: pref * pw, prefScheduled: pref, weight: pw };
}
export const byName = (K, n) => K.book.find((b) => b.name === n);
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const readDeal = (slug) => fs.readFileSync(path.join(ROOT, 'deals', slug + '.json'), 'utf8');
export const allDeals = () => fs.readdirSync(path.join(ROOT, 'deals')).filter((f) => f !== 'index.json' && f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'deals', f), 'utf8')));
export const readJSON = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
