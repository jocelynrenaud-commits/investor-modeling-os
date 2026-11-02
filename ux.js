/* UX LAYER (prototype only).
 *
 * PURPOSE. The base app (app.js) explains everything inline, which makes every card a wall
 * of text, and it names things in its own older vocabulary. This layer keeps every word but
 * changes what you see first:
 *
 *     heading -> one-line caption -> the numbers -> "How to read this" (folded)
 *
 * and it puts one vocabulary on the whole page (UX review C): private money is "paid in" or
 * "committed", money still owed to deals is "Still to pay in" in neutral ink, the headline
 * retirement metric is "Chance the money lasts", tab labels and page titles are the same
 * words, and no em or en dash reaches the screen.
 *
 * PLACE IN THE APP. Loaded by index.html after every plugin and before app.js. It works on
 * the RENDERED page through a MutationObserver on #out, so app.js and engine.js stay
 * byte-identical with the live Financial Planning OS. It owns no model state. It mounts the
 * Deal Library's "What If I Add This Deal?" card (ConsiderUI.mount) and adds two cards to
 * the Help tab (About This Tool, Terms).
 *
 * WHAT IT DOES, IN ORDER, ON EVERY MUTATION (tidy):
 *   compactIntake  shrink the drop zone once a book is loaded
 *   land           on every NEW book: open Overview and scroll to the top
 *   groupTabs      group the bar (Portfolio | Public markets | Private deals | Planning |
 *                  Reference) and give it the ARIA tab pattern with arrow-key movement
 *   pageTitle      the page title above the cards = the tab's own label
 *   tidyCard       captions, folds, kept findings, hidden cards (per card)
 *   retitle        card headings via RENAME, else title case (original kept in data-orig)
 *   relabel        text renames, "Still to pay in" in neutral ink, dash removal, chips'
 *                  aria-pressed, aria-labels on chart marks
 *   help           the Help tab's About and Terms cards
 *
 * INVARIANTS. Idempotent: running tidy twice changes nothing the second time. It never
 * changes a number, only the words and roles around it. It disconnects its own observer
 * while it edits, so its own changes do not re-trigger it.
 *
 * ASSUMPTIONS. Headings, labels and empty-cell glyphs are matched on their exact text, so a
 * copy change in app.js can make a rename silently stop applying (the test suite checks the
 * renamed strings on the example book). KNOWN LIMITS: hover readouts come from app.js's
 * tooltip layer; this file adds keyboard focus to them but not touch.
 */
