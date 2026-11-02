/* PUBLIC MARKETS: the statistical model (prototype).
 *
 * The original app modelled private deals only. This adds everything that trades every day
 * (stocks, ETFs, bonds, gold, commodities, crypto, cash) and one set of statistics that the
 * rest of the app can share:
 *
 *   classify()        ticker or label -> asset class
 *   holdingStats()    expected return, volatility, yield, beta, factor loadings per holding
 *   portfolioStats()  the same for any set of holdings, plus risk contribution, downside,
 *                     diversification and concentration
 *   toSleeves()       holdings -> Retirement Simulator sleeves, WITH their correlations
 *   cone()            the planned range of a balance over time (the Equity Curve)
 *
 * HOW CORRELATION WORKS. Every asset class is described by how much of its variance comes
 * from five shared drivers (equity, rates, real assets, credit, crypto); the rest is its own.
 * Correlation between any two holdings follows from that, so the matrix is always valid and
 * a new class needs one line, not a new row and column. Single stocks use the classic
 * single-index model: beta sets their share of market risk, the rest is company-specific.
 *
 * The numbers are long-run assumptions in the range of published 10-year capital market
 * forecasts. They are opinions, meant to be argued with; a holding can override any of them.
 *
 * PLACE IN THE APP. Loaded by index.html after engine.js and before runway.js, so it has no
 * dependency on any UI file. It exposes one global, window.Markets. markets-ui.js draws the
 * Overview, Holdings and Equity Curve tabs from it; runway-ui.js turns its sleeves into the
 * Retirement Simulator's inputs; includes.js and consider-ui.js do not use it directly.
 * Pure functions except load(), which reads the workbook, and the seeded cones.
 *
 * DATA SHAPES.
 *   holding  { symbol, name, cls, account, acctType ('preTax'|'roth'|'taxable'), qty, price,
 *              value (dollars, > 0), cost (dollars or null), beta, mu, sd, y (fractions a
 *              year, or null for "use the class assumption"), st: holdingStats(), gain,
 *              isPrivate?, uncalled?, commitment? }
 *   load()   { holdings: [holding], history: [{date 'YYYY-MM-DD', account, value, flow}],
 *              isDemo, asOf, source ('balances'|'holdings'|'sample'), notes: [string] }
 *   sleeve   { id, label, kind, balance, mu (price return), sd, yield, taxMix } with corr
 *              { [id]: { [id]: -1..1 } }, which is what Runway.simulate takes.
 *
 * WHICH HOUSEHOLD (load). One rule, so every tab shows the same money:
 *   1. a Balances tab (the shipped tracker template has one; the Retirement tab already
 *      reads it through portfolio.js), else
 *   2. a Holdings tab, even an empty one (an empty tab means "no public holdings"), else
 *   3. the fictional sample household, which the tabs label as such.
 * When both a Balances and a Holdings tab exist, Balances wins and a note says the Holdings
 * rows were not used. A Balances tab is never read as balance history.
 *
 * PERCENT CELLS (pctIn). Engine.num's rule: text with a % sign is percent ("1%" is 0.01,
 * "1.2%" is 0.012, "150%" is 1.5). A bare number, typed or numeric text, is a fraction when
 * it is below 1 in size (0.012 is 1.2%, which is how a percent-formatted Excel cell
 * arrives) and percent points from 1 up (1.2 is 1.2%, 8 is 8%). portfolio.js uses the same
 * rule for the Balances, You and Property tabs, and a test holds the two together.
 *
 * INVARIANTS. Risk contributions sum to 1. The correlation matrix is symmetric, in -1..1,
 * and positive semi-definite by construction. Negative holding values are left out with a
 * note rather than half counted (totals and statistics always cover the same rows).
 *
 * KNOWN LIMITS. Private deals enter the whole-portfolio statistics at what has been paid
 * in, with their asset type's assumptions, not the deal-by-deal model. Public and private
 * cones are drawn independently (combineCones), although the factor model correlates them,
 * so the whole-portfolio range is a little too narrow; the Equity Curve says so.
 */
