# Design Specification, version 0.1

**Product:** My Ultimate Investor Modeling OS (Atlas & Index prototype)
**Baseline:** the prototype in this folder on 2026-11-01 (engine label `v1.51-proto`, tracker columns `v1.8`).
**Reader:** the engineer rebuilding the prototype in React with a test-driven architecture.
**Companions:** `RTM.md` lists every requirement with a worked example, acceptance criteria and test cases; requirement IDs in this document (for example `DM-010`) point there. `REACT_BUILD_PROMPT.md` is the prompt for the build agent.

Sections 1 to 6 describe the prototype as built. Section 7 is the target architecture for the rebuild; items still to be decided are marked **[OPEN]**.

---

## 1. What the product does

A member loads one spreadsheet (their tracker) and sees their whole financial picture in the browser: public holdings, private deals, when private money is likely to come back, the chance their retirement money lasts, and what a tax strategy or a new deal would change. All modelling is deterministic code with seeded randomness; nothing the member uploads leaves the browser.

Ten tabs in five groups (see RTM "Screen order"): Overview, Equity Curve (Portfolio); Holdings (Public markets); Deals, Liquidity Outlook, Returns, Deal Library (Private deals); Retirement, Tax Strategies (Planning); Help (Reference).

---

## 2. Architecture as built

### 2.1 Shape

A static page (`index.html`) and plain script files, no build step, no framework, no server. Each file is an immediately invoked function that attaches one global to `window`. Model files never touch the DOM; UI files write HTML strings into the page. The prototype is a fork of an earlier private-deal app: `app.js` and `engine.js` are kept byte-identical with that live app, so every new tab is added as a plugin and every wording change is made after rendering by `ux.js`.

### 2.2 Script load order

`index.html` loads the scripts in this order. Order matters only where noted.

| # | File | Global | Layer | Role | Why it sits here |
|---|---|---|---|---|---|
| 1 | SheetJS 0.18.5 (CDN) | `XLSX` | library | Spreadsheet parser | Used by app.js only |
| 2 | engine.js | `Engine` (top-level `const`, not a window property) | model | Private-deal model | Everything else reads it at call time |
| 3 | inline | (none) | cache | Refreshes the example book's cache entry | |
| 4 | history.js | `History` | model | 1928 to 2025 annual returns and CPI, block samplers | Before runway.js |
| 5 | markets.js | `Markets` | model | Public-market statistics, household rule, cones | No UI dependency |
| 6 | runway.js | `Runway` | model | Retirement simulator | Reads Engine and History at call time |
| 7 | portfolio.js | `Portfolio` | model | You, Balances, Property, Cashflows, Events tabs; dated cash | |
| 8 | runway-ui.js | `RunwayUI` | UI plugin | Retirement tab | Must register before app.js |
| 9 | taxplay.js | `TaxPlay` | model | Two published federal tax models, ported | |
| 10 | taxes-ui.js | `TaxStrategies` | UI plugin + model | Tax Strategies tab and four tax models | Must register before app.js |
| 11 | includes.js | `AppState`, `PlanIncludes` | state | What the plan includes; the reset hook | Before the plugins that call `AppState.onReset` directly |
| 12 | consider-ui.js | `ConsiderUI` | UI | "What If I Add This Deal?" card | |
| 13 | markets-ui.js | `MarketsUI` | UI plugin | Overview, Equity Curve, Holdings | Must register before app.js |
| 14 | ux.js | `UX` | UI | Post-render layer: names, captions, folds, tab grouping, ARIA, Help cards; mounts the tester | Observes `#out`; waits for DOMContentLoaded |
| 15 | inline | `APP_TAB_LABELS` | config | Renames app.js's own tabs | Before app.js |
| 16 | app.js | (none; test hook `AppIntake`) | UI | Intake, base tabs, the tab bar, hover readouts | Reads `APP_PLUGINS` once, so it must load last |

### 2.3 Plugin contract

A plugin appends `{ id, label, after, render(host, ctx) }` to `window.APP_PLUGINS` before app.js loads. app.js inserts a tab labelled `label` after the tab whose id is `after` (or at the end), and when the tab is open calls `render(host, ctx)` with `host` = the `#tabbody` element; render replaces its contents. Every render calls `PlanIncludes.remember(ctx)` first, so a new book resets all session state before anything is drawn.

Registered plugins: `overview` after `dash`, `curve` after `overview`, `holdings` after `curve` (markets-ui.js); `runway` after `outlook` (runway-ui.js); `tax` after `runway` (taxes-ui.js). app.js's own tabs: `dash`, `outlook`, `perf`, `about`, `universe`. ux.js then regroups the bar into the five areas.

### 2.4 The context object (ctx)

```
ctx = {
  book:   Position[]                  // Engine.buildBook output; a new array object on every load,
                                      // so object identity marks a new book
  mode:   'all' | 'venture' | 'income'// the private-deal sleeve filter
  sheets: { [sheetName]: any[][] }    // every sheet of the workbook as rows of cells; {} for the example book
}
```

The same ctx is dispatched as `window` event `privatedeals:book` on every successful load.

### 2.5 Data flow

```
 file (.xlsx/.csv)                 example-book.json
      |  FileReader + XLSX.read          |
      v                                  v
 readWorkbook: sheets{} (all)  ---> rows[] (first sheet with a name + commitment header)
      |                                  |
      |                     enrich: matchDeal(name, deals/index.json)
      |                             applyDealFile(row, deals/<slug>.json)   (blanks filled, overrides recorded)
      |                                  |
      |                     validate(rows) -> problems[]
      |                     Engine.buildBook(rows) -> book (Position[]), warnings
      |                                  |
      +------------- ctx = { book, mode, sheets } ------------------------------+
      |                                  |                                       |
      v                                  v                                       v
 Markets.load(sheets)          Engine.simulate(book, 6000, irr)          Portfolio.build(sheets, book)
  Balances > Holdings > sample   -> Deals, Liquidity Outlook, Returns      -> You, Balances sleeves,
  -> Overview, Holdings,         Engine.pathDraws -> Markets.privateCone      dated cash (Property sale,
     Equity Curve                   -> Equity Curve (private)                 Cashflows, Events)
  Markets.toSleeves(holdings)                                                     |
      |                                                                           |
      +---------------------> RunwayUI.baseConfig(ctx) <--------------------------+
                               C = sample <- holdings sleeves <- You <- Balances <- sliders
                               runCfg = C + dealSim (Engine.simulate, 400 paths, capturePaths)
                                          + dated + dealTax (commitment-weighted mix)
                                         |
                       PlanIncludes.config(ctx, include switches, candidate deal)
                         + TaxStrategies.dated(ctx)   (tax strategies as dated cash)
                         + callsDated(book)           (capital calls still owed)
                         + the considered deal's paid-in, calls and simulated proceeds
                                         |
                                         v
                              Runway.simulate(runCfg, 1200 lifetimes)
                       -> Retirement; effect() for Tax Strategies; preview() for the Deal Library
```

