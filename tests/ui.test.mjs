// The whole page in jsdom: what a member sees after the 2026-10-31 hardening of the
// whole-portfolio tabs, the Deal Library tester and the UX layer.  node tests/ui.test.mjs
// Each block names the audit finding it guards (QA = 03_qa_bugs, UX = 04_ux_review).
import fs from 'fs'; import path from 'path';
import { boot, demo, upload, tab, text, settle, DIR } from './harness.mjs';

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL', m); } };
const BOOK2 = { Positions: [['Deal name', 'Account', 'Asset class', 'Commitment', 'Funded to date', 'Uncalled', 'Year funded', 'Hold (yrs)', 'Coupon %'],
  ['Solo Credit Fund', 'Personal', 'Private Credit', 20000, 20000, 0, 2025, 4, '9%']] };
const POS = BOOK2.Positions;
const YOU = [['You'], ['Field', 'Your number', 'What it means'], ['Birth year', 1980, ''], ['Planned stop work year', 2040, ''], ['Annual spending', 90000, '']];
const BAL = [['Balances'], ['Account', 'Account type', 'Sleeve', 'Label', 'Value', 'Cost basis', 'Yield %', 'Expected return %', 'Vol %', 'As of'],
  ['Fidelity 401k', '401k', 'Growth', 'Index', 800000, '', '', '', '', '2026-09-30']];
const DASHES = /[\u2013\u2014]/;

/* Pick a deal in the tester, set inputs, and press Run it. */
async function pickDeal(H, slug, set) {
  const w = H.w, card = () => H.$('#consider');
  const sel = card().querySelector('[data-cs="slug"]');
  sel.value = slug || sel.options[2].value; sel.dispatchEvent(new w.Event('change')); await settle(w, 3);
  for (const [k, v] of Object.entries(set || {})) {
    const el = card().querySelector('[data-cs="' + k + '"]'); el.value = String(v); el.dispatchEvent(new w.Event('change')); await settle(w, 2);
  }
}
async function runDeal(H) { H.$('#consider [data-csrun]').click(); await settle(H.w, 150); }

