/* THE RETIREMENT TAB (the Liquidity Runway's screen).
 *
 * PURPOSE. Draws the Retirement Simulator: the controls, "Included in This Plan", the
 * headline (never short, share of target, ending wealth), the money-over-time fan, the
 * stop-year comparison, what breaks first, the levers, where each year's money comes from,
 * one traced year-by-year ledger, and the methodology note. All the arithmetic is in
 * runway.js; this file builds its config and turns the result into HTML.
 *
 * WHERE IT SITS. Registers itself through the plugin hook in app.js (window.APP_PLUGINS),
 * which is why app.js can stay byte-identical between this app and the live Private Deals
 * one. It reads Portfolio (portfolio.js: the You, Balances, Property, Cashflows and Events
 * tabs), Markets (markets.js: holdings to sleeves, private account names), Engine (the deal
 * book simulation) and PlanIncludes (includes.js: tax strategies, capital calls, a deal being
 * considered). Other tabs read it back through window.RunwayUI:
 *   baseConfig(ctx) -> { C, port, sim, runCfg }   C is the merged config (sample, then sheet,
 *                      then sliders); runCfg is C plus the deal simulation, the dated money
 *                      (portfolio.js datedFlows) and the deal tax mix, ready for
 *                      Runway.simulate. includes.js builds every plan from this.
 *   stopYear(ctx) -> integer                       the stop year in force.
 *   expectedReturn(ctx) -> decimal | null          balance-weighted mu + yield of the sleeves.
 *   real(v, year, C, r?) -> today's dollars        see real() below.
 *   money(v) -> "$1,234" ;  dealTaxMix(book) -> { preTax, taxable, roth } | null ;
 *   reset() -> clears the slider overrides.
 * ctx is what app.js hands every plugin: { book: [engine rows], mode, sheets: { name: aoa } }.
 *
 * THE SPLIT THIS TAB IS BUILT ON. The sheet holds what is true: balances, ages, a benefit
 * estimate. The app holds what is assumed, as controls you can move and watch move. Until a
 * reader supplies a You tab and a Balances tab, the figures are a FICTIONAL sample household,
 * and the panel says so, so nobody reads a made-up plan as their own.
 *
 * INVARIANTS.
 *   - Every "never short" on this tab for the current stop year is the same number: the
 *     comparison table's highlighted row IS the headline run, not a re-run.
 *   - The must-have floor never exceeds the spend target (it is clamped, and its slider is
 *     capped), and its slider is disabled unless the spending mode uses it.
 *   - A slider recomputes on change (release), not on every input tick, and the focused
 *     control keeps focus across the re-render.
 *   - Today's dollars use the simulator's own inflation path (inflPre before the stop year,
 *     inflPost from it), not one rate for every year.
 *   - Rendered copy has no em or en dashes, and every name from a file is escaped.
 *
 * ASSUMPTIONS AND SIMPLIFICATIONS. Deal proceeds are taxed at one blended rate, the deals'
 * Account column weighted by commitment (Self-Directed IRA and blank as pre-tax, personal or
 * taxable accounts as taxable, Roth as Roth). Dated money arrives already in nominal dollars
 * from portfolio.js (which grows Cashflows rows marked to inflate); runway.js can also take a
 * dated item flagged inflates: true and inflate it on each path's own price level.
 * Slider overrides live in memory only and are cleared when a new book is loaded.
 *
 * KNOWN LIMITS. Every slider move re-runs the headline, five stop-year rows and the levers
 * (about a dozen simulations); a few hundred milliseconds in a browser, longer on a slow
 * machine. Historical sampling is not exposed here yet.
 */
