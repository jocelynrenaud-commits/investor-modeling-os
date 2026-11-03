# Start here: the handoff package

**Live prototype:** https://jocelynrenaud-commits.github.io/investor-modeling-os/
**Source and documents:** https://github.com/jocelynrenaud-commits/investor-modeling-os

The prototype is the reference for the production build. It is a working, tested app in plain browser JavaScript with no build step and no server. It is not meant to be ported line by line. **The stack, the architecture, hosting and tooling are yours to decide.** The documents below say what the product must do and which numbers it must produce; where they name a library, folder layout or pattern, that is a suggestion drawn from how the prototype happens to work.

## Read in this order

| # | What | Why |
|---|---|---|
| 1 | The live site: click **Run the example book**, then walk the ten tabs | The fastest way to see the product. Download the template from the landing page and load your own copy to see intake. |
| 2 | [docs/DESIGN_SPEC.md](docs/DESIGN_SPEC.md), section 7 and the addendum | The owner decisions (7.1, 7.7, 7.8 and the product rules in 7.4 to 7.6) are requirements. The rest of section 7 is suggestions. Sections 1 to 6 describe the prototype as built. |
| 3 | [docs/RTM.md](docs/RTM.md) | 283 requirements, page by page. Each has a rule or formula, a worked example with its expected output, Given/When/Then, and test cases mapped to the prototype's checks. The gap list and the open decisions (D1 to D8) are near the end. |
| 4 | [docs/REACT_BUILD_PROMPT.md](docs/REACT_BUILD_PROMPT.md) | A prompt for a coding agent working in your repository. It defers to your stack and conventions and fixes only what must be true. Edit it freely. |
| 5 | [README.md](README.md) | How the prototype is organised, its plugin contract and its state rules. |

## Non-negotiables, whatever the stack

1. **Member data is never stored.** The member's spreadsheet is read in the browser and kept in memory only; nothing they upload is sent to a server or kept in browser storage (T1, T2).
2. **Same file in, same numbers out.** The prototype's test suites are the oracle. The production models must reproduce them on the same inputs (QG-002), and every RTM worked example is a test.
3. **Numbers and explanations, no verdicts.** No fit scores, recommendations or suggested amounts in the beta.
4. **The beta gate.** 5 members first, then 40 only with no open wrong-number defect and a clean agent-driven run against the RTM (QG-003, QG-004).

## Run the prototype and its tests

```
python -m http.server 8791
```

Open http://localhost:8791. Tests need Node 18 or later; the page-level suites also need `jsdom` (`npm install jsdom` in this folder).

```
node tests/engine.test.mjs
node tests/ui.test.mjs
```

There are nine suites in `tests/` (about 6,700 checks). Each prints `<name>: N checks, 0 failures`. All nine are green at handoff.

## Known findings and open items

- **Open decisions D1 to D8** (RTM, end of document): each states the prototype's current behaviour, which is the default until decided.
- **G27, the IRR solver** (RTM gap list, DM-018): a stream whose last flow is money going out is read as a total loss before the solver checks for several sign changes. Flagged and not yet fixed.
- **D6, the sample household** reads about 32% chance the money lasts. It is fictional and drives Retirement only for the example book and before a member loads a file.
- **Gaps not yet built:** broker-export readers (Schwab, Fidelity, Vanguard, E*TRADE), print and PDF summary, "download my changes", the tie-out on Overview (QG-001), the deal-library governance (LIB-009 to LIB-012), the two-tier deal library and the admin area. The RTM marks 13 requirements as Gap; the rest are described in DESIGN_SPEC 7.4 to 7.8 and the addendum.

## About the data

The deal library holds real community deal files, kept by the owner's decision, with people's names removed. The example book is one investor's real book with the names taken out, shared as a worked example. The template (`tracker-template.xlsx`) is what members fill in: the five orange You-tab fields and a Balances tab are required before Retirement runs.
