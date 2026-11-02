/* Exit Timing Calendar: simulation engine (prototype fork).
 *
 * Ported from the APEX Retirement Simulator's Private Book tab. Deliberately plain
 * JavaScript with no dependencies, so the whole app can be a static page that runs
 * entirely in the browser and never sends anybody's book anywhere.
 *
 * Every rule in here was learned by getting it wrong first. They are commented where
 * they sit, because each one is an error this model used to make.
 *
 * ============================================================================
 * PORTING GUIDE (written 2026-10-31 for the React port; read this first)
 * ============================================================================
 *
 * PURPOSE
 *   Turn a holder's private-deal positions (one tracker row each) into:
 *     - a deterministic schedule of capital calls and contractual preferred returns,
 *     - a Monte Carlo of exit timing and outcome per deal, summed per future ("path"),
 *     - cash and IRR percentiles that rank WHOLE futures, so they can be read down a column.
 *   No DOM, no network, no storage. Every exported function is pure apart from reading the
 *   clock through calendarNow() (pinned by CFG.asOf / env PD_AS_OF in tests).
 *
 * THE PIPELINE
 *   tracker row --applyDealFile(row, dealFile)--> enriched row (blanks filled from shared terms)
 *               --buildBook(rows)--> book: Position[]   (warnings on each position)
 *               --simulate(book, opts)--> Result
 *
 * INPUT: a tracker row (plain object; every field optional except name and commitment).
 *   Values may be numbers or strings as a spreadsheet hands them over ("$100,000", "8%").
 *     name, account, accountType, assetClass, vehicle ("Fund" / "Single deal" / free text),
 *     commitment, funded, uncalled, yearFunded, hold (years),
 *     coupon            preferred return a year. PERCENT FIELD, see pctField() below.
 *     moic              sponsor's multiple on invested capital (total distributions / capital)
 *     markedUpMoic      the holder's paper mark; DISPLAY ONLY, never reaches the simulation
 *     deals             number of underlying deals in a fund (20 or more = diversified table)
 *     liqFrom, liqTo    payout window in fund-years from funding
 *     exitEarliest, exitLikely, exitLatest   calendar years
 *     nextCallDate ("Q1 2027", "2027-03", 2027), nextCallAmount
 *     callPctPerYear, uncalledYieldPct, ltv  PERCENT FIELDS (deal files supply them as decimals)
 *     uncalledYieldUntil  decimal year the uncalled yield stops (2027.5 = end of June 2027)
 *     conviction, thesis  free text, carried for display
 *     _deal, _ovr, _tier, _tierUnresolved    set by applyDealFile, not typed by anyone
 *
 * DEAL FILE SCHEMA (deals/<slug>.json). Every field engine.js READS; anything else in a file
 * is display copy that app.js may print. All rates are decimals (0.08 means 8%).
 *     slug                 identity; also the groupKey that gives tranches one shared fate
 *     assetClass           decides real estate vs venture vs income tables (isRealEstate)
 *     vehicle              free text; vehKind() reads "fund"/"pool" vs "single"/"spv"
 *     singleCompany        true forces the single-deal reading
 *     dealsInFund          number of underlying deals
 *     liquidity.fromYear, liquidity.toYear   payout window in fund-years
 *     terms.couponPct      preferred return (makes the deal "income")
 *     terms.sponsorMoic    sponsor multiple (required if no coupon, else a flagged 5.0x is used)
 *     terms.holdYears      hold in years
 *     terms.callPctPerYear known call pace as a share of commitment a year
 *     terms.uncalledYieldPct, terms.uncalledYieldUntil   yield on uncalled money, and its end
 *     terms.ltvPct         loan to value for real estate. terms.ltv is accepted as an alias,
 *                          because asilia-credit-fund-evergreen.json was written with it
 *     tiers.basis, tiers.bands[{label, min, max, terms}]  ticket-size pricing; only basis
 *                          "commitment" can be resolved; a band's terms replace terms.*
 *   The deal index (deals/index.json) is read by matchDeal(): deals[{slug, name, aliases}],
 *   reserved[] (names that must resolve to nothing).
 *
 * OUTPUT: Position (one per kept row, from buildBook)
 *     name, account, kind ('income' | 'venture'), cls, ltv, commitment, funded, uncalled,
 *     coupon, hold, fy, moic, exitMult (residual multiple for coupon payers), deals, isFund,
 *     diversified, branches + scales (the outcome table), liq + spread (sell-down window),
 *     earliest, likely, latest, nextCallYear, nextCallAmt, callPctPerYear, uncalledYieldPct,
 *     uncalledYieldUntil, markedUpMoic, paperNav, moicAssumed, moicGiven, groupKey, deal,
 *     overrides, tier, tierUnresolved, thesis, conviction, earliestTyped, liqStated,
 *     warnings: string[]   input problems found and corrected here (see INVARIANTS)
 *
 * OUTPUT: Result (from simulate)
 *     years[]                      the calendar grid (gridYears)
 *     byYear[{year, coupon, couponScheduled, calls, med, odds, p90}]   per-year, NOT addable
 *     cum[{year, p10, p50, p90}]   cumulative, ranked on whole futures, addable down
 *     hist[], histBins, histMax    total cash / committed, as shares of paths
 *     pathRows                     [path][yearIndex] cash, only with opts.capturePaths
 *     totals{committed, funded, uncalled, coupon, couponScheduled, couponP10, calls,
 *            p10, p50, p90, mean, stackedP90, shareAtCap}
 *     ties                         true when cum's last p50 equals totals.p50
 *     irr (only with opts.irr)     {portfolio, byCash, byClass, byDeal[], flags, paper}
 *
 * INVARIANTS (tests rely on these)
 *   - Exit proceeds = commitment x drawn multiple. Never funded x multiple.
 *   - A coupon payer exits on the RESIDUAL multiple (moic - coupon x hold), so the preferred
 *     return is not counted twice.
 *   - 0 <= funded <= commitment and 0 <= uncalled <= commitment - funded, enforced in
 *     buildBook with a warning on the position whenever an input had to be corrected.
 *   - Staging (liqSpread, exitPlan) only MOVES money between years; weights sum to 1.
 *   - Nothing is ever placed in a year that has already ended (callsOf, exitPlan).
 *   - The portfolio IRR is solved on POOLED flows per path, never averaged across deals.
 *   - Cumulative percentiles tie to the totals (Result.ties).
 *
 * RANDOMNESS AND SEEDING (changed 2026-10-31, audit finding M-02)
 *   Seeded, so the same book always gives the same answer. Base seed CFG.seed (20260922),
 *   overridable with opts.seed. Each deal GROUP (groupKey: the deal file slug, or the typed
 *   name) draws from its OWN stream, streamFor(groupKey, path, seed), seeded from a stable
 *   hash of the key, the base seed and the path index. So adding, removing or reordering one
 *   deal never moves another deal's futures, and any path can be replayed on its own.
 *   Per path and group, exactly two numbers are drawn, in this order: the timing offset
 *   (pick over CFG.timing), then the outcome (pickOutcome over the position's branches).
 *   Rows sharing a groupKey reuse the first row's draws within a path (one company, one fate).
 *   Anything that replays the engine's futures (markets.js privateCone) must call
 *   Engine.pathDraws(book, p) rather than copying the draw code.
 *
 * SIMPLIFICATIONS (stated, not bugs)
 *   - Annual calendar. Calls and exits are placed by year; quarters are dropped on purpose.
 *   - Capital calls and preferred returns are deterministic; only exit timing and outcome
 *     are random, and a preferred return is impaired by the same outcome draw (prefFactor).
 *   - Outcome tables are judgement calls kept in CFG where they can be argued with.
 *   - Deals are drawn independently of each other and of public markets (no common factor).
 *   - No tax, no fees beyond what a sponsor multiple already nets, no recallable capital.
 *
 * KNOWN LIMITS
 *   - irrOf brackets -99.99% to 1000%; outside it, or with more than one sign change, the
 *     result is null with a flag rather than a number.
 *   - A percent field cannot tell "1.5" meaning 1.5% from 150%: the rule in pctField() reads
 *     a bare number above 1 as a percent and warns. A real 150% coupon must be typed "150%".
 *   - Default year funded is this calendar year; a blank is reported by app.js validate().
 */