### 2.6 Module responsibilities

| Module | Owns | Must not |
|---|---|---|
| engine.js | Building positions from rows (with corrections), deal-file matching and enrichment, call and preferred schedules, outcome tables, seeded per-deal streams, the Monte Carlo, IRR | Touch the DOM, read the network, read anything but the clock (`calendarNow`, pinned by `PD_AS_OF`) |
| history.js | Historical series and block samplers | Know about sleeves beyond the series map |
| markets.js | Asset classes, factor model, holding and portfolio statistics, sleeves and correlations, the household rule, cones, reading Holdings and History tabs, private holdings at paid in | Draw anything |
| runway.js | The retirement simulation, levers, the median trace, diagnose | Know whose money it is |
| portfolio.js | Reading You, Balances, Property, Cashflows, Events; the join of deals and balances by account; dated cash | Read Holdings layouts (left to markets.js) |
| taxplay.js | The two published tax models, unchanged arithmetic (parity-locked) | Change arithmetic without the published tools and fixtures |
| taxes-ui.js | The strategy definitions, four in-house tax models, stacking, the tab, the side-account analysis, the hand-off as dated cash | |
| includes.js | What the plan includes, the run/effect/preview API, deal validation, the shared reset hook | Render |
| runway-ui.js | The Retirement tab and the config layering; exposes `RunwayUI` for other tabs | |
| markets-ui.js | Overview, Holdings, Equity Curve | |
| consider-ui.js | The deal tester card | Change the plan except through `PlanIncludes.consider` |
| app.js | Intake, validation messages, the base private-deal tabs, the tab bar, hover readouts, release notes | Model anything (it calls Engine) |
| ux.js | Copy, captions, folds, tab grouping and ARIA, Help cards, mounting the tester | Change a number |

### 2.7 State ownership and reset

Nothing is stored anywhere: no server, no browser storage (RTM `STA-001`). A reload starts clean.

| Owner | Session state | Cleared by |
|---|---|---|
| app.js | `BOOK`, `SHEETS`, `MODE`, `DIST`, `TAB`, `OPEN`, `DEALSORT`, `LASTMAP`, `UNMATCHED`, deal index cache (a failed fetch is never cached) | Replaced on each successful load |
| PlanIncludes | include switches `S = {tax, calls, deal}`, `considered` deal, `lastCtx` | `AppState` reset |
| ConsiderUI.S | slug, commitment, paid, year, account, result, busy, seq, errors (keeps a loaded deal list) | `AppState` reset |
| MarketsUI.S | account filter, sort, scope, horizon, plan year, monthly addition, recorded balances, risk view, Start Here hidden, flash | `AppState` reset |
| TaxStrategies.S | plan items, baseline profile, growth override, messages | `AppState` reset |
| RunwayUI | `LIVE` slider and button overrides, last headline | `APP_RESET_HOOKS` and its own new-book check |

`AppState` (includes.js) is the single reset hook. `AppState.onReset(fn)` registers `fn(reason)` and returns an unregister function; a module that loads before includes.js pushes onto `window.APP_RESET_HOOKS` instead. `AppState.noteBook(ctx)` resets everything once when `ctx.book` is a different object from the last one seen (the first book resets nothing). A hook clears only its own state, must not render, and one failing hook does not stop the others (`STA-002`, `STA-003`).

### 2.8 The UX layer

ux.js runs on every DOM mutation of `#out` (as a microtask, idempotent, with its own observer paused while it edits): shrink the drop zone, land on Overview for a new book, group the tab bar with the ARIA tab pattern, set the page title from the tab label, add one-line captions and "How to read this" folds, rename headings (original kept in `data-orig`) and labels (`Still to pay in`, `Paid in`, `Chance the money lasts`), remove em and en dashes, add hover readouts and aria-labels to chart marks, add the Help cards, and mount the deal tester. It matches copy by exact text, so in a port all of it becomes ordinary component copy and the observer disappears.

---

## 3. Inputs and outputs at a glance

| Input | Where it comes from | Read by |
|---|---|---|
| Positions sheet | Member's tracker (required for a book) or `example-book.json` | app.js, engine.js |
| You, Balances, Property, Cashflows, Events sheets | Member's tracker, optional | portfolio.js (Balances also by markets.js) |
| Holdings, History sheets | Member's tracker, optional | markets.js |
| Deal library | `deals/index.json` and `deals/<slug>.json`, shipped with the site | app.js, engine.js, consider-ui.js |
| Clock | Browser time, or `PD_AS_OF` / `CFG.asOf` in tests | engine.js `calendarNow`; others call `new Date()` (see RTM gap list) |

| Output | Form |
|---|---|
| Every figure and chart | Rendered HTML and inline SVG |
| Balance history recorded in the session | CSV download (`Date,Account,Balance,Net flow`) |

---

## 4. Data model

### 4.1 The tracker

A sheet is recognised by its columns, never its name; a sheet claimed by one tab type is not re-read as another (`INT-016`). Header matching is lower-case and trimmed, and a header is claimed by the first unclaimed field whose alias it equals or starts with, so the order of fields below is part of the contract (`INT-004`).

**Positions** (one row per private deal; header row = first of the top 12 rows with a name column and a commitment column). Field order and aliases, exactly as `app.js:FIELDS`:

