# My Ultimate Investor Modeling OS: prototype (Atlas & Index)

A working prototype for the product review, built from tools the author already ships:

| Piece | Source |
|---|---|
| Private-deal dashboard, liquidity outlook, Retirement Simulator | Financial Planning OS v1.50 |
| Tax plays | Workforce Housing v1.2 and Heavy Machinery v1.0 federal tax models, ported in `taxplay.js` |
| Whole portfolio (new) | `markets.js` (statistics) + `markets-ui.js`: Overview, Public Markets holdings, Equity Curve |
| Tax Strategies (new) | `taxes-ui.js`: pick a strategy, set its terms, see tax saved and owed back year by year, its effect on retirement, and what investing the savings does |
| Plan includes (new) | `includes.js`: one place deciding what the Retirement plan includes (tax strategies, capital calls still owed, a deal being considered) |
| Deal tester (new) | `consider-ui.js`: "What If I Add This Deal?" on the Deal Library |

## How the app is organised
The tab bar is grouped so public and private never get mixed up:

| Group | Tabs |
|---|---|
| Portfolio | Overview (Net Worth, Portfolio Allocation, Assets by Account, 12-Month Return Range with a 20-bar outcome histogram, Risk Concentration for the whole portfolio, public only or private only), Equity Curve (a new planned cone each Jan 1 vs the actual balance; Combined: Whole portfolio, All public accounts, All private accounts; or any one of the five accounts) |
| Public markets | Holdings (positions, statistics with a risk and return map, the sleeves that feed the plan) |
| Private deals | Deals, Liquidity Outlook, Returns, Deal Library (the original app, unchanged) |
| Planning | Retirement, Tax Strategies |
| Reference | Help (About This Tool, Terms, then the private-deal explainers) |

## Accounts
Five, by tax bucket: **IRA** and **Self-Directed IRA** (pre-tax), **Roth IRA** (Roth), **Private Deals** and **Brokerage** (taxable). Public holdings take the account named in the Holdings tab. Private deals take the tracker's Account column: anything IRA-like goes to the Self-Directed IRA, anything personal or taxable to Private Deals, and a blank defaults to the Self-Directed IRA.

## Tax Strategies (`taxes-ui.js`)
A strategy is a definition (name, the model it runs, and a list of typed input fields), so the form, the year-by-year chart and the totals are drawn from it. Heavy Machinery, Workforce Housing, Roth conversion, cost segregation, oil and gas and the solar investment credit are live. Solar takes a 30% credit against the tax itself (only for projects in service by Dec 31, 2027 under the 2025 law), depreciation on cost less half the credit, income, and a sale; selling inside 5 years claws back the unvested credit. Oil and gas deducts the intangible drilling costs and bonus-depreciated equipment in the year invested, then taxes declining production cash less 15% percentage depletion; a working interest offsets W-2 income, a limited partner's loss waits until production ends. Cost segregation models only the difference from not doing the study: extra depreciation up front, less later, recapture at ordinary rates on a sale (none if kept or exchanged), and a passive investor's loss held until the sale. Several strategies stack: conversions (which add income) are counted first, then deductions in order, each measured against the income left after the ones before, so a deduction can absorb a conversion in the same year. The Roth card states the one comparison that decides it: the rate paid now against the rate avoided later, and the result in today's dollars.

## What the Retirement plan includes
Retirement's "Included in This Plan" panel switches three items on and off, and shows never short with and without them on the same futures:
- **Capital calls still owed** (on by default; leaving them out flatters the plan).
- **Your tax strategies**, as set up on Tax Strategies, entered as dated cash.
- **A deal you are considering**, added on purpose from the Deal Library's tester: run through the engine with its deal file, its paid-at-close and calls going out, its simulated proceeds coming in. Nothing is added to the book.

The tester's **Run it is a preview** (`PlanIncludes.preview`): it shows the deal's own range and the plan without and with it, and changes nothing. **Add to my Retirement plan** includes it (`PlanIncludes.consider`), the card then shows it as included with **Remove**, and the Retirement panel lists it. A deal that closes before this year or more than ten years out, a paid-in share outside 0 to 100%, or a commitment larger than all the public investments is refused with a message, because the simulator would otherwise drop its money in or charge money that is not there.

Tax Strategies shows "Effect on retirement" (chance the money lasts and the change in money left at the end, with and without the strategies) and the Deal Library tester shows the same for its deal; all use `PlanIncludes.effect` or `preview`, 1,200 lifetimes, the Retirement tab's own count.