/* ── the example book: landing, words, roles ─────────────────────────────── */
{
  const H = await boot();
  ok(H.$('#intake a[href="tracker-template.xlsx"]'), 'UX-01 landing page links the tracker template');
  H.$('#demo').click();
  ok(H.$('#demo').getAttribute('aria-busy') === 'true' && /Loading/.test(H.$('#demo').textContent), 'UX-03 Run the example book shows a loading state');
  await settle(H.w, 80);
  ok(H.$('#demo').getAttribute('aria-busy') !== 'true', 'UX-03 loading state cleared after load');
  ok(H.$('#out [data-tab].on').getAttribute('data-tab') === 'overview', 'lands on Overview');
  ok(/Start Here/.test(text(H)), 'UX-02 Start here card on Overview');
  ok(H.$('footer #ver'), 'UX-42 version pill sits in the footer');
  ok(/31 Oct 2026/.test(H.$('#ver').textContent) && /31 Oct 2026/.test(H.$('#relWhen').textContent), 'UX-54 pill and release notes name the same version');
  const bar = H.$('#out .tabs');
  ok(bar.getAttribute('role') === 'tablist' && H.$$('#out [role="tab"]').length >= 10, 'UX-52 tab bar has the tab pattern');
  ok(H.$$('#out [role="tab"][aria-selected="true"]').length === 1 && H.$('#out [role="tab"][tabindex="0"]').classList.contains('on'), 'one selected tab in the Tab order');
  const ov = H.$('#out [data-tab="overview"]'); ov.focus();
  ov.dispatchEvent(new H.w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await settle(H.w, 40);
  ok(H.$('#out [data-tab].on').getAttribute('data-tab') === 'curve' && H.w.document.activeElement.getAttribute('data-tab') === 'curve', 'Right arrow moves to the next tab and keeps focus');
  for (const t of ['overview', 'curve', 'holdings', 'dash', 'outlook', 'perf', 'universe', 'runway', 'tax', 'about']) {
    await tab(H, t);
    const tx = text(H);
    ok(!DASHES.test(tx), 'no em or en dash on ' + t + ': ' + ((tx.match(/.{0,30}[\u2013\u2014].{0,20}/) || [''])[0]));
    ok(!/NaN|undefined|Infinity/.test(tx), 'no NaN on ' + t);
    ok(!/Still callable|Still to call|\bUncalled\b/.test(tx), 'UX-10 one name for money still owed on ' + t);
    const label = H.$('#out [data-tab].on').textContent.trim(), title = (H.$('#tabbody .ptitle b') || {}).textContent;
    ok(label === title, 'UX-05 tab label matches page title on ' + t + ': ' + label + ' / ' + title);
    const titles = H.$$('#tabbody [title], #tabbody [data-tip]').map((e) => e.getAttribute('title') || e.getAttribute('data-tip')).join(' ');
    ok(!DASHES.test(titles), 'no dash in tooltips on ' + t);
  }
  await tab(H, 'dash');
  ok(/Still to pay in/.test(text(H)) && /Paid in/.test(text(H)), 'Deals tab uses Still to pay in and Paid in');
  const owe = H.$$('#tabbody small').find((s) => s.textContent.trim() === 'Still to pay in');
  ok(owe && !owe.nextElementSibling.classList.contains('neg'), 'UX-10 Still to pay in is in neutral ink');
  await tab(H, 'overview');
  ok(/Private deals \(paid in\)/.test(text(H)) && !/at cost/.test(text(H)), 'UX-11 private figures say paid in, not at cost');
  ok(/typical yearly swing/.test(text(H)), 'volatility defined where it is shown');
  await tab(H, 'about');
  ok(H.$('#uxAbout') && H.$('#uxTerms'), 'UX-08 Help has About This Tool and Terms');
  ['Volatility', 'Beta', 'Sharpe ratio', 'MOIC (multiple)', 'Chance the money lasts'].forEach((t) => ok(H.$$('#uxTerms .glos .t').some((e) => e.textContent === t), 'Terms defines ' + t));
  ok(!/Three tabs do the work/.test(text(H)), 'UX-02 About copy is current');
  await tab(H, 'runway');
  ok(!/Never short/i.test(H.$$('#tabbody small, #tabbody h2, #tabbody span').map((e) => e.textContent).join(' ').replace(/never short,/gi, '')), 'UX-12 the headline label reads Chance the money lasts');
  await tab(H, 'holdings');
  const th = H.$('#tabbody th.mk-sort button[data-mksort="value"]');
  ok(th && th.closest('th').getAttribute('aria-sort') === 'descending', 'QA L3 sortable headers are buttons with aria-sort');
  H.$('#tabbody [data-mksort="symbol"]').click(); await settle(H.w, 5);
  ok(H.$('#tabbody [data-mksort="symbol"]').closest('th').getAttribute('aria-sort') === 'ascending' && H.w.document.activeElement.getAttribute('data-mksort') === 'symbol', 'sorting keeps focus on the heading');
  ok(H.$('#tabbody th.mk-c-hide') && H.$('#tabbody .mk-c-show'), 'UX-48 mobile hides Type and Account and shows the account under the name');
  ok(H.$$('#tabbody .chip[aria-pressed]').length > 1, 'chips say whether they are pressed');
  const css = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  ok(/prefers-color-scheme:\s*dark/.test(css) && /color-scheme" content="light dark"/.test(css), 'UX-51 dark mode tokens');
  ok(/button:disabled/.test(css), 'UX-32 disabled buttons look disabled');
  ok(/pointer:coarse[^}]*min-height:44px/.test(css), 'UX-49 44px touch targets');
  ok(/more-right[^}]*mask-image/.test(css), 'UX-48 tab overflow fade');
  ok(/position:static/.test(css.slice(css.indexOf('.ver{position:static'))), 'UX-42 version pill is in the flow');
  ok(!H.errors.length, 'no script errors: ' + H.errors.slice(0, 2).join(' | '));
}