| Field | Aliases (in order) | Type and rule |
|---|---|---|
| deals | deals in fund, underlying deals, number of deals, portfolio companies, positions in fund, deal count | integer; blank = 1 (not diversified); 20+ = diversified table for venture |
| vehicle | fund or single, fund / single, vehicle, fund?, structure | text; fund/pool/syndicat/portfolio = fund; single/spv/one/direct/company = single |
| liqFrom | liquidity from, payout from, sell-down from, distributions from | fund-years from funding |
| liqTo | liquidity to, payout to, sell-down to, distributions to | fund-years from funding |
| name | deal name, deal, name, investment, position | required; rows named "Total..." skipped |
| accountType | account type, account kind, registration type, tax treatment | text |
| account | account, held in, custodian, wrapper, registration | text; decides the private account (RTM `OVR-015`) |
| assetClass | asset class, class, type, sleeve type | text; decides real estate and the private class |
| commitment | commitment, committed, total commitment | required, dollars > 0 |
| yearFunded | year funded, funded year, vintage, year | integer; blank = this year |
| funded | funded to date, funded, paid in, contributed | dollars, clamped 0..commitment |
| uncalled | uncalled, unfunded, remaining, callable | dollars, clamped 0..commitment - funded |
| nextCallDate | next call date, next capital call date, call date, next call expected, expected call date | any spelling with a year |
| nextCallAmount | next call amount, next capital call amount, call amount, next call size | dollars |
| hold | hold, hold (yrs), hold years, term, fund life, horizon | years; <= 0 or blank = 10 |
| coupon | coupon, coupon %, preferred return %, preferred return, preferred, pref, pref % | percent field (NUM-002) |
| markedUpMoic | marked up moic, marked-up moic, markup moic, marked up multiple, moic (marked up), moic marked up, current moic, paper moic | multiple; display only |
| moic | sponsor moic, moic, multiple, expected moic, target multiple | multiple; negative ignored |
| conviction | conviction, confidence | text; default Medium |
| thesis | thesis, why i did it, rationale, notes, my notes | text; never from a deal file |
| exitEarliest | exit: earliest, earliest, exit earliest | calendar year; display and window note |
| exitLikely | exit: likely, likely, exit likely, override likely | calendar year; default funded year + hold |
| exitLatest | exit: latest, latest, exit latest | calendar year; display |

Also read by the engine when a deal file supplies them (no tracker column today): `callPctPerYear`, `uncalledYieldPct`, `uncalledYieldUntil`, `ltv`.

**You** (label and value pairs, at least two recognised labels; the sheet with the most matches wins): birth year; planned stop work year; plan to age; annual spend target; floor spend (must-have); inflation until stop; inflation after stop; benefit start age; estimated annual benefit. Money in today's dollars; inflation by the percent rule (NUM-003).

**Balances** (header with a value column and an account column and no symbol column): Account type, Account, Sleeve, Label, Value, Cost basis, Yield, Expected return, Volatility, As of. A row needs value > 0 and an account. A blank percent cell is null (use the model default), never 0 (`INT-018`). Sleeve names map to growth, income, bonds or cash (`INT-019`); the tax bucket comes from the account name and type (`INT-020`).

**Property** (value and sell year): Property, Value, Mortgage balance, Rate, Payment / mo, Net rent / mo, Sell in year, Cost to sell (default 6%). Only the sale reaches the plan today (`INT-022`, a gap).

**Cashflows** (amount and starts): Label, Amount / yr (positive in), Starts, Ends (blank = the plan horizon), Inflates (default yes), Account.

**Events** (amount, year and label; skips sheets claimed by Balances, Property or Cashflows): Label, Year, Amount (positive in), Account.

**Holdings** (symbol and quantity or value): Symbol, Name, Account type, Account (default Brokerage), Asset class, Quantity, Price, Market value, Cost basis, Beta, Expected return, Volatility, Yield.

**History** (date and value, rejecting headers that also name label, sleeve, symbol, yield, expected return, holding or cost basis; a sheet named History tried first): Date, Account (blank = all public accounts), Balance, Net flow.

### 4.2 The deal file

One JSON file per deal in `deals/`, plus `deals/index.json`. Rates are decimals. Fields the engine reads are marked **math**; everything else is display copy.

| Field | Type | Use |
|---|---|---|
| slug | string | **math**: identity and the group key for shared fate |
| name | string | display, matching |
| aliases | string[] | matching (`DM-020`) |
| sponsor | string | display (public tier) |
| assetClass | string | **math**: real estate test, private class |
| vehicle | string | **math**: fund or single |
| singleCompany | boolean | **math**: forces single |
| subStrategy, structure | string | display |
| dealsInFund | integer or null | **math**: diversification (public tier as "underlying deals") |
| liquidity | { fromYear, toYear, source } or null | **math**: payout window in fund-years |
| terms.couponPct | number | **math**: preferred return; makes the deal "income" |
| terms.holdYears | number | **math**: hold (public tier) |
| terms.sponsorMoic | number or null | **math**: sponsor multiple (public tier) |
| terms.callPctPerYear | number | **math**: call pace |
| terms.uncalledYieldPct, terms.uncalledYieldUntil | number | **math**: yield on uncalled capital and its end (decimal year) |
| terms.ltvPct (alias terms.ltv) | number | **math**: real-estate leverage |
| terms.minimum | number | display (public tier) |
| terms.mgmtFee, carry, ubtiDrag, equityKicker, and other terms | mixed | display |
| terms.*Note | string | display footnotes |
| tiers | { basis: 'commitment' or 'class', bands: [{ label, min, max, terms }] } | **math**: a band's terms replace terms.* when basis is commitment |
| provisional | boolean | display: under review |
| uwScore | number | display: community underwriting score |
| keyRisks, notes, sections [{ title, body }], trackRecord, holdings.companies, and others | mixed | display |
| asOf, source, _about | string | provenance |

Across the 22 shipped files, the top-level fields in use are: slug, name, aliases, sponsor, assetClass, vehicle, subStrategy, terms, liquidity, dealsInFund, singleCompany, structure, sections, source (all files); asOf, keyRisks, uwScore, _about, provisional, modelFit, variesByHolder, variesNote, liquidityNote, tiers, spvFeeDetail, greenFlags, keyFacts, discrepancy, uwScoreNote, notes (several files); and about twenty one-off fields. The terms block uses about sixty keys, of which the engine reads seven (above).

