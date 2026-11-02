# Prototype vs APEX: functionality cross-check (2026-10-28)

This compares the prototype (built on the Financial Planning OS v1.50, plus the whole-portfolio and Tax Strategies tabs) against APEX, the author's private portfolio system. It covers only the investor-modeling features; APEX's options trading machinery, market desks, journals and live Schwab feed are out of scope for this product.

How to read it: **Has it** means the prototype already does what APEX does (or more). **Partial** means part of it is there. **Missing** means APEX has it and the prototype does not, so it's a candidate for the next layer. The last column says where the prototype is ahead of APEX.

| Feature | Prototype | Notes |
|---|---|---|
| Private deal register: import, deal cards, totals | **Has it** | Spreadsheet import, shared deal-term files, KPIs. No add/edit inside the app (APEX has it) |
| Allocation by asset class | **Has it** | |
| Liquidity ladder and exit timing | **Has it** | Same window and spreading rules as APEX |
| Deal model: calls, preferred return, MOIC, IRR | **Has it, and goes further** | Per-deal Monte Carlo ranges; APEX models one path |
| Liquidity outlook, performance and returns | **Has it** | |
| VC sleeve (outcome draws, call drag) | **Has it** | |
| Retirement simulator | **Has it, and goes further** | Any number of sleeves, a spend-mode selector, historical sequences, levers, "what breaks first", a year-by-year ledger. APEX lacks the mode selector |
| Tax on retirement withdrawals | **Has it, and goes further** | Gross-up by account type (pre-tax 22%, taxable 15%, Roth 0). APEX works in pre-tax dollars. Neither has brackets, state tax, RMDs or Roth conversions |
| **Tax plays (WFH, Heavy Machinery)** | **New in the prototype** | Verified port of both published tools (6,145 checks, 0 differences), stackable and repeatable, fed into the retirement simulation. APEX has none |
| **Tax strategy module** | **New in the prototype** (Tax Strategies tab) | Strategy library built to take any strategy; Heavy Machinery, Workforce Housing, Roth conversion, cost segregation, oil and gas and the solar credit live, stackable. APEX has none |
| Capital calls still owed, deducted from the plan | **New in the prototype** (Retirement, on by default) | Neither the Financial Planning OS simulator nor APEX deducts them |
| Test a new deal against the plan | **New in the prototype** (Deal Library) | The deal's own range and its effect on never short and ending wealth; APEX has none |
| Tax savings reinvested over the deal's life | **New in the prototype** (Tax Strategies) | Side account at a chosen growth rate and the break-even rate; APEX has none |
| Compounding (reinvest preferred returns into new tranches) | **Missing** | Exists as a separate published tool and inside APEX; not yet in the prototype |
| Portfolio roles (R-codes) and coverage gaps | **Missing** | APEX: R0-R10 roles, flags an empty income role |
| Concentration and unfunded-commitment flags | **Partial** | Overview shows each holding's share of risk and commitments still to call; no warning thresholds yet. | APEX: single sponsor above 30% warns, above 50% critical; unfunded above $200K warns |
| Allocation targets, drift and risk rules | **Missing** | APEX: theme caps, single-name cap, cash floor, beta |
| Realized income ledger | **Missing** | APEX tracks income actually received; the prototype projects it |
| Plan vs actual (equity curves) | **Has it, and goes further** (Equity Curve tab) | Private accounts get their own cone from the deal-by-deal simulation, not a flat line. A new planned cone each Jan 1 from the Dec 31 balance, as in APEX, actual balance on top, percentile and on/below/ahead status, per account or whole portfolio. Balances recorded in-app download as tracker rows |
| Public holdings detail (positions, cost basis) | **Has it** (Public Markets tab) | Positions by account with gain, expected return, volatility, beta and share of risk; asset types from stocks and ETFs to bonds, gold, commodities and crypto |
| Portfolio statistics feeding the plan | **New in the prototype** | Holdings become Retirement sleeves with their own return, volatility, yield and tax mix, and the sleeves move together (correlated draws). APEX has none of this |
| Deal score and evaluator | **Partial** | Shows the community underwrite score from the deal files; APEX also stores a personal score. Neither has a scoring engine in the app |

## Known limits in the new pieces (for the product review)
1. **The tax math is the published tools' math, unchanged.** Losses are treated as non-passive and fully at risk; no state tax, NIIT, AMT or QBI; the loss carryforward is not applied against the tax owed back in the exit year.
2. **A finding worth discussing:** at the tools' default inputs, one Heavy Machinery play for a household earning $400K nets **-$40,194** over its life (a year-1 saving of $73,468, then taxable lease income and $97,071 of tax owed back at exit). It is a deferral, not a gain, unless the exit or the income picture is different. Workforce Housing behaves similarly at its defaults.
3. **Tax savings are counted in the year they are earned**; refunds really arrive the following spring.
4. **The prototype is a fork:** app.js and engine.js are still byte-identical to the Financial Planning OS, but runway-ui.js has a fictional demo household and exposes its inputs to other tabs.
