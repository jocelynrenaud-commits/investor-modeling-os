/* WHAT IF I ADD THIS DEAL? (prototype) A card at the top of the Deal Library.
 *
 * Pick a deal the tool already knows, say how much you would commit and when, and it runs
 * that deal through the same engine as your own positions: the deal file's terms, the same
 * outcome and timing draws, the same calls. Two answers come back: what the deal itself is
 * likely to return, and what adding it would do to your retirement plan, on the same futures
 * as the Retirement tab.
 *
 * RUN IT IS A PREVIEW. It changes nothing (UX review #31: "what if" must be safe to try).
 * The plan changes only when the reader presses "Add to my Retirement plan"; the card then
 * shows the deal as included, with Remove beside it, and the Retirement tab's "Included in
 * This Plan" panel lists it. Nothing is ever added to the book: the other tabs still show
 * what you own.
 *
 * PLACE IN THE APP. Loaded by index.html after includes.js. ux.js calls ConsiderUI.mount()
 * when the Deal Library (drawn by app.js) is on screen. Reads PlanIncludes (ctx, preview,
 * consider, validateDeal, liquid), RunwayUI.expectedReturn and Engine (applyDealFile,
 * buildBook, simulate). Fetches deals/index.json and deals/<slug>.json.
 *
 * STATE. S below, session only. Cleared on every new book through AppState.onReset (the
 * deal index stays cached when it loaded; a failed index is never cached). Inputs are kept
 * as typed, validated on every change, and snapshotted when a run starts, so a change made
 * while a run is in flight cannot be mixed into its result.
 *
 * DATA SHAPES. S.result = { name, cls, inputs {slug, commitment, paid, year, account},
 * p10, p50, p90, mean (multiples on commitment), irr (fraction a year or null), firstBack
 * (year or null), er (portfolio expected return, fraction), eff (PlanIncludes.preview),
 * deal (the candidate handed to PlanIncludes.consider on Add) } or { error }.
 *
 * KNOWN LIMITS. One considered deal at a time: adding another replaces it. The deal's money
 * in is taken from the public investments, and a commitment above them is refused rather
 * than simulated (the simulator cannot charge money that is not there).
 */
