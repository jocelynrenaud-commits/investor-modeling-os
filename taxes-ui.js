/* TAX STRATEGIES (prototype): pick a strategy, set its terms, see what it does to your tax.
 *
 * WHAT THIS FILE IS
 * The Tax Strategies tab, plus the models behind it. It owns six strategies (Heavy Machinery,
 * Workforce Housing, Roth conversion, cost segregation, oil and gas, solar), runs any mix of
 * them as one stacked plan, draws the year-by-year chart, the "If You Invest What It Saves"
 * card, and hands the plan to the Retirement tab as dated cash (dated()). Heavy Machinery and
 * Workforce Housing are the published tools' models, run through taxplay.js unchanged; the
 * other four are written here. Everything runs in the browser; nothing is stored.
 *
 * A STRATEGY IS A DEFINITION, NOT A SCREEN
 *   { id, name, tag, blurb, status: 'ready' | 'soon',
 *     kind,                          // a TaxPlay model (taxplay.js KINDS), or...
 *     run(item, income, profile),    // ...its own model (see rothRun), returning a Run
 *     defaults,                      // input values for a new item (a getter where they depend on the year)
 *     fields: [{ key, label, type: 'money'|'pct'|'int'|'select'|'bool', group, min, max, step, help }],
 *     fix(inputs, key),              // optional cross-field check, returns a message when it changes a value
 *     raisesIncome,                  // counted before deductions, so a deduction can offset it
 *     repeatLabel, repeatDefault }   // the "do it again each year" control
 * The form, the chart, the totals and the hand-off read only the definition and the Run, so a
 * new strategy is one more entry in STRATEGIES. Field min and max are in the units the reader
 * types (a 'pct' field's max of 100 means 100%); they may be functions of the current year.
 *
 * A PLAN ITEM (S.plan[i])
 *   { uid, id, startYear, repeat, inputs }   uid is unique for the session; repeat >= 1 means
 *   "the same again each year, starting in startYear". Percent inputs are stored as fractions.
 *
 * SESSION STATE (S)
 *   S.plan starts EMPTY: nothing from this tab reaches Retirement (dated() returns null) until
 *   the reader adds a strategy; the empty state offers "Add a strategy" and "Try Heavy
 *   Machinery". S.local is the Federal Tax Baseline (status, w2Now, w2Growth, persded,
 *   retireIncome, bracketIndex, discount). S.growth is the "If You Invest" slider (null =
 *   follow the portfolio). S.msgs holds inline validation messages. reset() clears it all and
 *   is registered with the app's shared new-book reset (includes.js AppState).
 *
 * THE COMMON RUN SHAPE (what every model returns, and runPlan() collects)
 *   { label, startYear, uid,
 *     years: [{ year, down, saved, extra, cash, sale, owed }],
 *     sum:   { down, y1Deduction, y1TaxSaved, cumTaxSaved, cash, exitYear, owedBack, netSale, allIn },
 *     roth | cs | og | sol: {...} }   one strategy-specific block for its card (see each model)
 * Units: US dollars of the calendar year the row is in (nominal), federal tax only.
 * Sign convention in years[]: money that reaches you is positive, money that leaves you is
 * negative. Adding the six fields gives the year's net effect on your cash.
 *   year   calendar year.
 *   down   cash you put in: down payments, study fees, the price of a program or project (<= 0).
 *   saved  federal tax you do not pay that year: a deduction priced at your brackets, a credit
 *          used, or a Roth withdrawal that is tax-free (>= 0).
 *   extra  extra tax during the life of the strategy: tax on a Roth conversion, or on deal
 *          income once the deduction is used up (<= 0).
 *   cash   cash the deal throws off: lease or rent after the loan, production, power sales.
 *          Usually >= 0; a Heavy Machinery year whose loan payment beats the lease is negative.
 *   sale   what a sale brings in after paying off any loan, BEFORE tax (>= 0).
 *   owed   tax owed back at the end: depreciation recapture, capital-gains tax, a clawed-back
 *          credit (<= 0).
 * sum, for the table and the KPI tiles (all dollars, same sign style except where noted):
 *   down         money put in, as a POSITIVE number (the KPI tile flips it).
 *   y1Deduction  extra deduction in the first year (0 where the idea does not apply).
 *   y1TaxSaved   saved + extra in the first year of the item (negative for a conversion).
 *   cumTaxSaved  saved + extra over every year (owed is NOT in it).
 *   cash         total of years[].cash.
 *   exitYear     last calendar year the strategy touches.
 *   owedBack     tax owed back at the end, as a POSITIVE number.
 *   netSale      sale proceeds after the loan (HM, WFH: after the tax as well, as the tools show).
 *   allIn        every year added up as the dollars land, undiscounted.
 *
 * INCOME AND THE TAX BASE
 * `income` maps calendar year -> gross ordinary income (W-2 and the like) BEFORE the personal
 * deduction. Every model prices a change through the brackets on that gross figure:
 *   tax change = tax(max(0, gross + delta - deduction)) - tax(max(0, gross - deduction))
 * so an unused standard deduction absorbs new income first (a Roth conversion in a year with
 * no other income is taxed only on the part above the deduction). A deduction can only use
 * income that exists: it lowers gross income to zero at most and the rest carries forward, the
 * way a net operating loss is measured from income without the standard deduction (s.172(d)).
 * Each model returns `next`, the gross income left after it, which the next strategy sees.
 *
 * BRACKETS AND THE YEAR
 * 2026 law (Rev. Proc. 2025-32 brackets, the 2026 standard deduction, the 0/15/20% capital
 * gains thresholds). The four models written here index the brackets, the standard deduction
 * and the capital gains thresholds by "Brackets rise each year" (default 2.5%), as the IRS does
 * for inflation: tax in year y = f * tax(taxable / f) with f = (1 + rate)^(y - 2026). Heavy
 * Machinery and Workforce Housing keep the published tools' 2026 brackets in every year
 * (parity-locked in taxplay.js), which slightly overstates their later tax. W-2 income grows at
 * its own rate until the Retirement tab's stop year, then becomes "Taxable income after you
 * stop" (default $0), which rises with the brackets. "This year" is read from the clock each
 * time it is needed, never frozen at page load.
 *
 * STACKING ORDER (runPlan)
 * Strategies that ADD taxable income (a Roth conversion) are counted first, then the
 * deductions in the order shown, each measured against the income left after the ones before
 * it. That is how a Heavy Machinery deduction can soak up a conversion in one year. A Heavy
 * Machinery or Workforce Housing exit hands on its recapture income too, so a later strategy
 * prices its own income above it (the published stack() leaves it out; see taxplay.js).
 * Capital gains are taxed on top of ordinary income and are not handed on.
 *
 * WORTH TODAY (one convention for the whole tab)
 * Every "worth today" figure on this tab is each year's net discounted to the current year at
 * the tab's discount rate (S.local.discount, default 6% a year, shown and editable on the
 * Federal Tax Baseline card): the return the money could earn elsewhere. It is not the
 * inflation adjustment the Retirement tab calls "today's dollars"; the one figure on this tab
 * that comes from Retirement (the effect on retirement) keeps Retirement's meaning and says so.
 *
 * TAX LAW EACH MODEL ENCODES (federal, 2026)
 *   Heavy Machinery, Workforce Housing: see taxplay.js (s.168(k) bonus, s.461(l) excess
 *     business loss, s.172 NOL with the 80% limit, s.1245 and s.1250 recapture, s.1231).
 *   Roth conversion: s.408A(d)(3), the converted amount is ordinary income that year.
 *   Cost segregation: s.168 recovery periods (27.5 years residential, 39 nonresidential),
 *     s.168(k) bonus on 5, 7 and 15-year property, s.1245 recapture on the reclassified part,
 *     s.469 passive loss rules, s.1(h)(1)(E) 25% unrecaptured s.1250 gain.
 *   Oil and gas: s.263(c) intangible drilling costs, s.168(k) bonus on equipment, s.613A
 *     15% percentage depletion, s.469(c)(3) working interest exception.
 *   Solar: s.48E clean electricity investment credit as amended by the 2025 law (One Big
 *     Beautiful Bill Act: in service by Dec 31, 2027 for projects starting after July 4, 2026),
 *     s.50(c)(3) basis reduced by half the credit, s.50(a) recapture over 5 years, s.50(c)(2)
 *     half the recaptured credit added back to basis, s.1245 recapture and s.1231 gain or loss
 *     on the sale, gain above the original basis taxed at the 0/15/20% long-term rates.
 *
 * SIMPLIFICATIONS AND KNOWN LIMITS
 *   No state tax, NIIT (3.8%), AMT, SE tax or QBI. No s.38(c) general business credit limit
 *   beyond the tax owed (material for high earners). Losses carry forward in full in the
 *   models written here (no 80% limit); HM and WFH apply it. Tax is counted in the year it is
 *   earned, not the following spring. One 7-year schedule for all reclassified property. Oil
 *   and gas holds to depletion. Solar is a cash purchase. The Roth model ignores RMDs, IRMAA
 *   and the five-year rule. Federal only. Not tax advice.
 */