(function () {
  'use strict';

  const PROTO_DATE = '31 Oct 2026';

  // One line per card: what the card answers. Keyed by the card's heading text.
  const CAPTIONS = {
    'Your portfolio': 'What you committed, what you have paid in, and what is still to pay in.',
    'Your allocation': 'Split by what you committed, not by current value.',
    'Your positions': 'Every position and what the model expects from it.',
    'Capital calls vs. preferred income': 'Money you still owe against the income the documents promise.',
    'Cumulative cash received': 'Cash paid back to you, added up as it arrives. Plan against this one.',
    'Maturity and liquidity ladder': 'When each position is due to pay you back.',
    'The cone of outcomes': 'Cumulative cash, bad run to good run. Dashed line: your capital back.',
    'Outcome range by sleeve': 'Bad, typical and good multiple for each sleeve.',
    'Outcome distribution': 'Where every simulated future landed, as a multiple on what you committed.',
    'Lifetime returns': 'Profit on everything committed, over the life of each position.',
    'Annual rate of return': 'The yearly rate, counting cash actually returned.',
    'The assumptions': 'Move anything to test it. Nothing is saved.',
    'Will the money last': 'How often the plan covers every year, across simulated lifetimes.',
    'Your money over time': 'Total wealth each year, bad run to good run.',
    'When can you stop?': 'The same plan for each possible stop year.',
    'What breaks first': 'In the lifetimes that fell short: when and why.',
    'What moves it most': 'One change at a time, same random draws.',
    'Where each year’s money comes from': 'What pays for each year. Dashed line: the full target.',
    'Year by year': 'One typical lifetime, row by row.',
    'How this works, and what it assumes': 'The method and its limits.',
    'Loaded GC deals': 'Deal terms the tool already knows.',
    'What it cannot tell you': 'The limits, in plain terms.',
  };

  // Findings worth seeing without opening anything. Matched on the start of the note.
  const KEEP = ['Typically ', 'The median crosses', 'In these simulations the income sleeves',
    'Held together, venture does better', 'Taken from your tracker'];

  // Reference tabs read as text on purpose; leave their prose open.
  const OPEN_CARDS = ['What this does', 'The numbers this tool invents, and why',
    'The rules it enforces', 'Reading these tables', 'About This Tool', 'Terms'];

  const SHORT = 14; // words; anything this short is a label, not an explanation

  // Cards taken off the page. "Cash flow by year" ranked each year on its own, so its rows
  // could not be added down; the cumulative card below it answers the same question safely.
  const HIDE = ['Cash flow by year'];

  /* Direct, descriptive titles. Each card is named for what it shows, not for a question
     about it ("Where it sits" became "Portfolio Allocation"). Keyed by the base app's own
     heading, which stays on the element as data-orig so the captions, folds and hides above
     keep finding their card. Anything not listed is set in title case. */
  const RENAME = {
    'Your portfolio': 'Private Deals Summary', 'Your allocation': 'Private Allocation by Commitment',
    'Your positions': 'Private Positions', 'Your deals': 'Deal Cards', 'Loaded GC deals': 'Known Deal Terms',
    'Which sleeve': 'Show', 'Outcome range by sleeve': 'Lifetime Multiple Range by Sleeve',
    'Outcome distribution': 'Distribution of Lifetime Multiples', 'The cone of outcomes': 'Range of Cumulative Cash Outcomes',
    'The assumptions': 'Simulator Assumptions', 'Will the money last': 'Chance the Money Lasts',
    'Your money over time': 'Projected Portfolio Value', 'When can you stop?': 'Retirement Year Comparison',
    'What breaks first': 'Shortfall Analysis', 'What moves it most': 'Sensitivity Analysis',
    'Where each year’s money comes from': 'Annual Funding Sources', 'Year by year': 'Year-by-Year Ledger',
    'How this works, and what it assumes': 'Method and Assumptions', 'What it does': 'What the Simulator Does',
    'What the model invents': 'Modeled Assumptions', 'What it cannot tell you': 'Limitations',
    'What this does': 'The Private Deal Tabs', 'The numbers this tool invents, and why': 'Modeled Assumptions',
    'The rules it enforces': 'Model Rules', 'Reading these tables': 'How to Read the Tables',
  };

  /* LABELS RENDERED BY OTHER FILES, renamed in place. Matched on a text node's whole,
     trimmed text, so a sentence that merely contains the words is left alone. One name for
     money committed and not yet sent ("Still to pay in", UX-10), "Paid in" for what has
     been sent (UX-11), and the retirement headline in plain words (UX-12). */
  const TEXT = {
    'Still callable': 'Still to pay in', 'Still to call': 'Still to pay in', 'Uncalled': 'Still to pay in',
    'Funded': 'Paid in', 'Funded to date': 'Paid in to date',
    'Committed, funded, and still callable': 'Committed, paid in, and still to pay in',
    'Never short': 'Chance the money lasts', 'NEVER SHORT': 'Chance the money lasts',
  };
  /* Phrases replaced inside longer text, where the replacement reads correctly in context. */
  const PHRASES = [
    [/\bStill callable\b/g, 'Still to pay in'], [/\bstill callable\b/g, 'still to pay in'],
    [/^Never short:/, 'Chance the money lasts:'], [/^Never short /, 'Chance the money lasts '],
  ];

  const SMALL = /^(a|an|and|as|at|but|by|for|in|nor|of|on|or|per|the|to|vs\.?|via|with)$/;
  /* Title case, leaving small words, acronyms and words with inner capitals as they are. */
  function titleCase(t) {
    let first = true;
    return t.split(/(\s+|-)/).map((w) => {
      if (/^\s+$|^-$/.test(w) || !w) return w;
      const keep = /[A-Z0-9]/.test(w.slice(1)) || /^[^a-z]/.test(w);
      const out = keep ? w : (!first && SMALL.test(w)) ? w : w[0].toUpperCase() + w.slice(1);
      first = /:$/.test(w);
      return out;
    }).join('');
  }
  /* Rename one card heading (once; the original stays in data-orig). */
  function retitle(h) {
    if (h.hasAttribute('data-orig') || h.children.length) return;
    const orig = h.textContent.trim();
    h.setAttribute('data-orig', orig);
    const nt = RENAME[orig] || titleCase(orig);
    if (nt !== orig) h.textContent = nt;
  }

  const words = (el) => (el.textContent.trim().match(/\S+/g) || []).length;
  const hasControl = (el) => !!el.querySelector('input,select,button,textarea');

  /* Caption, folds and kept findings for one card. Idempotent rather than run-once: parts
     of a card re-render in place when a control moves, and the fresh notes need folding. */
  function tidyCard(card) {
    const h = card.querySelector(':scope > h2, :scope > h3');
    const title = h ? (h.getAttribute('data-orig') || h.textContent.trim()) : '';
    if (OPEN_CARDS.includes(title)) { if (h) retitle(h); return; }
    if (HIDE.includes(title)) { card.style.display = 'none'; return; }

    if (h && CAPTIONS[title] && !card.querySelector(':scope > .cap')) {
      const cap = document.createElement('p');
      cap.className = 'cap';
      cap.textContent = CAPTIONS[title];
      h.after(cap);
    }

    const fold = [];
    card.querySelectorAll('.note, :scope > .glos').forEach((n) => {
      if (n.closest('details') || n.closest('.cap') || hasControl(n) || n.classList.contains('key') || n.closest('#consider')) return;
      const t = n.textContent.trim();
      if (!t || words(n) <= SHORT) return;
      if (KEEP.some((k) => t.startsWith(k))) { n.classList.add('key'); return; }
      if (n.parentElement === card) { fold.push(n); return; } // document order is kept
      // Nested beside a control: fold where it stands, under a label saying what it holds.
      const d = document.createElement('details');
      d.className = 'tip';
      const lead = (t.match(/^[^.:]{3,48}/) || [''])[0].trim();
      d.innerHTML = '<summary></summary>';
      d.firstChild.textContent = lead ? 'Explain: ' + lead : 'Explain';
      n.before(d);
      d.appendChild(n);
    });

    if (fold.length) {
      let d = card.querySelector(':scope > details.how');
      if (!d) {
        d = document.createElement('details');
        d.className = 'more how';
        d.innerHTML = '<summary>How to read this</summary>';
      }
      fold.forEach((n) => d.appendChild(n));
      card.appendChild(d); // keep it last
    }
  }

  /* Once a book is loaded the drop zone has done its job: shrink it to one link. */
  function compactIntake() {
    const out = document.getElementById('out'), intake = document.getElementById('intake');
    if (!out || !intake || out.classList.contains('hidden') || intake.classList.contains('hidden')) return;
    intake.classList.add('hidden');
    const sub = document.querySelector('.sub');
    if (sub && !document.getElementById('uxReload')) {
      const a = document.createElement('button');
      a.id = 'uxReload'; a.type = 'button'; a.className = 'linkish'; a.textContent = 'Load a different file';
      a.onclick = () => { intake.classList.remove('hidden'); a.remove(); intake.scrollIntoView({ behavior: 'smooth' }); };
      sub.appendChild(document.createTextNode(' '));
      sub.appendChild(a);
    }
  }

  /* ONE APP, FIVE AREAS. The original tabs were all about private deals; with public
     markets and the whole portfolio added, a flat row of ten tabs would mix them up. */
  const NAV = [
    ['Portfolio', ['overview', 'curve']],
    ['Public markets', ['holdings']],
    ['Private deals', ['dash', 'outlook', 'perf', 'universe']],
    ['Planning', ['runway', 'tax']],
    ['Reference', ['about']],
  ];

  /* Group the tab bar, and give it the ARIA tab pattern: a tablist of tabs with
     aria-selected, one tab in the Tab order (roving tabindex), and Left/Right/Home/End to
     move between them. Enter and Space press a tab because each is a button. */
  function groupTabs() {
    const bar = document.querySelector('#out .tabs');
    if (!bar) return;
    if (!bar.querySelector('.tg')) {
      const btns = {};
      bar.querySelectorAll('[data-tab]').forEach((b) => { btns[b.getAttribute('data-tab')] = b; });
      let lastBox = null;
      NAV.forEach(([label, keys]) => {
        const have = keys.filter((k) => btns[k]);
        if (!have.length) return;
        const g = document.createElement('div');
        g.className = 'tg';
        g.setAttribute('role', 'presentation');
        g.innerHTML = '<span class="tgl" aria-hidden="true">' + label + '</span><div class="tgb" role="presentation"></div>';
        have.forEach((k) => { g.lastChild.appendChild(btns[k]); delete btns[k]; });
        bar.appendChild(g);
        lastBox = g.lastChild;
      });
      Object.keys(btns).forEach((k) => lastBox && lastBox.appendChild(btns[k]));
      bar.addEventListener('keydown', tabKeys);
      bar.addEventListener('scroll', () => edge(bar), { passive: true });
    }
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', 'Sections');
    const body = document.getElementById('tabbody');
    bar.querySelectorAll('[data-tab]').forEach((b) => {
      const on = b.classList.contains('on');
      b.setAttribute('role', 'tab');
      b.id = b.id || 'tab-' + b.getAttribute('data-tab');
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.setAttribute('tabindex', on ? '0' : '-1');
      if (body) b.setAttribute('aria-controls', 'tabbody');
      if (on && body) { body.setAttribute('role', 'tabpanel'); body.setAttribute('aria-labelledby', b.id); }
    });
    edge(bar);
  }
  /* Arrow keys on the tab bar. */
  function tabKeys(e) {
    const tabs = Array.prototype.slice.call(e.currentTarget.querySelectorAll('[data-tab]'));
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let j = null;
    if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = tabs.length - 1;
    if (j == null) return;
    e.preventDefault();
    const k = tabs[j].getAttribute('data-tab');
    tabs[j].click();
    const again = document.querySelector('#out [data-tab="' + k + '"]');
    if (again) again.focus();
  }
  /* On a phone the bar is one swipeable row: fade its right edge while more tabs are off
     screen (UX-48), and stop fading once the reader has scrolled to the end. */
  function edge(bar) {
    const more = bar.scrollWidth > bar.clientWidth + 2 && bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 2;
    bar.classList.toggle('more-right', more);
  }

  /* The page title above the cards: the group as an eyebrow and the tab's own label as the
     title, so the tab and the page always use the same words (UX-05). */
  function pageTitle() {
    const on = document.querySelector('#out [data-tab].on');
    const body = document.getElementById('tabbody');
    if (!on || !body) return;
    const k = on.getAttribute('data-tab');
    const grp = (NAV.find(([, keys]) => keys.includes(k)) || [''])[0];
    const label = on.textContent.trim();
    const bar = on.closest('.tabs');
    if (bar && bar.scrollWidth > bar.clientWidth) {
      const l = on.getBoundingClientRect().left - bar.getBoundingClientRect().left;
      if (l < 0 || l + on.offsetWidth > bar.clientWidth) bar.scrollLeft += l - 16;
    }
    let el = body.querySelector(':scope > .ptitle');
    if (!el || el.getAttribute('data-k') !== k) {
      if (el) el.remove();
      el = document.createElement('div');
      el.className = 'ptitle';
      el.setAttribute('data-k', k);
      el.innerHTML = '<small></small><b></b>';
      el.firstChild.textContent = grp;
      el.lastChild.textContent = label;
      body.prepend(el);
    }
    // The page title already says it; a first card headed the same way repeats it.
    const first = body.querySelector('.card > h2');
    if (first && first.textContent.trim().toLowerCase() === label.toLowerCase()) first.style.display = 'none';
  }

  /* HOVER ON EVERY CHART. Most charts already carry their numbers as tooltips; two in the
     base app do not. Rather than edit app.js, their readouts are added here from what the
     chart itself prints, so they can never disagree with the marks. */
  const SVGNS = 'http://www.w3.org/2000/svg';
  /* Give an SVG mark a <title> tooltip, unless it already has one. */
  function addTitle(el, text) {
    if (!el || el.querySelector('title') || el.hasAttribute('data-tip')) return;
    const t = document.createElementNS(SVGNS, 'title');
    t.textContent = text;
    el.appendChild(t);
  }
  /* Readouts for the two base charts that have none, and aria-labels for every chart mark. */
  function enrichHover() {
    // Outcome range by sleeve: label, committed, bar, median dot, bad, good, typical.
    document.querySelectorAll('#out svg[aria-label^="Bad run to good run"]').forEach((svg) => {
      svg.querySelectorAll('rect').forEach((r) => {
        const sib = (el, n, dir) => { for (let i = 0; i < n && el; i++) el = el[dir]; return el; };
        const label = sib(r, 2, 'previousElementSibling'), comm = sib(r, 1, 'previousElementSibling');
        const lo = sib(r, 2, 'nextElementSibling'), hi = sib(r, 3, 'nextElementSibling'), mid = sib(r, 4, 'nextElementSibling');
        if (!label || !mid) return;
        const tip = label.textContent + '\n' + comm.textContent + '\nBad run (1 in 10): ' + lo.textContent
          + '\nTypical: ' + mid.textContent + '\nGood run (1 in 10): ' + hi.textContent + '\nAs a multiple on what you committed; 1.00x is your money back';
        addTitle(r, tip);
        addTitle(r.nextElementSibling, tip);
      });
    });
    // The private allocation bar: segments in the same order as the legend under them.
    document.querySelectorAll('#out .card').forEach((card) => {
      const h = card.querySelector(':scope > h2');
      if (!h || !/allocation/i.test(h.textContent) || card.querySelector('.mk-bar')) return;
      const bar = Array.prototype.find.call(card.querySelectorAll(':scope > div'), (d) => d.style.height === '30px');
      const legend = card.querySelector(':scope > .row');
      if (!bar || !legend) return;
      const segs = bar.children, items = legend.children;
      Array.prototype.forEach.call(segs, (seg, i) => {
        if (seg.hasAttribute('title') || seg.hasAttribute('data-tip') || !items[i]) return;
        const name = items[i].childNodes[1] ? items[i].childNodes[1].textContent.trim() : '';
        const amt = items[i].querySelector('b') ? items[i].querySelector('b').textContent : '';
        seg.setAttribute('title', name + ': ' + amt + ' committed (' + parseFloat(seg.style.width).toFixed(1) + '% of the total)');
      });
    });
    /* A screen reader should not need a mouse to hear a chart mark's figures (QA M14): copy
       each SVG <title> into aria-label now, rather than on the first hover. */
    document.querySelectorAll('#out svg title').forEach((t) => {
      const p = t.parentNode;
      if (p && p.nodeType === 1 && p.tagName.toLowerCase() !== 'svg' && !p.hasAttribute('aria-label')) p.setAttribute('aria-label', t.textContent.replace(/\n/g, '. '));
    });
  }

  /* NO EM OR EN DASHES ON SCREEN (house rule). A dash between numbers becomes "to"; a dash
     used as punctuation becomes a comma; a dash standing alone in a cell becomes "None".
     Applied to text and to tooltips, never to inputs. */
  const DASH_RE = /[\u2013\u2014]/;
  function undash(t) {
    if (!DASH_RE.test(t)) return t;
    if (/^\s*[\u2013\u2014]\s*$/.test(t)) return t.replace(/[\u2013\u2014]/, 'None');
    return t
      .replace(/([\d%x×)])\s*[\u2013\u2014]\s*(?=[-$\d(])/g, '$1 to ')
      .replace(/\s*[\u2013\u2014]\s*$/g, ':')
      .replace(/^\s*[\u2013\u2014]\s*/g, '')
      .replace(/\s+[\u2013\u2014]\s+/g, ', ')
      .replace(/[\u2013\u2014]/g, ', ');
  }
  /* One pass over every text node and tooltip in #out: renames (TEXT, PHRASES), neutral ink
     for money still owed, the change label, dash removal, and aria-pressed on toggles. */
  function relabel() {
    const out = document.getElementById('out');
    if (!out) return;
    const walker = document.createTreeWalker(out, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    nodes.forEach((n) => {
      const p = n.parentNode;
      if (!p || /^(SCRIPT|STYLE|TEXTAREA|OPTION)$/i.test(p.nodeName)) return;
      let t = n.nodeValue;
      const trim = t.trim();
      if (!trim) return;
      if (Object.prototype.hasOwnProperty.call(TEXT, trim)) {
        t = t.replace(trim, TEXT[trim]);
        /* the figure beside "Still to pay in" is an obligation, not a loss: neutral ink */
        if (TEXT[trim] === 'Still to pay in') {
          const host = p.nodeName === 'SMALL' || p.nodeName === 'SPAN' ? p : null;
          const v = host && host.nextElementSibling;
          if (v && v.classList) { v.classList.remove('neg'); v.classList.add('owed'); }
        }
      } else {
        PHRASES.forEach(([re, to]) => { t = t.replace(re, to); });
      }
      /* A change label beside a signed figure: "Ending wealth" there is a difference. */
      if (trim === 'Ending wealth') {
        const v = p.nextElementSibling;
        if (v && /^[+-]/.test(v.textContent.trim())) t = t.replace('Ending wealth', 'Change in money left at the end');
      }
      t = undash(t);
      if (t !== n.nodeValue) n.nodeValue = t;
    });
    out.querySelectorAll('[title],[data-tip],[aria-label]').forEach((el) => {
      ['title', 'data-tip', 'aria-label'].forEach((a) => {
        const v = el.getAttribute(a);
        if (v && DASH_RE.test(v)) el.setAttribute(a, undash(v));
      });
    });
    /* Toggle buttons say whether they are pressed (UX-52). */
    out.querySelectorAll('#tabbody button[data-mode], #tabbody button[data-dist], #tabbody button[data-dsort], #tabbody button.chip').forEach((b) => {
      b.setAttribute('aria-pressed', b.classList.contains('on') ? 'true' : 'false');
    });
  }

  /* THE HELP TAB. app.js's own explainer covers its private-deal tabs only; this adds, at
     the top, what the whole tool does and where to start, and a Terms card that defines
     every word a member is likely to look up (UX-02, UX-08). Tab names are read from the
     tab bar, so they cannot drift from it. */
  const TERMS = [
    ['Beta', 'How much a holding moves with the US stock market. 1 moves with it, 2 moves about twice as much, 0 does not follow it.'],
    ['Capital call', 'A request from a deal for part of the money you committed. You agreed to pay it when you signed.'],
    ['Chance the money lasts', 'In how many of 1,200 simulated lifetimes every year’s spending was fully paid. Below 70% is worth a closer look; 85% and up is comfortable.'],
    ['Change in money left at the end', 'How much more or less the plan leaves at the end of your plan age in its typical future, in today’s dollars, because of one change.'],
    ['Committed', 'The full amount you signed up to invest in a deal, paid in or not.'],
    ['IRR (rate of return)', 'The yearly rate that a deal’s money in and money out work out to, counting when each dollar moved.'],
    ['MOIC (multiple)', 'Total cash back divided by cash in. 2.0× means you got back twice what you put in; 1.0× is your money back.'],
    ['Paid in', 'The part of a commitment you have already sent. Private deals are valued at this on the Overview.'],
    ['Percentile', 'Where a result sits among all the simulated ones. The 10th percentile is a bad run (1 in 10 do worse); the 90th is a good one.'],
    ['Preferred return', 'Income a deal’s documents promise to pay you each year before the sponsor shares in profits. Contractual, but it can be suspended.'],
    ['Sharpe ratio', 'Return above cash divided by volatility: how much return you get for each unit of ups and downs. Higher is better.'],
    ['Sleeve', 'A group of money with one job in the plan: Stocks, Income, Bonds, Real assets, Crypto, Cash.'],
    ['Still to pay in', 'What you committed to your deals and have not yet sent. It is money you owe, not a loss.'],
    ['Today’s dollars', 'A future amount shrunk by inflation, so it can be compared with prices now.'],
    ['Typical (median)', 'The middle result: half the simulated futures do better, half do worse.'],
    ['Volatility', 'The typical yearly swing, up or down, around the expected return. 16% is about what the US stock market does.'],
  ];
  function help() {
    const on = document.querySelector('#out [data-tab].on');
    const body = document.getElementById('tabbody');
    if (!on || !body || on.getAttribute('data-tab') !== 'about' || body.querySelector('#uxAbout')) return;
    const lab = (k) => { const b = document.querySelector('#out [data-tab="' + k + '"]'); return b ? b.textContent.trim() : k; };
    const card = (id, html) => { const c = document.createElement('div'); c.className = 'card'; c.id = id; c.innerHTML = html; return c; };
    const about = card('uxAbout', '<h2>About This Tool</h2>'
      + '<p class="note">Everything you own, when you can reach it, and whether it lasts. Load your tracker (or try the example) and the tabs are grouped by what they answer:</p>'
      + [['Portfolio', ['overview', 'curve'], 'everything you own on one page, and how it is doing against this year’s plan.'],
        ['Public markets', ['holdings'], 'your stocks, funds, bonds and cash, with their expected return and risk.'],
        ['Private deals', ['dash', 'outlook', 'perf', 'universe'], 'what you hold, when it pays back, what it may return, and every deal the tool knows.'],
        ['Planning', ['runway', 'tax'], 'the chance the money lasts, and what a tax strategy would change.']]
        .map(([g, ks, what]) => '<div class="glos"><div class="t"></div><div class="d"></div></div>'.replace('<div class="t"></div>', '<div class="t">' + g + '</div>')
          .replace('<div class="d"></div>', '<div class="d"><b>' + ks.map(lab).map(escT).join(', ') + '</b>: ' + what + '</div>')).join('')
      + '<p class="note"><b>Where to start:</b> ' + escT(lab('overview')) + ', then ' + escT(lab('outlook')) + ', then ' + escT(lab('runway')) + '. Use ' + escT(lab('tax')) + ' and the ' + escT(lab('universe')) + ' to test a change before you make it; neither changes your plan until you add something.</p>'
      + '<p class="note">Everything runs in your browser. Your tracker is read in the page and never uploaded.</p>');
    const terms = card('uxTerms', '<h2>Terms</h2><p class="cap">The words this tool uses, one sentence each.</p>'
      + TERMS.map(([t, d]) => '<div class="glos"><div class="t">' + escT(t) + '</div><div class="d">' + escT(d) + '</div></div>').join(''));
    const anchor = body.querySelector(':scope > .ptitle');
    if (anchor) { anchor.after(about); about.after(terms); } else { body.prepend(terms); body.prepend(about); }
  }
  const escT = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* LAND ON THE WHOLE PICTURE, ON EVERY NEW BOOK (QA L11, H2). app.js opens Deals after a
     load; the first thing a member should see is Overview, from the top of the page (UX-03).
     A new book is known by AppState.book changing (app.js tells PlanIncludes on every load,
     and dispatches privatedeals:book); before that hook existed, only the first load landed. */
  let landedBook = null, landedOnce = false, pendingLand = false;
  function land() {
    const b = document.querySelector('#out [data-tab="overview"]');
    if (!b) return;
    const bk = window.AppState ? window.AppState.book : null;
    if (landedOnce && !pendingLand && (!bk || bk === landedBook)) return;
    landedOnce = true; pendingLand = false; landedBook = bk;
    if (!b.classList.contains('on')) b.click();
    demoDone();
    toTop();
  }
  /* Scroll to the top now and again shortly after, so app.js's smooth scroll cannot win. */
  function toTop() {
    const go = () => { try { window.scrollTo({ top: 0, left: 0, behavior: 'auto' }); } catch (e) { try { window.scrollTo(0, 0); } catch (e2) { /* jsdom */ } } };
    go(); setTimeout(go, 0); setTimeout(go, 400);   // after app.js's own smooth scroll starts
  }

  /* "Run the example book" shows that it is working, and cannot be pressed twice. */
  let demoTimer = null;
  function demoBusy() {
    const b = document.getElementById('demo');
    if (!b || b.getAttribute('aria-busy') === 'true') return;
    b.setAttribute('data-label', b.textContent);
    b.textContent = 'Loading the example...';
    b.setAttribute('aria-busy', 'true');
    b.classList.add('busy');
    clearTimeout(demoTimer);
    demoTimer = setTimeout(demoDone, 15000);
  }
  /* Put the example button back once the book has loaded or failed. */
  function demoDone() {
    const b = document.getElementById('demo');
    if (!b || b.getAttribute('aria-busy') !== 'true') return;
    b.textContent = b.getAttribute('data-label') || 'Run the example book';
    b.removeAttribute('aria-busy');
    b.classList.remove('busy');
    clearTimeout(demoTimer);
  }

  /* The parse error used to point at "the repository"; link the template instead (the
     current app.js does this itself, and then this does nothing). */
  function intakeLinks() {
    const err = document.getElementById('intakeErr');
    if (!err) return;
    if (err.querySelector('.err')) demoDone();
    if (err.querySelector('a[href*="tracker-template"]')) return;
    err.querySelectorAll('.err').forEach((e) => {
      if (!/Could not (find|read)/.test(e.textContent)) return;
      e.innerHTML = e.innerHTML.replace(/The tracker template in the repository\s+has the expected layout\./, '');
      const a = document.createElement('a');
      a.href = 'tracker-template.xlsx'; a.setAttribute('download', ''); a.textContent = 'Download the tracker template (tracker-template.xlsx)';
      e.appendChild(document.createTextNode(' '));
      e.appendChild(a);
      e.appendChild(document.createTextNode(' to see the layout.'));
    });
  }

  /* KEYBOARD READOUTS (QA M14). A chart mark that carries a tooltip and can take focus shows
     the same box on focus that app.js shows on hover. */
  function focusTips() {
    document.addEventListener('focusin', (e) => {
      const el = e.target;
      if (!el || !el.closest || !el.closest('#out')) return;
      const tip = document.querySelector('.tipbox');
      if (!tip) return;
      let text = el.getAttribute('data-tip');
      if (!text && el.namespaceURI === SVGNS) { const t = el.querySelector(':scope > title'); text = t ? t.textContent : el.getAttribute('aria-label'); }
      if (!text) return;
      tip.textContent = text;
      tip.style.display = 'block';
      const r = el.getBoundingClientRect();
      tip.style.left = Math.max(8, Math.min(window.innerWidth - 348, r.left)) + 'px';
      tip.style.top = Math.max(8, r.bottom + 8) + 'px';
    });
    document.addEventListener('focusout', () => { const tip = document.querySelector('.tipbox'); if (tip) tip.style.display = 'none'; });
  }

  /* The version pill sits in the footer, so it never covers content (UX-42), and it and the
     release notes name the same version (UX-54). */
  function versionPill() {
    const ver = document.getElementById('ver'), foot = document.querySelector('footer');
    if (ver && foot && ver.parentNode !== foot) { foot.appendChild(document.createTextNode(' ')); foot.appendChild(ver); }
    const label = 'Prototype · ' + PROTO_DATE;
    if (ver && ver.textContent !== label) ver.textContent = label;
    const when = document.getElementById('relWhen');
    const w = 'You are on the prototype of ' + PROTO_DATE + ', built on the Financial Planning OS ' + ((typeof Engine !== 'undefined' && Engine.CFG && Engine.CFG.version) || 'v1.50') + '.';
    if (when && when.textContent !== w) when.textContent = w;
  }

  let queued = false, obs = null;
  /* The whole layer, once per batch of mutations (see the header for the order). */
  function tidy() {
    queued = false;
    if (obs) obs.disconnect(); // our own moves should not re-trigger us
    try {
      /* Regrouping moves the tab buttons, and moving a focused element drops its focus:
         remember which tab had it and give it back. */
      const ae = document.activeElement, focusTab = ae && ae.getAttribute && ae.closest && ae.closest('#out .tabs') ? ae.getAttribute('data-tab') : null;
      compactIntake();
      land();
      groupTabs();
      if (focusTab) { const b = document.querySelector('#out [data-tab="' + focusTab + '"]'); if (b && document.activeElement !== b) b.focus(); }
      pageTitle();
      versionPill();
      // The Deal Library gets its "What If I Add This Deal?" card once the list has drawn.
      const onTab = document.querySelector('#out [data-tab].on');
      if (window.ConsiderUI && onTab && onTab.getAttribute('data-tab') === 'universe' && document.querySelectorAll('#tabbody > .card').length >= 1) window.ConsiderUI.mount(document.getElementById('tabbody'));
      help();
      document.querySelectorAll('#out .card').forEach(tidyCard);
      document.querySelectorAll('#tabbody .card h2, #tabbody .card h3').forEach(retitle);
      enrichHover();
      relabel();
      intakeLinks();
    } finally {
      if (obs) {
        obs.observe(document.getElementById('out'), { childList: true, subtree: true });
        const ie = document.getElementById('intakeErr'); if (ie) obs.observe(ie, { childList: true, subtree: true });
      }
    }
  }
  // A microtask, not requestAnimationFrame: rAF never fires in a background tab, and the
  // fold has to be in place before the page is first painted anyway.
  function queue() { if (!queued) { queued = true; queueMicrotask(tidy); } }

  document.addEventListener('DOMContentLoaded', () => {
    const out = document.getElementById('out');
    if (!out) return;
    obs = new MutationObserver(queue);
    obs.observe(out, { childList: true, subtree: true });
    const demo = document.getElementById('demo');
    if (demo) demo.addEventListener('click', demoBusy);
    window.addEventListener('privatedeals:book', () => { pendingLand = true; queue(); });
    focusTips();
    versionPill();
    queue();
  });

  window.UX = { undash, titleCase, TEXT, RENAME, TERMS };
})();