(function (root) {
  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  /* Dollars in three significant steps: $950, $48k, $1.25M, $2.50B, $1.00T. */
  function short(v) {
    const a = Math.abs(v), sg = v < 0 ? '-' : '';
    if (a >= 1e12) return sg + '$' + (a / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return sg + '$' + (a / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return sg + '$' + (a / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return sg + '$' + Math.round(a / 1e3) + 'k';
    return sg + '$' + Math.round(a);
  }
  /* A fraction as a percent with d decimals; a value that rounds to zero prints as 0, never -0. */
  function pct(v, d) {
    const s = (v * 100).toFixed(d == null ? 0 : d);
    return (Number(s) === 0 ? (0).toFixed(d == null ? 0 : d) : s) + '%';
  }
  const E = () => ((typeof Engine !== 'undefined' && Engine) ? Engine : root.Engine);
  const url = (slug) => 'deals/' + slug + '.json?v=' + encodeURIComponent((E().CFG && E().CFG.version) || 'dev');
  /* This year, read when needed rather than frozen at page load (QA M7). */
  const nowYear = () => (root.PlanIncludes && root.PlanIncludes.nowYear ? root.PlanIncludes.nowYear() : new Date().getFullYear());

  const fresh = () => ({ slug: '', commitment: 50000, paid: 1, year: null, account: 'Self-Directed IRA', result: null, busy: false, seq: 0, errors: {} });
  const S = Object.assign(fresh(), { index: null, indexError: null });

  /* The deal list, fetched once per session when it works. A failure is NOT cached: the
     card says so and offers Retry, and the next mount tries again (QA M10). */
  async function index() {
    if (S.index) return S.index;
    try {
      const r = await fetch(url('index'));
      if (!r || r.ok === false) throw new Error('the server answered ' + (r ? r.status : 'nothing'));
      const j = await r.json();
      const list = (j && j.deals) || [];
      list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      S.index = list; S.indexError = null;
    } catch (e) {
      S.index = null;
      S.indexError = 'Could not load the list of deals (' + (e && e.message ? e.message : 'network error') + '). Check your connection and try again.';
    }
    return S.index;
  }

  /* The public investments, computed once per book (it runs the Retirement base config). */
  const liquidCache = new WeakMap();
  function liquidFor(ctx) {
    if (!ctx || !ctx.book) return null;
    if (!liquidCache.has(ctx.book)) liquidCache.set(ctx.book, root.PlanIncludes.liquid(ctx));
    return liquidCache.get(ctx.book);
  }

  /* The candidate deal from the inputs, in dollars: paid = commitment x paid fraction. */
  function candidate() {
    const year = S.year == null ? nowYear() : S.year;
    return { commitment: S.commitment, paid: S.commitment * S.paid, year, account: S.account };
  }

  /* Validate the inputs into S.errors. With withLiquid, a commitment above the public
     investments is an error too (only checked when a run is asked for, because it costs a
     base-config run). */
  function check(withLiquid) {
    const PI = root.PlanIncludes;
    const v = PI.validateDeal(candidate(), withLiquid ? liquidFor(PI.ctx) : null);
    S.errors = v.errors;
    if (S.paidBad) S.errors.paid = 'Enter a percent between 0 and 100.';
    return v.ok && !S.paidBad;
  }

  /* PREVIEW the chosen deal. Inputs are copied before anything is awaited; a run that a later
     change or reset has overtaken is thrown away. The plan is never changed here. */
  async function runIt(card) {
    const PI = root.PlanIncludes, ctx = PI && PI.ctx;
    if (S.busy || !S.slug || !ctx) return;
    if (!check(true)) { S.result = null; draw(card); return; }
    const inp = Object.assign({ slug: S.slug }, candidate());
    const seq = ++S.seq;
    S.busy = true; draw(card);
    let result;
    try {
      const resp = await fetch(url(inp.slug));
      if (!resp || resp.ok === false) throw new Error('its deal file did not load');
      const f = await resp.json();
      if (seq !== S.seq) return;   // overtaken by a newer run or a reset
      const row = E().applyDealFile({ name: f.name, commitment: inp.commitment, funded: inp.paid, uncalled: inp.commitment - inp.paid, yearFunded: inp.year, account: inp.account }, f);
      const book = E().buildBook([row]);
      if (!book.length) throw new Error('it has no commitment');
      const sim = E().simulate(book, { irr: true });
      const t = sim.totals, firstBack = (sim.cum.find((r) => r.p50 >= inp.commitment) || {}).year;
      const deal = { name: f.name, commitment: inp.commitment, paid: inp.paid, year: inp.year, account: inp.account, book, slug: inp.slug };
      const eff = PI.preview(ctx, deal);
      let er = null;
      try { er = root.RunwayUI.expectedReturn(ctx); } catch (e2) { er = null; }
      result = { name: f.name, cls: f.assetClass, inputs: inp, deal, eff, er,
        p10: t.p10 / inp.commitment, p50: t.p50 / inp.commitment, p90: t.p90 / inp.commitment, mean: t.mean / inp.commitment,
        irr: sim.irr && sim.irr.portfolio ? sim.irr.portfolio.p50 : null, firstBack };
    } catch (e) {
      result = { error: 'This deal could not be run: ' + (e && e.message ? e.message : 'unknown error') + '. Your Retirement plan has not changed.' };
    }
    if (seq !== S.seq) return;
    S.result = result; S.busy = false;
    if (card.isConnected) draw(card);
  }

  /* True when the shown result is the deal now in the plan (same deal and same terms). */
  function isIncluded(r, cur) {
    if (!r || !r.deal || !cur) return false;
    return cur.slug === r.deal.slug && cur.commitment === r.deal.commitment && cur.paid === r.deal.paid && cur.year === r.deal.year && cur.account === r.deal.account;
  }

  /* The inline message under one field, announced to a screen reader, or nothing. */
  function errLine(k) { return S.errors[k] ? '<span class="cs-err" role="alert">' + esc(S.errors[k]) + '</span>' : ''; }

  /* Draw the whole card from S. Rebuilt on every change; handlers are bound fresh each time. */
  function draw(card) {
    const PI = root.PlanIncludes, cur = PI && PI.considered, deals = S.index || [];
    const y0 = nowYear();
    let h = '<h2>What If I Add This Deal?</h2><p class="cap">Try a deal against your plan before you commit. It uses the deal’s own terms and the same simulation as your positions. Running it is a preview: your plan changes only if you add it.</p>';
    if (!PI || !PI.ctx) {
      card.innerHTML = h + '<p class="note">Load your tracker or the example book first, so there is a plan to add it to.</p>'; return;
    }
    if (S.indexError) {
      h += '<p class="note cs-error" role="alert">' + esc(S.indexError) + ' <button type="button" class="linkish" data-csretry>Try again</button></p>';
    }
    const can = S.slug && !S.busy && !Object.keys(S.errors).length;
    h += '<div class="tx-row">'
      + '<label class="tx-f" style="min-width:240px"><span>Deal</span><select data-cs="slug"><option value="">Choose a deal</option>'
      + deals.map((d) => '<option value="' + esc(d.slug) + '"' + (S.slug === d.slug ? ' selected' : '') + '>' + esc(d.name) + (d.assetClass ? ' · ' + esc(d.assetClass) : '') + '</option>').join('') + '</select></label>'
      + '<label class="tx-f"><span>You would commit</span><span class="tx-in m"><input type="number" data-cs="commitment" value="' + S.commitment + '" step="5000" min="1" inputmode="decimal"' + (S.errors.commitment ? ' aria-invalid="true"' : '') + '></span>' + errLine('commitment') + '</label>'
      + '<label class="tx-f" title="The rest is called later, on the deal’s own schedule"><span>Paid in at close</span><span class="tx-in p"><input type="number" data-cs="paid" value="' + Math.round(S.paid * 100) + '" step="5" min="0" max="100"' + (S.errors.paid ? ' aria-invalid="true"' : '') + '></span>' + errLine('paid') + '</label>'
      + '<label class="tx-f"><span>Year it closes</span><span class="tx-in"><input type="number" data-cs="year" value="' + (S.year == null ? y0 : S.year) + '" step="1" min="' + y0 + '" max="' + (y0 + 10) + '"' + (S.errors.year ? ' aria-invalid="true"' : '') + '></span>' + errLine('year') + '</label>'
      + '<label class="tx-f"><span>Held in</span><select data-cs="account"><option' + (S.account === 'Self-Directed IRA' ? ' selected' : '') + '>Self-Directed IRA</option><option' + (S.account === 'Private Deals' ? ' selected' : '') + '>Private Deals</option></select></label>'
      + '<button type="button" class="on" data-csrun' + (can ? '' : ' disabled') + (S.busy ? ' aria-busy="true"' : '') + '>' + (S.busy ? 'Running...' : 'Run it') + '</button>'
      + '</div>'
      + (!S.slug && !S.busy ? '<p class="cs-hint">Choose a deal to run it.</p>' : '');
    const r = S.result;
    if (r && r.error) {
      /* A failed run never hides what is already in the plan, or the way to remove it (QA M3). */
      h += '<p class="note cs-error" role="alert">' + esc(r.error) + '</p>' + (cur ? includedNote(cur, false) : '');
    } else if (r) {
      const e = r.eff;
      const d = e ? Math.round(e.after * 100) - Math.round(e.before * 100) : 0;
      h += '<div class="mk-kpis">'
        + kpiBox('Typical outcome', r.p50.toFixed(2) + '×', 'bad ' + r.p10.toFixed(2) + '× · good ' + r.p90.toFixed(2) + '× on what you commit')
        + kpiBox('Typical rate of return', r.irr == null ? 'Not known' : pct(r.irr, 1), 'a year, middle future')
        + kpiBox('Money back by', r.firstBack || 'after the window', 'typical future: the year your cash back first equals what you put in')
        + (e ? kpiBox('Chance the money lasts', pct(e.before) + ' → ' + pct(e.after), 'your retirement plan, without it → with it' + (d ? ' (' + (d > 0 ? '+' : '') + d + ' point' + (Math.abs(d) === 1 ? '' : 's') + ')' : ''), e.after >= e.before ? 'pos' : 'neg')
          + kpiBox('Change in money left at the end', (e.endAfter >= e.endBefore ? '+' : '') + short(e.endAfter - e.endBefore), 'typical future, in today’s dollars', e.endAfter >= e.endBefore ? 'pos' : 'neg') : '')
        + '</div>'
        + (e ? whyLine(r, e) : '');
      if (isIncluded(r, cur)) {
        h += includedNote(cur, true);
      } else {
        h += '<div class="cs-actions"><button type="button" class="on" data-csadd>Add to my Retirement plan</button>'
          + '<span class="cs-hint">' + (cur ? 'This replaces ' + esc(cur.name) + ' (' + short(cur.commitment) + ' from ' + cur.year + ') in your plan.' : 'This is a preview. Your Retirement plan has not changed.') + '</span></div>';
        if (cur) h += includedNote(cur, false);
      }
    } else if (cur) {
      h += includedNote(cur, false);
    }
    h += '<details class="more how"><summary>How this works</summary><p class="note">The deal is built from its shared file exactly as one of your own positions would be: its terms, its outcome table and its timing. What you pay at close goes out in that year, from your public investments; the rest is called on the deal’s schedule; its preferred return and exit come back in each simulated future. The retirement figures run your plan without any considered deal and with this one, on the same futures, with everything else on the Retirement tab’s "Included in This Plan" panel as it is. Running it changes nothing; Add to my Retirement plan includes it, and Remove takes it out. Nothing is added to your book.</p></details>';
    card.innerHTML = h;

    card.querySelectorAll('[data-cs]').forEach((el) => {
      el.onchange = () => {
        const k = el.getAttribute('data-cs'), raw = String(el.value).trim();
        if (k === 'slug' || k === 'account') S[k] = el.value;
        else if (k === 'paid') {
          /* A blank or impossible percent keeps the last good value and says why (QA M4). */
          const n = Number(raw);
          if (raw === '' || !Number.isFinite(n) || n < 0 || n > 100) S.paidBad = true;
          else { S.paidBad = false; S.paid = n / 100; }
        } else if (k === 'year') S.year = raw === '' ? null : Number(raw);
        else S.commitment = raw === '' ? 0 : Number(raw);
        S.result = null;   // a result always describes the inputs on screen (QA M5)
        S.seq++; S.busy = false;
        check(false);
        draw(card);
        const again = card.querySelector('[data-cs="' + k + '"]'); if (again) again.focus();
      };
    });
    const run = card.querySelector('[data-csrun]'); if (run) run.onclick = () => runIt(card);
    const add = card.querySelector('[data-csadd]');
    if (add) add.onclick = () => {
      if (!S.result || !S.result.deal) return;
      if (!PI.consider(S.result.deal)) { S.result = { error: 'This deal could not be added: check the inputs above. Your Retirement plan has not changed.' }; }
      draw(card);
      const del = card.querySelector('[data-csdel]'); if (del) del.focus();
    };
    const del = card.querySelector('[data-csdel]'); if (del) del.onclick = () => { PI.consider(null); draw(card); const b = card.querySelector('[data-csadd],[data-csrun]'); if (b) b.focus(); };
    const go = card.querySelector('[data-csgo]'); if (go) go.onclick = () => { const t = document.querySelector('#out [data-tab="runway"]'); if (t) t.click(); };
    const retry = card.querySelector('[data-csretry]');
    if (retry) retry.onclick = () => { S.indexError = null; draw(card); index().then(() => { if (card.isConnected) draw(card); }); };
  }

  /* The included state: what is in the plan, with a link to Retirement and Remove. */
  function includedNote(cur, justThis) {
    return '<p class="note key cs-included"><b>' + (justThis ? 'Included. ' : '') + esc(cur.name) + '</b> (' + short(cur.commitment) + ' from ' + cur.year + ') is in your Retirement plan. '
      + '<button type="button" class="linkish" data-csgo>See it in Retirement</button> · <button type="button" class="linkish" data-csdel>Remove it</button></p>';
  }

  /* WHY THE MONEY LEFT AT THE END MOVED. The money for a new deal comes out of the plan's
     public investments, so the deal is never judged against zero: it is judged against what
     that money would have earned where it was. A deal that returns less than the portfolio's
     expected return lowers the end figure even though it makes money, and the gap compounds
     to the end of the plan. The average outcome is shown next to the typical one because a
     deal whose bad cases lose more than its good cases gain averages below its middle, and
     the retirement plan feels every case, not just the middle one. Reads the run's own
     inputs (r.inputs), never the boxes, so it cannot describe a deal that was not run. */
  function whyLine(r, e) {
    const up = e.endAfter >= e.endBefore;
    let t = '<p class="note key"><b>Why the money left at the end ' + (up ? 'rose' : 'fell') + ':</b> the ' + short(r.inputs.commitment) + ' comes out of your public investments';
    if (r.er != null) t += ', which the Retirement Simulator expects to earn about <b>' + pct(r.er, 1) + '</b> a year';
    t += '. This deal’s typical return is <b>' + (r.irr == null ? 'not known' : pct(r.irr, 1)) + '</b> a year, and its average outcome is <b>' + r.mean.toFixed(2) + '×</b>'
      + (r.mean < r.p50 - 0.005 ? ' (below its typical ' + r.p50.toFixed(2) + '× because its bad cases lose more than its good cases gain)' : '') + '. ';
    t += up ? 'It earns more than that money would have, and the difference compounds to the end of your plan.'
      : 'It earns less than that money would have, so it makes money but leaves you behind where you would have been, and the gap compounds to the end of your plan. A deal can still be worth it for income, diversification or a view the averages do not capture.';
    return t + '</p>';
  }

  /* One headline figure: label, value, a one-line explanation, and an optional pos/neg class. */
  function kpiBox(l, v, sub, cls) {
    return '<div class="mk-kpi"><small>' + l + '</small><b' + (cls ? ' class="' + cls + '"' : '') + '>' + v + '</b><span>' + sub + '</span></div>';
  }

  /* Called by ux.js whenever the Deal Library is on screen: put the card after the first
     card, once per render of the tab. Fetches the deal list if it is not cached. */
  function mount(body) {
    if (!body || body.querySelector('#consider')) return;
    const first = body.querySelector(':scope > .card');
    if (!first) return;
    const card = document.createElement('div');
    card.className = 'card'; card.id = 'consider';
    first.after(card);
    if (root.PlanIncludes && root.PlanIncludes.ctx) check(false);
    draw(card);
    if (!S.index) index().then(() => { if (card.isConnected) draw(card); });
  }

  /* Back to a fresh card on a new book. The deal list stays if it loaded. */
  function reset() {
    const keep = { index: S.index, indexError: null };
    const seq = S.seq + 1;
    Object.keys(S).forEach((k) => delete S[k]);
    Object.assign(S, fresh(), keep, { seq });
  }
  if (root.AppState) root.AppState.onReset(reset);
  else (root.APP_RESET_HOOKS = root.APP_RESET_HOOKS || []).push(reset);

  root.ConsiderUI = { S, mount, reset, short, pct };
}(window));