/* ── Equity Curve: the monthly addition, dates, CSV ──────────────────────── */
{
  const H = await boot({ now: '2026-12-31T20:00:00' });
  await demo(H); await tab(H, 'curve');
  ok(/with no new money added/.test(text(H)) && !/adding\s+a month/.test(text(H)), 'UX-26 the monthly addition is printed');
  const fl = H.$('#tabbody [data-mkflow]'); fl.value = '500'; fl.dispatchEvent(new H.w.Event('change')); await settle(H.w, 10);
  ok(/\$500<\/b> added each month/.test(H.$('#tabbody').innerHTML), 'UX-26 a set addition is printed as an amount');
  ok(H.$('#tabbody [name="date"]').value === '2026-12-31', 'QA M8 the default date is the local date, not UTC');
  const f = H.$('#tabbody [data-mkform]');
  f.querySelector('[name="date"]').value = '2099-06-30'; f.querySelector('[name="value"]').value = '100000';
  f.dispatchEvent(new H.w.Event('submit', { cancelable: true })); await settle(H.w, 10);
  ok(/cannot be later than today/.test(text(H)) && !H.$('#tabbody [data-mkyear="2099"]') && H.w.MarketsUI.S.added.length === 0, 'QA M11 a future date is refused');
  const f2 = H.$('#tabbody [data-mkform]'); f2.querySelector('[name="value"]').value = '1000000000000';
  f2.dispatchEvent(new H.w.Event('submit', { cancelable: true })); await settle(H.w, 10);
  ok(/ten times/.test(text(H)) && H.w.MarketsUI.S.added.length === 0, 'a balance ten times the last asks again');
  const f3 = H.$('#tabbody [data-mkform]'); f3.querySelector('[name="value"]').value = '1000000000000';
  f3.dispatchEvent(new H.w.Event('submit', { cancelable: true })); await settle(H.w, 10);
  ok(H.w.MarketsUI.S.added.length === 1 && /Balance added for/.test(text(H)), 'the second press adds it, with feedback');
  ok(H.w.MarketsUI.csvCell('=HYPERLINK("x")') === '"\'=HYPERLINK(""x"")"' && H.w.MarketsUI.csvCell('IRA') === '"IRA"', 'QA L9 CSV cells cannot start a formula');
  ok(/drawn independently/.test(text(H)), 'M-18 the independence of public and private is said on the tab');
  ok(!H.errors.length, 'curve: no script errors ' + H.errors.slice(0, 2).join(' | '));
}

/* ── One household on every tab (QA H3, C1) ──────────────────────────────── */
{
  const H = await boot();
  await upload(H, { 'Read me': [['x']], Positions: POS, 'What you get back': [['y']], You: YOU, Balances: BAL });
  await tab(H, 'overview');
  const ov = text(H);
  ok(!/Sample household/.test(ov) && /From your Balances tab/.test(ov), 'QA H3 Overview reads the Balances tab');
  ok(/<small>Public markets<\/small><b>\$800k<\/b>/.test(H.$('#tabbody').innerHTML), 'Overview public total is the Balances total');
  await tab(H, 'holdings');
  ok(/Index/.test(text(H)) && /\$800,000/.test(text(H)), 'Holdings lists the Balances row');
  await tab(H, 'curve');
  ok(/No balance history yet/.test(text(H)), 'QA H3 a Balances tab is not read as balance history');
  await tab(H, 'runway');
  ok(/Balances/.test(text(H)) && !/Sample household\./.test(text(H)), 'Retirement plans from the same Balances tab');
  ok(!H.errors.length, 'balances: no script errors ' + H.errors.slice(0, 2).join(' | '));
}

/* ── Holdings edge cases (QA H9, M12, M13, H4) ───────────────────────────── */
{
  const H = await boot();
  await upload(H, { Positions: POS, Holdings: [['Symbol', 'Name', 'Account', 'Market value'], ['MARGIN', 'Margin debit', 'Brokerage', -50000]] });
  await tab(H, 'overview');
  ok(!H.errors.length && /Net Worth/.test(text(H)), 'QA H9 an account of only negative values renders: ' + H.errors.slice(0, 1).join(''));
  ok(/negative value/.test(text(H)) && !/Sample household/.test(text(H)), 'the negative row is reported, not half counted, and the sample is not shown');
  await upload(H, { Positions: POS, Holdings: [['Symbol', 'Account', 'Market value'], ['CASH', 'Brokerage', 0.01]] });
  await tab(H, 'overview');
  ok(!/of your public money/.test(text(H)), 'QA M12 no share of a negligible public total');
  await upload(H, { Positions: POS, Holdings: [['Symbol', 'Account', 'Market value', 'Yield', 'Expected return', 'Volatility'], ['BND', 'Brokerage', 100000, '1%', 1.2, 1.4]] });
  await tab(H, 'holdings');
  ok(/1\.2%/.test(text(H)) && !/120\.0%/.test(text(H)) && /\$1k a year/.test(text(H)), 'QA H4 "1%" and 1.2 read as about one percent');
  await upload(H, { Positions: POS, Holdings: [['Symbol', 'Account', 'Market value'], ['', '', '']] });
  await tab(H, 'holdings');
  ok(/no rows with a value/.test(text(H)) && !/Sample household/.test(text(H)), 'QA M13 an empty Holdings tab means none, not the sample');
}