`deals/index.json`: `{ about, asOf, deals: [{ slug, name, aliases, assetClass, vehicle, sponsor }], reserved: [names that must resolve to nothing], reservedNote }`.

### 4.3 Position (one book row)

From `Engine.buildBook`. Units: dollars, years, decimals.

```
name, account, kind ('income' | 'venture'), cls (asset class), ltv,
commitment, funded, uncalled, coupon, hold, fy (year funded), moic,
exitMult            residual multiple (moic - coupon x hold, floor 0.2) for coupon payers
nextCallYear, nextCallAmt, nextCallRaw, callPctPerYear, uncalledYieldPct, uncalledYieldUntil,
deals, isFund, diversified,
branches            outcome table [[p, v, absolute?]], top branch implicit = sponsor case
scales              true when v scales the exit multiple
liq, spread         window [from, to] in fund-years; [[offset from likely year, weight]]
moicAssumed, moicGiven, markedUpMoic, paperNav,
deal (the matched file), groupKey (slug, or 'name:' + lower-case name),
overrides [{ key, label, fmt, yours, shared }], tier, tierUnresolved,
thesis, conviction, earliestTyped, liqStated, earliest, likely, latest,
warnings: string[]
```

### 4.4 Simulation result

From `Engine.simulate(book, { paths = 6000, seed = 20260922, capturePaths, irr })`:

```
years: number[]                                   this year .. last payout year
byYear: [{ year, coupon (median paid), couponScheduled, calls, med, odds, p90 }]   per year, not addable
cum:    [{ year, p10, p50, p90 }]                 cumulative, ranked on whole futures, addable down
hist (40 bins over 0..4x of committed), histBins, histMax
pathRows: [path][yearIndex] cash                   only with capturePaths
totals: { committed, funded, uncalled, coupon, couponScheduled, couponP10, calls,
          p10, p50, p90, mean, stackedP90, shareAtCap }
ties: boolean                                      cum last p50 equals totals.p50
irr (only with irr): { portfolio {p10,p50,p90,defined,paths}, byCash {p10,p50,p90},
       byClass { income, venture }, byDeal [{ name, kind, commitment, sponsorMoic, sponsorCase,
       hold, lossShare, flags, p10, p50, p90, defined, paths }], flags, paper }
```

### 4.5 Public-market shapes

```
holding = { symbol, name, cls, account, acctType ('preTax'|'roth'|'taxable'), qty, price,
            value (> 0), cost | null, beta | null, mu | null, sd | null, y | null,
            st: { mu, sd, y, L[5], e2, beta }, gain | null,
            isPrivate?, uncalled?, commitment?, fromBalances? }
Markets.load(sheets) = { holdings, history: [{ date 'YYYY-MM-DD', account, value, flow }],
            isDemo, asOf, source ('balances'|'holdings'|'sample'), sheet, notes: string[] }
sleeve  = { id, label, kind ('growth'|'income'|'bonds'|'cash'), balance, mu (price return),
            sd, yield, taxMix { preTax, taxable, roth }, account? }
corr    = { [sleeveId]: { [sleeveId]: rho } }
cone month = { sorted: Float64Array, p5, p25, p50, p75, p95 }
```

### 4.6 Retirement simulator config and result

```
cfg = { birthYear, stopYear, planToAge, thisYear,
        spend, floorSpend, benefitAnnual (today's dollars), benefitAge,
        inflPre, inflPost, mode ('fixed'|'guard'|'floor'), guard [[cover, share], ...],
        sleeves: sleeve[], corr?, dated?: { [year]: { net, items: [{ label, amount, inflates? }] } },
        dealSim? (Engine.simulate with capturePaths), dealTax? (rate or mix),
        tax { on, preTax 0.22, taxable 0.15, roth 0, benefitShare 0.85 },
        drawOrder ('safe-first'|'proportional'|'growth-first'), rebalance ('annual'|'none'),
        sampling ('normal'|'historical'|'sequence'), blockYears, paths, seed, trace, traceAt }

result = { neverShort (0..1), share, fullYears, worstRun,
           terminal { p10, p50, p90 } (nominal),
           byYear [{ age, year, need, wealth {p10,p50,p90}, from { benefit, dated, deals, <sleeveId> } }],
           curve [{ year, age, phase, p10, p50, p90, index }],
           preStop { n, share, gapP50 } | null,
           breaks { n, share, ageP10, ageP50, gapP50, dryAgeP50, empty [{ what, n, share }] } | null,
           trace?, traceRunup?, terminalByPath, tax { ..., bySleeve [{ label, rate, mix }] },
           sleeves, stopYear, hasDeals, correlated, corrRejected, sampling, drawOrder, rebalancing }
```

Defaults (`Runway.DEFAULTS`): born 1975, stop 2040, plan to 92, spend 180,000, floor 120,000, inflation 3.5% before the stop year and 3% after, benefit 40,000 from 67, guardrails, 2,000 paths, seed 20260929. The Retirement tab overrides these with its fictional sample household (born 1972, stop 2035, spend 200,000, floor 160,000, benefit 42,000) and runs 1,200 lifetimes.

### 4.7 Tax strategy shapes

```
strategy definition = { id, name, tag, blurb, status ('ready'|'soon'),
        kind ('hm'|'wfh', a TaxPlay model) | run(item, income, profile),
        defaults, fields [{ key, label, type ('money'|'pct'|'int'|'select'|'bool'), group,
        min, max, step, help, options? }], fix?(inputs, key), raisesIncome?, repeatLabel?, repeatDefault? }
plan item = { uid, id, startYear, repeat (1..20), inputs }        percents stored as fractions
profile   = { status 'mfj', w2Now 400000, w2Growth 0.03, persded 32200, retireIncome 0,
              bracketIndex 0.025, discount 0.06 }
Run = { label, startYear, uid,
        years [{ year, down (<=0), saved (>=0), extra (<=0), cash, sale (>=0), owed (<=0) }],
        sum { down (positive), y1Deduction, y1TaxSaved, cumTaxSaved, cash, exitYear,
              owedBack (positive), netSale, allIn },
        roth | cs | og | sol: strategy-specific block }
```

### 4.8 Plan includes shapes