**Terms.** The headline retirement metric is **Chance the money lasts** (it was "never short"; ux.js relabels the base app's text, and new copy should use the new words). A difference in ending wealth is **Change in money left at the end**. Money committed to a deal and not yet sent is **Still to pay in**, in neutral ink; money sent is **Paid in**; the full amount signed is **Committed**.

## If you invest what it saves
Tax Strategies follows a side account that takes each year's net and grows at a slider rate (0 to 12%), against the same money left as cash, and solves the break-even rate where the account ends at zero. Deferral-shaped plans (saving first, tax later) win above it; investment-shaped plans (money in first) win only if your other money would grow slower.

## Card titles
Every card is named for what it shows, in title case. Titles drawn by the base app are renamed in `ux.js` (RENAME), which keeps the original on the element as `data-orig` so captions, folds and hidden cards still match.

## Hover
Every chart shows its numbers on hover. Charts drawn by `app.js` that had no readout (Outcome range by sleeve, the private allocation bar) get one from `ux.js`, built from the figures the chart prints.

## The statistics (`markets.js`)
- Every asset class has a long-run expected return, volatility and yield, and a breakdown of its risk across five shared drivers (equity, rates, real assets, credit, crypto). Correlations follow from that breakdown, so the matrix is always valid.
- Single stocks use the single-index model: beta sets the market share of their risk; the rest is company-specific.
- `portfolioStats` gives expected return, volatility, yield, beta, each holding's share of risk, a 1-in-20 bad year, the chance of a losing year, Sharpe, diversification benefit and effective number of holdings.
- `toSleeves` turns holdings into Retirement Simulator sleeves (Stocks, Income, Bonds, Real assets, Crypto, Cash), each with its own return, volatility, yield and tax mix, plus the correlation between sleeves. The simulator now draws correlated returns when given that matrix (`runway.js`, opt-in; identical results without it).
- `privateCone` draws the private accounts' planned range from the Liquidity Outlook's own futures: it replays simulate()'s draws with the same seed, so path p is the same future, and values the account monthly (cash received plus what is still held, marked from cost toward the drawn outcome by its exit; calls are money added). Run to the last exit it ends exactly on the Outlook's cumulative cash (tested). The whole-portfolio cone adds public and private paths future by future.
- `cone` draws the Equity Curve's planned range, seeded. A new plan starts every Jan 1 from the Dec 31 balance, as in APEX; the first year on record starts from its first balance.

## Tracker tabs it reads (all optional)
- **Balances** (in the shipped template): Account, Account type, Sleeve, Label, Value, Cost basis, Yield, Expected return, Volatility, As of. Read by `portfolio.js` for every tab.
- **Holdings**: Symbol, Name, Asset class, Account, Account type, Quantity, Price, Market value, Cost basis, Beta, Expected return, Volatility, Yield. Only Symbol plus Quantity/Price or Market value are required.
- **History**: Date, Account, Balance, Net flow. The Equity Curve's "Download history" produces exactly this. A Balances tab is never read as history.

**Which household every tab shows** (`Markets.load`, one rule): a **Balances** tab, else a **Holdings** tab (an empty one means "no public holdings"), else the fictional sample household (IRA, Roth IRA and Brokerage, illustrative prices; the example deals split between the Self-Directed IRA and Private Deals), which every tab labels. When both Balances and Holdings exist, Balances wins (the Retirement tab already plans from it) and Overview and Holdings say the Holdings rows were not used. Negative values are left out with a note.

**Percent cells** (`Markets.pctIn`, `Portfolio.pctOf`, the same rule, tested together): text with a % sign is percent, as in `Engine.num` ("1%" is 1%, "1.2%" is 1.2%, "150%" is 150%). A bare number below 1 is already a fraction (0.012 is 1.2%, which is how a percent-formatted Excel cell arrives); from 1 up it is percent points (1.2 is 1.2%, 8 is 8%). A return or yield beyond 50% a year, or a volatility beyond 200%, is flagged on screen.

**Dated cash that inflates** (Cashflows tab, Inflates = yes) grows from today's dollars at the You tab's inflation before and after the stop year (3.5% and 3% when the You tab is silent).

## Run it
```
python -m http.server 8791
```
Then open http://localhost:8791 and click **Run the example book**. Everything runs in the browser; nothing is uploaded or stored.

## Test it
```
node tests/engine.test.mjs
node tests/intake.test.mjs
node tests/markets.test.mjs
node tests/plan.test.mjs
node tests/runway.test.mjs
node tests/taxes.test.mjs
node tests/taxes2.test.mjs
node tests/taxplay_parity.test.mjs
node tests/ui.test.mjs
```
Each prints `<name>: N checks, 0 failures` and exits 1 on any failure. `taxplay_parity` runs the original tax tools' code (saved copies in `tests/fixtures/`) beside the port and requires identical results year by year. `markets` covers the statistics, cones and percent cells; `plan` covers percent cells, dates, which household, dated cash, the deal tester's rules and the reset hook, in a bare `vm` context; `ui` boots the whole page in jsdom through `tests/harness.mjs` (scripts in index.html's own order, XLSX stubbed, `fetch` served from disk, `Date` pinnable) and checks what a member sees. The jsdom tests need `jsdom`: install it in this folder (`npm install jsdom`) or point `JSDOM_FROM` at an existing `node_modules`.

## Architecture (as built; the React build's architecture is the technical partner's)

**Script load order** (index.html), and why:

| # | File | Global | Role |
|---|---|---|---|
| 1 | xlsx (CDN) | `XLSX` | spreadsheet parser, used by app.js only |
| 2 | engine.js | `Engine` | the private-deal model; shared, byte-identical with the live apps |
| 3 | history.js | `History` | historical return series for the simulator |
| 4 | markets.js | `Markets` | public-markets statistics, which household, cones |
| 5 | runway.js | `Runway` | the retirement simulator |
| 6 | portfolio.js | `Portfolio` | You, Balances, Property, Cashflows, Events tabs; dated cash |
| 7 | runway-ui.js | `RunwayUI` | Retirement tab (plugin) |
| 8 | taxplay.js, taxes-ui.js | `TaxPlay`, `TaxStrategies` | Tax Strategies tab (plugin) |
| 9 | includes.js | `AppState`, `PlanIncludes` | what the plan includes; the reset hook |
| 10 | consider-ui.js | `ConsiderUI` | the Deal Library's "What If I Add This Deal?" card |
| 11 | markets-ui.js | `MarketsUI` | Overview, Equity Curve, Holdings (plugins) |
| 12 | ux.js | `UX` | post-render layer: names, captions, folds, tab grouping and ARIA, Help cards |
| 13 | inline | `APP_TAB_LABELS` | renames for app.js's own tabs |
| 14 | app.js | (none) | intake and the base tabs; reads `APP_PLUGINS` once, so every plugin must load first |

Model files (2 to 6) never touch the DOM and read other globals only at call time. UI files read model globals at render time, so their order among themselves only matters for registration.

**Plugin contract.** A plugin appends `{ id, label, after, render(host, ctx) }` to `window.APP_PLUGINS` before app.js loads. app.js inserts a tab labelled `label` after the tab whose id is `after` and, when it is open, calls `render(host, ctx)` with `host` the `#tabbody` element (render replaces its contents) and `ctx = { book, mode, sheets }`: `book` is `Engine.buildBook` output (one object per load, so its identity marks a new book), `mode` is the private-deal sleeve filter (`'all' | 'venture' | 'income'`), and `sheets` is every sheet of the workbook as arrays of rows (`{}` for the example book). A render must call `PlanIncludes.remember(ctx)` first.

**State ownership.** Each module owns its session state and nothing else: `PlanIncludes` (the include switches and the considered deal), `ConsiderUI.S` (the tester's inputs and result), `MarketsUI.S` (filters, sort, Equity Curve scope, balances recorded this session), `TaxStrategies.S` (the strategy plan), RunwayUI's slider overrides. Nothing is stored: a reload starts clean.

**Reset.** `window.AppState` (includes.js) is the one reset hook. `AppState.onReset(fn)` registers `fn(reason)`; a module that loads before includes.js pushes `fn` onto `window.APP_RESET_HOOKS` instead (read at reset time). `AppState.reset(reason)` runs every hook once. It fires automatically on every new book: app.js calls `PlanIncludes.remember(ctx)` and dispatches `privatedeals:book` on each successful load, `remember` calls `AppState.noteBook(ctx)`, and a book object different from the last one seen triggers the reset. A hook clears only its own state and must not render. Whatever the new architecture, the rule to keep is: a new book clears every module's session state.

**The UX layer.** ux.js edits the rendered page through a MutationObserver because app.js must stay identical to the live app. In a port, its renames, captions, folds and Help cards become ordinary component copy and the observer goes away.

## What changed from the Financial Planning OS
- `taxplay.js`, `markets.js`, `markets-ui.js`, `taxes-ui.js`, `includes.js`, `consider-ui.js`: new.
- `runway.js`: optional correlated sleeve draws (off unless a correlation matrix is passed).
- `runway-ui.js`: sleeves come from the Public Markets holdings unless the tracker has a Balances tab.
- `includes.js`, `consider-ui.js`, `markets.js`, `markets-ui.js`, `portfolio.js`, `ux.js`, `index.html` (2026-10-31): hardening from the math, QA and UX audits. One household on every tab; percent cells read one way; a new book resets every module (`AppState`); the deal tester previews and only Add changes the plan; inputs validated; plain terms; Start Here and Terms cards; keyboard tab pattern; dark mode; the template linked from the landing page. `portfolio.js` changes (percent rule, Holdings not read as Balances, inflating cashflows) should be ported to webapp-next, which shares the file.
- `ux.js`: new. Hides the Cash flow by year card (its rows could not be added down; Cumulative cash received answers the same question). UX cleanup layer: a one-line caption under each card heading, long explanations folded under "How to read this", key findings highlighted, the drop zone collapsed once a book is loaded. Works on the rendered page so app.js stays identical to the Financial Planning OS.
- `runway-ui.js`: the author's real figures replaced by a fictional sample household; exposes `RunwayUI.baseConfig` (Tax Strategies reads the stop year from it).
- The What-If tab (`whatif-ui.js`) was removed on 2026-10-31 at the owner's request; it is in git history.
- `index.html`: a new look modelled on Apple's product pages (system type, white cards on grey, a pinned frosted tab bar), prototype branding, release notes, shorter copy and tab labels (Deals, Liquidity Outlook, Returns, Deal Library, Retirement, Glossary), new script tags.
- `example-book.json`: first-person notes removed; each deal carries an account; the two BlueBird tranches merged into one $100k row.

Real community deal files are kept by the owner's decision; people's names have been removed from code comments and deal notes.

See `CROSSCHECK.md` for the comparison with APEX.