/* Seeded RNG (mulberry32). Seeded on purpose: the same book must never produce two
   different answers on two reads. An unstable number is worse than no number. */
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CFG = {
  /* The version the page shows bottom-left. It lives HERE, next to the assumptions it
     describes, so that changing the model and forgetting to change the label is awkward
     rather than easy. Bump the minor when an assumption moves: anyone comparing two runs
     needs to know they were produced by different models.
       v1.0  first public release
       v1.1  a diversified fund is no longer priced or timed like a single deal
       v1.2  a fund's sell-down is a window off its own terms, not a deal count
       v1.3  three tabs, shared deal files, and the tool is renamed Private Deals
       v1.4  bug sweep: short names no longer inherit another deal's terms; quotes in a
             deal name no longer break its card
       v1.5  a Fund / Single deal column, said outright instead of inferred; Asilia's
             shared terms flagged as under review after a holder caught them
       v1.6  Asilia rebuilt from the April 2026 offering, ACFE split into its own file,
             and an ambiguous name now matches nothing rather than guessing
       v1.7  the cone of outcomes, and a card that says which figures you typed over
       v1.8  three reading bugs found by a new regression suite: "8%" typed as text was
             read as 800%, a column headed "Type" lost its asset class, and a column
             headed "Funded year" was read as an amount
       v1.9  the two Asilia GC Fund offerings are separate deals; a card now says when a
             term is not the same for every holder, and prints the footnotes it was
             already carrying
       v1.10 where a sponsor prices by ticket size, the tool now picks your class from your
             commitment instead of telling you to work it out yourself
       v1.11 both Eephus funds rebuilt from their PPMs: the class ladders are real, and
             Fund II pays 9% at the top where Fund I stops at 8%
       v1.12 BlueBird rebuilt from its PPM and decks -- the terms were already right, the
             description of what it is was not
       v1.13 SpaceStation rebuilt from its Partnership Agreement, and a fund card now lists
             what the fund actually holds
       v1.14 a multiple nobody supplied is now flagged instead of passed off as a real one;
             Rainmaker documented
       v1.43 the example book carries Asilia's second capital call ($5,000, due 19 Oct 2026)
       v1.42 capital calls: none is ever placed in time already gone, a fund that calls at
             a known pace runs off at it, and the deal IRR uses the same schedule as the
             calls panel; the example book carries its real next calls
       v1.32 the app speaks in sleeves and portfolios, the way Growth Circle does
       v1.31 the dashboard prints the real outcome odds instead of describing them
       v1.30 a deal card reads in headed sections, and no longer shows where its
             figures were sourced from
       v1.29 Tovala documented
       v1.28 the maturity ladder prints the expected dollars over each block instead of
             hiding them in a tooltip
       v1.27 a yield on uncalled capital can now EXPIRE, because Asilia's comes from a
             subscription line that matures; Ancient Crunch's priced round recorded
       v1.26 Ancient Crunch documented; a venture deal can no longer carry a preferred
             return, which is how note interest would have been mispriced
       v1.25 deal data is tagged with the app version, so a release can no longer serve
             yesterday's deal list out of a browser cache
       v1.24 the preferred return accrues on capital actually CALLED, not on the whole
             commitment; Playhouse MD documented
       v1.23 a maturity and liquidity ladder, the three books side by side, and a tab
             listing every deal the tool knows with the names each one answers to
       v1.22 deal names are recognised the way people write them, and a position the tool
             cannot place now says so instead of going quiet
       v1.21 the example book no longer reports itself as an older tracker
       v1.20 the break-even year is marked on the cone itself, not only stated below it
       v1.19 the hold is shown beside every return figure. A size-against-speed scatter
             was tried in v1.18 and withdrawn the same day as too confusing to read
       v1.18 superseded within the day by v1.19; see that entry
       v1.17 a preferred return is no longer certain: it is impaired by the same outcome
             draw as the exit, so the fund that hands back less also pays less
       v1.16 IRR by deal, asset class and scenario; a Marked Up MOIC column that drives a
             paper track beside the cash line and never inside it
       v1.15 the three Asilia vehicles untangled, ACFE documented from its own pitch, and
             Rorra's hold corrected from 10 years to 4 */
  version: 'v1.51-proto',
  released: '13 Oct 2026',

  /* The TRACKER's version is the version of its COLUMNS, and moves only when they change.
     It was being conflated with the app's: v1.7 changed no columns, so the app's
     "older tracker" notice started telling people to look for a v1.7 stamp in a file that
     correctly says v1.6, and the only way to satisfy it would have been to make everyone
     re-download a spreadsheet identical to the one they already had. */
  trackerVersion: 'v1.8',

  /* Venture: the ten-deal power law. The last branch, 10%, is the sponsor's own
     projected multiple. That number is what the deal returns IF IT WORKS; using it as
     the expected value is the single commonest way these models become fiction.
     This is a SINGLE deal. A fund of them is a different distribution -- see below. */
  venture: [[0.30, 0.00], [0.30, 1.00], [0.30, 1.65]],

  /* Income sleeves: stabilized RE / PE / credit. A far tighter spread, and the branches
     SCALE the exit multiple rather than replacing it. Last branch, 15%, is the full
     exit. */
  income: [[0.05, 0.00], [0.25, 0.60], [0.55, 0.75]],

  /* REAL ESTATE THAT PAYS NO COUPON. Until v1.35 the table was chosen by one question --
     does the deal quote a coupon -- so Philo Hospitality Fund, a hospitality fund holding
     three properties with a 2.08x target, was priced as a single venture SPV at a 30% chance
     of returning nothing, and expected to return 1.003x over six years. Eephus, also real
     estate, quotes a pref and landed on the income table at 5%. Two real estate funds, a
     six-fold difference in loss probability, decided by whether the sponsor happened to
     quote a preferred return.

     Levered equity in property is neither. It can go to zero -- that is what a mortgage is
     for -- but nothing like one deal in three, and the outcome it actually produces most
     often is the one neither existing table has: a HAIRCUT. Three in ten getting 70 cents
     back is the shape of this asset class, and the income table has no branch for it.

     THE THIRD ELEMENT IS A FLAG, not a number. `true` means the multiple is ABSOLUTE rather
     than a fraction of the sponsor's target, because "three in ten below cost" is a claim
     about 1.0x: 0.45 of a 2.5x target is 1.13x, which is a gain. So the loss buckets are
     absolute and only the upside scales. The implicit top branch, 15%, is the sponsor case. */
  reEquity: [[0.10, 0.00, true], [0.30, 0.70, true], [0.45, 0.75, false]],

  /* LEVERAGE IS WHAT DECIDES WHETHER PROPERTY CAN GO TO ZERO, so the weights above are the
     reading at a reference LTV and the dial moves them. A 45%-LTV stabilised fund and an
     80%-LTV bridge-financed one do not share a downside, and pricing them the same is the
     same mistake as pricing Philo and a startup the same.

     Only the zero weight moves; what leaves it goes to the upside bucket, so the below-cost
     reading stays at three in ten across the range. No deal on file records an LTV yet, so
     every one of them runs at `ref` today and the card says so rather than implying the
     number came from the sponsor. */
  reLtv: { low: 0.50, ref: 0.65, high: 0.80, zeroLow: 0.04, zeroRef: 0.10, zeroHigh: 0.20 },

  /* A DIVERSIFIED VENTURE FUND is not a big venture deal, and treating it as one was a
     real error in this model. The single-deal table above carries a 30% chance of
     returning zero. For a fund holding 20+ companies that outcome requires all of them
     to fail at once: it is not conservative, it is impossible. Published fund data has
     no 0.00x in it at all.

     So funds get their own table, fitted to VC fund TVPI benchmarks -- p10 0.70x,
     p25 1.00x, p50 1.50x, p75 2.20x, p90 3.00x -- expressed as a fraction of the
     sponsor's target so it works for any fund. Like the income table it SCALES the
     target rather than replacing it, and the implicit top branch is the sponsor's own
     number, which lands around the 95th percentile. That is where a sponsor's target
     belongs: achievable, not the base case.

     Pooling maths alone would give the wrong answer here. Averaging 20 independent
     deals makes a fund look nearly risk-free, which is plainly false. Deals inside one
     fund share a vintage and managers differ, so pooling collapses the left tail
     without narrowing the right one. This table is fitted to what funds actually did,
     not to what averaging predicts. */
  fundVenture: [[0.10, 0.18], [0.15, 0.25], [0.25, 0.38], [0.25, 0.56], [0.15, 0.76]],

  /* A fund also does not exit ONCE. It sells down over several years: distributions
     build, peak, then tail off. For a tool whose whole job is to say WHEN cash arrives,
     dropping a fund's entire proceeds into a single year is the larger error of the two.

     That sell-down is a property of the DEAL, not of how many things it holds, so it is
     described by a LIQUIDITY WINDOW in fund-years rather than by a fixed table. Fund-years
     rather than calendar years so the window survives a change to the funding date.
     A GP who has told you "years five through eight" can say exactly that. */
  liqStart: 0.6,       // with nothing stated, a sell-down runs over the back 40% of the hold
  liqTailVenture: 2,   // venture funds run PAST the horizon; income funds wind up on it

  /* The deal COUNT is a separate question, and it decides only the outcome table. A
     position earns the FUND table once it is genuinely diversified; below that it is a
     handful of deals wearing a fund's name and the single-deal power law still fits. */
  fundMinDeals: 20,

  /* Exits slip and nothing makes them early, so the window is skewed late. The final
     5% rung is not padding: funds extend, and leaving it out is how a calendar quietly
     turns optimistic. */
  timing: [[0.20, -3], [0.50, 0], [0.25, 2], [0.05, 4]],

  callYears: 3,        // an uncalled commitment is drawn down over roughly this long
  /* THE DATE THE CALENDAR STANDS ON. null means today. A test pins it, because the
     current-year capital call depends on how much of the year is left (see callsOf). */
  asOf: (typeof process !== 'undefined' && process.env && process.env.PD_AS_OF) || null,
  paths: 6000,
  /* The bar width is what matters, not the bin count: at 0.10x a reader can see the
     shape. The range used to stop at 3.0x, which put 5.7% of futures -- one run in
     eighteen -- into a single bar jammed against the right edge, exactly where the
     interesting tail is. Extended to 4.5x and the bin count raised to match, so the
     bars are the same width and there is simply more chart. */
  /* HOW MUCH OF A PREFERRED RETURN ACTUALLY ARRIVES, by how the deal turned out.
     A preferred return is contractual, not guaranteed: a sponsor who is not earning can
     suspend it, and the fund most likely to suspend it is the fund that is also about to
     hand back less than plan. So this is keyed to the SAME outcome draw as the exit, not
     to an independent one. Shares of the scheduled preferred that get paid:
         equity written off      pays a couple of early years, then stops
         well below plan         most of it
         below plan              nearly all of it
         at or above plan        all of it
     These are judgements, not findings, and they are deliberately in CFG where they can be
     argued with rather than buried in the loop. */
  prefPaid: { writeOff: 0.25, wellBelow: 0.70, below: 0.90, onPlan: 1.00 },

  histBins: 40,
  histMax: 4.0,        // multiple on committed; anything above gathers into the last bin
  /* The base seed for every deal stream (see streamFor). Kept at the value the single shared
     stream used before 2026-10-31 so the number reads the same in old notes; the futures it
     produces did change once, when each deal got its own stream. */
  seed: 20260922,
  /* No longer read by the engine or app.js (2026-10-31): a blank year funded now means this
     calendar year. Kept so a caller that reads it does not break. */
  yearFrom: 2026,
  yearTo: 2042,
};

/* ── Building the book ──────────────────────────────────────────────────────
   One row in, one position out. Two rules do most of the work here.

   COMMITMENT IS THE BASIS. Exit proceeds are commitment x multiple, never
   funded-to-date x multiple, because the whole commitment is called long before any
   exit lands. On one real book, using funded understated the position by 48%.

   A COUPON IS ALREADY INSIDE THE MULTIPLE. A sponsor MOIC is total distributions over
   invested capital, so any preferred return paid along the way is part of it. Showing
   the coupon as its own row AND exiting at the full multiple counts that cash twice.
   Coupon-payers therefore exit on the RESIDUAL.

   buildBook(rows, opts) -> Position[]
     rows   tracker rows, already passed through applyDealFile where a deal file matched.
     opts   optional { warnings: [] }: every input correction is pushed there as
            { name, field, msg } as well as onto the position's own `warnings` array.
   Rows without a positive commitment are dropped (app.js reports them as skipped).
   Inputs are never trusted silently: anything out of range is corrected AND reported, so the
   screen can say which figure the model actually ran on (QA H5, H6, 2026-10-31). */