```
deal (considered) = { name, commitment (> 0), paid (0..commitment, dollars at close),
                      year (this year .. this year + 10), account, book: Position[], slug }
effect / preview  = { before, after (chance the money lasts), endBefore, endAfter
                      (money left at the end, typical lifetime, today's dollars), others: string[] }
```

---

## 5. The models

### 5.1 Public-market statistics (markets.js)

**Asset classes.** Long-run assumptions, a year (mu = expected total return, sd = volatility, y = income yield, f = share of variance from each shared driver):

| Class | Group | mu | sd | y | Driver shares |
|---|---|---|---|---|---|
| US stocks | stocks | 7.0% | 16% | 1.3% | equity 0.95 |
| US growth and tech | stocks | 8.0% | 22% | 0.6% | equity 0.85 |
| International stocks | stocks | 7.5% | 18% | 3.0% | equity 0.70 |
| Single stocks | stocks | 3.5% + beta x 3.5% | sqrt((beta x 16%)^2 + 28%^2) | 0.5% | single-index model |
| Dividend and covered-call | income | 7.0% | 13% | 4.5% | equity 0.75 |
| High yield and credit | income | 6.0% | 9% | 6.8% | equity 0.45, credit 0.30, rates 0.05 |
| Core bonds | bonds | 4.5% | 6% | 4.2% | rates 0.85, equity 0.02 |
| Long Treasuries | bonds | 4.5% | 13% | 4.6% | rates 0.95, equity -0.03 |
| Inflation-linked bonds | bonds | 4.0% | 6% | 3.5% | rates 0.50, real 0.20 |
| REITs | real | 6.5% | 20% | 3.8% | equity 0.50, rates 0.05 |
| Gold and silver | real | 4.0% | 15% | 0% | real 0.35, rates 0.05 |
| Commodities | real | 3.5% | 17% | 0% | real 0.50, equity 0.10 |
| Crypto | alts | 8.0% | 60% | 0% | crypto 0.70, equity 0.15 |
| Cash and T-bills | cash | 3.5% | 0.5% | 3.5% | none |
| Private credit | private | 9.0% | 8% | 8.0% | credit 0.30, equity 0.15 |
| Private real estate | private | 8.0% | 12% | 4.0% | equity 0.20, rates 0.10 |
| Private equity | private | 11.0% | 22% | 0% | equity 0.50 |
| Venture | private | 12.0% | 45% | 0% | equity 0.30, crypto 0.03 |

**Factor model.** Loading L_k = sign(f_k) sqrt(abs(f_k)); own variance share e2 = 1 - sum L_k^2. Portfolio variance = sum_k (sum_i w_i sd_i L_ik)^2 + sum_i (w_i sd_i)^2 e2_i; this is positive semi-definite by construction, so the correlation matrix is always valid. Beta = sd x L_equity / (0.16 x sqrt(0.95)). Risk contributions sum to 1 (`HLD-007`). Sharpe = (mu - 3.5%) / sd. Diversification ratio = sum(w sd) / sd. Effective holdings = 1 / sum w^2.

**Lognormal year.** s^2 = ln(1 + sd^2 / (1 + mu)^2), m = ln(1 + mu) - s^2 / 2; typical = exp(m) - 1; 1-in-20 bad and good = exp(m -/+ 1.645 s) - 1; P(down) = Phi(-m / s) (`OVR-011`).

**Sleeves for the plan.** One per group; price return = group mu - group yield; tax mix by value; rho_ab = F_a . F_b / (sd_a sd_b) (`HLD-010`, `HLD-011`).

**Cones.** Public: monthly lognormal, 2,000 paths, seed 20261028 + plan year, optional monthly addition (`EQC-007`). Private: replay of the deal futures valued monthly (`EQC-008`). Whole: path-by-path sum (`EQC-009`).

**Simplifications and limits.** Assumptions are opinions in the range of published 10-year forecasts. Private deals enter the whole-portfolio statistics at paid in with a class assumption, not the deal model. Public and private cones are independent, so the combined range is a little narrow. A typed return, yield or volatility overrides the class; an implausible one is flagged but used.

### 5.2 The private-deal model (engine.js)

**Outcome tables** (probability, multiple; the omitted top branch is the sponsor case, the residual exit multiple):

| Table | Branches | Scales the sponsor case? | Used for |
|---|---|---|---|
| venture | 30% at 0, 30% at 1.00x, 30% at 1.65x, 10% sponsor | no (absolute) | single venture deal |
| income | 5% at 0, 25% at 60%, 55% at 75%, 15% sponsor | yes | any deal paying a preferred return |
| reEquity | 10% at 0 (absolute), 30% at 0.70x (absolute), 45% at 75% of sponsor, 15% sponsor | upside only | real estate with no preferred return; zero weight moved by LTV (4% at 50%, 10% at 65%, 20% at 80%) |
| fundVenture | 10% at 18%, 15% at 25%, 25% at 38%, 25% at 56%, 15% at 76%, 10% sponsor | yes | venture fund of 20+ deals |

**Timing.** Offset from the likely exit year: 20% at -3, 50% at 0, 25% at +2, 5% at +4. A fund pays across its window with ramped weights (2, 3, 4, ...), normalised. Nothing lands in a year already gone; past tranches are renormalised onto the years ahead (`DM-009`).

**Calls.** Deterministic: a stated next call, then a known pace, else an even three-year spread from the year after funding, never in time already gone (`DM-010`).

**Preferred return.** On capital called by each year, plus a yield on uncalled capital until it expires (`DM-011`); impaired by the outcome drawn for that future: 25% paid on a write-off, 70% well below plan, 90% below plan, 100% at or above (`DM-012`).

**Monte Carlo.** 6,000 futures; for each future and each deal group, two draws from that group's own seeded stream (timing, then outcome); tranches of one deal share them (`DM-015`, `RND-002`). Exit cash = commitment x multiple. Per-year cash is summed per future, so cumulative percentiles rank whole futures (`DM-017`).

**IRR.** Money-weighted, cash only (no marks), bisection on [-99.99%, 1000%], with flags instead of false numbers; the portfolio rate is solved on pooled flows per future, never averaged (`DM-018`, `DM-019`).