/* ── The deal tester: preview, add, remove, validation (UX-31, QA H8, M3, M4, M5, C2) ── */
{
  const H = await boot({ now: '2026-10-31T12:00:00' }); const w = H.w;
  await demo(H); await tab(H, 'universe'); await settle(w, 40);
  ok(H.$('#consider [data-csrun]').disabled && /Choose a deal/.test(H.$('#consider').textContent), 'UX-32 Run it is disabled until a deal is chosen, and says why');
  await pickDeal(H, 'aerolane', { year: 2020 });
  ok(/cannot be in the past/.test(H.$('#consider').textContent) && H.$('#consider [data-csrun]').disabled, 'QA H8 a past year is refused');
  await pickDeal(H, 'aerolane', { year: 2026, paid: 150 });
  ok(/between 0 and 100/.test(H.$('#consider').textContent) && H.$('#consider [data-csrun]').disabled, 'QA M4 paid in above 100% is refused');
  await pickDeal(H, 'aerolane', { paid: 100, commitment: 0 });
  ok(/above \$0/.test(H.$('#consider').textContent), 'a zero commitment is refused');
  await pickDeal(H, 'aerolane', { commitment: 3000000 });
  await runDeal(H);
  ok(/More than your public money/.test(H.$('#consider').textContent) && w.ConsiderUI.S.result && w.ConsiderUI.S.result.short != null, 'QA C2 a commitment above the public investments runs, with the shortfall warning');
  await pickDeal(H, 'aerolane', { commitment: 50000 });
  await runDeal(H);
  ok(w.ConsiderUI.S.result && !w.ConsiderUI.S.result.error, 'a valid deal runs: ' + JSON.stringify(w.ConsiderUI.S.result && w.ConsiderUI.S.result.error));
  ok(w.PlanIncludes.considered === null, 'UX-31 Run it is a preview: nothing is added to the plan');
  ok(/Chance the money lasts/.test(H.$('#consider').textContent) && /Change in money left at the end/.test(H.$('#consider').textContent), 'UX-12 the tester uses the plain labels');
  ok(!/-0\.0%/.test(H.$('#consider').textContent) && !/≥/.test(H.$('#consider').textContent), 'QA L2 and UX-28 no -0.0% and no symbol in the copy');
  H.$('#consider [data-csadd]').click(); await settle(w, 5);
  ok(w.PlanIncludes.considered && w.PlanIncludes.considered.name === 'Aerolane', 'Add to my Retirement plan includes the deal');
  ok(H.$('#consider .cs-included') && H.$('#consider [data-csdel]'), 'the included state shows, with Remove');
  ok(w.document.activeElement === H.$('#consider [data-csdel]'), 'focus moves to Remove after adding');
  // a change to the inputs clears the stale result (QA M5) but keeps the included note
  const c = H.$('#consider [data-cs="commitment"]'); c.value = '500000'; c.dispatchEvent(new w.Event('change')); await settle(w, 3);
  ok(!w.ConsiderUI.S.result && /Aerolane<\/b> \(\$50k from 2026\) is in your Retirement plan/.test(H.$('#consider').innerHTML), 'QA M5 a changed input clears the result; the plan still names the included deal');
  // a failed run leaves the plan alone and still shows the included deal with Remove (QA M3)
  const H2fail = w.fetch; w.fetch = async (u) => (/deals\/bluebird/.test(String(u)) ? { ok: false, status: 404, json: async () => { throw new Error('x'); } } : H2fail(u));
  await pickDeal(H, 'bluebird-capital', { commitment: 50000 });
  await runDeal(H);
  ok(/could not be run/.test(H.$('#consider').textContent) && w.PlanIncludes.considered && w.PlanIncludes.considered.name === 'Aerolane' && H.$('#consider [data-csdel]'), 'QA M3 a failed run changes nothing and keeps Remove: ' + H.$('#consider').textContent.slice(700, 1500) + ' considered=' + JSON.stringify(w.PlanIncludes.considered && w.PlanIncludes.considered.name));
  w.fetch = H2fail;
  H.$('#consider [data-csdel]').click(); await settle(w, 3);
  ok(w.PlanIncludes.considered === null, 'Remove takes the deal out');
  ok(!H.errors.length, 'tester: no script errors ' + H.errors.slice(0, 2).join(' | '));
}

