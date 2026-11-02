/* THE WHOLE-PORTFOLIO TABS (prototype): Overview, Holdings, Equity Curve.
 *
 * Registered through the same plugin hook as the Retirement Simulator (window.APP_PLUGINS,
 * { id, label, after, render(host, ctx) }), so app.js is untouched. All the statistics come
 * from markets.js; this file only draws them. Session-only, like the rest of the app: a
 * balance recorded here lives until reload (or a new book), and the Download button hands it
 * back as rows for the tracker's History tab.
 *
 * PLACE IN THE APP. Loaded by index.html after consider-ui.js and before ux.js and app.js.
 * Overview sits after Deals in app.js's tab list; ux.js regroups the bar (Portfolio: Overview,
 * Equity Curve; Public markets: Holdings). Every render calls PlanIncludes.remember(ctx)
 * first, so a new book resets every module before anything is drawn.
 *
 * DATA IN. ctx = { book: [Engine position], mode, sheets }. Markets.load(ctx.sheets) decides
 * the household (Balances tab, then Holdings tab, then the sample, one rule for every tab);
 * Markets.privateHoldings(ctx.book) adds the private deals at what has been paid in.
 *
 * STATE. S below: the Holdings account filter and sort, the Equity Curve scope, horizon,
 * plan year and monthly addition, the balances recorded this session (S.added), the
 * Overview risk view and whether the Start here card was dismissed. reset() puts it back
 * to a fresh session and is registered with AppState.
 *
 * INVARIANTS. Totals and statistics cover the same rows (load() drops negative values with
 * a note). Private figures are labelled "paid in" or "committed"; money still owed to deals
 * is "Still to pay in", in neutral ink, because it is an obligation, not a loss. No em or en
 * dashes in anything drawn.
 *
 * KNOWN LIMITS. The whole-portfolio statistics treat each private deal as its asset type,
 * valued at what has been paid in; the deal tabs keep the detailed model. The Equity Curve
 * draws public and private futures independently, and says so.
 */