(function (root) {
  'use strict';

  /* ── FORMATTING ──────────────────────────────────────────────────────────── */

  /* Escape text for HTML (body and attribute values). */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  /* Whole dollars with separators: -$1,234. */
  const money = (v) => (v < 0 ? '-' : '') + '$' + Math.round(Math.abs(v)).toLocaleString('en-US');
  /* Short dollars for tiles and charts: $950, $12k, $1.25M, $3.40B, $2.00T. */
  const short = (v) => {
    const a = Math.abs(v), sg = v < 0 && Math.round(a) > 0 ? '-' : '';
    if (a >= 1e12) return sg + '$' + (a / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return sg + '$' + (a / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return sg + '$' + (a / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return sg + '$' + Math.round(a / 1e3) + 'k';
    return sg + '$' + Math.round(a);
  };
  /* A fraction as a percent with d decimals (default 1); never prints "-0.0%". */
  const pct = (v, d) => { const s = (v * 100).toFixed(d == null ? 1 : d); return (/^-0(\.0+)?$/.test(s) ? s.slice(1) : s) + '%'; };
  /* A signed short figure: +$12k or -$12k. */
  const signed = (v) => (v >= 0 ? '+' : '') + short(v);

  /* The current calendar year, read from the clock every time (a session that crosses
     midnight on Dec 31 moves with it). */
  const nowYear = () => new Date().getFullYear();
  const TP = () => root.TaxPlay;
  /* The tax year the bracket tables describe. */
  const TAX_YEAR = 2026;
  const MONEY_MAX = 1e9;

  /* ── TAX ARITHMETIC SHARED BY THE MODELS WRITTEN HERE ─────────────────────── */

  /* Bracket index factor for year y: (1 + bracketIndex)^(y - 2026), 1 for 2026 and earlier. */
  function indexOf(prof, y) { return Math.pow(1 + (prof && prof.bracketIndex ? prof.bracketIndex : 0), Math.max(0, y - TAX_YEAR)); }
  /* Ordinary tax on taxable income ti with every bracket edge scaled by f. */
  function taxIdx(ti, st, f) { return f * TP().tax(ti / f, st); }
  /* The discount rate behind every "worth today" figure (default 6%). */
  function discountOf(prof) { return prof && prof.discount != null ? prof.discount : 0.06; }

  /* A running tax ledger over a gross-income map. Every model writes through one of these, so
     the deduction is applied the same way everywhere.
       ti(y)          taxable income in year y: max(0, gross - personal deduction).
       taxAt(y)       ordinary tax in year y on the indexed brackets.
       income(y, a)   add a dollars of ordinary income; returns the extra tax (>= 0).
       deduct(y, a)   take a dollars of deduction; it lowers gross income to zero at most.
                      Returns { saved, carry }: the tax saved and the part left over.
       ltcg(y, g)     long-term capital gains tax on g stacked on top of ti(y); not booked.
     `next` is the gross map after every change, for the strategy after this one. */
  function ledger(income, prof) {
    const st = prof.status, next = Object.assign({}, income);
    const f = (y) => indexOf(prof, y);
    const ded = (y) => Math.max(TP().STD[st], prof.persded || 0) * f(y);
    const gross = (y) => Math.max(0, next[y] || 0);
    const ti = (y) => Math.max(0, gross(y) - ded(y));
    const taxAt = (y) => taxIdx(ti(y), st, f(y));
    return {
      next, ti, taxAt, f,
      income(y, a) { if (!(a > 0)) return 0; const b = taxAt(y); next[y] = (next[y] || 0) + a; return taxAt(y) - b; },
      deduct(y, a) {
        if (!(a > 0)) return { saved: 0, carry: 0 };
        const used = Math.min(a, gross(y)), b = taxAt(y);
        next[y] = (next[y] || 0) - used;
        return { saved: b - taxAt(y), carry: a - used };
      },
      ltcg(y, g) { return g > 0 ? f(y) * TP().ltcgTax(ti(y) / f(y), g / f(y), st) : 0; },
    };
  }

  /* An empty year row for model output, created on first use. */
  function rowsOf() {
    const Y = {};
    const at = (y) => Y[y] || (Y[y] = { year: y, down: 0, saved: 0, extra: 0, cash: 0, sale: 0, owed: 0 });
    const list = () => Object.values(Y).sort((a, b) => a.year - b.year);
    return { Y, at, list };
  }
  /* The net of one year row: the six fields added (see the sign convention above). */
  const netOf = (o) => o.saved + o.extra + o.cash + o.sale + o.down + o.owed;
  /* Year rows discounted to the current year at rate d: sum of net / (1 + d)^(year - now).
     A year before now is not inflated (it counts at face value). */
  function pvOf(years, d) {
    const now = nowYear();
    return years.reduce((a, o) => a + netOf(o) / Math.pow(1 + d, Math.max(0, o.year - now)), 0);
  }
  const reps = (item) => Math.max(1, item.repeat | 0);

  const DEP = { key: 'depMethod', label: 'Method', type: 'select', group: 'Depreciation',
    options: [['bonus', 'Deduct it all in year one (bonus depreciation)'], ['macrs', 'Deduct it over 6 years (standard 5-year schedule)']] };

  /* ── ROTH CONVERSION ─────────────────────────────────────────────────────
     Move money from a pre-tax IRA to a Roth: pay ordinary tax on it now (s.408A(d)(3)), at
     the rate your income that year puts it at, and never pay tax on it or its growth again.
     The honest test is one comparison. If the converted money grows at the same rate either
     way and is discounted at that same rate, converting wins exactly when the rate you avoid
     later beats the rate you pay now: the gain is amount x (later rate - rate paid now) in
     the year converted. The card reports the tab's one convention instead: every year's net
     (tax now, tax-free withdrawals later) discounted to today at the tab's discount rate.
     Inputs (item.inputs): amount ($ a year), growth (fraction), laterRate (fraction, the rate
     on IRA withdrawals in retirement), drawStart (calendar year), drawYears (count).
     Formula per conversion year c: tax T = ledger.income(c, amount); the balance at the first
     withdrawal W = max(c + 1, drawStart) is amount x (1 + g)^(W - c); it is drawn as a level
     annuity over D years, pmt = bal x g / (1 - (1 + g)^-D) / (1 + g) (bal / D when g = 0),
     and each withdrawal saves pmt x laterRate.
     Returns the Run plus `next` (income raised by the conversions) and
     roth { paid, converted, avgNow, laterRate, growth, pv, worst, discount }.
     Edge cases: amount 0 gives zero rates, not NaN. Assumes the tax is paid from cash outside
     the IRA. Ignores RMDs, Medicare surcharges (IRMAA), state tax and the five-year rule. */
  function rothRun(item, income, prof) {
    const inp = item.inputs, L = ledger(income, prof), R = rowsOf(), at = R.at;
    const g = inp.growth || 0, r = inp.laterRate || 0, D = Math.max(1, inp.drawYears | 0);
    let paid = 0, converted = 0;
    const rateNow = [];
    for (let k = 0; k < reps(item); k++) {
      const c = item.startYear + k, A = Math.max(0, inp.amount || 0);
      const T = L.income(c, A);
      at(c).extra -= T;
      paid += T; converted += A;
      if (A > 0) rateNow.push(T / A);
      /* the converted dollars grow tax-free, then come out evenly over the drawing years;
         each withdrawal is tax you would have paid on the same dollars from the IRA */
      const W = Math.max(c + 1, inp.drawStart || 0);
      const bal = A * Math.pow(1 + g, W - c);
      const pmt = g > 0 ? bal * g / (1 - Math.pow(1 + g, -D)) / (1 + g) : bal / D;
      if (A > 0) for (let j = 0; j < D; j++) at(W + j).saved += pmt * r;
    }
    const years = R.list(), d = discountOf(prof);
    const nominal = years.reduce((a, o) => a + o.saved + o.extra, 0);
    const avgNow = converted > 0 ? paid / converted : 0;
    return {
      next: L.next, years,
      sum: { down: 0, y1Deduction: 0, y1TaxSaved: years[0] ? years[0].extra : 0, cumTaxSaved: nominal, cash: 0,
        exitYear: years.length ? years[years.length - 1].year : item.startYear, owedBack: 0, netSale: 0, allIn: nominal },
      roth: { paid, converted, avgNow, laterRate: r, growth: g, pv: pvOf(years, d), discount: d, worst: rateNow.length ? Math.max(...rateNow) : 0 },
    };
  }

  /* ── COST SEGREGATION ────────────────────────────────────────────────────
     A building is normally depreciated in a straight line over 27.5 years (residential) or
     39 (commercial). A cost segregation study moves part of it (fixtures, finishes, site
     work) into 5, 7 and 15-year property, which takes bonus depreciation: most of that part
     is deducted in year one. Nothing new is deducted in total; it is deducted sooner, and
     the later years deduct less. So this models the DIFFERENCE from not doing the study:
       - each year's extra (or missing) depreciation, priced at your bracket that year.
         Both schedules stop when the depreciable basis is used up, so over the full recovery
         life the extra and the missing depreciation cancel (only the fee is left);
       - Sell: the comparison runs for the years held. At the sale the extra depreciation
         taken so far comes back as ordinary income (s.1245), and the reclassified part's
         straight-line share is recaptured at ordinary rates instead of the 25% cap on
         buildings (s.1(h)(1)(E)).
       - Keep (or a 1031 exchange, which carries the basis over): no recapture, but the
         comparison runs to the end of the recovery life whatever the years held, so the extra
         deduction is given back as smaller deductions later. The gain is the use of the money
         in between, which only the "worth today" figure shows.
     Who can use the loss decides most of it. A passive investor (s.469) cannot set it
     against W-2 income; it waits and is released at the sale (never, if kept).
     Inputs: price, land (fraction), type 'res'|'com', reclass (fraction of the building),
     bonus (fraction), fee ($, deducted in year one), use 'active'|'passive', hold (years),
     end 'sell'|'keep'.
     Formula, per year t: base_t = min(B / life, B - base so far); with the study,
     (B - R) / life on the building part (capped the same way) plus R x bonus in year one and
     R x (1 - bonus) x MACRS7[t]; diff_t = with - base (+ fee in year one). B = price x
     (1 - land), R = B x reclass.
     Returns the Run plus cs { y1Ded, y1Saved, pv, net, passive, sell, owed, life, years }.
     Simplified: one 7-year schedule for all reclassified property, losses beyond a year's
     income carry forward in full (no 80% limit), no state tax, and the sale price is assumed
     to cover the recapture. */
  function costSegRun(item, income, prof) {
    const inp = item.inputs, st = prof.status, L = ledger(income, prof), Rw = rowsOf(), at = Rw.at;
    const life = inp.type === 'com' ? 39 : 27.5, m7 = TP().MACRS_PRESETS.m7, H = Math.max(1, inp.hold | 0);
    const sell = inp.end === 'sell', N = sell ? H : Math.ceil(life);
    let y1Ded = 0, y1Saved = 0, owedAll = 0;
    for (let k = 0; k < reps(item); k++) {
      const c = item.startYear + k, B = inp.price * (1 - inp.land), R = B * inp.reclass, fee = inp.fee || 0;
      at(c).down -= fee;
      const diff = [];
      let cumBase = 0, cumBld = 0, cumWith = 0;
      for (let t = 0; t < N; t++) {
        const base = Math.max(0, Math.min(B / life, B - cumBase)); cumBase += base;
        const bld = Math.max(0, Math.min((B - R) / life, (B - R) - cumBld)); cumBld += bld;
        const withS = bld + (t === 0 ? R * inp.bonus : 0) + R * (1 - inp.bonus) * (m7[t] || 0);
        cumWith += withS;
        diff.push(withS - base + (t === 0 ? fee : 0));
      }
      const depDiff = cumWith - cumBase;   // extra depreciation taken by the end of the comparison
      let carry = 0;
      if (inp.use === 'active') {
        diff.forEach((d, t) => {
          const y = c + t;
          const eff = d + carry; carry = 0;
          if (eff > 0) { const r = L.deduct(y, eff); at(y).saved += r.saved; carry = r.carry; }
          else if (eff < 0) at(y).extra -= L.income(y, -eff);
        });
        if (!sell) for (let y = c + N; carry > 0.5 && y < c + N + 20; y++) { const r = L.deduct(y, carry); at(y).saved += r.saved; carry = r.carry; }
      } else {
        carry = diff.reduce((a, d) => a + d, 0);   // suspended until the building is sold
      }
      if (sell) {
        const ye = c + H - 1;
        const recap = L.income(ye, Math.max(0, depDiff));
        const ti = L.ti(ye), f = L.f(ye);
        const marg = (taxIdx(ti + 1000, st, f) - taxIdx(ti, st, f)) / 1000;
        const bump = Math.max(0, marg - 0.25) * Math.min(R, (R / life) * H);
        at(ye).owed -= recap + bump;
        owedAll += recap + bump;
        if (carry > 0) {   // the suspended (passive) or unused loss is released at the sale
          const r = L.deduct(ye, carry);
          at(ye).saved += r.saved;
        }
      }
      if (k === 0) { y1Ded = diff[0]; y1Saved = (Rw.Y[c] ? Rw.Y[c].saved + Rw.Y[c].extra : 0); }
    }
    const years = Rw.list();
    const net = years.reduce((a, o) => a + netOf(o), 0);
    const pv = pvOf(years, discountOf(prof));
    const last = years.length ? years[years.length - 1].year : item.startYear;
    return {
      next: L.next, years,
      sum: { down: (inp.fee || 0) * reps(item), y1Deduction: y1Ded, y1TaxSaved: y1Saved,
        cumTaxSaved: years.reduce((a, o) => a + o.saved + o.extra, 0), cash: 0, exitYear: last, owedBack: owedAll, netSale: 0, allIn: net },
      cs: { y1Ded, y1Saved, pv, net, passive: inp.use === 'passive', sell, owed: owedAll, life, years: N },
    };
  }

  /* ── OIL AND GAS DRILLING ────────────────────────────────────────────────
     A drilling program spends most of your money on intangible drilling costs (labor, mud,
     services, s.263(c)), which you deduct in the year you invest; equipment is 7-year
     property that takes bonus depreciation (s.168(k)); the rest buys the lease. Production
     then pays cash that declines each year, and 15% of it is sheltered by percentage
     depletion (s.613A, the allowance for independent producers). Unlike the deal strategies
     this is real cash at risk: what comes back depends on the wells.
     How you hold it decides the deduction. A WORKING interest is not a passive activity even
     without material participation (s.469(c)(3)), so it offsets W-2 income; it carries
     unlimited liability unless held through an entity. A LIMITED partner's loss is passive:
     it shelters the program's own income first, and the rest is released when production
     ends. Held to depletion: no sale, no recapture.
     Inputs: amount ($), idc and tdc (fractions of the amount, together at most 100%), bonus
     (fraction of equipment), interest 'working'|'limited', yield1 (first-year cash as a
     fraction of the amount), decline (fraction a year), prodYears.
     Formula: year one deducts amount x idc + equipment depreciation; production year t
     (t = 1..N, starting the year after you invest) pays amount x yield1 x (1 - decline)^(t-1)
     and is taxed on 85% of it less that year's equipment depreciation.
     Returns the Run plus og { y1Ded, y1Saved, putIn, cashAll, net, pv, limited, afterTax }.
     Simplified: depletion is a flat 15% of production cash (no 65% of taxable income limit,
     no cost depletion), losses carry forward in full. */
  function oilGasRun(item, income, prof) {
    const inp = item.inputs, L = ledger(income, prof), Rw = rowsOf(), at = Rw.at;
    const m7 = TP().MACRS_PRESETS.m7, N = Math.max(1, inp.prodYears | 0);
    /* apply a change in taxable income to year y, priced through the brackets; returns any
       deduction the year could not use */
    const book = (y, delta) => {
      if (delta < 0) { const r = L.deduct(y, -delta); at(y).saved += r.saved; return r.carry; }
      if (delta > 0) at(y).extra -= L.income(y, delta);
      return 0;
    };
    let y1Ded = 0, y1Saved = 0, cashAll = 0, putIn = 0;
    for (let k = 0; k < reps(item); k++) {
      const c = item.startYear + k, A = inp.amount, T = A * inp.tdc;
      at(c).down -= A; putIn += A;
      const dep = (t) => (t === 0 ? T * inp.bonus : 0) + T * (1 - inp.bonus) * (m7[t] || 0);
      const ded0 = A * inp.idc + dep(0);
      let carry = 0;
      if (inp.interest === 'working') carry = book(c, -ded0);
      else carry = ded0;
      if (k === 0) { y1Ded = ded0; y1Saved = Rw.Y[c] ? Rw.Y[c].saved : 0; }
      for (let t = 1; t <= N; t++) {
        const y = c + t, cash = A * inp.yield1 * Math.pow(1 - inp.decline, t - 1);
        at(y).cash += cash; cashAll += cash;
        let taxable = cash * 0.85 - dep(t);
        const use = Math.min(carry, Math.max(0, taxable));   // a carried or suspended loss shelters the program's own income first
        taxable -= use; carry -= use;
        if (inp.interest === 'working' && carry > 0) { carry = book(y, -carry); }
        if (taxable < 0 && inp.interest !== 'working') carry += -taxable;   // a passive loss stays suspended
        else carry += book(y, taxable);
      }
      if (carry > 0) book(c + N, -carry);   // whatever is left is released when production ends
    }
    const years = Rw.list();
    const net = years.reduce((a, o) => a + netOf(o), 0);
    const pv = pvOf(years, discountOf(prof));
    return {
      next: L.next, years,
      sum: { down: putIn, y1Deduction: y1Ded, y1TaxSaved: y1Saved, cumTaxSaved: years.reduce((a, o) => a + o.saved + o.extra, 0), cash: cashAll,
        exitYear: years.length ? years[years.length - 1].year : item.startYear, owedBack: 0, netSale: 0, allIn: net },
      og: { y1Ded, y1Saved, putIn, cashAll, net, pv, limited: inp.interest === 'limited', afterTax: putIn - y1Saved },
    };
  }

  /* ── SOLAR INVESTMENT CREDIT ─────────────────────────────────────────────
     Solar equipment bought for a business earns the investment tax credit (s.48E): a
     dollar-for-dollar cut in the tax itself, 30% of cost at the base rate. The equipment is
     depreciated on its cost less half the credit (s.50(c)(3)), with bonus depreciation. It
     earns income (power sales or a lease) and is sold at the end.
     The deadline that decides it: under the 2025 law (One Big Beautiful Bill Act) a project
     that begins construction after July 4, 2026 must be in service by Dec 31, 2027. A
     project placed in service later gets no credit here.
     The credit can only reduce tax that exists: what one year cannot use carries forward
     (up to 20 years after the sale here). Selling within 5 years claws back the unvested part
     (s.50(a): 20% vests each full year), and half of what is clawed back is added back to
     the basis (s.50(c)(2)).
     The sale: gain up to the depreciation taken is recaptured as ordinary income (s.1245);
     gain above the original basis is a long-term capital gain (s.1231), taxed at the 0/15/20%
     rates on top of ordinary income; a sale below the adjusted basis is an ordinary loss.
     Passive investors use the credit and the loss only against the project's own income and
     its sale; the loss is released at the sale, a credit left over is lost to this plan.
     Inputs: price ($), credit (fraction), bonus (fraction), use 'active'|'passive', yield1,
     decline, hold (years; sold at the end of the last), salePct (fraction of cost, 0 to 150%).
     Returns the Run plus sol { y1Saved, creditAll, creditUsed, clawAll, lostAll, cashAll,
     cgTaxAll, net, pv, passive, late, putIn }.
     Simplified: cash purchase (no loan), no s.38(c) general business credit limit beyond the
     tax owed, no NIIT on the gain. */
  function solarRun(item, income, prof) {
    const inp = item.inputs, L = ledger(income, prof), Rw = rowsOf(), at = Rw.at;
    const m5 = TP().MACRS_PRESETS.m5, H = Math.max(1, inp.hold | 0);
    const book = (y, delta) => {
      if (delta < 0) { const r = L.deduct(y, -delta); at(y).saved += r.saved; return r.carry; }
      if (delta > 0) at(y).extra -= L.income(y, delta);
      return 0;
    };
    const active = inp.use === 'active';
    const usedIn = {};   // credit already taken against each year's tax, across every project
    let y1Saved = 0, creditAll = 0, creditUsed = 0, clawAll = 0, lostAll = 0, cashAll = 0, cgTaxAll = 0, late = false;
    for (let k = 0; k < reps(item); k++) {
      const c = item.startYear + k, P = inp.price;
      const credit = c <= 2027 ? P * inp.credit : 0;
      if (!credit && inp.credit > 0) late = true;
      const basis = P - credit / 2;
      const dep = (t) => (t === 0 ? basis * inp.bonus : 0) + basis * (1 - inp.bonus) * (m5[t] || 0);
      at(c).down -= P; creditAll += credit;
      let lossCarry = 0, credCarry = credit, depTaken = 0;
      /* use the credit against up to `cap` of year y's tax */
      const useCredit = (y, cap) => { const u = Math.min(credCarry, Math.max(0, cap)); credCarry -= u; creditUsed += u; usedIn[y] = (usedIn[y] || 0) + u; at(y).saved += u; return u; };
      for (let t = 0; t < H; t++) {
        const y = c + t;
        const cash = t === 0 ? 0 : P * inp.yield1 * Math.pow(1 - inp.decline, t - 1);
        at(y).cash += cash; cashAll += cash;
        const d = dep(t); depTaken += d;
        let taxable = cash - d;
        if (active) {
          lossCarry = book(y, taxable - lossCarry);
          useCredit(y, L.taxAt(y) - (usedIn[y] || 0));
        } else {
          /* passive: the credit only offsets tax the project's own income creates */
          const use = Math.min(lossCarry, Math.max(0, taxable)); taxable -= use; lossCarry -= use;
          if (taxable < 0) { lossCarry -= taxable; taxable = 0; }
          const before = L.taxAt(y); book(y, taxable); useCredit(y, L.taxAt(y) - before);
        }
      }
      /* the sale, at the end of the last year held */
      const ys = c + H - 1, saleCash = P * inp.salePct;
      at(ys).sale += saleCash;
      const claw = credit * Math.min(1, Math.max(0, 6 - H) / 5);   // sold in year 1: all of it; each later year 20% less; year 6 on: none
      const adjBasis = Math.max(0, basis + claw / 2 - depTaken);
      const gain = saleCash - adjBasis;
      const recapInc = Math.max(0, Math.min(gain, depTaken));
      const capGain = Math.max(0, gain - recapInc);
      const recapTax = L.income(ys, recapInc);
      const cgTax = L.ltcg(ys, capGain);
      cgTaxAll += cgTax;
      at(ys).owed -= recapTax + cgTax + claw; clawAll += claw;
      if (gain < 0) lossCarry += -gain;   // a sale below the adjusted basis is an ordinary (s.1231) loss
      if (!active) useCredit(ys, recapTax + cgTax);   // passive credit can offset the tax the sale creates
      if (lossCarry > 0) book(ys, -lossCarry);
      if (active && credCarry > 0) for (let y = ys + 1; y < ys + 20 && credCarry > 0; y++) useCredit(y, L.taxAt(y) - (usedIn[y] || 0));
      lostAll += credCarry;
      if (k === 0) y1Saved = Rw.Y[c] ? Rw.Y[c].saved : 0;
    }
    const years = Rw.list();
    const net = years.reduce((a, o) => a + netOf(o), 0);
    const pv = pvOf(years, discountOf(prof));
    return {
      next: L.next, years,
      sum: { down: inp.price * reps(item), y1Deduction: 0, y1TaxSaved: y1Saved, cumTaxSaved: years.reduce((a, o) => a + o.saved + o.extra, 0),
        cash: cashAll, exitYear: years.length ? years[years.length - 1].year : item.startYear, owedBack: -years.reduce((a, o) => a + o.owed, 0),
        netSale: years.reduce((a, o) => a + o.sale, 0), allIn: net },
      sol: { y1Saved, creditAll, creditUsed, clawAll, lostAll, cashAll, cgTaxAll, net, pv, passive: !active, late, putIn: inp.price * reps(item) },
    };
  }

  const STRATEGIES = [
    { id: 'hm', kind: 'hm', name: 'Heavy Machinery', tag: 'Equipment leasing', status: 'ready',
      blurb: 'Buy equipment mostly with a loan, lease it to an operator, and deduct its price up front.',
      fields: [
        { key: 'price', label: 'Equipment price', type: 'money', group: 'The purchase', step: 25000, min: 0, max: 1e8 },
        { key: 'down', label: 'Down payment', type: 'pct', group: 'The purchase', step: 1, min: 0, max: 100 },
        { key: 'fee', label: 'Fees, year one', type: 'pct', group: 'The purchase', step: 0.5, min: 0, max: 20, help: 'Platform and origination fees, deducted in year one' },
        { key: 'noteRate', label: 'Loan rate', type: 'pct', group: 'The loan', step: 0.25, min: 0, max: 20 },
        { key: 'amortYears', label: 'Loan term (years)', type: 'int', group: 'The loan', step: 1, min: 1, max: 30 },
        { key: 'lease', label: 'Lease income a year', type: 'money', group: 'The lease', step: 1000, min: 0, max: 1e7 },
        { key: 'exit', label: 'Sold back after (years)', type: 'int', group: 'The exit', step: 1, min: 1, max: 8, help: 'The published model runs 8 years, so the sale must fall inside them' },
        { key: 'buybackPct', label: 'Buyback price (% of equipment price)', type: 'pct', group: 'The exit', step: 1, min: 0, max: 150 },
        DEP,
      ] },
    { id: 'wfh', kind: 'wfh', name: 'Workforce Housing', tag: 'Real estate', status: 'ready',
      blurb: 'Buy a rental unit with seller financing, rent it out, and deduct its price up front.',
      fields: [
        { key: 'price', label: 'Unit price', type: 'money', group: 'The purchase', step: 25000, min: 0, max: 1e8 },
        { key: 'down', label: 'Down payment', type: 'pct', group: 'The purchase', step: 1, min: 0, max: 100 },
        { key: 'noteRate', label: 'Note rate', type: 'pct', group: 'The loan', step: 0.25, min: 0, max: 20 },
        { key: 'paydown', label: 'Rent pays down the note', type: 'bool', group: 'The loan' },
        { key: 'rent', label: 'Rent a month', type: 'money', group: 'The rent', step: 50, min: 0, max: 1e6 },
        { key: 'fee', label: 'Management fee', type: 'pct', group: 'The rent', step: 1, min: 0, max: 60, help: 'Share of rent' },
        { key: 'y1f', label: 'Year one rented', type: 'pct', group: 'The rent', step: 5, min: 0, max: 100 },
        { key: 'exit', label: 'Sold after (years)', type: 'int', group: 'The exit', step: 1, min: 1, max: 10, help: 'The published model runs 10 years, so the sale must fall inside them' },
        { key: 'residual', label: 'Sale price', type: 'money', group: 'The exit', step: 10000, min: 0, max: 1e8 },
        DEP,
      ] },
    { id: 'roth', name: 'Roth conversion', tag: 'Retirement accounts', status: 'ready', run: rothRun, raisesIncome: true,
      blurb: 'Pay tax now on part of your IRA, in a year it is cheap, so it comes out tax-free later.',
      repeatLabel: 'Years converting', repeatDefault: 3,
      get defaults() { return { amount: 100000, growth: 0.06, laterRate: 0.24, drawStart: nowYear() + 14, drawYears: 20 }; },
      fields: [
        { key: 'amount', label: 'Convert each year', type: 'money', group: 'The conversion', step: 10000, min: 0, max: 1e8, help: 'Moved from the IRA to a Roth IRA; taxed as ordinary income that year' },
        { key: 'growth', label: 'Growth a year', type: 'pct', group: 'The conversion', step: 0.5, min: 0, max: 15, help: 'The same either way; it only sets how big the later withdrawals are' },
        { key: 'laterRate', label: 'Your tax rate later', type: 'pct', group: 'Later', step: 1, min: 0, max: 50, help: 'The rate you would pay on IRA withdrawals in retirement' },
        { key: 'drawStart', label: 'Start drawing in', type: 'int', group: 'Later', step: 1, min: () => nowYear(), max: () => nowYear() + 50 },
        { key: 'drawYears', label: 'Drawn over (years)', type: 'int', group: 'Later', step: 1, min: 1, max: 40 },
      ] },
    { id: 'costseg', name: 'Cost segregation', tag: 'Real estate', status: 'ready', run: costSegRun,
      blurb: 'An engineering study moves part of a building into short-lived property you can deduct up front.',
      repeatLabel: 'Buildings, one a year',
      defaults: { price: 1000000, land: 0.20, type: 'res', reclass: 0.25, bonus: 1, fee: 8000, use: 'active', hold: 10, end: 'sell' },
      fields: [
        { key: 'price', label: 'Purchase price', type: 'money', group: 'The building', step: 50000, min: 0, max: 1e9 },
        { key: 'land', label: 'Land share', type: 'pct', group: 'The building', step: 1, min: 0, max: 90, help: 'Land is never depreciated' },
        { key: 'type', label: 'Type', type: 'select', group: 'The building', options: [['res', 'Residential rental (27.5 years)'], ['com', 'Commercial (39 years)']] },
        { key: 'reclass', label: 'Moved to short-lived property', type: 'pct', group: 'The study', step: 1, min: 0, max: 60, help: 'Share of the building the study reclassifies to 5, 7 and 15-year property; 20 to 30% is common' },
        { key: 'bonus', label: 'Bonus depreciation', type: 'pct', group: 'The study', step: 10, min: 0, max: 100, help: 'Share of the reclassified property deducted in year one' },
        { key: 'fee', label: 'Study fee', type: 'money', group: 'The study', step: 1000, min: 0, max: 1e7 },
        { key: 'use', label: 'Can the loss offset your W-2?', type: 'select', group: 'Your situation',
          options: [['active', 'Yes: real estate professional or short-term rental'], ['passive', 'No: passive investor (loss waits for the sale)']] },
        { key: 'hold', label: 'Years you hold it', type: 'int', group: 'The end', step: 1, min: 1, max: 40, help: 'Used when you sell. Keeping it runs the comparison to the end of the recovery life' },
        { key: 'end', label: 'At the end', type: 'select', group: 'The end', options: [['sell', 'Sell, and pay recapture'], ['keep', 'Keep for life, or 1031 exchange']] },
      ] },
    { id: 'energy', name: 'Oil and gas drilling', tag: 'Energy', status: 'ready', run: oilGasRun,
      blurb: 'Invest in a drilling program and deduct most of it, the intangible drilling costs, in the year you invest.',
      repeatLabel: 'Programs, one a year',
      defaults: { amount: 100000, idc: 0.75, tdc: 0.20, bonus: 1, interest: 'working', yield1: 0.22, decline: 0.18, prodYears: 12 },
      /* drilling costs and equipment are shares of one investment, so together at most 100% */
      fix(inp, key) {
        if (inp.idc + inp.tdc <= 1 + 1e-9) return null;
        const other = key === 'tdc' ? 'idc' : 'tdc', mine = other === 'idc' ? 'tdc' : 'idc';
        inp[mine] = Math.max(0, 1 - inp[other]);
        return 'Drilling costs and equipment together cannot be more than 100% of the investment; set to ' + pct(inp[mine], 0) + '.';
      },
      fields: [
        { key: 'amount', label: 'Amount invested', type: 'money', group: 'The investment', step: 10000, min: 0, max: 1e8 },
        { key: 'idc', label: 'Intangible drilling costs', type: 'pct', group: 'The investment', step: 1, min: 0, max: 100, help: 'Labor, mud, chemicals, services: deductible in the year paid. Programs usually state 65 to 85%' },
        { key: 'tdc', label: 'Equipment (tangible)', type: 'pct', group: 'The investment', step: 1, min: 0, max: 100, help: 'Well casing and equipment: 7-year property. The rest of the investment is the lease, recovered through depletion' },
        { key: 'bonus', label: 'Bonus on equipment', type: 'pct', group: 'The investment', step: 10, min: 0, max: 100 },
        { key: 'interest', label: 'How you hold it', type: 'select', group: 'Your situation',
          options: [['working', 'Working interest: deduction offsets W-2'], ['limited', 'Limited partner: passive, deduction waits']] },
        { key: 'yield1', label: 'First-year cash yield', type: 'pct', group: 'Production', step: 1, min: 0, max: 60, help: 'Cash from production in the first full year, as a share of what you invested. Dry holes and prices move this most' },
        { key: 'decline', label: 'Decline each year', type: 'pct', group: 'Production', step: 1, min: 0, max: 60, help: 'Wells produce less each year; 15 to 30% is typical' },
        { key: 'prodYears', label: 'Years producing', type: 'int', group: 'Production', step: 1, min: 1, max: 30 },
      ] },
    { id: 'solar', name: 'Solar investment credit', tag: 'Energy', status: 'ready', run: solarRun,
      blurb: 'Buy solar equipment for a business: a credit against the tax itself, plus depreciation on most of the cost.',
      repeatLabel: 'Projects, one a year',
      defaults: { price: 100000, credit: 0.30, bonus: 1, use: 'active', yield1: 0.10, decline: 0.01, hold: 6, salePct: 0.30 },
      fields: [
        { key: 'price', label: 'Equipment cost', type: 'money', group: 'The project', step: 10000, min: 0, max: 1e8 },
        { key: 'credit', label: 'Credit rate', type: 'pct', group: 'The project', step: 5, min: 0, max: 70, help: '30% base; projects can add 10% each for domestic content or an energy community' },
        { key: 'bonus', label: 'Bonus depreciation', type: 'pct', group: 'The project', step: 10, min: 0, max: 100, help: 'On the cost less half the credit; the rest is 5-year property' },
        { key: 'use', label: 'Can it offset your W-2 tax?', type: 'select', group: 'Your situation',
          options: [['active', 'Yes: you materially participate'], ['passive', 'No: passive investor (credit and loss wait)']] },
        { key: 'yield1', label: 'First-year cash yield', type: 'pct', group: 'Income', step: 1, min: 0, max: 40, help: 'Power sales or lease payments in the first year, as a share of cost' },
        { key: 'decline', label: 'Decline each year', type: 'pct', group: 'Income', step: 0.5, min: 0, max: 20, help: 'Panels lose output; contracts step down' },
        { key: 'hold', label: 'Sold after (years)', type: 'int', group: 'The sale', step: 1, min: 1, max: 30, help: 'Selling inside 5 years claws back part of the credit' },
        { key: 'salePct', label: 'Sale price (% of cost)', type: 'pct', group: 'The sale', step: 5, min: 0, max: 150, help: 'Above the cost less half the credit, the gain is taxed as a long-term capital gain' },
      ] },
  ];
  /* The strategy definition for an id, or undefined. */
  const byId = (id) => STRATEGIES.find((x) => x.id === id);

  /* The plan item's own controls, validated like any other field. */
  const ITEM_FIELDS = {
    startYear: { key: 'startYear', label: 'First year', type: 'int', min: () => nowYear(), max: () => nowYear() + 40 },
    repeat: { key: 'repeat', label: 'Repeat', type: 'int', min: 1, max: 20 },
  };
  /* The Federal Tax Baseline card's inputs. */
  const PROFILE_FIELDS = [
    { key: 'w2Now', label: 'W-2 income this year', type: 'money', step: 10000, min: 0, max: 1e8 },
    { key: 'w2Growth', label: 'Growing each year', type: 'pct', step: 0.5, min: -10, max: 20 },
    { key: 'persded', label: 'Personal deductions', type: 'money', step: 100, min: 0, max: 1e7, help: 'The larger of this and the standard deduction is used' },
    { key: 'retireIncome', label: 'Taxable income after you stop', type: 'money', step: 10000, min: 0, max: 1e8, help: 'From the Retirement tab’s stop year on, W-2 income is replaced by this (pension, IRA withdrawals, 85% of Social Security), in today’s money, rising with the brackets' },
    { key: 'bracketIndex', label: 'Brackets rise each year', type: 'pct', step: 0.5, min: 0, max: 10, help: 'Inflation indexing of the brackets and the standard deduction. Heavy Machinery and Workforce Housing keep 2026 brackets, as the published tools do' },
    { key: 'discount', label: 'Discount rate', type: 'pct', step: 0.5, min: 0, max: 15, help: 'Every “worth today” figure on this tab discounts each year’s net to this year at this rate: what the money could earn elsewhere. Not the inflation adjustment Retirement uses' },
  ];

  /* Session state, for this visit only. */
  let uid = 0;
  /* growth: null until the reader moves the slider; until then the view uses the
     portfolio's expected return from the Retirement Simulator (see growthNow).
     msgs: inline validation messages, keyed by the control's data attribute value.
     book: the book the plan was built for (a new book starts a new plan). */
  const PROFILE_DEFAULTS = { status: 'mfj', w2Now: 400000, w2Growth: 0.03, persded: 32200, retireIncome: 0, bracketIndex: 0.025, discount: 0.06 };
  const S = { plan: [], growth: null, local: Object.assign({}, PROFILE_DEFAULTS), msgs: {}, book: null, focusNext: null };
  const profile = () => S.local;

  /* Add a new plan item for strategy `id` with its default inputs, starting this year.
     Returns the new item (or undefined for an unknown or not-ready id). The plan starts
     empty: nothing reaches Retirement until the reader adds something. */
  function addStrategy(id) {
    const def = byId(id), K = def && def.kind && TP().KINDS[def.kind];
    if (!def || def.status !== 'ready') return undefined;
    const inputs = {}, dflt = K ? K.defaults : def.defaults;
    def.fields.forEach((f) => { inputs[f.key] = dflt[f.key]; });
    const it = { uid: ++uid, id, startYear: nowYear(), repeat: def.repeatDefault || 1, inputs };
    S.plan.push(it);
    return it;
  }

  /* Start over: an empty plan, the default baseline, no messages. Called when a new book loads. */
  function reset() {
    S.plan.length = 0; S.growth = null; S.msgs = {}; S.focusNext = null; S.seeded = null;
    Object.assign(S.local, PROFILE_DEFAULTS);
  }
  /* A new book (a different ctx.book) means a different household: start a new plan. Only
     used when the shared reset hook (includes.js AppState) is not loaded; with it, reset() is
     registered below and runs once per new book for every module together. */
  function syncBook(ctx) {
    const b = ctx && ctx.book;
    if (!b) return;
    if (S.book && S.book !== b) reset();
    S.book = b;
  }
  /* THE MEMBER'S OWN BASELINE. The You tab can carry Filing status, Household income and
     Taxable income after you stop; they replace the defaults once per book, the first time
     the tab draws it, so a reader's later edits on this tab are not overwritten. */
  function seedFromSheet(ctx) {
    const b = ctx && ctx.book;
    if (!b || S.seeded === b) return;
    S.seeded = b;
    let you = null;
    try { you = root.RunwayUI && root.RunwayUI.you ? root.RunwayUI.you(ctx) : null; } catch (e) { you = null; }
    if (!you) return;
    if (you.filingStatus === 'mfj' || you.filingStatus === 'single') S.local.status = you.filingStatus;
    if (Number.isFinite(you.w2Now)) S.local.w2Now = you.w2Now;
    if (Number.isFinite(you.retireIncome)) S.local.retireIncome = you.retireIncome;
  }
  /* Move items that now start in the past (the year rolled over during the session) to this
     year, so Retirement, which starts at this year, still sees their first year. */
  function freshen() {
    const y = nowYear();
    S.plan.forEach((it) => {
      if (it.startYear < y) it.startYear = y;
      if (it.inputs && it.inputs.drawStart != null && it.inputs.drawStart < y) it.inputs.drawStart = y;
    });
  }

  /* Gross ordinary income by calendar year, from this year for 60 years: W-2 growing at its
     rate until the Retirement stop year, then "Taxable income after you stop" rising with the
     brackets. With no plan loaded there is no stop year and W-2 runs on. */
  function incomeMap(ctx) {
    const p = profile(), out = {}, y0 = nowYear();
    let stop = null;
    try { stop = root.RunwayUI.stopYear(ctx); } catch (e) { /* no plan loaded: income runs on */ }
    for (let y = y0; y < y0 + 60; y++) {
      out[y] = (stop && y >= stop) ? (p.retireIncome || 0) * Math.pow(1 + (p.bracketIndex || 0), y - y0)
        : p.w2Now * Math.pow(1 + p.w2Growth, y - y0);
    }
    return out;
  }
  /* The stop year from Retirement, or null. */
  function stopYearOf(ctx) { try { return root.RunwayUI.stopYear(ctx); } catch (e) { return null; } }

  /* A TaxPlay run (Heavy Machinery, Workforce Housing) in the common Run shape. tax saved
     splits into saved (> 0) and extra (< 0); the exit year's sale is shown before tax, with
     the recapture and capital gains tax as owed. */
  function fromTaxPlay(run, uidOf) {
    const K = TP().KINDS[run.kind], inp = run.res.inp, sm = TP().summary(run);
    const years = run.res.years.map((r, i) => ({
      year: run.startYear + i, down: i === 0 ? -inp.price * inp.down : 0,
      saved: Math.max(0, r.taxSav), extra: Math.min(0, r.taxSav), cash: K.cash(r),
      sale: r.isExit ? r.netSale + r.recapTax + r.ltcgTaxAmt : 0, owed: r.isExit ? -(r.recapTax + r.ltcgTaxAmt) : 0,
    }));
    return { label: run.label, startYear: run.startYear, uid: uidOf, years,
      sum: { down: sm.down, y1Deduction: sm.y1Deduction, y1TaxSaved: sm.y1TaxSaved, cumTaxSaved: sm.cumTaxSaved, cash: sm.cash,
        exitYear: sm.exitYear, owedBack: sm.recapTax + sm.ltcgTax, netSale: sm.netSale, allIn: sm.allIn } };
  }

  /* Run the whole plan and return one Run per strategy (one per repeat for HM and WFH).
     Order: income-raising strategies first, then the rest in plan order. Each sees the gross
     income the ones before it left (`cur`). For HM and WFH that is the play's taxable income
     plus its recapture in the exit year, grossed back up by the personal deduction; when the
     play leaves no taxable income, the gross is the lower of the income it saw (less its own
     loss) and the deduction. `plan` defaults to the session plan. */
  function runPlan(income, prof, plan) {
    plan = plan || S.plan;
    let cur = Object.assign({}, income);
    const runs = [];
    const order = plan.filter((it) => byId(it.id).raisesIncome).concat(plan.filter((it) => !byId(it.id).raisesIncome));
    order.forEach((it) => {
      const def = byId(it.id);
      if (def.run) {
        const r = def.run(it, cur, prof);
        cur = r.next;
        runs.push({ label: def.name, startYear: it.startYear, uid: it.uid, years: r.years, sum: r.sum, roth: r.roth, cs: r.cs, og: r.og, sol: r.sol });
        return;
      }
      for (let k = 0; k < reps(it); k++) {
        const play = { kind: def.kind, label: def.name + (it.repeat > 1 ? ' #' + (k + 1) : ''), startYear: it.startYear + k,
          inputs: Object.assign({ status: prof.status, persded: prof.persded }, it.inputs) };
        const r = TP().runPlay(play, cur);
        const next = Object.assign({}, cur), pd = r.res.persDed;
        r.res.years.forEach((row, i) => {
          const yr = play.startYear + i, ord = row.dealTI + (row.isExit ? row.recapInc : 0);
          next[yr] = ord > 0 ? ord + pd : Math.min(pd, Math.max(0, (cur[yr] || 0) + Math.min(0, row.schedC)));
        });
        cur = next;
        runs.push(fromTaxPlay(r, it.uid));
      }
    });
    return runs;
  }

  /* Calendar-year totals across every run, split the way the chart draws them:
     [{ year, down, saved, extra, cash, sale, owed, items: [labels] }], sorted by year, years
     where every field rounds to zero left out. */
  function yearly(runs) {
    const Y = {};
    const keys = ['down', 'saved', 'extra', 'cash', 'sale', 'owed'];
    runs.forEach((run) => run.years.forEach((o) => {
      const t = Y[o.year] || (Y[o.year] = { year: o.year, down: 0, saved: 0, extra: 0, cash: 0, sale: 0, owed: 0, items: [] });
      keys.forEach((k) => { t[k] += o[k] || 0; });
      if (keys.some((k) => o[k]) && !t.items.includes(run.label)) t.items.push(run.label);
    }));
    return Object.values(Y).filter((o) => keys.some((k) => Math.abs(o[k]) > 0.5)).sort((a, b) => a.year - b.year);
  }

  const PARTS = [
    ['saved', 'Tax saved', '#34C759', 'Federal tax you do not pay that year: a deduction, a credit, or a tax-free Roth withdrawal'],
    ['cash', 'Cash from the deal', '#0071E3', 'Lease, rent or production left after the loan and fees'],
    ['sale', 'Sale, after the loan', '#5AC8FA', 'What the sale brings in after paying off the loan, before tax'],
    ['down', 'Cash you put in', '#8E8E93', 'Down payments, study fees, the price of a program or project'],
    ['extra', 'Extra tax', '#FF9F9A', 'Tax on a Roth conversion, or on deal income once the deduction is used up'],
    ['owed', 'Tax owed back', '#FF3B30', 'Tax due when you sell: depreciation recapture, capital gains, a clawed-back credit'],
  ];

  /* The year-by-year stacked bar chart (SVG string) for yearly() rows: positive parts stack
     up from zero, negative parts down, a dot marks each year's net. Empty string for no rows. */
  function chart(rows) {
    if (!rows.length) return '';
    const W = 960, H = 320, L = 64, R = 20, T = 16, B = 34;
    let hi = 0, lo = 0;
    rows.forEach((r) => {
      hi = Math.max(hi, r.saved + Math.max(0, r.cash) + r.sale);
      lo = Math.min(lo, r.down + r.extra + r.owed + Math.min(0, r.cash));
    });
    const span = (hi - lo) || 1; hi += span * 0.05; lo -= span * 0.05;
    const ys = (v) => T + (hi - v) / (hi - lo) * (H - T - B);
    const bw = Math.min(54, (W - L - R) / rows.length * 0.62);
    const xc = (i) => L + (i + 0.5) * (W - L - R) / rows.length;
    const every = Math.ceil(rows.length / 16);
    let s = '<div class="mk-chart"><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Year by year: tax saved, cash, and tax owed back">';
    const step = niceStep((hi - lo) / 5);
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + ys(v).toFixed(1) + '" y2="' + ys(v).toFixed(1) + '" stroke="' + (Math.abs(v) < 1e-6 ? '#1D1D1F' : '#E8E8ED') + '"/>'
        + '<text x="' + (L - 8) + '" y="' + (ys(v) + 4).toFixed(1) + '" text-anchor="end" class="ax">' + short(v) + '</text>';
    }
    rows.forEach((r, i) => {
      const x = xc(i) - bw / 2;
      let up = 0, dn = 0;
      PARTS.forEach(([k, label, color, desc]) => {
        const v = r[k];
        if (Math.abs(v) < 0.5) return;
        let y0, y1;
        if (v > 0) { y0 = ys(up + v); y1 = ys(up); up += v; } else { y0 = ys(dn); y1 = ys(dn + v); dn += v; }
        s += '<rect x="' + x.toFixed(1) + '" y="' + y0.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(1, y1 - y0).toFixed(1) + '" rx="3" fill="' + color + '"><title>'
          + esc(r.year + ' · ' + label + ': ' + money(v) + '\n' + desc) + '</title></rect>';
      });
      const net = netOf(r);
      s += '<circle cx="' + xc(i).toFixed(1) + '" cy="' + ys(net).toFixed(1) + '" r="4.5" fill="#1D1D1F" stroke="#fff" stroke-width="1.5"><title>'
        + esc(r.year + ' · Net that year: ' + money(net) + '\n' + PARTS.filter(([k]) => Math.abs(r[k]) >= 0.5).map(([k, l]) => l + ': ' + money(r[k])).join('\n') + (r.items.length ? '\nFrom: ' + r.items.join(', ') : '')) + '</title></circle>';
      if (i % every === 0) s += '<text x="' + xc(i).toFixed(1) + '" y="' + (H - 10) + '" text-anchor="middle" class="ax">' + r.year + '</text>';
    });
    return s + '</svg></div><div class="mk-legend">' + PARTS.map(([, l, c]) => '<span><i style="background:' + c + '"></i>' + l + '</span>').join('')
      + '<span><i style="background:#1D1D1F;border-radius:50%"></i>Net that year</span></div>';
  }
  /* A round axis step (1, 2, 2.5, 5 or 10 times a power of ten) at least x. */
  function niceStep(x) {
    const p = Math.pow(10, Math.floor(Math.log10(Math.max(1, x)))), m = x / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
  }

  /* ── INPUT VALIDATION ──────────────────────────────────────────────────── */

  /* A field bound (min or max) in the units typed, resolving functions of the year. Money
     fields with no max get MONEY_MAX. */
  function bound(f, which) {
    const v = f[which];
    if (typeof v === 'function') return v();
    if (v == null && which === 'max' && f.type === 'money') return MONEY_MAX;
    return v;
  }
  /* A stored value as the reader sees it: 0.25 -> "25%", 500000 -> "$500,000". */
  function shown(f, v) { return f.type === 'pct' ? +(v * 100).toFixed(4) + '%' : f.type === 'money' ? money(v) : String(v); }

  /* Validate one typed value for field f. `raw` is the text from the control, `prev` the
     stored value. Returns { value, msg }: the value to store (a fraction for 'pct', rounded
     for 'int', clamped to [min, max]) and a plain-English message when the entry was changed
     or rejected (null when it was taken as typed). Blank or non-numeric text keeps `prev`.
     A "$", "%" or thousands separator in the text is ignored. Selects and checkboxes pass
     through unchanged. */
  function validate(f, raw, prev) {
    if (f.type === 'select' || f.type === 'bool') return { value: raw, msg: null };
    const lo = bound(f, 'min'), hi = bound(f, 'max');
    const s = String(raw == null ? '' : raw).trim().replace(/[$,%\s]/g, '');
    const range = (lo != null && hi != null) ? ' between ' + shownTyped(f, lo) + ' and ' + shownTyped(f, hi) : '';
    if (s === '' || !isFinite(Number(s))) {
      return { value: prev, msg: f.label + ' needs a number' + range + '; kept ' + shown(f, prev) + '.' };
    }
    let n = Number(s);
    if (f.type === 'int') n = Math.round(n);
    let msg = null;
    if (lo != null && n < lo) { msg = f.label + ' must be' + range + '; set to ' + shownTyped(f, lo) + '.'; n = lo; }
    else if (hi != null && n > hi) { msg = f.label + ' must be' + range + '; set to ' + shownTyped(f, hi) + '.'; n = hi; }
    return { value: f.type === 'pct' ? n / 100 : n, msg };
  }
  /* A bound in typed units, for messages: 100 -> "100%" for a percent field. */
  function shownTyped(f, v) { return f.type === 'pct' ? v + '%' : f.type === 'money' ? money(v) : String(v); }

  /* The inline message under a control, if any. */
  function msgHtml(key) {
    const m = S.msgs[key];
    return m ? '<small class="warn tx-msg" role="alert" style="display:block;font-size:12px;font-weight:500;margin-top:4px;max-width:260px">' + esc(m) + '</small>' : '';
  }

  /* One form control for field f of item it (or the profile when it is null). */
  function control(f, v, attr, id) {
    if (f.type === 'select') return '<select ' + attr + '="' + id + '">' + f.options.map(([k, l]) => '<option value="' + k + '"' + (v === k ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>';
    if (f.type === 'bool') return '<span class="tx-switch"><input type="checkbox" ' + attr + '="' + id + '"' + (v ? ' checked' : '') + '></span>';
    const val = f.type === 'pct' ? +(v * 100).toFixed(4) : v, lo = bound(f, 'min'), hi = bound(f, 'max');
    return '<span class="tx-in' + (f.type === 'money' ? ' m' : f.type === 'pct' ? ' p' : '') + '"><input type="number" ' + attr + '="' + id + '" value="' + val + '" step="' + (f.step || 1) + '"'
      + (lo != null ? ' min="' + lo + '"' : '') + (hi != null ? ' max="' + hi + '"' : '') + ' aria-label="' + esc(f.label) + '"></span>';
  }
  /* A labelled field for a strategy input. */
  function field(it, f) {
    const id = it.uid + '.' + f.key;
    return '<label class="tx-f"' + (f.help ? ' title="' + esc(f.help) + '"' : '') + '><span>' + esc(f.label) + '</span>' + control(f, it.inputs[f.key], 'data-tx', id) + msgHtml(id) + '</label>';
  }

  /* Today's worth of a set of runs: every calendar year's net (yearly()) discounted to the
     current year at `rate`. With no rate given, the tab's discount rate. */
  function presentValue(runs, rate) {
    return pvOf(yearly(runs), rate == null ? discountOf(profile()) : rate);
  }

  /* ── THE CARD SENTENCES ────────────────────────────────────────────────── */

  /* The credit, said plainly: what it is worth now, and what can take it away. */
  function solarRead(o, d) {
    let t = '<p class="note key">';
    if (o.late) t += '<b>No credit:</b> a project placed in service after Dec 31, 2027 does not qualify under the 2025 law, so only the depreciation is counted. ';
    else if (o.passive) t += 'As a passive investor the <b>' + short(o.creditAll) + '</b> credit only offsets tax the project itself creates; <b>' + short(o.lostAll) + '</b> of it goes unused here. ';
    else t += 'The <b>' + short(o.creditAll) + '</b> credit and the depreciation save <b>' + short(o.y1Saved) + '</b> in the year you buy, against <b>' + short(o.putIn) + '</b> paid. ';
    if (o.clawAll > 0) t += 'Selling inside 5 years claws back <b>' + short(o.clawAll) + '</b> of the credit. ';
    if (o.cgTaxAll > 0.5) t += 'Selling above the cost less half the credit is a capital gain: <b>' + short(o.cgTaxAll) + '</b> of capital gains tax. ';
    t += 'With the income and the sale, it comes to <b>' + signed(o.net) + '</b> over its life, worth <b>' + signed(o.pv) + '</b> today at ' + pct(d) + ' a year.';
    return t + '</p>';
  }

  /* What a drilling program is, said plainly: real money at risk, with a deduction attached. */
  function oilGasRead(o, d) {
    let t = '<p class="note key">';
    t += o.limited ? 'As a limited partner the <b>' + short(o.y1Ded) + '</b> deduction is passive: it shelters the program’s own income first and the rest waits until production ends. '
      : 'The <b>' + short(o.y1Ded) + '</b> deduction saves <b>' + short(o.y1Saved) + '</b> this year, so the program costs you <b>' + short(o.afterTax) + '</b> after tax. ';
    t += 'The wells then return <b>' + short(o.cashAll) + '</b> of cash before tax at these production assumptions. Over its life that is <b>' + signed(o.net)
      + '</b>, worth <b>' + signed(o.pv) + '</b> today at ' + pct(d) + ' a year. Unlike the other strategies the cash itself is at risk: a dry hole or a price drop moves the result more than the tax does.';
    return t + '</p>';
  }

  /* What the study buys, said plainly: timing, not a smaller tax bill. */
  function costSegRead(c, d) {
    let t = '<p class="note key">';
    if (c.passive) t += 'As a passive investor the extra deduction cannot touch your W-2 income: it waits' + (c.sell ? ' and is released at the sale' : ', and with no sale it is never released here') + '. ';
    else if (c.y1Ded > 0 && c.y1Saved < 1) t += 'The study adds <b>' + short(c.y1Ded) + '</b> of deductions in year one, but the strategies before it have already used that year’s income, so it carries forward to later years. ';
    else t += 'The study adds <b>' + short(c.y1Ded) + '</b> of deductions in year one, saving <b>' + short(c.y1Saved) + '</b>. ';
    t += c.sell ? 'Selling brings <b>' + short(c.owed) + '</b> back as recapture, so the gain is mostly the use of the money in between: '
      : 'Keeping it (or a 1031 exchange) means no recapture, but the extra deduction is given back as smaller deductions over the rest of the ' + c.life + '-year life, so over ' + c.years + ' years it nets to <b>' + signed(c.net) + '</b>'
        + (c.net > 500 ? ', above zero only because the smaller deductions later fall in years taxed at lower rates, such as after you stop work' : '') + '. The gain is the use of the money in between: ';
    return t + '<b>' + signed(c.pv) + '</b> worth today at ' + pct(d) + ' a year.</p>';
  }

  /* The one comparison a Roth conversion turns on, said in a sentence. With other strategies
     in the plan, the fair measure is what the conversion ADDS to the plan: run it with and
     without, same income, and compare at the same discount rate (paired). */
  function rothRead(R, paired) {
    const rateWin = R.laterRate > R.avgNow, win = R.pv >= 0;
    let t = '<p class="note key">You pay <b>' + pct(R.avgNow) + '</b> on the conversions now' + (R.worst > R.avgNow + 0.0005 ? ' (up to ' + pct(R.worst) + ' in the most expensive year)' : '') + ' to avoid <b>'
      + pct(R.laterRate, 0) + '</b> later. Discounted to today at ' + pct(R.discount) + ' a year that is <b>' + signed(R.pv) + '</b>: '
      + (win ? 'converting comes out ahead.' : 'converting comes out behind.');
    if (rateWin !== win) {
      t += ' The rates alone point the other way; the difference is timing: the money grows at ' + pct(R.growth) + ' a year inside the Roth and the later savings are discounted at ' + pct(R.discount) + '. With the two rates equal, the rate comparison decides it.';
    }
    if (paired != null) {
      t += '</p><p class="note key">With your other strategies, the conversion adds <b>' + signed(paired) + '</b> worth today'
        + (paired > R.pv + 500 ? ', ' + short(paired - R.pv) + ' better than on its own, because the deduction absorbs part of the converted income.' : '.');
    }
    return t + '</p>';
  }

  /* ── THE TAB ───────────────────────────────────────────────────────────── */

  const FOCUS_ATTRS = ['data-tx', 'data-txs', 'data-txp', 'data-txg', 'data-txadd'];
  /* The focused control inside host, as [attribute, value], so it can be found again after
     the markup is replaced. */
  function focusKey(host) {
    const doc = host && host.ownerDocument, a = doc && doc.activeElement;
    if (!a || !host.contains || !host.contains(a) || !a.getAttribute) return null;
    for (const k of FOCUS_ATTRS) if (a.hasAttribute(k)) return [k, a.getAttribute(k)];
    return null;
  }

  /* Draw the tab into host. ctx is the app's { book, mode, sheets }. Re-drawing replaces
     host's markup; the control that had focus gets it back. */
  function render(host, ctx) {
    if (!TP()) { host.innerHTML = '<div class="card"><p class="note">The tax models did not load.</p></div>'; return; }
    /* a new book resets every module through the shared hook (includes.js AppState); without
       it (tests, or this file on its own) the tab notices the new book itself */
    if (root.PlanIncludes) root.PlanIncludes.remember(ctx); else syncBook(ctx);
    seedFromSheet(ctx);
    freshen();
    const keepFocus = S.focusNext || focusKey(host); S.focusNext = null;
    const p = profile(), Y0 = nowYear(), d = discountOf(p);
    const income = incomeMap(ctx), stop = stopYearOf(ctx);
    const runs = S.plan.length ? runPlan(income, p) : [];
    const rows = yearly(runs);
    const tot = (k) => runs.reduce((a, r) => a + r.sum[k], 0);
    const f0 = indexOf(p, Y0);
    const baseTI = Math.max(0, p.w2Now - Math.max(TP().STD[p.status], p.persded) * f0);
    const baseTax = taxIdx(baseTI, p.status, f0);
    const marg = (TP().BR[p.status].find((b) => baseTI / f0 > b[0] && baseTI / f0 <= b[1]) || [0, 0, 0])[2];
    const hasDeduction = S.plan.some((it) => !byId(it.id).raisesIncome);
    const pvAll = runs.length ? presentValue(runs, d) : 0;
    const pairedOf = (it) => (hasDeduction ? pvAll - presentValue(runPlan(income, p, S.plan.filter((x) => x.uid !== it.uid)), d) : null);
    const pf = (k) => PROFILE_FIELDS.find((f) => f.key === k);
    const pfield = (k) => { const f = pf(k); return '<label class="tx-f"' + (f.help ? ' title="' + esc(f.help) + '"' : '') + '><span>' + esc(f.label) + '</span>' + control(f, p[k], 'data-txp', k) + msgHtml('p.' + k) + '</label>'; };

    /* 1. your tax picture */
    let h = '<div class="card"><h2>Your Federal Tax Baseline</h2><p class="cap">The income every strategy is measured against'
      + (stop ? ': W-2 until ' + stop + ' (your stop year on Retirement), then ' + (p.retireIncome ? short(p.retireIncome) + ' a year' : 'no income unless you enter some below') : '') + '.</p>'
      + '<div class="tx-row">'
      + '<label class="tx-f"><span>Filing status</span><select data-txp="status"><option value="mfj"' + (p.status === 'mfj' ? ' selected' : '') + '>Married filing jointly</option><option value="single"' + (p.status === 'single' ? ' selected' : '') + '>Single</option></select></label>'
      + pfield('w2Now') + pfield('w2Growth') + pfield('persded')
      + '</div><div class="tx-row">' + pfield('retireIncome') + pfield('bracketIndex') + pfield('discount')
      + '</div><div class="mk-kpis">'
      + kpi('Federal tax this year', short(baseTax), 'with no strategy')
      + kpi('Top bracket', pct(marg, 0), 'each extra dollar deducted saves this')
      + kpi('Effective rate', p.w2Now ? pct(baseTax / p.w2Now) : 'None', 'of W-2 income')
      + '</div><p class="note">Every “worth today” figure on this tab discounts each year’s net to ' + Y0 + ' at <b>' + pct(d) + '</b> a year, the discount rate above. Retirement’s “today’s dollars” is a different measure: it only takes out inflation.</p></div>';

    /* 2. an empty plan says so, and offers a way in */
    if (!S.plan.length) {
      h += '<div class="card tx-empty"><h2>Your Tax Plan Is Empty</h2>'
        + '<p class="cap">Nothing from this tab is in your Retirement plan until you add a strategy.</p>'
        + '<p class="note">Pick one from the library below and set its terms: you will see the tax it saves, the tax it owes back, what investing the savings does, and its effect on retirement.</p>'
        + '<div class="tx-row" style="align-items:center;gap:12px">'
        + '<button type="button" data-txlib style="background:var(--blue);color:#fff">Add a strategy</button>'
        + '<button type="button" class="linkish" data-txadd="hm" title="A $500k equipment purchase with 10% down, leased out and sold back in year 6">Try Heavy Machinery, the worked example</button>'
        + '</div></div>';
    }

    /* 3. the strategy library */
    h += '<div class="card"><h2>Strategy Library</h2><p class="cap">Add one or several. Conversions are counted first, then deductions in the order shown.</p><div class="tx-lib">'
      + STRATEGIES.map((dd) => {
        const n = S.plan.filter((it) => it.id === dd.id).length;
        return '<button type="button" class="tx-card' + (dd.status === 'soon' ? ' soon' : '') + '"' + (dd.status === 'soon' ? ' disabled' : ' data-txadd="' + dd.id + '"') + '>'
          + '<small>' + esc(dd.tag) + '</small><b>' + esc(dd.name) + '</b><span>' + esc(dd.blurb) + '</span>'
          + '<em>' + (dd.status === 'soon' ? 'Coming next' : n ? '✓ In your plan' + (n > 1 ? ' (' + n + ')' : '') + ': add another' : '+ Add') + '</em></button>';
      }).join('')
      + '</div></div>';

    /* 4. one card per strategy in the plan */
    S.plan.forEach((it, i) => {
      const def = byId(it.id), mine = runs.filter((r) => r.uid === it.uid);
      const groups = [];
      def.fields.forEach((f) => { let g = groups.find((x) => x[0] === f.group); if (!g) groups.push(g = [f.group, []]); g[1].push(f); });
      const y1 = mine.reduce((a, r) => a + r.sum.y1TaxSaved, 0), all = mine.reduce((a, r) => a + r.sum.allIn, 0);
      const R = mine[0] && mine[0].roth, CS = mine[0] && mine[0].cs, OG = mine[0] && mine[0].og, SOL = mine[0] && mine[0].sol;
      const pvMine = presentValue(mine, d);
      const valPill = (v, why) => '<span class="pill ' + (v >= 0 ? 'up' : 'bad') + '" title="' + esc(why + ', discounted to ' + Y0 + ' at ' + pct(d) + ' a year') + '">' + signed(v) + ' worth today</span>';
      const pills = SOL
        ? '<span class="pill ok" title="Credit plus the depreciation saving in the year you buy">' + short(SOL.y1Saved) + ' saved, year one</span>' + valPill(SOL.pv, 'Cash in and out plus every year’s tax effect')
        : OG
        ? '<span class="pill ok" title="Tax saved in the year you invest">' + short(OG.y1Saved) + ' saved, year one</span>' + valPill(OG.pv, 'Cash in and out plus every year’s tax effect')
        : CS
        ? '<span class="pill ok" title="Tax saved in the first year by the extra deduction">' + short(CS.y1Saved) + ' saved, year one</span>' + valPill(CS.pv, 'Every year’s difference from not doing the study')
        : R
        ? '<span class="pill bad" title="Ordinary tax on the conversions, paid in the years you convert">' + short(R.paid) + ' tax now</span>' + valPill(R.pv, 'Tax avoided later less tax paid now')
        : '<span class="pill ok" title="Tax saved in the first year, across every repeat">' + short(y1) + ' saved, year one</span>'
          + '<span class="pill ' + (all >= 0 ? 'up' : 'bad') + '" title="Everything added up as the dollars land: tax saved, cash, the sale, less the down payment and tax owed back">' + signed(all) + ' all in</span>'
          + valPill(pvMine, 'The same flows');
      const sid = it.uid + '.startYear', rid = it.uid + '.repeat';
      h += '<div class="card tx-plan"><div class="mk-head"><div><small class="tx-step">Strategy ' + (i + 1) + '</small><h2>' + esc(def.name) + '</h2></div>'
        + '<div class="tx-tags">' + pills + '<button type="button" class="tx-x" data-txdel="' + it.uid + '" title="Remove this strategy">Remove</button></div></div>'
        + '<div class="tx-row"><label class="tx-f"><span>First year</span>' + control(ITEM_FIELDS.startYear, it.startYear, 'data-txs', sid) + msgHtml(sid) + '</label>'
        + '<label class="tx-f" title="' + (def.raisesIncome ? 'Convert the same amount each year, for this many years' : 'Buy the same again each year, for this many years') + '"><span>' + esc(def.repeatLabel || 'Repeat for (years)') + '</span>' + control(ITEM_FIELDS.repeat, it.repeat, 'data-txs', rid) + msgHtml(rid) + '</label></div>'
        + '<div class="tx-groups">' + groups.map(([g, fs]) => '<div class="tx-group"><h3>' + esc(g) + '</h3><div class="tx-row">' + fs.map((f) => field(it, f)).join('') + '</div></div>').join('') + '</div>'
        + (R ? rothRead(R, pairedOf(it)) : '') + (CS ? costSegRead(CS, d) : '') + (OG ? oilGasRead(OG, d) : '') + (SOL ? solarRead(SOL, d) : '')
        + '</div>';
    });

    /* 5. what the plan does */
    if (runs.length) {
      const allIn = tot('allIn');
      /* the effect on retirement, from the same run the Retirement tab shows */
      let eff = null;
      try { eff = root.PlanIncludes ? root.PlanIncludes.effect(ctx, 'tax') : null; } catch (e) { eff = null; }
      const effLine = eff ? '<div class="tx-effect"><span>Effect on retirement</span><b>Never short ' + pct(eff.before, 0) + ' → ' + pct(eff.after, 0) + '</b>'
        + '<b class="' + (eff.endAfter >= eff.endBefore ? 'pos' : 'neg') + '">Change in money left at the end ' + signed(eff.endAfter - eff.endBefore) + '</b>'
        + '<small>in today’s dollars as Retirement counts them (inflation taken out)' + (eff.others.length ? ', with ' + esc(eff.others.join(' and ')) + ' counted' : '') + '</small>'
        + '<button type="button" class="linkish" data-txgo="runway">See it in Retirement</button></div>' : '';
      h += '<div class="card"><div class="mk-head"><h2>Combined Tax Impact</h2></div>'
        + '<p class="cap">Every strategy above, stacked, year by year. Hover a bar for the amount.</p>'
        + effLine
        + '<div class="mk-kpis">'
        + kpi('Tax, first year', (tot('y1TaxSaved') >= 0 ? '' : '+') + short(Math.abs(tot('y1TaxSaved'))), tot('y1TaxSaved') >= 0 ? 'saved, first year of each' : 'more tax, first year of each', tot('y1TaxSaved') >= 0 ? 'pos' : 'neg')
        + kpi('Tax saved, all years', short(tot('cumTaxSaved')), 'net of the extra tax along the way', tot('cumTaxSaved') >= 0 ? 'pos' : 'neg')
        + kpi('Tax owed back at sale', short(-tot('owedBack')), 'tax due when you sell', 'neg')
        + kpi('Cash you put in', short(-tot('down')), 'down payments, fees, prices')
        + kpi('Net, all in', signed(allIn), 'added up as each dollar lands', allIn >= 0 ? 'pos' : 'neg')
        + kpi('Worth today', signed(pvAll), 'every year’s net discounted at ' + pct(d) + ' a year', pvAll >= 0 ? 'pos' : 'neg')
        + '</div>' + chart(rows)
        + (allIn < 0 ? '<p class="note key">Over its life this plan returns less than it costs: the first-year saving comes back as tax later. Its value is moving tax from a high-income year to a later one.</p>' : '')
        + '<details class="more how"><summary>The numbers, strategy by strategy</summary><div style="overflow-x:auto"><table class="mk-tight"><thead><tr><th class="l">Strategy</th><th>Down payment</th><th>Year-1 deduction</th><th>Tax, year one</th><th>Tax saved, all years</th><th>Cash from the deal</th><th>Ends</th><th>Tax owed back</th><th>Net sale</th><th>All in</th></tr></thead><tbody>'
        + runs.map((r) => { const s = r.sum; return '<tr><td class="l mk-strong">' + esc(r.label) + ' (' + r.startYear + ')</td><td>' + money(s.down) + '</td><td>' + money(s.y1Deduction) + '</td><td>' + money(s.y1TaxSaved) + '</td><td>' + money(s.cumTaxSaved) + '</td><td>' + money(s.cash) + '</td><td>' + s.exitYear + '</td><td>' + money(s.owedBack) + '</td><td>' + money(s.netSale) + '</td><td class="b">' + money(s.allIn) + '</td></tr>'; }).join('')
        + '</tbody></table></div><p class="note">Conversions are counted first, so a deduction in the same year offsets them; deductions then follow in the order shown, each measured against the income left after the ones before it, including any recapture an earlier strategy brings in at its sale. Heavy Machinery and Workforce Housing carry a loss bigger than the year can use forward, at most 80% of a later year’s income; the other strategies carry it forward in full. “All in” adds dollars in the year they land, so a Roth conversion’s later, larger dollars look better than they are; “worth today” is the fair figure.</p></details>'
        + '<details class="more how"><summary>What this assumes</summary><p class="note">Federal tax only, 2026 law. Your income: W-2 grows at ' + pct(p.w2Growth) + ' a year' + (stop ? ' until ' + stop + ', your stop year on Retirement; from then on it is ' + (p.retireIncome ? short(p.retireIncome) + ' a year in today’s money' : '$0, so recapture and conversions that land in retirement are taxed from the bottom brackets. Enter your retirement income above to change that') : '') + '. '
        + 'Brackets: Roth conversion, cost segregation, oil and gas and solar index the 2026 brackets, standard deduction and capital gains thresholds by ' + pct(p.bracketIndex) + ' a year; Heavy Machinery and Workforce Housing keep 2026 brackets in every year, as the published tools do, which overstates their later tax when your income grows. The unused part of the standard deduction absorbs new income first. '
        + 'Heavy Machinery and Workforce Housing use a verified port of the published v1.0 and v1.2 models: losses non-passive (you materially participate) and fully at risk; no state tax, NIIT, AMT or QBI. Solar: the 30% credit applies only to projects in service by Dec 31, 2027 (2025 law, for projects starting construction after July 4, 2026); depreciation is on cost less half the credit; selling inside 5 years claws back the unvested credit and adds half of it back to basis; a sale above the cost less half the credit is a long-term capital gain at 0, 15 or 20%; cash purchase, no loan. Oil and gas holds the program to depletion (no sale, no recapture), starts production the year after you invest, and treats depletion as a flat 15% of production cash; a working interest offsets W-2 income, a limited partner’s loss waits. Cost segregation models only the difference from not doing the study: selling compares the years held and recaptures the extra depreciation; keeping runs to the end of the recovery life, where the extra and missing depreciation cancel. The Roth conversion pays its tax from cash outside the IRA, grows the converted money at the same rate either way, and draws it evenly; it ignores required minimum distributions, Medicare surcharges (IRMAA), state tax and the five-year rule. Worth today: every year’s net discounted at ' + pct(d) + ' a year. Tax is counted in the year it is earned. Not tax, legal or investment advice: confirm any strategy with a CPA.</p></details></div>';
    }
    if (runs.length) h += compoundCard(rows, ctx);
    host.innerHTML = h;

    /* wiring */
    const rerender = () => render(host, ctx);
    let pending = null;
    /* re-draw after the event has finished, so a Tab press lands on the next field first and
       that field gets its focus back */
    const later = () => { if (pending) return; pending = setTimeout(() => { pending = null; rerender(); }, 0); };
    const q = (s) => host.querySelector(s), qa = (s) => (host.querySelectorAll ? host.querySelectorAll(s) : []);
    const gs = q('[data-txg]');
    if (gs) {
      gs.oninput = () => { gs.nextElementSibling.textContent = pct(Number(gs.value) / 100, 1); };
      gs.onchange = () => { S.growth = Number(gs.value) / 100; later(); };
    }
    const gr = q('[data-txgreset]');
    if (gr) gr.onclick = () => { S.growth = null; S.focusNext = ['data-txg', '']; rerender(); };
    qa('[data-txgo]').forEach((b) => { b.onclick = () => { const t = document.querySelector('#out [data-tab="' + b.getAttribute('data-txgo') + '"]'); if (t) t.click(); }; });
    const lib = q('[data-txlib]');
    if (lib) lib.onclick = () => { const c = q('.tx-lib [data-txadd]'); if (c) { try { c.scrollIntoView({ block: 'center' }); } catch (e) { /* not in every browser */ } c.focus(); } };
    qa('[data-txadd]').forEach((b) => { b.onclick = () => { const it = addStrategy(b.getAttribute('data-txadd')); if (it) S.focusNext = ['data-txs', it.uid + '.startYear']; rerender(); }; });
    qa('[data-txdel]').forEach((b) => { b.onclick = () => {
      const u = +b.getAttribute('data-txdel'), gone = S.plan.find((x) => x.uid === u);
      S.plan = S.plan.filter((x) => x.uid !== u);
      Object.keys(S.msgs).forEach((k) => { if (k.split('.')[0] === String(u)) delete S.msgs[k]; });
      if (gone) S.focusNext = ['data-txadd', gone.id];
      rerender();
    }; });
    qa('[data-txp]').forEach((el) => {
      el.onchange = () => {
        const k = el.getAttribute('data-txp');
        if (k === 'status') p.status = el.value;
        else { const r = validate(pf(k), el.value, p[k]); p[k] = r.value; if (r.msg) S.msgs['p.' + k] = r.msg; else delete S.msgs['p.' + k]; }
        later();
      };
    });
    qa('[data-txs]').forEach((el) => {
      el.onchange = () => {
        const key = el.getAttribute('data-txs'), [u, k] = key.split('.');
        const it = S.plan.find((x) => x.uid === +u);
        if (!it) return;
        const r = validate(ITEM_FIELDS[k], el.value, it[k]);
        it[k] = r.value;
        if (r.msg) S.msgs[key] = r.msg; else delete S.msgs[key];
        later();
      };
    });
    qa('[data-tx]').forEach((el) => {
      el.onchange = () => {
        const key = el.getAttribute('data-tx'), [u, k] = key.split('.');
        const it = S.plan.find((x) => x.uid === +u);
        if (!it) return;
        const def = byId(it.id), f = def.fields.find((x) => x.key === k);
        const r = validate(f, f.type === 'bool' ? el.checked : el.value, it.inputs[k]);
        it.inputs[k] = r.value;
        const cross = def.fix ? def.fix(it.inputs, k) : null;
        const msg = cross || r.msg;
        if (msg) S.msgs[key] = msg; else delete S.msgs[key];
        later();
      };
    });
    if (keepFocus) {
      const el = q('[' + keepFocus[0] + (keepFocus[1] !== '' ? '="' + keepFocus[1] + '"' : '') + ']');
      if (el && el.focus) el.focus();
    }
  }

  /* ── INVEST WHAT IT SAVES ────────────────────────────────────────────────
     Every one of these strategies moves tax: less now, often more later. What the money does
     in between decides whether that is worth it. compound() follows a side account that
     takes each year's net (tax saved, cash from the deal, the sale, less the money put in and
     the tax owed back) and grows at the chosen rate g, against the same flows left as cash.
     Inputs: rows from yearly(), g as a fraction. Returns null for no rows, else
       { pts: [{ year, net, inv, flat }]  inv_y = inv_(y-1) x (1 + g) + net_y, flat = running sum,
         roots: every break-even rate in [-50%, 100%], ascending (where the account ends at 0),
         ranges: [{ lo, hi, ahead }] the growth rates from 0% to 100% split at the roots,
         be: the break-even rate when there is exactly one, else null,
         rising: true when faster growth helps (the account ends ahead above be),
         signChanges: how often the yearly net changes sign (Descartes: at most that many roots),
         anyNeg, anyPos }.
     The roots are found by scanning the account's end value on a 0.25% grid and bisecting
     every step where it changes sign, rather than with one IRR routine, because a stacked
     plan's net can change sign more than once (money in, saving, tax owed back) and then has
     more than one break-even rate. */
  function compound(rows, g) {
    if (!rows.length) return null;
    const first = rows[0].year, last = rows[rows.length - 1].year;
    const net = {}; rows.forEach((r) => { net[r.year] = netOf(r); });
    const pts = []; let inv = 0, flat = 0;
    for (let y = first; y <= last; y++) {
      inv = inv * (1 + g) + (net[y] || 0); flat += net[y] || 0;
      pts.push({ year: y, net: net[y] || 0, inv, flat });
    }
    const fv = (r) => Object.keys(net).reduce((a, y) => a + net[y] * Math.pow(1 + r, last - Number(y)), 0);
    const flows = pts.map((pt) => pt.net).filter((v) => Math.abs(v) > 0.5);
    const anyNeg = flows.some((v) => v < 0), anyPos = flows.some((v) => v > 0);
    let signChanges = 0;
    for (let i = 1; i < flows.length; i++) if ((flows[i] > 0) !== (flows[i - 1] > 0)) signChanges++;
    const LO = -0.5, HI = 1.0, STEP = 0.0025, roots = [];
    if (anyNeg && anyPos) {
      const n = Math.round((HI - LO) / STEP);
      let a = LO, fa = fv(a);
      for (let i = 1; i <= n; i++) {
        const b = LO + i * STEP, fb = fv(b);
        if (fb === 0) roots.push(b);
        else if (fa !== 0 && fa * fb < 0) {
          let x = a, y = b, fx = fa;
          for (let j = 0; j < 60; j++) { const m = (x + y) / 2, fm = fv(m); if (fx * fm <= 0) y = m; else { x = m; fx = fm; } }
          roots.push((x + y) / 2);
        }
        a = b; fa = fb;
      }
    }
    /* the growth rates a reader can choose, 0% to 100%, split at the roots */
    const cuts = [0].concat(roots.filter((r) => r > 1e-9 && r < HI), [HI]);
    const ranges = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const ahead = fv((cuts[i] + cuts[i + 1]) / 2) > 0, prev = ranges[ranges.length - 1];
      if (prev && prev.ahead === ahead) prev.hi = cuts[i + 1]; else ranges.push({ lo: cuts[i], hi: cuts[i + 1], ahead });
    }
    const be = roots.length === 1 ? roots[0] : null;
    const rising = be != null ? fv(be + 0.01) > 0 : fv(0.10) > fv(0);
    return { pts, be, rising, roots, ranges, signChanges, anyNeg, anyPos };
  }

  /* The break-even sentence for a compound() result at growth g (HTML). It never claims a
     single rate when there are several, and never claims "no break-even" without having
     looked at every rate from 0% to 100%. */
  function compoundText(cp, g) {
    if (!cp) return '';
    const end = cp.pts[cp.pts.length - 1];
    const at = ' At <b>' + pct(g, 1) + '</b> it ' + (end.inv >= 0 ? 'ends <b>' + short(end.inv) + '</b> ahead' : 'ends <b>' + short(-end.inv) + '</b> behind') + ' in ' + end.year
      + ' (left as cash: ' + signed(end.flat) + ').';
    if (!cp.anyNeg) return 'This plan never takes more out than it puts back in any year, so it comes out ahead at any growth rate.';
    if (!cp.anyPos) return 'This plan only costs money in these years; growth cannot rescue it.';
    const ahead = cp.ranges.filter((r) => r.ahead), top = 1.0;
    if (!ahead.length) return 'At every growth rate from 0% to 100% a year this plan ends behind: the side account never climbs back to zero.' + at;
    if (ahead.length === 1 && ahead[0].lo <= 1e-9 && ahead[0].hi >= top) {
      return 'This plan comes out ahead at every growth rate from 0% up, even if what it saves is left as cash (' + signed(end.flat) + ' by ' + end.year + ').' + at;
    }
    if (ahead.length === 1 && ahead[0].hi >= top) {
      return 'This plan saves tax first and pays some back later, so it beats paying the tax as usual if what it frees up grows faster than <b>' + pct(ahead[0].lo, 1) + '</b> a year.' + at;
    }
    if (ahead.length === 1 && ahead[0].lo <= 1e-9) {
      return 'This plan puts money in first and gets it back later, so it beats leaving that money invested only if your investments would grow slower than <b>' + pct(ahead[0].hi, 1) + '</b> a year, its own rate of return.' + at;
    }
    const inner = cp.roots.filter((r) => r > 1e-9 && r < top);
    const span = (r) => (r.lo <= 1e-9 ? 'below ' + pct(r.hi, 1) : r.hi >= top ? 'above ' + pct(r.lo, 1) : 'between ' + pct(r.lo, 1) + ' and ' + pct(r.hi, 1));
    return 'This plan’s yearly net changes direction ' + cp.signChanges + ' times, so it has ' + inner.length + ' break-even rates, '
      + inner.map((r) => '<b>' + pct(r, 1) + '</b>').join(' and ') + ', and no single rate of return. It comes out ahead only when what it frees up grows '
      + ahead.map(span).join(' or ') + ' a year, and behind otherwise.' + at;
  }

  /* The side-account chart (SVG string): invested at g (green) against left as cash (grey). */
  function compoundChart(cp, g) {
    const pts = cp.pts, W = 960, H = 260, L = 64, R = 20, T = 16, B = 30;
    let lo = 0, hi = 0;
    pts.forEach((pt) => { lo = Math.min(lo, pt.inv, pt.flat); hi = Math.max(hi, pt.inv, pt.flat); });
    const pad = (hi - lo) * 0.08 || 1000; lo -= pad; hi += pad;
    const n = Math.max(1, pts.length - 1);
    const xs = (i) => L + i / n * (W - L - R), ys = (v) => T + (hi - v) / (hi - lo) * (H - T - B);
    let s = '<div class="mk-chart"><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Side account over time, invested and not invested">';
    const step = niceStep((hi - lo) / 5);
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + ys(v).toFixed(1) + '" y2="' + ys(v).toFixed(1) + '" stroke="' + (Math.abs(v) < 1e-6 ? '#1D1D1F' : '#E8E8ED') + '"/>'
        + '<text x="' + (L - 8) + '" y="' + (ys(v) + 4).toFixed(1) + '" text-anchor="end" class="ax">' + short(v) + '</text>';
    }
    const line = (k) => pts.map((pt, i) => xs(i).toFixed(1) + ',' + ys(pt[k]).toFixed(1)).join(' ');
    s += '<polyline points="' + line('flat') + '" fill="none" stroke="#8E8E93" stroke-width="2" stroke-dasharray="5 4"/>'
      + '<polyline points="' + line('inv') + '" fill="none" stroke="#34C759" stroke-width="3" stroke-linejoin="round"/>';
    const every = Math.ceil(pts.length / 14), half = (xs(1) - xs(0)) / 2 || 20;
    pts.forEach((pt, i) => {
      s += '<circle cx="' + xs(i).toFixed(1) + '" cy="' + ys(pt.inv).toFixed(1) + '" r="3.5" fill="#34C759" stroke="#fff" stroke-width="1.5"/>';
      if (i % every === 0 || i === pts.length - 1) s += '<text x="' + xs(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" class="ax">' + pt.year + '</text>';
      s += '<rect x="' + (xs(i) - half).toFixed(1) + '" y="' + T + '" width="' + (2 * half).toFixed(1) + '" height="' + (H - T - B) + '" fill="transparent"><title>'
        + esc(pt.year + '\nThis year, net: ' + money(pt.net) + '\nInvested at ' + pct(g, 1) + ': ' + money(pt.inv) + '\nLeft as cash: ' + money(pt.flat) + '\nWhat growth added so far: ' + money(pt.inv - pt.flat)) + '</title></rect>';
    });
    return s + '</svg></div><div class="mk-legend"><span><i style="background:#34C759;height:3px;margin-bottom:3px"></i>Invested at ' + pct(g, 1) + ' a year</span><span><i style="background:#8E8E93;height:2px;margin-bottom:3px"></i>Left as cash</span></div>';
  }

  /* The growth rate the view runs at: the reader's choice, else the Retirement
     Simulator's expected return for these holdings, else 7%.
     Returns { g, own (the reader set it), er (the portfolio's return or null) }. */
  function growthNow(ctx) {
    if (S.growth != null) return { g: S.growth, own: true, er: portfolioReturn(ctx) };
    const er = portfolioReturn(ctx);
    return { g: er != null ? Math.round(er * 1000) / 1000 : 0.07, own: false, er };
  }
  /* The Retirement Simulator's expected return a year, or null when it is not loaded. */
  function portfolioReturn(ctx) {
    try { return root.RunwayUI && root.RunwayUI.expectedReturn ? root.RunwayUI.expectedReturn(ctx) : null; } catch (e) { return null; }
  }

  /* The "If You Invest What It Saves" card (HTML) for yearly() rows. */
  function compoundCard(rows, ctx) {
    const G = growthNow(ctx), g = G.g, cp = compound(rows, g);
    if (!cp) return '';
    let read = compoundText(cp, g);
    read += ' The “worth today” figures above use ' + pct(discountOf(profile()), 1) + ' a year; at that growth rate this view and they agree on ahead or behind.';
    return '<div class="card"><div class="mk-head"><h2>If You Invest What It Saves</h2>'
      + '<label class="tx-slider">Growth a year <input type="range" min="0" max="12" step="0.1" value="' + (g * 100).toFixed(1) + '" data-txg aria-label="Growth a year"><b>' + pct(g, 1) + '</b></label></div>'
      + '<p class="cap">Tax saved today can grow until the tax comes due. A side account takes each year’s net and grows at this rate'
      + (G.own ? (G.er != null ? ' (you set it; <button type="button" class="linkish" data-txgreset>use your portfolio’s ' + pct(G.er, 1) + '</button>)' : '')
        : (G.er != null ? ', set to your portfolio’s expected return from the Retirement Simulator' : ''))
      + '. Hover for each year.</p>'
      + '<p class="note key">' + read + '</p>' + compoundChart(cp, g)
      + '<details class="more how"><summary>How this works</summary><p class="note">Each year’s net is everything the plan moves that year: tax saved, cash from the deal and the sale coming in; the money you put in, extra tax and tax owed back going out. The green line invests that net at the chosen rate (and, when it is negative, takes it from the account), so a year-one saving keeps compounding until the recapture is paid. The grey line keeps the same money as cash. A break-even rate is one where the green line ends at zero. When the plan saves tax first, faster growth helps it; when it puts money in first, the break-even is the plan’s own rate of return and your other investments have to grow slower than that for it to win. When the net changes direction more than once there can be two break-even rates, and the plan wins only between them (or only outside them); this card then says so instead of quoting one rate.</p></details></div>';
  }

  /* For Retirement and the include panel: the stacked plan as dated cash, the same flows the
     chart draws. Returns { [year]: { net, items: [{ label, amount }] } }, or null when the
     plan is empty (so nothing is counted until the reader adds a strategy). */
  function dated(ctx) {
    if (!S.plan.length) return null;
    freshen();
    const rows = yearly(runPlan(incomeMap(ctx), profile()));
    const out = {};
    rows.forEach((r) => {
      const items = PARTS.filter(([k]) => Math.abs(r[k]) >= 0.5).map(([k, l]) => ({ label: 'Tax strategies: ' + l.toLowerCase(), amount: r[k] }));
      out[r.year] = { net: items.reduce((a, x) => a + x.amount, 0), items };
    });
    return out;
  }
  /* A plan item's display name, "Roth conversion ×3" when repeated. */
  function name(it) { const d = byId(it.id); return d.name + (it.repeat > 1 ? ' ×' + it.repeat : ''); }

  /* One KPI tile (HTML). */
  function kpi(l, v, sub, cls) {
    return '<div class="mk-kpi"><small>' + l + '</small><b' + (cls ? ' class="' + cls + '"' : '') + '>' + v + '</b>' + (sub ? '<span>' + sub + '</span>' : '') + '</div>';
  }

  root.TaxStrategies = { STRATEGIES, S, runPlan, yearly, rothRun, costSegRun, oilGasRun, solarRun, addStrategy, presentValue, compound, compoundText, dated, name,
    reset, validate, nowYear, incomeMap, render, PROFILE_FIELDS, ITEM_FIELDS, short, pct };
  root.APP_PLUGINS = (root.APP_PLUGINS || []).concat([{ id: 'tax', label: 'Tax Strategies', after: 'runway', render }]);
  /* This file loads before includes.js, so it registers its reset the way the other early
     modules do: on window.APP_RESET_HOOKS, which AppState.reset() runs on every new book. */
  if (root.AppState) root.AppState.onReset(reset);
  else (root.APP_RESET_HOOKS = root.APP_RESET_HOOKS || []).push(reset);
}(window));
