/* TAX PLAYS: the Workforce Housing and Heavy Machinery federal tax models, as pure functions.
 *
 * Ported line for line from the two published tools so the numbers match them exactly:
 *   Workforce Housing v1.2  (gc-wfh-tax-model, runModel)
 *   Heavy Machinery  v1.0   (gc-hm-tax-model, runModel, amortYear)
 * Only the DOM readers were dropped; inputs arrive as a plain object instead. The parity test
 * (tests/taxplay_parity.test.mjs, 6,145 checks) runs the original page code beside this port and
 * requires the same output, year by year. DO NOT CHANGE THE ARITHMETIC HERE without changing the
 * published tools and the saved fixtures (tests/fixtures/) in step; a fix that belongs in the
 * prototype goes in taxes-ui.js, which wraps these models (see its runPlan).
 *
 * What is new here, and is not in either tool:
 *   - toDated(): turns one play into calendar-year cash flows for the retirement simulator.
 *   - stack():   runs several plays in order. Each play is measured against the taxable income
 *                LEFT after the plays before it, so two plays in one year cannot both claim the
 *                same income (the standalone tools each assume they are the only play).
 *
 * THE MODEL, IN ONE PARAGRAPH (both plays)
 * You buy an asset (equipment, or a rental unit) mostly with a loan, and deduct its whole price in
 * year one (100% bonus depreciation, s.168(k)) or over a 5-year MACRS schedule. The asset earns
 * lease or rent income, which pays the loan interest (and, for HM, principal). The deduction is a
 * business loss set against W-2 income, capped each year by the excess business loss limit
 * (s.461(l)); the rest becomes a net operating loss carried forward and used against at most 80%
 * of a later year's taxable income (s.172(a)(2)). At the exit the asset is sold: gain up to the
 * depreciation taken is recaptured at ordinary rates (s.1245 for equipment; the published WFH tool
 * treats the unit the same way), gain above the original price is a long-term capital gain at
 * 0/15/20% stacked on top (s.1(h)), and a sale below the adjusted basis is an ordinary s.1231 loss.
 * The loan is paid off from the sale.
 *
 * INPUTS (one object; percent values are fractions)
 *   Shared: status 'mfj'|'single'; persded (personal deductions, the larger of it and the
 *     standard deduction is used); price ($); down (fraction); depMethod 'bonus'|'macrs';
 *     depSched (fraction of price by year, used for 'macrs'); exit (year of the sale, 1-based);
 *     w2 (array of gross W-2 income by model year, index 0 = year 1).
 *   WFH: noteRate, paydown (rent pays down the note), rent ($ a month), fee (management fee, share
 *     of rent), y1f (share of year one rented), residual (sale price $). Horizon 10 years.
 *   HM: noteRate, amortYears, fee (fees in year one as a share of price; or platformFee+origFee),
 *     lease ($ a year), buybackPct (sale price as a share of price), reinvest (unused). Horizon 8.
 *   An exit past the horizon is never reached: no sale, no recapture, no payoff. Callers must
 *   keep exit inside the horizon (taxes-ui.js clamps it).
 *
 * OUTPUT ROWS (res.years[i], one per model year, dollars of that year, unrounded)
 *   gross, sqTI, sqTax       W-2 income, taxable income and tax with no play (status quo).
 *   dep, accumDep, adjBasis  depreciation this year, so far, and the basis left at the exit.
 *   interest, principal, openBal, closeBal   the loan this year.
 *   schedC                   the play's business income (negative = a loss).
 *   eblExcess, negNOL, nol, nolUsed   loss over the EBL cap, loss below zero taxable income, the
 *                            running NOL (HM only) and the NOL used this year.
 *   dealTI, dealTax, taxSav  taxable income and tax with the play; taxSav = sqTax - dealTax
 *                            (negative when the play adds tax).
 *   opsCash (HM) / freeCash (WFH)   cash after the loan and fees (WFH: 0 when rent pays the note).
 *   isExit, proceeds, recapInc, ltcgGain, sec1231Loss, recapTax, ltcgTaxAmt, lossBenefit,
 *   payoff, netSale          the sale. netSale = proceeds - recapTax - ltcgTaxAmt + lossBenefit
 *                            - payoff, so it is AFTER tax. dealTI does NOT include recapInc.
 *
 * Federal only, 2026 brackets (Rev. Proc. 2025-32), never indexed in later years. Not tax advice.
 * Inherited assumptions (from the tools, unchanged): losses are non-passive (material
 * participation, s.469) and fully at risk (s.465); no state tax, NIIT, SE tax, AMT or QBI; the
 * NOL is not applied against exit-year recapture.
 *
 * KNOWN LIMITS (parity-locked, listed so a port does not copy them blindly)
 *   - The MFJ 35% bracket ends at 768,600; Rev. Proc. 2025-32 gives 768,700 (worth about $2).
 *   - The NOL is measured after the standard deduction (negNOL from sqTI), so the deduction is
 *     carried forward as part of the NOL; s.172(d) measures it from income without it.
 *   - stack() hands the next play dealTI + persDed. In the exit year dealTI leaves out recapInc,
 *     so a second play prices its recapture in brackets the first play's recapture already
 *     filled. taxes-ui.js runPlan() does its own stacking and adds the recapture back.
 *   - A year where the play leaves no taxable income hands on exactly persDed, even when the
 *     W-2 income was lower.
 */