function buildBook(rows, opts) {
  const out = [];
  const sink = opts && Array.isArray(opts.warnings) ? opts.warnings : null;
  const thisYear = calendarNow().year;
  for (const r of rows) {
    const commitment = num(r.commitment);
    if (!(commitment > 0)) continue;
    const warnings = [];
    const name0 = String(r.name || 'Unnamed');
    const warn = (field, msg) => {
      warnings.push(msg);
      if (sink) sink.push({ name: name0, field, msg });
    };
    /* v1.42: FUNDED, UNCALLED AND COMMITMENT MUST TIE. A row with Uncalled typed and Funded
       left blank used to read as $0 funded, so $100k committed with $30k uncalled called only
       the $30k, paid its preferred return on $30k, exited on $100k, and solved an IRR on $30k
       going out. Funded is now derived from the other two when it is the one left blank.

       2026-10-31 (QA H6): THE THREE FIGURES ARE NOW KEPT IN RANGE, and every correction is
       reported. Before this, a negative funded figure went straight through (funded -$20k on a
       $100k commitment called $120k), and an uncalled figure larger than the commitment was
       called in full, so "still callable" could exceed "committed". The rules:
         funded    clamped to 0 .. commitment
         uncalled  clamped to 0 .. commitment - funded (what is left to call cannot exceed
                   what was committed and not yet paid in) */
    const hasFunded = r.funded != null && String(r.funded).trim() !== '';
    const hasUncalled = r.uncalled != null && String(r.uncalled).trim() !== '';
    const fundedIn = num(r.funded), uncalledIn = num(r.uncalled);
    if (hasFunded && fundedIn < 0) warn('funded', 'funded to date of ' + fmtMoney(fundedIn)
      + ' is negative, so it was read as $0');
    if (hasFunded && fundedIn > commitment) warn('funded', 'funded to date of ' + fmtMoney(fundedIn)
      + ' is more than the ' + fmtMoney(commitment) + ' committed, so it was capped at the commitment');
    if (hasUncalled && uncalledIn < 0) warn('uncalled', 'uncalled of ' + fmtMoney(uncalledIn)
      + ' is negative, so it was read as $0');
    const funded = (!hasFunded && hasUncalled)
      ? Math.max(0, commitment - Math.max(0, uncalledIn))
      : Math.max(0, Math.min(fundedIn, commitment));
    let uncalled = hasUncalled
      ? Math.max(0, uncalledIn)
      : Math.max(0, commitment - funded);
    if (uncalled > commitment - funded + 0.005) {
      warn('uncalled', 'uncalled of ' + fmtMoney(uncalled) + ' is more than the '
        + fmtMoney(commitment - funded) + ' left to call (' + fmtMoney(commitment)
        + ' committed less ' + fmtMoney(funded) + ' funded), so the model calls '
        + fmtMoney(commitment - funded));
      uncalled = Math.max(0, commitment - funded);
    }
    /* A hold of zero or less used to be taken as typed when negative (only 0 fell back),
       which put every preferred return and exit before the deal was funded. */
    const holdIn = num(r.hold);
    if (holdIn < 0) warn('hold', 'a hold of ' + holdIn + ' years is not possible, so 10 years was used');
    const hold = holdIn > 0 ? holdIn : 10;
    /* YEAR FUNDED. A blank used to mean CFG.yearFrom (2026) forever; it now means this
       calendar year, which is the same in 2026 and stays right after a year rollover.
       A typed year far outside a plausible range is still used but reported. */
    const fyIn = parseInt(r.yearFunded, 10);
    const fy = fyIn || thisYear;
    if (fyIn && (fyIn < 1980 || fyIn > thisYear + 5)) {
      warn('yearFunded', 'year funded ' + fyIn + ' looks mistyped; it was used as typed');
    }
    /* PERCENT FIELDS (QA H5): see pctField for the rule. */
    const coupon = pctField(r.coupon, 'preferred return', 'coupon', warn);
    /* WHEN NOBODY HAS GIVEN US A MULTIPLE.
       A venture row with no multiple and no coupon used to fall back to 5.0x in silence, and
       5.0x is not a neutral number -- it is a strong claim. Rainmaker is the case that made
       this matter: neither its offering documents nor the underwriting call produce a sponsor
       base case at all, because the deal is sold on multiple expansion rather than a
       projected MOIC. So anyone loading it got a confident 5.0x that no human ever said.
       The fallback stays (the model needs a number) but it is now FLAGGED, so the card can
       say the figure is the tool's convention rather than anybody's projection. */
    /* A negative multiple used to be taken as typed (only 0 fell through to the fallback),
       which simulated a deal that hands back less than nothing. */
    const moicIn = num(r.moic);
    if (moicIn < 0) warn('moic', 'a sponsor multiple of ' + moicIn + ' is not possible, so it was ignored');
    const moicGiven = moicIn > 0;
    const moic = moicGiven ? moicIn : (coupon ? 1 + coupon * hold : 5);
    const moicAssumed = !moicGiven && !(coupon > 0);

    // residual exit multiple, so the coupon is never double counted
    let exitMult = moic;
    if (coupon > 0) exitMult = Math.max(0.2, moic - coupon * hold);

    /* A CALL THE HOLDER ACTUALLY KNOWS ABOUT. Only the year is taken: the whole calendar is
       annual, so "Q1 2027" and "2027-03" and "2027" are the same instruction here, and
       pretending to hold the quarter would imply a precision nothing downstream uses. */
    const nextCallYear = callYearOf(r.nextCallDate);
    const nextCallAmt = Math.max(0, num(r.nextCallAmount));
    const likely = parseInt(r.exitLikely, 10) || (fy + hold);
    /* AN EXIT YEAR ALREADY GONE. exitPlan() lands it this year rather than dropping it (a
       position you still hold has not exited), which is right, but it used to happen in
       silence, so a typo of 2016 for 2026 looked like a normal exit. Display only. */
    if (parseInt(r.exitLikely, 10) && likely < thisYear) {
      warn('exitLikely', 'likely exit ' + likely + ' has already passed, so the model lands it in '
        + thisYear + ' or later');
    }
    const kind = coupon > 0 ? 'income' : 'venture';
    /* Read BEFORE the outcome table is chosen, because from v1.35 the table depends on both.
       It used to be computed on the way out, where nothing could act on it. */
    const cls = String(r.assetClass || (coupon > 0 ? 'Income' : 'VC'));
    /* LTV is a percent field too: 65 typed means 65%. Before 2026-10-31 a bare 65 was kept
       as 65 and reEquityTable() ignored anything at or above 1, silently. */
    const ltv = pctField(r.ltv, 'loan to value', 'ltv', warn);

    /* A MARKED-UP MOIC IS NOT A FORECAST INPUT, and this is the only place that has to be
       said in code, because everything downstream simply never reads it.
       A member's point, and a fair one: five to seven years is a long time to hold
       something with no signal at all, so a holder who tracks valuation increases wants to
       see them. The risk is that a paper gain leaks into a chart about cash. It cannot here.
       `markedUpMoic` is deliberately NOT folded into `moic`, `exitMult` or `branches`, so the
       simulation below cannot see it even by accident, and a tracker that leaves the column
       blank produces numbers identical to one from before the column existed.
       It is applied to FUNDED, never to commitment: you cannot have a paper gain on capital
       you have not sent. On a position with $75k in against a $250k commitment, marking the
       commitment up 2x would claim $500k of value on $75k of money. */
    const markedUpMoic = num(r.markedUpMoic) > 0 ? num(r.markedUpMoic) : null;

    /* How many underlying deals does this position hold? This decides the OUTCOME table
       only. Blank means one, because assuming diversification nobody declared would be
       inventing it. A blank is NOT the same as a typed 1: typing 1 is someone saying
       "this is one company", which is what opts a coupon-payer out of staging below. */
    const declared = r.deals != null && String(r.deals).trim() !== '';
    const deals = Math.max(1, Math.round(num(r.deals)) || 1);
    const diversified = deals >= CFG.fundMinDeals;

    /* which outcome table, and does it scale the target or replace it.
       REAL ESTATE IS TESTED BEFORE DIVERSIFICATION, because a real-estate fund holding
       twenty properties is still real estate -- letting fundVenture claim it would price a
       property portfolio off venture-fund TVPI benchmarks. */
    let branches = CFG.venture, scales = false;
    if (kind === 'income') { branches = CFG.income; scales = true; }
    else if (isRealEstate(cls)) { branches = reEquityTable(ltv); scales = true; }
    else if (diversified) { branches = CFG.fundVenture; scales = true; }

    /* DOES IT SELL DOWN, OR IS IT BOUGHT ONCE?
       A coupon-paying position is assumed to be a fund, because most of them are, and a
       fund sells down over years. Someone holding one company with a preferred return
       types 1 in the deals column to say so. Venture is the other way round: a single
       deal unless declared otherwise, which stays the cautious reading of a blank. */
    /* An explicit Fund / Single deal column, because asking people to express that as a
       COUNT was indirect. Someone who knows their position is a fund should be able to
       write "Fund" rather than work out how many properties are in it. A typed value here
       beats every inference below. The count still decides PRICING for venture at 20+;
       this decides only whether the payout is staged. */
    const typ = String(r.vehicle || '').trim().toLowerCase();
    const saysSingle = /^(single|spv|one |direct|company)/.test(typ) || typ === 'single deal';
    const saysFund = /fund|pool|syndicat|portfolio/.test(typ);

    const single = saysSingle || (!saysFund && declared && deals === 1);
    const isFund = saysFund ? true
      : saysSingle ? false
      : (kind === 'income' ? !single : deals > 1);
    const liq = isFund
      ? liqWindow(hold, num(r.liqFrom), num(r.liqTo), kind !== 'income')
      : null;

    out.push({
      name: String(r.name || 'Unnamed'),
      /* Empty string rather than a placeholder: the UI decides what to call an unassigned
         holding, and a model that invents the word "Unassigned" would have it turn up in
         exports and totals as though someone had typed it. */
      account: String(r.account || '').trim(),
      kind,
      cls,
      ltv,
      commitment, funded, uncalled, coupon, hold, fy, moic,
      nextCallYear, nextCallAmt,
      callPctPerYear: pctField(r.callPctPerYear, 'call pace', 'callPctPerYear', warn),
      nextCallRaw: String(r.nextCallDate || '').trim(),
      uncalledYieldPct: pctField(r.uncalledYieldPct, 'yield on uncalled', 'uncalledYieldPct', warn),
      uncalledYieldUntil: num(r.uncalledYieldUntil) || 0,
      exitMult, deals, isFund, diversified, branches, scales, liq, moicAssumed, moicGiven,
      markedUpMoic,                   // paper only; never reaches the simulation
      paperNav: markedUpMoic ? funded * markedUpMoic : funded,
      deal: r._deal || null,          // the shared file this matched, if any
      /* WHICH REAL-WORLD DEAL THIS ROW IS. Two tranches of one company share a fate and must
         share a draw. Keyed on the resolved file where there is one, because Eephus Growth
         Fund I and II are different funds with similar names and must stay independent; a row
         that matched nothing falls back to its own name so two hand-typed rows still group. */
      groupKey: (r._deal && r._deal.slug)
        || ('name:' + String(r.name || '').trim().toLowerCase()),
      overrides: r._ovr || [],        // fields the holder typed over that file
      tier: r._tier || null,          // the band this commitment landed in, if resolvable
      tierUnresolved: !!r._tierUnresolved,
      thesis: String(r.thesis || ''), // the holder's own words, from their tracker
      spread: liq ? liqSpread(hold, liq) : null,
      /* v1.48: display-only flags, never read by the simulation. A member typed an
         Exit: earliest on a fund and nothing moved, because a fund pays across its liquidity
         window and that window ignores it. The page now says so instead of staying quiet. */
      earliestTyped: parseInt(r.exitEarliest, 10) > 0,
      liqStated: num(r.liqFrom) > 0 || num(r.liqTo) > 0,
      earliest: parseInt(r.exitEarliest, 10) || (likely - Math.min(3, Math.max(1, Math.round(hold * 0.3)))),
      likely,
      latest: parseInt(r.exitLatest, 10) || (likely + 2),
      conviction: String(r.conviction || 'Medium'),
      warnings,                       // input corrections, in plain English, for the screen
    });
  }
  return out;
}