(function (root) {
  'use strict';

  /* A FICTIONAL SAMPLE HOUSEHOLD. Round numbers on purpose, so nobody mistakes them for a
     real plan. Money in today's dollars a year. Replace it with your own by adding a You tab
     and a Balances tab. The sleeves here are used only when neither a Balances tab nor the
     Markets module supplies any. */
  const DEMO = {
    label: 'a fictional sample household, so you can see what a filled-in plan looks like',
    birthYear: 1972,
    stopYear: 2035,
    planToAge: 92,
    spend: 200000,
    floorSpend: 160000,
    benefitAge: 67,
    benefitAnnual: 42000,
    sleeves: [
      { id: 'growth', label: 'Growth', kind: 'growth', balance: 1100000 },
      { id: 'income', label: 'Income', kind: 'income', balance: 350000 },
      { id: 'cash', label: 'Cash', kind: 'cash', balance: 150000 },
    ],
  };

  /* LIVE CONTROL STATE: the slider and button overrides, keyed by config field. Session only
     on purpose: this app stores nothing. Moving a slider is a what-if, not a saved preference.
     Cleared when a new book arrives (a new upload starts clean). */
  const LIVE = {};
  let lastBook = null;
  /* The headline of the previous render, so a change can say how far it moved the number. */
  let lastHeadline = null;

  const MODES = [
    ['fixed', 'Fixed real spend', 'Ask for the full target every year, whatever the markets did.'],
    ['guard', 'Guardrails', 'Trim the ask in thin years (to 90% or 80% of the target), restore it in good ones.'],
    ['floor', 'Income floor first', 'Only ever ask for the must-have number.'],
  ];

  /* A number or its default, so a deliberate 0 is kept (0% inflation is a real input). */
  function numOr(v, d) {
    const n = Number(v);
    return v != null && v !== '' && Number.isFinite(n) ? n : d;
  }

  /* NOMINAL TO TODAY'S DOLLARS. Every figure the model produces is in the dollars of its own
     year, because the arithmetic needs that. On screen that is a trap: $12m in 2067 reads as
     generational wealth and is a third of that in today's dollars.

     real(v, year, C, r) = v / priceLevel(year). With a simulation result r whose curve carries
     the median price index for that year, the index is used (it is exact in normal mode and
     the median path's CPI in historical mode). Otherwise it is computed the way runway.js
     inflates the target: (1 + inflPre) for each year from thisYear to the stop year, then
     (1 + inflPost) for each year after. It used to deflate every year at inflPost, which
     overstated a figure twenty-five years out by about 4.5%. */
  function real(v, year, C, r) {
    if (r && r.curve) {
      const row = r.curve.find((c) => c.year === year);
      if (row && row.index > 0) return v / row.index;
    }
    const base = (C && C.thisYear) || new Date().getFullYear();
    const stop = C && C.stopYear != null ? C.stopYear : base;
    const pre = numOr(C && C.inflPre, 0.035), post = numOr(C && C.inflPost, 0.03);
    const a = Math.max(0, Math.min(year, stop) - base);
    const b = Math.max(0, year - Math.max(stop, base));
    return v / (Math.pow(1 + pre, a) * Math.pow(1 + post, b));
  }

  /* HTML-escape anything that came from a file or a user (names, labels) before it is put
     into markup. */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  /* Whole dollars with separators, a hyphen for negatives: "-$1,234". */
  const money = (v) => (v < 0 ? '-' : '') + '$' + Math.round(Math.abs(v)).toLocaleString('en-US');
  /* A share (decimal) as a whole percent: 0.586 -> "59%". */
  const pct = (v) => (v * 100).toFixed(0) + '%';
  /* A share (decimal) to one place: 0.0725 -> "7.3%". */
  const pct1 = (v) => (v * 100).toFixed(1) + '%';
  /* "1 point" / "-3 points", for differences of whole percents. */
  const pts = (d) => (d > 0 ? '+' : '') + d + (Math.abs(d) === 1 ? ' point' : ' points');

  /* You-tab fields that belong to Tax Strategies, not to the plan. */
  const TAX_ONLY = ['filingStatus', 'w2Now', 'retireIncome'];

  /* WHAT A MEMBER'S FILE MUST CARRY before Retirement shows a result (grill Q20, 2026-11-01):
     the five You-tab figures below and a Balances or Holdings tab. Each entry is the field and
     the label to type in column A of the You tab. A zero is an answer (no Social Security, no
     public money); only a missing row or a blank cell counts as missing. */
  const REQUIRED_YOU = [
    ['birthYear', 'Birth year'],
    ['stopYear', 'Planned stop work year'],
    ['spend', 'Annual spend target'],
    ['benefitAnnual', 'Estimated annual benefit'],
    ['benefitAge', 'Benefit start age'],
  ];
  /* The labels still missing from a member's file, or null when nothing is missing. The
     sample household (no file) and the example book (an empty sheet set) are never gated:
     they are demonstrations, and say so. A Balances or Holdings tab counts when it is there
     at all, even with no positive row, so a member with nothing outside their deals types a
     Cash row of 0 rather than leaving the tab out. */
  function missingRequired(port, ctx) {
    const sheets = ctx && ctx.sheets;
    if (!sheets || !Object.keys(sheets).length) return null;
    const you = (port && port.you) || {};
    const miss = REQUIRED_YOU.filter(([k]) => you[k] == null || Number.isNaN(you[k])).map(([, l]) => l);
    const mk = root.Markets ? root.Markets.load(sheets) : null;
    const named = Object.keys(sheets).some((n) => /^\s*(balances?|holdings?)\b/i.test(n));
    const hasBal = !!(port && port.balances) || named
      || !!(mk && (mk.source === 'balances' || mk.source === 'holdings'));
    if (!hasBal) miss.push('A Balances tab (or a Holdings tab)');
    return miss.length ? miss : null;
  }

  /* The card shown in place of the plan while missingRequired has anything to say. */
  function requiredCard(miss) {
    return '<div class="card"><h2>Retirement Simulator</h2>'
      + '<p class="note key"><b>Your file needs ' + miss.length + ' more '
      + (miss.length === 1 ? 'figure' : 'figures') + ' before this page can plan your retirement.</b> '
      + 'Without them the plan would run on a sample household’s age, spending and savings, and the '
      + 'answer would not be yours. Add these to your tracker and upload it again:</p>'
      + '<ul class="rw-need">' + miss.map((m) => '<li>' + esc(m) + '</li>').join('') + '</ul>'
      + '<p class="note">The first five go on the <b>You</b> tab, one per row: the label in column A, '
      + 'your number in column B. Type 0 for a benefit you will not get. The Balances tab lists each '
      + 'account outside your private deals (401k, IRA, brokerage, cash) with its value; if you hold '
      + 'nothing outside your deals, add one Cash row with 0. The tracker template has all of them: '
      + '<a href="tracker-template.xlsx" download>download it</a> and copy the You and Balances tabs '
      + 'into your file. Your deals, Overview and the other tabs work without them.</p></div>';
  }

  /* What the workbook said, if it said anything: a Portfolio.build result, or null when the
     sheets carry none of the plan tabs. Parsed fresh per call from the sheets app.js kept. */
  function fromSheet(ctx) {
    if (!root.Portfolio || !ctx || !ctx.sheets) return null;
    const p = root.Portfolio.build(ctx.sheets, ctx.book || []);
    return p && p.hasAny ? p : null;
  }

  /* THE CONFIG BEFORE THE SLIDERS: the sample underneath, the holdings (or a Balances tab)
     for sleeves, the sheet's You tab over it. Each layer only covers what the one below it
     left, so a sheet that names three fields does not drag the other six back to a default.
     This is also what a moved slider is compared against ("your tracker says"). */
  function cfgBase(port, ctx) {
    const base = Object.assign({}, DEMO);
    /* PUBLIC HOLDINGS FEED THE PLAN. Unless the sheet has a Balances tab, the sleeves come
       from the holdings on the Holdings tab: each sleeve carries the return, volatility,
       yield and tax mix of what is actually in it, and the correlation between sleeves. */
    if (root.Markets) {
      const mk = root.Markets.load(ctx && ctx.sheets);
      const sv = root.Markets.toSleeves(mk.holdings);
      if (sv.sleeves.length) {
        base.sleeves = sv.sleeves; base.corr = sv.corr; base.fromHoldings = true;
        base.holdingsAreSample = !!mk.isDemo;
      } else if (mk.source === 'none') {
        /* The member's file has no public money: plan on the private deals alone rather than
           the sample household's sleeves. */
        /* The simulator needs one sleeve to land deal cash in, so a private-only plan gets a
           single Cash sleeve holding $1 (taxable). Deal proceeds and coupons arrive into it
           and earn the cash yield; capital calls are paid from it, and whatever it cannot
           pay is a shortfall. */
        base.sleeves = [{ id: 'cash', label: 'Cash from your deals', kind: 'cash', balance: 1, taxMix: { preTax: 0, roth: 0, taxable: 1 } }];
        base.corr = null; base.fromHoldings = false; base.noPublic = true;
      }
    }
    if (port) {
      if (port.you) Object.keys(port.you).forEach((k) => {
        if (TAX_ONLY.indexOf(k) < 0 && k.charAt(0) !== '_' && port.you[k] != null && !Number.isNaN(port.you[k])) {
          base[k] = port.you[k];
        }
      });
      if (port.sleeves && port.sleeves.length) {
        base.sleeves = port.sleeves; base.corr = null; base.fromHoldings = false;
      }
    }
    return base;
  }

  /* THE CONFIG IN FORCE: cfgBase with the reader's controls on top, and the floor held at or
     below the spend target. Lowering the target below the floor moves the floor down with it,
     because a must-have larger than the whole target is not a plan anyone has. */
  function cfg(port, ctx) {
    const C = Object.assign(cfgBase(port, ctx), LIVE);
    if (Number(C.floorSpend) > Number(C.spend)) C.floorSpend = C.spend;
    return C;
  }

  /* THE TAX BUCKET OF THE DEAL BOOK, as a mix { preTax, taxable, roth } weighted by
     commitment (the money at stake; proceeds are not known until a path is drawn). The
     account rule is the one Overview uses (Markets.privateAccount): IRA-like names and a
     blank go to the Self-Directed IRA (pre-tax), personal or taxable names to Private Deals
     (taxable), Roth stays Roth. Null for an empty book, which runway.js reads as pre-tax. */
  function dealTaxMix(book) {
    const rows = (book || []).filter((b) => b && (Number(b.commitment) || Number(b.funded)) > 0);
    if (!rows.length) return null;
    const M = root.Markets;
    const mix = { preTax: 0, taxable: 0, roth: 0 };
    let tot = 0;
    rows.forEach((b) => {
      const w = Number(b.commitment) || Number(b.funded) || 0;
      let bucket;
      if (M && M.privateAccount) {
        const acct = M.privateAccount(b.account);
        bucket = acct === M.PRIV_TAXABLE ? 'taxable' : M.acctType(acct);
      } else {
        const a = String(b.account || '').toLowerCase();
        bucket = /roth/.test(a) ? 'roth'
          : (!a || /ira|self.?direct|401|pre.?tax|checkbook|solo/.test(a)) ? 'preTax' : 'taxable';
      }
      mix[bucket] = (mix[bucket] || 0) + w;
      tot += w;
    });
    if (!tot) return null;
    return { preTax: mix.preTax / tot, taxable: mix.taxable / tot, roth: mix.roth / tot };
  }

  /* SECTION: THE CONTROLS. No slider recomputes on input; see wire(). */

  /* Formatters for each slider's value label, shared by the markup and the live update. */
  const FMT = {
    stopYear: (v) => String(v),
    spend: money,
    floorSpend: money,
    benefitAge: (v) => 'age ' + v,
  };

  /* One labelled range input. anchor is the value before the sliders (the sheet's or the
     sample's); a moved slider says so and names the anchor. disabledNote, when given,
     disables the control and says why. */
  function slider(id, label, min, max, step, val, anchor, sourceWord, disabledNote) {
    const moved = LIVE[id] != null && LIVE[id] !== anchor;
    const fmt = FMT[id];
    return '<label style="display:block;margin:0 0 14px' + (disabledNote ? ';opacity:.55' : '') + '">'
      + '<span style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">'
      + '<span>' + esc(label) + (moved ? ' <b style="color:#B17930">(moved)</b>' : '') + '</span>'
      + '<b data-rwval="' + id + '">' + fmt(val) + '</b></span>'
      + '<input type="range" data-rw="' + id + '" min="' + min + '" max="' + max
      + '" step="' + step + '" value="' + val + '" style="width:100%"'
      + (disabledNote ? ' disabled aria-describedby="rwhint-' + id + '"' : '') + '>'
      + (disabledNote ? '<span class="note" id="rwhint-' + id + '" style="font-size:11px">' + disabledNote + '</span>'
        : moved ? '<span class="note" style="font-size:11px">' + sourceWord + ' ' + fmt(anchor) + '</span>' : '')
      + '</label>';
  }

  /* The assumptions card. C is the config in force, A the config before the sliders. */
  function panelControls(C, A, port) {
    const anyMoved = Object.keys(LIVE).length > 0;
    const src = port ? 'your tracker says' : 'sample value:';
    const thisYear = C.thisYear || new Date().getFullYear();
    let h = '<div class="card"><h2>The assumptions</h2>'
      + '<p class="note">Everything here starts from your tracker (or the sample) and can be '
      + 'moved without editing it. A moved control says so, and says what the tracker said, '
      + 'so a what-if is never mistaken for what you wrote down. Nothing is saved: reload, or '
      + 'load another file, and you are back to your own numbers. The plan recalculates when '
      + 'you let go of a slider.</p>';

    const step = 5000;
    const stopMin = Math.min(C.stopYear, Math.max(thisYear, A.stopYear - 10));
    const stopMax = Math.max(stopMin + 1, A.stopYear + 12);
    const spMin = Math.round(A.spend * 0.5 / step) * step, spMax = Math.round(A.spend * 1.5 / step) * step;
    /* THE FLOOR IS CAPPED AT THE TARGET, and only matters in "Income floor first": the other
       two modes never ask for it, so in those it is shown disabled with the reason. */
    const flMax = Math.max(step, Math.floor(C.spend / step) * step);
    const flMin = Math.min(flMax, Math.round(A.floorSpend * 0.5 / step) * step);
    const floorOff = (C.mode || 'guard') !== 'floor'
      ? 'Used only by "Income floor first". The other modes never ask for less than 80% of the target.' : '';

    h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:0 24px;margin-top:14px">';
    h += slider('stopYear', 'Stop work in', stopMin, stopMax, 1, C.stopYear, A.stopYear, src);
    h += slider('spend', 'Annual spend target (today\'s dollars)', spMin, spMax, step, C.spend, A.spend, src);
    h += slider('floorSpend', 'Must-have spending (floor)', flMin, flMax, step,
      Math.min(C.floorSpend, flMax), Math.min(A.floorSpend, A.spend), src, floorOff);
    h += slider('benefitAge', 'Start Social Security at', 62, 70, 1,
      C.benefitAge, A.benefitAge, src);
    h += '</div>';

    h += '<div style="margin-top:6px"><div style="font-size:13px;margin-bottom:6px">How the plan spends</div>'
      + '<div class="row">'
      + MODES.map(([k, l]) => '<button data-rwmode="' + k + '"'
          + (C.mode === k || (!C.mode && k === 'guard') ? ' class="on"' : '') + '>' + l + '</button>').join('')
      + '</div>'
      + '<p class="note" style="margin-top:8px">'
      + esc((MODES.find(([k]) => k === (C.mode || 'guard')) || MODES[1])[2]) + '</p></div>';

    /* HOW THE PORTFOLIO IS MANAGED. Rebalancing restores the mix at the end of every year,
       which erases where the withdrawal came from, so with it on the draw order does nothing
       at all. Presenting them as independent would invite fiddling with one that cannot move. */
    const reb = LIVE.rebalance === undefined ? 'annual' : LIVE.rebalance;
    const ORD = (root.Runway && root.Runway.DRAW_ORDERS) || {};
    const ordKey = LIVE.drawOrder || 'safe-first';

    h += '<div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--rule)">'
      + '<div style="font-size:13px;margin-bottom:6px">Rebalancing</div>'
      + '<div class="row">'
      + '<button data-rwreb="annual"' + (reb === 'annual' ? ' class="on"' : '') + '>Rebalance every year</button>'
      + '<button data-rwreb="none"' + (reb === 'none' ? ' class="on"' : '') + '>Never rebalance</button>'
      + '</div>'
      + '<p class="note" style="margin-top:8px">'
      + (reb === 'annual'
          ? 'Each year the mix is restored to the one you started with. This is what most '
            + 'people actually do, and it stops the growth sleeve quietly taking over until '
            + 'the plan is riskier than the one you described.'
          : '<span class="warn">The mix is left to drift.</span> Growth compounds and the '
            + 'safer sleeves get spent, so a plan that starts balanced can end up almost '
            + 'entirely in equities. It scores better here and it is a stronger claim than it '
            + 'looks.')
      + '</p></div>';

    h += '<div style="margin-top:14px">'
      + '<div style="font-size:13px;margin-bottom:6px">Which sleeve pays first'
      + (reb === 'annual' ? ' <span style="color:var(--muted);font-weight:400">(no effect while rebalancing)</span>' : '')
      + '</div>'
      + '<div class="row"' + (reb === 'annual' ? ' style="opacity:.45"' : '') + '>'
      + Object.keys(ORD).map((k) => '<button data-rword="' + k + '"'
          + (ordKey === k ? ' class="on"' : '') + '>' + esc(ORD[k].label) + '</button>').join('')
      + '</div>'
      + '<p class="note" style="margin-top:8px">'
      + (reb === 'annual'
          ? '<b>While you rebalance, this choice does nothing.</b> Restoring the mix at the '
            + 'end of each year erases where the money came from, so all three give the same '
            + 'answer. Turn rebalancing off and they differ by tens of points.'
          : esc((ORD[ordKey] || {}).note || ''))
      + '</p></div>';

    if (anyMoved) {
      h += '<div class="row" style="margin-top:10px"><button data-rwreset="1">Reset to '
        + (port ? 'my tracker' : 'the sample') + '</button></div>';
    }
    return h + '</div>';
  }

  /* SECTION: THE ANSWER */

  /* The headline card. r is the full-size run; prev the previous render's never short (or
     null), so a change says how far it moved the number. */
  function panelHeadline(r, prev) {
    /* One KPI tile. key goes on the value as data-rwkpi, so tests and other layers (ux.js
       renames labels) can find a figure without depending on its wording. */
    const kpi = (l, v, note, key) => '<div style="flex:1;min-width:150px">'
      + '<div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)">' + l + '</div>'
      + '<div style="font-size:26px;font-weight:700;margin:2px 0"' + (key ? ' data-rwkpi="' + key + '"' : '') + '>' + v + '</div>'
      + (note ? '<div class="note" style="font-size:11px">' + note + '</div>' : '') + '</div>';
    const endYear = r.cfg.birthYear + r.endAge;
    const d = prev == null ? 0 : Math.round(r.neverShort * 100) - Math.round(prev * 100);
    const mode = (MODES.find(([k]) => k === r.cfg.mode) || MODES[1])[1];
    return '<div class="card"><h2>Will the money last</h2>'
      + '<p class="note">' + r.cfg.paths.toLocaleString('en-US') + ' simulated lifetimes, '
      + 'from age ' + r.stopAge + ' to ' + r.endAge + ', spending under <b>' + esc(mode)
      + '</b>. <b>Never short</b> means the plan met what it asked for in every single year '
      + 'of that lifetime, including every bill dated before you stop. One thin year is '
      + 'enough to fail it, which is a harder test than it sounds.</p>'
      + '<div style="display:flex;flex-wrap:wrap;gap:20px;margin-top:14px">'
      + kpi('Never short', pct(r.neverShort) + (d ? ' <span style="font-size:13px;font-weight:600;color:'
          + (d > 0 ? '#2E6B52' : '#A33A1F') + '">(' + pts(d) + ')</span>' : ''),
          'of ' + r.cfg.paths.toLocaleString('en-US') + ' lifetimes' + (d ? ', change since your last move' : ''), 'neverShort')
      + kpi('Of the full target', pct(r.share), 'typical run, spending only')
      + kpi('Worst thin run', r.worstRun + (r.worstRun === 1 ? ' year' : ' years'), 'below 90% of the ask')
      + kpi('Left at the end', money(real(r.terminal.p50, endYear, r.cfg, r)),
            'in today\'s dollars, typical run (' + money(r.terminal.p50) + ' in ' + endYear + ' dollars)', 'left')
      + '</div>'
      + (r.preStop
          ? '<p class="note" style="margin-top:14px"><span class="warn">Money going out before '
            + 'you stop could not always be paid.</span> In ' + pct(r.preStop.share) + ' of '
            + 'lifetimes the capital calls, down payments and other bills dated before '
            + r.stopYear + ' were larger than everything in the accounts; typically '
            + money(r.preStop.gapP50) + ' went unpaid. Those lifetimes count as short.</p>'
          : '')
      + '<p class="note" style="margin-top:14px"><b>Read the two together.</b> A plan can be '
      + 'never short simply by asking for little: the income-floor mode does exactly that, '
      + 'and its share of the full target is where the cost shows up. Neither number means '
      + 'much without the other.</p>'
      + (r.hasDeals
          ? '<p class="note"><b class="pos">Your private deals are in these figures.</b> '
            + 'Each lifetime here spends one coherent future of that book: the same model the '
            + 'other tabs run, not an average of it.</p>'
          : '<p class="note"><span class="warn">No private deals are feeding this.</span> '
            + 'The runway is running on the liquid sleeves alone.</p>')
      + '</div>';
  }

  /* SECTION: WHERE EACH YEAR'S MONEY COMES FROM */

  /* A colour per source: the benefit, dated money and deals fixed, each sleeve its Holdings
     colour when Markets knows it, otherwise a fallback by kind, then a neutral blue. */
  function colourOf(k) {
    const FIX = { benefit: '#2E6B52', dated: '#1F3864', deals: '#7B5EA7' };
    if (FIX[k]) return FIX[k];
    const G = root.Markets && root.Markets.GROUPS;
    if (G && G[k] && G[k].color) return G[k].color;
    return ({ growth: '#4C7BD9', income: '#B17930', cash: '#6B7A8C', bonds: '#3E8C7A' })[k] || '#8FA8C8';
  }

  /* Stacked bars of the median amount from each source per drawing year (nominal), with the
     full target as a dashed line. Sleeve bars are gross withdrawals, before their tax. */
  function compositionChart(r) {
    const rows = r.byYear;
    const W = 860, H = 300, L = 62, B = 30, T = 14, R = 10;
    const keys = ['benefit', 'dated', 'deals'].concat(r.sleeves.map((s) => s.id));
    const nameOf = { benefit: 'Social Security', dated: 'Property, pensions, one-offs', deals: 'Private deals' };
    r.sleeves.forEach((s) => { nameOf[s.id] = s.label; });

    let top = 0;
    rows.forEach((y) => {
      let t = 0; keys.forEach((k) => { t += (y.from[k] || 0); });
      if (t > top) top = t;
      if (y.need > top) top = y.need;
    });
    if (top <= 0) return '';

    const iw = W - L - R, ih = H - T - B;
    const bw = Math.max(2, (iw / rows.length) * 0.74);
    const x = (i) => L + (iw / rows.length) * (i + 0.5);
    const y = (v) => T + ih - (v / top) * ih;

    let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block" '
      + 'role="img" aria-label="Where each year’s money comes from, by source">';
    for (let g = 0; g <= 4; g++) {
      const v = top * g / 4;
      s += '<line x1="' + L + '" y1="' + y(v) + '" x2="' + (W - R) + '" y2="' + y(v)
        + '" stroke="#E4E9F0" stroke-width="1"/>'
        + '<text x="' + (L - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end" font-size="10" '
        + 'fill="#6B7A8C">' + (v >= 1000 ? '$' + Math.round(v / 1000) + 'k' : '$0') + '</text>';
    }
    rows.forEach((row, i) => {
      let acc = 0;
      keys.forEach((k) => {
        const v = row.from[k] || 0;
        if (v <= 0) return;
        const y1 = y(acc + v), y0 = y(acc);
        s += '<rect x="' + (x(i) - bw / 2) + '" y="' + y1 + '" width="' + bw
          + '" height="' + Math.max(0, y0 - y1) + '" fill="' + colourOf(k) + '"'
          + ' stroke="#fff" stroke-width="0.5"><title>' + row.year + ', ' + esc(nameOf[k] || k)
          + ': ' + money(v) + '</title></rect>';
        acc += v;
      });
    });
    let d = '';
    rows.forEach((row, i) => { d += (i ? 'L' : 'M') + x(i) + ' ' + y(row.need); });
    s += '<path d="' + d + '" fill="none" stroke="#141A22" stroke-width="2" stroke-dasharray="5 3"/>';
    rows.forEach((row, i) => {
      if (i % 5 && i !== rows.length - 1) return;
      s += '<text x="' + x(i) + '" y="' + (H - 10) + '" text-anchor="middle" font-size="10" '
        + 'fill="#6B7A8C">' + row.year + '</text>';
    });
    return s + '</svg>';
  }

  /* The composition card, with a legend built from the sleeves actually in the run. */
  function panelComposition(r) {
    const key = (k, label) => '<span style="display:inline-flex;align-items:center;gap:6px;margin-right:14px">'
      + '<span style="width:10px;height:10px;border-radius:2px;background:' + colourOf(k) + ';display:inline-block"></span>'
      + '<span style="font-size:12px">' + esc(label) + '</span></span>';
    return '<div class="card"><h2>Where each year’s money comes from</h2>'
      + '<p class="note">One bar per year of the plan, stacked by what paid for it, in the '
      + 'dollars of each year. The dashed line is the full target, so <b>the gap between the '
      + 'bars and the line is the shortfall</b>. Sleeve bars are what was withdrawn before '
      + 'tax, so in a taxed plan they rise above the line by the tax. This is the panel that '
      + 'shows what the private deals are for: they arrive in lumps, in particular years, and '
      + 'either cover a gap the liquid sleeves could not or they do not.</p>'
      + '<div style="margin:10px 0 4px">'
      + key('benefit', 'Social Security') + key('dated', 'Property, pensions, one-offs')
      + key('deals', 'Private deals')
      + r.sleeves.map((s) => key(s.id, s.label)).join('')
      + '</div>'
      + compositionChart(r)
      + '<p class="note" style="margin-top:10px">Each bar is the <b>typical</b> amount from '
      + 'that source in that year, so the bars are a picture of a normal run rather than a '
      + 'total you can add across the chart.</p></div>';
  }

  /* WHERE EVERY NUMBER CAME FROM. A page that mixes the reader's own figures with invented
     ones and does not distinguish them is worse than one that invents everything. */
  function sourceNote(port, C) {
    const holdings = C.fromHoldings
      ? (C.holdingsAreSample ? 'Balances come from the sample household\'s public holdings (the Holdings tab).'
        : 'Balances come from <b>your Holdings tab</b>, grouped into the same sleeves it shows.')
      : '';
    if (C.noPublic && !port) {
      return '<p class="note key"><b>Your private deals only.</b> Your file has no Holdings, Balances or You tab, so this plan has no public money: your deals’ payouts land in a cash account that pays your calls and spending, '
        + 'and your age, spending and Social Security are <b>sample assumptions</b>. Add a You tab and a Holdings tab for a plan that is yours.</p>';
    }
    if (!port) {
      return '<p class="note"><b>Sample household.</b> ' + holdings + '</p>';
    }
    const bits = [];
    if (port.you) {
      bits.push('the <b>' + esc(port.you._sheet) + '</b> tab supplied '
        + port.you._fields.length + ' of your own figures');
    }
    if (port.balances) {
      const tot = port.sleeves.reduce((a, s) => a + s.balance, 0);
      bits.push('<b>' + esc(port.balances.sheet) + '</b> supplied '
        + port.balances.rows.length + ' holdings worth ' + money(tot)
        + ' across ' + port.sleeves.length + ' sleeve' + (port.sleeves.length === 1 ? '' : 's'));
    }
    if (C.noPublic) bits.push('your file holds <b>no public money</b>, so your deals’ payouts land in a cash account that pays your calls and spending');
    let h = '<p class="note"><b class="pos">Running on your tracker.</b> ' + (bits.length ? bits.join(', and ') + '. ' : '')
      + (port.balances ? '' : holdings + ' ')
      + 'Anything your tracker did not say still comes from the sample household’s '
      + 'figures, so a blank on your tracker is not a blank on this page.</p>';

    const defaulted = (port.sleeves || []).filter((s) => s.mu == null).map((s) => s.label);
    if (port.balances && defaulted.length) {
      h += '<p class="note">No expected return was given for <b>' + esc(defaulted.join(', '))
        + '</b>, so ' + (defaulted.length === 1 ? 'it uses' : 'they use')
        + ' the model’s own assumption. Put a figure in the <b>Expected return %</b> '
        + 'column to argue with it.</p>';
    }
    const odd = (port.sleeves || []).filter((s) => s.unknownSleeveValue > 0);
    if (odd.length) {
      h += '<p class="note"><span class="warn">Sleeve names not recognised.</span> '
        + money(odd.reduce((a, s) => a + s.unknownSleeveValue, 0)) + ' was filed as Growth '
        + 'because its sleeve did not match Growth, Income, Bonds or Cash.</p>';
    }
    if (port.dealsWithoutAccount > 0) {
      h += '<p class="note">' + port.dealsWithoutAccount + ' of your ' + port.dealCount
        + ' deals carry no <b>Account</b>, so they are treated as held in the Self-Directed '
        + 'IRA and their proceeds are taxed as pre-tax money.</p>';
    }
    return h;
  }

  /* SECTION: THE WHOLE LIFE, AS A SHAPE */

  /* The fan chart: every calendar year from today to the plan age, 10th to 90th percentile
     band and the median line, IN TODAY'S DOLLARS so it reads in the same unit as the
     headline. The axis is capped at 2.5 times the highest median (or the band's top if
     lower), so one good-run tail cannot flatten the typical line; a clipped band says so. */
  function fanChart(r) {
    const rows = (r.curve || []).map((c) => {
      const f = c.index > 0 ? c.index : 1;
      return Object.assign({}, c, { p10: c.p10 / f, p50: c.p50 / f, p90: c.p90 / f, n50: c.p50 });
    });
    if (rows.length < 2) return '';
    const W = 860, H = 320, L = 66, R = 12, T = 16, B = 34;
    const iw = W - L - R, ih = H - T - B;
    let p90top = 0, p50top = 0;
    rows.forEach((c) => { if (c.p90 > p90top) p90top = c.p90; if (c.p50 > p50top) p50top = c.p50; });
    const top = Math.min(p90top, Math.max(1, p50top * 2.5));
    if (top <= 0) return '';
    const clipped = p90top > top * 1.001;
    const x = (i) => L + (iw / (rows.length - 1)) * i;
    const y = (v) => T + ih - (Math.min(v, top) / top) * ih;
    const ax = (v) => (v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M' : v >= 1000 ? '$' + Math.round(v / 1000) + 'k' : '$0');

    let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block" '
      + 'role="img" aria-label="Portfolio value over time in today\'s dollars, from today to the plan age">';
    for (let g = 0; g <= 4; g++) {
      const v = top * g / 4;
      s += '<line x1="' + L + '" y1="' + y(v) + '" x2="' + (W - R) + '" y2="' + y(v)
        + '" stroke="#E4E9F0" stroke-width="1"/>'
        + '<text x="' + (L - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end" font-size="10" '
        + 'fill="#6B7A8C">' + ax(v) + '</text>';
    }
    let up = '', dn = '';
    rows.forEach((c, i) => { up += (i ? 'L' : 'M') + x(i) + ' ' + y(c.p90); });
    for (let i = rows.length - 1; i >= 0; i--) dn += 'L' + x(i) + ' ' + y(rows[i].p10);
    s += '<path d="' + up + dn + 'Z" fill="#4C7BD9" fill-opacity="0.16"/>';
    let mid = '', bad = '';
    rows.forEach((c, i) => { mid += (i ? 'L' : 'M') + x(i) + ' ' + y(c.p50); bad += (i ? 'L' : 'M') + x(i) + ' ' + y(c.p10); });
    s += '<path d="' + bad + '" fill="none" stroke="#A33A1F" stroke-width="1.5"/>';
    s += '<path d="' + mid + '" fill="none" stroke="#1F3864" stroke-width="2"/>';
    if (clipped) {
      s += '<text x="' + (W - R) + '" y="' + (T + 11) + '" text-anchor="end" font-size="10" fill="#6B7A8C">'
        + 'good-run band clipped above ' + ax(top) + '</text>';
    }
    /* WHERE EARNING STOPS AND DRAWING BEGINS: the line a reader looks for first. */
    const si = rows.findIndex((c) => c.phase === 'drawing');
    if (si > 0) {
      s += '<line x1="' + x(si) + '" y1="' + T + '" x2="' + x(si) + '" y2="' + (T + ih)
        + '" stroke="#A33A1F" stroke-width="1.5" stroke-dasharray="4 3"/>'
        + '<text x="' + (x(si) + 5) + '" y="' + (T + 11) + '" font-size="10" fill="#A33A1F">'
        + 'stop work, ' + rows[si].year + '</text>';
    }
    rows.forEach((c, i) => {
      if (i % 6 && i !== rows.length - 1) return;
      s += '<text x="' + x(i) + '" y="' + (H - 12) + '" text-anchor="middle" font-size="10" '
        + 'fill="#6B7A8C">' + c.year + '</text>';
    });
    const half = iw / (rows.length - 1) / 2;
    rows.forEach((c, i) => {
      s += '<rect x="' + (x(i) - half).toFixed(1) + '" y="' + T + '" width="' + (2 * half).toFixed(1) + '" height="' + ih
        + '" fill="transparent"><title>' + c.year + ', age ' + c.age + (c.phase === 'drawing' ? ', drawing down' : ', still earning')
        + '\nTypical: ' + money(c.p50) + ' in today\'s dollars (' + money(c.n50) + ' in ' + c.year + ' dollars)'
        + '\nBad run (10th percentile): ' + money(c.p10) + '\nGood run (90th percentile): ' + money(c.p90) + '</title></rect>';
    });
    return s + '</svg>';
  }

  /* The money-over-time card, its sentences in today's dollars like the chart. */
  function panelCurve(r) {
    const rows = r.curve;
    const td = (c, k) => real(c[k], c.year, r.cfg, r);
    const peak = rows.reduce((a, c) => (td(c, 'p50') > td(a, 'p50') ? c : a), rows[0]);
    const atStop = rows.find((c) => c.phase === 'drawing') || rows[rows.length - 1];
    const last = rows[rows.length - 1];
    const bust = rows.filter((c) => c.phase === 'drawing' && c.p10 <= 0)[0];

    return '<div class="card"><h2>Your money over time</h2>'
      + '<p class="note">Every year from today to age ' + r.cfg.planToAge + ', across '
      + r.cfg.paths.toLocaleString('en-US') + ' simulated lifetimes, <b>in today\'s dollars</b>. '
      + 'The band runs from a bad run (10th percentile, the red line) to a good one (90th), '
      + 'with the typical run through it. The dashed line is the year you stop working: '
      + '<b>everything left of it is saving, everything right of it is drawing</b>.</p>'
      + fanChart(r)
      + '<p class="note" style="margin-top:10px">Typically <b>' + money(td(atStop, 'p50'))
      + '</b> at the stop year'
      /* Only worth saying when the peak is not simply the last year: "peaking in the final
         year" is a trend, not a peak. */
      + (peak.year < last.year - 1
          ? ', peaking around <b>' + money(td(peak, 'p50')) + '</b> in ' + peak.year
          : ', and rising throughout')
      + ', ending with <b>' + money(td(last, 'p50')) + '</b>. '
      + (bust
          ? '<span class="warn">In a bad run the money is gone by ' + bust.year
            + '</span>, which is the failure the headline probability counts.'
          : '<b class="pos">Even the bad run never reaches zero</b> inside the calendar.')
      + '</p>'
      + '<p class="note">The model itself works in the dollars of each year, because the '
      + 'spending it pays for does too; hover a year to see both. ' + money(last.p50) + ' in '
      + last.year + ' is about <b>' + money(td(last, 'p50')) + '</b> today, at '
      + pct1(numOr(r.cfg.inflPre, 0.035)) + ' inflation until you stop and '
      + pct1(numOr(r.cfg.inflPost, 0.03)) + ' after.</p>'
      + '</div>';
  }

  /* SECTION: WHEN CAN YOU STOP? */

  /* The stop-year comparison. Every row runs the SAME plan as the headline (with everything
     "Included in This Plan") at the same number of lifetimes on the same seed, and the
     current stop year's row is the headline run itself, so the two always agree. */
  function panelWhen(r, runCfg) {
    const C = runCfg;
    const years = [];
    for (let d = -4; d <= 6; d += 2) years.push(C.stopYear + d);
    const thisYear = C.thisYear || new Date().getFullYear();
    const rows = years.filter((sy) => sy >= thisYear || sy === C.stopYear).map((sy) => {
      const rr = sy === C.stopYear ? r
        : root.Runway.simulate(Object.assign({}, C, { stopYear: sy, paths: r.cfg.paths }));
      return rr ? { year: sy, age: sy - C.birthYear, r: rr } : null;
    }).filter(Boolean);
    if (rows.length < 2) return '';

    const body = rows.map((o) => {
      const on = o.year === C.stopYear;
      const endYear = C.birthYear + C.planToAge;
      return '<tr' + (on ? ' class="hi"' : '') + '>'
        + '<td class="l b">' + o.year + (on ? ' <span class="muted" style="font-size:10px">your plan</span>' : '') + '</td>'
        + '<td>' + o.age + '</td>'
        + '<td class="b">' + pct(o.r.neverShort) + '</td>'
        + '<td>' + pct(o.r.share) + '</td>'
        + '<td>' + (o.r.breaks ? 'age ' + o.r.breaks.ageP50 : 'never') + '</td>'
        + '<td>' + money(real(o.r.terminal.p50, endYear, o.r.cfg, o.r)) + '</td></tr>';
    }).join('');

    return '<div class="card"><h2>When can you stop?</h2>'
      + '<p class="note">The same plan, with everything it includes, run again for each stop '
      + 'year. <b>Waiting is the one lever that works on both sides at once</b>: another year '
      + 'of saving and one fewer of drawing, which is why it usually moves the number more '
      + 'than anything except spending less. Your current year is highlighted and matches the '
      + 'headline exactly. "Typically breaks" is the median age at which the failing '
      + 'lifetimes first fell short; ending wealth is the typical run, in today\'s dollars.</p>'
      + '<table style="margin-top:10px"><tr>'
      + '<th class="l">Stop in</th><th>Age</th><th>Never short</th>'
      + '<th>Of full target</th><th>Typically breaks</th><th>Left, in today\'s dollars</th></tr>'
      + body + '</table>'
      + '<p class="note" style="margin-top:10px">' + r.cfg.paths.toLocaleString('en-US')
      + ' lifetimes per row, the same as the headline.</p></div>';
  }

  /* SECTION: WHAT BREAKS FIRST, AND WHAT MOVES IT */

  /* The anatomy of the failing lifetimes: when they break, the first gap, which sleeve
     emptied first. */
  function panelBreaks(r) {
    if (!r.breaks) {
      return '<div class="card"><h2>What breaks first</h2>'
        + '<p class="note"><b class="pos">Nothing broke.</b> Every one of the '
        + r.cfg.paths.toLocaleString('en-US') + ' lifetimes met what the plan asked for in '
        + 'every year. That is a statement about these assumptions, not a guarantee: move the '
        + 'spend target up, or the returns down, and this panel will have something to say.</p></div>';
    }
    const b = r.breaks;
    const firstDry = b.empty[0];
    const stat = (l, v, n) => '<div style="flex:1;min-width:140px">'
      + '<div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)">' + l + '</div>'
      + '<div style="font-size:24px;font-weight:700;margin:2px 0">' + v + '</div>'
      + (n ? '<div class="note" style="font-size:11px">' + n + '</div>' : '') + '</div>';

    let h = '<div class="card"><h2>What breaks first</h2>'
      + '<p class="note">Of ' + r.cfg.paths.toLocaleString('en-US') + ' lifetimes, <b>'
      + pct(b.share) + ' fell short at some point</b>. These figures describe those runs '
      + 'only. Averaging in the ones that went fine would drag every number toward '
      + '"nothing went wrong", which is the run you need no help with.</p>'
      + '<div style="display:flex;flex-wrap:wrap;gap:20px;margin-top:14px">'
      + stat('Typically breaks at', 'age ' + b.ageP50, 'age ' + b.ageP10 + ' in the earliest tenth')
      + stat('First gap', money(b.gapP50), 'what was missing that year, in that year\'s dollars')
      + (b.dryAgeP50 != null && firstDry
          ? stat('First sleeve empty', esc(firstDry.what), 'typically at age ' + b.dryAgeP50)
          : '')
      + '</div>';

    if (b.dryAgeP50 != null && firstDry && b.dryAgeP50 < b.ageP50) {
      h += '<p class="note" style="margin-top:14px"><b>You get ' + (b.ageP50 - b.dryAgeP50)
        + ' years of warning.</b> ' + esc(firstDry.what) + ' typically empties at '
        + b.dryAgeP50 + ' and the money does not actually run out until ' + b.ageP50
        + '. A sleeve hitting zero is the early signal; by the time a year goes unpaid the '
        + 'decision that would have helped is long behind you.</p>';
    }
    return h + '</div>';
  }

  /* The levers table: each row the plan re-run with one change, its effect on never short in
     whole points. */
  function panelLevers(lv) {
    if (!lv || !lv.levers.length) return '';
    const rows = lv.levers.map((l) => {
      const d = Math.round(l.delta * 100);
      const up = d >= 0;
      const w = Math.min(100, Math.abs(l.delta * 100) * 2.2);
      return '<tr>'
        + '<td class="l" style="padding:7px 12px 7px 0"><b>' + esc(l.label) + '</b>'
        + (l.note ? '<div class="note" style="font-size:11px;margin-top:1px">' + esc(l.note) + '</div>' : '')
        + '</td>'
        + '<td style="padding:7px 0;width:200px">'
        + '<div style="display:flex;align-items:center;gap:8px">'
        + '<div style="flex:1;height:8px;background:#EDF1F6;border-radius:4px;overflow:hidden">'
        + '<div style="width:' + w + '%;height:100%;background:' + (up ? '#2E6B52' : '#A33A1F') + '"></div>'
        + '</div>'
        + '<b style="width:76px;text-align:right;color:' + (up ? '#2E6B52' : '#A33A1F') + '">'
        + pts(d) + '</b></div></td>'
        + '<td style="padding:7px 0 7px 14px;text-align:right;width:70px">' + pct(l.neverShort) + '</td>'
        + '</tr>';
    }).join('');

    return '<div class="card"><h2>What moves it most</h2>'
      + '<p class="note">Each row is <b>the same plan re-run with one thing changed</b>, on '
      + 'the same seed, so the difference is the change and not a different random world. '
      + 'This is measured rather than attributed: a model with this many moving parts can '
      + 'always be told a plausible story about why it failed, and a re-run cannot.</p>'
      + '<table style="margin-top:10px"><tr><th class="l">Change</th>'
      + '<th class="l">Effect on never short</th><th style="text-align:right">Then</th></tr>'
      + rows + '</table>'
      + '<p class="note" style="margin-top:12px"><b>These are not recommendations.</b> The '
      + 'tool has no view on whether you should work two more years; it can only say what '
      + 'two more years did to the number. Run on ' + lv.paths.toLocaleString('en-US')
      + ' lifetimes per row, fewer than the headline above, so a row within a point or two '
      + 'of zero is noise rather than a finding.</p></div>';
  }

  /* CAPITAL CALLS BEFORE YOU STOP (Q21). The calls are contractual, so this is arithmetic,
     not a simulation: each year's calls from the engine's own schedule, their running total,
     and how much of that total the public money in the file could not cover if no deal paid
     anything out first. The first year a gap appears is highlighted; the panel states numbers
     and gives no verdict. The simulation above counts deal payouts and returns; this does not. */
  function panelCalls(ctx, C) {
    const PI = root.PlanIncludes;
    if (!PI || !PI.callsDated || !ctx || !ctx.book || !ctx.book.length) return '';
    const dated = PI.callsDated(ctx.book);
    const stop = C.stopYear;
    const years = Object.keys(dated).map(Number).filter((y) => y < stop).sort((a, b) => a - b);
    if (!years.length) return '';
    const later = Object.keys(dated).map(Number).filter((y) => y >= stop)
      .reduce((a, y) => a + -dated[y].net, 0);
    const have = C.noPublic ? 0 : (C.sleeves || []).reduce((a, s) => a + (Number(s.balance) || 0), 0);
    let cum = 0, flagged = false;
    const rows = years.map((y) => {
      const due = -dated[y].net;
      cum += due;
      const gap = Math.max(0, cum - have);
      const first = gap > 0.5 && !flagged;
      if (first) flagged = true;
      return '<tr' + (first ? ' class="rw-uncov"' : '') + '><td class="l">' + y + (first ? '<br><b class="warn" style="font-size:12px;white-space:nowrap">first year not covered</b>' : '') + '</td>'
        + '<td>' + money(due) + '</td><td>' + money(cum) + '</td>'
        + '<td' + (gap > 0.5 ? ' class="neg"' : '') + '>' + (gap > 0.5 ? money(gap) : '$0') + '</td></tr>';
    });
    const gapEnd = Math.max(0, cum - have);
    return '<div class="card rw-calls"><h2>Capital calls before you stop</h2>'
      + '<p class="note">These are the capital calls your deals can still make before ' + stop
      + ', year by year, from the Next call date and amount in your file and an even spread of the '
      + 'rest of what is still to pay in. Each row shows that year&rsquo;s calls, the running '
      + 'total, and how much of the total the public money in your file could not cover if none '
      + 'of your deals paid anything out first. Your deals&rsquo; payouts and your accounts&rsquo; '
      + 'returns are left out here; the figures above count both.</p>'
      + '<p class="note key"><b>Calls due ' + years[0] + (years.length > 1 ? ' to ' + years[years.length - 1] : '')
      + ': ' + money(cum) + '.</b> Public money in your file: ' + money(have) + '. Not covered: '
      + (gapEnd > 0.5 ? '<span class="neg">' + money(gapEnd) + '</span>' : '$0') + '.'
      + (later > 0.5 ? ' A further ' + money(later) + ' falls in ' + stop + ' or later.' : '') + '</p>'
      + '<div style="overflow-x:auto"><table style="margin-top:10px"><tr><th class="l">Year</th><th>Calls due</th>'
      + '<th>Running total</th><th>Not covered</th></tr>' + rows.join('') + '</table></div></div>';
  }

  /* ONE FUTURE, WRITTEN OUT. Every other panel is a range, and a range cannot be read down a
     column. This is the median-ENDING path, a real future that happened, which is why it adds
     up line by line. The run-up years are summarised above the table (they hold the capital
     calls and down payments); the table itself is the drawing years. */
  function panelLedger(runCfg) {
    const mt = root.Runway.medianTrace(runCfg);
    if (!mt || !mt.rows || !mt.rows.length) return '';
    const stopAge = mt.rows[0].age;
    const blank = '';
    const up = mt.runup || [];
    const upPaid = up.reduce((a, o) => a + o.paid, 0);
    const upUnmet = up.reduce((a, o) => a + o.unmet, 0);

    let h = '<div class="card"><h2>Year by year</h2>'
      + '<p class="note"><b>This is one future, not the range.</b> Everything above is a band '
      + 'across ' + mt.of.toLocaleString('en-US') + ' simulated lifetimes. This table is a '
      + 'single one of them, chosen because it ends with the <b>middle</b> result (it ends on '
      + 'the headline\'s typical figure), so it can be read down a column and added up the '
      + 'way a spreadsheet can. The bands above are what to plan against; this is for '
      + 'checking that the arithmetic behaves.</p>'
      + (upPaid > 0.5 || upUnmet > 0.5
          ? '<p class="note"><b>Before you stop</b>, ' + money(upPaid) + ' of dated bills '
            + '(capital calls, down payments, tax owed back) was paid from the accounts in this '
            + 'future' + (upUnmet > 0.5 ? ', and <span class="warn">' + money(upUnmet)
              + ' could not be paid</span>' : '') + '.</p>'
          : '')
      + '<p class="note">Each row is in the dollars of its year. Last year&rsquo;s closing '
      + 'balance is this year&rsquo;s opening, and every row reconciles: <b>opening, plus '
      + 'return, less what was withdrawn, plus money swept in, gives the closing balance</b>. '
      + 'Money swept in is the part of a deal payout or a dated inflow that the year did not '
      + 'need. Spending is what the year delivered after any bills; Bills are dated money '
      + 'going out (paid before spending). Tax covers the withdrawals, the deal proceeds spent '
      + 'and Social Security. A blank cell means nothing that year.</p>'
      + '<details style="margin-top:12px"><summary style="cursor:pointer;font-weight:600;'
      + 'font-size:13px">Open the ledger (' + mt.rows.length + ' years)</summary>'
      + '<table style="margin-top:10px"><tr><th class="l">Year</th><th>Age</th>'
      + '<th>Opening</th><th>Return</th><th>Withdrawn</th><th>Tax</th>'
      + '<th>Social Security</th><th>Deals</th><th>Bills</th><th>Spending</th><th>Swept in</th><th>Closing</th></tr>';

    for (const r of mt.rows) {
      const ret = r.sleeves.reduce((a, sv) => a + sv.growth + sv.income, 0);
      const gross = r.sleeves.reduce((a, sv) => a + sv.yield + sv.principal, 0);
      const close = r.sleeves.reduce((a, sv) => a + sv.balanceAfter, 0);
      const cell = (v, cls, neg) => '<td class="' + (v > 0.5 ? cls : 'z') + '">' + (v > 0.5 ? (neg ? '-' : '') + money(v) : blank) + '</td>';
      h += '<tr' + (r.short ? ' class="hi"' : '') + '>'
        + '<td class="l b">' + r.year + (r.age === stopAge
          ? ' <span class="muted" style="font-size:10px">work stops</span>' : '') + '</td>'
        + '<td>' + r.age + '</td>'
        + '<td>' + money(r.opening) + '</td>'
        + '<td class="' + (ret < 0 ? 'neg' : 'pos') + '">' + money(ret) + '</td>'
        + cell(gross, 'neg', true)
        + cell(r.tax, 'neg', true)
        + cell(r.benefit, 'pos', false)
        + '<td class="' + (r.dealsAvailable > 0.5 ? 'pos' : 'z') + '">'
        + (r.dealsAvailable > 0.5 ? money(r.dealsAvailable)
            + (r.deals > 0.5 ? ' <span class="muted" style="font-size:10px">'
                + money(r.deals) + ' spent</span>' : '')
          : blank) + '</td>'
        + cell(r.billsPaid, 'neg', true)
        + '<td class="b">' + money(r.spending)
        + (r.short ? ' <span class="neg" style="font-size:10px">short '
            + money(r.unmet) + '</span>' : '') + '</td>'
        + cell(r.sweptIn, 'pos', false)
        + '<td>' + money(close) + '</td></tr>';
    }
    return h + '</table></details></div>';
  }

  /* SECTION: HOW IT WORKS, AND WHAT IT ASSUMES */

  /* EVERY NUMBER HERE IS READ FROM THE MODEL, not typed into the prose. A methodology note
     maintained by hand drifts away from the code it describes, and then it is a confident
     description of a model that no longer exists. */
  function panelMethod(r, C) {
    const K = root.Runway.SLEEVE_KINDS || {};
    const ORDS = root.Runway.DRAW_ORDERS || {};
    const chosen = ORDS[r.drawOrder] || ORDS['safe-first'] || {};
    const T = r.tax || {};
    const step = (nn, t, d) => '<div class="glos"><div class="t">' + nn + '. ' + t
      + '</div><div class="d">' + d + '</div></div>';
    const orderLabels = chosen.order === null ? null : r.sleeves.map((s) => s.label);

    /* THE SLEEVES IN THIS RUN, under the labels the Holdings tab uses, with the figures the
       simulator actually drew from (return = price return + yield, as Holdings shows it). */
    const sleeveRows = r.sleeves.map((s, i) => '<tr>'
      + '<td class="l b">' + esc(s.label) + '</td>'
      + '<td>' + money(s.balance) + '</td>'
      + '<td>' + pct1(s.mu + s.yield) + '</td>'
      + '<td>' + pct1(s.sd) + '</td>'
      + '<td>' + pct1(s.yield) + '</td>'
      + '<td>' + pct1(((T.bySleeve || [])[i] || {}).rate || 0) + '</td></tr>').join('');
    const kindRows = Object.keys(K).map((k) => '<tr>'
      + '<td class="l">' + k.charAt(0).toUpperCase() + k.slice(1) + '</td>'
      + '<td>' + pct1(K[k].mu + K[k].yield) + '</td>'
      + '<td>' + pct1(K[k].sd) + '</td>'
      + '<td>' + pct1(K[k].yield) + '</td></tr>').join('');
    const source = C.fromHoldings ? 'the Holdings tab' : 'your Balances tab, or the model\'s defaults where it gave none';

    return '<div class="card" id="fpos-method"><h2>How this works, and what it assumes</h2>'
      + '<p class="note">Every figure below is read out of the model as it runs, not typed '
      + 'into this text. A methodology note kept by hand drifts away from the code it '
      + 'describes, and then it is worse than nothing.</p>'

      + '<h3 style="margin-top:18px">What it does</h3>'
      + '<p class="note">It runs one life ' + r.cfg.paths.toLocaleString('en-US')
      + ' times and counts how often the money lasted. Each run has two phases. '
      + '<b>Saving</b>, from today to ' + r.stopYear + ': nothing is spent and everything '
      + 'compounds, but dated money still moves. Money coming in is invested; money going out '
      + '(capital calls, a down payment, tax owed back) is paid from the accounts in the same '
      + 'order and with the same tax as a withdrawal in retirement, and anything the accounts '
      + 'cannot cover makes that lifetime short. <b>Drawing</b>, from ' + r.stopYear
      + ' to age ' + r.cfg.planToAge + ': each year it works out what the plan needs and pays '
      + 'it in a fixed order.</p>'
      + '<p class="note">Dated money in a year that is already past is handled one way, so '
      + 'nothing is free: money going out is charged in the first year simulated, and money '
      + 'coming in is assumed to be in your balances already (the same rule as deal proceeds '
      + 'that landed before today).</p>'
      + '<p class="note">The seed is fixed, so the same inputs always give the same answer. '
      + 'If a number moves, something moved it.</p>'

      + '<h3 style="margin-top:18px">How one year gets paid</h3>'
      + '<p class="note">Bills dated that year are added to what it must pay and paid first; '
      + 'what is left goes to spending. Then, in this order, stopping as soon as the year is '
      + 'covered:</p>'
      + step(1, 'Social Security', 'It arrives whatever the markets did, which is why it goes '
          + 'first. Taxed at ' + pct1(T.benefit || 0) + ': ' + pct(T.benefitShare != null ? T.benefitShare : 0.85)
          + ' of it (the most that can be taxable) at the pre-tax rate of ' + pct(T.preTax || 0) + '.')
      + step(2, 'Dated money coming in', 'A property sale, a pension, an inheritance, a tax '
          + 'saving. Treated as already after tax. What the year does not need is invested.')
      + step(3, 'Private deal proceeds landing that year', '<b>Only what actually pays out in '
          + 'that year.</b> A deal is never treated as a balance you can draw on, only as cash '
          + 'on the date it arrives. What is spent is taxed at <b>' + pct1(T.deals || 0)
          + '</b>, the blend of the accounts your deals sit in (Self-Directed IRA at the pre-tax '
          + 'rate, personal accounts at the taxable rate, weighted by commitment); what is not '
          + 'needed is invested and taxed when it is drawn.')
      + step(4, 'Sleeve income', 'The yield from <b>every</b> sleeve is spent before '
          + '<b>any</b> principal is touched anywhere.')
      + step(5, 'Growth', 'Each sleeve is then moved by its own return draw for that year.')
      + step(6, 'Sleeve principal', 'Only if the year is still not covered. '
          + (r.rebalancing
              ? 'You are rebalancing every year, so <b>which sleeve pays makes no difference</b>: '
                + 'the mix is restored afterwards either way.'
              : orderLabels ? 'In the order <b>' + esc(orderLabels.join(', then ')) + '</b>, and with '
                + 'no rebalancing that choice is worth tens of points.'
                : 'A little from every sleeve, in proportion to what each holds.'))
      + '<p class="note">Every withdrawal is grossed up for tax: $100,000 of spending from a '
          + 'sleeve taxed at 22% costs $128,205 of balance. Anything still unmet after all six '
          + 'is a <b>short year</b>, and one short year is enough to fail a lifetime.</p>'

      + '<h3 style="margin-top:18px">The sleeves this plan draws from</h3>'
      + '<p class="note">These are the sleeves in this run, from ' + source + ', under the same '
      + 'names. Return is the expected total return a year (price plus yield), volatility its '
      + 'typical yearly swing, yield the part paid out as income, and tax the effective rate '
      + 'on a withdrawal, blended from the accounts behind the sleeve.</p>'
      + '<table style="margin-top:8px"><tr><th class="l">Sleeve</th><th>Balance today</th><th>Return</th>'
      + '<th>Volatility</th><th>Yield</th><th>Tax on withdrawal</th></tr>'
      + sleeveRows + '</table>'
      + '<p class="note" style="margin-top:10px">Defaults the model uses only when a sleeve on '
      + 'a Balances tab gives no figure of its own:</p>'
      + '<table style="margin-top:4px"><tr><th class="l">Kind</th><th>Return</th>'
      + '<th>Volatility</th><th>Yield</th></tr>' + kindRows + '</table>'
      + '<table style="margin-top:14px"><tr><th class="l">Assumption</th><th class="l">Value</th></tr>'
      + '<tr><td class="l">Inflation before you stop</td><td class="l">' + pct1(numOr(C.inflPre, 0.035)) + '</td></tr>'
      + '<tr><td class="l">Inflation after</td><td class="l">' + pct1(numOr(C.inflPost, 0.03)) + '</td></tr>'
      + '<tr><td class="l">Guardrail bands</td><td class="l">'
        + (C.guard || root.Runway.DEFAULTS.guard).map((g) => 'cover of ' + g[0] + '× or more: ask for ' + pct(g[1])).join('; ')
        + '</td></tr>'
      + '<tr><td class="l">How a year\'s return is drawn</td><td class="l">lognormal, with the '
        + 'sleeve\'s return and volatility (the same distribution as the Equity Curve), so no '
        + 'year can lose more than everything</td></tr>'
      + '<tr><td class="l">How the sleeves move together</td><td class="l">'
        + (r.correlated ? 'correlated, through the same factor model as the Holdings tab'
          : r.corrRejected ? 'independently (the correlation supplied was not valid and was ignored)'
            : 'independently') + '</td></tr>'
      + '<tr><td class="l">How the yield varies</td><td class="l">by a quarter of the price volatility, in proportion to the yield, and never below zero; it averages the yield shown</td></tr>'
      + '<tr><td class="l">Tax rates</td><td class="l">pre-tax ' + pct(T.preTax || 0) + ', taxable '
        + pct(T.taxable || 0) + ', Roth ' + pct(T.roth || 0) + (T.on ? '' : ' (tax is switched off)') + '</td></tr>'
      + '<tr><td class="l">Simulated lifetimes</td><td class="l">'
        + r.cfg.paths.toLocaleString('en-US') + ' for the headline and each stop-year row, 700 per lever</td></tr>'
      + '</table>'

      + '<h3 style="margin-top:18px">What it cannot tell you</h3>'
      + '<p class="note"><b>Tax in detail.</b> One effective rate per account type, not '
      + 'brackets. No state tax, no RMDs, no Roth conversions, and no cost basis: a taxable '
      + 'withdrawal or a taxable deal payout is taxed on all of it rather than on the gain, '
      + 'which is harsh. Dated money coming in is treated as already taxed.</p>'
      + (r.rebalancing ? ''
        : '<p class="note"><b>What a real person would do between years.</b> With rebalancing '
          + 'off, cash can empty while growth compounds beside it, which a real person would '
          + 'not allow, so the "first sleeve empty" warning fires earlier than it should.</p>')
      + '<p class="note"><b>What happens when everything goes wrong at once.</b> '
      + (r.correlated ? 'The public sleeves move together, but the private deals'
        : 'The sleeves are drawn independently, so a bad year for shares is not a bad year for '
          + 'credit. The private deals too')
      + ' are drawn apart from the markets: a crash does not delay an exit here, though in '
      + 'life it often does. That flatters the worst runs.</p>'
      + '<p class="note"><b>Whether any of this is a good idea.</b> It takes your plan as '
      + 'given and says whether the money lasts. It has no view on the plan.</p>'
      + '</div>';
  }

  /* WHAT THIS PLAN INCLUDES, and what it would say without them, on the same futures. Every
     name shown here comes from a deal file or a strategy and is escaped. */
  function panelIncludes(r, base) {
    const PI = root.PlanIncludes;
    if (!PI) return '';
    const av = PI.available(), S = PI.S;
    const box = (k, label, sub, go) => '<label class="inc-row"><input type="checkbox" data-rwinc="' + k + '"' + (S[k] ? ' checked' : '') + '>'
      + '<span><b>' + esc(label) + '</b><small>' + esc(sub) + (go ? ' <button type="button" class="linkish" data-rwgo="' + go[0] + '">' + esc(go[1]) + '</button>' : '') + '</small></span></label>';
    let h = '<div class="card"><h2>Included in This Plan</h2><p class="cap">Switch an item off to see the plan without it.</p><div class="inc-list">';
    h += box('calls', 'Capital calls still owed', 'Money your deals can still call. Leaving it out makes the plan look better than it is.');
    h += av.tax ? box('tax', 'Your tax strategies', root.TaxStrategies.S.plan.map((it) => root.TaxStrategies.name(it)).join(', '), ['tax', 'Edit in Tax Strategies'])
      : '<div class="inc-row off"><span><b>Your tax strategies</b><small>None set up yet. <button type="button" class="linkish" data-rwgo="tax">Add one in Tax Strategies</button></small></span></div>';
    h += av.deal ? box('deal', 'A deal you are considering', PI.considered.name + ', ' + money(PI.considered.commitment) + ' from ' + PI.considered.year, ['universe', 'Change in Deal Library'])
      : '<div class="inc-row off"><span><b>A deal you are considering</b><small>None. <button type="button" class="linkish" data-rwgo="universe">Test one in the Deal Library</button></small></span></div>';
    h += '</div>';
    if (base) {
      const d = Math.round(r.neverShort * 100) - Math.round(base.neverShort * 100);
      h += '<p class="note key">Never short: <b>' + pct(base.neverShort) + '</b> without these, <b>' + pct(r.neverShort) + '</b> with them ('
        + (d === 0 ? 'no change' : pts(d)) + '). The second figure is the headline below.</p>';
    }
    return h + '</div>';
  }

  /* SECTION: RENDER */

  /* WHICH CONTROL HAD FOCUS, as a selector that finds the same control in the new markup.
     Re-rendering replaces host.innerHTML, which detaches the focused element and drops focus
     to <body>; a keyboard user lost their place on every change. */
  const FOCUS_KEYS = ['data-rw', 'data-rwmode', 'data-rwreb', 'data-rword', 'data-rwinc', 'data-rwreset'];
  function focusKey(host) {
    const doc = host.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const a = doc && doc.activeElement;
    if (!a || !host.contains(a)) return null;
    for (const k of FOCUS_KEYS) {
      if (a.hasAttribute(k)) return '[' + k + '="' + a.getAttribute(k) + '"]';
    }
    return null;
  }
  function restoreFocus(host, sel) {
    if (!sel) return;
    const el = host.querySelector(sel) || host.querySelector('[data-rw]');
    if (el && el.focus) el.focus();
  }

  /* Re-render after a control changed, keeping focus on the same control. */
  function rerender(host, ctx) {
    const sel = focusKey(host);
    render(host, ctx);
    restoreFocus(host, sel);
  }

  /* Draws the whole tab into host for ctx ({ book, mode, sheets }). Runs the plan once at
     1,200 lifetimes (with everything included), once without the includes when any are on,
     once per other stop-year row, and the levers. */
  function render(host, ctx) {
    /* A NEW BOOK STARTS CLEAN: slider overrides from the previous household are cleared. */
    const book = ctx && ctx.book ? ctx.book : null;
    if (lastBook && book && book !== lastBook) { Object.keys(LIVE).forEach((k) => delete LIVE[k]); lastHeadline = null; }
    if (book) lastBook = book;
    if (root.PlanIncludes) root.PlanIncludes.remember(ctx);
    const port = fromSheet(ctx);
    const miss = missingRequired(port, ctx);
    if (miss) { host.innerHTML = requiredCard(miss); return; }
    const A = cfgBase(port, ctx);
    const C = cfg(port, ctx);
    const E = (typeof Engine !== 'undefined' && Engine) ? Engine : (root.Engine || null);
    /* WHAT IS INCLUDED: your tax strategies, capital calls still owed, and a deal you are
       considering, decided in one place (includes.js) so the other tabs agree. */
    const PI = root.PlanIncludes;
    let runCfg, on = [], base = null;
    if (PI) {
      const c = PI.config(ctx);
      runCfg = c.runCfg; on = c.on;
      if (on.length) base = root.Runway.simulate(Object.assign({}, PI.config(ctx, { tax: false, calls: false, deal: false }).runCfg, { paths: 1200 }));
    } else {
      const sim = (ctx && ctx.book && ctx.book.length && E) ? E.simulate(ctx.book, { paths: 400, capturePaths: true }) : null;
      runCfg = Object.assign({}, C, { dealSim: sim, dated: port ? port.dated : null, dealTax: dealTaxMix(ctx && ctx.book) });
    }
    runCfg = Object.assign({}, runCfg, { paths: 1200 });
    const r = root.Runway.simulate(runCfg);
    /* The levers re-run the whole model once per row, so they get fewer paths. */
    const lv = r ? root.Runway.levers(runCfg, { paths: 700 }) : null;

    if (!r) {
      const d = root.Runway.diagnose(runCfg);
      host.innerHTML = '<div class="card"><h2>Retirement Simulator</h2>'
        + '<p class="note"><b>Nothing to run yet.</b> ' + (d && d.msg
          ? d.msg
          : 'This needs at least one sleeve with a balance, and a stop year before the plan '
            + 'age.') + '</p></div>';
      return;
    }
    const prev = lastHeadline;
    lastHeadline = r.neverShort;
    const T = r.tax;

    host.innerHTML =
      '<div class="card"><h2>Retirement Simulator</h2>'
      + '<p class="note">How long the money lasts, and what it leans on to get there.</p>'
      + sourceNote(port, C)
      + '<p class="note"><b>It models tax simply</b>, as one effective rate per account type '
      + 'rather than brackets: pre-tax accounts at ' + pct(T.preTax) + ', taxable at '
      + pct(T.taxable) + ', Roth and HSA at ' + pct(T.roth) + '. Withdrawals are grossed up, '
      + 'so the spending figure is what you actually get to spend. Private deal proceeds are '
      + 'taxed at ' + pct1(T.deals) + ', the blend of the accounts your deals sit in, and '
      + 'Social Security at ' + pct1(T.benefit) + ' (85% of it at the pre-tax rate). There '
      + 'are no brackets, no state tax, no RMDs and no cost basis, so taxable money is taxed '
      + 'on the whole withdrawal rather than on the gain, which is slightly harsh. '
      + (r.correlated ? 'The public sleeves move together; the private deals are drawn apart '
        + 'from the markets, which flatters the worst runs. ' : 'Each sleeve is drawn '
        + 'independently, which flatters the worst runs. ')
      + '<a href="#fpos-method">How this works and what it assumes</a> is at the foot of this tab.</p></div>'
      + panelControls(C, A, port)
      + panelIncludes(r, base)
      + panelHeadline(r, prev)
      + panelCalls(ctx, C)
      + panelCurve(r)
      + panelWhen(r, runCfg)
      + panelBreaks(r)
      + panelLevers(lv)
      + panelComposition(r)
      + panelLedger(runCfg)
      + panelMethod(r, C);

    wire(host, ctx);
  }

  /* EVENT WIRING. Sliders update their value label on every input tick (cheap) and recompute
     only on change, when the drag or key press is finished: re-rendering on input replaced
     the slider under the pointer, ended the drag after one step and took a couple of seconds
     a tick. Every handler re-renders through rerender(), which keeps focus. */
  function wire(host, ctx) {
    host.querySelectorAll('[data-rw]').forEach((el) => {
      const id = el.getAttribute('data-rw');
      el.oninput = () => {
        const lab = host.querySelector('[data-rwval="' + id + '"]');
        if (lab && FMT[id]) lab.textContent = FMT[id](Number(el.value));
      };
      el.onchange = () => {
        LIVE[id] = Number(el.value);
        /* Lowering the target below the floor pulls the floor down with it. */
        if (id === 'spend' && LIVE.floorSpend != null && LIVE.floorSpend > LIVE.spend) LIVE.floorSpend = LIVE.spend;
        rerender(host, ctx);
      };
    });
    host.querySelectorAll('[data-rwmode]').forEach((el) => {
      el.onclick = () => { LIVE.mode = el.getAttribute('data-rwmode'); rerender(host, ctx); };
    });
    host.querySelectorAll('[data-rwreb]').forEach((el) => {
      el.onclick = () => { LIVE.rebalance = el.getAttribute('data-rwreb'); rerender(host, ctx); };
    });
    host.querySelectorAll('[data-rword]').forEach((el) => {
      el.onclick = () => { LIVE.drawOrder = el.getAttribute('data-rword'); rerender(host, ctx); };
    });
    host.querySelectorAll('[data-rwinc]').forEach((el) => {
      el.onchange = () => { root.PlanIncludes.S[el.getAttribute('data-rwinc')] = el.checked; rerender(host, ctx); };
    });
    host.querySelectorAll('[data-rwgo]').forEach((el) => {
      el.onclick = () => { const t = document.querySelector('#out [data-tab="' + el.getAttribute('data-rwgo') + '"]'); if (t) t.click(); };
    });
    const rst = host.querySelector('[data-rwreset]');
    if (rst) rst.onclick = () => { Object.keys(LIVE).forEach((k) => delete LIVE[k]); rerender(host, ctx); };
  }

  /* SESSION RESET: clears every slider and button override and the remembered headline.
     Registered on window.APP_RESET_HOOKS, which includes.js (AppState) runs when a new book
     is loaded; render() also clears on a new book by itself, so this tab is correct even
     without includes.js. */
  function reset() { Object.keys(LIVE).forEach((k) => delete LIVE[k]); lastHeadline = null; }
  root.APP_RESET_HOOKS = (root.APP_RESET_HOOKS || []).concat([reset]);

  /* FOR OTHER TABS: the exact inputs this tab runs on (sample, then sheet, then sliders), plus
     the same deal-book simulation, so a scenario differs from the base by its changes only.
     Signatures are relied on by includes.js, taxes-ui.js and consider-ui.js. */
  root.RunwayUI = {
    /* { C, port, sim, runCfg }. runCfg = C + dealSim (400 engine paths) + dated (the
       tracker's dated money, from portfolio.js) + dealTax (the book's tax mix). */
    baseConfig(ctx) {
      const port = fromSheet(ctx);
      const C = cfg(port, ctx);
      const E = (typeof Engine !== 'undefined' && Engine) ? Engine : (root.Engine || null);
      const sim = (ctx && ctx.book && ctx.book.length && E) ? E.simulate(ctx.book, { paths: 400, capturePaths: true }) : null;
      return { C, port, sim, runCfg: Object.assign({}, C, {
        dealSim: sim, dated: port ? port.dated : null, dealTax: dealTaxMix(ctx && ctx.book) }) };
    },
    /* Just the stop year in force, without running anything: Tax Strategies needs only this. */
    stopYear(ctx) { return cfg(fromSheet(ctx), ctx).stopYear; },
    /* The portfolio's expected return a year (decimal), as the Retirement Simulator sees it:
       each sleeve's price return plus its income, weighted by balance. Tax Strategies uses it
       as the default growth for "If You Invest What It Saves". It is the arithmetic mean; the
       typical (median) path compounds a little slower once volatility is counted. Null when
       there are no balances. */
    expectedReturn(ctx) {
      const K = root.Runway ? root.Runway.SLEEVE_KINDS : {};
      const sl = (cfg(fromSheet(ctx), ctx).sleeves || []).filter((s) => Number(s.balance) > 0);
      const tot = sl.reduce((a, s) => a + Number(s.balance), 0);
      if (!tot) return null;
      return sl.reduce((a, s) => {
        const k = K[s.kind] || K.growth || {};
        return a + Number(s.balance) * ((s.mu != null ? Number(s.mu) : k.mu || 0) + (s.yield != null ? Number(s.yield) : k.yield || 0));
      }, 0) / tot;
    },
    /* The You-tab labels (and the Balances tab) a member's file still lacks, or null. The
       deal tester uses it to hold back its two retirement figures until the plan is real. */
    missing(ctx) { return missingRequired(fromSheet(ctx), ctx); },
    /* The member's You tab as parsed, or null: Tax Strategies seeds its baseline from it. */
    you(ctx) { const p = fromSheet(ctx); return p && p.you ? p.you : null; },
    /* Clears every slider and button override (a new book does this automatically). */
    reset,
    real, money, dealTaxMix,
  };

  root.APP_PLUGINS = (root.APP_PLUGINS || []).concat([{
    id: 'runway',
    label: 'Retirement',
    after: 'outlook',
    render,
  }]);
}(window));