**Simplifications and limits.** Annual calendar. Calls and preferred returns are deterministic; only exit timing and outcome are random. Deals are independent of each other and of public markets. No tax, no fees beyond what a sponsor multiple nets, no recallable capital. Outcome tables are judgements kept in `CFG`. A bare number above 1 in a percent field is read as percent, so a real rate above 100% must carry a % sign. See the RTM gap list for the IRR classification finding.

### 5.3 The retirement simulator (runway.js)

**One lifetime.** From this year to the stop year (saving years): dated money in is added to the first sleeve, money out is paid from principal in the draw order with the tax gross-up (unpaid > $1 fails the lifetime), deal proceeds are reinvested, every sleeve grows by (1 + yield)(1 + price), then rebalance. From the stop year to the plan age (drawing years): the year asks for the target, the floor, or the guardrail-trimmed target (coverage bands 12 -> 100%, 9 -> 90%, else 80%), plus any bills; it is paid by the benefit after tax, dated money in, deal proceeds after tax, every sleeve's yield after tax, then principal in the draw order; unpaid > $1 makes the lifetime short; then rebalance (`RTR-004`, `RTR-021`, `RTR-023`).

**Draws.** Price: lognormal with the sleeve's arithmetic mean and volatility; yield: lognormal with mean equal to the stated yield and a coefficient of variation of sd / 4; optional correlated shocks through a Cholesky factor (`RTR-019`, `RTR-020`). Historical modes replay 1928 to 2025 in 10-year blocks or every complete window; not exposed on the tab (`RTR-024`).

**Tax.** One effective rate per account type (pre-tax 22%, taxable 15%, Roth 0%), blended by each sleeve's tax mix; withdrawals grossed up, gross = net / (1 - rate); Social Security taxed at 85% x the pre-tax rate; deal proceeds at the book's commitment-weighted blend (`RTR-022`).

**Outputs.** Chance the money lasts, share of the full target, worst thin run, ending wealth percentiles, the yearly curve with a median price index, shortfall anatomy, levers, sources by year, and a median-ending traced ledger that foots (`RTR-008` to `RTR-016`).

**Simplifications and limits.** No brackets, state tax, RMDs or basis tracking; taxable money is taxed on the whole withdrawal. No glide path. The benefit is one flat amount. Lifetime p spends deal future p mod 400; public and private draws are independent. A bill that cannot be paid before the stop year fails the whole lifetime (D8).

### 5.4 Tax models (taxplay.js, taxes-ui.js)

All federal, 2026 law (2026 brackets, standard deduction $32,200 MFJ / $16,100 single, excess business loss limit $512,000 / $256,000, long-term capital gains thresholds $98,900 and $613,700 MFJ). Not tax advice.

| Model | File | Core rule | Laws encoded | Parity |
|---|---|---|---|---|
| Heavy Machinery | taxplay.js `runHM` | Loan-financed equipment, lease income, bonus or MACRS 5, EBL cap, NOL at 80%, buyback with recapture, LTCG and s.1231 | s.168(k), s.461(l), s.172, s.1245, s.1231, s.1(h) | Identical to the published tool (6,145 checks) |
| Workforce Housing | taxplay.js `runWFH` | Seller-financed unit, rent less fees, optional paydown, same loss and exit rules | as above | Identical to the published tool |
| Roth conversion | taxes-ui.js `rothRun` | Tax now through the brackets; level withdrawals of the grown balance save the later rate | s.408A(d)(3) | In-house |
| Cost segregation | taxes-ui.js `costSegRun` | Difference from no study; keep or sell; active or passive | s.168, s.168(k), s.1245, s.469, s.1(h)(1)(E) | In-house |
| Oil and gas | taxes-ui.js `oilGasRun` | IDC and bonus equipment up front; declining production taxed after 15% depletion; working interest or limited partner | s.263(c), s.168(k), s.613A, s.469(c)(3) | In-house |
| Solar credit | taxes-ui.js `solarRun` | 30% credit if in service by 2027; basis less half the credit; 5-year clawback; sale with recapture and LTCG | s.48E (2025 law), s.50(c)(3), s.50(a), s.50(c)(2), s.1245, s.1231 | In-house |

**Stacking.** Income-raising strategies first, then deductions in plan order, each against the income left by the ones before; HM and WFH hand on their recapture income (`TAX-009`). **Indexing.** The in-house models index brackets 2.5% a year; HM and WFH stay on 2026 brackets (D2). **Worth today.** Net per year discounted at 6% (D3). **Side account.** inv_y = inv_(y-1)(1 + g) + net_y; every break-even rate found by a 0.25% scan and bisection (`INV-001` to `INV-004`).

**Simplifications and limits.** No state tax, NIIT, AMT, SE tax or QBI. HM and WFH keep the published tools' known limits: the MFJ 35% bracket ends at 768,600 rather than 768,700, the NOL includes the standard deduction, and their own `stack()` does not hand on exit-year recapture (D4). Losses carry forward in full in the in-house models. Savings land in the year earned, not the next spring.

---

## 6. Test strategy (as built)

| Layer | How | Suites |
|---|---|---|
| Pure models | Load the file into a bare Node `vm` context and call the exported functions | E, M, P, R (first half), T1 |
| Parity with the published tax tools | Run the tools' original page code from `tests/fixtures/` beside the port and compare every numeric field of every year to 1e-6 | TP |
| Whole page | Boot `index.html` in jsdom with every script in page order, SheetJS stubbed so a workbook is fed as arrays of rows, `fetch` served from disk (or failed on demand), and `Date` pinnable | I, R (second half), T2, U |

Conventions: every suite prints `<name>: N checks, 0 failures` and exits 1 on a failure. Engine tests pin the calendar with `PD_AS_OF`; page tests pin `Date`. Many checks name the audit finding they guard (for example `QA H5`, `M-02`). Figures are compared to the cent where they are deterministic and within tolerance where sampled.

Known weaknesses: rendering requirements without a check (marked `TO WRITE` in the RTM), no visual or screenshot tests, dark mode verified only for structure, and ux.js renames tested only on the example book's copy.

The suites are the parity oracle for the rebuild: the model functions keep their signatures and their tests run unchanged against the ported modules (section 7.3).

---

## 7. Target architecture for the React rebuild

### 7.1 Decisions already made