/* Every input warning in a book, as "Name: message" lines, in book order. app.js appends
   these to the "worth fixing" list it already shows after a load. */
function bookWarnings(book) {
  const out = [];
  for (const b of book || []) for (const w of (b.warnings || [])) out.push(b.name + ': ' + w);
  return out;
}

/* Whole dollars, for warning text only. The engine has no display layer; this exists so a
   warning can say "$120,000" rather than "120000". */
function fmtMoney(v) {
  const n = Number(v) || 0;
  return (n < 0 ? '-$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-US');
}

/* A PERCENT FIELD, READ ONE WAY EVERYWHERE (QA H5, 2026-10-31).
   The rule, in order:
     1. blank                         -> 0
     2. text containing "%"           -> divided by 100 ("8%" is 0.08, "0.5%" is 0.005)
     3. a bare number above 1         -> read as a percent and divided by 100 (8 is 8%),
                                         with a warning saying so
     4. a bare number from 0 to 1     -> already a decimal (0.08 is 8%, 1 is 100%)
     5. a negative number             -> 0, with a warning
   Why rule 3: before this, a plain 8 typed into an unformatted "Coupon %" cell, or a CSV
   column, was a preferred return of 800% a year; the Deals tab printed 800.0% and a $100k
   position simulated a median of $6.56M back, with no message. Nobody means 800%. The cost
   of the rule is that a real rate above 100% must be typed with its "%" sign.
   Deal files always carry decimals, so they are unaffected. `warn` is buildBook's reporter;
   pass null to read without reporting. */
function pctField(v, label, field, warn) {
  if (v == null || String(v).trim() === '') return 0;
  const hasSign = typeof v === 'string' && /%/.test(v);
  const n = num(v);
  if (!isFinite(n) || n === 0) return 0;
  if (n < 0) {
    if (warn) warn(field, 'a ' + label + ' of ' + String(v).trim() + ' is negative, so it was read as 0');
    return 0;
  }
  if (!hasSign && n > 1) {
    if (warn) warn(field, 'a ' + label + ' of ' + String(v).trim() + ' was read as '
      + n + '% (' + String(+(n / 100).toFixed(8)) + '). Type it with a % sign, or as a decimal, '
      + 'and this note goes away');
    return n / 100;
  }
  return n;
}

/* The liquidity window for a position, as [firstYear, lastYear] in FUND-YEARS from
   funding. A stated window always wins -- a GP who says "years five through eight" is
   better information than any rule. Otherwise the back of the hold. */
function liqWindow(hold, from, to, isVenture) {
  const a = from > 0 ? Math.round(from) : Math.max(1, Math.round(hold * CFG.liqStart));
  const b = to > 0 ? Math.round(to) : hold + (isVenture ? CFG.liqTailVenture : 0);
  return [a, Math.max(a, b)];
}

/* That window as offsets from the exit year, with weights. Weights ramp up across it:
   a sell-down starts slowly and the largest payment is usually the last one. They sum
   to 1, so staging MOVES money between years and never creates any. */
function liqSpread(hold, win) {
  const n = Math.max(1, win[1] - win[0] + 1);
  const out = [];
  let tot = 0;
  for (let i = 0; i < n; i++) { tot += i + 2; out.push([win[0] + i - hold, i + 2]); }
  for (let i = 0; i < n; i++) out[i][1] /= tot;
  return out;
}

function num(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const raw = String(v).trim();
  const n = parseFloat(raw.replace(/[$,%\s]/g, ''));
  if (!isFinite(n)) return 0;
  /* A PERCENT SIGN MEANS PERCENT.
     This used to strip the sign and keep the number, so "8%" became 8 -- a coupon of 800%
     a year, on a book that still rendered perfectly. Excel hides the problem, because a
     percent-formatted cell holds 0.08 and arrives here as a number. A CSV does not: export
     that same cell from Numbers or Excel and it is written out as the TEXT "8%", which is
     the documented route for anyone on a Mac. So the bug only ever hit the members least
     able to spot it. */
  if (/%/.test(raw)) return n / 100;
  return n;
}

/* "Q1 2027", "2027-03", "March 2027", 2027. Only the YEAR is wanted, because the calendar
   this feeds is annual, so a quarter would be precision nothing downstream can use. Forgiving
   on purpose: nobody keeps a spreadsheet to someone else's date format. */
function callYearOf(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number' && v >= 1900 && v <= 2200) return Math.round(v);
  const m = String(v).match(/(19|20|21)\d{2}/);
  const y = m ? Number(m[0]) : 0;
  return y >= 1900 && y <= 2200 ? y : 0;
}

/* Capital calls are contractual, so they are deterministic and never simulated. They are also
   the only movement on this whole calendar you actually KNOW about -- and until v1.38 the tool
   would not listen when you did. A holder who can name the date and the amount gets exactly
   that; the even spread is the fallback for everyone else. */
/* ONE POSITION'S CALLS, BY YEAR. Expressed once and consumed twice, by the capital-calls
   panel and by the preferred return, because those two disagreed for a day and a member found
   it: v1.38 taught the schedule about the Next call date column and did not teach calledBy(),
   so the panel said nothing arrived before 2027 while the coupon was paid as though a third
   had arrived the year before. Reported by a member on 2026-10-02, on her own book,
   and she was right to the dollar. */
/* TODAY, as a calendar year and the share of it still ahead. Day-granular, so two renders on
   one day agree, and the same arithmetic APEX uses for its year-end stub. */
function calendarNow() {
  const d = CFG.asOf ? new Date(String(CFG.asOf).slice(0, 10) + 'T00:00:00') : new Date();
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const yearEnd = new Date(today.getFullYear(), 11, 31);
  return { year: today.getFullYear(),
           left: Math.max(0, Math.min(1, (yearEnd - today) / (365.25 * 24 * 3600 * 1000))) };
}

/* v1.42: TWO RULES THIS FUNCTION DID NOT KNOW.
   (1) THE UNCALLED BALANCE IS WHAT IS LEFT AS OF TODAY, so none of it can be called in time
   that has already gone. The even spread started the year after funding wherever "today"
   was, so a 2025 commitment put a full third of its uncalled balance in 2026 -- including the
   months already behind the reader -- and the panel had to bolt on an "about $10k still
   ahead" note to apologise for it. SpaceStation read -$58,333 for 2026 against the one
   $12,500 call actually left. Now a modelled spread that would begin in the past begins
   TODAY: the current year carries only the share of a year still ahead, and the tail runs
   into the year after the window would have closed. Totals are unchanged; only when moves.
   A stated next call dated in the past lands in the current year, not in a year nobody can
   pay into.
   (2) A FUND THAT CALLS AT A KNOWN PACE. SpaceStation has called 5% of commitment every
   quarter. `callPctPerYear` (from the deal file, or typed) runs the balance off at that pace
   instead of an even three-year spread. */
function callsOf(b) {
  const out = {};
  if (!(b.uncalled > 0)) return out;
  const add = (y, v) => { if (v > 0.005) out[y] = (out[y] || 0) + v; };
  const now = calendarNow();
  const pace = (b.callPctPerYear > 0 && b.commitment > 0) ? b.callPctPerYear * b.commitment : 0;
  /* Run `amt` off at the pace from year y0, of which only `first` (0..1) of a year is left. */
  const runOff = (amt, y0, first) => {
    let left = amt, y = y0, share = first;
    for (let k = 0; left > 0.005 && k < 80; k++) {
      const c = Math.min(left, pace * share);
      add(y, c); left -= c; y++; share = 1;
    }
  };
  /* Spread `amt` evenly over CFG.callYears years starting at y0, the first of which has only
     `first` of a year left; whatever that first year cannot take lands after the window. */
  const spread = (amt, y0, first) => {
    const per = amt / CFG.callYears;
    add(y0, per * first);
    for (let k = 1; k < CFG.callYears; k++) add(y0 + k, per);
    add(y0 + CFG.callYears, per * (1 - first));
  };
  const place = pace > 0 ? runOff : spread;
  const stated = Math.min(b.nextCallAmt || 0, b.uncalled);
  if (b.nextCallYear && stated > 0) {
    const y = Math.max(b.nextCallYear, now.year);
    add(y, stated);
    const rest = b.uncalled - stated;
    if (rest > 0.005) place(rest, y + 1, 1);
    return out;
  }
  /* A stated amount with no date cannot be placed in a year, and choosing one would invent the
     very thing the column exists to stop. It falls through to the modelled spread, and
     callNotes() makes sure that is said rather than silently done. A DATE with no amount still
     says the most important thing: nothing arrives before it. */
  if (b.nextCallYear) { place(b.uncalled, Math.max(b.nextCallYear, now.year), b.nextCallYear > now.year ? 1 : now.left); return out; }
  const start = b.fy + 1;
  if (start > now.year) place(b.uncalled, start, 1);
  else place(b.uncalled, now.year, now.left);
  return out;
}

/* Everything called up to and including a year, which is the base a preferred return accrues
   on. Derived from callsOf so it cannot drift from the schedule on screen. */
function callsCumulative(b, year) {
  const c = callsOf(b);
  let acc = b.funded;
  for (const y of Object.keys(c)) if (Number(y) <= year) acc += c[y];
  return Math.min(acc, b.commitment);
}

/* callSchedule(book, years) -> { [year]: total capital called that year across the book }.
   Deterministic, built from callsOf() per position; years outside `years` are left out, so
   pass gridYears(book) to see everything. Calls are positive numbers here (money going out);
   the UI prints them with a minus sign. */
function callSchedule(book, years) {
  const out = {};
  for (const y of years) out[y] = 0;
  for (const b of book) {
    const c = callsOf(b);
    for (const y of Object.keys(c)) if (out[y] != null) out[y] += c[y];
  }
  return out;
}

/* What the schedule above did with what it was told, so the screen can say so. A column
   someone filled in that quietly changed nothing is worse than no column at all. */
function callNotes(book) {
  const stated = [], undated = [];
  for (const b of book) {
    if (b.uncalled <= 0) continue;
    if (b.nextCallYear) {
      stated.push({ name: b.name, year: b.nextCallYear, raw: b.nextCallRaw,
        amount: Math.min(b.nextCallAmt || 0, b.uncalled) });
    } else if (b.nextCallAmt > 0) {
      undated.push({ name: b.name, amount: b.nextCallAmt });
    }
  }
  return { stated, undated };
}

