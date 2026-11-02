/* LIQUIDITY RUNWAY: a generic decumulation model (the Retirement Simulator's engine).
 *
 * PURPOSE. Runs one household's life a few thousand times and answers three questions: how
 * often the money never falls short, how much of the spending target a typical run delivers,
 * and where each year's money came from. Ported from APEX's retSimulate, which answers the
 * same question against one person's three named accounts. This one takes any number of
 * sleeves and knows nothing about whose they are.
 *
 * WHERE IT SITS. Pure model, no DOM. runway-ui.js (the Retirement tab) builds the config and
 * draws the answer; includes.js, taxes-ui.js and consider-ui.js call simulate() through
 * PlanIncludes so every tab that prints "never short" runs the same function on the same
 * seed. It reads Engine (engine.js) for the seeded random generator and History (history.js)
 * for the historical sampling modes. It is loaded as a plain script (window.Runway) and also
 * exports itself for node, which is how tests/runway.test.mjs loads it.
 *
 * WHAT MAKES IT DIFFERENT FROM A RETIREMENT CALCULATOR. Illiquid positions do not pay on a
 * schedule you choose. A deal exits in a year, or it does not, and the whole point is
 * whether the liquid sleeves can carry the gap until it does. So the private book is not a
 * balance earning a return: it is a stream of dated, uncertain arrivals, drawn from the same
 * model the Private Deals tabs use.
 *
 * ONE COHERENT FUTURE AT A TIME. Path 7 of the runway spends path 7 of the deal book: the
 * lifetime where those deals went that particular way. Feeding it per-year medians would
 * commit the error the cash-flow panel warns about in bold, because the middle future in one
 * year is a different future from the middle in the next.
 *
 * INPUT: simulate(cfg). Every field is optional and falls back to DEFAULTS.
 *   birthYear, stopYear, planToAge   integers. stopYear is the first drawing year.
 *   thisYear                         integer, defaults to the clock. The first simulated year.
 *   spend, floorSpend, benefitAnnual  annual amounts in TODAY'S dollars (nominal of thisYear).
 *   benefitAge                       age the benefit (Social Security) starts.
 *   inflPre, inflPost                decimals a year (0.03 = 3%), before and from the stop year.
 *   mode                             'fixed' | 'guard' | 'floor' (see the drawing loop).
 *   guard                            [[coverMultiple, shareOfTarget], ...], highest first.
 *   sleeves  [{ id, label, kind, balance, mu, sd, yield, taxMix, account }]
 *            balance in today's dollars; mu = expected PRICE return a year (decimal), sd its
 *            volatility, yield the spendable income a year (decimal of balance); kind one of
 *            SLEEVE_KINDS; taxMix { preTax, taxable, roth } as shares summing to 1.
 *   corr     { idA: { idB: rho } } optional correlation between sleeves.
 *   dated    { [year]: { net, items: [{ label, amount, inflates? }] } } nominal dollars, plus
 *            money going in (positive) or out (negative). An item flagged `inflates: true` is
 *            in today's dollars and is inflated on this path's own price index; `net` is the
 *            plain sum of the items and is what a caller that knows nothing of the flag sets.
 *   dealSim  an Engine.simulate result taken with capturePaths: true (proceeds per path).
 *   dealTax  optional tax bucket of the deal proceeds: a number (an effective rate, decimal)
 *            or a mix { preTax, taxable, roth }. Absent means pre-tax, the conservative case.
 *   tax      { on, preTax, taxable, roth, benefitShare } effective rates (decimals).
 *   drawOrder 'safe-first' | 'proportional' | 'growth-first';  rebalance 'annual' | 'none'.
 *   sampling 'normal' (default) | 'historical' | 'sequence';  blockYears for 'historical'.
 *   paths, seed, trace, traceAt      run size, generator seed, and one path to record.
 *
 * OUTPUT: an object (or null when the inputs cannot be run; diagnose() says why) with
 *   neverShort   share of lifetimes in which every year met what it asked for (0..1)
 *   share        median share of the FULL target delivered as spending (0..1, never above 1)
 *   fullYears, worstRun   median share of years paid in full; median longest thin run (years)
 *   terminal     { p10, p50, p90 } ending wealth, NOMINAL dollars of the final year
 *   byYear       drawing years: { age, year, need (median nominal target), wealth {p10,p50,p90},
 *                from { benefit, dated, deals, <sleeveId> } median amounts }
 *   curve        every calendar year from thisYear: { year, age, phase, p10, p50, p90, index }
 *                where index is the median price level (1 = today) for today's-dollar maths
 *   preStop      { n, share, gapP50 } lifetimes whose dated money going out before the stop
 *                year could not be paid even after every sleeve was emptied; null when none
 *   breaks       anatomy of the failing lifetimes, null when nothing failed
 *   trace        the recorded path's drawing years (see the trace push for the row shape)
 *   traceRunup   the recorded path's saving years: { year, flow, paid, unmet, balance }
 *   tax          rates in force, per sleeve, plus deal and benefit rates
 *
 * INVARIANTS (tests/runway.test.mjs checks each).
 *   - Money going out is never dropped. Before the stop year it is paid from the sleeves in
 *     draw order with the tax gross-up; whatever the sleeves cannot cover is a shortfall.
 *   - Paying a bill is not spending. share and fullYears count spending only, so share <= 1.
 *   - The traced ledger foots: opening + return - withdrawn + money swept in = closing.
 *   - The traced path is the one whose ending is terminal.p50 (same rank rule as q()).
 *   - Same inputs and seed give the same answer.
 *
 * ASSUMPTIONS AND SIMPLIFICATIONS.
 *   - Tax is one effective rate per account type (pre-tax 22%, taxable 15%, Roth 0), with
 *     withdrawals grossed up. No brackets, no state tax, no RMDs, no basis on taxable money,
 *     which is taxed on the whole withdrawal and is therefore slightly harsh.
 *   - Social Security is taxed at 85% of the pre-tax rate (the most of it that can be taxable).
 *   - Deal proceeds are taxed at their bucket's rate when they are spent; the part not spent
 *     is swept, untaxed, into the first sleeve and taxed at that sleeve's rate when drawn.
 *   - Positive dated money (a pension, a property sale, a tax saving) is treated as already
 *     after tax. Dated money before thisYear: money going OUT is charged in the first year
 *     simulated (a cost cannot be made to vanish by dating it in the past); money coming IN
 *     is assumed to be in the balances already, the same rule deal proceeds follow.
 *   - Price returns are lognormal with the sleeve's arithmetic mean and volatility, the same
 *     distribution markets.js cone() uses, so no floor is needed (a lognormal cannot lose more
 *     than 100%). Yield is lognormal around the stated yield, swinging by a quarter of the
 *     price volatility in proportion to it: never below zero, and its average is the yield
 *     stated (a normal floored at zero used to add phantom income, about 1.6 points a year on
 *     a stock sleeve).
 *   - The benefit beyond what a year needs is not saved (conservative and usually zero).
 *
 * KNOWN LIMITS. Public and private paths are independent (deal path p and market path p come
 * from separate generators). No glide path: the mix typed today is held for life. The
 * benefit is one flat amount in today's dollars from benefitAge.
 */