| # | Decision | Source |
|---|---|---|
| T1 | Member data lives only in the member's own spreadsheet. Nothing a member uploads is stored server-side; the spreadsheet is parsed in the browser. | Grill log Q2 |
| T2 | What-ifs are session-only. A member keeps them by printing or saving a PDF summary, downloading a "my changes" file, or downloading an updated spreadsheet. | Grill log Q3 |
| T3 | Two-tier deal library: public fields (sponsor, sponsor MOIC, hold, minimum, underlying deals) visible to members; private reference terms visible only to the two founders and used only by the math. | Grill log Q4 |
| T4 | Private deal math moves server-side once the shared server exists; until then it may run in the browser. | Grill log Q5 |
| T5 | A deal a member enters themselves requires a key-metrics form so the simulation never lacks an input. | Grill log Q4 |
| T6 | Beta with 5 community members, then 40. | Grill log Q0 |
| T7 | Deterministic math; any AI features stay inside the business rules. Free, with a clear "not financial advice" disclaimer. | Product brief, meeting notes |
| T8 | Sign-in only for the two founders' admin area; members use the app without an account. | Brief for this work |
| T9 | Quality gates: tie-out of every Overview total to the member's file; parity with the prototype proven by its own suites; the 5-to-40 beta gate. | Owner, 2026-11-01 (7.7) |
| T10 | Deal-library governance: source precedence, conflicts flagged, "Not confirmed" labels, one-week loading, an intake template. | Owner grill (7.8) |

### 7.2 Proposed structure

```
apps/web                 React app (Vite), routes = the ten tabs plus /admin
packages/models          pure TypeScript ports of the model files, one module each:
                         engine, history, markets, runway, portfolio, taxplay, taxes (models only),
                         includes (config/run/effect/preview, no globals)
packages/intake          spreadsheet -> { sheets, rows } (SheetJS), header mapping, validation
packages/ui              shared components: cards, KPI tiles, tables, charts (SVG), folds, chips
services/deal-api        later (T4): deal library and private-terms math   [OPEN]
tests/parity             the existing suites, run against packages/models
```

### 7.3 Rules for the port

1. **Models stay pure functions with the same signatures.** `buildBook`, `simulate`, `applyDealFile`, `matchDeal`, `callsOf`, `prefInYear`, `irrOf`, `pathDraws`, `portfolioStats`, `toSleeves`, `cone`, `privateCone`, `Runway.simulate`, `levers`, `medianTrace`, `diagnose`, `Portfolio.build`, `datedFlows`, `TaxPlay.*`, the four tax models, `runPlan`, `yearly`, `compound`, `validateDeal`. No React, DOM or network inside them; the clock is injected (replacing `calendarNow()` and every `new Date()` with a `now` parameter fixes the inconsistent clocks in the gap list).
2. **The existing tests are the oracle.** Port each suite's model checks first and run them against the TypeScript modules; the numbers must match. Keep the seeds (engine 20260922, retirement 20260929, cone 20261028 + year), the mulberry32 generator, the FNV-1a and Murmur3 mixing in `streamFor`, and the draw order (timing then outcome, two draws per deal group per path); otherwise every simulated figure moves.
3. **Keep the published tax arithmetic byte-for-byte** (`taxplay.js`) and keep the parity test with its fixtures.
4. **State.** One `BookProvider` keyed on the loaded book: a new book remounts everything below it, which replaces `AppState`. Each tab owns its session state in a reducer under that provider; no global mutable objects. The include switches and the considered deal live in a `PlanProvider`.
5. **Copy is component copy.** Everything ux.js renames, folds or captions becomes the component's own text; the MutationObserver goes away. Keep the vocabulary (Paid in, Still to pay in, Chance the money lasts, worth today vs today's dollars) and the no-dash rule as lint checks.
6. **Heavy computation off the main thread.** Run `Engine.simulate` (6,000 paths with IRR) and the retirement runs (1,200 lifetimes, levers, stop-year rows) in a Web Worker with memoisation per book and config.
7. **Accessibility and mobile as built** (RTM A11Y, MOB): tab pattern with roving tabindex, focus kept across re-renders, aria-labels and keyboard readouts on chart marks, 44-pixel touch targets, 700-pixel breakpoint, dark mode by tokens plus a manual switch (DRK-003).

### 7.4 Data and privacy

- **Browser-side parsing.** SheetJS in a Web Worker; the workbook never leaves the page. The parsed `sheets` and `book` live in memory only. No analytics on member data. **[OPEN]** whether to keep the page usable offline once loaded (it is today).
- **Exports (T2).** (a) Print or PDF: a print stylesheet that renders a summary of every tab with the current what-ifs. (b) "Download my changes": a small JSON or CSV of the session what-ifs (slider moves, include switches, considered deal inputs, tax plan items, recorded balances) that can be loaded back. (c) "Download updated spreadsheet": the member's workbook with recorded balances appended to History and, **[OPEN]**, which other changes are written back and in which columns. **[OPEN]** the file format of (b) and whether it is versioned.
- **Upload validation report** and an **unsaved-change warning** before leaving the page when what-ifs exist (grill log Q2 best practices).

### 7.5 The two-tier deal library and server-side math (T3, T4)