/* Preferred returns, also deterministic. This is the most optimistic assumption in the
   model and the app says so on screen: a sponsor CAN suspend a coupon, and if that is
   on the table the income sleeve's floor is softer than it looks here. */
/* The share of a position's scheduled preferred return that gets paid, given the exit
   multiple drawn for it on this path. `m` is the already-drawn outcome, so no extra random
   number is taken and the draw order -- and therefore every existing figure that does not
   involve a preferred return -- is untouched. */
function prefFactor(b, m) {
  if (!(b.coupon > 0)) return 0;
  const P = CFG.prefPaid;
  /* For an income position the table SCALES the sponsor's multiple, so m / exitMult
     recovers the band that was drawn: 0 for a write-off, up to 1 for the full case. */
  const r = (b.scales && b.exitMult > 0) ? (m / b.exitMult) : (m > 0 ? 1 : 0);
  if (!(r > 0.001)) return P.writeOff;
  if (r < 0.65) return P.wellBelow;
  if (r < 0.95) return P.below;
  return P.onPlan;
}

/* HOW MUCH CAPITAL IS ACTUALLY IN, at the end of year fy+k.
   Raised by a member, 27 Sep 2026: the tool was paying the headline rate on the
   WHOLE commitment from year one, while most of it was still uncalled. On a fully funded
   position that is right and changes nothing. On Asilia GC Fund -- $100,000 committed
   against $19,000 funded -- it was the most generous of every possible reading, and worth
   $9,720 of preferred return that had not been earned yet.

   A commitment is drawn over CFG.callYears, so the base the preferred return is paid on
   ramps with it. What the UNCALLED balance earns in the meantime is a separate, much lower
   rate: see uncalledYield. */
function calledBy(b, k) {
  if (k <= 0) return b.funded;
  if (!(b.uncalled > 0)) return b.commitment;
  /* NOT its own copy of the ramp. It had one until 2026-10-02 and that copy never learned
     about the Next call date column, so a holder who told the tool her next call was Q1 2027
     still had a coupon paid on a third of her commitment in 2026. */
  return callsCumulative(b, b.fy + k);
}

/* Some funds pay a small yield on money you have committed but they have not called, so it
   is not sitting idle. Asilia's sessions describe this for ACFE. It is NOT the headline
   rate and must never be confused with it, so it is a separate term with its own default
   of zero: a fund that has not told us it does this is assumed not to. */
function uncalledYield(b) {
  const y = Number(b.uncalledYieldPct);
  return isFinite(y) && y > 0 ? y : 0;
}

/* HOW MUCH OF YEAR y THE UNCALLED YIELD IS STILL BEING PAID FOR.
   A yield on uncalled money is usually not a property of the investment at all -- it is a
   property of the fund's SUBSCRIPTION LINE, which is borrowing, and borrowing matures.
   Asilia's line matures at the end of June 2027, so ACFE pays ~6-7% on uncalled capital
   until then and nothing after.

   Without this the rate applied for the whole hold, which would have run a temporary
   financing arrangement out to 2034 and invented seven years of income. Expressed as a
   decimal year, so mid-2027 is 2027.5 and the last year is counted as the half of it that
   was actually earned. No date means no expiry, which is the right default for a genuine
   term rather than a facility. */
function uncalledYieldShare(b, y) {
  const until = Number(b.uncalledYieldUntil);
  if (!isFinite(until) || until <= 0) return 1;
  return Math.max(0, Math.min(1, until - y));
}

/* What a position pays in preferred return in year fy+k: the headline rate on the capital
   actually called, plus whatever the uncalled balance earns. */
function prefInYear(b, k) {
  if (!(b.coupon > 0)) return 0;
  const inSoFar = calledBy(b, k);
  const outstanding = Math.max(0, b.commitment - inSoFar);
  /* The yield on what is still uncalled can expire before the hold does. */
  const share = uncalledYieldShare(b, b.fy + k);
  return inSoFar * b.coupon + outstanding * uncalledYield(b) * share;
}

function couponSchedule(book, years) {
  const out = {};
  for (const y of years) out[y] = 0;
  for (const b of book) {
    if (!(b.coupon > 0)) continue;
    for (let k = 1; k <= b.hold; k++) {
      const y = b.fy + k;
      if (out[y] != null) out[y] += prefInYear(b, k);
    }
  }
  return out;
}

/* ── IRR ────────────────────────────────────────────────────────────────────
   Money-weighted, which is the right convention for private deals: the holder does not
   choose when capital is called or returned.

   THIS IS A CASH IRR. It counts distributions actually received and no paper marks at
   all, so it is a DPI-based figure and it will read LOWER than a sponsor's reported IRR,
   which includes unrealised carrying value. That difference is the whole point and the
   Background tab says so.

   Bisection rather than Newton: Newton is fragile near the total-loss boundary, and the
   bracket here is known. 60 iterations on a bracket of 11 is well under a basis point.

   irrOf(flows, t0) -> { r, flag }
     flows  [[year, amount]], negative = money in, positive = money back; same years add
     t0     the year discounting starts from
     r      annual rate as a decimal, or null when there is no single honest answer
     flag   'ok' | 'no-contribution' (r null) | 'total-loss' (r -1) | 'above-bracket' (r null)
            | 'multi-sign' (r null) | 'loan-shaped' (r null, added 2026-10-31: money back
            BEFORE money in, with nothing back after; it used to be labelled a total loss) */
function irrOf(flows, t0) {
  let anyPos = false, anyNeg = false;
  for (const f of flows) { if (f[1] > 1e-9) anyPos = true; if (f[1] < -1e-9) anyNeg = true; }
  /* Four outcomes that are NOT zero, and showing 0% for any of them would be a lie:
     no contribution at all is undefined; contributions with nothing back is exactly
     -100%; a return that exceeds the bracket is UNDEFINED, not the bracket; and a stream
     that changes direction more than once has several roots and no single answer. */
  if (!anyNeg) return { r: null, flag: 'no-contribution' };
  if (!anyPos) return { r: -1, flag: 'total-loss' };
  const byT = {};
  for (const f of flows) byT[f[0]] = (byT[f[0]] || 0) + f[1];
  const ts = Object.keys(byT).map(Number).sort((a, b) => a - b);
  /* A stream that changes sign more than once can have several real roots, so IRR is
     genuinely ambiguous there, and silently returning whichever root bisection lands on
     would be worse than saying so.

     IT OCCURS. An earlier version of this comment said it did not -- "zero cases in 78,000
     deal-runs" -- and that was true of the books tested, all of which were close to fully
     funded. A member found it on 2026-10-01 by holding ACFE mostly uncalled: the
     preferred return starts arriving while the capital is still in her pocket, so the early
     years are net positive and the outflows come later. Any coupon-payer with a large
     uncalled balance can do it. */
  let changes = 0, prev = 0;
  for (const t of ts) {
    const sg = byT[t] > 1e-9 ? 1 : (byT[t] < -1e-9 ? -1 : 0);
    if (sg !== 0 && prev !== 0 && sg !== prev) changes++;
    if (sg !== 0) prev = sg;
  }
  const npv = (rate) => {
    let acc = 0;
    for (const t of ts) acc += byT[t] / Math.pow(1 + rate, t - t0);
    return acc;
  };
  let lo = -0.9999, hi = 10;
  /* npv at -99.99% is dominated by the LAST flows, so a negative value means the stream ends
     with money going out. When the stream also STARTED with money going in, that is a total
     loss. When it started with money coming back (a preferred return or uncalled yield paid
     before the calls, then nothing at the exit), it has the shape of a loan, and -100% would
     be a false statement (audit M-26). */
  if (npv(lo) < 0) {
    const first = ts.find((t) => Math.abs(byT[t]) > 1e-9);
    return byT[first] > 0 ? { r: null, flag: 'loan-shaped' } : { r: -1, flag: 'total-loss' };
  }
  /* NOT `{ r: hi }`. Returning the ceiling printed "1000.0%" in the by-deal table, which a
     reader quite reasonably took for a 1000% return rather than for the solver giving up. */
  if (npv(hi) > 0) return { r: null, flag: 'above-bracket' };
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (npv(mid) > 0) lo = mid; else hi = mid;
  }
  if (changes > 1) return { r: null, flag: 'multi-sign' };
  return { r: (lo + hi) / 2, flag: 'ok' };
}

/* One position's signed cash flow for one path, built from its TERMS rather than from the
   display grid. The grid starts at this year (gridYears); a position funded before that would lose
   its early calls to the grid's bounds, and an IRR missing its first contributions is
   flattering. So this reads b.fy directly and is unaffected by the calendar on screen.
   `off` and `m` are the draws the simulation has already made for this path, passed in so
   that IRR and the cone describe the SAME futures and no extra number is drawn. */
function dealStream(b, off, m) {
  const f = [[b.fy, -b.funded]];
  /* v1.42: the call schedule, not a third copy of the even ramp. This one never learned about
     the Next call date column, so a deal's IRR was solved on calls the panel beside it did not
     show. */
  const cs = callsOf(b);
  for (const y of Object.keys(cs)) f.push([Number(y), -cs[y]]);
  if (b.coupon > 0) {
    /* Impaired by the same draw the exit uses. An IRR computed on a preferred return that
       never fails would disagree with the cash tables beside it. */
    const pf = prefFactor(b, m);
    if (pf > 0) {
      for (let k = 1; k <= b.hold; k++) f.push([b.fy + k, prefInYear(b, k) * pf]);
    }
  }
  const cash = b.commitment * m;
  if (cash > 0) for (const [y, w] of exitPlan(b, off)) f.push([y, cash * w]);
  return f;
}

/* WHERE ONE POSITION'S EXIT CASH LANDS, as [[year, share]] summing to 1, for a timing draw
   `off`. ONE helper for the simulation, the IRR stream and the ladder, which each had their
   own copy until v1.42 and did not agree at the edges:
   - an exit is never placed in a year that has already ended. A position you still hold has
     not exited, so a 2019 deal whose "early" draw said 2023 lands this year rather than
     vanishing off the front of the calendar (it was dropped outright, which put the
     Performance mean 20% under the Dashboard's expectation on such a book);
   - a sell-down tranche before this year is folded into the years still ahead, renormalised,
     so staging still only MOVES money; a window entirely in the past lands this year. */
function exitPlan(b, off) {
  const now = calendarNow().year;
  const ey = b.likely + (off || 0);
  if (!b.spread || !b.spread.length) return [[Math.max(ey, now), 1]];
  let ws = 0;
  for (const [d, w] of b.spread) if (ey + d >= now) ws += w;
  if (!(ws > 0)) return [[now, 1]];
  const out = [];
  for (const [d, w] of b.spread) if (ey + d >= now) out.push([ey + d, w / ws]);
  return out;
}