(function (root) {
  'use strict';

  /* 2026 ordinary brackets by filing status: [from, to, rate] on taxable income. */
  const BR = {
    mfj: [[0, 24800, .10], [24800, 100800, .12], [100800, 211400, .22], [211400, 403550, .24], [403550, 512450, .32], [512450, 768600, .35], [768600, 1e15, .37]],
    single: [[0, 12400, .10], [12400, 50400, .12], [50400, 105700, .22], [105700, 201775, .24], [201775, 256225, .32], [256225, 640600, .35], [640600, 1e15, .37]],
  };
  /* 2026 standard deduction; s.461(l) excess business loss limit; the taxable income where the
     long-term capital gains rate steps from 0% to 15% and from 15% to 20%; MACRS half-year
     tables (5-year, 7-year, and a 5-year straight-line variant), fractions of basis by year. */
  const STD = { mfj: 32200, single: 16100 };
  const EBL = { mfj: 512000, single: 256000 };
  const CG = { mfj: [98900, 613700], single: [49450, 545500] };
  const MACRS_PRESETS = { m5: [.20, .32, .192, .1152, .1152, .0576], m7: [.1429, .2449, .1749, .1249, .0893, .0892, .0893, .0446], sl: [.10, .20, .20, .20, .20, .10] };

  /* Ordinary federal tax on taxable income ti for status s: the sum over brackets of
     (min(ti, top) - bottom) x rate. 0 for ti <= 0. */
  function tax(ti, s) { if (ti <= 0) return 0; let t = 0; for (const b of BR[s]) if (ti > b[0]) t += (Math.min(ti, b[1]) - b[0]) * b[2]; return t; }
  /* Long-term capital gains tax on `gain` stacked on top of ordinary taxable income baseTI:
     the gain fills the 0% band up to CG[s][0], then 15% up to CG[s][1], then 20%. 0 for a
     gain <= 0. (No NIIT.) */
  function ltcgTax(baseTI, gain, s) {
    if (gain <= 0) return 0; const bp = CG[s]; const tiers = [[bp[0], 0], [bp[1], 0.15], [1e15, 0.20]];
    let lo = Math.max(0, baseTI), rem = gain, t = 0;
    for (const [ceil, rate] of tiers) { if (rem <= 0) break; const seg = Math.max(0, Math.min(ceil, lo + rem) - lo); if (seg > 0) { t += seg * rate; rem -= seg; lo += seg; } }
    return t;
  }

  /* ── Workforce Housing (gc-wfh-tax-model v1.2 runModel, verbatim logic) ── */
  const WFH_DEFAULTS = { status: 'mfj', paydown: false, depMethod: 'bonus', depSched: MACRS_PRESETS.m5.concat([0, 0, 0, 0]),
    persded: 32200, price: 500000, down: 0.20, noteRate: 0.04, exit: 9, residual: 250000, rent: 3194, fee: 0.21, y1f: 0.5 };
  /* Run the Workforce Housing model for 10 model years. inp: see INPUTS above (WFH_DEFAULTS
     fills the gaps when called through runPlay). The note is price x (1 - down) at noteRate,
     interest only unless paydown, in which case the rent's net operating income pays it
     monthly. Rent before the exit: rent x 12 (x y1f in year one), less the management fee.
     Depreciation is capped at the price. Returns { inp, years: rows (see OUTPUT ROWS), note,
     persDed }. Edge: exit past 10 means no sale and the note is never repaid. */
  function runWFH(inp) {
    const s = inp.status, note = inp.price * (1 - inp.down), persDed = Math.max(STD[s], inp.persded), im = inp.noteRate / 12;
    const years = []; let nol = 0, bal = note, accum = 0;
    for (let y = 1; y <= 10; y++) {
      const before = y <= inp.exit, isExit = y === inp.exit, gross = inp.w2[y - 1] || 0;
      const sqTI = Math.max(0, gross - persDed), sqTax = tax(sqTI, s);
      const grossRent = before ? inp.rent * 12 * (y === 1 ? inp.y1f : 1) : 0;
      const fees = grossRent * inp.fee, noi = grossRent - fees;
      let openBal = bal, interest = 0, principal = 0, closeBal = bal;
      if (before) {
        if (inp.paydown && noi > 0) {
          let b = openBal, ia = 0; const pay = noi / 12;
          for (let mo = 0; mo < 12; mo++) { const i = b * im; ia += i; let pr = pay - i; if (pr < 0) pr = 0; if (pr > b) pr = b; b -= pr; }
          interest = ia; closeBal = b; principal = openBal - closeBal;
        } else { interest = openBal * inp.noteRate; closeBal = openBal; principal = 0; }
      }
      bal = closeBal;
      const netRent = noi - interest;
      const freeCash = inp.paydown ? 0 : netRent;
      let dep = before ? ((inp.depMethod === 'macrs') ? inp.price * (inp.depSched[y - 1] || 0) : (y === 1 ? inp.price : 0)) : 0;
      if (accum + dep > inp.price) dep = Math.max(0, inp.price - accum);
      accum += dep;
      const schedC = noi - interest - dep;
      let dealTIpre, nolUsed = 0, eblExcess = 0, negNOL = 0;
      if (schedC < 0) { const loss = -schedC, allowed = Math.min(loss, EBL[s]); eblExcess = loss - allowed; dealTIpre = sqTI - allowed; negNOL = Math.max(0, -dealTIpre); nol += eblExcess + negNOL; }
      else { const tent = sqTI + schedC; nolUsed = Math.min(nol, 0.8 * tent); dealTIpre = tent - nolUsed; nol -= nolUsed; }
      const dealTI = Math.max(0, dealTIpre), dealTax = tax(dealTI, s), taxSav = sqTax - dealTax;
      let recapInc = 0, ltcgGain = 0, sec1231Loss = 0, recapTax = 0, ltcgTaxAmt = 0, lossBenefit = 0, payoff = 0, netSale = 0, adjBasis = 0, accumDep = 0;
      if (isExit) {
        accumDep = accum; adjBasis = Math.max(0, inp.price - accumDep);
        const gain = inp.residual - adjBasis;
        recapInc = Math.max(0, Math.min(gain, accumDep));
        ltcgGain = Math.max(0, inp.residual - inp.price);
        sec1231Loss = Math.max(0, -gain);
        recapTax = tax(dealTI + recapInc, s) - tax(dealTI, s);
        ltcgTaxAmt = ltcgTax(dealTI + recapInc, ltcgGain, s);
        lossBenefit = sec1231Loss > 0 ? (tax(dealTI, s) - tax(Math.max(0, dealTI - sec1231Loss), s)) : 0;
        payoff = closeBal;
        netSale = inp.residual - recapTax - ltcgTaxAmt + lossBenefit - payoff;
      }
      years.push({ y, gross, sqTI, sqTax, grossRent, fees, noi, interest, principal, openBal, closeBal, netRent, freeCash, dep, bonus: dep, accumDep, adjBasis, schedC, nolUsed, eblExcess, negNOL, dealTI, dealTax, taxSav, isExit, recapInc, ltcgGain, ltcgTaxAmt, sec1231Loss, lossBenefit, recapTax, payoff, netSale });
    }
    return { inp, years, note, persDed };
  }

  /* ── Heavy Machinery (gc-hm-tax-model v1.0 runModel + amortYear, verbatim logic) ── */
  const HM_MAXY = 8;
  const HM_DEFAULTS = { status: 'mfj', depMethod: 'bonus', depSched: MACRS_PRESETS.m5.concat([0, 0]), persded: 32200,
    price: 500000, down: 0.10, noteRate: 0.0675, amortYears: 10, fee: 0.03, platformFee: 0, origFee: 0, exit: 6, buybackPct: 0.56, lease: 66300, reinvest: 0.05 };
  /* A level-payment loan of P at annualRate over amortYears, summed by year for heldYears.
     Monthly payment pmt = P x i(1 + i)^n / ((1 + i)^n - 1), i = rate / 12, n = years x 12
     (P / n at 0%). Returns { pmt, years: [{ y, openBal, interest, principal, closeBal,
     payment }] }. A loan paid off early stops charging. */
  function amortYear(P, annualRate, amortYears, heldYears) {
    const im = annualRate / 12, n = Math.max(1, Math.round(amortYears * 12));
    const pmt = im > 0 ? P * (im * Math.pow(1 + im, n)) / (Math.pow(1 + im, n) - 1) : P / n;
    let bal = P; const out = [];
    for (let y = 1; y <= heldYears; y++) {
      let openBal = bal, iy = 0, py = 0;
      for (let m = 0; m < 12; m++) { if (bal <= 0) break; const i = bal * im; let pr = pmt - i; if (pr > bal) pr = bal; iy += i; py += pr; bal -= pr; }
      out.push({ y, openBal, interest: iy, principal: py, closeBal: bal, payment: iy + py });
    }
    return { pmt, years: out };
  }
  /* Run the Heavy Machinery model for 8 model years. inp: see INPUTS above (HM_DEFAULTS fills
     the gaps through runPlay). The loan is price x (1 - down), amortized with amortYear; fees
     (price x fee) are deducted in year one; the lease runs until the exit, when the operator
     buys the equipment back at price x buybackPct. Business income each year is lease -
     interest - depreciation - fees. Returns { inp, years: rows (see OUTPUT ROWS), loanP,
     persDed, pmt, feePct }. Edges: down 1 means no loan; down above 1 gives a negative loan
     (callers must clamp); exit past 8 means no sale. */
  function runHM(inp) {
    const s = inp.status, loanP = inp.price * (1 - inp.down), persDed = Math.max(STD[s], inp.persded);
    const feePct = (inp.fee != null ? inp.fee : (inp.platformFee + inp.origFee));
    const am = amortYear(loanP, inp.noteRate, inp.amortYears, inp.exit);
    const years = []; let nol = 0, accum = 0;
    for (let y = 1; y <= HM_MAXY; y++) {
      const before = y <= inp.exit, isExit = y === inp.exit, gross = inp.w2[y - 1] || 0;
      const sqTI = Math.max(0, gross - persDed), sqTax = tax(sqTI, s);
      const lease = before ? inp.lease : 0;
      const A = before ? am.years[y - 1] : { interest: 0, principal: 0, openBal: 0, closeBal: 0, payment: 0 };
      const interest = A.interest, principal = A.principal, loanPmt = A.payment;
      let dep = before ? ((inp.depMethod === 'macrs') ? inp.price * (inp.depSched[y - 1] || 0) : (y === 1 ? inp.price : 0)) : 0;
      if (accum + dep > inp.price) dep = Math.max(0, inp.price - accum);
      accum += dep;
      const feeDed = (y === 1) ? inp.price * feePct : 0;
      const schedC = lease - interest - dep - feeDed;
      let dealTIpre, nolUsed = 0, eblExcess = 0, negNOL = 0;
      if (schedC < 0) { const loss = -schedC, allowed = Math.min(loss, EBL[s]); eblExcess = loss - allowed; dealTIpre = sqTI - allowed; negNOL = Math.max(0, -dealTIpre); nol += eblExcess + negNOL; }
      else { const tent = sqTI + schedC; nolUsed = Math.min(nol, 0.8 * tent); dealTIpre = tent - nolUsed; nol -= nolUsed; }
      const dealTI = Math.max(0, dealTIpre), dealTax = tax(dealTI, s), taxSav = sqTax - dealTax;
      const opsCash = before ? (lease - loanPmt - feeDed) : 0;
      let recapInc = 0, ltcgGain = 0, sec1231Loss = 0, recapTax = 0, ltcgTaxAmt = 0, lossBenefit = 0, payoff = 0, netSale = 0, adjBasis = 0, accumDep = 0, proceeds = 0;
      if (isExit) {
        proceeds = inp.buybackPct * inp.price; accumDep = accum; adjBasis = Math.max(0, inp.price - accumDep);
        const gain = proceeds - adjBasis;
        recapInc = Math.max(0, Math.min(gain, accumDep));
        ltcgGain = Math.max(0, proceeds - inp.price);
        sec1231Loss = Math.max(0, -gain);
        recapTax = tax(dealTI + recapInc, s) - tax(dealTI, s);
        ltcgTaxAmt = ltcgTax(dealTI + recapInc, ltcgGain, s);
        lossBenefit = sec1231Loss > 0 ? (tax(dealTI, s) - tax(Math.max(0, dealTI - sec1231Loss), s)) : 0;
        payoff = A.closeBal; netSale = proceeds - recapTax - ltcgTaxAmt + lossBenefit - payoff;
      }
      years.push({ y, gross, sqTI, sqTax, lease, interest, principal, loanPmt, openBal: A.openBal, closeBal: A.closeBal, dep, feeDed, accumDep, adjBasis, schedC, nol, nolUsed, eblExcess, negNOL, dealTI, dealTax, taxSav, opsCash, isExit, proceeds, recapInc, ltcgGain, ltcgTaxAmt, sec1231Loss, lossBenefit, recapTax, payoff, netSale });
    }
    return { inp, years, loanP, persDed, pmt: am.pmt, feePct };
  }

  /* The two plays: label, model years, defaults, the model, and which row field is the cash the
     play throws off. */
  const KINDS = {
    wfh: { label: 'Workforce Housing unit', horizon: 10, defaults: WFH_DEFAULTS, run: runWFH, cash: (r) => r.freeCash },
    hm: { label: 'Heavy Machinery', horizon: HM_MAXY, defaults: HM_DEFAULTS, run: runHM, cash: (r) => r.opsCash },
  };

  /* Run one play. `income` maps calendar year -> W-2/ordinary income; the play starts in `startYear`.
     play = { kind: 'hm'|'wfh', startYear, label?, inputs? }; inputs override the kind's defaults
     and w2 is filled from income (negative income read as 0). Returns { play, kind, label,
     startYear, res } where res is the model's output. Throws on an unknown kind. */
  function runPlay(play, income) {
    const K = KINDS[play.kind]; if (!K) throw new Error('unknown tax play: ' + play.kind);
    const inp = Object.assign({}, K.defaults, play.inputs || {});
    inp.w2 = []; for (let i = 0; i < K.horizon; i++) inp.w2.push(Math.max(0, income[play.startYear + i] || 0));
    const res = K.run(inp);
    return { play, kind: play.kind, label: play.label || K.label, startYear: play.startYear, res };
  }

  /* One play -> {calendarYear: {net, items}}. Year 1 pays the down payment; every year adds the tax
     saved and the cash the play throws off; the exit year adds the net sale (proceeds less recapture
     and capital-gains tax, less the loan payoff). Years after exit still carry any NOL tax savings.
     `into` (optional) is an existing map to add to. Each year: { net, items: [{ label, amount }] }.
     Not used by the Tax Strategies tab, which builds its own dated cash (taxes-ui.js dated()). */
  function toDated(run, into) {
    const out = into || {};
    const K = KINDS[run.kind];
    const add = (yr, amt, label) => {
      if (!amt) return;
      const o = out[yr] || (out[yr] = { net: 0, items: [] });
      o.net += amt; o.items.push({ label, amount: amt });
    };
    const inp = run.res.inp;
    add(run.startYear, -(inp.price * inp.down), run.label + ': down payment');
    run.res.years.forEach((r, i) => {
      const yr = run.startYear + i;
      add(yr, r.taxSav, run.label + ': tax saved');
      add(yr, K.cash(r), run.label + ': cash from operations');
      if (r.isExit) add(yr, r.netSale, run.label + ': net sale after recapture and payoff');
    });
    return out;
  }

  /* Several plays in order. Play k sees the taxable income left after plays 1..k-1 (their dealTI,
     grossed back up by the personal deduction), so savings are incremental and never double-count.
     opts = { status, persded } (defaults 'mfj', 32,200) apply to every play unless its inputs say
     otherwise. Returns { runs: [runPlay results], dated: toDated() of them all }.
     Known limit: the exit year's recapture income is not handed on (see KNOWN LIMITS above). */
  function stack(plays, income, opts) {
    const persded = (opts && opts.persded) || 32200;
    const status = (opts && opts.status) || 'mfj';
    let cur = Object.assign({}, income);
    const runs = [], dated = {};
    for (const p of plays) {
      const play = Object.assign({}, p, { inputs: Object.assign({ status, persded }, p.inputs || {}) });
      const r = runPlay(play, cur);
      const persDed = r.res.persDed;
      const next = Object.assign({}, cur);
      r.res.years.forEach((row, i) => {
        const yr = play.startYear + i;
        next[yr] = row.dealTI + persDed;   // the next play's status-quo taxable income = this play's result
      });
      cur = next;
      toDated(r, dated);
      runs.push(r);
    }
    return { runs, dated };
  }

  /* Headline numbers for one run, the same roll-ups the tools show.
     Returns { down (price x down), y1Deduction (year-one depreciation plus fees), y1TaxSaved,
     cumTaxSaved (sum of taxSav), cash (sum of the play's cash), exitYear (calendar), recapTax,
     ltcgTax, netSale (after tax and payoff), allIn = cumTaxSaved + cash + netSale - down }. */
  function summary(run) {
    const y = run.res.years, inp = run.res.inp, K = KINDS[run.kind];
    const exit = y.find((r) => r.isExit) || {};
    const cumSav = y.reduce((a, r) => a + r.taxSav, 0);
    const cash = y.reduce((a, r) => a + K.cash(r), 0);
    return {
      down: inp.price * inp.down, y1Deduction: y[0] ? y[0].dep + (y[0].feeDed || 0) : 0,
      y1TaxSaved: y[0] ? y[0].taxSav : 0, cumTaxSaved: cumSav, cash,
      exitYear: run.startYear + (inp.exit - 1), recapTax: exit.recapTax || 0, ltcgTax: exit.ltcgTaxAmt || 0,
      netSale: exit.netSale || 0, allIn: cumSav + cash + (exit.netSale || 0) - inp.price * inp.down,
    };
  }

  const TaxPlay = { BR, STD, EBL, CG, MACRS_PRESETS, tax, ltcgTax, amortYear, runWFH, runHM, KINDS, runPlay, toDated, stack, summary };
  if (typeof module !== 'undefined' && module.exports) module.exports = TaxPlay;
  root.TaxPlay = TaxPlay;
}(typeof window !== 'undefined' ? window : globalThis));