- **Public tier** (served to everyone, cacheable): slug, name, aliases, sponsor, sponsor MOIC, hold, minimum, underlying deals, asset class, vehicle, plus prose the founders mark public. **[OPEN]** whether asset class, vehicle, the underwriting score and the key risks are public.
- **Private tier** (founders only): every other term the math reads (preferred rate, call pace, uncalled yield and its end, LTV, tiers, liquidity window) and all private notes.
- **The split forces a server boundary.** The engine needs private terms to simulate a library deal, and the member's positions must not be stored. Proposed: a stateless endpoint that takes the member's positions (commitment, funded, uncalled, year, account, typed terms; no names beyond the matched slug) and returns only results (schedules, percentiles, IRR bands, per-path proceeds for the plan), never the private terms, and logs nothing about the request body. **[OPEN]** whether the member's own position figures may transit the server at all under T1, or whether the server returns an opaque, per-deal "model card" (outcome table, timing, schedule rules) that the browser engine can use without seeing the raw terms. **[OPEN]** how the deal card shows "yours vs shared" overrides when the shared value is private (today it prints both).
- **Until the server exists,** the browser keeps loading full deal files (today's behaviour); the build must make the switch a configuration change, not a rewrite: the engine depends on a `DealSource` interface with `listPublic()` and `modelInputs(slug, commitment)`.
- **Member-entered deals (T5).** A form with required fields so `buildBook` never falls back silently: name, asset class, fund or single deal, commitment, year funded, hold, and either a sponsor MOIC or a preferred rate; optional: liquidity window, call pace, next call date and amount, LTV, deals in fund. **[OPEN]** whether a member-entered deal can be saved to their spreadsheet through the updated-spreadsheet export.

### 7.6 Authentication and the admin area (T8)

- Members: no account, no sign-in (**[OPEN]** if the beta needs an invite gate; the meeting notes mention Google or Microsoft sign-in for members, which conflicts with T8 and needs a decision).
- Founders: sign-in (Google or Microsoft identity, **[OPEN]** which) to an `/admin` area that edits the deal library (both tiers), reserved names, and publishes a new library version (which busts caches, as the version key does today).
- **[OPEN]** audit log for library edits; who can publish.

### 7.7 Quality gates (owner decisions, RTM section 21)

- **Tie-out (QG-001).** Every total on Overview is shown beside the sum of the member's own file rows, to the dollar, for example "Your file: $2,031,400 · Shown here: $2,031,400 ✓"; any difference names the rows that explain it (left out as negative, no commitment, and so on). Design: `packages/intake` returns, with the parsed sheets, a `fileTotals` object computed from the raw rows as typed; the Overview components compare it with the model totals. Not in the prototype.
- **Parity (QG-002).** The React build's model package must reproduce the prototype's numbers on the same file. Mechanism: a single loader `tests/load-models.mjs` that returns the model globals (Engine, Markets, Runway, Portfolio, History, TaxPlay, the tax models, PlanIncludes) either from the prototype files or from the compiled `packages/models`, selected by `MODELS_FROM=prototype|react`. The model suites (engine, markets, plan, runway first half, taxes, taxplay_parity) are changed only to read through the loader; the page suites (intake, runway second half, taxes2, ui) are re-expressed as Playwright tests against the React app with the same inputs and expected figures. The gate: all nine suites (about 6,700 checks) green against `MODELS_FROM=react`, plus every RTM worked example.
- **Beta gate (QG-003, QG-004).** The beta widens from 5 to 40 testers only with zero open tester-reported wrong numbers, every reported math or display defect fixed first with a regression test, QG-002 green, and an agent-driven test run by the technical partner against the RTM's Given/When/Then with no unexplained differences.

### 7.8 Deal-library governance (owner decisions, RTM LIB-009 to LIB-012)

- **Source precedence.** Each term records its source and rank: subscription documents (1), then a call transcript (2), then the pitch post (3). The highest rank wins.
- **Conflicts and confirmation.** A conflict between sources is flagged to the member on the deal card (within the two-tier rule). A deal without subscription documents runs on its pitch numbers, each labelled "Not confirmed".
- **Timeliness.** New community deals are loaded by the owner within one week of the offering; the file records the offering date so this can be measured.
- **Deal-intake template.** One template, split into public and private tiers, with per-term source and rank and the offering date, that produces a valid deal file. To be built with the admin area (7.6).
- Schema change implied: `terms.<key>` becomes `{ value, source, rank, asOf }` in the private tier, or a parallel `sources: { <key>: { source, rank, asOf } }` block. **[OPEN]** which shape.

### 7.9 Hosting and delivery

**[OPEN]** host (a shared virtual server or a static host plus a small API), domain, and environments. Proposed CI: type-check, lint (including the vocabulary and no-dash rules), unit and parity suites, the jsdom or Playwright page suites, and an accessibility check, on every push; a preview build per branch.

### 7.10 Open questions

1. **[OPEN]** Can member position figures be sent to the server for private-term math, given T1? (7.5)
2. **[OPEN]** Which deal fields are public. (7.5)
3. **[OPEN]** Member sign-in or invite gate for the beta, given T8. (7.6)
4. **[OPEN]** Export formats and what the updated spreadsheet writes back. (7.4)
5. **[OPEN]** D1 to D8 in the RTM (default income after the stop year, bracket indexing, worth-today wording, fixing the published tools' limits at source, community wording, the sample household, deal-proceeds tax, failing a lifetime on an unpayable bill).
6. **[OPEN]** Whether to unify the two percent rules (RTM gap list) and accept the resulting change on a bare 1.
7. **[OPEN]** Whether to expose historical sampling on Retirement.
8. **[OPEN]** Whether to raise the deal futures used by Retirement above 400 (a 1,200-lifetime run reuses each three times).
9. **[OPEN]** Product name, hosting and domain.
10. **[OPEN]** The schema for per-term sources in deal files. (7.8)

## Addendum: decisions from the owner's grill (2026-11-01)

- **Broker exports.** Members paste their brokerage's positions export into the template rather than typing holdings. The React build reads Schwab, Fidelity, Vanguard and E*TRADE position exports first; each broker needs its own column mapping and a fixture file in the tests. [Gap: the prototype reads only its own Holdings layout.]
- **No verdicts.** The beta shows numbers and explanations only: no fit scores, verdicts or suggested amounts.
- **Who sees the prototype.** The public prototype link is a reference for the technical partner; beta testers use the React build.
- **Required plan figures (Q20).** On a member's own file, Retirement shows no result until the You tab has birth year, planned stop work year, annual spend target, Social Security amount and its start age, and the file has a Balances or Holdings tab. Retirement lists what is missing instead; the deal tester shows the deal's own figures and holds back its two retirement figures. A 0 is an answer. The sample household and the example book are never gated. The template marks the five as required and adds three optional Tax Strategies fields (filing status, household income, taxable income after stopping). RTM RTR-026, INT-026.
- **Capital calls before you stop (Q21).** Retirement carries a panel, placed under the headline, listing each year's capital calls before the stop year, the running total and the part the public money in the file could not cover before any deal payout. Numbers only, no verdict; the first year a gap appears is highlighted red (light #FFECEE, dark #3A1214) with the label "first year not covered". The summary line stays visible; the method folds under How to read this. RTM RTR-027.