/* THE CALENDAR'S YEARS: from this year to whichever is later, CFG.yearTo or the last year
   anything in this book can land -- the latest exit draw plus its sell-down, the last call,
   the last preferred-return year. A fixed 2042 end silently dropped a long fund's tail.
   gridYears(book) -> [thisYear, thisYear + 1, ..., lastYear], never empty, never in the past.
   Every per-year array in simulate() is indexed against this list. */
function gridYears(book) {
  const from = calendarNow().year;
  let to = Math.max(CFG.yearTo, from);
  const lateOff = CFG.timing.reduce((a, t) => Math.max(a, t[1]), 0);
  for (const b of book || []) {
    for (const [y] of exitPlan(b, lateOff)) to = Math.max(to, y);
    for (const y of Object.keys(callsOf(b))) to = Math.max(to, Number(y));
    if (b.coupon > 0) to = Math.max(to, b.fy + b.hold);
  }
  const years = [];
  for (let y = from; y <= to; y++) years.push(y);
  return years;
}

/* The sponsor's own case as an IRR: their multiple, at the likely exit, with the real call
   and coupon schedule. Deterministic, and it exists because of a genuine blind spot -- the
   single-deal venture table puts the sponsor's multiple in the top 10% only, so at every
   percentile at or below P90 it is invisible. Four deals with multiples from 5.5x to 14.2x
   otherwise print an identical number, which is true to the model and reads as a bug. */
function sponsorCaseIrr(b) {
  return irrOf(dealStream(b, 0, b.exitMult), b.fy).r;
}

/* What the holder says their positions are worth now. Cost basis for anything unmarked, so
   this is never inflated by absence. Kept entirely separate from every cash figure. */
function paperTrack(book) {
  let cost = 0, nav = 0, marked = 0;
  for (const b of book) {
    cost += b.funded;
    nav += b.paperNav != null ? b.paperNav : b.funded;
    if (b.markedUpMoic) marked++;
  }
  return {
    cost, nav, gain: nav - cost, marked, positions: book.length,
    multiple: cost > 0 ? nav / cost : 0,
  };
}

/* Real estate by ASSET CLASS, which is the thing the outcome distribution actually depends
   on. Deliberately not a list of slugs: the point of v1.35 is that a deal no longer gets a
   distribution because of how it was spelled. */
function isRealEstate(cls) {
  return /real\s*estate|property|multifamily|self.?storage|hospitality/i.test(String(cls || ''));
}

function pick(rnd, branches, fallback) {
  const r = rnd();
  let acc = 0;
  for (const [p, v] of branches) {
    acc += p;
    if (r <= acc) return v;
  }
  return fallback;      // the top branch, which the table deliberately leaves implicit
}

/* The same draw, but it also reports whether the branch it landed on states an ABSOLUTE
   multiple. Separate from pick() above rather than a wider return type, because pick() is
   also what draws the timing offset and widening it there would be change for nothing.

   It takes exactly ONE number from the generator, like pick(), so every seed produces the
   identical draw it did before this existed. That is load-bearing: the whole suite compares
   figures across versions, and a table nobody edited must not move because the draw did. */
function pickOutcome(rnd, branches) {
  const r = rnd();
  let acc = 0;
  for (const br of branches) {
    acc += br[0];
    if (r <= acc) return { v: br[1], abs: br[2] === true };
  }
  return { v: null, abs: false };     // the implicit top branch: the sponsor's own case
}

/* ── One random stream per deal (audit M-02, 2026-10-31) ─────────────────────
   Until this date simulate() drew from ONE sequential stream: two numbers per deal per path,
   deals in book order. Adding a single $1 deal therefore shifted every later draw, so 399 of
   400 paths of the EXISTING book became different futures, and the Deal tester's "with and
   without" comparison measured that reshuffle rather than the deal (ending wealth moved
   $140k for a $1 deal).

   Now each deal group owns its draws. The stream for (groupKey, path) is seeded from a stable
   32-bit hash of the key, the base seed and the path index, so:
     - adding, removing or reordering a deal never moves another deal's futures;
     - any single path can be replayed without replaying the ones before it;
     - two runs of the same book still agree exactly.
   APEX's retirement simulator isolates its venture draws for the same reason. */