(function (root) {
  'use strict';

  const FACTORS = ['equity', 'rates', 'real', 'credit', 'crypto'];
  const RF = 0.035;           // cash / T-bill return
  const ERP = 0.035;          // equity risk premium over cash: beta 1 -> 7.0%
  const MKT_SD = 0.16;        // US stock market volatility
  const IDIO_SD = 0.28;       // company-specific volatility of a typical single stock

  /* mu = expected TOTAL return a year, sd = volatility, y = income yield,
     f = share of variance from each shared driver (negative = moves the other way). */
  const CLASSES = {
    usEquity:    { label: 'US stocks', group: 'stocks', mu: 0.070, sd: 0.16, y: 0.013, f: { equity: 0.95 } },
    growth:      { label: 'US growth & tech', group: 'stocks', mu: 0.080, sd: 0.22, y: 0.006, f: { equity: 0.85 } },
    intlEquity:  { label: 'International stocks', group: 'stocks', mu: 0.075, sd: 0.18, y: 0.030, f: { equity: 0.70 } },
    stock:       { label: 'Single stocks', group: 'stocks', mu: null, sd: null, y: 0.005, f: null },
    dividend:    { label: 'Dividend & covered-call', group: 'income', mu: 0.070, sd: 0.13, y: 0.045, f: { equity: 0.75 } },
    highYield:   { label: 'High yield & credit', group: 'income', mu: 0.060, sd: 0.09, y: 0.068, f: { equity: 0.45, credit: 0.30, rates: 0.05 } },
    bonds:       { label: 'Core bonds', group: 'bonds', mu: 0.045, sd: 0.06, y: 0.042, f: { rates: 0.85, equity: 0.02 } },
    treasLong:   { label: 'Long Treasuries', group: 'bonds', mu: 0.045, sd: 0.13, y: 0.046, f: { rates: 0.95, equity: -0.03 } },
    tips:        { label: 'Inflation-linked bonds', group: 'bonds', mu: 0.040, sd: 0.06, y: 0.035, f: { rates: 0.50, real: 0.20 } },
    reit:        { label: 'REITs', group: 'real', mu: 0.065, sd: 0.20, y: 0.038, f: { equity: 0.50, rates: 0.05 } },
    gold:        { label: 'Gold & silver', group: 'real', mu: 0.040, sd: 0.15, y: 0, f: { real: 0.35, rates: 0.05 } },
    commodities: { label: 'Commodities', group: 'real', mu: 0.035, sd: 0.17, y: 0, f: { real: 0.50, equity: 0.10 } },
    crypto:      { label: 'Crypto', group: 'alts', mu: 0.080, sd: 0.60, y: 0, f: { crypto: 0.70, equity: 0.15 } },
    cash:        { label: 'Cash & T-bills', group: 'cash', mu: RF, sd: 0.005, y: RF, f: {} },
    /* Private deals, valued at what has been paid in. Used for the whole-portfolio view only; the
       private-deal tabs keep their own, far more detailed, deal-by-deal model. */
    pCredit:     { label: 'Private credit', group: 'private', mu: 0.090, sd: 0.08, y: 0.08, f: { credit: 0.30, equity: 0.15 } },
    pRealEstate: { label: 'Private real estate', group: 'private', mu: 0.080, sd: 0.12, y: 0.04, f: { equity: 0.20, rates: 0.10 } },
    pEquity:     { label: 'Private equity', group: 'private', mu: 0.110, sd: 0.22, y: 0, f: { equity: 0.50 } },
    venture:     { label: 'Venture', group: 'private', mu: 0.120, sd: 0.45, y: 0, f: { equity: 0.30, crypto: 0.03 } },
  };

  /* How each group becomes a Retirement Simulator sleeve. `kind` sets the draw order and
     whether income is spent before principal. */
  const GROUPS = {
    stocks:  { label: 'Stocks', kind: 'growth', color: '#1F3864' },
    income:  { label: 'Income', kind: 'income', color: '#2E6B52' },
    bonds:   { label: 'Bonds', kind: 'bonds', color: '#5B8DB8' },
    real:    { label: 'Real assets', kind: 'growth', color: '#C9A227' },
    alts:    { label: 'Crypto', kind: 'growth', color: '#D0703C' },
    cash:    { label: 'Cash', kind: 'cash', color: '#9AA8B8' },
    private: { label: 'Private deals', kind: null, color: '#7B5EA7' },
  };
  const PRIVATE_COLORS = { pCredit: '#B17930', pRealEstate: '#8A5A44', pEquity: '#4E7F7A', venture: '#7B5EA7' };

  const SYMBOLS = {
    usEquity: 'VOO SPY IVV VTI ITOT SCHB SCHX RSP SPLG IWM IJH VB VO',
    growth: 'QQQ QQQM VUG SCHG IWF XLK VGT SMH SOXX ARKK IGV MGK',
    intlEquity: 'VXUS VEA IEFA EFA VWO IEMG EEM IXUS SCHF ACWX',
    dividend: 'SCHD VYM DVY JEPI JEPQ DGRO NOBL HDV SPYD DIVO QYLD XYLD',
    highYield: 'HYG JNK USHY BKLN SRLN PFF ANGL',
    bonds: 'AGG BND SCHZ IEF SHY VGIT BSV LQD MUB VCIT IGSB BIV SCHR',
    treasLong: 'TLT EDV VGLT ZROZ SPTL GOVZ',
    tips: 'TIP SCHP VTIP STIP',
    reit: 'VNQ SCHH XLRE IYR USRT',
    gold: 'GLD IAU GLDM SGOL SLV PSLV PHYS AAAU SIVR',
    commodities: 'DBC PDBC GSG USO DBA BCI CMDY COMT',
    crypto: 'IBIT FBTC GBTC BITO ETHA ETHE ARKB BITB BTC ETH',
    cash: 'SGOV BIL SHV USFR TFLO SPAXX SWVXX VMFXX FDRXX CASH',
  };
  const BY_SYMBOL = {};
  Object.keys(SYMBOLS).forEach((c) => SYMBOLS[c].split(' ').forEach((s) => { BY_SYMBOL[s] = c; }));

  /* A label the reader typed, matched loosely. Checked before the ticker table so an
     explicit "Asset class" column always wins. */
  const LABEL_RULES = [
    [/crypto|bitcoin|ether/, 'crypto'], [/gold|silver|precious/, 'gold'],
    [/commodit|oil|energy fut/, 'commodities'], [/reit|real estate/, 'reit'],
    [/tips|inflation/, 'tips'], [/long.*(treas|bond)|treasury.*long/, 'treasLong'],
    [/high yield|junk|credit|loan|preferred/, 'highYield'], [/bond|fixed income|treasur|muni/, 'bonds'],
    [/cash|money market|t-bill|treasury bill/, 'cash'], [/dividend|covered call|income/, 'dividend'],
    [/international|intl|emerging|developed|foreign/, 'intlEquity'], [/growth|tech|nasdaq|semi/, 'growth'],
    [/single|stock|equity|share/, 'stock'], [/index|s&p|total market|etf/, 'usEquity'],
  ];

  /* Ticker or typed label -> a CLASSES key. A typed label wins over the ticker table, and
     anything unrecognised is a single stock (the most cautious volatility). */
  function classify(symbol, label) {
    const l = String(label || '').toLowerCase().trim();
    if (l) {
      if (CLASSES[l]) return l;
      for (const [re, c] of LABEL_RULES) if (re.test(l)) return c;
    }
    const s = String(symbol || '').toUpperCase().trim();
    return BY_SYMBOL[s] || 'stock';
  }

  /* Which tax bucket an account is in: a stated account type first, then the account's
     name. Roth is tested before IRA because "Roth IRA" contains "IRA". Unknown is taxable. */
  function acctType(name, stated) {
    const t = String(stated || '').toLowerCase();
    if (/roth|hsa/.test(t)) return 'roth';
    if (/pre|trad|ira|401|403|sep|tsp|deferred/.test(t)) return 'preTax';
    if (/tax|brok|individual|joint|trust/.test(t)) return 'taxable';
    const n = String(name || '').toLowerCase();
    if (/roth|hsa/.test(n)) return 'roth';
    if (/ira|401|403|sep|tsp|pension|sdira|rollover/.test(n)) return 'preTax';
    return 'taxable';
  }
  const ACCT_TYPE_LABEL = { preTax: 'Pre-tax', roth: 'Roth', taxable: 'Taxable' };

  /* Signed square roots of the variance shares: the loading on each shared driver, in
     FACTORS order. A share of 0.95 on equity is a loading of 0.975; the sign carries direction. */
  function loadings(f) {
    return FACTORS.map((k) => {
      const v = (f && f[k]) || 0;
      return Math.sign(v) * Math.sqrt(Math.abs(v));
    });
  }
  const L_US = loadings(CLASSES.usEquity.f);

  /* Expected return, volatility, yield, beta and loadings for one holding. Anything the
     holding states (mu, sd, y, beta) overrides the class assumption. All fractions a year.
     Single stocks (single-index model): sd = sqrt((beta x 16%)^2 + 28%^2), mu = cash +
     beta x 3.5%, and the equity loading is beta x sd_US x L_US / sd, so the beta reported
     back is exactly the beta stated (US stocks load sqrt(0.95), not 1, on the equity driver;
     using 1 here used to turn a stated 1.70 into 1.74). Returns { mu, sd, y, L, e2, beta },
     where L is the loading on each of FACTORS and e2 the holding's own share of variance. */
  function holdingStats(h) {
    const c = CLASSES[h.cls] || CLASSES.stock;
    let mu, sd, y, L;
    if (h.cls === 'stock' || !c.f) {
      const beta = h.beta != null ? h.beta : 1.2;
      sd = h.sd != null ? h.sd : Math.sqrt(Math.pow(beta * MKT_SD, 2) + IDIO_SD * IDIO_SD);
      mu = h.mu != null ? h.mu : RF + beta * ERP;
      y = h.y != null ? h.y : c.y;
      const share = Math.min(0.95, Math.pow(beta * MKT_SD * Math.sqrt(0.95) / sd, 2));
      L = loadings({ equity: share });
    } else {
      mu = h.mu != null ? h.mu : c.mu;
      sd = h.sd != null ? h.sd : c.sd;
      y = h.y != null ? h.y : c.y;
      L = loadings(c.f);
    }
    const e2 = Math.max(0, 1 - L.reduce((a, x) => a + x * x, 0));
    const beta = (sd * L[0]) / (CLASSES.usEquity.sd * L_US[0]);
    return { mu, sd, y, L, e2, beta };
  }

  /* Standard normal CDF (Abramowitz-Stegun 7.1.26), accurate to about 1e-7. Used for the
     chance of a losing year and the histogram's bar heights. */
  function phi(x) {
    const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
    const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
    return 0.5 * (1 + Math.sign(x) * erf);
  }

  /* Lognormal parameters for a year with arithmetic mean mu and volatility sd (fractions):
     s^2 = ln(1 + sd^2 / (1 + mu)^2), m = ln(1 + mu) - s^2 / 2, so E[exp(N(m, s))] = 1 + mu.
     The typical (median) year is exp(m) - 1, a little below mu. */
  function logParams(mu, sd) {
    const s2 = Math.log(1 + (sd * sd) / Math.pow(1 + mu, 2));
    return { m: Math.log(1 + mu) - s2 / 2, s: Math.sqrt(s2) };
  }

  /* The whole statistical picture for a set of holdings. Each item needs a value; stats
     are computed if missing. Only positive values count (a negative row is a liability,
     which load() keeps out with a note). Returns null when nothing has value, so callers
     must guard. Portfolio variance = sum over drivers of (sum w sd L)^2 + sum (w sd)^2 e2.
     Everything returned is a fraction a year except value (dollars), effN (count), divRatio
     (ratio) and sharpe ((mu - cash) / sd). */
  function portfolioStats(items) {
    const rows = items.filter((h) => h.value > 0).map((h) => Object.assign({}, h, h.st ? {} : { st: holdingStats(h) }));
    const V = rows.reduce((a, h) => a + h.value, 0);
    if (!V) return null;
    const F = FACTORS.map(() => 0);
    let mu = 0, y = 0, beta = 0, sumWsd = 0, hhi = 0, idio = 0;
    rows.forEach((h) => {
      const w = h.value / V, st = h.st;
      h.w = w;
      mu += w * st.mu; y += w * st.y; beta += w * st.beta; sumWsd += w * st.sd; hhi += w * w;
      st.L.forEach((l, k) => { F[k] += w * st.sd * l; });
      idio += Math.pow(w * st.sd, 2) * st.e2;
    });
    const varP = F.reduce((a, x) => a + x * x, 0) + idio;
    const sd = Math.sqrt(varP);
    /* RISK CONTRIBUTION: each holding's share of total variance. They sum to 100%, and a
       holding whose risk share is well above its weight is where the volatility lives. */
    rows.forEach((h) => {
      const st = h.st, ws = h.w * st.sd;
      h.risk = varP > 0 ? (ws * st.L.reduce((a, l, k) => a + l * F[k], 0) + ws * ws * st.e2) / varP : 0;
    });
    const lp = logParams(mu, sd);
    const top = rows.slice().sort((a, b) => b.value - a.value);
    return {
      value: V, mu, sd, y, beta, rows,
      median: Math.exp(lp.m) - 1,                       // typical (median) year
      down5: Math.exp(lp.m - 1.645 * lp.s) - 1,         // a 1-in-20 bad year
      up95: Math.exp(lp.m + 1.645 * lp.s) - 1,
      pDown: phi(-lp.m / lp.s),                         // chance of a losing year
      sharpe: sd > 0 ? (mu - RF) / sd : 0,
      divRatio: sd > 0 ? sumWsd / sd : 1,               // how much diversification is doing
      effN: hhi > 0 ? 1 / hhi : 0,                      // equivalent number of equal holdings
      top5: top.slice(0, 5).reduce((a, h) => a + h.w, 0),
      exposure: F,
    };
  }

  /* HOLDINGS -> RETIREMENT SLEEVES. One sleeve per group, each with the expected return,
     volatility and yield of what is actually in it, the tax treatment of the accounts it
     sits in, and the correlation between sleeves, so a bad year for stocks is a bad year
     for the Real assets sleeve too, to the degree history says it is. */
  function toSleeves(holdings) {
    const by = {};
    holdings.filter((h) => h.value > 0 && GROUPS[group(h)].kind).forEach((h) => {
      const g = group(h);
      (by[g] = by[g] || []).push(h);
    });
    const sleeves = [], G = {};
    Object.keys(GROUPS).forEach((g) => {
      if (!by[g]) return;
      const ps = portfolioStats(by[g]);
      const tax = { preTax: 0, roth: 0, taxable: 0 };
      by[g].forEach((h) => { tax[h.acctType || 'taxable'] += h.value; });
      sleeves.push({
        id: g, label: GROUPS[g].label, kind: GROUPS[g].kind, balance: ps.value,
        mu: ps.mu - ps.y,                  // the simulator draws price and income separately
        sd: ps.sd, yield: ps.y,
        taxMix: { preTax: tax.preTax / ps.value, roth: tax.roth / ps.value, taxable: tax.taxable / ps.value },
      });
      G[g] = { F: ps.exposure, sd: ps.sd };
    });
    const corr = {};
    sleeves.forEach((a) => {
      corr[a.id] = {};
      sleeves.forEach((b) => {
        const ga = G[a.id], gb = G[b.id];
        corr[a.id][b.id] = a.id === b.id ? 1
          : (ga.sd > 0 && gb.sd > 0 ? ga.F.reduce((s, x, k) => s + x * gb.F[k], 0) / (ga.sd * gb.sd) : 0);
      });
    });
    return { sleeves, corr };
  }

  /* The GROUPS key (sleeve) a holding belongs to. */
  function group(h) { return (CLASSES[h.cls] || CLASSES.stock).group; }

  /* THE PLANNED CONE. A balance carried forward month by month from a start date, drawn
     from the portfolio's own return and volatility, with an optional steady contribution.
     Seeded, so the plan does not move when the page reloads: it is a commitment to measure
     the actual against, not a forecast that updates itself. */
  function cone(opts) {
    const months = Math.max(1, Math.round(opts.months || 36));
    const paths = opts.paths || 2000;
    const lp = logParams(opts.mu, opts.sd);
    const mm = lp.m / 12, ms = lp.s / Math.sqrt(12);
    const flow = opts.monthlyFlow || 0;
    const E = (typeof Engine !== 'undefined' && Engine) ? Engine : root.Engine;
    const rnd = E.makeRng(opts.seed || 20261028);
    const gauss = () => {
      let u = 0, v = 0;
      while (u === 0) u = rnd();
      while (v === 0) v = rnd();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const at = [];
    for (let t = 0; t <= months; t++) at.push(new Float64Array(paths));
    for (let p = 0; p < paths; p++) {
      let v = opts.start;
      at[0][p] = v;
      for (let t = 1; t <= months; t++) {
        v = v * Math.exp(mm + ms * gauss()) + flow;
        at[t][p] = v;
      }
    }
    const q = (arr, pc) => arr[Math.min(arr.length - 1, Math.floor(pc * (arr.length - 1)))];
    const raw = opts.keepPaths ? at.map((a) => a.slice()) : null;   // path order, before sorting
    const out = at.map((arr) => {
      arr.sort();
      return { sorted: arr, p5: q(arr, 0.05), p25: q(arr, 0.25), p50: q(arr, 0.5), p75: q(arr, 0.75), p95: q(arr, 0.95) };
    });
    out.raw = raw;
    return out;
  }

  /* THE PRIVATE DEALS' PLANNED CONE, from the same futures as the Liquidity Outlook.
     engine.js simulate() plays each future by drawing, deal by deal, an exit-timing offset
     and an outcome multiple from that deal's own seeded stream (shared once per company, so
     two tranches share a fate). This replays exactly those draws through Engine.pathDraws,
     so path p here is future p there, and then values the account month by month instead of
     only counting cash:

       value = cash received so far (preferred return + exit proceeds, held in the account)
             + what is still held: capital called so far x its mark, for the share not yet
               sold, where the mark moves in a straight line from cost at the plan start to
               the outcome that future drew, reached at the exit.

     Capital calls are money added, like a contribution, and are returned as `flows` so the
     curve can say so. Months within a year share that year's calls and preferred return
     evenly; an exit lands mid-year (or next month, if mid-year has passed). Write-offs mark
     down to zero by their exit year. This is a planning view, not a valuation: real marks
     come from sponsor statements. */
  function privateCone(book, opts) {
    const E = (typeof Engine !== 'undefined' && Engine) ? Engine : root.Engine;
    const list = (book || []).filter((b) => b.commitment > 0);
    if (!E || !list.length) return null;
    const paths = opts.paths || 2000, months = opts.months, t0 = opts.t0;   // t0: Dec 31 of the year before
    const Y0 = new Date(t0).getFullYear() + 1;
    const now = E.calendarNow();
    const nowM = Math.max(0, (now.year - Y0) * 12 + (12 - Math.round(now.left * 12)));   // months already behind us
    const at = (y, m) => (y - Y0) * 12 + m;   // month index of month m (1..12) of year y
    /* deterministic per deal: capital in at each month (cost basis), and the calls themselves */
    const called = list.map((b) => {
      const arr = new Float64Array(months + 1);
      const opening = b.fy < Y0 ? b.funded : 0;
      const cs = E.callsOf(b);
      const inc = new Float64Array(months + 1);
      if (b.fy >= Y0) inc[Math.min(months, Math.max(1, nowM))] += b.funded;   // funded this year: in by today
      for (const y of Object.keys(cs)) {
        const yy = Number(y), first = yy === now.year ? Math.max(1, nowM - at(yy, 0) + 1) : 1;
        for (let m = first; m <= 12; m++) { const k = at(yy, m); if (k >= 1 && k <= months) inc[k] += cs[y] / (13 - first); }
      }
      let run = opening;
      for (let k = 0; k <= months; k++) { run += inc[k]; arr[k] = run; }
      return { arr, inc, opening };
    });
    const flows = new Float64Array(months + 1);
    called.forEach((c) => { for (let k = 1; k <= months; k++) flows[k] += c.inc[k]; });
    const start = called.reduce((a, c) => a + c.opening, 0);

    /* THE DRAWS COME FROM THE ENGINE. Since 2026-10-31 every deal group has its own seeded
       stream (two draws per group per path, timing first, from Engine.streamFor(groupKey, p,
       seed)), and Engine.pathDraws returns exactly the per-path draw simulate() makes,
       shared fate included. Replaying through it means this cone cannot drift from the
       Liquidity Outlook. There is deliberately no local copy of the draw. */
    if (typeof E.pathDraws !== 'function') return null;
    const seed = opts.seed != null ? opts.seed : E.CFG.seed;
    const atM = []; for (let k = 0; k <= months; k++) atM.push(new Float64Array(paths));
    const val = new Float64Array(months + 1);
    for (let p = 0; p < paths; p++) {
      val.fill(0);
      const pd = E.pathDraws(list, p, seed);
      for (let bi = 0; bi < list.length; bi++) {
        const b = list[bi], c = called[bi];
        const off = pd[bi].off, mlt = pd[bi].m;
        /* cash into the account: preferred return through the year, exits mid-year */
        const cashAt = new Float64Array(months + 1);
        if (b.coupon > 0) {
          const pf = E.prefFactor(b, mlt);
          if (pf > 0) for (let k = 1; k <= b.hold; k++) {
            const yy = b.fy + k, amt = E.prefInYear(b, k) * pf;
            for (let m = 1; m <= 12; m++) { const i = at(yy, m); if (i >= 1 && i <= months) cashAt[i] += amt / 12; }
          }
        }
        const plan = E.exitPlan(b, off), cash = b.commitment * mlt;
        let firstExit = Infinity;
        const sold = new Float64Array(months + 1);
        for (const [y, w] of plan) {
          let i = at(y, 6); if (y === now.year && i <= nowM) i = nowM + 1;
          if (i < 1) i = 1;
          firstExit = Math.min(firstExit, i);
          if (i <= months) { cashAt[i] += cash * w; sold[i] += w; }
        }
        let got = 0, gone = 0;
        for (let k = 0; k <= months; k++) {
          got += cashAt[k]; gone += sold[k];
          const prog = firstExit > 0 ? Math.min(1, k / firstExit) : 1;
          const mark = 1 + (mlt - 1) * prog;   // every committed dollar is called by the exit, so the drawn multiple is the multiple on cost
          val[k] += got + Math.max(0, 1 - gone) * c.arr[k] * Math.max(0, mark);
        }
      }
      for (let k = 0; k <= months; k++) atM[k][p] = val[k];
    }
    const q = (arr, pc) => arr[Math.min(arr.length - 1, Math.floor(pc * (arr.length - 1)))];
    return {
      start, flows, paths: atM.map((a) => a.slice()),
      cone: atM.map((arr) => { arr.sort(); return { sorted: arr, p5: q(arr, 0.05), p25: q(arr, 0.25), p50: q(arr, 0.5), p75: q(arr, 0.75), p95: q(arr, 0.95) }; }),
    };
  }

  /* Two sets of paths added future by future (public and private drawn independently).
     a and b are [month][path] arrays of dollars; the result has the same percentile shape as
     cone(). Independence is a simplification: the factor model says venture and private
     equity move partly with stocks, so the true combined range is a little wider. */
  function combineCones(a, b) {
    const q = (arr, pc) => arr[Math.min(arr.length - 1, Math.floor(pc * (arr.length - 1)))];
    return a.map((arr, k) => {
      const n = Math.min(arr.length, b[k].length), s = new Float64Array(n);
      for (let i = 0; i < n; i++) s[i] = arr[i] + b[k][i];
      s.sort();
      return { sorted: s, p5: q(s, 0.05), p25: q(s, 0.25), p50: q(s, 0.5), p75: q(s, 0.75), p95: q(s, 0.95) };
    });
  }

  /* Where a value sits in a sorted distribution, 0 to 1 (share of paths at or below x),
     by binary search. */
  function rankIn(sorted, x) {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= x) lo = mid + 1; else hi = mid; }
    return lo / sorted.length;
  }

  /* ── reading the workbook ───────────────────────────────────────────────── */

  /* A money or count cell to a number, or null for blank or unreadable. Strips $ , % and
     spaces; percent handling is pctIn's job, not this one's. */
  const num = (v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const n = Number(String(v).replace(/[$,%\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  /* A PERCENT CELL, read one way everywhere (see the header). Text with a % sign divides by
     100, exactly as Engine.num does. A bare number below 1 in size is already a fraction
     (a percent-formatted Excel cell holding 1.2% arrives as 0.012); from 1 up it is percent
     points (1.2 is 1.2%, not 120%). Returns a fraction, or null for a blank cell. */
  function pctIn(v) {
    if (v == null || v === '') return null;
    const n = num(v);
    if (n == null) return null;
    if (typeof v !== 'number' && /%/.test(String(v))) return n / 100;
    return Math.abs(n) >= 1 ? n / 100 : n;
  }
  const low = (v) => String(v == null ? '' : v).trim().toLowerCase();

  /* The first sheet (a preferred name first, then workbook order) with a header row in its
     top ten rows that satisfies need.ok. need.fields is [[field, [header prefixes]]]; each
     header cell is claimed by the first field it matches. need.reject(map) vetoes a header
     row that also looks like some other tab. Returns { name, aoa, row, map } or null. */
  function findTable(sheets, need) {
    const names = Object.keys(sheets || {});
    if (need.prefer) names.sort((a, b) => (need.prefer.test(b) ? 1 : 0) - (need.prefer.test(a) ? 1 : 0));
    for (const nm of names) {
      const aoa = sheets[nm] || [];
      for (let r = 0; r < Math.min(10, aoa.length); r++) {
        const map = {};
        (aoa[r] || []).forEach((h, i) => {
          const k = low(h);
          if (!k) return;
          for (const [f, alts] of need.fields) if (map[f] == null && alts.some((n) => k === n || k.startsWith(n))) { map[f] = i; break; }
        });
        if (need.ok(map) && !(need.reject && need.reject(map))) return { name: nm, aoa, row: r, map };
      }
    }
    return null;
  }

  /* Narrower names first: matching is by prefix, so "account type" must be claimed before a
     bare "account" can take it. */
  const HOLDING_FIELDS = [
    ['symbol', ['symbol', 'ticker']], ['name', ['name', 'description', 'security']],
    ['acctType', ['account type', 'tax type']], ['account', ['account']],
    ['cls', ['asset class', 'class', 'type of asset']],
    ['qty', ['quantity', 'qty', 'shares', 'units']],
    ['price', ['price', 'last price', 'last']], ['value', ['market value', 'value', 'mkt val']],
    ['cost', ['cost basis', 'cost', 'basis']], ['beta', ['beta']],
    ['mu', ['expected return', 'exp return']], ['sd', ['volatility', 'vol']], ['y', ['yield', 'dividend yield']],
  ];

  /* A sanity check on a percent the reader typed, so a cell read 100 times too big is said
     out loud rather than silently simulated. Bounds: return and yield within +-50% a year,
     volatility 0 to 200%. Adds a line to notes; changes nothing. */
  function pctNote(label, field, v, notes) {
    if (v == null) return;
    const bad = field === 'sd' ? (v < 0 || v > 2) : (v > 0.5 || v < -0.5);
    if (bad) {
      notes.push(label + ': ' + (field === 'mu' ? 'expected return' : field === 'sd' ? 'volatility' : 'yield')
        + ' read as ' + (v * 100).toFixed(1) + '%. Check the cell: type 7% or 0.07 for seven percent.');
    }
  }

  /* Holdings tab -> { sheet, rows: [holding] }. Returns null when there is no Holdings tab,
     and an empty rows list when there is one with no usable rows (that means "no public
     holdings", not "show the sample"). A row needs a symbol and a value (Market value, or
     Quantity x Price). Negative values are left out with a note, so totals and statistics
     always cover the same rows. */
  function holdingsFromSheets(sheets, notes) {
    notes = notes || [];
    const t = findTable(sheets, { fields: HOLDING_FIELDS, ok: (m) => m.symbol != null && (m.qty != null || m.value != null) });
    if (!t) return null;
    const { aoa, row, map } = t;
    const g = (r, f) => (map[f] != null ? r[map[f]] : null);
    const out = [];
    for (let i = row + 1; i < aoa.length; i++) {
      const r = aoa[i] || [];
      const symbol = String(g(r, 'symbol') || '').trim();
      if (!symbol) continue;
      const qty = num(g(r, 'qty')), price = num(g(r, 'price'));
      const value = num(g(r, 'value')) != null ? num(g(r, 'value')) : (qty != null && price != null ? qty * price : null);
      if (!value) continue;
      if (value < 0) {
        notes.push(symbol + ': a negative value (-$' + Math.round(-value).toLocaleString('en-US') + ') was left out. Enter a margin loan or other debt as a liability, not a holding.');
        continue;
      }
      const account = String(g(r, 'account') || 'Brokerage').trim();
      const h = {
        symbol, name: String(g(r, 'name') || ''), cls: classify(symbol, g(r, 'cls')),
        account, acctType: acctType(account, g(r, 'acctType')), qty, price, value,
        cost: num(g(r, 'cost')), beta: num(g(r, 'beta')),
        mu: pctIn(g(r, 'mu')), sd: pctIn(g(r, 'sd')), y: pctIn(g(r, 'y')),
      };
      ['mu', 'sd', 'y'].forEach((f) => pctNote(symbol, f, h[f], notes));
      out.push(norm(h));
    }
    return { sheet: t.name, rows: out };
  }

  /* Balances tab -> { sheet, rows: [holding] }, so Overview, Holdings and the Equity Curve
     show the same money the Retirement tab plans with. Parsed by portfolio.js, one parser
     for the tab, so the two cannot read it differently. The class follows the row's sleeve,
     because the sleeve is what the Retirement tab groups by: Growth -> US stocks, Income ->
     dividend and income, Bonds -> core bonds, Cash -> cash. A typed Expected return,
     Volatility or Yield overrides the class assumption. Returns null when there is no
     Balances tab (or portfolio.js is not loaded, as in the bare statistics test). */
  const KIND_CLASS = { growth: 'usEquity', income: 'dividend', bonds: 'bonds', cash: 'cash' };
  function holdingsFromBalances(sheets, notes) {
    const P = root.Portfolio;
    if (!P || !P.parseBalances) return null;
    const bal = P.parseBalances(sheets);
    if (!bal) return null;
    const rows = bal.rows.map((r) => {
      const kind = P.kindOf ? P.kindOf(r.sleeve).kind : 'growth';
      const label = r.label || r.sleeve || r.account;
      const h = {
        symbol: label, name: r.sleeve ? r.sleeve + ' sleeve' : '', cls: KIND_CLASS[kind] || 'usEquity',
        account: r.account, acctType: P.taxTreatment ? P.taxTreatment(r.account, r.type) : acctType(r.account, r.type),
        qty: null, price: null, value: r.value, cost: r.basis > 0 ? r.basis : null, beta: null,
        mu: r.ret, sd: r.vol, y: r.yield, fromBalances: true,
      };
      ['mu', 'sd', 'y'].forEach((f) => pctNote(label, f, h[f], notes));
      return norm(h);
    });
    return { sheet: bal.sheet, rows };
  }

  /* History tab -> [{date, account, value, flow}], or null. A Balances tab is NOT history,
     although it also has a date ("As of") and a value: a header row that also names a label,
     sleeve, symbol, yield or cost basis is skipped, and a sheet named History is tried
     first. Rows with no Account column are filed under "All", which the Equity Curve reads
     as every public account together. */
  function historyFromSheets(sheets) {
    const t = findTable(sheets, {
      prefer: /history/i,
      fields: [['date', ['date', 'as of']], ['account', ['account']], ['value', ['balance', 'value', 'total']], ['flow', ['net flow', 'flow', 'contribution']],
        ['other', ['label', 'sleeve', 'symbol', 'ticker', 'yield', 'expected return', 'holding', 'cost basis']]],
      ok: (m) => m.date != null && m.value != null,
      reject: (m) => m.other != null,
    });
    if (!t) return null;
    const { aoa, row, map } = t;
    const out = [];
    for (let i = row + 1; i < aoa.length; i++) {
      const r = aoa[i] || [];
      const d = toDate(r[map.date]);
      const v = num(r[map.value]);
      if (!d || v == null) continue;
      out.push({ date: d, account: map.account != null ? String(r[map.account] || '').trim() || 'All' : 'All', value: v, flow: map.flow != null ? (num(r[map.flow]) || 0) : 0 });
    }
    return out.length ? out : null;
  }

  /* A cell to a calendar date 'YYYY-MM-DD' with no time-zone shift, or null. Excel serials
     are days since 1899-12-30 (computed in UTC, which is exact). Text is parsed by hand
     (2027-01-01, 1/1/2027, 1/1/27, Jan 1 2027, 1 Jan 2027), because
     new Date("01/01/2027").toISOString() is the UTC date of local midnight, which east of
     Greenwich is the day before: a Jan 1 balance used to land in the previous year's plan. */
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  /* A checked calendar date as YYYY-MM-DD, or null when y-m-d is not a real day. */
  function ymd(y, m, d) {
    if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1) return null;   // 2027-02-30 is not a date
    return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }
  function toDate(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') {
      if (!(v > 20000 && v < 80000)) return null;   // the Excel serial range, 1954 to 2119
      return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
    }
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : ymd(v.getFullYear(), v.getMonth() + 1, v.getDate());
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return ymd(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
    if (m) { let y = +m[3]; if (y < 100) y += 2000; return ymd(y, +m[1], +m[2]); }
    m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/);
    if (m && MONTHS.indexOf(m[1].toLowerCase()) >= 0) return ymd(+m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2]);
    m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})$/);
    if (m && MONTHS.indexOf(m[2].toLowerCase()) >= 0) return ymd(+m[3], MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1]);
    return null;
  }

  /* Attach the statistics and the unrealised gain (value - cost, dollars) to a holding. */
  function norm(h) {
    h.st = holdingStats(h);
    h.gain = h.cost != null ? h.value - h.cost : null;
    return h;
  }

  /* ── the sample household's public accounts (fictional) ─────────────────────
     Quantities and prices are illustrative round numbers, not quotes. Three accounts with
     three tax treatments; the IRA is a concentrated growth book, the others are broader. */
  const DEMO_AS_OF = '2026-10-27';
  const DEMO_HOLDINGS = [
    ['NVDA', 'NVIDIA', 'IRA', 900, 180, 61000, 1.7],
    ['MSFT', 'Microsoft', 'IRA', 220, 510, 78000, 1.1],
    ['AMZN', 'Amazon', 'IRA', 400, 225, 64000, 1.3],
    ['GOOGL', 'Alphabet', 'IRA', 350, 250, 52000, 1.1],
    ['AVGO', 'Broadcom', 'IRA', 250, 340, 40000, 1.5],
    ['TSM', 'Taiwan Semiconductor', 'IRA', 280, 290, 51000, 1.4],
    ['QQQ', 'Nasdaq-100 ETF', 'IRA', 160, 600, 70000],
    ['GLD', 'Gold ETF', 'IRA', 250, 380, 62000],
    ['TLT', '20+ Year Treasury ETF', 'IRA', 600, 90, 58000],
    ['SGOV', '0-3 Month T-Bill ETF', 'IRA', 400, 100.5, 40200],
    ['VTI', 'Total US Stock Market ETF', 'Roth IRA', 500, 330, 120000],
    ['VXUS', 'Total International ETF', 'Roth IRA', 900, 72, 55000],
    ['IBIT', 'Bitcoin ETF', 'Roth IRA', 700, 62, 30000],
    ['SLV', 'Silver ETF', 'Roth IRA', 600, 45, 18000],
    ['VOO', 'S&P 500 ETF', 'Brokerage', 300, 620, 140000],
    ['SCHD', 'Dividend Equity ETF', 'Brokerage', 2500, 28, 64000],
    ['BND', 'Total Bond Market ETF', 'Brokerage', 900, 74, 68000],
    ['VNQ', 'Real Estate ETF', 'Brokerage', 300, 92, 26000],
    ['PDBC', 'Commodity Strategy ETF', 'Brokerage', 1500, 14, 22000],
    ['SPAXX', 'Money market', 'Brokerage', 30000, 1, 30000],
  ].map(([symbol, name, account, qty, price, cost, beta]) => norm({
    symbol, name, account, acctType: acctType(account), cls: classify(symbol), qty, price,
    value: qty * price, cost, beta: beta == null ? null : beta, mu: null, sd: null, y: null,
  }));

  /* Month-end balances for the same three accounts since 31 Dec 2025, ending at today's
     holdings. Fictional: a made-up 2026 for the sample household, so the Equity Curve has
     something to track. One $20,000 contribution to the brokerage account in March. */
  function demoHistory(holdings) {
    const dates = ['2025-12-31', '2026-01-30', '2026-02-27', '2026-03-31', '2026-04-30', '2026-05-29',
      '2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30', DEMO_AS_OF];
    const mkt = [0.018, -0.024, -0.041, 0.030, 0.042, 0.021, 0.012, -0.008, 0.026, 0.015];
    const beta = { 'IRA': 1.25, 'Roth IRA': 1.0, 'Brokerage': 0.7 };
    const flows = { 'Brokerage': { 3: 20000 } };
    const out = [];
    Object.keys(beta).forEach((acct) => {
      const end = holdings.filter((h) => h.account === acct).reduce((a, h) => a + h.value, 0);
      const vals = [end];
      for (let i = mkt.length - 1; i >= 0; i--) {
        const f = (flows[acct] || {})[i + 1] || 0;
        vals.unshift((vals[0] - f) / (1 + mkt[i] * beta[acct] + 0.002));
      }
      dates.forEach((d, i) => out.push({ date: d, account: acct, value: Math.round(vals[i]), flow: (flows[acct] || {})[i] || 0 }));
    });
    return out;
  }

  /* WHAT THE APP WORKS FROM: which household every tab shows. Precedence, decided here once:
     a Balances tab, then a Holdings tab (an empty one means "no public holdings"), then the
     fictional sample household, which the tabs label. Balances leads because the shipped
     tracker template carries one and the Retirement tab already plans from it, so this is
     the order that keeps Overview, Holdings, the Equity Curve and Retirement on the same
     money. History comes from a History tab only; the sample household brings its own.
     Returns { holdings, history, isDemo, asOf, source, sheet, notes }. */
  function load(sheets) {
    const notes = [];
    const bal = holdingsFromBalances(sheets, notes);
    const hold = holdingsFromSheets(sheets, bal ? [] : notes);
    const src = bal ? 'balances' : hold ? 'holdings' : 'sample';
    if (bal && hold && hold.rows.length) {
      notes.push('Your tracker has both a ' + bal.sheet + ' tab and a ' + hold.sheet + ' tab. Every tab uses ' + bal.sheet
        + ', which the Retirement plan reads; the ' + hold.sheet + ' rows were not used.');
    }
    const holdings = bal ? bal.rows : hold ? hold.rows : DEMO_HOLDINGS;
    const real = src !== 'sample';
    let hist = historyFromSheets(sheets) || (real ? [] : demoHistory(DEMO_HOLDINGS));
    /* A history with no Account column is the whole public portfolio. With one public
       account that is simply that account. */
    const accts = [...new Set(holdings.map((h) => h.account))];
    if (accts.length === 1) hist = hist.map((r) => (r.account === 'All' ? Object.assign({}, r, { account: accts[0] }) : r));
    return { holdings, history: hist, isDemo: !real, asOf: real ? null : DEMO_AS_OF, source: src,
      sheet: bal ? bal.sheet : hold ? hold.sheet : null, notes };
  }

  /* Where a private deal is held. Two accounts, because the tax treatment differs: deals
     bought inside a Self-Directed IRA (pre-tax) and deals bought personally (taxable). The
     tracker's Account column decides; with nothing stated a deal is assumed to sit in the
     Self-Directed IRA, where most of them are held. */
  const SDIRA = 'Self-Directed IRA', PRIV_TAXABLE = 'Private Deals';
  function privateAccount(stated) {
    const a = String(stated || '').trim();
    if (!a) return SDIRA;
    if (/roth/i.test(a)) return a;
    if (/ira|self.?direct|401|pre.?tax|checkbook|solo/i.test(a)) return SDIRA;
    if (/tax|personal|individual|joint|trust|llc|brok|private deal/i.test(a)) return PRIV_TAXABLE;
    return a;
  }

  /* Private positions from the deal book (Engine.buildBook rows), as holdings valued at what
     has been paid in (funded), with uncalled and commitment carried along for the Overview.
     The asset type maps to one of the four private classes by keyword; anything else is
     venture, the most volatile, so an unknown type never flatters the risk figures. */
  function privateHoldings(book) {
    return (book || []).filter((p) => (p.funded || 0) > 0).map((p) => {
      const c = String(p.cls || p.kind || '').toLowerCase();
      const cls = /credit|debt|lend/.test(c) ? 'pCredit' : /real|property|estate/.test(c) ? 'pRealEstate'
        : /private equity|buyout|pe\b/.test(c) ? 'pEquity' : 'venture';
      const account = privateAccount(p.account);
      return norm({ symbol: '', name: p.name, cls, account, acctType: account === PRIV_TAXABLE ? 'taxable' : acctType(account),
        value: p.funded, cost: p.funded, uncalled: p.uncalled || 0, commitment: p.commitment || 0, isPrivate: true });
    });
  }

  root.Markets = {
    FACTORS, CLASSES, GROUPS, PRIVATE_COLORS, ACCT_TYPE_LABEL, RF,
    classify, acctType, holdingStats, portfolioStats, toSleeves, cone, rankIn, logParams, phi,
    holdingsFromSheets, holdingsFromBalances, historyFromSheets, toDate, pctIn, load, privateHoldings, privateAccount, privateCone, combineCones, group,
    SDIRA, PRIV_TAXABLE,
  };
}(typeof window !== 'undefined' ? window : globalThis));
