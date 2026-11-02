/* WHAT GOES INTO THE RETIREMENT PLAN (prototype), and the app's one reset hook.
 *
 * One place decides what the plan includes, so the three tabs that care cannot disagree:
 *   - your tax strategies, as set up on the Tax Strategies tab;
 *   - capital calls you still owe on your deals (on by default: leaving them out makes the
 *     plan look better than it is);
 *   - a deal you are considering, added on purpose from the Deal Library's "What If I Add
 *     This Deal?" card. Running that card is only a preview (preview() below); the plan
 *     changes when the reader presses "Add to my Retirement plan" (consider()).
 *
 * Retirement shows the panel and runs with these included. Tax Strategies and the Deal
 * Library ask effect() or preview() for the same run with and without their item, on the
 * same seeded futures, so the difference is the item itself and nothing else. Since
 * 2026-10-31 the engine gives every deal its own random stream, so adding a deal to the
 * book no longer reshuffles the futures of the deals already in it (audit M-02).
 *
 * PLACE IN THE APP. Loaded by index.html after taxes-ui.js and before consider-ui.js,
 * markets-ui.js, ux.js and app.js. Exposes two globals:
 *   window.AppState      the session-reset hook every plugin shares (below)
 *   window.PlanIncludes  what the plan includes, plus config/run/effect/preview
 * It reads window.RunwayUI (baseConfig, real), window.Runway (simulate), window.TaxStrategies
 * (S.plan, dated) and Engine (gridYears, callSchedule, calendarNow) at call time, never at
 * load time, so script order among those does not matter.
 *
 * STATE AND RESET. Session-only, like the rest of the app. Every plugin keeps its own
 * session state (a considered deal, filters, recorded balances, slider moves); when a NEW
 * BOOK is loaded all of it must go, or book 2 runs with book 1's what-ifs (QA H2, M1).
 *   AppState.reset(reason)  clears every module's session state, once, in registration order
 *   AppState.onReset(fn)    registers fn(reason); returns a function that unregisters it
 *   window.APP_RESET_HOOKS  an array a module loaded BEFORE this file can push fn onto (the
 *                           same pattern as window.APP_PLUGINS); read at reset time
 *   AppState.noteBook(ctx)  called with each render's ctx; when ctx.book is a different
 *                           object from the last one seen (app.js builds a new book on
 *                           every load), it resets everything and returns true
 * PlanIncludes.remember(ctx) calls noteBook. app.js calls remember() on every successful
 * load and dispatches a 'privatedeals:book' event (detail: ctx), which this file also
 * listens to; every plugin calls remember() at the top of its render too. So nobody has to
 * remember to reset. A hook must only clear its own module's state and must not render.
 *
 * DATA SHAPES.
 *   ctx         { book: [Engine position], mode, sheets: { [name]: rows } } from app.js
 *   deal (in)   { name, commitment (dollars > 0), paid (dollars paid at close, 0..commitment),
 *                 year (calendar year it closes), account, book: [Engine position] }
 *   effect out  { before, after (chance the money lasts, 0..1), endBefore, endAfter (money
 *                 left at the end, typical future, today's dollars), others: [string] }
 *   dated       { [year]: { net (dollars, + in), items: [{label, amount}] } }
 *
 * ASSUMPTIONS AND LIMITS. A considered deal's money in comes out of the plan's public
 * investments; validateDeal refuses a deal that closes before this year (its paid-in would
 * fall before the simulator's first year and vanish while its proceeds still arrived, QA H8
 * and M-13), more than ten years out, or larger than all the public investments (the
 * simulator cannot charge what is not there, QA C2). One considered deal at a time: adding
 * another replaces it.
 */