/* ── A failed deal index is not cached and offers a retry (QA M10) ────────── */
{
  let fail = true;
  const H = await boot({ fetchFail: (p) => (fail && p === 'deals/index.json' ? 'reject' : false) });
  await demo(H); await tab(H, 'universe'); await settle(H.w, 40);
  ok(/Could not load the list of deals/.test(H.$('#consider').textContent) && H.$('#consider [data-csretry]'), 'QA M10 a failed index says so and offers Try again');
  ok(H.w.ConsiderUI.S.index === null, 'the failure is not cached');
  fail = false;
  H.$('#consider [data-csretry]').click(); await settle(H.w, 40);
  ok(H.w.ConsiderUI.S.index && H.w.ConsiderUI.S.index.length > 5 && !/Could not load/.test(H.$('#consider').textContent), 'Try again loads the list');
}

/* ── A new book starts clean (QA H2, M1) ─────────────────────────────────── */
{
  const H = await boot(); const w = H.w;
  await demo(H); await tab(H, 'universe'); await settle(w, 40);
  await pickDeal(H, 'aerolane', { commitment: 50000 }); await runDeal(H);
  H.$('#consider [data-csadd]').click(); await settle(w, 5);
  await tab(H, 'holdings'); H.$('#tabbody [data-mksort="symbol"]').click(); await settle(w, 5);
  await tab(H, 'curve');
  const f = H.$('#tabbody [data-mkform]'); f.querySelector('[name="value"]').value = '400000'; f.dispatchEvent(new w.Event('submit', { cancelable: true })); await settle(w, 10);
  ok(w.PlanIncludes.considered && w.MarketsUI.S.added.length === 1 && w.MarketsUI.S.sort === 'symbol', 'state was set on book 1');
  let hookRan = 0; w.AppState.onReset(() => { hookRan++; });
  const book1 = w.PlanIncludes.ctx.book;
  await upload(H, BOOK2);
  ok(w.PlanIncludes.ctx.book !== book1 && w.PlanIncludes.ctx.book.length === 1, 'QA H2 the remembered book is the new one before any plugin tab opens');
  ok(w.PlanIncludes.considered === null && !w.ConsiderUI.S.result && w.ConsiderUI.S.slug === '', 'QA M1 the considered deal and tester are cleared');
  ok(w.MarketsUI.S.added.length === 0 && w.MarketsUI.S.sort === 'value', 'QA M1 recorded balances and sort are cleared');
  ok(hookRan === 1, 'AppState.onReset hooks run once per new book: ' + hookRan);
  ok(H.$('#out [data-tab].on').getAttribute('data-tab') === 'overview', 'QA L11 every new book lands on Overview');
  await tab(H, 'universe'); await settle(w, 40);
  await pickDeal(H, 'aerolane', { commitment: 10000 }); await runDeal(H);
  ok(w.ConsiderUI.S.result && !w.ConsiderUI.S.result.error && w.ConsiderUI.S.result.p50 > 0, 'the tester runs against book 2');
  ok(!w.ConsiderUI.S.result.eff && w.ConsiderUI.S.result.need && /appears once your file has/.test(H.$('#consider').textContent),
    'Q20 on a file without the You tab the tester holds back its retirement figures and says why');
  ok(!H.errors.length, 'reset: no script errors ' + H.errors.slice(0, 2).join(' | '));
}

