# Prompt: build the React app from the RTM and the design spec

Give the text below to a coding agent working in a fresh repository that also contains a copy of this prototype folder (read-only, under `reference/prototype/`).

---

You are building the React version of an investor modeling tool. A working prototype exists and is the reference; three documents define what to build:

- `reference/prototype/docs/RTM.md`: every requirement, page by page, each with a rule or formula, a worked example with its expected output, Given/When/Then acceptance criteria, test-case IDs (`TC-<REQ>-nn`) mapped to the prototype's existing checks or marked TO WRITE, the gap list, and the open decisions D1 to D8.
- `reference/prototype/docs/DESIGN_SPEC.md`: the architecture as built, the data model, the model formulas, and section 7, the target architecture. Section 7 governs where it differs from the prototype.
- `reference/prototype/tests/*.test.mjs`: about 6,700 checks that are the parity oracle for the models.

Work test-first. Do not write a feature before its tests exist and fail.

## Ground rules

1. **Stack.** TypeScript, React, Vite, a monorepo with `packages/models`, `packages/intake`, `packages/ui`, `apps/web` (DESIGN_SPEC 7.2). Vitest for unit and parity tests, Playwright for page tests, axe for accessibility. No server in this phase.
2. **Models are pure functions.** Port `engine.js`, `history.js`, `markets.js`, `runway.js`, `portfolio.js`, `taxplay.js`, the four tax models and the stacking in `taxes-ui.js`, and the config, run, effect, preview and validation logic of `includes.js` into `packages/models`, keeping every exported signature and every constant. No DOM, network or globals. Inject the clock as a `now` parameter everywhere; do not call `new Date()` inside a model.
3. **Parity first.** Before porting a module, port the model checks from its prototype suite (E, M, P, R first half, T1, TP) into Vitest against the TypeScript module, then port the module until they pass with the same numbers. Keep the seeds, the mulberry32 generator, the `streamFor` hashing and the draw order exactly (DESIGN_SPEC 7.3), or every simulated figure moves. Keep `taxplay.js` arithmetic byte-for-byte and keep its parity test with the fixtures.
4. **The RTM's worked examples are tests.** For every requirement, write the test case `TC-<REQ>-01` (and the others listed) from its worked example and acceptance criteria, with the stated inputs and the expected output, before building the requirement. Examples were computed with the clock at 2026-11-01 12:00 local and the prototype's example book; reuse `reference/prototype/example-book.json` and `deals/` as fixtures.
5. **Build order.** (a) `packages/models` with parity green. (b) `packages/intake`: SheetJS in a Web Worker, header mapping in the documented field order, validation messages (RTM section 12). (c) `BookProvider` keyed on the loaded book, and `PlanProvider` for the include switches and the considered deal (DESIGN_SPEC 7.3 rule 4). (d) Tabs in screen order: Overview, Equity Curve, Holdings, Deals, Liquidity Outlook, Returns, Deal Library with the tester, Retirement, Tax Strategies, Help. (e) Cross-cutting sections 13 to 20. Run simulations in a Web Worker with memoisation.
6. **Copy and vocabulary.** Component copy replaces everything `ux.js` did after rendering. Use the RTM's labels exactly (Paid in, Still to pay in, Chance the money lasts, Change in money left at the end, worth today versus today's dollars). Add lint checks that fail on an em or en dash, "NaN", "undefined", "-$0" or "-0.0%" in rendered output.
7. **Privacy.** Nothing the member uploads is sent anywhere or stored. No analytics on member data, no browser storage of member data. The only network calls are for the app itself and the deal library.
8. **Deal library behind an interface.** The engine reads deals through a `DealSource` with `listPublic()` and `modelInputs(slug, commitment)`. Implement a static source over `deals/*.json` now; the server-side source (DESIGN_SPEC 7.5) comes later and must be a configuration change.
9. **Accessibility and mobile.** Meet RTM sections 18 to 20: tablist with roving tabindex and arrow keys, focus kept across re-renders, keyboard readouts on chart marks, 44-pixel touch targets, a 700-pixel breakpoint, dark mode by tokens and a manual switch.
10. **Quality gates (RTM section 21, DESIGN_SPEC 7.7).** Build the tie-out on Overview: every total shown beside the sum of the member's own file rows to the dollar ("Your file: $2,031,400 · Shown here: $2,031,400 ✓"), with the rows that explain any difference. Create `tests/load-models.mjs` so each prototype model suite (engine, markets, plan, runway, taxes, taxplay_parity) can run against either the prototype files or your `packages/models` build via `MODELS_FROM=prototype|react`; re-express the page suites (intake, runway page checks, taxes2, ui) as Playwright tests with the same inputs and figures. All nine suites must be green with `MODELS_FROM=react`.
11. **Deal-library governance (DESIGN_SPEC 7.8).** Model per-term source and rank in the deal schema behind the `DealSource` interface, show "Not confirmed" on terms whose best source is a call or a pitch, and flag conflicts on the deal card; leave the schema shape behind a flag (it is open).
12. **Do not decide open questions.** Anything marked **[OPEN]** in DESIGN_SPEC section 7, and D1 to D8 in the RTM, stays as the prototype behaves, behind a named flag, and is listed in your final report.

## Definition of done for this phase

- Every RTM requirement with status Implemented or Partial is built, and every one of its test cases exists and passes. Gaps (status Gap) are not built unless listed below.
- The ported prototype suites pass with identical figures; the parity test passes all 6,145 checks.
- Build the three decided gaps that have no open questions: the print and PDF summary (DESIGN_SPEC 7.4 a), the "download my changes" file (7.4 b, format behind a flag), and the member-entered deal form with required fields (7.5).
- The tie-out (QG-001) is built and tested on the example book and on a synthetic tracker with a negative row.
- CI runs type-check, lint, unit, parity (all nine prototype suites with `MODELS_FROM=react`), page and accessibility tests on every push.
- The release is ready for the beta gate (QG-003): no open wrong-number defect, and a report the technical partner's agent-driven run (QG-004) can start from.
- A final report lists: requirements built, test cases written, any number that differs from an RTM worked example and why, and every open question you met.