(function (root) {
  'use strict';

  /* ── the reset hook ─────────────────────────────────────────────────────── */

  const hooks = [];
  let lastBook = null, resetting = false;
  const AppState = {
    /* Clear every registered module's session state. reason is a short string for logs
       ("new book", "user"). Re-entrant calls during a reset are ignored. */
    reset(reason) {
      if (resetting) return;
      resetting = true;
      try {
        const all = hooks.concat(Array.isArray(root.APP_RESET_HOOKS) ? root.APP_RESET_HOOKS : []);
        all.forEach((fn) => { try { if (typeof fn === 'function') fn(reason || 'reset'); } catch (e) { /* one module's bug must not stop the others resetting */ } });
      } finally { resetting = false; }
    },
    /* Register fn(reason) to run on every reset. Returns an unregister function. */
    onReset(fn) {
      if (typeof fn === 'function' && hooks.indexOf(fn) < 0) hooks.push(fn);
      return () => { const i = hooks.indexOf(fn); if (i >= 0) hooks.splice(i, 1); };
    },
    /* Note the book a render was given. A different book object from the last one means a
       new load: reset everything and return true. The first book seen resets nothing,
       because there is nothing from an earlier book to clear. */
    noteBook(ctx) {
      if (!ctx || !ctx.book) return false;
      if (lastBook === ctx.book) return false;
      const changed = lastBook !== null;
      lastBook = ctx.book;
      if (changed) AppState.reset('new book');
      return changed;
    },
    get book() { return lastBook; },
  };

  /* ── what the plan includes ─────────────────────────────────────────────── */

  const DEFAULTS = { tax: true, calls: true, deal: true };
  const S = Object.assign({}, DEFAULTS);
  let considered = null;   // the deal deliberately added to the plan, shape "deal (in)" above
  let lastCtx = null;      // the latest ctx a render was given, for the Deal Library card

  const E = () => ((typeof Engine !== 'undefined' && Engine) ? Engine : root.Engine);
  /* This calendar year, read from the clock every time it is needed (a session that runs
     past midnight on Dec 31 must not keep last year). Engine.calendarNow honours CFG.asOf. */
  const nowYear = () => (E() && E().calendarNow ? E().calendarNow().year : new Date().getFullYear());

  /* Merge one dated stream into another, year by year. Returns `into`. */
  function addDated(into, from) {
    if (!from) return into;
    for (const y of Object.keys(from)) {
      const o = into[y] || (into[y] = { net: 0, items: [] });
      o.net += from[y].net || 0;
      (from[y].items || [{ label: 'dated', amount: from[y].net }]).forEach((it) => o.items.push(it));
    }
    return into;
  }

  /* The capital calls still owed on a set of positions, as money going out (negative), from
     the engine's own call schedule so the Liquidity Outlook and the plan agree. */
  function callsDated(book, label) {
    if (!E() || !book || !book.length) return {};
    const years = E().gridYears(book), sch = E().callSchedule(book, years), out = {};
    for (const y of Object.keys(sch)) if (sch[y] > 0) out[y] = { net: -sch[y], items: [{ label: label || 'Capital calls still owed', amount: -sch[y] }] };
    return out;
  }

  /* True when at least one tax strategy is set up on the Tax Strategies tab. */
  function hasTax() { return !!(root.TaxStrategies && root.TaxStrategies.S && root.TaxStrategies.S.plan && root.TaxStrategies.S.plan.length); }

  /* Which items exist right now (switched on or not). */
  function available() {
    return { tax: hasTax(), calls: true, deal: !!considered };
  }

  /* The plan's public investments in dollars: the sleeves the Retirement Simulator starts
     from. A new deal's money has to come out of these. */
  function liquid(ctx) {
    try {
      const sl = (root.RunwayUI.baseConfig(ctx || lastCtx || {}).C.sleeves) || [];
      return sl.reduce((a, s) => a + (Number(s.balance) || 0), 0);
    } catch (e) { return null; }
  }

  /* CHECK A DEAL BEFORE IT IS PREVIEWED OR ADDED. Returns { ok, errors: { field: message } }
     for the fields commitment, paid and year. `liquidAssets` (dollars) is optional; when it
     is given, a commitment above it is refused. */
  function validateDeal(d, liquidAssets) {
    const errors = {}, y0 = nowYear();
    const c = Number(d && d.commitment);
    if (!(c > 0)) errors.commitment = 'Enter how much you would commit, above $0.';
    else if (c > 1e9) errors.commitment = 'That is more than this tool can model ($1B).';
    else if (liquidAssets != null && liquidAssets >= 0 && c > liquidAssets) {
      errors.commitment = 'That is more than all your public investments ($' + Math.round(liquidAssets).toLocaleString('en-US')
        + '), so the plan has nothing to pay it from.';
    }
    const paid = Number(d && d.paid);
    if (!(paid >= 0) || (c > 0 && paid > c + 0.005)) errors.paid = 'Paid in at close must be between 0% and 100% of the commitment.';
    const yr = Number(d && d.year);
    if (!Number.isInteger(yr)) errors.year = 'Enter the year it would close, such as ' + y0 + '.';
    else if (yr < y0) errors.year = 'The year cannot be in the past. Use ' + y0 + ' or later.';
    else if (yr > y0 + 10) errors.year = 'Use a year no later than ' + (y0 + 10) + '.';
    return { ok: !Object.keys(errors).length, errors };
  }

  /* The Retirement run's inputs with the chosen items included. `inc` overrides S; `cand`
     (optional) stands in for the considered deal, so preview() can run a deal without
     adding it. Returns { C, runCfg, on: [names of what is included] }. */
  function config(ctx, inc, cand) {
    inc = Object.assign({}, S, inc || {});
    const av = available();
    const deal = cand !== undefined ? cand : considered;
    const useDeal = !!(inc.deal && deal), useTax = inc.tax && av.tax;
    const book = (ctx && ctx.book ? ctx.book : []).concat(useDeal ? deal.book : []);
    const base = root.RunwayUI.baseConfig(Object.assign({}, ctx, { book }));
    const dated = addDated({}, base.port ? base.port.dated : null);
    if (useTax) addDated(dated, root.TaxStrategies.dated(ctx));
    if (inc.calls) addDated(dated, callsDated(ctx && ctx.book));
    if (useDeal) {
      /* a deal you add always brings its own money going in: what is paid at close, then its calls */
      addDated(dated, { [deal.year]: { net: -deal.paid, items: [{ label: deal.name + ': paid in at close', amount: -deal.paid }] } });
      addDated(dated, callsDated(deal.book, deal.name + ': capital calls'));
    }
    const on = [];
    if (useTax) on.push('your tax strategies');
    if (inc.calls) on.push('capital calls still owed');
    if (useDeal) on.push(deal.name);
    return { C: base.C, runCfg: Object.assign({}, base.runCfg, { dated: Object.keys(dated).length ? dated : null }), on };
  }

  /* One Retirement run (default 1,200 lifetimes, the Retirement tab's own count). */
  function run(ctx, inc, paths, cand) {
    const c = config(ctx, inc, cand);
    return { r: root.Runway.simulate(Object.assign({}, c.runCfg, { paths: paths || 1200 })), C: c.C, on: c.on };
  }

  /* Money left at the end, typical future (median terminal wealth), in today's dollars. */
  function ending(res) {
    const r = res.r, last = r.curve[r.curve.length - 1];
    return root.RunwayUI.real(r.terminal.p50, last ? last.year : nowYear(), res.C);
  }

  /* The plan with and without one item ('tax' | 'calls' | 'deal'), everything else as
     currently set, on the same futures. null when either run cannot be made. */
  function effect(ctx, key, paths) {
    const off = run(ctx, { [key]: false }, paths || 1200), on = run(ctx, { [key]: true }, paths || 1200);
    if (!off.r || !on.r) return null;
    const own = key === 'tax' ? 'your tax strategies' : key === 'deal' && considered ? considered.name : 'capital calls still owed';
    return { before: off.r.neverShort, after: on.r.neverShort, endBefore: ending(off), endAfter: ending(on), others: on.on.filter((x) => x !== own) };
  }

  /* A PREVIEW: the plan without any considered deal, against the plan with this one in its
     place, everything else as set. Changes nothing. Same result shape as effect(). */
  function preview(ctx, cand, paths) {
    if (!cand) return null;
    const off = run(ctx, { deal: false }, paths || 1200), on = run(ctx, { deal: true }, paths || 1200, cand);
    if (!off.r || !on.r) return null;
    return { before: off.r.neverShort, after: on.r.neverShort, endBefore: ending(off), endAfter: ending(on), others: on.on.filter((x) => x !== cand.name) };
  }

  /* Add a deal to the plan on purpose (the Deal Library's "Add to my Retirement plan"), or
     take it out with null. A deal that fails validateDeal is refused: the plan is left as it
     was and false is returned. */
  function consider(d) {
    if (d == null) { considered = null; return true; }
    if (!validateDeal(d).ok || !d.book || !d.book.length) return false;
    considered = d; S.deal = true;
    return true;
  }

  /* The Deal Library is drawn by app.js, which hands its added cards no book. app.js calls
     remember() on every load, and every plugin tab calls it at the top of its render, so this
     always holds the book on screen. A new book resets every module (AppState.noteBook). */
  function remember(ctx) {
    if (!ctx || !ctx.book) return;
    AppState.noteBook(ctx);
    lastCtx = ctx;
  }

  /* Back to a fresh session: no considered deal, every include switch at its default. The
     remembered ctx is kept, because it is the book now on screen. */
  function reset() {
    considered = null;
    Object.keys(S).forEach((k) => delete S[k]);
    Object.assign(S, DEFAULTS);
  }
  AppState.onReset(reset);

  /* app.js dispatches privatedeals:book on every successful load (and also calls remember()
     directly). Either one is enough; remember() is idempotent for the same book. */
  if (typeof root.addEventListener === 'function') {
    root.addEventListener('privatedeals:book', (e) => { if (e && e.detail) remember(e.detail); });
  }

  root.AppState = AppState;
  root.PlanIncludes = { S, available, config, run, effect, preview, ending, consider, validateDeal, liquid, callsDated, remember, reset, nowYear,
    get considered() { return considered; }, get ctx() { return lastCtx; } };
}(window));
