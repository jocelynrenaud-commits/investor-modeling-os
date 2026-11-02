// The closing sections: gaps, open decisions, the traceability summary and the counts.
export default (K, trace, counts) => {
  let s = '\n---\n\n## 22. Gaps\n\n';
  s += 'Each gap is either a requirement marked **Gap** above, a decision not yet built, or a limit found while writing this RTM. "Ref" points to the requirement or the decision.\n\n';
  s += '| # | Gap | Ref | Kind |\n|---|---|---|---|\n';
  const G = [
    ['Two-tier deal library: every deal term ships to the browser today; the decision is public fields only, private terms used by the math on the server.', 'LIB-008; grill Q4, Q5', 'Decision not built'],
    ['Member-entered deals with a required key-metrics form.', 'WIF-019; grill Q4', 'Decision not built'],
    ['Print or PDF summary of the plan and what-ifs.', 'grill Q3', 'Decision not built'],
    ['"Download my changes" file (session what-ifs as a file the member keeps).', 'grill Q3', 'Decision not built'],
    ['"Download updated spreadsheet" (the tracker with the session changes written back). Only the Equity Curve\'s History CSV exists.', 'grill Q3; EQC-015', 'Decision not built'],
    ['Unsaved-change warning before leaving the page with what-ifs set, and a scenario bar with per-change undo.', 'grill Q2', 'Decision not built'],
    ['Sign-in: none today. Target: sign-in for the two founders\' admin area only; members stay anonymous.', 'DESIGN_SPEC 8', 'Decision not built'],
    ['Tie-out: Overview does not show the totals of the member file beside its own figures.', 'QG-001', 'Owner decision not built'],
    ['Beta gate and agent-driven testing are process requirements with no tracking yet.', 'QG-003, QG-004', 'Owner decision not built'],
    ['Deal terms carry no per-term source or rank; conflicts are not flagged; unconfirmed terms are not labelled "Not confirmed".', 'LIB-009, LIB-010', 'Owner decision not built'],
    ['No offering date or one-week service level for new deals; no deal-intake template.', 'LIB-011, LIB-012', 'Owner decision not built'],
    ['Property net rent and mortgage payment are parsed but never reach the plan; only the sale does.', 'INT-022', 'Gap'],
    ['The tracker template has no Holdings or History tab, though the app reads both.', 'INT-025', 'Gap'],
    ['No manual light or dark switch.', 'DRK-003', 'Gap'],
    ['Chart readouts cannot be opened by touch.', 'MOB-004', 'Gap'],
    ['Compounding (reinvesting preferred returns and exits into new tranches) from the product brief is not in the prototype.', 'brief layer 4', 'Missing feature'],
    ['Deal evaluator or fit score: only the community underwriting score is displayed.', 'brief; LIB-005', 'Missing feature'],
    ['Concentration and unfunded-commitment warning thresholds (single sponsor above 30% or 50%, unfunded above a limit).', 'OVR-013', 'Missing feature'],
    ['Allocation targets, drift and risk rules; a realized income ledger.', '(cross-check)', 'Missing feature'],
    ['Two percent rules disagree on a bare 1: the deal engine reads it as 100%, the public and plan readers as 1%.', 'NUM-002, NUM-003', 'Inconsistency'],
    ['Whole-portfolio statistics class a "Self Storage" deal as Venture, while the deal engine reads it as real estate.', 'OVR-014, DM-006', 'Inconsistency'],
    ['Tax Strategies reads the clock with new Date(), not Engine.calendarNow(), so PD_AS_OF does not pin it.', 'TAX-006', 'Inconsistency'],
    ['Retirement reuses 400 deal futures across 1,200 lifetimes (each three times).', 'RND-004, RTR-010', 'Simplification'],
    ['Public and private futures are independent in Retirement and the Equity Curve, so combined ranges are a little narrow.', 'EQC-009, RND-004', 'Simplification'],
    ['Historical sampling exists in the simulator but is not offered on the tab.', 'RTR-024', 'Not exposed'],
    ['app.js claims a test asserting its real-estate regex equals the engine\'s (E31); no such test is in this folder.', 'DLS-002, DM-006', 'Test gap'],
    ['irrOf classes any stream whose last flow is money going out as a total loss (-100%) before it checks for several sign changes, so -100, +230, -132 (true rates 10% and 20%) reads -100%. A test currently endorses this; decide whether such a stream should be multi-sign.', 'DM-018', 'Finding'],
    ['Many rendering requirements are Partial only because no automated check covers them; each has a TO WRITE test case below.', 'section 24', 'Test gap'],
    ['Tax savings are counted in the year earned, not when the refund arrives the next spring.', 'TAX-010', 'Simplification'],
    ['Federal tax only: no state tax, NIIT, AMT, SE tax or QBI; HM and WFH carry the published tools\' parity-locked limits (2026 brackets, MFJ 35% edge, NOL measured after the standard deduction).', 'HM-001, WFH-001; D2, D4', 'Simplification'],
    ['Deal proceeds are taxed at one commitment-weighted blend, on the whole payout rather than the gain.', 'RTR-022; D7', 'Simplification'],
    ['ux.js renames headings and labels by matching exact text, so a copy change in app.js can silently stop a rename.', 'A11Y-009', 'Fragility'],
  ];
  G.forEach((g, i) => { s += '| G' + (i + 1) + ' | ' + g[0] + ' | ' + g[1] + ' | ' + g[2] + ' |\n'; });

  s += '\n## 23. Open product decisions (D1 to D8)\n\nRaised by the hardening work and logged in the owner\'s grill session; none is decided yet.\n\n';
  s += '| ID | Decision | Today | Requirements affected |\n|---|---|---|---|\n';
  [
    ['D1', 'Taxable income after the stop year on Tax Strategies defaults to $0, which flatters deferral. Default it from the Retirement plan instead?', '$0 (TAX-003)', 'TAX-003, INV-003'],
    ['D2', 'The four in-house tax models index brackets at 2.5%; Heavy Machinery and Workforce Housing stay on 2026 brackets for parity with the published tools. Keep and disclose, or change the published tools and fixtures?', 'Disclosed on the tab (TAX-008)', 'TAX-008, HM-001, WFH-001'],
    ['D3', '"Worth today" (6% discount, Tax Strategies) against "today\'s dollars" (inflation, Retirement): wording and the 6% default.', 'Kept apart and labelled (TDD-003)', 'TAX-015, TDD-001, TDD-003'],
    ['D4', 'Fix the stacking recapture, the MFJ 35% bracket edge and the NOL measured after the standard deduction at the source, in the published tools?', 'Fixed in taxes-ui.js stacking only; the port keeps the tools\' arithmetic', 'TAX-009, HM-002, HM-003'],
    ['D5', 'Community wording in visible copy (for example a library heading that names the community): keep or make generic?', 'Tab label renamed to Deal Library; card heading renamed by ux.js', 'LIB-001, A11Y-009'],
    ['D6', 'The sample household now reads about 32% chance the money lasts and $0 left at the end. Recalibrate the fictional sample (for example a $140,000 target) or keep it?', 'Kept (RTR-008)', 'RTR-008, WIF-010, TAX-012'],
    ['D7', 'Taxable deal proceeds are taxed on the whole payout, not the gain, with one blend for all deals weighted by commitment; per-deal tax needs engine work.', 'One blend (RTR-022)', 'RTR-022'],
    ['D8', 'A bill that cannot be paid before the stop year fails the whole lifetime. Alternative: a separate "could not fund commitments" result.', 'Fails the lifetime (RTR-009)', 'RTR-009, INC-002'],
  ].forEach((d) => { s += '| ' + d.join(' | ') + ' |\n'; });

  s += '\n## 24. Traceability summary\n\nEvery requirement, its test cases, whether an existing check covers it, and its status. Test-case IDs expand in the requirement\'s own block.\n\n';
  s += '| Requirement | Test cases | Coverage | Status |\n|---|---|---|---|\n';
  trace.forEach((t) => { s += '| ' + t.join(' | ') + ' |\n'; });

  const tot = counts.reduce((a, c) => [a[0] + c[1], a[1] + c[2], a[2] + c[3], a[3] + c[4]], [0, 0, 0, 0]);
  const toWrite = trace.filter((t) => t[2] === 'TO WRITE').length;
  s += '\n## 25. Counts\n\n| Section | Requirements | Implemented | Partial | Gap |\n|---|---|---|---|---|\n';
  counts.forEach((c) => { s += '| ' + c.join(' | ') + ' |\n'; });
  s += '| **Total** | **' + tot[0] + '** | **' + tot[1] + '** | **' + tot[2] + '** | **' + tot[3] + '** |\n';
  s += '\nRequirements with at least one mapped existing check: ' + (trace.length - toWrite) + '. Requirements whose test case is TO WRITE: ' + toWrite + '.\n';
  return s;
};
