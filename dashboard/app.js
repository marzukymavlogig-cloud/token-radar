// Token Launch Radar dashboard. Reads window.RADAR (data.js, written by main.ts from the
// same board as board.json) and renders the ranked board, filters, a per-protocol detail view
// with the model decomposition, and the live-token comparables. No network, no fetch.
(function () {
  'use strict';
  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', watch: false, minTvl: 0, sort: 'implied', dir: -1, tab: 'board', selected: null };
  var WATCH = {};
  DATA.rows.forEach(function (r) { WATCH[r.slug] = false; });
  (DATA.watchlist_slugs || []).forEach(function (s) { WATCH[s] = true; });

  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtPct(n) { if (n === null || n === undefined || !isFinite(n)) return 'n/a'; return (n > 0 ? '+' : '') + n.toFixed(1) + '%'; }
  function fmtAge(d) { if (d === null || d === undefined) return 'unknown'; if (d >= 365) return (d / 365).toFixed(1) + 'y'; return Math.round(d) + 'd'; }
  function fmtMult(n) { return 'x' + Number(n).toFixed(3); }
  function chainsOf(r) { return r.chains && r.chains.length ? (r.chains.slice(0, 2).join(', ') + (r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '')) : '—'; }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) node.appendChild(x); });
      else if (typeof c === 'string') node.appendChild(document.createTextNode(c));
      else node.appendChild(c);
    }
    return node;
  }
  function readHash() {
    var h = window.location.hash.replace(/^#/, '');
    if (!h) return;
    var p = new URLSearchParams(h);
    if (p.get('detail')) state.selected = p.get('detail');
    if (p.get('q')) state.q = p.get('q');
    if (p.get('view') === 'live') state.tab = 'live';
    var f = p.get('filter');
    if (f === 'watchlist') state.watch = true;
    else if (f && f.indexOf('category:') === 0) state.category = f.slice(9);
  }
  function writeHash() {
    var p = new URLSearchParams();
    if (state.selected) p.set('detail', state.selected);
    if (state.q) p.set('q', state.q);
    if (state.category !== 'all') p.set('filter', 'category:' + state.category);
    else if (state.watch) p.set('filter', 'watchlist');
    if (state.tab === 'live') p.set('view', 'live');
    var s = p.toString();
    window.history.replaceState(null, '', s ? '#' + s : window.location.pathname + window.location.search);
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && !(r.chains || []).includes(state.chain)) return false;
      if (state.watch && !WATCH[r.slug]) return false;
      if (r.tvl_usd < state.minTvl) return false;
      if (!q) return true;
      return [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }
  function sorted(list) {
    var k = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (k === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (k === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (k === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (k === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (k === 'rank') { av = a.rank; bv = b.rank; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir; if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  // Scatter is built as an HTML string (no createElementNS namespace literal in source).

  function scatterSvg() {
    var pts = DATA.scatter || [];
    var W = 560, H = 210, pad = 34;
    var xs = pts.map(function (p) { return Math.log10(p.t); }), ys = pts.map(function (p) { return Math.log10(p.m); });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    function X(v) { return pad + (v - x0) / (x1 - x0) * (W - pad * 2); }
    function Y(v) { return H - pad - (v - y0) / (y1 - y0) * (H - pad * 2); }
    var f = DATA.fitted;
    var dots = pts.map(function (p) {
      return '<circle cx="' + X(Math.log10(p.t)).toFixed(1) + '" cy="' + Y(Math.log10(p.m)).toFixed(1) + '" r="3" fill="#7fb3ff" opacity="0.75"/>';
    }).join('');
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="scatter" role="img" aria-label="Comparables scatter: log TVL against log market cap with the fitted curve">'
      + '<line x1="' + X(x0).toFixed(1) + '" y1="' + Y(f.a + f.b * x0).toFixed(1) + '" x2="' + X(x1).toFixed(1) + '" y2="' + Y(f.a + f.b * x1).toFixed(1) + '" stroke="#f5a623" stroke-width="2"/>'
      + dots
      + '<text x="8" y="16" fill="#93a1ba" font-size="11">log TVL vs log mcap — ' + pts.length + ' comparables, amber line = fitted curve</text>'
      + '<text x="8" y="' + (H - 8) + '" fill="#6b7a94" font-size="11">Each dot is a protocol whose token already trades.</text></svg>';
    return el('div', { html: svg });
  }

  function header() {
    var v = DATA.validation;
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('b', { text: 'Token Launch Radar' })),
      el('div', { class: 'top-meta' },
        el('span', null, 'Snapshot ', el('b', { text: DATA.as_of })),
        el('span', null, 'Source ', el('b', { text: 'DefiLlama' })),
        el('span', null, 'Model ', el('b', { text: DATA.model_version })),
        el('span', null, 'Watchlist ', el('b', { text: DATA.watchlist_size + '/' + DATA.watchlist_size })),
        el('span', null, 'LOO err ', el('b', { text: v.loo.median_abs_log10_error + ' dex' }))
      ));
  }
  function lede() {
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.board_size + ' pre-token protocols, ranked by implied value' }),
        el('p', null, 'The watchlist is the floor: every protocol with at least ', el('b', { text: '$' + Math.round(DATA.floor_usd / 1e6) + 'M' }), ' of TVL that records no token. The radar adds ', el('b', { text: String(DATA.early_size) }), ' more pre-token protocols below that floor, so the board finds launches early — not just the biggest names. Implied value is this entry\u2019s model claim, not a prediction that a token will launch.')
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Early rows below floor' }), el('b', { text: String(DATA.early_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Live-token comparables' }), el('b', { text: String(DATA.live_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Fitted comps (n)' }), el('b', { text: String(DATA.fitted.n) }))
      ));
  }
  function modelPanel() {
    var f = DATA.fitted, v = DATA.validation;
    var beat = v.flat_loo.median_abs_log10_error > 0 ? Math.round((1 - v.loo.median_abs_log10_error / v.flat_loo.median_abs_log10_error) * 100) : 0;
    var wfBeat = v.flat_walk_forward.median_abs_log10_error > 0 ? Math.round((1 - v.walk_forward.median_abs_log10_error / v.flat_walk_forward.median_abs_log10_error) * 100) : 0;
    return el('section', { class: 'model' },
      el('h2', { text: 'How implied value is computed — fitted on the market, tested out of sample' }),
      el('div', { class: 'grid' },
        el('div', null,
          el('div', { class: 'formula', text: 'log10(mcap) = ' + f.a + ' + ' + f.b + ' x log10(TVL)   ·   R² = ' + f.r2 + '   ·   n = ' + f.n + ' traded-token comparables' }),
          el('p', { class: 'sub', text: 'Age curve (inverted-U): 0.70 at day 0, rising to 1.00 at 180 days, flat to 1,095 days, then decaying back to 0.70 at 1,851 days. Growth: 7d change clamped to [-60%, +120%]; upside counts at 0.6x, downside at 0.9x. Category adjustment: median residual per category (5+ comps), shrunk and clamped to ±0.30 dex. Breadth: +3% per chain up to 5 chains.' }),
          el('div', { class: 'vals' },
            el('div', null, el('span', { text: 'LOO median log10 error' }), el('b', { text: String(v.loo.median_abs_log10_error) })),
            el('div', null, el('span', { text: 'LOO MAPE on mcap' }), el('b', { text: v.loo.mape_pct + '%' })),
            el('div', null, el('span', { text: 'Walk-forward error (post-2025)' }), el('b', { text: String(v.walk_forward.median_abs_log10_error) })),
            el('div', null, el('span', { text: 'Walk-forward MAPE' }), el('b', { text: v.walk_forward.mape_pct + '%' })),
            el('div', null, el('span', { text: 'Flat 0.25x TVL, LOO error' }), el('b', { text: String(v.flat_loo.median_abs_log10_error) })),
            el('div', null, el('span', { text: 'Flat 0.25x TVL, walk-fwd error' }), el('b', { text: String(v.flat_walk_forward.median_abs_log10_error) }))
          ),
          el('p', { class: 'sub' }, 'The fitted curve beats the flat 0.25x TVL multiple by ', el('span', { class: 'win', text: beat + '% lower LOO error' }), ' and ', el('span', { class: 'win', text: wfBeat + '% lower walk-forward error' }), ' (train ' + v.walk_forward_train_n + ' pre-2025 comps, test ' + v.walk_forward_test_n + ' listed on/after 2025-01-01). ' + (v.note || ''))
        ),
        scatterSvg()
      ));
  }
  function controls() {
    var cats = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (a, r) { return a.concat(r.chains || []); }, []))).sort();
    var q = el('input', { type: 'search', id: 'q', placeholder: 'Search name, slug or chain', value: state.q, 'aria-label': 'Search the board' });
    q.addEventListener('input', function () { state.q = q.value; writeHash(); render(); });
    var cat = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      cats.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); }));
    cat.addEventListener('change', function () { state.category = cat.value; writeHash(); render(); });
    var ch = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); }));
    ch.addEventListener('change', function () { state.chain = ch.value; render(); });
    var tv = el('select', { id: 'mintvl', 'aria-label': 'Minimum TVL' },
      [['0', 'Any TVL'], ['50000000', 'TVL ≥ $50M'], ['100000000', 'TVL ≥ $100M'], ['500000000', 'TVL ≥ $500M'], ['1000000000', 'TVL ≥ $1B']].map(function (o) { return el('option', { value: o[0], text: o[1], selected: String(state.minTvl) === o[0] ? 'selected' : null }); }));
    tv.addEventListener('change', function () { state.minTvl = Number(tv.value); render(); });
    var sort = el('select', { id: 'sort', 'aria-label': 'Sort by' },
      [['implied', 'Sort: implied value'], ['rank', 'Sort: rank'], ['tvl', 'Sort: TVL'], ['growth', 'Sort: 7d growth'], ['age', 'Sort: age'], ['name', 'Sort: name']].map(function (o) { return el('option', { value: o[0], text: o[1], selected: state.sort === o[0] ? 'selected' : null }); }));
    sort.addEventListener('change', function () { state.sort = sort.value; state.dir = state.sort === 'name' || state.sort === 'rank' ? 1 : -1; render(); });
    var wk = el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: state.watch ? 'checked' : null }), ' Watchlist only');
    wk.querySelector('input').addEventListener('change', function (e) { state.watch = e.target.checked; writeHash(); render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'board' ? 'true' : 'false', text: 'Pre-token board', onclick: function () { state.tab = 'board'; writeHash(); render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live-token comparables', onclick: function () { state.tab = 'live'; writeHash(); render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), q),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), cat),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), ch),
      el('div', { class: 'field' }, el('label', { for: 'mintvl', text: 'Min TVL' }), tv),
      el('div', { class: 'field' }, el('label', { for: 'sort', text: 'Sort' }), sort),
      wk,
      el('div', { class: 'field' }, el('span', { class: 'lab', text: 'View' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', text: state.tab === 'board' ? filtered().length + ' of ' + DATA.board_size + ' rows shown' : DATA.live.length + ' live-token comparables' }));
  }
  function sortHeader(key, label) {
    return el('th', { scope: 'col' }, el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = key === 'name' || key === 'rank' ? 1 : -1; } render(); } }, label, state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' ▼' : ' ▲' }) : null));
  }
  function boardTable() {
    var list = sorted(filtered());
    if (!list.length) return el('div', { class: 'panel' }, el('div', { class: 'empty' }, el('h2', { text: 'No protocol matches that filter' }), el('p', { text: 'Clear the search or pick another category to see the board again.' }), el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.watch = false; state.minTvl = 0; writeHash(); render(); } })));
    var max = DATA.rows[0].implied_value_usd || 1;
    var tb = el('tbody');
    list.forEach(function (r) {
      var tr = el('tr', { 'data-selected': state.selected === r.slug ? 'true' : 'false', tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } } },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' · ' + chainsOf(r) }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', null, el('div', { class: 'implied' }, el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(2, Math.round(r.implied_value_usd / max * 100)) + '%' })), el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) }))),
        el('td', { class: 'num', text: '$' + r.gas_cost_usd }),
        el('td', null, WATCH[r.slug] ? el('span', { class: 'tag watch', text: 'watchlist' }) : el('span', { class: 'tag', text: 'pre-token' })));
      tb.appendChild(tr);
    });
    return el('div', { class: 'panel' }, el('div', { class: 'table-wrap' }, el('table', null,
      el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model decomposition and farm plan.' }),
      el('thead', null, el('tr', null, sortHeader('rank', 'Rank'), sortHeader('name', 'Protocol'), sortHeader('tvl', 'TVL'), sortHeader('growth', '7d'), sortHeader('age', 'Age'), sortHeader('implied', 'Implied value'), el('th', { scope: 'col', text: 'Farm gas' }), el('th', { scope: 'col', text: 'Status' }))),
      tb)));
  }
  function liveTable() {
    var tb = el('tbody');
    DATA.live.forEach(function (r) {
      var ratio = r.tvl_usd > 0 && r.mcap_usd ? (r.mcap_usd / r.tvl_usd).toFixed(2) + 'x' : 'n/a';
      tb.appendChild(el('tr', null,
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' · ' + chainsOf(r) }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: ratio }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', null, el('span', { class: 'tag', text: 'already trades' }))));
    });
    return el('div', { class: 'panel' }, el('div', { class: 'table-wrap' }, el('table', null,
      el('caption', { class: 'sub', text: 'Live-token comparables: the market\u2019s own values, never model-implied. The fitted curve was trained on these protocols (top 24 of 144 by market cap).' }),
      el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Mcap / TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Token' }))),
      tb)));
  }
  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug; writeHash(); render();
    var d = document.getElementById('detail');
    if (d) d.scrollIntoView();
  }
  function detailView() {
    var row = DATA.rows.filter(function (r) { return r.slug === state.selected; })[0];
    if (!row) return null;
    var idx = DATA.rows.indexOf(row);
    var prev = idx > 0 ? DATA.rows[idx - 1] : null;
    var next = idx < DATA.rows.length - 1 ? DATA.rows[idx + 1] : null;
    var catF = Math.pow(10, row.category_adjustment_dex);
    return el('section', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' },
      el('div', { class: 'detail-head' },
        el('div', null,
          el('span', { class: 'sub', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + (WATCH[row.slug] ? ' · watchlist' : ' · early find') }),
          el('h2', { id: 'detail-title', text: row.name }),
          el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains || []).join(', ') + ' · TVL ' + fmtUsd(row.tvl_usd) + ' · 7d ' + fmtPct(row.change_7d) + ' · age ' + fmtAge(row.age_days) + (row.listed_at ? ' (listed ' + row.listed_at + ')' : '') })
        ),
        el('button', { class: 'button', type: 'button', text: 'Close', onclick: function () { state.selected = null; writeHash(); render(); } })
      ),
      el('div', { class: 'navrow' },
        prev ? el('button', { class: 'button', type: 'button', text: '← Prev: ' + prev.name, onclick: function () { openDetail(prev.slug); } }) : el('button', { class: 'button', type: 'button', disabled: 'disabled', text: '← First on the board' }),
        next ? el('button', { class: 'button', type: 'button', text: 'Next: ' + next.name + ' →', onclick: function () { openDetail(next.slug); } }) : el('button', { class: 'button', type: 'button', disabled: 'disabled', text: 'Last on the board →' })
      ),
      el('h3', { text: 'Model decomposition — base × category × growth × maturity × breadth' }),
      el('div', { class: 'decomp' },
        el('div', null, el('span', { text: 'Base (fitted curve at TVL)' }), el('b', { text: fmtUsd(row.base_usd) })),
        el('div', null, el('span', { text: 'Category adj (' + (row.category || 'Other') + ')' }), el('b', { text: fmtMult(catF) + ' (' + row.category_adjustment_dex + ' dex)' })),
        el('div', null, el('span', { text: 'Growth (' + row.growth_pct + '%)' }), el('b', { text: fmtMult(row.growth_multiplier) })),
        el('div', null, el('span', { text: 'Maturity (' + fmtAge(row.age_days) + ')' }), el('b', { text: fmtMult(row.maturity_multiplier) })),
        el('div', null, el('span', { text: 'Breadth (' + (row.chains || []).length + ' chains)' }), el('b', { text: fmtMult(row.breadth_multiplier) })),
        el('div', { class: 'tot' }, el('span', { text: 'Implied value' }), el('b', { text: fmtUsd(row.implied_value_usd) }))
      ),
      el('p', { class: 'sub', text: 'Curve: log10(mcap) = ' + row.curve_a + ' + ' + row.curve_b + ' x log10(TVL), fitted on ' + DATA.fitted.n + ' traded-token comparables (R² = ' + DATA.fitted.r2 + '). Farm gas for this plan: $' + row.gas_cost_usd + '.' }),
      el('p', { class: 'caution', text: 'Caution: this protocol records no token in the DefiLlama snapshot — that is the record, not proof it has none. Implied value is the entry\u2019s own claim, not a prediction that a token will launch.' }),
      el('h3', { text: 'Farm plan — ' + row.farm_steps.length + ' steps, costed' }),
      el('ol', { class: 'steps' }, row.farm_steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        return el('li', null, el('b', { text: at >= 0 ? s.slice(0, at) : s }), el('span', { class: 'cost', text: at >= 0 ? s.slice(at + 1) : '' }));
      }))
    );
  }
  function footer() {
    return el('footer', null,
      el('p', { text: 'Method: snapshot frozen 2026-11-14 (DefiLlama protocol index, ' + DATA.rows.length + ' pre-token rows ranked). Implied value is this entry\u2019s own claim from the fitted comparables curve — not a prediction that a token will launch, and not financial advice.' }),
      el('p', { text: 'Farm at your own risk. Never pay to claim an airdrop; claim only from the protocol\u2019s own published link. A protocol that records no token may still have one its record does not carry.' })
    );
  }
  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(modelPanel());
    var d = detailView();
    if (d) shell.appendChild(d);
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'live' ? liveTable() : boardTable());
    shell.appendChild(footer());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
  }
  // Watchlist slugs are embedded by main.ts as a compact lookup in data.js when present.
  readHash();
  render();
  window.addEventListener('hashchange', function () { readHash(); render(); });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.selected) { state.selected = null; writeHash(); render(); }
  });
})();