/* ── A private-only file never shows the sample household (tester book, 2026-11-01) ── */
{
  const H = await boot(); const w = H.w;
  await upload(H, BOOK2);
  const mk = w.Markets.load(w.PlanIncludes.ctx.sheets);
  ok(mk.source === 'none' && mk.holdings.length === 0 && !mk.isDemo, 'private-only file: no public holdings, not the sample: ' + mk.source);
  for (const t of ['overview', 'holdings', 'curve']) { await tab(H, t); ok(!/Sample household/.test(H.$('#out').textContent), 'private-only file: ' + t + ' does not show the sample household'); }
  await tab(H, 'runway'); await settle(w, 40);
  const rt = H.$('#out').textContent;
  ok(/needs 6 more figures/.test(rt) && !/Chance the money lasts/.test(rt) && !/Sample household/.test(rt), 'Q20 private-only file: Retirement asks for its figures instead of running on the sample');
  ok(['Birth year', 'Planned stop work year', 'Annual spend target', 'Estimated annual benefit', 'Benefit start age', 'A Balances tab'].every((l) => rt.indexOf(l) >= 0),
    'Q20 the request names every missing figure as it is typed on the You tab');
  const c = w.RunwayUI.baseConfig(w.PlanIncludes.ctx).C;
  ok(c.noPublic && c.sleeves.length === 1 && c.sleeves[0].balance === 1, 'private-only file: one $1 cash sleeve for deal cash');
  ok(!H.errors.length, 'private-only file: no script errors ' + H.errors.slice(0, 2).join(' | '));
}

/* ── Q20: a member's file must carry the plan's figures before Retirement runs ── */
{
  const H = await boot(); const w = H.w;
  const YOU_ALL = [['You'], ['Field', 'Your number'], ['Birth year', 1968], ['Planned stop work year', 2030], ['Annual spend target', '$150,000'],
    ['Estimated annual benefit', 0], ['Benefit start age', 70], ['Filing status', 'Single'], ['Household income', 250000], ['Taxable income after you stop', 60000]];
  const BAL0 = [['Balances'], ['Account', 'Account type', 'Sleeve', 'Label', 'Value'], ['Checking', 'Taxable', 'Cash', 'Cash', 0]];
  await upload(H, { Positions: POS, You: YOU_ALL.slice(0, 6), Balances: BAL0 });
  await tab(H, 'runway'); await settle(w, 40);
  let rt = H.$('#out').textContent;
  const need = [...H.$('#out').querySelectorAll('.rw-need li')].map((li) => li.textContent);
  ok(/needs 1 more figure /.test(rt) && need.length === 1 && need[0] === 'Benefit start age',
    'Q20 only the one missing figure is asked for; a 0 benefit counts as an answer: ' + need.join(', '));
  await upload(H, { Positions: POS, You: YOU_ALL, Balances: BAL0 });
  await tab(H, 'runway'); await settle(w, 40);
  rt = H.$('#out').textContent;
  ok(!/more figure/.test(rt) && /Chance the money lasts/.test(rt) && /no public money/.test(rt), 'Q20 a complete file runs, and a Balances tab of 0 reads as no public money');
  const c = w.RunwayUI.baseConfig(w.PlanIncludes.ctx).C;
  ok(c.birthYear === 1968 && c.stopYear === 2030 && c.spend === 150000 && c.benefitAnnual === 0 && c.benefitAge === 70 && c.noPublic,
    'Q20 the plan uses the member’s own figures');
  ok(c.filingStatus === undefined && c.w2Now === undefined, 'the tax-only You fields stay out of the plan config');
  await tab(H, 'tax'); await settle(w, 20);
  ok(w.TaxStrategies.S.local.status === 'single' && w.TaxStrategies.S.local.w2Now === 250000 && w.TaxStrategies.S.local.retireIncome === 60000,
    'Tax Strategies baseline is seeded from the You tab');
  const blankB = w.Portfolio.parseYou({ You: [['Birth year', '', 'Ages are worked out from this'], ['Planned stop work year', 2030, ''], ['Annual spend target', 'TBD', '']] });
  ok(blankB && blankB.birthYear === undefined && blankB.spend === undefined && blankB.stopYear === 2030,
    'a blank or unreadable You value is missing, never the explanation beside it');
  ok(w.RunwayUI.missing({ book: w.PlanIncludes.ctx.book, sheets: {} }) === null && w.RunwayUI.missing({ book: [] }) === null, 'the example book and the sample household are never gated');
  ok(!H.errors.length, 'Q20: no script errors ' + H.errors.slice(0, 2).join(' | '));
}

