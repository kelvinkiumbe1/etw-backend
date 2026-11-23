/* ETW equity chart — the Verified Track Record curve, in the app and on the public /track page.
   One self-contained file, no libraries: crisp SVG drawn at the container's real pixel size, a
   drawdown pane under the equity line, range presets, a crosshair with a readout on hover, touch
   and keyboard. The backend serves an identical copy (src/equity-chart.js) inline on the public page,
   so keep the two in step.

   ETWEquity.mount(el, curve, { theme:'dark'|'light', height:300 }) → { update(curve), destroy() }
   curve = [{ d:'YYYY-MM-DD', pnl, cum, trades }, …] — one point per trading day, cum = running net P&L. */
(function (root) {
  'use strict';
  if (root.ETWEquity) return;
  var DAY = 864e5, SVGNS = 'http://www.w3.org/2000/svg';
  var CSS = ''
    + '.eqc{--eqc-up:#22C55E;--eqc-dn:#EF4444;--eqc-grid:rgba(255,255,255,.065);--eqc-axis:rgba(236,238,244,.46);--eqc-text:#F3F4F8;--eqc-mut:rgba(236,238,244,.56);'
    + '--eqc-cross:rgba(236,238,244,.32);--eqc-tip:#1C1E26;--eqc-tip-line:rgba(255,255,255,.1);--eqc-seg:rgba(255,255,255,.05);--eqc-seg-on:rgba(255,255,255,.12);--eqc-dd:rgba(239,68,68,.16);'
    + 'position:relative;font-family:inherit;color:var(--eqc-text);-webkit-user-select:none;user-select:none}'
    + '.eqc.eqc-light{--eqc-up:#16A34A;--eqc-dn:#DC2626;--eqc-grid:rgba(15,23,42,.07);--eqc-axis:rgba(15,23,42,.5);--eqc-text:#0F172A;--eqc-mut:rgba(15,23,42,.55);'
    + '--eqc-cross:rgba(15,23,42,.28);--eqc-tip:#FFFFFF;--eqc-tip-line:rgba(15,23,42,.1);--eqc-seg:rgba(15,23,42,.04);--eqc-seg-on:#FFFFFF;--eqc-dd:rgba(220,38,38,.12)}'
    + '.eqc-top{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:0 0 10px}'
    + '.eqc-sum{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;min-width:0}'
    + '.eqc-lbl{font-size:12px;font-weight:600;color:var(--eqc-mut)}'
    + '.eqc-val{font-size:18px;font-weight:750;letter-spacing:-.01em;font-variant-numeric:tabular-nums}'
    + '.eqc-chg{font-size:12.5px;font-weight:650;font-variant-numeric:tabular-nums}.eqc-chg.up{color:var(--eqc-up)}.eqc-chg.dn{color:var(--eqc-dn)}'
    + '.eqc-chg em{font-style:normal;font-weight:500;color:var(--eqc-mut);margin-left:4px}'
    + '.eqc-rng{display:inline-flex;padding:3px;gap:2px;border-radius:9px;background:var(--eqc-seg);border:1px solid var(--eqc-tip-line)}'
    + '.eqc-rng button{appearance:none;border:0;background:transparent;color:var(--eqc-mut);font:600 11.5px/1 inherit;font-family:inherit;padding:6px 10px;border-radius:6px;cursor:pointer;font-variant-numeric:tabular-nums}'
    + '.eqc-rng button:hover{color:var(--eqc-text)}'
    + '.eqc-rng button[aria-pressed="true"]{background:var(--eqc-seg-on);color:var(--eqc-text);box-shadow:0 1px 2px rgba(0,0,0,.18)}'
    + '.eqc-rng button:focus-visible,.eqc-hit:focus-visible{outline:2px solid #7C6CF0;outline-offset:2px}'
    + '.eqc-plot{position:relative}.eqc-plot svg{display:block;overflow:visible;stroke:none!important;fill:none!important}'
    + '.eqc-hit{position:absolute;left:0;top:0;right:0;bottom:0;touch-action:pan-y;cursor:crosshair;border-radius:6px}'
    + '.eqc-tipbox{position:absolute;top:6px;z-index:2;pointer-events:none;min-width:168px;padding:10px 12px;border-radius:10px;background:var(--eqc-tip);border:1px solid var(--eqc-tip-line);'
    + 'box-shadow:0 12px 32px -12px rgba(0,0,0,.45);font-size:12px;line-height:1.5;opacity:0;transition:opacity .12s}'
    + '.eqc-tipbox.on{opacity:1}.eqc-tipbox h5{margin:0 0 6px;font-size:11.5px;font-weight:650;color:var(--eqc-mut)}'
    + '.eqc-tipbox p{margin:0;display:flex;justify-content:space-between;gap:16px;font-variant-numeric:tabular-nums}.eqc-tipbox p span{color:var(--eqc-mut)}.eqc-tipbox p b{font-weight:700}'
    + '.eqc-tipbox .up{color:var(--eqc-up)}.eqc-tipbox .dn{color:var(--eqc-dn)}'
    + '.eqc-empty{padding:40px 0;text-align:center;font-size:13px;color:var(--eqc-mut)}'
    + '@media print{.eqc-rng,.eqc-tipbox,.eqc-hit{display:none!important}.eqc{--eqc-up:#16A34A;--eqc-dn:#DC2626;--eqc-grid:rgba(15,23,42,.08);--eqc-axis:rgba(15,23,42,.55);--eqc-text:#0F172A;--eqc-mut:rgba(15,23,42,.6);--eqc-cross:rgba(15,23,42,.3);--eqc-tip:#fff;--eqc-dd:rgba(220,38,38,.12)}}';

  function css() {
    if (typeof document === 'undefined' || document.getElementById('eqc-css')) return;
    var s = document.createElement('style'); s.id = 'eqc-css'; s.textContent = CSS; document.head.appendChild(s);
  }
  function el(tag, attrs, parent) {
    var n = document.createElementNS(SVGNS, tag);
    for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function ms(d) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function dlong(t) { var d = new Date(t); return WD[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }
  function dshort(t) { var d = new Date(t); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()]; }
  function money(v, sign) {
    var n = Math.round(+v || 0), s = Math.abs(n).toLocaleString('en-US');
    return (n < 0 ? '-$' : sign && n > 0 ? '+$' : '$') + s;
  }
  function compact(v) {
    var a = Math.abs(v), s;
    if (a >= 1e6) s = (a / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    else if (a >= 1e3) s = (a / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
    else s = String(Math.round(a));
    return (v < 0 ? '-$' : '$') + s;
  }
  function niceStep(span, count) {
    var raw = span / Math.max(1, count), p = Math.pow(10, Math.floor(Math.log10(raw || 1))), f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  // Fritsch–Carlson monotone cubic: smooth, but never overshoots a day's real value
  function path(xs, ys) {
    var n = xs.length; if (!n) return '';
    if (n < 3) return 'M' + xs.map(function (x, i) { return x.toFixed(1) + ',' + ys[i].toFixed(1); }).join('L');
    var dx = [], dy = [], m = [], t = [];
    for (var i = 0; i < n - 1; i++) { dx[i] = xs[i + 1] - xs[i]; dy[i] = ys[i + 1] - ys[i]; m[i] = dx[i] ? dy[i] / dx[i] : 0; }
    t[0] = m[0]; t[n - 1] = m[n - 2];
    for (i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
    for (i = 0; i < n - 1; i++) {
      if (!m[i]) { t[i] = t[i + 1] = 0; continue; }
      var a = t[i] / m[i], b = t[i + 1] / m[i], h = a * a + b * b;
      if (h > 9) { var k = 3 / Math.sqrt(h); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
    }
    var d = 'M' + xs[0].toFixed(1) + ',' + ys[0].toFixed(1);
    for (i = 0; i < n - 1; i++) {
      var h3 = dx[i] / 3;
      d += 'C' + (xs[i] + h3).toFixed(1) + ',' + (ys[i] + t[i] * h3).toFixed(1) + ' ' + (xs[i + 1] - h3).toFixed(1) + ',' + (ys[i + 1] - t[i + 1] * h3).toFixed(1) + ' ' + xs[i + 1].toFixed(1) + ',' + ys[i + 1].toFixed(1);
    }
    return d;
  }

  function prepare(curve) {
    var pts = (curve || []).map(function (p) { return { t: ms(p.d), cum: +p.cum || 0, pnl: +p.pnl || 0, trades: +p.trades || 0 }; })
      .filter(function (p) { return isFinite(p.t); }).sort(function (a, b) { return a.t - b.t; });
    if (!pts.length) return [];
    // the record starts from zero the day before the first trade, so the first day's result is part of the curve
    pts.unshift({ t: pts[0].t - DAY, cum: 0, pnl: 0, trades: 0, start: true });
    var peak = 0;
    pts.forEach(function (p) { peak = Math.max(peak, p.cum); p.dd = p.cum - peak; });
    return pts;
  }
  var RANGES = [['1M', 30], ['3M', 91], ['6M', 182], ['YTD', 'ytd'], ['1Y', 365], ['All', 0]];
  function rangeFrom(key, pts) {
    var end = pts[pts.length - 1].t, r = RANGES.filter(function (x) { return x[0] === key; })[0];
    if (!r || !r[1]) return pts[0].t;
    if (r[1] === 'ytd') { var y = new Date(end).getUTCFullYear(); return Date.UTC(y, 0, 1); }
    return end - r[1] * DAY;
  }
  function rangesFor(pts) {
    var first = pts[0].t, end = pts[pts.length - 1].t, span = end - first;
    return RANGES.filter(function (r) {
      if (!r[1]) return true;
      if (r[1] === 'ytd') { var y0 = Date.UTC(new Date(end).getUTCFullYear(), 0, 1); return first < y0 && end - y0 > 14 * DAY && Math.abs((end - y0) - 365 * DAY) > 20 * DAY; }
      return span > r[1] * DAY * 1.15;
    }).map(function (r) { return r[0]; });
  }

  function mount(host, curve, opts) {
    css(); opts = opts || {};
    var state = { pts: prepare(curve), range: 'All', drawn: false, hover: -1 };
    host.innerHTML = '';
    var box = document.createElement('div');
    box.className = 'eqc' + (opts.theme === 'light' ? ' eqc-light' : '');
    host.appendChild(box);
    var top = document.createElement('div'); top.className = 'eqc-top'; box.appendChild(top);
    var plot = document.createElement('div'); plot.className = 'eqc-plot'; box.appendChild(plot);
    var svg = el('svg', { role: 'img' }, plot);
    var tip = document.createElement('div'); tip.className = 'eqc-tipbox'; plot.appendChild(tip);
    var hit = document.createElement('div'); hit.className = 'eqc-hit'; hit.tabIndex = 0; plot.appendChild(hit);
    var geo = null, ro = null;

    function visible() {
      var pts = state.pts; if (!pts.length) return [];
      var from = rangeFrom(state.range, pts), i = 0;
      while (i < pts.length - 1 && pts[i + 1].t <= from) i++;   // keep the day before the range as its baseline
      return pts.slice(i);
    }
    function header(v) {
      var ranges = rangesFor(state.pts);
      if (ranges.indexOf(state.range) < 0) state.range = 'All';
      var last = v[v.length - 1], base = v[0], chg = last.cum - base.cum;
      var since = state.range === 'All' ? 'since ' + dshort(state.pts[1] ? state.pts[1].t : base.t) + ' ' + new Date(state.pts[1] ? state.pts[1].t : base.t).getUTCFullYear()
        : state.range === 'YTD' ? 'this year' : 'last ' + ({ '1M': 'month', '3M': '3 months', '6M': '6 months', '1Y': 'year' })[state.range];
      top.innerHTML = '<div class="eqc-sum"><span class="eqc-lbl">Equity</span><b class="eqc-val">' + money(last.cum, true) + '</b>'
        + (state.range === 'All' ? '<span class="eqc-chg"><em style="margin:0">' + since + '</em></span>'
           : '<span class="eqc-chg ' + (chg >= 0 ? 'up' : 'dn') + '">' + money(chg, true) + '<em>' + since + '</em></span>') + '</div>'
        + (ranges.length > 1 ? '<div class="eqc-rng" role="group" aria-label="Time range">' + ranges.map(function (r) {
          return '<button type="button" data-r="' + r + '" aria-pressed="' + (r === state.range) + '">' + r + '</button>';
        }).join('') + '</div>' : '');
    }
    top.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('button[data-r]'); if (!b) return;
      state.range = b.getAttribute('data-r'); state.hover = -1; draw();
    });

    function draw() {
      var v = visible();
      if (v.length < 2) { top.innerHTML = ''; svg.innerHTML = ''; svg.setAttribute('width', 0); plot.style.height = 'auto'; tip.classList.remove('on');
        if (!plot.querySelector('.eqc-empty')) { var em = document.createElement('div'); em.className = 'eqc-empty'; em.textContent = 'The curve appears after the second verified trading day.'; plot.appendChild(em); }
        return; }
      var emp = plot.querySelector('.eqc-empty'); if (emp) emp.remove();
      header(v);
      var W = Math.max(260, Math.floor(plot.clientWidth || host.clientWidth || 600));
      var Htot = opts.height || 300, narrow = W < 520;
      var AX = 22, DDH = Math.max(42, Math.round(Htot * .16)), GAP = 26, R = narrow ? 50 : 60, L = 2, T = 8;
      var H = Htot - AX - DDH - GAP - T;
      svg.setAttribute('width', W); svg.setAttribute('height', Htot); svg.setAttribute('viewBox', '0 0 ' + W + ' ' + Htot);
      plot.style.height = Htot + 'px';
      svg.innerHTML = '';
      var t0 = v[0].t, t1 = v[v.length - 1].t, pw = W - L - R;
      var X = function (t) { return L + (t1 === t0 ? pw / 2 : (t - t0) / (t1 - t0) * pw); };
      var lo = Infinity, hi = -Infinity;
      v.forEach(function (p) { lo = Math.min(lo, p.cum); hi = Math.max(hi, p.cum); });
      if (state.range === 'All') { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
      if (hi - lo < 1) { hi += 50; lo -= 50; }
      // the plot hugs the data (a little air above and below); grid lines sit on round values inside it
      var y0 = lo - (hi - lo) * .05, y1 = hi + (hi - lo) * .08;
      if (state.range === 'All' && lo >= 0) y0 = 0;
      var step = niceStep(y1 - y0, H < 170 ? 3 : 5);
      var Y = function (c) { return T + (1 - (c - y0) / (y1 - y0)) * H; };
      var up = v[v.length - 1].cum >= v[0].cum, col = up ? 'var(--eqc-up)' : 'var(--eqc-dn)';
      var gid = 'eqg' + Math.random().toString(36).slice(2, 8);
      var defs = el('defs', {}, svg);
      var lg = el('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
      el('stop', { offset: '0', 'stop-color': col, 'stop-opacity': '.20' }, lg);
      el('stop', { offset: '.75', 'stop-color': col, 'stop-opacity': '.04' }, lg);
      el('stop', { offset: '1', 'stop-color': col, 'stop-opacity': '0' }, lg);

      // grid + right-hand price axis
      var g = el('g', {}, svg), lastY = Y(v[v.length - 1].cum);
      for (var yv = Math.ceil(y0 / step) * step; yv <= y1; yv += step) {
        var zero = Math.abs(yv) < step / 1e6, yy = Math.round(Y(yv)) + .5;
        if (yy < T - 1 || yy > T + H + 1) continue;
        el('line', { x1: L, x2: L + pw, y1: yy, y2: yy, stroke: zero ? 'var(--eqc-cross)' : 'var(--eqc-grid)', 'stroke-width': 1, 'stroke-dasharray': zero ? null : '2 4' }, g);
        if (Math.abs(yy - lastY) < 14) continue;   // the current-value tag sits here
        var tx = el('text', { x: W - 2, y: yy + 3.5, 'text-anchor': 'end', fill: 'var(--eqc-axis)', 'font-size': 10.5, 'font-variant-numeric': 'tabular-nums' }, g);
        tx.textContent = compact(zero ? 0 : yv);
      }

      // x axis: month starts, or weeks on short ranges
      var span = t1 - t0, ticks = [];
      if (span <= 50 * DAY) { var d0 = new Date(t0); var s = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate() + ((8 - d0.getUTCDay()) % 7 || 7)); for (var tt = s; tt <= t1; tt += 7 * DAY) ticks.push([tt, dshort(tt)]); }
      else {
        var dA = new Date(t0), mY = dA.getUTCFullYear(), mM = dA.getUTCMonth() + 1, multiYear = new Date(t1).getUTCFullYear() !== mY;
        for (;;) { var mt = Date.UTC(mY + Math.floor((mM) / 12), mM % 12, 1); if (mt > t1) break; var md = new Date(mt);
          ticks.push([mt, MON[md.getUTCMonth()] + (multiYear && md.getUTCMonth() === 0 ? ' ' + md.getUTCFullYear() : '')]); mM++; }
        var maxT = Math.max(2, Math.floor(pw / 74)), every = Math.ceil(ticks.length / maxT);
        ticks = ticks.filter(function (_, i) { return i % every === 0; });
      }
      var xa = el('g', {}, svg), axY = T + H + DDH + GAP + 15;
      ticks.forEach(function (k) {
        var x = X(k[0]); if (x < L + 16 || x > L + pw - 16) return;
        var lt = el('text', { x: x, y: axY, 'text-anchor': 'middle', fill: 'var(--eqc-axis)', 'font-size': 10.5 }, xa); lt.textContent = k[1];
      });

      // equity area + line
      var xs = v.map(function (p) { return X(p.t); }), ys = v.map(function (p) { return Y(p.cum); });
      var line = path(xs, ys);
      el('path', { d: line + 'L' + xs[xs.length - 1].toFixed(1) + ',' + (T + H) + 'L' + xs[0].toFixed(1) + ',' + (T + H) + 'Z', fill: 'url(#' + gid + ')' }, svg);
      var ln = el('path', { d: line, fill: 'none', stroke: col, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
      if (!state.drawn && !(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches) && ln.getTotalLength) {
        try { var len = ln.getTotalLength(); ln.style.strokeDasharray = len; ln.style.strokeDashoffset = len; ln.getBoundingClientRect(); ln.style.transition = 'stroke-dashoffset .7s cubic-bezier(.3,.7,.2,1)'; ln.style.strokeDashoffset = 0;
          setTimeout(function () { ln.style.strokeDasharray = ''; ln.style.transition = ''; }, 760); } catch (e) {}
      }
      state.drawn = true;

      // last value tag on the axis
      var lx = xs[xs.length - 1], lyv = ys[ys.length - 1];
      el('circle', { cx: lx, cy: lyv, r: 3.2, fill: col }, svg);
      var lastCum = v[v.length - 1].cum, tagTxt = Math.abs(lastCum) < 1e5 ? money(lastCum) : compact(lastCum), tw = tagTxt.length * 6.3 + 12;
      var tg = el('g', {}, svg);
      el('rect', { x: W - tw, y: lyv - 9, width: tw, height: 18, rx: 4, fill: col }, tg);
      var tt2 = el('text', { x: W - tw / 2, y: lyv + 3.6, 'text-anchor': 'middle', fill: '#fff', 'font-size': 10.5, 'font-weight': 700, 'font-variant-numeric': 'tabular-nums' }, tg); tt2.textContent = tagTxt;

      // drawdown pane
      var dTop = T + H + GAP, minDD = 0;
      v.forEach(function (p) { minDD = Math.min(minDD, p.dd); });
      var dScale = minDD < 0 ? -minDD : 1;
      var DY = function (dd) { return dTop + Math.min(1, dd / -dScale) * (DDH - 6); };
      el('line', { x1: L, x2: L + pw, y1: dTop + .5, y2: dTop + .5, stroke: 'var(--eqc-cross)', 'stroke-opacity': .6, 'stroke-width': 1 }, svg);
      var dl = el('text', { x: L, y: dTop - 7, fill: 'var(--eqc-mut)', 'font-size': 10.5, 'font-weight': 600 }, svg);
      dl.textContent = 'Drawdown from peak';
      var dv = el('text', { x: W - 2, y: DY(minDD) + 3.5, 'text-anchor': 'end', fill: 'var(--eqc-axis)', 'font-size': 10.5, 'font-variant-numeric': 'tabular-nums' }, svg); dv.textContent = minDD < 0 ? money(minDD) : '$0';
      if (minDD < 0) {
        var dys = v.map(function (p) { return DY(p.dd); }), dpath = path(xs, dys);
        el('path', { d: dpath + 'L' + xs[xs.length - 1].toFixed(1) + ',' + dTop + 'L' + xs[0].toFixed(1) + ',' + dTop + 'Z', fill: 'var(--eqc-dd)' }, svg);
        // the outline only shows where the record is under its peak, not along the zero line
        var cid = gid + 'c', cp = el('clipPath', { id: cid }, defs); el('rect', { x: 0, y: dTop + 1.2, width: W, height: DDH }, cp);
        el('path', { d: dpath, fill: 'none', stroke: 'var(--eqc-dn)', 'stroke-width': 1.3, 'stroke-linejoin': 'round', 'stroke-opacity': .85, 'clip-path': 'url(#' + cid + ')' }, svg);
      }

      // crosshair layer
      var cross = el('g', { opacity: 0 }, svg);
      var cl = el('line', { y1: T, y2: dTop + DDH, stroke: 'var(--eqc-cross)', 'stroke-width': 1, 'stroke-dasharray': '3 3' }, cross);
      var cdot = el('circle', { r: 4.5, fill: col, stroke: 'var(--eqc-tip)', 'stroke-width': 2 }, cross);
      var ddot = el('circle', { r: 3, fill: 'var(--eqc-dn)' }, cross);
      geo = { v: v, xs: xs, ys: ys, W: W, L: L, pw: pw, cross: cross, cl: cl, cdot: cdot, ddot: ddot, DY: DY };
      svg.setAttribute('aria-label', 'Verified equity curve: ' + money(v[v.length - 1].cum, true) + ' on ' + dlong(v[v.length - 1].t) + ', worst drawdown ' + money(minDD) + ' in this range.');
      if (state.hover >= 0) show(Math.min(state.hover, v.length - 1)); else hide();
    }

    function show(i) {
      if (!geo) return; var v = geo.v, p = v[i]; if (!p) return;
      state.hover = i;
      var x = geo.xs[i];
      geo.cross.setAttribute('opacity', 1);
      geo.cl.setAttribute('x1', x); geo.cl.setAttribute('x2', x);
      geo.cdot.setAttribute('cx', x); geo.cdot.setAttribute('cy', geo.ys[i]);
      geo.ddot.setAttribute('cx', x); geo.ddot.setAttribute('cy', geo.DY(p.dd)); geo.ddot.setAttribute('opacity', p.dd < 0 ? 1 : 0);
      tip.innerHTML = '<h5>' + (p.start ? 'Start of record' : dlong(p.t)) + '</h5>'
        + '<p><span>Equity</span><b>' + money(p.cum, true) + '</b></p>'
        + (p.start ? '' : '<p><span>Day</span><b class="' + (p.pnl >= 0 ? 'up' : 'dn') + '">' + money(p.pnl, true) + '</b></p>'
          + '<p><span>Trades</span><b>' + p.trades + '</b></p>')
        + (p.dd < 0 ? '<p><span>From peak</span><b class="dn">' + money(p.dd) + '</b></p>' : '');
      tip.classList.add('on');
      var tw = tip.offsetWidth || 170, left = x + 14;
      if (left + tw > geo.L + geo.pw) left = x - tw - 14;
      tip.style.left = Math.max(0, left) + 'px';
    }
    function hide() { state.hover = -1; tip.classList.remove('on'); if (geo) geo.cross.setAttribute('opacity', 0); }
    function nearest(clientX) {
      var r = svg.getBoundingClientRect(), x = clientX - r.left, xs = geo.xs, lo = 0, hi = xs.length - 1;
      while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (xs[mid] < x) lo = mid; else hi = mid; }
      return Math.abs(xs[lo] - x) <= Math.abs(xs[hi] - x) ? lo : hi;
    }
    hit.addEventListener('pointermove', function (e) { if (geo) show(nearest(e.clientX)); });
    hit.addEventListener('pointerdown', function (e) { if (geo) show(nearest(e.clientX)); });
    hit.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse') hide(); });
    hit.addEventListener('pointerup', function (e) { if (e.pointerType !== 'mouse') setTimeout(hide, 1800); });
    hit.addEventListener('blur', hide);
    hit.addEventListener('keydown', function (e) {
      if (!geo) return; var n = geo.v.length, i = state.hover < 0 ? n - 1 : state.hover;
      if (e.key === 'ArrowLeft') { show(Math.max(0, i - 1)); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { show(Math.min(n - 1, i + 1)); e.preventDefault(); }
      else if (e.key === 'Home') { show(0); e.preventDefault(); }
      else if (e.key === 'End') { show(n - 1); e.preventDefault(); }
      else if (e.key === 'Escape') hide();
    });
    hit.setAttribute('aria-label', 'Equity curve. Use the left and right arrow keys to read each day.');

    var lastW = 0;
    if (root.ResizeObserver) { ro = new ResizeObserver(function () { var w = Math.floor(plot.clientWidth); if (w && w !== lastW) { lastW = w; draw(); } }); ro.observe(plot); }
    else root.addEventListener('resize', draw);
    draw(); lastW = Math.floor(plot.clientWidth);
    return {
      update: function (c) { state.pts = prepare(c); state.hover = -1; draw(); },
      theme: function (t) { box.classList.toggle('eqc-light', t === 'light'); },
      destroy: function () { try { ro && ro.disconnect(); } catch (e) {} host.innerHTML = ''; }
    };
  }

  // Month-by-month results from the same daily curve (used by the public page).
  function months(curve) {
    var out = {};
    (curve || []).forEach(function (p) { var k = String(p.d || '').slice(0, 7); if (!/^\d{4}-\d{2}$/.test(k)) return; var o = out[k] || (out[k] = { pnl: 0, trades: 0, days: 0 }); o.pnl += +p.pnl || 0; o.trades += +p.trades || 0; o.days++; });
    return out;
  }
  root.ETWEquity = { mount: mount, months: months, money: money, compact: compact };
})(typeof window !== 'undefined' ? window : this);