(function (root) {
  'use strict';

  /* SLEEVE ARCHETYPES. A reader who fills in nothing gets these; a reader who fills in an
     expected return, volatility or yield on their own sheet overrides them. mu is the PRICE
     return a year and yield the spendable income a year, both decimals; total expected return
     is mu + yield. Deliberately unexciting: this is the model's opinion, and an opinion should
     be arguable rather than flattering. */
  const SLEEVE_KINDS = {
    growth:  { mu: 0.08, sd: 0.16, yield: 0.00, spendYieldFirst: false },
    income:  { mu: 0.02, sd: 0.05, yield: 0.06, spendYieldFirst: true },
    bonds: { mu: 0.03, sd: 0.06, yield: 0.03, spendYieldFirst: true },
    cash:    { mu: 0.00, sd: 0.002, yield: 0.04, spendYieldFirst: true },
  };

  /* THE DEFAULT ORDER MONEY IS TAKEN IN, and it is a real decision rather than an
     arrangement. Yield is spent before any principal, because selling a position to fund a
     year you could have covered from income is the one avoidable way a plan shortens its own
     life. Cash goes before growth so a bad year is not crystallised. Growth is last. */
  const DRAW_ORDER = ['cash', 'bonds', 'income', 'growth'];

  /* WHICH SLEEVE PAYS FIRST, the three choices the Retirement tab offers. Each did measurably
     differently in history and each costs something. order null means pro rata. */
  const DRAW_ORDERS = {
    'safe-first': {
      order: ['cash', 'bonds', 'income', 'growth'],
      label: 'Spend the safe money first',
      note: 'Let growth compound untouched. Best historical outcomes, and it leaves you '
          + 'holding almost nothing but equities late in life.',
    },
    'proportional': {
      order: null,
      label: 'Take a little from everything',
      note: 'What a rebalanced portfolio does naturally, and what the Trinity study '
          + 'measures. The middle answer on almost every count.',
    },
    'growth-first': {
      order: ['growth', 'income', 'bonds', 'cash'],
      label: 'Spend the risky money first',
      note: 'De-risks as you go, so the plan gets safer with age. Worst on average, and the '
          + 'gentlest ending.',
    },
  };

  /* The defaults behind every field of the config. Money in today's dollars, rates as
     decimals a year. */
  const DEFAULTS = {
    birthYear: 1975,
    stopYear: 2040,
    planToAge: 92,
    spend: 180000,          // annual, today's dollars
    floorSpend: 120000,     // the must-have, today's dollars
    inflPre: 0.035,         // until the stop year
    inflPost: 0.03,         // from it
    benefitAge: 67,
    benefitAnnual: 40000,   // today's dollars
    mode: 'guard',          // 'fixed' | 'floor' | 'guard'
    guard: [[12, 1.00], [9, 0.90], [0, 0.80]],
    paths: 2000,
    seed: 20260929,
    sleeves: [],
    /* SIMPLE TAX, federal only, as effective rates rather than brackets. Deliberately not a
       tax engine. benefitShare is the share of the benefit that is taxed at the pre-tax
       rate: 85% is the most of Social Security that can be taxable, so it is the cautious
       stand-in for the provisional-income test. Set tax.on to false for pre-tax figures. */
    tax: { on: true, preTax: 0.22, taxable: 0.15, roth: 0, benefitShare: 0.85 },
  };

  /* engine.js declares `const Engine = {...}` at top-level script scope, and const does NOT
     create a window property: it lives in the global lexical scope. So the bare identifier
     works and `window.Engine` is undefined, which is how the runway once rendered an empty
     state claiming the profile had no sleeves. The bare name first, the global as a fallback
     for node. `typeof` on an undeclared name is safe; a bare read of one throws. These two
     return the History and Engine modules, or null when they are not loaded. */
  function historyRef() {
    if (typeof History !== 'undefined' && History && History.SERIES) return History;
    if (root && root.History && root.History.SERIES) return root.History;
    return null;
  }

  function engineRef() {
    if (typeof Engine !== 'undefined' && Engine) return Engine;
    if (root && root.Engine) return root.Engine;
    return null;
  }

  /* A NUMBER OR ITS DEFAULT. `x || d` turned a deliberate 0 (zero inflation, a zero
     benefit) into the default, so an inflation of exactly 0 silently became 3.5%. Only a
     missing or non-numeric value falls back. */
  function numOr(v, d) {
    const n = Number(v);
    return v != null && v !== '' && Number.isFinite(n) ? n : d;
  }

  /* One standard normal draw times sd plus mu, by Box-Muller. Consumes two uniforms from rnd,
     the same shape APEX uses, so a figure can be compared across the two. */
  function gauss(rnd, mu, sd) {
    let u = 0, v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /* LOGNORMAL PARAMETERS for a year whose arithmetic mean return is mu and volatility sd
     (both decimals). If 1 + r = exp(m + s z) with z standard normal, then
     s^2 = ln(1 + sd^2 / (1 + mu)^2) and m = ln(1 + mu) - s^2 / 2, which makes E[r] = mu and
     SD[r] = sd exactly. Identical to Markets.logParams, so the Retirement tab and the Equity
     Curve cone draw from one distribution. mu is held above -99% so the log exists. */
  function logParams(mu, sd) {
    const m1 = Math.max(-0.99, mu);
    const s2 = Math.log(1 + (sd * sd) / Math.pow(1 + m1, 2));
    return { m: Math.log(1 + m1) - s2 / 2, s: Math.sqrt(s2) };
  }

  /* CHOLESKY FACTOR: lower-triangular L with L L' = R, for drawing correlated shocks as L e.
     A tiny ridge (1e-9 on the diagonal) keeps a matrix that is valid but rounded to two
     places from failing on a zero pivot. A pivot clearly below zero (under -1e-8) means R is
     not a correlation matrix at all; that returns null rather than quietly clamping, because
     a clamped factor reproduces different correlations from the ones the caller passed. */
  function cholesky(R) {
    const n = R.length, L = R.map(() => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        let sum = R[i][j] + (i === j ? 1e-9 : 0);
        for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
        if (i === j) {
          if (sum < -1e-8) return null;
          L[i][j] = Math.sqrt(Math.max(sum, 1e-12));
        } else {
          L[i][j] = sum / L[j][j];
        }
      }
    }
    return L;
  }

  /* The p-quantile of an ascending array, by the floor of p (n - 1). Every percentile this
     module reports uses this one rule, including which path medianTrace records. */
  function q(sorted, p) { return sorted[Math.floor(p * (sorted.length - 1))]; }
  function sortNum(a) { return a.slice().sort((x, y) => x - y); }

  /* SLEEVES, NORMALISED. Fills in whatever the sheet did not say from the sleeve's kind,
     drops empty sleeves, and sorts them into the draw order in force (the proportional order
     keeps the default sort, which only matters for which sleeve receives swept cash). Also
     records which of mu and sd the caller stated, because historical sampling rescales a
     series only to moments somebody actually gave. */
  function normSleeves(list, drawOrder) {
    const strat = DRAW_ORDERS[drawOrder] || DRAW_ORDERS['safe-first'];
    const ord = strat.order || DRAW_ORDER;
    return (list || []).filter((s) => s && Number(s.balance) > 0).map((s, i) => {
      const k = SLEEVE_KINDS[s.kind] || SLEEVE_KINDS.growth;
      return {
        id: s.id || ('sleeve' + i),
        label: s.label || s.id || ('Sleeve ' + (i + 1)),
        kind: SLEEVE_KINDS[s.kind] ? s.kind : 'growth',
        account: s.account || '',
        balance: Number(s.balance) || 0,
        mu: s.mu != null ? Number(s.mu) : k.mu,
        sd: s.sd != null ? Number(s.sd) : k.sd,
        yield: s.yield != null ? Number(s.yield) : k.yield,
        stated: s.mu != null || s.sd != null,
        spendYieldFirst: k.spendYieldFirst,
        /* CARRIED THROUGH, or the tax rate silently falls back to the pre-tax default for
           every sleeve. This rebuilds each object field by field, so a field it does not name
           is dropped, and a dropped tax mix does not throw: it taxes a Roth account at 22%
           and reports a plausible number. */
        taxMix: s.taxMix || null,
      };
    }).sort((a, b) => ord.indexOf(a.kind) - ord.indexOf(b.kind));
  }

  /* The private book as dated arrivals per path rather than a balance. `sim` is an
     Engine.simulate result taken with capturePaths: true; rows[p][i] is path p's nominal
     proceeds in years[i]. Null when there is no book. */
  function dealArrivals(sim) {
    if (!sim || !sim.pathRows || !sim.pathRows.length) return null;
    return { years: sim.years, rows: sim.pathRows };
  }

  /* THE EFFECTIVE RATE FOR A TAX MIX: the shares of pre-tax, taxable and Roth money times
     their rates, held between 0 and 0.9 (a rate at 1 or above could never fund a year). A
     missing mix is assumed all pre-tax, because that is where most retirement money sits and
     assuming tax-free would flatter the plan. Returns a decimal. */
  function rateOfMix(m, TAX) {
    if (!TAX.on) return 0;
    const mix = m || { preTax: 1, roth: 0, taxable: 0 };
    const r = (mix.preTax || 0) * TAX.preTax + (mix.taxable || 0) * TAX.taxable
      + (mix.roth || 0) * TAX.roth;
    return Math.min(0.9, Math.max(0, r));
  }

  /* THE RATE ON DEAL PROCEEDS. The runway sees one stream of proceeds per path, with no
     account attached, so the bucket arrives as cfg.dealTax: a plain rate, or a mix that
     runway-ui.js builds from the deals' Account column weighted by commitment. With neither,
     the proceeds are taxed as pre-tax money (Self-Directed IRA), the highest rate the model
     has and where most deals in this tool are held. Returns a decimal. */
  function dealRateOf(C, TAX) {
    if (!TAX.on) return 0;
    const d = C.dealTax;
    if (typeof d === 'number' && Number.isFinite(d)) return Math.min(0.9, Math.max(0, d));
    if (d && typeof d === 'object') return rateOfMix(d, TAX);
    return rateOfMix(null, TAX);
  }

  /* ONE YEAR OF DATED MONEY, split into the part already in nominal dollars and the part in
     today's dollars that inflates (items flagged `inflates`, which runway-ui.js sets from the
     Cashflows tab's Inflates column). Returns { flat, real }, both signed, flat + real = net
     when every item is listed. A caller that passes only `net` gets it back as flat. */
  function splitDated(e) {
    if (!e) return { flat: 0, real: 0 };
    const net = Number(e.net) || 0;
    let real = 0;
    (e.items || []).forEach((it) => { if (it && it.inflates) real += Number(it.amount) || 0; });
    return { flat: net - real, real };
  }

  /* THE SIMULATION. See the header for the config and the result. Units throughout: dollars
     are NOMINAL dollars of the year in question unless a name says otherwise, rates are
     decimals a year, inflF is the price level of the current year relative to thisYear. */
  function simulate(cfg) {
    const C = Object.assign({}, DEFAULTS, cfg || {});
    const sleeves = normSleeves(C.sleeves, C.drawOrder);
    const proportional = (DRAW_ORDERS[C.drawOrder] || {}).order === null;
    const inflPre = numOr(C.inflPre, 0.035), inflPost = numOr(C.inflPost, 0.03);

    /* TARGET WEIGHTS for rebalancing, taken from the balances as typed. Rebalancing to
       today's mix is the only target the sheet actually states. */
    const total0 = sleeves.reduce((a, sv) => a + sv.balance, 0);
    const target = sleeves.map((sv) => (total0 > 0 ? sv.balance / total0 : 0));
    const rebalancing = (C.rebalance === undefined ? 'annual' : C.rebalance) === 'annual';
    const arr = dealArrivals(C.dealSim);

    /* THE EFFECTIVE RATE ON A WITHDRAWAL FROM EACH SLEEVE, blended from the accounts behind
       it, so a sleeve that is 70% 401k and 30% brokerage is taxed as what it is. */
    const TAX = Object.assign({}, DEFAULTS.tax, C.tax || {});
    const taxRate = sleeves.map((sv) => rateOfMix(sv.taxMix, TAX));
    const dealRate = dealRateOf(C, TAX);
    const benefitRate = TAX.on ? Math.min(0.9, Math.max(0, numOr(TAX.benefitShare, 0.85) * TAX.preTax)) : 0;
    /* GROSSED UP, NOT HAIRCUT, and the difference is the whole point. Funding $100,000 of
       spending from a 22% sleeve costs $128,205 of balance, gross = net / (1 - rate), because
       the tax comes out of the withdrawal and the spending has to survive it. */
    const grossFor = (net, i) => net / (1 - taxRate[i]);
    const netOf = (gross, i) => gross * (1 - taxRate[i]);

    const stopAge = C.stopYear - C.birthYear;
    const endAge = C.planToAge;
    const nYears = endAge - stopAge + 1;
    /* 130 matches diagnose()'s cut-off: a four-digit plan age is a calendar year in an age
       box, and running it produces a two-thousand-year retirement. Refusing here is what
       makes the panel show diagnose()'s message. */
    if (nYears < 1 || !sleeves.length || C.planToAge > 130) return null;

    const E = engineRef();
    const rnd = E ? E.makeRng(C.seed) : null;
    if (!rnd) return null;

    const thisYear = C.thisYear || new Date().getFullYear();
    const stopCal = C.birthYear + stopAge;
    /* The first year this run simulates. Normally today; for somebody whose stop year is
       already past it is the stop year, because the drawing loop starts there. */
    const firstYear = Math.min(thisYear, stopCal);

    /* HOW RETURNS ARE DRAWN. 'historical' walks consecutive blocks of real years; 'sequence'
       lives through every actual historical window once; 'normal' draws each year
       independently, which is what this model did exclusively and what made it optimistic
       under stress. */
    const H = historyRef();
    const HIST = (C.sampling === 'historical' || C.sampling === 'sequence') && H;
    /* In sequence mode the path count is not a choice: there are as many runs as history
       provides. A horizon longer than the record leaves none, and an empty set would divide
       by zero; null here, and diagnose() names the reason. */
    const SEQS = (C.sampling === 'sequence' && H)
      ? H.sequences((C.birthYear + C.planToAge) - thisYear + 2)
      : null;
    if (SEQS && !SEQS.length) return null;

    /* CORRELATED SLEEVES. Independent draws let a bad year for stocks be a fine year for
       every other sleeve, which flatters the downside. When the caller supplies a correlation
       matrix (Markets.toSleeves does), one vector of correlated standard normal shocks is
       drawn per year and shared by all sleeves. A matrix that is not a valid correlation
       matrix is refused (corrRejected) and the draws stay independent. */
    let CH = null, zAt = -1, zVec = null, corrRejected = false;
    sleeves.forEach((sv, i) => { sv._i = i; });
    if (C.corr && sleeves.length > 1) {
      const R = sleeves.map((a) => sleeves.map((b) => (a.id === b.id ? 1
        : Number(((C.corr[a.id] || {})[b.id]) || 0))));
      CH = cholesky(R);
      if (!CH) corrRejected = true;
    }
    /* The correlated shock vector for year index yi, drawn once per year and reused by every
       sleeve that year. */
    function zFor(yi) {
      if (yi !== zAt) {
        zAt = yi;
        const e = sleeves.map(() => gauss(rnd, 0, 1));
        zVec = CH.map((row) => row.reduce((a, l, j) => a + l * e[j], 0));
      }
      return zVec;
    }
    const LP = sleeves.map((s) => logParams(s.mu, s.sd));
    /* Lognormal parameters for each sleeve's yield (a positive quantity, not a return).
       Mean y with a coefficient of variation c = sd / 4 gives s^2 = ln(1 + c^2) and
       m = ln(y) - s^2 / 2, so E[yield] = y exactly: a 4% yield at 16% price volatility
       swings by about 4% of itself (0.16 points). Null for a sleeve with no yield. */
    const YP = sleeves.map((s) => {
      const yv = Math.max(0, s.yield), c = Math.max(0, s.sd * 0.25);
      if (!(yv > 0)) return null;
      const s2 = Math.log(1 + c * c);
      return { m: Math.log(yv) - s2 / 2, s: Math.sqrt(s2) };
    });
    /* The mean and volatility of each historical series, so a sleeve with stated moments can
       replay history's SHAPE (its runs and its co-movement) at its own level and spread. */
    const SER = {};
    if (HIST) {
      Object.keys(H.SERIES).forEach((k) => {
        const xs = H.SERIES[k], n = xs.length;
        const m = xs.reduce((a, x) => a + x, 0) / n;
        const v = xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (n - 1);
        SER[k] = { m, sd: Math.sqrt(v) };
      });
    }

    /* ONE DRAW FOR ONE SLEEVE IN ONE YEAR, split into spendable income and a price move,
       both decimals of the balance.

       Normal mode: price is lognormal, 1 + price = exp(m + s z), with z either an
       independent normal or this year's correlated shock. Yield is lognormal too, with mean
       the sleeve's yield and a swing in proportion to it (a quarter of the price volatility
       as a share of the yield), so it is never negative and averages exactly the yield
       stated. It used to be a normal floored at zero, with an absolute swing,
       and the floor cut off only the low side: a stock sleeve yielding 0.9% at 21% volatility
       averaged about 2.5% of income, and a zero-yield crypto sleeve earned 6% a year of
       income it does not pay. A zero yield now stays zero.

       Historical mode: history reports a TOTAL return, and this model spends yield
       separately, so the sleeve's yield is taken OUT of the total (adding it would pay it
       twice). A bond fund down 17% still pays its coupon, so the price move simply goes
       negative. A sleeve whose return or volatility was stated replays the series rescaled
       to them, total = (mu + yield) + sd (x - mean) / sdSeries; an unstated one replays the
       raw series, which is what the Trinity comparison was calibrated on. Price is held
       above -95%. */
    function draw(s, hist, yi) {
      if (!HIST || !hist) {
        const g = gauss(rnd, 0, 1);
        const yl = YP[s._i];
        const yld = yl ? Math.exp(yl.m + yl.s * g) : 0;
        const lp = LP[s._i];
        const z = CH ? zFor(yi)[s._i] : gauss(rnd, 0, 1);
        return { yield: yld, price: Math.exp(lp.m + lp.s * z) - 1 };
      }
      const idx = hist[Math.max(0, Math.min(hist.length - 1, yi))];
      const key = H.SERIES[s.kind] ? s.kind : 'growth';
      const x = H.SERIES[key][idx];
      const st = SER[key];
      const total = (s.stated && st && st.sd > 0) ? (s.mu + s.yield) + s.sd * (x - st.m) / st.sd : x;
      const y = Math.max(0, s.yield);
      return { yield: y, price: Math.max(-0.95, total - y) };
    }

    /* Inflation for one year, decimal: the sampled year's CPI, or the configured constant
       (inflPre before the stop year, inflPost from it). */
    function inflAt(hist, yi, drawing) {
      if (HIST && hist) {
        const idx = hist[Math.max(0, Math.min(hist.length - 1, yi))];
        return H.cpi[idx];
      }
      return drawing ? inflPost : inflPre;
    }

    /* DATED MONEY BEFORE THE FIRST SIMULATED YEAR. Money going out (a deal's paid-in dated
       2020, a down payment typed in the past) is folded into the first year, so it is paid;
       money coming in is assumed to be in the balances already and is not added twice.
       Today's-dollar items are taken at face value (price level 1). */
    let pastOut = 0;
    if (C.dated) {
      Object.keys(C.dated).forEach((k) => {
        const y = Number(k);
        if (!(y < firstYear)) return;
        const sp = splitDated(C.dated[k]);
        const v = sp.flat + sp.real;
        if (v < 0) pastOut += v;
      });
    }
    /* This year's dated money in nominal dollars: the flat part plus the today's-dollar part
       times this path's price level, plus the folded past outgoings in the first year. */
    function datedAt(y, inflF) {
      const sp = splitDated(C.dated && C.dated[y]);
      return sp.flat + sp.real * inflF + (y === firstYear ? pastOut : 0);
    }

    /* PAY AN AMOUNT FROM SLEEVE PRINCIPAL, net of tax, in the draw order in force (pro rata
       first when the order is proportional, then in sequence for whatever rounding left).
       Each sleeve gives up gross = net / (1 - its rate) or everything it holds, whichever is
       smaller. Mutates bal, adds to took/tookPrin when given, and returns what is still
       unpaid. The one routine both phases use, so a bill before the stop year and a year's
       spending after it are paid the same way. */
    function payFromPrincipal(bal, net, took, tookPrin, taxAcc) {
      let rem = net;
      if (proportional && rem > 1) {
        let pot = 0;
        for (let i = 0; i < bal.length; i++) pot += bal[i];
        if (pot > 0) {
          const want = rem;
          for (let i = 0; i < bal.length; i++) {
            const gross = Math.min(bal[i], grossFor(want * (bal[i] / pot), i));
            const n = netOf(gross, i);
            rem -= n; bal[i] = Math.max(0, bal[i] - gross);
            if (took) took[i] += gross;
            if (tookPrin) tookPrin[i] += gross;
            if (taxAcc) taxAcc.v += gross - n;
          }
        }
      }
      for (let i = 0; i < bal.length && rem > 1; i++) {
        const gross = Math.min(bal[i], grossFor(rem, i));
        const n = netOf(gross, i);
        rem -= n; bal[i] = Math.max(0, bal[i] - gross);
        if (took) took[i] += gross;
        if (tookPrin) tookPrin[i] += gross;
        if (taxAcc) taxAcc.v += gross - n;
      }
      return Math.max(0, rem);
    }

    /* The anatomy of the failures, collected only for paths that DID fall short: mixing in
       the runs that went fine would pull every figure toward "nothing went wrong". */
    const breakYear = [], breakGap = [], breakEmpty = {}, dryAges = [];
    const preGaps = [];
    let preShortN = 0;
    /* One life, recorded step by step, when asked. traceAt picks which path; medianTrace()
       asks for the median-ending one. */
    const trace = C.trace ? [] : null;
    const traceRunup = C.trace ? [] : null;
    const traceAt = Math.max(0, Math.round(Number(C.traceAt) || 0));
    const shares = [], fulls = [], worsts = [], terms = [];
    let neverShort = 0;

    /* Per-year capture: who paid, what was left, and what the year asked for, as arrays of
       per-path values ranked once at the end. */
    const paidBy = { benefit: [], dated: [], deals: [] };
    sleeves.forEach((s) => { paidBy[s.id] = []; });
    const wealth = [], needAt = [];

    /* THE WHOLE LIFE, not just the drawing half: one slot per calendar year from today to
       the plan age, so the run-up and the decumulation share one axis. idxAt holds each
       path's price level at the start of that year, for today's-dollar conversion. */
    const curveFrom = thisYear;
    const curveTo = C.birthYear + C.planToAge;
    const curve = [], idxAt = [];
    for (let y = curveFrom; y <= curveTo; y++) { curve.push([]); idxAt.push([]); }
    for (let y = 0; y < nYears; y++) {
      sleeves.forEach((s) => { paidBy[s.id].push([]); });
      paidBy.benefit.push([]);
      paidBy.dated.push([]);
      paidBy.deals.push([]);
      wealth.push([]);
      needAt.push([]);
    }

    const baseSpend = C.spend;
    const baseFloor = C.floorSpend;
    const baseBenefit = numOr(C.benefitAnnual, 0);

    /* The guardrail multiplier for a coverage ratio (liquid money plus this year's benefit,
       over the full target): the first band whose threshold the ratio meets. */
    function guardMult(coverage) {
      for (let i = 0; i < C.guard.length; i++) {
        if (coverage >= C.guard[i][0]) return C.guard[i][1];
      }
      return C.guard[C.guard.length - 1][1];
    }

    const nPaths = SEQS ? SEQS.length : C.paths;
    for (let p = 0; p < nPaths; p++) {
      const bal = sleeves.map((s) => s.balance);
      zAt = -1;
      /* The price level, compounded from today through the saving years and on into the
         drawing ones. 1 in thisYear. */
      let inflF = 1;
      let short = false, got = 0, want = 0, nFull = 0, run = 0, worst = 0;
      let firstShortAge = null, firstShortGap = 0;
      let firstDry = null, firstDryAge = null;
      let preGap = 0;

      /* THIS PATH'S WALK THROUGH HISTORY: one index per calendar year of the whole life,
         drawn in consecutive blocks so the runs survive. Null in normal mode. */
      let hist = null;
      if (HIST && H) {
        const span = (curveTo - curveFrom) + 2;
        if (C.sampling === 'sequence' && SEQS) hist = SEQS[p % SEQS.length];
        else hist = H.blockPath(rnd, span, C.blockYears || 10);
      }

      /* This lifetime's deal arrivals by calendar year (path p of the runway spends path p of
         the book). Proceeds landing before the stop year are reinvested in the year they
         arrive; proceeds landing before today are dropped, because that cash is already in
         the balances the reader typed. */
      const mine = {}, early = {};
      if (arr) {
        const row = arr.rows[p % arr.rows.length];
        arr.years.forEach((yy, i) => {
          if (yy < thisYear) return;
          if (yy < stopCal) early[yy] = row[i];
          else mine[yy] = row[i];
        });
      }

      /* THE SAVING YEARS, from today to the year before the stop year. Same draws, same
         order, same sleeves as the drawing loop. Dated money lands at the start of the year:
         money in is added to the first sleeve, money out is paid from the sleeves in draw
         order with the tax gross-up, and anything the sleeves cannot cover is a shortfall
         that fails the lifetime. It used to come out of the first sleeve only, floored at
         zero, so a commitment larger than the cash sleeve was mostly free. Income is
         reinvested rather than spent: nobody is drawing yet. */
      for (let y = thisYear; y < stopCal; y++) {
        const ci = y - curveFrom;
        if (ci >= 0 && ci < idxAt.length) idxAt[ci].push(inflF);
        const flow = C.dated ? datedAt(y, inflF) : 0;
        let unmet = 0;
        if (flow > 0) bal[0] += flow;
        else if (flow < 0) {
          unmet = payFromPrincipal(bal, -flow, null, null, null);
          if (unmet > 1) {
            preGap += unmet;
            if (!short) { firstShortAge = y - C.birthYear; firstShortGap = unmet; }
            short = true;
          }
        }
        if (early[y] > 0) bal[0] += early[y];
        for (let i = 0; i < bal.length; i++) {
          const d = draw(sleeves[i], hist, y - curveFrom);
          bal[i] = Math.max(0, (bal[i] * (1 + d.yield)) * (1 + d.price));
        }
        inflF *= (1 + inflAt(hist, y - curveFrom, false));
        if (rebalancing) {
          let t0 = 0;
          for (let i = 0; i < bal.length; i++) t0 += bal[i];
          if (t0 > 0) for (let i = 0; i < bal.length; i++) bal[i] = t0 * target[i];
        }
        let upTot = 0;
        for (let i = 0; i < bal.length; i++) upTot += bal[i];
        if (ci >= 0 && ci < curve.length) curve[ci].push(upTot);
        if (traceRunup && p === traceAt) {
          traceRunup.push({ year: y, flow, paid: flow < 0 ? -flow - unmet : 0, unmet: unmet > 1 ? unmet : 0,
            dealsIn: early[y] > 0 ? early[y] : 0, balance: upTot });
        }
      }
      if (preGap > 1) { preShortN++; preGaps.push(preGap); }

      /* THE DRAWING YEARS, from the stop year to the plan age. Each year: work out what the
         mode asks for, add any bills, then pay in order (the benefit, dated money coming in,
         deal proceeds, every sleeve's income, then sleeve principal). Bills are paid before
         spending, so what reaches spending is whatever is left after them. */
      for (let age = stopAge; age <= endAge; age++) {
        const yi = age - stopAge;
        const calYear = C.birthYear + age;
        const cj = calYear - curveFrom;
        if (cj >= 0 && cj < idxAt.length) idxAt[cj].push(inflF);
        /* THE OPENING BALANCE, captured before anything touches it, so the ledger foots on
           a recorded number rather than one reconstructed afterwards. */
        let openBal = 0;
        for (let i = 0; i < bal.length; i++) openBal += bal[i];
        const full = baseSpend * inflF;
        const floor = baseFloor * inflF;
        const benefitGross = age >= C.benefitAge ? baseBenefit * inflF : 0;
        const benefitNet = benefitGross * (1 - benefitRate);
        const liquid = openBal;

        /* What the plan asks for this year, which is where the modes differ: the full target,
           the floor, or the full target trimmed by the guardrail band. */
        let need;
        if (C.mode === 'fixed') need = full;
        else if (C.mode === 'floor') need = floor;
        else need = full * guardMult((liquid + benefitNet) / Math.max(1, full));

        want += full;
        const asked = need;          // what THIS mode asked for, which is what it is judged on
        const taxAcc = { v: 0 };

        /* Dated money landing THIS year, nominal. A negative net is a bill (a roof, a capital
           call, a tax owed back): it is added to what the year must pay, but it is not
           spending, so it is tracked apart and paid first. */
        const dated = C.dated ? datedAt(calYear, inflF) : 0;
        const bills = dated < 0 ? -dated : 0;
        let rem = need + bills, paid = 0, swept = 0;

        /* 1. The benefit, which arrives whatever the markets did, after its tax. */
        const fromBenefit = Math.min(rem, benefitNet);
        rem -= fromBenefit; paid += fromBenefit;
        const benefitTax = benefitRate > 0 ? fromBenefit * benefitRate / (1 - benefitRate) : 0;
        taxAcc.v += benefitTax;

        /* 2. Dated money coming in: a property sale, a pension, an inheritance. Kept apart
           from deal proceeds in the composition chart, because a contracted pension and a
           hoped-for exit are not the same kind of money. What the year does not need is
           invested in the first sleeve. */
        let fromDated = 0;
        if (dated > 0) {
          fromDated = Math.min(rem, dated);
          rem -= fromDated; paid += fromDated;
          if (dated > fromDated) { bal[0] += (dated - fromDated); swept += dated - fromDated; }
        }

        /* 3. Deal proceeds landing THIS year, cash on arrival. What the year spends is taxed
           at the deals' rate (gross = net / (1 - rate)); the rest is swept, untaxed, into the
           first sleeve, where it is taxed at that sleeve's rate when it is drawn. */
        let fromDeals = 0, dealsGross = 0;
        const arrived = Math.max(0, mine[calYear] || 0);
        if (arrived > 0) {
          fromDeals = Math.min(rem, arrived * (1 - dealRate));
          dealsGross = Math.min(arrived, fromDeals / (1 - dealRate));
          rem -= fromDeals; paid += fromDeals;
          taxAcc.v += dealsGross - fromDeals;
          if (arrived > dealsGross) { bal[0] += (arrived - dealsGross); swept += arrived - dealsGross; }
        }

        /* 4 and 5. Every sleeve's income, then its price move. All yield, from every sleeve,
           before any principal from any of them. */
        const took = sleeves.map(() => 0);
        const tookYield = sleeves.map(() => 0);
        const tookPrin = sleeves.map(() => 0);
        const grew = sleeves.map(() => 0);
        /* INCOME EARNED, as distinct from income SPENT: the part of a yield that is not drawn
           stays invested, so the ledger needs both. */
        const earned = sleeves.map(() => 0);
        for (let i = 0; i < sleeves.length; i++) {
          const d = draw(sleeves[i], hist, calYear - curveFrom);
          const inc = Math.max(0, bal[i] * d.yield);
          earned[i] = inc;
          const net = Math.min(rem, netOf(inc, i));
          const take = grossFor(net, i);
          rem -= net; paid += net; took[i] += take; tookYield[i] = take;
          taxAcc.v += take - net;
          bal[i] += (inc - take);
          const before = bal[i];
          bal[i] *= (1 + d.price);
          bal[i] = Math.max(0, bal[i]);
          grew[i] = bal[i] - before;
        }
        /* 6. Sleeve principal, in the draw order in force, for whatever is still unpaid. */
        if (rem > 1) {
          const left0 = rem;
          rem = payFromPrincipal(bal, rem, took, tookPrin, taxAcc);
          paid += left0 - rem;
        }

        /* REBALANCE, after the year is funded and the returns are in. Restores the mix the
           reader typed; without it the growth sleeve quietly takes over. */
        if (rebalancing) {
          let tot = 0;
          for (let i = 0; i < bal.length; i++) tot += bal[i];
          if (tot > 0) for (let i = 0; i < bal.length; i++) bal[i] = tot * target[i];
        }

        /* BILLS FIRST, then spending. What reached spending is what was paid less the bills
           it covered, so paying a capital call never counts as a year of spending delivered. */
        const billsPaid = Math.min(bills, paid);
        const spending = paid - billsPaid;

        /* Judged against what the mode asked for plus the bills, not against the untrimmed
           target. A floor plan that covers its floor every year is succeeding. */
        if (rem > 1) {
          if (!short) {
            /* The FIRST failure only: one cause, not twenty-one symptoms. */
            firstShortAge = age;
            firstShortGap = rem;
          }
          short = true;
        }

        /* The first sleeve to hit zero, whether or not the plan ever falls short: the
           earliest warning the model produces. */
        if (!firstDry) {
          for (let i = 0; i < bal.length; i++) {
            if (bal[i] < 1 && sleeves[i].balance > 0) {
              firstDry = sleeves[i].label; firstDryAge = age; break;
            }
          }
        }

        let left = 0;
        for (let i = 0; i < bal.length; i++) left += bal[i];
        paidBy.benefit[yi].push(fromBenefit);
        paidBy.dated[yi].push(fromDated);
        paidBy.deals[yi].push(fromDeals);
        sleeves.forEach((s, i) => { paidBy[s.id][yi].push(took[i]); });
        wealth[yi].push(left);
        needAt[yi].push(full);
        if (cj >= 0 && cj < curve.length) curve[cj].push(left);

        if (trace && p === traceAt) {
          /* One ledger row. All nominal dollars of `year`. paid = benefit + datedIn + deals +
             sleeve net; spending = paid - billsPaid; tax covers sleeves, deals and benefit;
             closing (the sum of balanceAfter) = opening + return - withdrawn + sweptIn. */
          trace.push({
            year: calYear, age, opening: openBal,
            fullTarget: full, asked, mode: C.mode,
            benefit: fromBenefit, benefitGross: fromBenefit + benefitTax, benefitTax,
            dated, datedIn: fromDated, bills, billsPaid,
            deals: fromDeals, dealsGross, dealsTax: dealsGross - fromDeals,
            dealsAvailable: arrived, sweptIn: swept,
            sleeves: sleeves.map((sv, i) => ({
              label: sv.label, yield: tookYield[i], principal: tookPrin[i], income: earned[i],
              growth: grew[i], balanceAfter: bal[i],
            })),
            tax: taxAcc.v, paid, spending, unmet: rem > 1 ? rem : 0, short: rem > 1,
          });
        }

        /* Advance the price level for NEXT year, after this year's target was set from it. */
        inflF *= (1 + inflAt(hist, calYear - curveFrom, true));

        got += spending;
        const frac = asked > 0 ? spending / asked : 1;
        if (frac >= 0.999) nFull++;
        if (frac < 0.90) { run++; if (run > worst) worst = run; } else run = 0;
      }

      if (short) {
        breakYear.push(firstShortAge);
        breakGap.push(firstShortGap);
        const k = firstDry ? (firstDry + '|' + firstDryAge) : 'nothing emptied|0';
        breakEmpty[k] = (breakEmpty[k] || 0) + 1;
        if (firstDryAge != null) dryAges.push(firstDryAge);
      } else neverShort++;
      /* A PLAN THAT ASKS FOR NOTHING GOT ALL OF NOTHING, which is 1, not NaN. */
      shares.push(want > 0 ? Math.min(1, got / want) : 1);
      fulls.push(nFull / nYears);
      worsts.push(worst);
      let end = 0;
      for (let i = 0; i < bal.length; i++) end += bal[i];
      terms.push(end);
    }

    const byYear = [];
    for (let y = 0; y < nYears; y++) {
      const w = sortNum(wealth[y]);
      const row = {
        age: stopAge + y,
        year: stopCal + y,
        /* The MEDIAN target across paths. In normal mode every path has the same target; in
           historical mode each inflates by its own CPI, and the last path's figure is not a
           summary of anything. */
        need: q(sortNum(needAt[y]), 0.50),
        wealth: { p10: q(w, 0.10), p50: q(w, 0.50), p90: q(w, 0.90) },
        from: {},
      };
      row.from.benefit = q(sortNum(paidBy.benefit[y]), 0.50);
      row.from.dated = q(sortNum(paidBy.dated[y]), 0.50);
      row.from.deals = q(sortNum(paidBy.deals[y]), 0.50);
      sleeves.forEach((s) => { row.from[s.id] = q(sortNum(paidBy[s.id][y]), 0.50); });
      byYear.push(row);
    }

    return {
      cfg: C,
      sleeves,
      rebalancing,
      drawOrder: C.drawOrder || 'safe-first',
      sampling: HIST ? C.sampling : 'normal',
      correlated: !!CH,
      corrRejected,
      /* Every path's ending wealth, in path order, so medianTrace can find the middle one. */
      terminalByPath: terms.slice(),
      tax: { on: TAX.on, preTax: TAX.preTax, taxable: TAX.taxable, roth: TAX.roth,
             deals: dealRate, benefit: benefitRate, benefitShare: numOr(TAX.benefitShare, 0.85),
             bySleeve: sleeves.map((sv, i) => ({ label: sv.label, rate: taxRate[i],
               mix: sv.taxMix || null })) },
      stopAge,
      endAge,
      thisYear,
      neverShort: neverShort / nPaths,
      /* Share of the FULL target delivered as spending, always, so a floor plan cannot look
         complete because it met the smaller number it set itself, and bills cannot push it
         above 100%. */
      share: q(sortNum(shares), 0.50),
      fullYears: q(sortNum(fulls), 0.50),
      worstRun: q(sortNum(worsts), 0.50),
      terminal: {
        p10: q(sortNum(terms), 0.10),
        p50: q(sortNum(terms), 0.50),
        p90: q(sortNum(terms), 0.90),
      },
      byYear,
      trace,
      traceRunup,
      /* THE WHOLE LIFE, one row per calendar year, with the stop year marked, and the median
         price level so a caller can turn any year's dollars into today's. */
      curve: curve.map((vals, i) => {
        const v = sortNum(vals);
        const ix = sortNum(idxAt[i]);
        return {
          year: curveFrom + i,
          age: curveFrom + i - C.birthYear,
          phase: (curveFrom + i) < stopCal ? 'saving' : 'drawing',
          p10: v.length ? q(v, 0.10) : 0,
          p50: v.length ? q(v, 0.50) : 0,
          p90: v.length ? q(v, 0.90) : 0,
          index: ix.length ? q(ix, 0.50) : null,
        };
      }),
      stopYear: stopCal,
      hasDeals: !!arr,
      /* Lifetimes that could not pay a bill before the stop year. Null when none. */
      preStop: preShortN ? { n: preShortN, share: preShortN / nPaths, gapP50: q(sortNum(preGaps), 0.50) } : null,
      /* Null when nothing failed, which is a different statement from "it failed at zero". */
      breaks: breakYear.length ? {
        n: breakYear.length,
        share: breakYear.length / nPaths,
        ageP10: q(sortNum(breakYear), 0.10),
        ageP50: q(sortNum(breakYear), 0.50),
        gapP50: q(sortNum(breakGap), 0.50),
        dryAgeP50: dryAges.length ? q(sortNum(dryAges), 0.50) : null,
        empty: (function () {
          /* Grouped by WHICH sleeve emptied first. */
          const by = {};
          Object.keys(breakEmpty).forEach((k) => {
            const nm = k.split('|')[0];
            by[nm] = (by[nm] || 0) + breakEmpty[k];
          });
          return Object.keys(by)
            .map((nm) => ({ what: nm, n: by[nm], share: by[nm] / breakYear.length }))
            .sort((a, b) => b.n - a.n);
        }()),
      } : null,
    };
  }

  /* WHAT ACTUALLY MOVES THE NUMBER.
   *
   * "Never short 76%" tells a reader they might fail and nothing about what to do. This does
   * not attribute failures to causes, which in a model with this many interacting parts is
   * mostly storytelling. It RE-RUNS the model with one thing changed at a time, on the same
   * seed, and reports the change in never short (a difference of shares, 0..1). These are
   * sensitivities, not recommendations. Returns { base, levers: [{ label, note, neverShort,
   * delta, share }], paths }, sorted by the size of the effect, or null.
   */
  function levers(cfg, opts) {
    const o = opts || {};
    const paths = o.paths || 700;
    const base = Object.assign({}, DEFAULTS, cfg, { paths });
    const run = (patch) => simulate(Object.assign({}, base, patch));

    const b = run({});
    if (!b) return null;

    const out = [];
    const add = (label, patch, note) => {
      const r = run(patch);
      if (!r) return;
      out.push({ label, note: note || '', neverShort: r.neverShort,
        delta: r.neverShort - b.neverShort, share: r.share });
    };

    add('Spend 10% less', { spend: base.spend * 0.9, floorSpend: Math.min(base.floorSpend, base.spend * 0.9) },
        'the biggest lever in almost every plan, and the least popular');
    add('Work two more years', { stopYear: base.stopYear + 2 },
        'two more years of earning, two fewer of drawing');
    if (base.benefitAge < 70) {
      /* Claiming later is worth roughly 8% a year in the US. Modelled as a straight uplift
         rather than the schedule, because the point is the direction and rough size. */
      const yrs = 70 - base.benefitAge;
      add('Start Social Security at 70', { benefitAge: 70, benefitAnnual: base.benefitAnnual * (1 + 0.08 * yrs) },
          'later but larger, at roughly 8% a year of waiting');
    }
    if (base.mode !== 'guard') {
      add('Use guardrails', { mode: 'guard' },
          'trim the ask in thin years instead of drawing through them');
    }
    if (base.mode !== 'floor') {
      add('Spend only the must-have amount', { mode: 'floor' },
          'safer, but you never spend the full target');
    }
    if (base.dealSim) {
      add('Without the private deals', { dealSim: null },
          'what the book is actually worth to the plan');
    }
    if (base.dated) {
      add('Without any dated money', { dated: null },
          'property sales, pensions, one-offs, capital calls and tax strategies all left out');
    }

    out.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
    return { base: b, levers: out, paths };
  }

  const Runway = { simulate, levers, DEFAULTS, SLEEVE_KINDS, DRAW_ORDER, DRAW_ORDERS,
                   normSleeves, logParams, cholesky };

  /* WHY THERE IS NOTHING TO SHOW, specifically. simulate() returns null for several different
     reasons, and a reader running their own sheet for the first time needs to know which of
     their numbers is odd. Returns { ok, why, msg } with msg as short HTML. */
  function diagnose(cfg) {
    const C = Object.assign({}, DEFAULTS, cfg || {});
    const sl = (C.sleeves || []).filter((s) => Number(s && s.balance) > 0);
    const stopAge = C.stopYear - C.birthYear;
    if (!(C.sleeves || []).length) {
      return { ok: false, why: 'no-sleeves',
        msg: 'There are no balances to run this on. Add a <b>Balances</b> tab to your tracker '
          + 'with one row per account and what is in it.' };
    }
    if (!sl.length) {
      return { ok: false, why: 'zero-balances',
        msg: 'Every balance on the Balances tab is zero, so there is nothing to draw on. If '
          + 'that is a placeholder sheet, fill in the amounts and run it again.' };
    }
    if (!(stopAge > 0)) {
      return { ok: false, why: 'stop-before-birth',
        msg: 'The stop-work year (' + C.stopYear + ') is at or before the birth year ('
          + C.birthYear + '). Check both on the <b>You</b> tab.' };
    }
    /* A FOUR-DIGIT PLAN AGE IS A YEAR IN AN AGE BOX. Refused rather than corrected, but the
       message names what it probably meant. 130 leaves room for the most optimistic plan. */
    if (C.planToAge > 130) {
      const guess = C.planToAge > 1900 && C.planToAge < 2200
        ? C.planToAge - C.birthYear : null;
      return { ok: false, why: 'plan-age-is-a-year',
        msg: 'The plan runs to age <b>' + C.planToAge + '</b>, which is a year rather than an '
          + 'age. ' + (guess && guess > 0 && guess < 130
            ? 'Living to ' + C.planToAge + ' from a ' + C.birthYear + ' birth year is age <b>'
              + guess + '</b>, which is probably what was meant.'
            : 'Plan to age is an age, like 92, not a calendar year.') };
    }
    if (C.planToAge <= stopAge) {
      return { ok: false, why: 'plan-age-too-low',
        msg: 'The plan runs to age ' + C.planToAge + ', and work stops at age ' + stopAge
          + ', so there are no retirement years to model. Either plan to a later age or stop '
          + 'work sooner. A common cause is typing a YEAR where the plan age goes.' };
    }
    const H = historyRef();
    if (C.sampling === 'sequence' && H) {
      const n = (C.birthYear + C.planToAge) - (C.thisYear || new Date().getFullYear()) + 2;
      if (n > H.N) {
        return { ok: false, why: 'history-too-short',
          msg: 'This plan runs ' + n + ' years, longer than the ' + H.N + ' years of market '
            + 'history on record, so there is no complete historical sequence to live through. '
            + 'Use the block-sampled historical mode instead.' };
      }
    }
    return { ok: true, why: null, msg: '' };
  }

  /* ONE COHERENT FUTURE, the middle one, as a year-by-year ledger.

     The byYear rows are percentiles and cannot be read down a column. This runs the model,
     finds the path whose ENDING wealth is the median by the same rank rule as q() (so the
     ledger's last closing balance is the headline's terminal.p50), and runs it again asking
     for that path to be recorded. The generator is seeded, so the second pass reproduces the
     same futures exactly. Returns { pathIndex, rows, runup, terminal, of } or null. */
  function medianTrace(cfg) {
    const first = simulate(Object.assign({}, cfg || {}));
    if (!first || !first.terminalByPath || !first.terminalByPath.length) return null;
    const n = first.terminalByPath.length;
    const idx = first.terminalByPath
      .map((v, i) => [v, i])
      .sort((a, b) => a[0] - b[0])[Math.floor(0.5 * (n - 1))][1];
    const second = simulate(Object.assign({}, cfg || {}, { trace: true, traceAt: idx }));
    if (!second || !second.trace) return null;
    return { pathIndex: idx, rows: second.trace, runup: second.traceRunup,
             terminal: first.terminalByPath[idx], of: n };
  }

  Runway.medianTrace = medianTrace;
  Runway.diagnose = diagnose;
  root.Runway = Runway;
  if (typeof module !== 'undefined' && module.exports) module.exports = Runway;
}(typeof window !== 'undefined' ? window : globalThis));