/* ── Q21: capital calls before the stop year, as numbers, with the first uncovered year marked ── */
{
  const H = await boot(); const w = H.w;
  const CALLS = [['Deal name', 'Account', 'Asset class', 'Commitment', 'Funded to date', 'Uncalled', 'Year funded', 'Next Call Date', 'Next Call Amount', 'Hold (yrs)', 'Coupon %'],
    ['Credit Fund', 'Personal', 'Private Credit', 400000, 96000, 304000, 2026, 'Q1 2027', 20000, 8, '12%'],
    ['Venture Fund', 'Personal', 'VC', 500000, 125000, 375000, 2025, 'Q4 2026', 37500, 10, '']];
  const YOU_ALL = [['You'], ['Field', 'Your number'], ['Birth year', 1968], ['Planned stop work year', 2030], ['Annual spend target', 150000],
    ['Estimated annual benefit', 30000], ['Benefit start age', 67]];
  const BALX = (v) => [['Balances'], ['Account', 'Account type', 'Sleeve', 'Label', 'Value'], ['Checking', 'Taxable', 'Cash', 'Cash', v]];
  await upload(H, { Positions: CALLS, You: YOU_ALL, Balances: BALX(100000) });
  await tab(H, 'runway'); await settle(w, 40);
  const card = H.$('#out .rw-calls');
  ok(card && /Capital calls before you stop/i.test(card.textContent), 'Q21 a member file with calls before the stop year shows the capital-calls panel');
  const rows = card ? [...card.querySelectorAll('tr')].slice(1) : [];
  const yrs = rows.map((tr) => parseInt(tr.cells[0].textContent, 10));
  ok(rows.length && yrs.every((y) => y < 2030), 'Q21 the panel lists only years before the stop year: ' + yrs.join(','));
  const sched = w.PlanIncludes.callsDated(w.PlanIncludes.ctx.book);
  const tot = Object.keys(sched).filter((y) => +y < 2030).reduce((a, y) => a - sched[y].net, 0);
  const cum = rows.length ? Number(rows[rows.length - 1].cells[2].textContent.replace(/[$,]/g, '')) : -1;
  ok(Math.abs(cum - Math.round(tot)) <= 1, 'Q21 the running total ties to the engine call schedule: ' + cum + ' vs ' + Math.round(tot));
  const hi = card ? card.querySelectorAll('tr.rw-uncov') : [];
  const firstGap = rows.findIndex((tr) => /[1-9]/.test(tr.cells[3].textContent));
  ok(hi.length === 1 && rows.indexOf(hi[0]) === firstGap && /first year not covered/.test(hi[0].textContent),
    'Q21 exactly one row is highlighted, the first year the calls outrun the public money');
  ok(card && /Public money in your file: \$100,000/.test(card.textContent) && !/should|must|risk/i.test(card.textContent),
    'Q21 the panel states the numbers and gives no verdict');
  await upload(H, { Positions: CALLS, You: YOU_ALL, Balances: BALX(5000000) });
  await tab(H, 'runway'); await settle(w, 40);
  const c2 = H.$('#out .rw-calls');
  ok(c2 && !c2.querySelector('tr.rw-uncov') && /Not covered: \$0/.test(c2.textContent), 'Q21 calls the file can cover are listed with nothing highlighted');
  await upload(H, { Positions: POS, You: YOU_ALL, Balances: BALX(100000) });
  await tab(H, 'runway'); await settle(w, 40);
  ok(!H.$('#out .rw-calls'), 'Q21 a book with nothing left to call shows no capital-calls panel');
  ok(!H.errors.length, 'Q21: no script errors ' + H.errors.slice(0, 2).join(' | '));
}

console.log('ui: ' + checks + ' checks, ' + fails + ' failures');
process.exit(fails ? 1 : 0);
