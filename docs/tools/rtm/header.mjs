export default (K) => `# Requirements Traceability Matrix (RTM), version 0.2

**Product:** My Ultimate Investor Modeling OS (Atlas & Index prototype)
**Baseline:** the prototype in this folder on 2026-11-01 (engine label \`${K.E.CFG.version}\`, tracker columns \`${K.E.CFG.trackerVersion}\`).
**Purpose:** the list of everything the prototype does, page by page, with every calculation and business rule, written so the React rebuild can be built test-first against it.
**Companions:** \`DESIGN_SPEC.md\` (architecture, data model, model formulas, target architecture) and \`REACT_BUILD_PROMPT.md\` (the prompt for the build agent).
**Generated:** this file is produced by \`node docs/tools/build_rtm.mjs\`. Edit the definitions in \`docs/tools/rtm/\`, never this file by hand, or the next build overwrites the edit.

## How the worked examples were produced

Every worked example below was computed by running the prototype's own code, not by hand. The build script boots \`index.html\` in jsdom through \`tests/harness.mjs\` (every script in the page's own order, the spreadsheet library stubbed, \`fetch\` served from disk), pins the clock to **${K.NOW} local time** (so \`Engine.calendarNow()\` reads year 2026 with about 16.4% of the year left), presses **Run the example book**, and then either calls the real module functions (\`Engine\`, \`Markets\`, \`Runway\`, \`Portfolio\`, \`TaxPlay\`, \`TaxStrategies\`, \`PlanIncludes\`, \`AppIntake\`) or reads the rendered page. Each example states its inputs: either the **example book** (\`example-book.json\`, 12 private positions, with the fictional **sample household** for public money and for the Retirement plan) or a small synthetic input written out in the example. Simulated figures depend on the seeds listed in section RND, so a port that keeps the seeds and the draw order reproduces them exactly; a port that changes either must reproduce them statistically and say so.

The screenshots under \`docs/screens/\` were taken from the same example book. Their figures can differ slightly from the examples here where the screenshot was taken on a different day (the calendar decides which capital calls are still ahead).

## How to read a requirement

Each requirement is one block:

| Field | Meaning |
|---|---|
| ID and title | Stable identifier. The prefix names the section. Numbers are never reused. |
| Requirement | One sentence a test can confirm or refute. |
| Rule or formula | The business rule with units. Money is US dollars. Rates are decimals a year unless written with %. |
| Worked example | Inputs and the expected output, computed by the build script. |
| Acceptance | Given, when, then. |
| Test cases | \`TC-<ID>-nn\` mapped to the existing suite and the check's own description, or \`TO WRITE\` when nothing covers it yet. |
| Source | \`file:function\` in this folder. |
| Status | **Implemented** (code and a test), **Partial** (code without a test, or only part of the rule), **Gap** (not built). |

## Test suites

All under \`tests/\`, run with \`node tests/<file>\`. Each prints \`<name>: N checks, 0 failures\` and exits 1 on a failure.

| Suite | File | Checks on 2026-11-01 | What it loads |
|---|---|---|---|
| E | engine.test.mjs | 64 | engine.js in a bare \`vm\` context, calendar pinned to 2026-10-31 |
| I | intake.test.mjs | 37 | the whole page in jsdom (\`harness.mjs\`) |
| M | markets.test.mjs | 100 | markets.js, engine.js and runway.js in \`vm\` |
| P | plan.test.mjs | 82 | portfolio.js, markets.js and includes.js in \`vm\` |
| R | runway.test.mjs | 67 | runway.js and history.js in \`vm\`, then the page in jsdom |
| T1 | taxes.test.mjs | 27 | taxplay.js and taxes-ui.js |
| T2 | taxes2.test.mjs | 75 | taxes-ui.js in jsdom with a pinnable clock |
| TP | taxplay_parity.test.mjs | 6,145 | the two published tax tools' original code beside \`taxplay.js\` |
| U | ui.test.mjs | 129 | the whole page in jsdom |

Total 6,726 checks. Many run in loops (one per tab, label or year), so there are fewer distinct check descriptions than checks.

## Screen order

\`ux.js:groupTabs\` groups the tab bar into five areas. Sections 1 to 10 follow it; sections 11 to 20 are cross-cutting; section 21 holds the owner's quality gates and deal-library rules.

| Group | Tabs (label, internal id, screenshot) |
|---|---|
| Portfolio | Overview (\`overview\`), Equity Curve (\`curve\`) |
| Public markets | Holdings (\`holdings\`) |
| Private deals | Deals (\`dash\`), Liquidity Outlook (\`outlook\`), Returns (\`perf\`), Deal Library (\`universe\`) |
| Planning | Retirement (\`runway\`), Tax Strategies (\`tax\`) |
| Reference | Help (\`about\`) |

The landing page before any book is loaded is \`docs/screens/landing.png\` (section INT).
`;