/* FNV-1a, 32-bit. Stable across engines and sessions, which is all it needs to be. */
function hashKey(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/* The finaliser from MurmurHash3: spreads nearby inputs (path 41, path 42) far apart, so
   mulberry32's first outputs for neighbouring seeds are not correlated. */
function mix32(h) {
  h = h >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/* streamFor(key, path, seed) -> a seeded generator (same shape as makeRng) for one deal
   group on one path. `seed` defaults to CFG.seed. This is THE place a deal's randomness comes
   from; anything that replays the engine (markets.js privateCone) must use it, or better,
   pathDraws() below, rather than copying the draw code. */
function streamFor(key, path, seed) {
  const base = (seed == null ? CFG.seed : seed) >>> 0;
  const s = mix32(mix32(hashKey(key) ^ base) + Math.imul((path >>> 0) + 1, 0x9E3779B9));
  return makeRng(s);
}

/* The multiple one position exits on, given its drawn outcome. Shared by simulate() and any
   replay so the scaling rule exists once:
     null branch            -> the full residual exit (the sponsor's case)
     scaling table, not abs -> branch value x residual exit
     otherwise              -> the branch value as an absolute multiple */
function outcomeMultiple(b, drawn) {
  let m = drawn.v;
  if (m === null) m = b.exitMult;
  else if (b.scales && !drawn.abs) m = m * b.exitMult;
  return m;
}

/* pathDraws(book, p, seed) -> [{ off, drawn, m }] in book order, for path p.
     off    timing offset in years from the likely exit (from CFG.timing)
     drawn  { v, abs } outcome branch (from the position's own table)
     m      the multiple on commitment this path exits on (outcomeMultiple)
   Exactly two numbers per deal GROUP per path, timing first, then outcome, from that group's
   own stream. Rows sharing a groupKey (tranches of one company) reuse the first row's off and
   drawn within the path, so one company has one fate; m is still computed per row, from that
   row's own exit multiple. */
function pathDraws(book, p, seed) {
  const drawnBy = {};
  const out = new Array(book.length);
  for (let bi = 0; bi < book.length; bi++) {
    const b = book[bi];
    let d = drawnBy[b.groupKey];
    if (!d) {
      const rnd = streamFor(b.groupKey, p, seed);
      const off = pick(rnd, CFG.timing, 4);
      const drawn = pickOutcome(rnd, b.branches);
      d = drawnBy[b.groupKey] = { off, drawn };
    }
    out[bi] = { off: d.off, drawn: d.drawn, m: outcomeMultiple(b, d.drawn) };
  }
  return out;
}

/* The real-estate table at a given LTV. Above the reference more of the weight sits in the
   zero bucket and below it less, taken from and returned to the upside bucket so the
   below-cost reading does not drift. An LTV nobody recorded returns the table unchanged. */
function reEquityTable(ltv) {
  const T = CFG.reEquity, L = CFG.reLtv;
  const v = Number(ltv);
  if (!(v > 0) || !(v < 1)) return T;
  const zero = v <= L.low ? L.zeroLow
    : v >= L.high ? L.zeroHigh
    : v <= L.ref ? L.zeroLow + (L.zeroRef - L.zeroLow) * (v - L.low) / (L.ref - L.low)
    : L.zeroRef + (L.zeroHigh - L.zeroRef) * (v - L.ref) / (L.high - L.ref);
  const shift = zero - T[0][0];
  return [[zero, T[0][1], T[0][2]], [T[1][0], T[1][1], T[1][2]],
    [Math.max(0, T[2][0] - shift), T[2][1], T[2][2]]];
}

/* ── The simulation ─────────────────────────────────────────────────────────
   Each trial plays one complete future: every position draws an exit YEAR and an
   OUTCOME, and the cash lands in that year. Then the whole future is summed.

   That ordering is the important part. Percentiles taken per YEAR rank each year
   separately, so the future sitting in the middle in one year is a different future
   from the middle one in another, and those columns CANNOT be added. Percentiles taken
   on the CUMULATIVE totals rank whole futures once, so those can. Same word, opposite
   behaviour.

   simulate(book, opts) -> Result (shape in the header), or null for an empty book.
     opts.paths         number of futures (default CFG.paths, 6000)
     opts.seed          base seed for every deal stream (default CFG.seed)
     opts.capturePaths  also return pathRows[path][yearIndex], for the runway
     opts.irr           also solve IRRs (off by default; everything else is identical)
   Path p of deal d is the same future whatever else is in the book (see pathDraws). */
function simulate(book, opts) {
  opts = opts || {};
  const paths = opts.paths || CFG.paths;
  if (!book.length) return null;
  const years = gridYears(book);

  /* The CONTRACTUAL schedule, still computed, because a reader wants to know what was
     promised as well as what the model expects to arrive. It is no longer what gets paid. */
  const couponSched = couponSchedule(book, years);
  const calls = callSchedule(book, years);
  const per = {}, cum = {}, cpn = {};
  for (const y of years) { per[y] = []; cum[y] = []; cpn[y] = []; }

  /* Per-PATH yearly proceeds, recorded only when asked. The runway spends one coherent
     future at a time, so it cannot use the per-year medians: those rank each year
     separately, and adding them down builds a future nobody had. Off by default so no
     existing caller allocates a paths-by-years matrix it never reads. */
  const pathRows = opts.capturePaths ? [] : null;
  const cpnTotals = [];
  const totals = [];
  /* No shared generator any more: each deal group draws from its own stream (pathDraws). */
  const seed = opts.seed != null ? opts.seed : CFG.seed;

  /* IRR is OPT-IN, and that is deliberate rather than lazy. Everything below this point
     runs unchanged when it is off, so a caller that does not ask for IRR gets byte-for-byte
     the output it got before IRR existed. The regression golden depends on that. */
  const wantIrr = !!opts.irr;
  const irrDeal = wantIrr ? book.map(() => []) : null;
  const irrPort = [];
  const irrClass = {};
  const irrFlags = {};
  const dealFlags = [];
  const classT0 = {};
  if (wantIrr) {
    for (const b of book) {
      if (irrClass[b.kind] == null) { irrClass[b.kind] = []; classT0[b.kind] = b.fy; }
      if (b.fy < classT0[b.kind]) classT0[b.kind] = b.fy;
    }
  }
  const bookT0 = book.reduce((a, b) => Math.min(a, b.fy), Infinity);

  for (let p = 0; p < paths; p++) {
    const yr = {};
    const cp = {};
    for (const y of years) { yr[y] = 0; cp[y] = 0; }
    const pooled = wantIrr ? [] : null;
    const classFlows = {};
    /* ONE COMPANY, ONE FATE. Two tranches of the same deal drew independently until
       2026-10-02, so a single future could write one off and pay the other 14.2x. The draw
       and the timing jitter are taken once per deal GROUP per path and reused (pathDraws
       resets its cache every path: a shared fate is shared WITHIN one future); the exit YEAR
       is not shared, because that comes from each row's own stated dates and overruling a
       holder's input is not this tool's job. */
    const draws = pathDraws(book, p, seed);
    for (let bi = 0; bi < book.length; bi++) {
      const b = book[bi];
      const off = draws[bi].off;
      const m = draws[bi].m;
      const cash = b.commitment * m;

      /* The preferred return for THIS future, impaired by how this deal went. Added to the
         same yr[] bucket the exit proceeds use, so everything downstream -- the cumulative
         table, the totals, the cone, the histogram -- sees one number and cannot disagree
         with itself. */
      if (b.coupon > 0) {
        const pf = prefFactor(b, m);
        if (pf > 0) {
          for (let k = 1; k <= b.hold; k++) {
            const y = b.fy + k;
            if (yr[y] != null) {
              const amt = prefInYear(b, k) * pf;
              yr[y] += amt;
              cp[y] += amt;
            }
          }
        }
      }

      /* BEFORE the early return below, because a position that returns nothing is not an
         absence of data -- it is a -100% IRR, and it is 30% of the outcomes for a single
         venture deal. Skipping it here would quietly drop the entire left tail. */
      if (wantIrr) {
        const fl = dealStream(b, off, m);
        const res = irrOf(fl, b.fy);
        irrDeal[bi].push(res.r);
        irrFlags[res.flag] = (irrFlags[res.flag] || 0) + 1;
        /* PER DEAL as well as in total. The global tally existed from the start and nothing
           ever displayed it, so a position whose rate of return could not be computed looked
           exactly like one whose could. The table has to be able to say WHICH deal and WHY. */
        if (!dealFlags[bi]) dealFlags[bi] = {};
        dealFlags[bi][res.flag] = (dealFlags[bi][res.flag] || 0) + 1;
        for (const f of fl) pooled.push(f);
        if (classFlows[b.kind] == null) classFlows[b.kind] = [];
        for (const f of fl) classFlows[b.kind].push(f);
      }
      if (!(cash > 0)) continue;
      /* A fund sells down over several years rather than exiting on one date. The window can
         run off the front of the calendar -- a 2027 exit staged from two years earlier starts
         in 2025 -- so the in-range weights are renormalised rather than the stray tranche
         being dropped (that once deleted 0.12% of the book's mean). exitPlan() does it, for
         this loop, the IRR stream and the ladder alike, and the grid is sized to the book so
         nothing falls off the far end either. */
      for (const [y, w] of exitPlan(b, off)) if (yr[y] != null) yr[y] += cash * w;
    }
    let run = 0, tot = 0;
    let cpTot = 0;
    for (const y of years) {
      const v = yr[y];
      per[y].push(v);
      cpn[y].push(cp[y]);
      cpTot += cp[y];
      run += v; cum[y].push(run);
      tot += v;
    }
    totals.push(tot);
    cpnTotals.push(cpTot);
    if (pathRows) pathRows.push(years.map((y) => yr[y]));

    /* THE RULE THIS WHOLE FEATURE TURNS ON. A portfolio IRR is the IRR of the pooled cash
       flow, solved ONCE per run and only then ranked across runs. It is not the average of
       the deals' IRRs and it is not their commitment-weighted average -- IRR is not additive.
       On the reference book, averaging gives a median of -5.4% against the correct 12.4%,
       which is not a rounding artefact, it is the difference between a healthy book and a
       loss-making one. A test asserts the shipped figure differs from both shortcuts. */
    if (wantIrr) {
      irrPort.push(irrOf(pooled, bookT0).r);
      for (const k of Object.keys(irrClass)) {
        irrClass[k].push(classFlows[k] ? irrOf(classFlows[k], classT0[k]).r : null);
      }
    }
  }

  const q = (arr, p) => {
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.floor(p * (s.length - 1))];
  };
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / (arr.length || 1);

  const committed = book.reduce((a, b) => a + b.commitment, 0);
  const funded = book.reduce((a, b) => a + b.funded, 0);
  const uncalled = book.reduce((a, b) => a + b.uncalled, 0);

  const byYear = years.map((y) => ({
    year: y,
    /* The TYPICAL preferred return now, not the contractual one, so this column and the
       median beside it describe the same future. `couponScheduled` carries what the
       documents promise. */
    coupon: q(cpn[y], 0.50),
    couponScheduled: couponSched[y],
    calls: calls[y],
    med: q(per[y], 0.50),
    odds: per[y].filter((v) => v > 0).length / per[y].length,
    p90: q(per[y], 0.90),
  }));
  const cumRows = years.map((y) => ({
    year: y, p10: q(cum[y], 0.10), p50: q(cum[y], 0.50), p90: q(cum[y], 0.90),
  }));

  // distribution SHAPE. Three percentiles cannot show it, and shape is the argument.
  const hist = new Array(CFG.histBins).fill(0);
  for (const t of totals) {
    let bin = Math.floor((t / committed) / CFG.histMax * CFG.histBins);
    if (bin < 0) bin = 0;
    if (bin >= CFG.histBins) bin = CFG.histBins - 1;
    hist[bin]++;
  }
  for (let i = 0; i < hist.length; i++) hist[i] /= totals.length;

  const out = {
    years, byYear, cum: cumRows, hist,
    /* [path][yearIndex] against `years`. Present only with opts.capturePaths. */
    pathRows,
    histBins: CFG.histBins, histMax: CFG.histMax,
    totals: {
      committed, funded, uncalled,
      coupon: q(cpnTotals, 0.50),
      couponScheduled: years.reduce((a, y) => a + couponSched[y], 0),
      couponP10: q(cpnTotals, 0.10),
      calls: years.reduce((a, y) => a + calls[y], 0),
      p10: q(totals, 0.10), p50: q(totals, 0.50),
      mean: mean(totals), p90: q(totals, 0.90),
      stackedP90: byYear.reduce((a, r) => a + r.p90, 0),
      /* The share sitting in the final bar, whatever the range happens to be. The old
         name said 3x and would have started lying the moment the range moved. */
      shareAtCap: hist[CFG.histBins - 1],
      shareAbove3x: hist[CFG.histBins - 1],   // deprecated alias, kept for one version
    },
  };
  // the tie-out that proves the cumulative panel and the totals are one model
  out.ties = Math.abs(cumRows[cumRows.length - 1].p50 - out.totals.p50) < 0.01;

  if (wantIrr) {
    /* Percentiles over the DEFINED values only. A run where a deal returned nothing is
       -100% and belongs in the distribution; a run where it had no cash flow at all is
       undefined and must not be silently counted as a zero. */
    /* AN UNSOLVABLE PATH IS NOT AN ABSENT ONE. Filtering the nulls out and taking the
       quantile of what is left reports a complete-looking band computed only from the runs
       that behaved -- and the runs that did not behave are the ones at the TOP, so dropping
       them drags p90 down and still prints it with a decimal point.

       So they keep their place in the ordering, above every solved path, and a quantile that
       lands among them returns null. p90 goes undefined exactly when a tenth or more of the
       runs could not be solved; p50 is untouched until half of them cannot. A position with
       nothing undefined is completely unaffected, which is every fully funded one. */
    const qi = (arr, pp) => {
      const v = arr.filter((x) => x != null).sort((a, b) => a - b);
      if (!v.length) return null;
      const i = Math.floor(pp * (arr.length - 1));
      return i < v.length ? v[i] : null;
    };
    const band = (arr) => ({
      p10: qi(arr, 0.10), p50: qi(arr, 0.50), p90: qi(arr, 0.90),
      defined: arr.filter((x) => x != null).length,
      paths: arr.length,
    });

    /* "By scenario" has two defensible readings and they disagree, so both ship and both
       are labelled. `portfolio` ranks runs BY IRR, which is the honest IRR spread.
       `byCash` ranks them by total cash returned -- the cone's own basis -- and reports
       that run's IRR, which is what a reader means when they point at the cone's good line
       and ask what return it is. A run can return a great deal of money slowly, so on the
       reference book the good end differs by over four points. */
    const order = totals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    const atCash = (pp) => irrPort[order[Math.floor(pp * (order.length - 1))]];

    out.irr = {
      portfolio: band(irrPort),
      byCash: { p10: atCash(0.10), p50: atCash(0.50), p90: atCash(0.90) },
      byClass: Object.fromEntries(Object.keys(irrClass).map((k) => [k, band(irrClass[k])])),
      byDeal: book.map((b, i) => Object.assign({
        name: b.name, kind: b.kind, commitment: b.commitment,
        sponsorMoic: b.moic, sponsorCase: sponsorCaseIrr(b), hold: b.hold,
        lossShare: irrDeal[i].filter((x) => x != null && x <= -0.9999).length / (irrDeal[i].length || 1),
        flags: dealFlags[i] || {},
      }, band(irrDeal[i]))),
      flags: irrFlags,
      paper: paperTrack(book),
    };
  }
  return out;
}

/* ── SHAREABLE DEAL FILES ───────────────────────────────────────────────────
   The terms of a deal are identical for everyone who bought it, so they live in one
   file per deal rather than being retyped by every holder -- thirteen people typing
   the same preferred rate is thirteen chances to get it wrong.

   YOUR TRACKER ALWAYS WINS. A deal file only fills what you left blank. If your copy
   of the terms differs from the shared one, yours is used and nothing argues with you.
   Nothing personal is ever in a deal file: commitments, dates and notes stay in your
   tracker and never leave your machine. */
/* MIN_FUZZY exists because "Ae" used to match AERTHLINGS. A prefix match on two
   characters silently attached somebody else's sponsor, hold and 10x multiple to a
   stranger's position, and nothing on screen said where those numbers came from.
   Quietly using the wrong terms is worse than using none, so a partial match now needs
   real evidence on both sides. An exact name still matches at any length. */
const MIN_FUZZY = 6;

function matchDeal(name, index) {
  const n = String(name || '').trim().toLowerCase();
  if (!n || !index || !index.deals) return null;
  let best = null;
  const hits = new Set();
  for (const d of index.deals) {
    for (const a of (d.aliases || [d.name])) {
      const al = String(a).trim().toLowerCase();
      if (!al) continue;
      if (n === al) return d;                                  // exact wins outright
      if (n.length < MIN_FUZZY || al.length < MIN_FUZZY) continue;
      if (n.startsWith(al) || al.startsWith(n)) {
        hits.add(d.slug);
        if (!best || al.length > best._len) best = Object.assign({ _len: al.length }, d);
      }
    }
  }
  /* AMBIGUITY WINS NOTHING. "Asilia" prefixes both the GC Fund and Asilia Credit Fund
     Evergreen, which are different vehicles with different terms. Picking the longer
     alias would attach one of them silently and look confident about it. When more than
     one deal is in play the honest answer is none: the holder types their own terms, or
     writes the fuller name. Only an EXACT match is allowed to resolve this. */
  if (hits.size > 1) return null;
  /* RESERVED NAMES. Ambiguity was the only thing protecting a holder of Asilia Credit Fund I,
     and ambiguity is emergent: it lasted exactly as long as a second Asilia credit vehicle
     had a file here. The moment that file went, "Asilia Credit Fund I" prefixed the sole
     remaining candidate, resolved cleanly, and attached Evergreen's coupon, term and
     redemption gate to somebody else's money with nothing on screen to say so. Removing a
     deal file must not make its name start meaning a different deal, so the index names the
     vehicles it knows about but does not carry, and a typed name consistent with one of them
     resolves to nothing. An exact alias of a real deal has already returned above. */
  if (best && isReserved(n, index)) return null;
  return best;
}

/* Reserved names match the way deal aliases do, prefixes and all, because the family is
   what has to be refused rather than one spelling of it. */
function isReserved(n, index) {
  for (const r of (index.reserved || [])) {
    const rl = String(r).trim().toLowerCase();
    if (!rl) continue;
    if (n === rl) return true;
    if (n.length < MIN_FUZZY || rl.length < MIN_FUZZY) continue;
    if (n.startsWith(rl) || rl.startsWith(n)) return true;
  }
  return false;
}

/* Is a typed value the same thing the shared file says? Numbers compare as numbers, so
   0.12 and "12%" parsed to 0.12 do not read as a disagreement; everything else compares as
   trimmed lower-case text. */
function sameVal(a, b) {
  const na = Number(a), nb = Number(b);
  const bothNum = Number.isFinite(na) && Number.isFinite(nb)
    && String(a).trim() !== '' && String(b).trim() !== '';
  if (bothNum) return Math.abs(na - nb) < 1e-9;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/* A vehicle column is free text on both sides: the holder writes "Fund", the file carries
   "Closed-end fund". Those agree. Only compare what the two strings actually decide, which
   is whether the position sells down over years or is bought on one date. */
function vehKind(s) {
  const t = String(s || '').trim().toLowerCase();
  if (!t) return null;
  if (/^(single|spv|one |direct|company)/.test(t) || t === 'single deal') return 'single';
  if (/fund|pool|syndicat|portfolio/.test(t)) return 'fund';
  return null;
}

/* WHICH TIER DOES THIS COMMITMENT LAND IN?
   Several GC deals price by ticket size -- Eephus pays 8% to its top classes and 6% to its
   lowest, Asilia charges 1.3% and 30% carry below $400k and 1.2% and 20% above it. Until
   now the shared file carried ONE set of terms, the author's, and the best the tool could
   do was print a warning telling the reader to work out their own class and type it in by
   hand. That is the tool asking the reader to do its job: it already knows the commitment
   and it already holds the bands.

   `basis` is what makes this safe. Only 'commitment' can be resolved from a tracker row.
   A deal whose tiers are known to exist but whose breakpoints are NOT documented is
   recorded with basis 'class', which resolves to nothing and leaves the warning in place --
   because guessing a breakpoint would be worse than admitting there is one. */
function resolveTier(f, commitment) {
  const T = f && f.tiers;
  if (!T || !Array.isArray(T.bands) || !T.bands.length) return null;
  if (T.basis !== 'commitment') return null;      // not resolvable from what a tracker holds
  const amt = num(commitment);
  if (!(amt > 0)) return null;
  let hit = null;
  for (const b of T.bands) {
    const lo = b.min == null ? 0 : num(b.min);
    const hi = b.max == null ? Infinity : num(b.max);
    if (amt >= lo && amt < hi) { if (!hit || lo >= num(hit.min || 0)) hit = b; }
  }
  return hit;
}

/* applyDealFile(row, dealFile) -> a NEW row (the input is not mutated).
   Fills only the fields the holder left blank, from the deal file's terms (or from the
   ticket-size band their commitment lands in), and records:
     _deal            the file itself, for the card
     _ovr             [{key, label, fmt, yours, shared}] fields typed over the file
     _tier            the resolved band, or null
     _tierUnresolved  true when the file has tiers that a commitment cannot resolve
   The fields it reads from the file are listed in the header under DEAL FILE SCHEMA. */
function applyDealFile(row, f) {
  if (!f) return row;
  const tier = resolveTier(f, row && row.commitment);
  /* A band's terms REPLACE the file's defaults before anything is filled in, so the rest of
     this function never needs to know tiers exist. */
  const t = Object.assign({}, f.terms || {}, (tier && tier.terms) || {});
  const L = f.liquidity || {};
  const blank = (v) => v == null || String(v).trim() === '';
  const out = Object.assign({}, row);

  /* WHAT THE HOLDER TYPED OVER.
     The shared file only ever fills blanks, so anything typed wins silently. That rule is
     right and it is also a quiet failure mode: a number typed BEFORE the sponsor's terms
     were corrected looks identical to a number typed in deliberate disagreement with them.
     The tool cannot tell those two apart -- but it can put both figures on the card and let
     the holder decide which one they still believe. Recorded here rather than in the UI so
     the comparison happens once, against the file that actually matched. */
  const ovr = [];
  const mark = (key, label, fmt, mine, theirs) => {
    if (blank(mine) || theirs == null || theirs === '') return;
    /* A typed rate is read with the same percent rule buildBook uses, so a holder who typed
       a bare 12 against a file's 0.12 is not reported as disagreeing (and is not shown as
       "1200%" beside "12%"). */
    if (fmt === 'pct') mine = pctField(mine, label, key, null);
    if (sameVal(mine, theirs)) return;
    ovr.push({ key, label, fmt, yours: mine, shared: theirs });
  };

  mark('assetClass', 'Asset class', 'text', out.assetClass, f.assetClass);
  mark('coupon', 'Preferred rate', 'pct', out.coupon, t.couponPct);
  mark('uncalledYieldPct', 'Yield on uncalled', 'pct', out.uncalledYieldPct,
       t.uncalledYieldPct);
  mark('hold', 'Hold', 'years', out.hold, t.holdYears);
  mark('moic', 'Sponsor MOIC', 'mult', out.moic, t.sponsorMoic);
  mark('deals', 'Deals in fund', 'num', out.deals, f.dealsInFund);

  const mineVeh = vehKind(out.vehicle);
  const theirVeh = f.singleCompany ? 'single' : vehKind(f.vehicle);
  if (mineVeh && theirVeh && mineVeh !== theirVeh) {
    ovr.push({
      key: 'vehicle', label: 'Fund or single deal', fmt: 'text',
      yours: mineVeh === 'fund' ? 'Fund' : 'Single deal',
      shared: theirVeh === 'fund' ? 'Fund' : 'Single deal',
    });
  }

  /* The window is one decision typed across two cells, so it reports as one line. A holder
     who typed only the far end still gets the whole window compared, because that is what
     the model runs on. */
  if ((!blank(out.liqFrom) || !blank(out.liqTo)) && L.fromYear && L.toYear) {
    const a = blank(out.liqFrom) ? L.fromYear : num(out.liqFrom);
    const b = blank(out.liqTo) ? L.toYear : num(out.liqTo);
    if (a !== L.fromYear || b !== L.toYear) {
      ovr.push({
        key: 'window', label: 'Payout window', fmt: 'window',
        yours: [a, b], shared: [L.fromYear, L.toYear],
      });
    }
  }

  if (blank(out.assetClass) && f.assetClass) out.assetClass = f.assetClass;
  if (blank(out.vehicle) && f.vehicle) out.vehicle = f.singleCompany ? 'Single deal' : f.vehicle;
  if (blank(out.coupon) && t.couponPct != null) out.coupon = t.couponPct;
  if (blank(out.uncalledYieldPct) && t.uncalledYieldPct != null) {
    out.uncalledYieldPct = t.uncalledYieldPct;
  }
  if (blank(out.uncalledYieldUntil) && t.uncalledYieldUntil != null) {
    out.uncalledYieldUntil = t.uncalledYieldUntil;
  }
  if (blank(out.hold) && t.holdYears) out.hold = t.holdYears;
  if (blank(out.callPctPerYear) && t.callPctPerYear != null) out.callPctPerYear = t.callPctPerYear;
  /* terms.ltvPct is the documented key; terms.ltv is accepted as an alias (2026-10-31)
     because asilia-credit-fund-evergreen.json was written with it and the value was being
     dropped. ltvPct wins if a file ever carries both. */
  const ltvTerm = t.ltvPct != null ? t.ltvPct : t.ltv;
  if (blank(out.ltv) && ltvTerm != null) out.ltv = ltvTerm;
  if (blank(out.moic) && t.sponsorMoic) out.moic = t.sponsorMoic;
  if (blank(out.deals) && f.dealsInFund != null) out.deals = f.dealsInFund;
  if (blank(out.liqFrom) && L.fromYear) out.liqFrom = L.fromYear;
  if (blank(out.liqTo) && L.toYear) out.liqTo = L.toYear;
  out._deal = f;
  out._ovr = ovr;
  out._tier = tier ? { label: tier.label, min: tier.min, max: tier.max, terms: tier.terms } : null;
  /* Tiers exist but cannot be resolved from a commitment -- the reader still has to be
     told, which is what the card's warning is for. */
  out._tierUnresolved = !!(f.tiers && !tier);
  return out;
}

/* callSchedule is exported because app.js had grown its OWN copy of it, so A2b would have been
   the third place to change the same rule. Two implementations of one schedule is how the deal
   index drifted from the deal files. */
const Engine = { CFG, buildBook, simulate, makeRng, num, matchDeal, applyDealFile, resolveTier,
                 irrOf, dealStream, sponsorCaseIrr, paperTrack, prefFactor,
                 callSchedule, callNotes, callYearOf, callsOf, callsCumulative, calendarNow,
                 couponSchedule, exitPlan, gridYears };
/* 2026-10-31. The deal streams, exported so a replay (markets.js privateCone) draws through
   the engine instead of copying it: streamFor(key, path, seed) is the raw generator,
   pathDraws(book, p, seed) is the whole per-path draw including shared fate, and
   outcomeMultiple(b, drawn) is the scaling rule. pctField and bookWarnings are the input
   rules buildBook applies, exported for the intake screen and the tests. */
Engine.streamFor = streamFor;
Engine.pathDraws = pathDraws;
Engine.outcomeMultiple = outcomeMultiple;
Engine.hashKey = hashKey;
Engine.pctField = pctField;
Engine.bookWarnings = bookWarnings;
/* Exported because app.js draws three panels off the same figure. A second copy of the
   ramp in the UI is exactly how the cash table and the ladder end up disagreeing. */
Engine.prefInYear = prefInYear;
Engine.calledBy = calledBy;
Engine.uncalledYieldShare = uncalledYieldShare;

if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