(function (root) {
  'use strict';

  const M = () => root.Markets;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = (v) => (v < 0 ? '-' : '') + '$' + Math.round(Math.abs(v)).toLocaleString('en-US');
  /* Dollars in short form: $950, $48k, $1.25M, $12.5M, $2.50B, $1.00T. */
  const short = (v) => {
    const a = Math.abs(v), sg = v < 0 ? '-' : '';
    if (a >= 1e12) return sg + '$' + (a / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return sg + '$' + (a / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return sg + '$' + (a / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'M';
    if (a >= 1e3) return sg + '$' + Math.round(a / 1e3) + 'k';
    return sg + '$' + Math.round(a);
  };
  /* A fraction as a percent; a value that rounds to zero prints as 0, never -0. */
  const pct = (v, d) => { const t = (v * 100).toFixed(d == null ? 1 : d); return (Number(t) === 0 ? (0).toFixed(d == null ? 1 : d) : t) + '%'; };
  const NONE = '<span class="z">None</span>';
  const signed = (v, f) => (v > 0 ? '+' : '') + f(v);

  /* Session state for the three tabs (see the header). */
  const fresh = () => ({ acct: 'all', sort: 'value', dir: -1, scope: 'public', horizon: 1, year: null, flow: 0, added: [], risk: 'whole', startHidden: false, flash: '' });
  const S = fresh();
  /* Back to a fresh session, in place (other code holds a reference to S). */
  function reset() { Object.keys(S).forEach((k) => delete S[k]); Object.assign(S, fresh()); }
  if (root.AppState) root.AppState.onReset(reset);
  else (root.APP_RESET_HOOKS = root.APP_RESET_HOOKS || []).push(reset);

  /* Today as a local calendar date 'YYYY-MM-DD'. toISOString() is the UTC date, which every
     evening in the Americas is already tomorrow (QA M8). */
  function todayLocal() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /* The five accounts, in the order a household reads them: the two pre-tax buckets, Roth,
     then the two taxable ones. Accounts the tracker names that are not on this list follow. */
  const ACCT_ORDER = ['IRA', 'Self-Directed IRA', 'Roth IRA', 'Private Deals', 'Brokerage'];
  const acctRank = (n) => { const i = ACCT_ORDER.indexOf(n); return i < 0 ? 99 : i; };

  /* Everything the three tabs draw from: { mk (Markets.load), pub, priv, all }. */
  function data(ctx) {
    if (root.PlanIncludes) root.PlanIncludes.remember(ctx);
    const mk = M().load(ctx && ctx.sheets);
    const pub = mk.holdings;
    const priv = M().privateHoldings(ctx && ctx.book);
    return { mk, pub, priv, all: pub.concat(priv) };
  }

  /* A row of headline figures: [label, value, one-line explanation, pos/neg class]. */
  function kpis(list) {
    return '<div class="mk-kpis">' + list.map(([l, v, sub, cls]) => '<div class="mk-kpi"><small>' + l + '</small><b'
      + (cls ? ' class="' + cls + '"' : '') + '>' + v + '</b>' + (sub ? '<span>' + sub + '</span>' : '') + '</div>').join('') + '</div>';
  }

  /* A single stacked bar with a legend: [{label, value, color}] */
  function bar(parts) {
    const tot = parts.reduce((a, p) => a + p.value, 0) || 1;
    return '<div class="mk-bar">' + parts.filter((p) => p.value > 0).map((p) => {
      const w = p.value / tot;
      return '<div style="flex:' + w.toFixed(4) + ';background:' + p.color + '" title="' + esc(p.label) + ': ' + money(p.value) + ' (' + pct(w) + ' of the total)' + (p.desc ? '\n' + esc(p.desc) : '') + '">'
        + (w > 0.06 ? pct(w, 0) : '') + '</div>';
    }).join('') + '</div><div class="mk-legend">' + parts.filter((p) => p.value > 0).map((p) => '<span><i style="background:'
      + p.color + '"></i>' + esc(p.label) + ' <b>' + short(p.value) + '</b></span>').join('') + '</div>';
  }

  /* Where the household on screen came from, as a tag beside the card heading. */
  function sampleNote(mk) {
    if (mk.isDemo) return '<span class="mk-tag">Sample household · illustrative prices, ' + esc(fmtDate(mk.asOf)) + '</span>';
    return mk.sheet ? '<span class="mk-tag mk-tag-own">From your ' + esc(mk.sheet) + ' tab</span>' : '';
  }
  /* Anything load() set aside or doubted, said once at the top of the tab. */
  function notesBox(mk) {
    return mk.notes && mk.notes.length ? '<div class="note mk-notes" role="status"><b>About your file:</b><ul>' + mk.notes.map((n) => '<li>' + esc(n) + '</li>').join('') + '</ul></div>' : '';
  }

  /* Holdings -> bar parts by sleeve (public) and by private class, in a fixed order. */
  function byGroup(holdings) {
    const G = M().GROUPS, out = {};
    holdings.forEach((h) => {
      const key = h.isPrivate ? h.cls : M().group(h);
      out[key] = (out[key] || 0) + h.value;
    });
    const parts = [];
    Object.keys(G).forEach((g) => { if (g !== 'private' && out[g]) parts.push({ label: G[g].label, value: out[g], color: G[g].color }); });
    Object.keys(M().PRIVATE_COLORS).forEach((c) => {
      if (out[c]) parts.push({ label: M().CLASSES[c].label, value: out[c], color: M().PRIVATE_COLORS[c] });
    });
    return parts;
  }

  /* THE NEXT YEAR AS A BELL CURVE. Twenty equal-width ranges of one-year return, from the
     1-in-100 bad year to the 1-in-100 good one (the last bar on each side also holds the tail
     beyond it). Each bar's height is the chance the year lands in it, taken from the same
     lognormal the numbers above come from, so the bars and the numbers cannot disagree. */
  function histogram(ps) {
    const lp = M().logParams(ps.mu, ps.sd), phi = M().phi;
    const at = (z) => Math.exp(lp.m + z * lp.s) - 1;
    const lo = at(-2.326), hi = at(2.326), N = 20, w = (hi - lo) / N;
    const cdf = (r) => (r <= -1 ? 0 : phi((Math.log(1 + r) - lp.m) / lp.s));
    const bins = [];
    for (let i = 0; i < N; i++) {
      const a = lo + i * w, b = a + w;
      bins.push({ a, b, p: (i === N - 1 ? 1 : cdf(b)) - (i === 0 ? 0 : cdf(a)) });
    }
    const W = 520, H = 190, L = 8, R = 8, T = 22, B = 30;
    const xs = (r) => L + (r - lo) / (hi - lo) * (W - L - R);
    const top = Math.max(...bins.map((x) => x.p)) * 1.12;
    const ys = (v) => T + (1 - v / top) * (H - T - B);
    const bw = (W - L - R) / N;
    let s = '<div class="mk-chart mk-hist"><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Twenty ranges of next year’s return and the chance of each. Typical year ' + pct(ps.median) + ', 1 in 20 bad year ' + pct(ps.down5) + ', 1 in 20 good year ' + pct(ps.up95) + '.">';
    bins.forEach((x, i) => {
      const mid = (x.a + x.b) / 2, neg = mid < 0;
      const range = (i === 0 ? 'Below ' + pct(x.b, 0) : i === N - 1 ? 'Above ' + pct(x.a, 0) : pct(x.a, 0) + ' to ' + pct(x.b, 0));
      const dollars = (i === 0 ? 'a loss of more than ' + short(-x.b * ps.value) : i === N - 1 ? 'a gain of more than ' + short(x.a * ps.value)
        : signed(x.a * ps.value, short) + ' to ' + signed(x.b * ps.value, short));
      const tipText = 'Outcome ' + (i + 1) + ' of 20: ' + range + '\n' + dollars + '\nChance: ' + pct(x.p) + ' (about 1 year in ' + Math.max(1, Math.round(1 / x.p)) + ')';
      s += '<rect x="' + (xs(x.a) + 1).toFixed(1) + '" y="' + ys(x.p).toFixed(1) + '" width="' + (bw - 2).toFixed(1) + '" height="' + (ys(0) - ys(x.p)).toFixed(1)
        + '" rx="2" fill="' + (neg ? '#FF3B30' : '#34C759') + '" fill-opacity="' + (0.35 + 0.55 * x.p / top).toFixed(2) + '" tabindex="0" role="img" aria-label="' + esc(tipText.replace(/\n/g, '. ')) + '"><title>'
        + esc(tipText) + '</title></rect>';
    });
    /* the bell itself, drawn over the bars */
    let path = '';
    for (let k = 0; k <= 80; k++) {
      const r = lo + (hi - lo) * k / 80;
      const z = (Math.log(1 + r) - lp.m) / lp.s;
      const dens = Math.exp(-z * z / 2) / (Math.sqrt(2 * Math.PI) * lp.s * (1 + r)) * w;
      path += (k ? 'L' : 'M') + xs(r).toFixed(1) + ' ' + ys(dens).toFixed(1);
    }
    s += '<path d="' + path + '" fill="none" stroke="#1D1D1F" stroke-width="1.4" stroke-opacity=".55"/>';
    s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + ys(0).toFixed(1) + '" y2="' + ys(0).toFixed(1) + '" stroke="#D2D2D7"/>';
    [[ps.down5, 'bad year'], [ps.median, 'typical'], [ps.up95, 'good year']].forEach(([v, l]) => {
      const x = xs(v).toFixed(1);
      s += '<line x1="' + x + '" x2="' + x + '" y1="' + (T - 6) + '" y2="' + ys(0).toFixed(1) + '" stroke="#1D1D1F" stroke-dasharray="3 3" stroke-opacity=".5"/>'
        + '<text x="' + x + '" y="' + (T - 10) + '" text-anchor="middle" class="ax">' + l + ' ' + signed(v, (q) => pct(q, 0)) + '</text>';
    });
    if (lo < 0 && hi > 0) s += '<text x="' + xs(0).toFixed(1) + '" y="' + (H - 10) + '" text-anchor="middle" class="ax">0%</text>';
    s += '<text x="' + L + '" y="' + (H - 10) + '" class="ax">' + pct(lo, 0) + '</text><text x="' + (W - R) + '" y="' + (H - 10) + '" text-anchor="end" class="ax">+' + pct(hi, 0) + '</text>';
    return s + '</svg></div>';
  }

  /* Weight against share of risk, as two thin bars (grey: money, red: risk). */
  function riskBars(w, r, name) {
    const sc = (x) => Math.min(100, x * 250).toFixed(1);
    const tip = (name ? name + '\n' : '') + pct(w) + ' of the money, ' + pct(r) + ' of the risk'
      + (w > 0 ? '\n' + (r / w).toFixed(1) + '× its weight' + (r > w * 1.2 ? ': it moves the total more than its size suggests' : r < w * 0.8 ? ': it steadies the total' : '') : '');
    return '<div class="mk-rb" title="' + esc(tip) + '"><div><i style="width:' + sc(w) + '%"></i></div><div><i class="r" style="width:' + sc(r) + '%"></i></div></div>';
  }

  /* ── OVERVIEW ─────────────────────────────────────────────────────────── */

  /* The Start here card: three lines of orientation for a first visit, dismissible for the
     session. Tab names here are the tab labels exactly. */
  function startHere() {
    if (S.startHidden) return '';
    return '<div class="card mk-start"><div class="mk-head"><h2>Start Here</h2><button type="button" class="linkish" data-mkstart>Hide this</button></div>'
      + '<ol class="mk-steps"><li><b>Overview</b> (this page): everything you own on one page, public and private.</li>'
      + '<li><b>Liquidity Outlook</b>: when your private money is likely to come back, and what is still to pay in.</li>'
      + '<li><b>Retirement</b>: the chance the money lasts. <b>Tax Strategies</b> and the <b>Deal Library</b> let you test a change before you make it.</li></ol>'
      + '<p class="cap" style="margin:6px 0 0">Words you do not know are defined on the <button type="button" class="linkish" data-mkgo="about">Help</button> tab.</p></div>';
  }

  /* OVERVIEW: net worth, allocation, accounts, the 12-month range and risk concentration. */
  function renderOverview(host, ctx) {
    const d = data(ctx);
    const pubV = d.pub.reduce((a, h) => a + h.value, 0);
    const privV = d.priv.reduce((a, h) => a + h.value, 0);
    const uncalled = (ctx && ctx.book ? ctx.book : []).reduce((a, p) => a + (p.uncalled || 0), 0);
    const ps = M().portfolioStats(d.all);
    if (!ps) { host.innerHTML = startHere() + notesBox(d.mk) + '<div class="card"><p class="note">Nothing to show yet: no holding or deal has a value above $0.</p></div>'; wireOverview(host, ctx); return; }
    const tot = pubV + privV;
    /* The share of public money only means something when there is public money to speak of. */
    const callShare = uncalled && pubV >= 1000 ? pct(uncalled / pubV, 0) + ' of your public money' : '';

    let h = startHere() + notesBox(d.mk) + '<div class="card"><div class="mk-head"><h2>Net Worth</h2>' + sampleNote(d.mk) + '</div>'
      + '<p class="cap">Public markets at market value, private deals at what you have paid in.</p>'
      + kpis([
        ['Total', short(tot)],
        ['Public markets', short(pubV), pct(pubV / tot, 0) + ' · sells any day'],
        ['Private deals (paid in)', short(privV), pct(privV / tot, 0) + ' · locked up'],
        ['Still to pay in', short(uncalled), uncalled ? 'committed to deals, not yet sent' + (callShare ? ' · ' + callShare : '') : 'nothing owed to your deals'],
        ['Expected return', pct(ps.mu), 'whole portfolio · typical year ' + pct(ps.median)],
        ['Volatility', pct(ps.sd), 'typical yearly swing, up or down · income yield ' + pct(ps.y)],
      ]) + '</div>';

    h += '<div class="card"><h2>Portfolio Allocation</h2><p class="cap">Every asset type, public and private, on one bar.</p>' + bar(byGroup(d.all)) + '</div>';

    /* By account */
    const accts = {};
    d.all.forEach((x) => {
      const a = accts[x.account] || (accts[x.account] = { name: x.account, type: x.acctType, pub: 0, priv: 0, items: [] });
      if (x.isPrivate) a.priv += x.value; else a.pub += x.value;
      a.items.push(x);
    });
    h += '<div class="card"><h2>Assets by Account</h2><p class="cap">Return and volatility of what each account holds, by tax bucket. Private deals at what you have paid in.</p>'
      + '<div style="overflow-x:auto"><table><thead><tr><th class="l">Account</th><th class="l">Tax</th><th>Public</th><th>Private (paid in)</th><th>Total</th><th>Exp. return</th><th>Volatility</th></tr></thead><tbody>'
      + Object.values(accts).sort((a, b) => acctRank(a.name) - acctRank(b.name) || (b.pub + b.priv) - (a.pub + a.priv)).map((a) => {
        /* null when an account holds nothing of positive value: show None, never crash (QA H9) */
        const st = M().portfolioStats(a.items);
        return '<tr><td class="l mk-strong">' + esc(a.name) + '</td><td class="l mk-muted">' + esc(M().ACCT_TYPE_LABEL[a.type] || 'Taxable') + '</td><td>'
          + (a.pub ? money(a.pub) : NONE) + '</td><td>' + (a.priv ? money(a.priv) : NONE) + '</td><td class="b">'
          + money(a.pub + a.priv) + '</td><td>' + (st ? pct(st.mu) : NONE) + '</td><td>' + (st ? pct(st.sd) : NONE) + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';

    /* Risk at a glance. Two readings: the whole portfolio, where each private deal carries its
       asset type's assumptions at cost, and public only, which stays clean of those. */
    if (S.risk === 'private' && !d.priv.length) S.risk = 'whole';
    if (S.risk === 'public' && !d.pub.length) S.risk = 'whole';
    const rps = (S.risk === 'public' ? M().portfolioStats(d.pub) : S.risk === 'private' ? M().portfolioStats(d.priv) : ps) || ps;
    const top = rps.rows.slice().sort((a, b) => b.risk - a.risk).slice(0, 5);
    const lead = top[0];
    const leadLine = lead ? '<p class="note key">' + esc(lead.symbol || lead.name) + ' is ' + pct(lead.w, 0) + ' of the money and '
      + pct(lead.risk, 0) + ' of the risk' + (lead.w > 0 ? ', about ' + (lead.risk / lead.w).toFixed(1) + '× its weight.' : '.') + '</p>' : '';
    h += '<div class="mk-grid2"><div class="card"><h2>12-Month Return Range</h2><p class="cap">What the next year could do to the whole portfolio. Hover or tab to a bar for its odds.</p>'
      + kpis([
        ['Bad year (1 in 20)', signed(ps.down5 * ps.value, short), pct(ps.down5), 'neg'],
        ['Typical year', signed(ps.median * ps.value, short), pct(ps.median)],
        ['Good year (1 in 20)', signed(ps.up95 * ps.value, short), pct(ps.up95), 'pos'],
        ['Chance of a down year', pct(ps.pDown, 0), 'whole portfolio'],
      ]) + histogram(ps) + '</div>'
      + '<div class="card"><div class="mk-head"><h2>Risk Concentration</h2><div class="chips" role="group" aria-label="Which holdings to rank">'
      + [['whole', 'Whole portfolio']].concat(d.pub.length ? [['public', 'Public only']] : []).concat(d.priv.length ? [['private', 'Private only']] : []).map(([k, l]) => '<button type="button" class="chip' + (S.risk === k ? ' on' : '') + '" aria-pressed="' + (S.risk === k) + '" data-mkrisk="' + k + '">' + l + '</button>').join('')
      + '</div></div><p class="cap">The five ' + (S.risk === 'private' ? 'private deals' : 'holdings') + ' that drive most of the ups and downs' + (S.risk === 'private' ? ' within the private sleeve' : '') + '. Grey: share of the money. Red: share of the ups and downs it causes.</p>'
      + leadLine
      + '<table class="mk-tight"><tbody>' + top.map((x) => '<tr><td class="l mk-strong">' + esc(x.symbol || x.name) + (x.isPrivate && S.risk !== 'private' ? ' <span class="mk-muted" style="font-weight:400">· private</span>' : '') + '</td><td class="l" style="width:50%">'
        + riskBars(x.w, x.risk, x.symbol || x.name) + '</td><td>' + pct(x.w, 0) + ' → <b class="neg">' + pct(x.risk, 0) + '</b></td></tr>').join('')
      + '</tbody></table>'
      + '<details class="more how"><summary>How this is worked out</summary><p class="note">A holding’s share of risk is how much of the portfolio’s swings it causes. It depends on three things: its size, its own volatility, and how much it moves with everything else you own. A volatile holding that moves with the rest counts for more than its weight; bonds, gold and cash usually count for less, because they move differently from stocks. <b>Whole portfolio</b> includes private deals at what you have paid in, each with its asset type’s volatility and correlations (private credit, real estate, private equity, venture), not a deal-by-deal model. <b>Public only</b> leaves them out. <b>Private only</b> ranks the deals against each other within the private sleeve, valued at what you have paid in.</p></details></div></div>';

    h += '<div class="card"><details class="more how"><summary>How this page is worked out</summary><p class="note">Public holdings are valued at market; private deals at what you have paid in, because a private deal is only revalued when the sponsor reports. Still to pay in is what you have committed to your deals and not yet sent; it is money you owe, not a loss. Expected return and volatility (the typical yearly swing, up or down) combine every holding using long-run assumptions per asset type and the correlations between them (see Holdings). The private-deal tabs keep their own deal-by-deal model; this page uses a simpler one so everything fits on one scale.</p></details></div>';
    host.innerHTML = h;
    wireOverview(host, ctx);
  }

  /* Overview's controls: the risk view chips, Start here, and its Help link. */
  function wireOverview(host, ctx) {
    host.querySelectorAll('[data-mkrisk]').forEach((b) => { b.onclick = () => { S.risk = b.getAttribute('data-mkrisk'); renderOverview(host, ctx); const n = host.querySelector('[data-mkrisk="' + S.risk + '"]'); if (n) n.focus(); }; });
    const st = host.querySelector('[data-mkstart]'); if (st) st.onclick = () => { S.startHidden = true; renderOverview(host, ctx); };
    host.querySelectorAll('[data-mkgo]').forEach((b) => { b.onclick = () => { const t = document.querySelector('#out [data-tab="' + b.getAttribute('data-mkgo') + '"]'); if (t) t.click(); }; });
  }

  /* ── PUBLIC MARKETS ───────────────────────────────────────────────────── */

  /* The holdings table's columns: [sort key, header, alignment, mobile class, definition].
     On a phone the Type and Account columns are hidden so Value sits next to the name. */
  const COLS = [
    ['symbol', 'Holding', 'l'], ['cls', 'Type', 'l', 'mk-c-hide'], ['account', 'Account', 'l', 'mk-c-hide'], ['value', 'Value'], ['w', 'Weight'],
    ['gain', 'Gain'], ['mu', 'Exp. return', '', '', 'The long-run average return a year, before inflation'],
    ['sd', 'Volatility', '', '', 'The typical yearly swing, up or down, around the expected return'],
    ['beta', 'Beta', '', '', 'How much it moves with the US stock market: 1 moves with it, 2 moves twice as much, 0 does not follow it'],
    ['risk', 'Share of risk', '', '', 'Its share of the portfolio’s ups and downs. Above its weight means it moves the total more than its size suggests'],
  ];

  /* HOLDINGS: the public positions, their statistics, and the sleeves that feed Retirement. */
  function renderHoldings(host, ctx) {
    const d = data(ctx);
    const accounts = [...new Set(d.pub.map((h) => h.account))].sort((a, b) => acctRank(a) - acctRank(b));
    if (S.acct !== 'all' && !accounts.includes(S.acct)) S.acct = 'all';
    const list = d.pub.filter((h) => S.acct === 'all' || h.account === S.acct);
    const ps = M().portfolioStats(list);
    if (!ps) {
      const why = d.mk.source === 'sample' ? 'No public holdings yet.' : d.mk.source === 'none' ? 'Your file has no Holdings or Balances tab, so there are no public holdings to show. Add one to see your whole portfolio.' : 'Your ' + esc(d.mk.sheet || 'Holdings') + ' tab has no rows with a value above $0, so there are no public holdings to show.';
      host.innerHTML = notesBox(d.mk) + '<div class="card"><p class="note">' + why + ' Add a Holdings tab (Symbol, Account, Quantity, Price) or a Balances tab (Account, Sleeve, Value) to your tracker.</p></div>';
      return;
    }
    const gain = list.reduce((a, h) => a + (h.gain || 0), 0);
    const cost = list.reduce((a, h) => a + (h.cost || 0), 0);

    let h = notesBox(d.mk) + '<div class="card"><div class="mk-head"><div class="chips" role="group" aria-label="Account">'
      + ['all'].concat(accounts).map((a) => '<button type="button" class="chip' + (S.acct === a ? ' on' : '') + '" aria-pressed="' + (S.acct === a) + '" data-mkacct="' + esc(a) + '">'
        + (a === 'all' ? 'All accounts' : esc(a)) + '</button>').join('') + '</div>' + sampleNote(d.mk) + '</div>'
      + '<p class="cap">Public holdings only. Private deals are on the Deals tab.</p>'
      + kpis([
        ['Market value', short(ps.value)],
        ['Unrealized gain', signed(gain, short), cost ? pct(gain / cost) + ' on cost' : 'no cost basis on file', gain >= 0 ? 'pos' : 'neg'],
        ['Expected return', pct(ps.mu), 'public holdings only · typical year ' + pct(ps.median)],
        ['Volatility', pct(ps.sd), 'typical yearly swing · beta ' + ps.beta.toFixed(2)],
        ['Income yield', pct(ps.y), short(ps.y * ps.value) + ' a year'],
        ['Chance of a down year', pct(ps.pDown, 0), 'bad year (1 in 20) ' + pct(ps.down5)],
      ])
      + '<div style="margin-top:18px">' + bar(byGroup(list)) + '</div></div>';

    /* holdings table */
    const rows = ps.rows.slice();
    const val = (x) => (['mu', 'sd', 'beta'].includes(S.sort) ? x.st[S.sort]
      : S.sort === 'cls' ? M().CLASSES[x.cls].label : x[S.sort]);
    rows.sort((a, b) => {
      const ka = val(a), kb = val(b);
      if (typeof ka === 'string') return S.dir * ka.localeCompare(String(kb));
      return S.dir * ((ka == null ? -Infinity : ka) - (kb == null ? -Infinity : kb));
    });
    /* Sortable headers are buttons inside the th, so a keyboard can reach and press them
       (Enter or Space), and aria-sort says which column is sorted which way (QA L3). */
    h += '<div class="card"><h2>Public Holdings</h2><p class="cap">Press a column heading to sort. Red bar: the holding’s share of the portfolio’s ups and downs.</p>'
      + '<div style="overflow-x:auto"><table class="mk-hold"><thead><tr>' + COLS.map(([k, l, c, mc, def]) => '<th class="' + (c || '') + ' ' + (mc || '') + ' mk-sort' + (S.sort === k ? ' on' : '')
        + '" aria-sort="' + (S.sort === k ? (S.dir < 0 ? 'descending' : 'ascending') : 'none') + '"' + (def ? ' title="' + esc(def) + '"' : '') + '><button type="button" class="mk-sortbtn" data-mksort="' + k + '">' + l + (S.sort === k ? (S.dir < 0 ? ' ↓' : ' ↑') : '') + '</button></th>').join('') + '</tr></thead><tbody>'
      + rows.map((x) => '<tr><td class="l"><span class="mk-sym">' + esc(x.symbol) + '</span><span class="mk-name">' + esc(x.name) + '</span><span class="mk-name mk-c-show">' + esc(x.account) + '</span></td>'
        + '<td class="l mk-muted mk-c-hide"><i class="mk-dot" style="background:' + M().GROUPS[M().group(x)].color + '"></i>' + esc(M().CLASSES[x.cls].label) + '</td>'
        + '<td class="l mk-muted mk-c-hide">' + esc(x.account) + '</td><td>' + money(x.value) + '</td><td>' + pct(x.w) + '</td>'
        + '<td class="' + (x.gain == null ? '' : x.gain >= 0 ? 'pos' : 'neg') + '">' + (x.gain == null ? NONE : signed(x.gain, short)) + '</td>'
        + '<td>' + pct(x.st.mu) + '</td><td>' + pct(x.st.sd, 0) + '</td><td>' + x.st.beta.toFixed(2) + '</td>'
        + '<td style="min-width:120px">' + riskBars(x.w, x.risk, x.symbol) + '<span class="mk-rl">' + pct(x.risk) + '</span></td></tr>').join('')
      + '</tbody></table></div></div>';

    /* statistics + sleeves */
    const sv = M().toSleeves(list);
    h += '<div class="mk-grid2"><div class="card"><h2>Portfolio Statistics</h2><p class="cap">What the holdings add up to, as a whole.</p>'
      + '<dl class="mk-dl">'
      + dl('Typical year (median)', pct(ps.median), 'Half of years do better than this, half worse')
      + dl('Chance of a down year', pct(ps.pDown, 0), 'Public holdings only')
      + dl('Return per unit of risk (Sharpe ratio)', ps.sharpe.toFixed(2), 'Return above cash, divided by volatility. Higher means more return for each unit of ups and downs')
      + dl('Diversification benefit', ps.divRatio.toFixed(2) + '×', 'risk if nothing offset anything, divided by actual risk')
      + dl('Effective number of holdings', ps.effN.toFixed(1) + ' of ' + rows.length)
      + dl('Top five holdings', pct(ps.top5, 0) + ' of the money')
      + '</dl>' + riskReturn(ps) + '</div>'
      + '<div class="card"><h2>Retirement Simulator Inputs</h2><p class="cap">These sleeves are what the Retirement Simulator draws from.</p>'
      + '<table class="mk-tight"><thead><tr><th class="l">Sleeve</th><th>Balance</th><th>Return</th><th>Volatility</th><th>Yield</th></tr></thead><tbody>'
      + sv.sleeves.map((s) => '<tr><td class="l"><i class="mk-dot" style="background:' + M().GROUPS[s.id].color + '"></i>' + esc(s.label) + '</td><td>' + short(s.balance)
        + '</td><td>' + pct(s.mu + s.yield) + '</td><td>' + pct(s.sd, 0) + '</td><td>' + pct(s.yield) + '</td></tr>').join('')
      + '</tbody></table>' + corrTable(sv) + '</div></div>';

    h += '<details class="more how"><summary>Assumptions by asset type</summary><p class="note">Long-run assumptions in the range of published 10-year forecasts. A Holdings tab can override any of them per holding (Expected return, Volatility, Yield, Beta columns). Single stocks: return = cash ' + pct(M().RF) + ' + beta × 3.5%; volatility combines market risk and 28% company-specific risk.</p>'
      + '<div style="overflow-x:auto"><table class="mk-tight"><thead><tr><th class="l">Asset type</th><th class="l">Sleeve</th><th>Exp. return</th><th>Volatility</th><th>Yield</th></tr></thead><tbody>'
      + Object.keys(M().CLASSES).filter((k) => M().CLASSES[k].mu != null).map((k) => {
        const c = M().CLASSES[k];
        return '<tr><td class="l">' + esc(c.label) + '</td><td class="l mk-muted">' + esc(M().GROUPS[c.group].label) + '</td><td>' + pct(c.mu) + '</td><td>' + pct(c.sd, 0) + '</td><td>' + pct(c.y) + '</td></tr>';
      }).join('') + '</tbody></table></div></details>';

    host.innerHTML = h;
    host.querySelectorAll('[data-mkacct]').forEach((b) => { b.onclick = () => { S.acct = b.getAttribute('data-mkacct'); renderHoldings(host, ctx); const n = host.querySelector('[data-mkacct="' + (window.CSS && CSS.escape ? CSS.escape(S.acct) : S.acct) + '"]'); if (n) n.focus(); }; });
    host.querySelectorAll('[data-mksort]').forEach((b) => {
      b.onclick = () => {
        const k = b.getAttribute('data-mksort');
        if (S.sort === k) S.dir = -S.dir; else { S.sort = k; S.dir = ['symbol', 'cls', 'account'].includes(k) ? 1 : -1; }
        renderHoldings(host, ctx);
        const n = host.querySelector('[data-mksort="' + k + '"]'); if (n) n.focus();   // keep the keyboard where it was
      };
    });
  }

  /* THE STATISTICS, DRAWN. Every holding placed by its volatility (across) and expected
     return (up), sized by its weight. Three marks tie the picture to the numbers above:
     the portfolio itself; where it would sit if nothing offset anything (the weighted
     average volatility), so the gap between the two IS the diversification benefit; and
     the line from cash through the portfolio, whose slope is the Sharpe ratio. Holdings
     above that line pay more return per unit of risk than the portfolio does. */
  function riskReturn(ps) {
    const rows = ps.rows, rf = M().RF;
    const wavg = rows.reduce((a, x) => a + x.w * x.st.sd, 0);
    const maxX = Math.max(wavg, ...rows.map((x) => x.st.sd)) * 1.08;
    const ysAll = rows.map((x) => x.st.mu).concat([ps.mu, rf]);
    const minY = Math.min(0, ...ysAll) - 0.005, maxY = Math.max(...ysAll) * 1.12;
    const W = 520, H = 300, L = 40, R = 14, T = 14, B = 34;
    const xs = (v) => L + v / maxX * (W - L - R);
    const ys = (v) => T + (1 - (v - minY) / (maxY - minY)) * (H - T - B);
    let s = '<h3 style="margin-top:22px">Risk and Return by Holding</h3><p class="cap" style="margin-top:0">Across: volatility. Up: expected return. Bubble size: weight. Hover for detail.</p>'
      + '<div class="mk-chart mk-hist"><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Each holding by volatility and expected return">';
    for (let k = 0; k <= 4; k++) {
      const vx = maxX * k / 4, vy = minY + (maxY - minY) * k / 4;
      s += '<line x1="' + xs(vx).toFixed(1) + '" x2="' + xs(vx).toFixed(1) + '" y1="' + T + '" y2="' + (H - B) + '" stroke="#F0F0F2"/>'
        + '<text x="' + xs(vx).toFixed(1) + '" y="' + (H - 16) + '" text-anchor="middle" class="ax">' + pct(vx, 0) + '</text>'
        + '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + ys(vy).toFixed(1) + '" y2="' + ys(vy).toFixed(1) + '" stroke="#F0F0F2"/>'
        + '<text x="' + (L - 6) + '" y="' + (ys(vy) + 4).toFixed(1) + '" text-anchor="end" class="ax">' + pct(vy, 0) + '</text>';
    }
    s += '<text x="' + (W - R) + '" y="' + (H - 2) + '" text-anchor="end" class="ax">volatility →</text>';
    /* Sharpe line: cash to the portfolio and on */
    const slope = (ps.mu - rf) / ps.sd, xEnd = Math.min(maxX, (maxY - rf) / slope);
    s += '<line x1="' + xs(0) + '" y1="' + ys(rf).toFixed(1) + '" x2="' + xs(xEnd).toFixed(1) + '" y2="' + ys(rf + slope * xEnd).toFixed(1) + '" stroke="#0071E3" stroke-dasharray="5 4" stroke-opacity=".6"><title>'
      + esc('Return per unit of risk (Sharpe ' + ps.sharpe.toFixed(2) + ')\nFrom cash at ' + pct(rf) + ' through the portfolio. Holdings above the line pay more return for their risk than the portfolio does; below it, less.') + '</title></line>';
    s += '<circle cx="' + xs(0) + '" cy="' + ys(rf).toFixed(1) + '" r="3" fill="#0071E3"/>';
    /* bubbles, biggest first so the small ones stay on top */
    rows.slice().sort((a, b) => b.w - a.w).forEach((x) => {
      const g = M().GROUPS[M().group(x)];
      s += '<circle cx="' + xs(x.st.sd).toFixed(1) + '" cy="' + ys(x.st.mu).toFixed(1) + '" r="' + (3 + Math.sqrt(x.w) * 30).toFixed(1) + '" fill="' + g.color + '" fill-opacity=".55" stroke="' + g.color + '"><title>'
        + esc((x.symbol || x.name) + ' · ' + M().CLASSES[x.cls].label + ' · ' + x.account + '\nWeight: ' + pct(x.w) + ' (' + short(x.value) + ')\nExpected return: ' + pct(x.st.mu) + '\nVolatility: ' + pct(x.st.sd, 0) + '\nShare of the portfolio’s risk: ' + pct(x.risk)) + '</title></circle>';
    });
    rows.slice().sort((a, b) => b.w - a.w).slice(0, 6).forEach((x) => {
      s += '<text x="' + (xs(x.st.sd) + 3 + Math.sqrt(x.w) * 30 + 3).toFixed(1) + '" y="' + (ys(x.st.mu) + 4).toFixed(1) + '" class="ax mk-halo" style="pointer-events:none">' + esc(x.symbol || x.name) + '</text>';
    });
    /* diversification: where the portfolio would sit with no offsetting, and where it does */
    const yP = ys(ps.mu).toFixed(1);
    s += '<line x1="' + xs(wavg).toFixed(1) + '" x2="' + (xs(ps.sd) + 9).toFixed(1) + '" y1="' + yP + '" y2="' + yP + '" stroke="#1D1D1F" stroke-width="1.5" marker-end="url(#mkArrow)"/>'
      + '<defs><marker id="mkArrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" fill="#1D1D1F"/></marker></defs>'
      + '<circle cx="' + xs(wavg).toFixed(1) + '" cy="' + yP + '" r="6" fill="#fff" stroke="#1D1D1F" stroke-dasharray="2 2"><title>'
      + esc('If nothing offset anything\nVolatility would be ' + pct(wavg) + ', the weighted average of the holdings.\nThe arrow is the diversification benefit: ' + ps.divRatio.toFixed(2) + '×') + '</title></circle>'
      + '<rect x="' + (xs(ps.sd) - 8).toFixed(1) + '" y="' + (ys(ps.mu) - 8).toFixed(1) + '" width="16" height="16" rx="3" fill="#1D1D1F" stroke="#fff" stroke-width="2.5" transform="rotate(45 ' + xs(ps.sd).toFixed(1) + ' ' + yP + ')"><title>'
      + esc('The portfolio\nExpected return: ' + pct(ps.mu) + '\nVolatility: ' + pct(ps.sd) + '\nSharpe: ' + ps.sharpe.toFixed(2)) + '</title></rect>'
      + '<text x="' + xs(ps.sd).toFixed(1) + '" y="' + (ys(ps.mu) + 26).toFixed(1) + '" text-anchor="middle" class="ax mk-halo" style="font-weight:700;fill:#1D1D1F;font-size:12px;pointer-events:none">Portfolio</text>';
    return s + '</svg></div><div class="mk-legend"><span><i style="background:#1D1D1F;transform:rotate(45deg)"></i>Portfolio</span><span><i style="background:#fff;border:1px dashed #1D1D1F"></i>With no diversification</span><span><i style="background:#0071E3;height:2px;margin-bottom:3px"></i>Sharpe line from cash</span></div>';
  }

  /* One statistic in the definition grid, with an optional definition as its tooltip. */
  function dl(k, v, title) { return '<div' + (title ? ' title="' + esc(title) + '"' : '') + '><dt>' + k + '</dt><dd>' + v + '</dd></div>'; }

  /* The sleeve correlation matrix, shaded blue for moving together and red for apart. */
  function corrTable(sv) {
    const ids = sv.sleeves.map((s) => s.id);
    if (ids.length < 2) return '';
    const cell = (v) => {
      const a = Math.min(1, Math.abs(v));
      const bg = v >= 0 ? 'rgba(31,56,100,' + (a * 0.55).toFixed(2) + ')' : 'rgba(163,58,31,' + (a * 0.55).toFixed(2) + ')';
      return '<td style="background:' + bg + ';color:' + (a > 0.5 ? '#fff' : 'inherit') + ';text-align:center">' + v.toFixed(2) + '</td>';
    };
    return '<h2 style="margin-top:18px">Sleeve Correlations</h2><div style="overflow-x:auto"><table class="mk-corr"><thead><tr><th></th>'
      + ids.map((i) => '<th>' + esc(M().GROUPS[i].label) + '</th>').join('') + '</tr></thead><tbody>'
      + ids.map((a) => '<tr><td class="l mk-muted">' + esc(M().GROUPS[a].label) + '</td>' + ids.map((b) => cell(sv.corr[a][b])).join('') + '</tr>').join('')
      + '</tbody></table></div>';
  }

  /* ── EQUITY CURVE ─────────────────────────────────────────────────────── */

  const MS_MONTH = 30.4375 * 86400000;

  /* The combined balance of `accounts` on every date where all of them have a balance on
     record (carrying each account's last balance forward), plus `extra`. [{date, value, flow}]. */
  function series(history, accounts, extra) {
    const rows = history.filter((r) => accounts.includes(r.account));
    const dates = [...new Set(rows.map((r) => r.date))].sort();
    const last = {}, out = [];
    dates.forEach((dt) => {
      let flow = 0;
      rows.filter((r) => r.date === dt).forEach((r) => { last[r.account] = r.value; flow += r.flow || 0; });
      if (accounts.every((a) => last[a] != null)) out.push({ date: dt, value: accounts.reduce((s, a) => s + last[a], 0) + extra, flow });
    });
    return out;
  }

  /* Calendar years that have a balance after their opening one, so each has something to judge. */
  function planYears(act) {
    const ys = [];
    act.forEach((p, i) => {
      const y = Number(p.date.slice(0, 4));
      const hasOpen = act.some((q) => q.date <= (y - 1) + '-12-31');
      const firstOfYear = act.findIndex((q) => q.date.slice(0, 4) === String(y)) === i;
      if ((hasOpen || !firstOfYear) && !ys.includes(y)) ys.push(y);
    });
    return ys.sort();
  }

  /* The private accounts have no statements on file, so their balance on record is what has
     been paid in: the opening is everything funded before this year, and what was funded
     this year arrives by today as money added. A balance recorded below (a sponsor's mark)
     takes over from there. */
  function privateHistory(book, accounts, asOf) {
    const Y = new Date(asOf + 'T12:00:00').getFullYear(), rows = [];
    accounts.forEach((a) => {
      const mine = (book || []).filter((b) => M().privateAccount(b.account) === a);
      const open = mine.filter((b) => b.fy < Y).reduce((x, b) => x + (b.funded || 0), 0);
      const added = mine.filter((b) => b.fy >= Y).reduce((x, b) => x + (b.funded || 0), 0);
      rows.push({ date: (Y - 1) + '-12-31', account: a, value: open, flow: 0, atCost: true });
      rows.push({ date: asOf, account: a, value: open + added, flow: added, atCost: true });
    });
    return rows;
  }

  /* EQUITY CURVE: this year's planned range against the balance actually recorded. */
  function renderCurve(host, ctx) {
    const d = data(ctx);
    const book = (ctx && ctx.book) || [];
    const asOf = d.mk.asOf || todayLocal();
    const privAccts = [M().SDIRA, M().PRIV_TAXABLE].filter((a) => book.some((b) => b.commitment > 0 && M().privateAccount(b.account) === a));
    /* A History tab with no Account column is the whole public portfolio ("All"). With more
       than one public account it stands for all of them together (QA L10). */
    const allRows = d.mk.history.some((r) => r.account === 'All');
    const pubHoldAccts = [...new Set(d.pub.map((h) => h.account))];
    const histPub = allRows && pubHoldAccts.length > 1
      ? d.mk.history.map((r) => (r.account === 'All' ? Object.assign({}, r, { account: 'All public accounts' }) : r))
      : d.mk.history;
    const hist = histPub.concat(privateHistory(book, privAccts, asOf)).concat(S.added);
    const pubAccts = (allRows && pubHoldAccts.length > 1 ? ['All public accounts'] : pubHoldAccts).filter((a) => hist.some((r) => r.account === a));
    const isPriv = (a) => privAccts.includes(a);

    /* Combined views first, whole portfolio leading; then every account on its own, in the
       household's order (pre-tax, Roth, taxable). */
    const combined = (privAccts.length ? [['whole', 'Whole portfolio']] : []).concat([['public', 'All public accounts']])
      .concat(privAccts.length ? [['private', 'All private accounts']] : []);
    const single = pubAccts.concat(privAccts).sort((x, y) => acctRank(x) - acctRank(y)).map((a) => [a, a]);
    if (!combined.concat(single).some(([k]) => k === S.scope)) S.scope = 'public';
    const pubSel = S.scope === 'public' || S.scope === 'whole' ? pubAccts : S.scope === 'private' || isPriv(S.scope) ? [] : [S.scope];
    const privSel = S.scope === 'private' || S.scope === 'whole' ? privAccts : isPriv(S.scope) ? [S.scope] : [];
    const accts = pubSel.concat(privSel);
    const pubHold = d.pub.filter((h) => pubSel.includes(h.account) || pubSel.includes('All public accounts'));
    const privBook = book.filter((b) => b.commitment > 0 && privSel.includes(M().privateAccount(b.account)));
    const ps = M().portfolioStats(pubHold.concat(d.priv.filter((h) => privSel.includes(h.account))));
    const act = series(hist, accts, 0);

    const chip = ([k, l]) => '<button type="button" class="chip' + (S.scope === k ? ' on' : '') + '" aria-pressed="' + (S.scope === k) + '" data-mkscope="' + esc(k) + '">' + esc(l) + '</button>';
    let h = '<div class="card"><div class="mk-head"><div class="mk-scopes"><div class="chips"><span class="mk-chiplab">Combined</span>' + combined.map(chip).join('') + '</div>'
      + (single.length ? '<div class="chips"><span class="mk-chiplab">By account</span>' + single.map(chip).join('') + '</div>' : '')
      + '</div>' + sampleNote(d.mk) + '</div>';

    if (!ps || act.length < 1) {
      host.innerHTML = h + '<p class="note">No balance history yet. Record a balance below, or add a History tab (Date, Account, Balance) to your tracker.</p></div>' + snapshotCard(accts.length ? accts : (pubAccts.length ? pubAccts : pubHoldAccts));
      wire(host, ctx); return;
    }

    /* A NEW PLAN EVERY JANUARY, as APEX does. Each calendar year's cone starts from the
       last balance on record at or before Dec 31 of the year before (the opening balance),
       so the year is judged against what the plan said on Jan 1. The first year on record
       starts from its first balance, because there is nothing earlier to open from. */
    const years = planYears(act);
    if (!years.length) years.push(Number(act[act.length - 1].date.slice(0, 4)));
    if (!years.includes(S.year)) S.year = years[years.length - 1];
    const Y = S.year;
    const yearEnd = (Y - 1) + '-12-31';
    const open = act.filter((p) => p.date <= yearEnd).pop() || act.find((p) => p.date.slice(0, 4) === String(Y));
    const t0 = open.date <= yearEnd ? new Date(yearEnd + 'T12:00:00').getTime() : new Date(open.date + 'T12:00:00').getTime();
    const months = S.horizon * 12;
    const tEnd = t0 + months * MS_MONTH + 5 * 86400000;
    const shown = act.filter((p) => p.date >= open.date && new Date(p.date + 'T12:00:00').getTime() <= tEnd);
    const start = shown[0], lastPt = shown[shown.length - 1];
    const elapsed = (new Date(lastPt.date + 'T12:00:00').getTime() - t0) / MS_MONTH;

    /* THE PLAN. Public money: the lognormal cone from the holdings' return and volatility.
       Private money: the Liquidity Outlook's own simulated futures, valued month by month
       (Markets.privateCone). Both together: added future by future. */
    const pubOpen = pubSel.length ? (series(hist, pubSel, 0).filter((p) => p.date <= open.date).pop() || { value: 0 }).value : 0;
    const pubPs = pubHold.length ? M().portfolioStats(pubHold) : null;
    const pubCone = pubPs ? M().cone({ start: pubOpen, mu: pubPs.mu, sd: pubPs.sd, months, monthlyFlow: S.flow, paths: 2000, seed: 20261028 + Y, keepPaths: !!privSel.length }) : null;
    const pc = privSel.length ? M().privateCone(privBook, { months, t0, paths: 2000 }) : null;
    const c = pubCone && pc ? M().combineCones(pubCone.raw, pc.paths) : pubCone || (pc && pc.cone);
    if (!c) { host.innerHTML = h + '<p class="note">Nothing to plan for in this scope yet.</p></div>'; wire(host, ctx); return; }

    const mi = Math.max(0, Math.min(months, Math.round(elapsed)));
    const here = c[mi];
    const rank = M().rankIn(here.sorted, lastPt.value);
    const flows = shown.reduce((a, p, i) => a + (i ? p.flow : 0), 0);
    const ret = start.value ? (lastPt.value - start.value - flows) / start.value : 0;
    const st = rank < 0.10 ? ['bad', 'Well below plan'] : rank < 0.25 ? ['warn', 'Below plan'] : rank <= 0.75 ? ['ok', 'On plan'] : ['up', 'Ahead of plan'];
    const setOn = 'Jan 1, ' + Y;
    const isYTD = lastPt.date.slice(0, 4) === String(Y);
    const privOnly = !pubSel.length;
    const atCost = privSel.length && !S.added.some((r) => privSel.includes(r.account));

    /* A cost-basis actual cannot be scored against a plan that counts marks and preferred
       return: it would always read "below". So a private-only view at cost shows the plan and
       says so; a recorded (marked) balance turns the judgement on. */
    if (privOnly && atCost) {
      h += '<div class="mk-status"><span class="pill up">Plan only</span><span>These deals are counted at what you have paid in (' + short(lastPt.value) + '), so the actual is not scored against the plan. Record a marked balance below, from a sponsor statement, to see where it sits.</span></div>'
        + kpis([
          ['Paid in', short(lastPt.value), fmtDate(lastPt.date)],
          ['Plan, typical today', short(here.p50), 'value incl. cash received'],
          ['Plan range today', short(here.p5) + ' to ' + short(here.p95), '90% of planned outcomes'],
          ['Plan, typical at ' + (S.horizon === 1 ? 'year end' : S.horizon + ' years'), short(c[months].p50), short(c[months].p5) + ' to ' + short(c[months].p95)],
        ]) + '</div>';
    } else {
      h += '<div class="mk-status"><span class="pill ' + st[0] + '">' + st[1] + '</span><span>Actual is better than <b>' + Math.round(rank * 100) + ' in 100</b> planned outcomes for ' + Y + ' (the plan set ' + setOn + ' from ' + short(start.value) + ').'
        + (atCost ? ' Private deals are counted at what you have paid in, which reads a little low against the plan until you record a marked balance.' : '') + '</span></div>'
        + kpis([
          ['Actual', short(lastPt.value), fmtDate(lastPt.date) + (atCost ? ' · private at paid in' : '')],
          ['Plan, typical', short(here.p50), 'middle of the cone today'],
          ['Gap to typical', signed(lastPt.value - here.p50, short), signed((lastPt.value - here.p50) / here.p50, pct), lastPt.value >= here.p50 ? 'pos' : 'neg'],
          [isYTD ? 'Return this year' : 'Return over the plan', signed(ret, pct), flows ? 'net of ' + short(flows) + ' added' : 'no money added'],
          ['Plan range today', short(here.p5) + ' to ' + short(here.p95), '90% of planned outcomes'],
        ]) + '</div>';
    }

    /* The monthly addition is printed as an amount, then offered as a box, so the sentence
       reads whole even to a screen reader or a copy and paste (UX-26: "adding  a month"). */
    const planLine = (pubPs ? 'Public money assumes <b>' + pct(pubPs.mu) + '</b> a year at <b>' + pct(pubPs.sd) + '</b> volatility (its typical yearly swing), '
        + (S.flow ? 'with <b>' + money(S.flow) + '</b> added each month' : 'with no new money added')
        + '. <label class="mk-flow">Monthly addition $<input type="number" step="500" min="0" value="' + S.flow + '" data-mkflow style="width:100px" aria-label="Money added to public accounts each month, in dollars"></label>' : '')
      + (pc ? (pubPs ? ' Private deals' : 'Private deals') + ' replay the Liquidity Outlook’s simulated futures for ' + privBook.length + ' position' + (privBook.length === 1 ? '' : 's')
        + ': each deal’s exit year, outcome, preferred return and capital calls (' + short(pc.flows.reduce((a, v) => a + v, 0)) + ' still to pay in over this window).' : '')
      + (pubPs && pc ? ' Public and private futures are drawn independently, so the combined range is a little narrower than it should be.' : '');

    h += '<div class="card"><div class="mk-head"><h2>Equity Curve: Plan vs. Actual</h2><div class="chips">'
      + (years.length > 1 ? years.map((y) => '<button type="button" class="chip' + (S.year === y ? ' on' : '') + '" aria-pressed="' + (S.year === y) + '" data-mkyear="' + y + '">' + y + ' plan</button>').join('') + '<span class="mk-sep"></span>' : '')
      + [[1, 'This year'], [3, '3 years'], [5, '5 years'], [10, '10 years']].map(([y, l]) => '<button type="button" class="chip' + (S.horizon === y ? ' on' : '') + '" aria-pressed="' + (S.horizon === y) + '" data-mkhor="' + y + '">' + l + '</button>').join('')
      + '</div></div><p class="cap">The ' + Y + ' plan from ' + setOn + ', with the actual balance on top. Hover for each month.' + (privOnly && S.horizon === 1 ? ' Try 5 years or 10 years: private deals pay out over years, not months.' : '') + '</p>'
      + chart(c, shown, t0, months) + '<div class="mk-legend"><span><i style="background:rgba(0,113,227,.12)"></i>90% of plans</span><span><i style="background:rgba(0,113,227,.26)"></i>Middle half</span>'
      + '<span><i style="background:#0071E3;height:2px;margin-bottom:3px"></i>Typical plan</span><span><i style="background:#FF9500;height:3px;margin-bottom:3px"></i>Actual</span></div>'
      + '<div class="mk-inline">' + planLine + '</div>'
      + '<details class="more how"><summary>How to read this</summary><p class="note">A new plan is set every January 1 from the Dec 31 balance, as in APEX, and does not move during the year: it is what the model said to expect, so the actual can be measured against it. 3 years, 5 years and 10 years draw the same plan further out from the same start.</p>'
      + '<p class="note"><b>Public money</b> uses the expected return and volatility of what this scope holds today (Holdings tab). <b>Private deals</b> use the same simulated futures as the Liquidity Outlook’s cone, valued each month: cash received so far (preferred return and exits, kept in the account) plus what is still held, marked in a straight line from cost toward the outcome that future drew. Capital calls are money added. The two are drawn independently and added future by future, although the private deals partly move with the stock market, so the combined range here is a little too narrow. Run far enough that every deal has exited, the private cone ends exactly on the Liquidity Outlook’s cumulative cash.</p>'
      + '<p class="note">Money added lifts the actual line; the return figure removes it. Private deals have no statements on file, so their actual balance is what you have paid in until you record a marked balance below.</p></details></div>';

    h += snapshotCard(accts.length ? accts : pubAccts, hist.filter((r) => !r.atCost));
    host.innerHTML = h;
    wire(host, ctx);
  }

  /* The Record a Balance form, its feedback line, and every balance on record. The date
     defaults to today's LOCAL date and cannot be later than today. */
  function snapshotCard(accts, hist) {
    const today = todayLocal();
    let h = '<div class="card"><h2>Record a Balance</h2><p class="cap">Add today’s balance to track it. Download to keep it in your tracker.</p>'
      + '<form class="mk-form" data-mkform novalidate><label>Date<input type="date" name="date" value="' + today + '" max="' + today + '" required></label>'
      + '<label>Account<select name="account">' + accts.slice().sort((a, b) => acctRank(a) - acctRank(b)).map((a) => '<option>' + esc(a) + '</option>').join('') + '</select></label>'
      + '<label>Balance ($)<input type="number" name="value" step="0.01" min="0" required placeholder="0" inputmode="decimal"></label>'
      + '<label>Money added ($)<input type="number" name="flow" step="0.01" value="0" inputmode="decimal"></label>'
      + '<button type="submit" class="on">Add</button><button type="button" data-mkdl>Download history (.csv)</button></form>';
    if (S.flash) h += '<p class="note mk-flash" role="status" style="margin-top:8px">' + esc(S.flash) + '</p>';
    if (S.added.length) h += '<p class="note" style="margin-top:8px">' + S.added.length + ' added this session. They are not saved until you download the history.</p>';
    if (hist && hist.length) {
      h += '<details class="more how"><summary>All balances on record (' + hist.length + ')</summary><div style="overflow-x:auto;max-height:320px"><table class="mk-tight"><thead><tr><th class="l">Date</th><th class="l">Account</th><th>Balance</th><th>Money added</th></tr></thead><tbody>'
        + hist.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).map((r) => '<tr><td class="l">' + esc(fmtDate(r.date)) + '</td><td class="l">' + esc(r.account) + '</td><td>' + money(r.value) + '</td><td>' + (r.flow ? money(r.flow) : NONE) + '</td></tr>').join('')
        + '</tbody></table></div></details>';
    }
    return h + '</div>';
  }

  /* CHECK A RECORDED BALANCE. Refuses a date after today or before 1990 (a future date used
     to become a plan year of its own, QA M11), a negative or unreadable balance, and asks
     for a second press when the balance is more than ten times the account's last one.
     Returns an error string, or '' when the entry can be added. */
  function checkEntry(e, hist) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) return 'Enter a date.';
    if (e.date > todayLocal()) return 'The date cannot be later than today.';
    if (e.date < '1990-01-01') return 'Use a date from 1990 on.';
    if (!(e.value >= 0) || !Number.isFinite(e.value)) return 'Enter the balance as a number of dollars, 0 or more.';
    if (!Number.isFinite(e.flow)) return 'Enter money added as a number of dollars.';
    const prev = hist.filter((r) => r.account === e.account && r.date <= e.date).sort((a, b) => (a.date < b.date ? -1 : 1)).pop();
    if (prev && prev.value > 0 && e.value > 10 * prev.value && S.confirm !== e.account + '|' + e.value) {
      S.confirm = e.account + '|' + e.value;
      return 'That is more than ten times the last balance on record for ' + e.account + ' (' + money(prev.value) + '). Press Add again if it is right.';
    }
    return '';
  }

  /* A cell for the downloaded CSV: quoted, with a leading = + - or @ neutralised so a
     spreadsheet does not run it as a formula (QA L9). */
  function csvCell(v) {
    let t = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
    return '"' + t.replace(/"/g, '""') + '"';
  }

  /* The Equity Curve's controls. After a re-render, focus goes back to the control that was
     used, so a keyboard user keeps their place. */
  function wire(host, ctx) {
    const again = (sel) => { const n = host.querySelector(sel); if (n) n.focus(); };
    host.querySelectorAll('[data-mkscope]').forEach((b) => { b.onclick = () => { S.scope = b.getAttribute('data-mkscope'); S.flash = ''; renderCurve(host, ctx); again('[data-mkscope="' + (window.CSS && CSS.escape ? CSS.escape(S.scope) : S.scope) + '"]'); }; });
    host.querySelectorAll('[data-mkhor]').forEach((b) => { b.onclick = () => { S.horizon = Number(b.getAttribute('data-mkhor')); renderCurve(host, ctx); again('[data-mkhor="' + S.horizon + '"]'); }; });
    host.querySelectorAll('[data-mkyear]').forEach((b) => { b.onclick = () => { S.year = Number(b.getAttribute('data-mkyear')); renderCurve(host, ctx); again('[data-mkyear="' + S.year + '"]'); }; });
    const fl = host.querySelector('[data-mkflow]');
    if (fl) fl.onchange = () => { S.flow = Math.max(0, Number(fl.value) || 0); renderCurve(host, ctx); again('[data-mkflow]'); };
    const f = host.querySelector('[data-mkform]');
    if (f) f.onsubmit = (e) => {
      e.preventDefault();
      const fd = new FormData(f);
      const entry = { date: String(fd.get('date') || ''), account: String(fd.get('account') || ''), value: fd.get('value') === '' ? NaN : Number(fd.get('value')), flow: fd.get('flow') === '' ? 0 : Number(fd.get('flow')) };
      const hist = data(ctx).mk.history.concat(S.added);
      const err = checkEntry(entry, hist);
      if (err) { S.flash = err; renderCurve(host, ctx); return; }
      S.confirm = null;
      S.added.push(entry);
      S.flash = 'Balance added for ' + entry.account + ': ' + money(entry.value) + ' on ' + fmtDate(entry.date) + '. Download the history to keep it.';
      renderCurve(host, ctx);
    };
    const dlb = host.querySelector('[data-mkdl]');
    if (dlb) dlb.onclick = () => {
      const hist = data(ctx).mk.history.concat(S.added).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
      const csv = 'Date,Account,Balance,Net flow\n' + hist.map((r) => [r.date, csvCell(r.account), r.value, r.flow || 0].join(',')).join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = 'balance-history.csv';
      document.body.appendChild(a); a.click(); a.remove();
    };
  }

  /* The date at month m of the plan: month ends when the plan opens on one. */
  function monthAt(t0, m) {
    const d = new Date(t0);
    const isEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() === d.getDate();
    return isEnd ? new Date(d.getFullYear(), d.getMonth() + m + 1, 0, 12) : new Date(d.getFullYear(), d.getMonth() + m, d.getDate(), 12);
  }

  /* The cone (90% and middle-half bands, typical line) with the actual balance on top, and one
     invisible hover column per month carrying that month's figures. */
  function chart(c, act, t0, months) {
    const W = 960, H = 340, L = 64, R = 108, T = 14, B = 30;
    const xs = (m) => L + (m / months) * (W - L - R);
    let lo = Infinity, hi = -Infinity;
    c.forEach((p) => { lo = Math.min(lo, p.p5); hi = Math.max(hi, p.p95); });
    act.forEach((p) => { lo = Math.min(lo, p.value); hi = Math.max(hi, p.value); });
    const pad = (hi - lo) * 0.06; lo = Math.max(0, lo - pad); hi += pad;
    const ys = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const band = (a, b) => c.map((p, m) => xs(m).toFixed(1) + ',' + ys(p[a]).toFixed(1)).join(' ') + ' '
      + c.slice().reverse().map((p, k) => xs(months - k).toFixed(1) + ',' + ys(p[b]).toFixed(1)).join(' ');
    const line = (k) => c.map((p, m) => xs(m).toFixed(1) + ',' + ys(p[k]).toFixed(1)).join(' ');
    const endP = c[months];
    let s = '<div class="mk-chart"><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc('Planned range and actual balance. At the end of the plan: typical ' + short(endP.p50) + ', range ' + short(endP.p5) + ' to ' + short(endP.p95) + '. Latest actual ' + short(act[act.length - 1].value) + '.') + '">';
    for (let i = 0; i <= 4; i++) {
      const v = lo + (hi - lo) * i / 4, y = ys(v);
      s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '" stroke="#E8E8ED"/>'
        + '<text x="' + (L - 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end" class="ax">' + short(v) + '</text>';
    }
    /* x ticks: quarters within a year, Jan 1 of each year beyond it */
    for (let m = 0; m <= months; m++) {
      const dt = monthAt(t0, m);
      let lab = null;
      if (months <= 15) { if (m % 3 === 0) lab = m === 0 ? 'Jan 1' : dt.toLocaleString('en-US', { month: 'short' }); }
      else if (dt.getMonth() === 11) lab = 'Jan ' + (dt.getFullYear() + 1);
      if (lab) s += '<text x="' + xs(m).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" class="ax">' + lab + '</text>';
    }
    s += '<polygon points="' + band('p5', 'p95') + '" fill="rgba(0,113,227,.10)"/>'
      + '<polygon points="' + band('p25', 'p75') + '" fill="rgba(0,113,227,.20)"/>'
      + '<polyline points="' + line('p50') + '" fill="none" stroke="#0071E3" stroke-width="1.6" stroke-dasharray="5 4"/>';
    const end = c[months];
    [['p95', 'good'], ['p50', 'typical'], ['p5', 'bad']].forEach(([k, l]) => {
      s += '<text x="' + (W - R + 6) + '" y="' + (ys(end[k]) + 4).toFixed(1) + '" class="ax">' + l + ' ' + short(end[k]) + '</text>';
    });
    const mOf = (p) => (new Date(p.date + 'T12:00:00').getTime() - t0) / MS_MONTH;
    const ax = (p) => xs(mOf(p));
    const lastX = ax(act[act.length - 1]);
    s += '<line x1="' + lastX.toFixed(1) + '" x2="' + lastX.toFixed(1) + '" y1="' + T + '" y2="' + (H - B) + '" stroke="#FF9500" stroke-dasharray="2 3" opacity=".6"/>';
    s += '<polyline points="' + act.map((p) => ax(p).toFixed(1) + ',' + ys(p.value).toFixed(1)).join(' ') + '" fill="none" stroke="#FF9500" stroke-width="2.6" stroke-linejoin="round"/>';
    act.forEach((p, i) => {
      s += '<circle cx="' + ax(p).toFixed(1) + '" cy="' + ys(p.value).toFixed(1) + '" r="' + (i === act.length - 1 ? 5 : 3) + '" fill="#FF9500" stroke="#fff" stroke-width="1.5"/>';
      if (i && p.flow) s += '<text x="' + ax(p).toFixed(1) + '" y="' + (ys(p.value) - 10).toFixed(1) + '" text-anchor="middle" class="ax" fill="#FF9500">+' + short(p.flow) + '</text>';
    });
    /* Hover: one invisible column per month, carrying the plan's range and any actual
       balance recorded that month. Drawn last so it sits on top of everything. */
    const half = (xs(1) - xs(0)) / 2;
    for (let m = 0; m <= months; m++) {
      const p = c[m], dt = monthAt(t0, m);
      const a = act.filter((q) => Math.round(mOf(q)) === m).pop();
      const head = m === 0 ? 'Plan start, Jan 1' : dt.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      let tip = head + '\nPlan, typical: ' + money(p.p50) + '\nMiddle half: ' + short(p.p25) + ' to ' + short(p.p75) + '\n90% of plans: ' + short(p.p5) + ' to ' + short(p.p95);
      if (a) {
        const r = M().rankIn(p.sorted, a.value);
        tip += '\nActual: ' + money(a.value) + ' (' + ordinal(Math.round(r * 100)) + ' percentile)' + (a.flow ? '\nMoney added: ' + money(a.flow) : '');
      }
      s += '<rect x="' + (xs(m) - half).toFixed(1) + '" y="' + T + '" width="' + (2 * half).toFixed(1) + '" height="' + (H - T - B) + '" fill="transparent" class="hov"><title>' + esc(tip) + '</title></rect>';
    }
    return s + '</svg></div>';
  }

  /* 'YYYY-MM-DD' -> "Oct 27, 2026", the one date format in the UI copy. */
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  /* 1 -> 1st, 22 -> 22nd, 113 -> 113th. */
  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  root.MarketsUI = { S, reset, short, pct, todayLocal, checkEntry, csvCell };
  root.APP_PLUGINS = (root.APP_PLUGINS || []).concat([
    { id: 'overview', label: 'Overview', after: 'dash', render: renderOverview },
    { id: 'curve', label: 'Equity Curve', after: 'overview', render: renderCurve },
    { id: 'holdings', label: 'Holdings', after: 'curve', render: renderHoldings },
  ]);
}(window));
