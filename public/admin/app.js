

const API = '/api';
let TOKEN = localStorage.getItem('np_admin_token');

const $  = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => Array.from(root.querySelectorAll(s));
// Null-safe innerHTML/textContent setters — a missing element (stale
// cached HTML mid-deploy, a renamed id, a view that isn't mounted yet)
// should never throw and blank an entire dashboard section.
function setHtml(id, html){ const el = document.getElementById(id); if (el) el.innerHTML = html; }
function setText(id, text){ const el = document.getElementById(id); if (el) el.textContent = text; }

let __doctorsCache = [];
let __apptsCache = [];

async function api(path, opts = {}) {
  const tokenAtCallTime = TOKEN; // snapshot — used to detect "session expired"
  const headers = {
    'Content-Type': 'application/json',
    ...(tokenAtCallTime && { Authorization: 'Bearer ' + tokenAtCallTime }),
    ...(opts.headers || {})
  };
  const r = await fetch(API + path, { ...opts, headers });
  let data = null;
  try { data = await r.json(); } catch(_) {}

  if (r.status === 401) {
    if (tokenAtCallTime) {
      localStorage.removeItem('np_admin_token');
      TOKEN = null;
      showLogin();
      const err = new Error('Session expired'); err.status = 401; throw err;
    }
    const err = new Error((data && (data.error || data.message)) || 'Unauthorized');
    err.status = 401; throw err;
  }

  if (!r.ok) throw new Error((data && (data.error || data.message)) || ('HTTP ' + r.status));
  return data;
}

function escapeHtml(s){
  return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function stripDrPrefix(name){
  return String(name == null ? '' : name).replace(/^\s*(dr\.?\s+)+/i, '').trim();
}
function drName(name){
  const clean = stripDrPrefix(name);
  return clean ? 'Dr. ' + clean : 'Doctor';
}
function drNameHtml(name){ return escapeHtml(drName(name)); }
function fmtDate(d){
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
}
function fmtTime(hhmm){
  if (!hhmm) return '';
  const m = String(hhmm).match(/^(\d{1,2}):(\d{2})/); if(!m) return hhmm;
  let h = parseInt(m[1],10); const min = m[2];
  const suffix = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${h}:${min} ${suffix}`;
}
// Dashboard welcome header: greeting by time of day + a live-updating date and
// clock. Purely presentational — never throws, and only runs while the
// welcome elements are on the page.
let __dashClockTimer = null;
function startDashClock(){
  const greetEl = document.getElementById('dashGreeting');
  const dateEl  = document.getElementById('dashWelcomeDate');
  const timeEl  = document.getElementById('dashWelcomeTime');
  if (!dateEl && !timeEl && !greetEl) return;
  function tick(){
    const now = new Date();
    const h = now.getHours();
    const greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    if (greetEl) greetEl.textContent = greet;
    if (dateEl) dateEl.textContent = now.toLocaleDateString('en-IN', { weekday:'short', day:'2-digit', month:'short', year:'numeric' });
    if (timeEl) timeEl.textContent = now.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' });
  }
  tick();
  if (__dashClockTimer) clearInterval(__dashClockTimer);
  __dashClockTimer = setInterval(tick, 30000);
}
function fmtDateTime(iso){
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { day:'2-digit', month:'short' }) + ' ' +
         d.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' });
}
function fmtCurrency(n){
  const v = Number(n||0);
  if (v >= 100000) return '₹' + (v/100000).toFixed(v%100000===0?0:1) + 'L';
  if (v >= 1000)   return '₹' + (v/1000).toFixed(v%1000===0?0:1) + 'k';
  return '₹' + v.toLocaleString('en-IN');
}
function fmtCurrencyFull(n){
  if (typeof NPFmt !== 'undefined' && NPFmt.inr) return NPFmt.inr(n);
  const v = Number(n||0);
  return '₹' + v.toLocaleString('en-IN');
}
function statusBadge(s){
  const map = {
    CONFIRMED:'np-badge--green', PENDING:'np-badge--amber',
    COMPLETED:'np-badge--blue',  CANCELLED:'np-badge--red',
    NO_SHOW:'np-badge--slate'
  };
  return `<span class="np-badge ${map[s]||'np-badge--slate'}"><span class="np-badge__dot"></span>${escapeHtml(s||'—')}</span>`;
}
function typeBadge(t){
  if (t === 'ONLINE')  return `<span class="np-badge np-badge--mint"><span class="np-badge__dot"></span>Online</span>`;
  if (t === 'OFFLINE') return `<span class="np-badge np-badge--blue"><span class="np-badge__dot"></span>In-person</span>`;
  return '';
}
function paymentBadge(p){
  const map = {
    PAID:           ['np-badge--green', 'Paid'],
    CASH_COLLECTED: ['np-badge--green', 'Cash collected'],
    CASH_PENDING:   ['np-badge--amber', 'Cash pending'],
    UNPAID:         ['np-badge--amber', 'Unpaid'],
    FAILED:         ['np-badge--red',   'Failed'],
    REFUNDED:       ['np-badge--slate', 'Refunded']
  };
  const m = map[p]; if (!m) return `<span class="np-badge np-badge--slate"><span class="np-badge__dot"></span>${escapeHtml(p||'—')}</span>`;
  return `<span class="np-badge ${m[0]}"><span class="np-badge__dot"></span>${m[1]}</span>`;
}
function notifStatusBadge(s){
  if (s === 'SENT')   return `<span class="np-badge np-badge--green"><span class="np-badge__dot"></span>Sent</span>`;
  if (s === 'FAILED') return `<span class="np-badge np-badge--red"><span class="np-badge__dot"></span>Failed</span>`;
  if (s === 'QUEUED') return `<span class="np-badge np-badge--amber"><span class="np-badge__dot"></span>Queued</span>`;
  return `<span class="np-badge np-badge--slate"><span class="np-badge__dot"></span>${escapeHtml(s||'—')}</span>`;
}
function channelBadge(c){
  if (c === 'WHATSAPP') return `<span class="np-badge np-badge--mint">WhatsApp</span>`;
  if (c === 'EMAIL')    return `<span class="np-badge np-badge--blue">Email</span>`;
  return `<span class="np-badge np-badge--slate">${escapeHtml(c||'—')}</span>`;
}
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginError').classList.add('hidden');
  try {
    const r = await fetch(API + '/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('#email').value, password: $('#password').value })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Login failed');
    if (data.role !== 'ADMIN') throw new Error('Not an admin account');
    TOKEN = data.token;
    localStorage.setItem('np_admin_token', TOKEN);
    if (typeof NPSession !== 'undefined') NPSession.start(TOKEN);
    showDashboard();
  } catch (err) {
    $('#loginError').textContent = err.message;
    $('#loginError').classList.remove('hidden');
  }
});
function togglePasswordVisibility(btn) {
  if (!btn) return;
  const targetId = btn.getAttribute('data-target');
  const input = document.getElementById(targetId);
  if (!input) return;
  const showIcon = btn.querySelector('.np-password-toggle__icon--show');
  const hideIcon = btn.querySelector('.np-password-toggle__icon--hide');
  const isHidden = input.type === 'password';
  input.type = isHidden ? 'text' : 'password';
  btn.setAttribute('aria-pressed', isHidden ? 'true' : 'false');
  btn.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
  if (showIcon) showIcon.style.display = isHidden ? 'none' : '';
  if (hideIcon) hideIcon.style.display = isHidden ? '' : 'none';
}

async function forgotPassword() {
  const email = await NPModal.prompt({
    title: 'Forgot password',
    message: 'Enter the email address associated with your admin account. If it matches, we\u2019ll send you a reset link.',
    placeholder: 'admin@neokidspro.in',
    inputType: 'email',
    okText: 'Send reset link',
  });
  if (!email || !email.trim()) return;
  try {
    const res = await api('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email: email.trim() }) });
    if (res.previewUrl) {
      await NPModal.alert({
        title: 'Reset link generated (mock mode)',
        message: res.previewUrl,
        okText: 'Copy & close',
      });
      try { await navigator.clipboard.writeText(res.previewUrl); NPToast.success('Reset link copied to clipboard'); } catch (_) {  }
    } else {
      NPToast.success('If the account exists, a reset link has been sent.');
    }
  } catch (err) { NPToast.error(err.message); }
}

function logout() {
  localStorage.removeItem('np_admin_token');
  TOKEN = null;
  __doctorsCache = [];
  __apptsCache = [];
  if (typeof NPSession !== 'undefined') NPSession.stop();
  showLogin();
}

function showLogin() {
  $('#dashboard').classList.add('hidden');
  $('#loginScreen').classList.remove('hidden');
  const f = $('#loginForm'); if (f) f.reset();
  const err = $('#loginError'); if (err) { err.textContent = ''; err.classList.add('hidden'); }
}

const VIEW_META = {
  dashboardView:   { title:'Dashboard',          sub:'Overview of your clinic' },
  doctorsView:     { title:'Doctors',            sub:'Manage clinic doctors and their performance' },
  apptsView:       { title:'Appointments',       sub:'All bookings across the clinic' },
  revenueView:     { title:'Revenue Reports',    sub:'Monthly clinic revenue — Cashfree only' },
  settlementsView: { title:'Doctor Settlements', sub:'Generate, review, and pay monthly doctor settlements' },
  invoicesView:    { title:'Invoices',           sub:'Settlement invoices issued to doctors' },
  recInvoicesView: { title:'Reception Invoices',  sub:'Consultation invoices generated at clinic front desks' },
  onlineInvoicesView: { title:'Online Booking Invoices', sub:'Invoices from NeoKidsPro patient online bookings' },
  notifView:       { title:'Notification Logs',  sub:'Audit WhatsApp & email deliveries' },
  settingsView:    { title:'Settings',           sub:'Account management' }
};
// Clicking a "recent appointment" row used to just dump the admin into the
// full, unfiltered Appointments list — technically "somewhere", but not
// the appointment they clicked. Pre-fill the search with that patient's
// name so landing on Appointments actually shows their booking(s).
function viewAppointmentInList(patientName){
  const search = document.getElementById('apptSearch');
  if (search) search.value = patientName || '';
  setView('apptsView');
}

function setView(view, opts) {
  $$('.tab-pane').forEach(v => v.classList.add('hidden'));
  const el = document.getElementById(view); if (el) el.classList.remove('hidden');
  $$('.np-nav-item').forEach(n => n.classList.remove('active'));
  const link = document.querySelector(`[data-view="${view}"]`);
  if (link) link.classList.add('active');
  const meta = VIEW_META[view];
  if (meta) { $('#pageTitle').textContent = meta.title; $('#pageSubtitle').textContent = meta.sub; }
  try {
    if (!(opts && opts.skipHash)) {
      const slug = view.replace(/View$/, '');
      if (location.hash !== '#' + slug) history.replaceState(null, '', '#' + slug);
    }
  } catch (_) {}
  if (view === 'dashboardView') loadDashboard();
  if (view === 'doctorsView')   loadDoctors();
  if (view === 'apptsView')     { loadDoctorsForFilter(); loadAppointments(); _setupApptDateRange(); }
  if (view === 'notifView')     { loadNotifTemplates(); loadNotifications(); }
  if (view === 'revenueView'     && window.Finance) Finance.loadRevenue();
  if (view === 'settlementsView' && window.Finance) Finance.loadSettlements();
  if (view === 'invoicesView'    && window.Finance) Finance.loadInvoices();
}

function setupSidebar(){
  const sidebar = $('#sidebar'); const backdrop = $('#sidebarBackdrop'); const toggle = $('#sidebarToggle');
  if (!sidebar || !toggle || !backdrop) return;
  if (toggle.__bound) return; toggle.__bound = true;
  function open(){ sidebar.classList.add('is-open'); backdrop.classList.add('is-open'); document.body.classList.add('np-drawer-open'); }
  function close(){ sidebar.classList.remove('is-open'); backdrop.classList.remove('is-open'); document.body.classList.remove('np-drawer-open'); }
  toggle.addEventListener('click', () => sidebar.classList.contains('is-open') ? close() : open());
  backdrop.addEventListener('click', close);
  window.addEventListener('resize', () => { if (window.innerWidth > 1023) close(); });
  $$('.np-nav-item').forEach(b => b.addEventListener('click', () => {
    setView(b.dataset.view);
    if (window.matchMedia('(max-width:1023px)').matches) close();
  }));
}
function setupProfileMenu(){
  const trigger = $('#profileTrigger'); const menu = $('#profileDropdown');
  if (!trigger || !menu) return;
  if (trigger.__bound) return; trigger.__bound = true;
  trigger.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('is-open'); trigger.setAttribute('aria-expanded', menu.classList.contains('is-open')); });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target) && !trigger.contains(e.target)) menu.classList.remove('is-open'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') menu.classList.remove('is-open'); });
}

// ─────────────────────────────────────────────────────────────────
// Dashboard: "Appointments — last 14 days" chart
// Responsive SVG bar chart with gridlines, axis labels, an average
// reference line, a highlighted peak day, and hover/tap/keyboard
// tooltips showing exact counts, completions, and revenue per day.
// ─────────────────────────────────────────────────────────────────
let _dailyChartData = null;
let _dailyChartResizeObs = null;

function renderDailyChart(data){
  _dailyChartData = Array.isArray(data) ? data : [];
  const wrap = $('#dailyChart');
  if (!wrap) return;

  drawDailyChart();

  if (!_dailyChartResizeObs) {
    if ('ResizeObserver' in window) {
      let lastW = Math.round(wrap.getBoundingClientRect().width);
      _dailyChartResizeObs = new ResizeObserver(entries => {
        const w = Math.round(entries[0].contentRect.width);
        if (Math.abs(w - lastW) < 4) return;
        lastW = w;
        drawDailyChart();
      });
      _dailyChartResizeObs.observe(wrap);
    } else {
      _dailyChartResizeObs = true; // sentinel so we don't re-bind
      window.addEventListener('resize', () => drawDailyChart());
    }
  }
}

function drawDailyChart(){
  const wrap = $('#dailyChart');
  const data = _dailyChartData || [];
  if (!wrap) return;

  if (!data.length){
    wrap.innerHTML = `<div class="np-empty" style="padding:2rem 0;"><div class="np-empty__sub">No appointment data yet.</div></div>`;
    return;
  }

  const containerW = Math.max(240, Math.round(wrap.getBoundingClientRect().width) || 600);
  const isNarrow = containerW < 460;
  const W = containerW;
  const H = isNarrow ? 220 : 290;
  const marginTop = 28;
  const marginRight = isNarrow ? 8 : 14;
  const marginBottom = isNarrow ? 34 : 38;

  const maxRaw = Math.max(0, ...data.map(d => Number(d.total) || 0));
  const stepsCount = 4;
  const niceMax = Math.max(stepsCount, Math.ceil(maxRaw / stepsCount) * stepsCount);
  const stepVal = niceMax / stepsCount;
  const marginLeft = Math.min(50, Math.max(24, 14 + String(niceMax).length * 8));

  const plotW = Math.max(10, W - marginLeft - marginRight);
  const plotH = H - marginTop - marginBottom;
  const n = data.length;
  const band = plotW / n;
  const barW = Math.max(isNarrow ? 4 : 6, Math.min(isNarrow ? 12 : 18, band * 0.38));

  const avg = data.reduce((s, d) => s + (Number(d.total) || 0), 0) / data.length;
  const peakIdx = data.reduce((best, d, i) => (Number(d.total) || 0) > (Number(data[best].total) || 0) ? i : best, 0);
  const peakVal = Number(data[peakIdx].total) || 0;

  // gridlines + y-axis labels
  let gridLines = '', yLabels = '';
  for (let s = 0; s <= stepsCount; s++){
    const val = Math.round(stepVal * s);
    const y = marginTop + plotH - (val / niceMax) * plotH;
    gridLines += `<line class="np-chart__grid" x1="${marginLeft}" x2="${(W - marginRight).toFixed(1)}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"></line>`;
    yLabels   += `<text class="np-chart__ylabel" x="${marginLeft - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${val}</text>`;
  }

  // average reference line
  let avgLine = '';
  if (peakVal > 0 && avg > 0.15) {
    const yAvg = marginTop + plotH - (avg / niceMax) * plotH;
    const avgText = avg % 1 === 0 ? String(avg) : avg.toFixed(1);
    avgLine = `
      <line class="np-chart__avgline" x1="${marginLeft}" x2="${(W - marginRight).toFixed(1)}" y1="${yAvg.toFixed(1)}" y2="${yAvg.toFixed(1)}"></line>
      <text class="np-chart__avglabel" x="${(W - marginRight).toFixed(1)}" y="${(yAvg - 5).toFixed(1)}" text-anchor="end">avg ${avgText}</text>`;
  }

  // Fixed 14-day range means labels can overlap on narrower screens —
  // show every other date once each column has less room than a label needs.
  const minLabelBand = 34;
  const labelEvery = band < minLabelBand ? 2 : 1;

  // bars + x-axis date labels
  let bars = '', xlabels = '';
  let lastMonth = null;
  data.forEach((d, i) => {
    const total = Number(d.total) || 0;
    const cx = marginLeft + band * i + band / 2;
    const h = total > 0 ? Math.max(3, (total / niceMax) * plotH) : 2;
    const y = marginTop + plotH - h;
    const isPeak = i === peakIdx && total > 0;
    const isToday = i === data.length - 1;
    const barCls = total === 0
      ? 'np-chart__bar np-chart__bar--muted'
      : (isPeak ? 'np-chart__bar np-chart__bar--peak' : 'np-chart__bar');

    const dt = new Date(d.date + 'T00:00:00');
    const dayNum = dt.getDate();
    const monthAbbr = dt.toLocaleDateString('en-IN', { month: 'short' });
    const weekday = dt.toLocaleDateString('en-IN', { weekday: 'short' });
    const showMonth = lastMonth !== monthAbbr;
    lastMonth = monthAbbr;

    bars += `
      <g class="np-chart__col${isToday ? ' np-chart__col--today' : ''}" data-i="${i}" tabindex="0"
         role="img" aria-label="${escapeHtml(weekday)}, ${dayNum} ${escapeHtml(monthAbbr)}: ${total} appointment${total === 1 ? '' : 's'}${isToday ? ' (today)' : ''}">
        <rect class="np-chart__hit" x="${(cx - band / 2).toFixed(1)}" y="${marginTop}" width="${band.toFixed(1)}" height="${plotH.toFixed(1)}"></rect>
        <rect class="${barCls}" x="${(cx - barW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(4, barW / 2).toFixed(1)}"></rect>
        ${isPeak ? `<text class="np-chart__peaklabel" x="${cx.toFixed(1)}" y="${(y - 8).toFixed(1)}" text-anchor="middle">${total}</text>` : ''}
      </g>`;

    // Always label "today" and the first day of the range even when
    // thinning labels, so the visible axis never looks arbitrary.
    const forceShow = isToday || i === 0;
    if (forceShow || i % labelEvery === 0) {
      xlabels += `<text class="np-chart__xlabel${isToday ? ' np-chart__xlabel--today' : ''}" x="${cx.toFixed(1)}" y="${(H - marginBottom + 16).toFixed(1)}" text-anchor="middle">${showMonth ? escapeHtml(monthAbbr) + ' ' : ''}${dayNum}</text>`;
    }
  });

  const peakDateLabel = escapeHtml(new Date(data[peakIdx].date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }));

  wrap.innerHTML = `
    <svg class="np-chart__svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="group" aria-label="Daily appointment volume for the last ${n} days">
      <g class="np-chart__grid-group">${gridLines}</g>
      <g class="np-chart__bars">${bars}</g>
      ${avgLine}
      <g class="np-chart__ylabels">${yLabels}</g>
      <g class="np-chart__xlabels">${xlabels}</g>
      <line class="np-chart__axis" x1="${marginLeft}" x2="${(W - marginRight).toFixed(1)}" y1="${(marginTop + plotH).toFixed(1)}" y2="${(marginTop + plotH).toFixed(1)}"></line>
    </svg>
    <div class="np-chart__tooltip" id="dailyChartTooltip" role="tooltip" aria-hidden="true"></div>
    <div class="np-chart__legend">
      <span class="np-chart__legend-item"><i class="np-chart__legend-swatch"></i>Appointments</span>
      ${peakVal > 0 ? `<span class="np-chart__legend-item"><i class="np-chart__legend-swatch np-chart__legend-swatch--peak"></i>Busiest day</span>
      <span class="np-chart__legend-item np-chart__legend-note">Peak: ${peakVal} on ${peakDateLabel}</span>` : ''}
    </div>
  `;

  bindDailyChartInteractions(wrap, data);
}

function bindDailyChartInteractions(wrap, data){
  const svg = wrap.querySelector('.np-chart__svg');
  const tooltip = wrap.querySelector('#dailyChartTooltip');
  if (!svg || !tooltip) return;
  let pinned = null;

  function contentFor(i){
    const d = data[i]; if (!d) return '';
    const dt = new Date(d.date + 'T00:00:00');
    const label = dt.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    const total = Number(d.total) || 0, completed = Number(d.completed) || 0, revenue = Number(d.revenue) || 0;
    return `
      <div class="np-chart__tooltip-date">${escapeHtml(label)}</div>
      <div class="np-chart__tooltip-main">${total} appointment${total === 1 ? '' : 's'}</div>
      <div class="np-chart__tooltip-sub">${completed} completed${revenue > 0 ? ' · ' + fmtCurrency(revenue) + ' revenue' : ''}</div>
    `;
  }

  function show(i, col){
    const rect = col.querySelector('rect:nth-child(2)');
    if (!rect) return;
    tooltip.innerHTML = contentFor(i);
    tooltip.classList.add('is-visible');
    tooltip.setAttribute('aria-hidden', 'false');

    const barBox = rect.getBoundingClientRect();
    const wrapBox = wrap.getBoundingClientRect();
    let left = barBox.left - wrapBox.left + barBox.width / 2;
    const top = barBox.top - wrapBox.top;

    const ttWidth = tooltip.offsetWidth || 160;
    const minLeft = ttWidth / 2 + 4;
    const maxLeft = wrapBox.width - ttWidth / 2 - 4;
    left = Math.max(minLeft, Math.min(maxLeft, left));

    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';

    $$('.np-chart__col', svg).forEach(c => c.classList.toggle('is-active', c === col));
  }
  function hide(){
    tooltip.classList.remove('is-visible');
    tooltip.setAttribute('aria-hidden', 'true');
    $$('.np-chart__col', svg).forEach(c => c.classList.remove('is-active'));
    pinned = null;
  }

  svg.addEventListener('pointermove', (e) => {
    if (pinned != null || e.pointerType === 'touch') return;
    const col = e.target.closest('.np-chart__col');
    if (col) show(Number(col.dataset.i), col); else hide();
  });
  svg.addEventListener('pointerleave', () => { if (pinned == null) hide(); });
  svg.addEventListener('click', (e) => {
    const col = e.target.closest('.np-chart__col');
    if (!col) { hide(); return; }
    const i = Number(col.dataset.i);
    if (pinned === i) { hide(); return; }
    pinned = i;
    show(i, col);
  });
  svg.addEventListener('focusin', (e) => {
    const col = e.target.closest('.np-chart__col');
    if (col) show(Number(col.dataset.i), col);
  });
  svg.addEventListener('focusout', (e) => {
    if (pinned == null && !svg.contains(e.relatedTarget)) hide();
  });
  document.addEventListener('click', (e) => {
    if (pinned != null && !wrap.contains(e.target)) hide();
  });
}

function trendChip(delta, label, isPercent){
  if (!delta) return `<span class="np-trend np-trend--flat">No change ${label}</span>`;
  const up = delta > 0;
  const val = isPercent ? `${Math.abs(delta)}%` : Math.abs(delta);
  return `<span class="np-trend ${up ? 'np-trend--up' : 'np-trend--down'}">${up ? '▲' : '▼'} ${val} ${label}</span>`;
}

async function loadDashboard() {
  try {
    const a = await api('/admin/analytics');
    const daily = Array.isArray(a.daily) ? a.daily : [];

    setHtml('trendToday', trendChip(a.todayDelta, 'vs yesterday'));
    setText('statToday', a.todayAppointments);
    setHtml('statTodayBreakdown',
      `<span class="np-dot np-dot--mint"></span>${a.last7Appointments} in last 7 days` +
      `<span class="np-dot np-dot--blue"></span>${a.last30Appointments} in last 30 days`);
    setText('statTodayFoot',
      `${a.completionRate}% completion · ${a.cancellationRate}% cancellation · ${a.totalDoctors} doctors · ${a.totalPatients} patients`);

    // The API only returns a 14-day daily series (not a pre-computed
    // week-over-week total), so the this-week/last-week split is derived
    // here from the last 14 entries — exactly enough for one real
    // comparison, oldest 7 vs newest 7.
    const thisWeek = daily.slice(7);
    const prevWeek = daily.slice(0, 7);
    const sum = (rows, key) => rows.reduce((t, r) => t + (Number(r[key]) || 0), 0);
    const thisWeekRevenue = sum(thisWeek, 'revenue');
    const prevWeekRevenue = sum(prevWeek, 'revenue');
    const weekDelta = prevWeekRevenue > 0
      ? Math.round(((thisWeekRevenue - prevWeekRevenue) / prevWeekRevenue) * 100)
      : (thisWeekRevenue > 0 ? 100 : 0);
    setHtml('trendWeek', trendChip(weekDelta, 'vs last week', true));
    setText('statWeekRevenue', fmtCurrency(thisWeekRevenue));

    const maxDaily = Math.max(1, ...thisWeek.map(d => Number(d.revenue) || 0));
    setHtml('statSparkline', thisWeek.map(d => {
      const h = Math.max(3, Math.round(((Number(d.revenue) || 0) / maxDaily) * 32));
      const label = new Date(d.date + 'T00:00:00Z').toLocaleDateString(undefined, { weekday: 'short' });
      return `<div class="np-sparkline__bar" style="height:${h}px" title="${label}: ${fmtCurrency(d.revenue)}"></div>`;
    }).join(''));

    // Full 14 days is too dense for a comfortable bar width in the panel's
    // available space, and the analytics cards above already cover the
    // longer 7-vs-7 comparison — the chart itself only needs the latest week.
    try { renderDailyChart(daily.slice(7)); } catch (_) {}

    // Revenue by source — online / in-clinic / pharmacy, each showing money
    // actually collected with pending noted separately so nothing is inflated.
    // These are lifetime totals (the API doesn't split by source per-week).
    const rbs = a.revenueBySource;
    if (rbs) {
      const pend = (p) => Number(p) > 0 ? ` · ${fmtCurrency(p)} pending` : '';
      setHtml('statSplit', `
        <div class="np-analytics-card__split-row"><span class="np-badge np-badge--mint"><span class="np-badge__dot"></span>Online</span> ${fmtCurrency(rbs.online.collected)} collected${pend(rbs.online.pending)}</div>
        <div class="np-analytics-card__split-row"><span class="np-badge np-badge--blue"><span class="np-badge__dot"></span>In-Clinic</span> ${fmtCurrency(rbs.offline.collected)} collected${pend(rbs.offline.pending)}</div>
        <div class="np-analytics-card__split-row"><span class="np-badge np-badge--violet"><span class="np-badge__dot"></span>Pharmacy</span> ${fmtCurrency(rbs.pharmacy.collected)} collected${pend(rbs.pharmacy.pending)}</div>`);
      setText('statFoot',
        `${fmtCurrency(rbs.totalCollected)} collected all-time · ${rbs.outstandingInvoices || 0} unpaid invoice(s)`);
    }

    const fail = a.notificationsFailed || 0;
    const badge = $('#navBadgeFailed');
    if (badge) {
      if (fail > 0) { badge.textContent = fail; badge.classList.remove('hidden'); }
      else { badge.classList.add('hidden'); }
    }

    const appts = await api('/admin/appointments?limit=10&excludeAutoCancelled=1');
    $('#recentAppts').innerHTML = (appts.length === 0)
      ? `<div class="np-empty"><div class="np-empty__title">No appointments yet</div><div class="np-empty__sub">Bookings will show up here.</div></div>`
      : appts.slice(0, 10).map(a => `
        <div class="np-appt-row" style="cursor:pointer" title="View ${escapeHtml(a.patient.name)}'s appointments" onclick="viewAppointmentInList('${escapeHtml((a.patient.name||'').replace(/'/g, "\\'"))}')">
          <div class="np-appt-row__time">
            <div class="np-appt-row__time-h">${escapeHtml(fmtTime(a.startTime))}</div>
            <div class="np-appt-row__time-d">${escapeHtml(fmtDate(a.date))}</div>
          </div>
          <div class="np-appt-row__body">
            <div class="np-appt-row__name">${escapeHtml(a.patient.name)}</div>
            <div class="np-appt-row__assign">${drNameHtml(a.doctor.name)}</div>
            <div class="np-appt-row__meta">${escapeHtml(a.primaryProblem || '—')}</div>
          </div>
          <div class="np-appt-row__right">
            ${statusBadge(a.status)}
          </div>
        </div>`).join('');
  } catch (err) {
    setHtml('dashAnalytics', `<div class="np-error">${escapeHtml(err.message)}</div>`);
  }
}

async function loadDoctors() {
  try {
    const grid = $('#doctorsGrid');
    if (grid && typeof NPSkeleton !== 'undefined') {
      grid.innerHTML = Array.from({length:6}, () => '<div class="np-ui-skel np-ui-skel--card"></div>').join('');
    }
  } catch (_) {}
  try {
    const docs = await api('/admin/doctors');
    const kycs = await Promise.all(
      docs.map(d => api('/admin/doctors/' + encodeURIComponent(d.id) + '/kyc').catch(() => null))
    );
    docs.forEach((d, i) => { d.kycStatus = (kycs[i] && kycs[i].kycStatus) || 'PENDING'; });
    __doctorsCache = docs;
    renderDoctors();
  } catch (err) {
    $('#doctorsGrid').innerHTML = `<div class="np-error">${escapeHtml(err.message)}</div>`;
  }
}

function _docInitials(name){
  const clean = stripDrPrefix(name) || 'D';
  return clean.split(/\s+/).map(s => s[0]).slice(0,2).join('').toUpperCase();
}
function _docAvatar(d){
  if (d.photoUrl) {
    return `<img class="np-doc-card__avatar" src="${escapeHtml(d.photoUrl)}" alt="Dr. ${escapeHtml(d.name)}" style="cursor:zoom-in" onclick="event.stopPropagation(); NPLightbox.open('${escapeHtml(d.photoUrl)}', 'Dr. ${escapeHtml((d.name||'').replace(/'/g, "\\'"))}')"/>`;
  }
  return `<div class="np-doc-card__avatar" aria-hidden="true">${escapeHtml(_docInitials(d.name))}</div>`;
}
function _docQualification(d){
  const q = String(d.qualification || '').trim();
  if (!q) return '';
  const spec = String(d.specialization || '').trim().toLowerCase();
  if (spec && spec.includes(q.toLowerCase())) return '';
  return `<div class="np-doc-card__qual" title="${escapeHtml(q)}">${escapeHtml(q)}</div>`;
}
function _iconMail(){
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16v12H4z"/><path d="m4 7 8 6 8-6"/></svg>`;
}
function _iconPhone(){
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`;
}
function _docContactStrip(d){
  const items = [];
  if (d.email) items.push(`<div class="np-doc-card__contact-item" title="${escapeHtml(d.email)}">${_iconMail()}<span>${escapeHtml(d.email)}</span></div>`);
  if (d.phone) items.push(`<div class="np-doc-card__contact-item" title="${escapeHtml(d.phone)}">${_iconPhone()}<span>${escapeHtml(d.phone)}</span></div>`);
  if (!items.length) return '';
  return `<div class="np-doc-card__contact">${items.join('')}</div>`;
}
function _docCard(d){
  const safeId = escapeHtml(d.id);
  const safeName = (d.name || '').replace(/'/g, "\\'");
  return `
    <article class="np-doc-card" data-id="${safeId}">

      <header class="np-doc-card__head">
        ${_docAvatar(d)}
        <div class="np-doc-card__head-meta">
          <h3 class="np-doc-card__name" title="${drNameHtml(d.name)}">${drNameHtml(d.name)}</h3>
          <p class="np-doc-card__role" title="${escapeHtml(d.specialization || 'Pediatrician')}">${escapeHtml(d.specialization || 'Pediatrician')}</p>
          ${_docQualification(d)}
        </div>
      </header>

      <div class="np-doc-card__badge-row">
        ${d.isAvailable
          ? `<span class="np-badge np-badge--green"><span class="np-badge__dot"></span>Active</span>`
          : `<span class="np-badge np-badge--slate"><span class="np-badge__dot"></span>Inactive</span>`}
        ${d.clinicName
          ? `<span class="np-doc-card__clinic" title="${escapeHtml(d.clinicName)}">🏥 ${escapeHtml(d.clinicName)}</span>`
          : ''}
      </div>

      ${_docContactStrip(d)}

      <div class="np-doc-card__stats" role="group" aria-label="Doctor statistics">
        <div class="np-doc-card__stat">
          <div class="np-doc-card__stat-label">Online</div>
          <div class="np-doc-card__stat-value">${fmtCurrency(d.onlineConsultFee)}</div>
        </div>
        <div class="np-doc-card__stat">
          <div class="np-doc-card__stat-label">In-person</div>
          <div class="np-doc-card__stat-value">${fmtCurrency(d.physicalConsultFee)}</div>
        </div>
        <div class="np-doc-card__stat">
          <div class="np-doc-card__stat-label">Consults</div>
          <div class="np-doc-card__stat-value">${d.consults || 0}</div>
        </div>
        <div class="np-doc-card__stat">
          <div class="np-doc-card__stat-label">Revenue</div>
          <div class="np-doc-card__stat-value">${fmtCurrency(d.revenue)}</div>
        </div>
      </div>

      <div class="np-doc-card__meta">
        ${d.mustChangePassword
          ? `<span class="np-doc-card__pill np-doc-card__pill--warn" title="Doctor still needs to set their password.">⚠ No password</span>`
          : `<span class="np-doc-card__pill np-doc-card__pill--ok"   title="Doctor has set a password.">✓ Password set</span>`}
        <span class="np-doc-card__pill np-doc-card__pill--kyc" title="KYC status">KYC: ${escapeHtml(d.kycStatus || 'PENDING')}</span>
      </div>

      <div class="np-doc-card__actions" role="group" aria-label="Doctor actions">
        <button class="np-btn np-btn--primary np-btn--sm" type="button"
                onclick="openInsights('${safeId}')">Insights</button>
        <button class="np-btn np-btn--sm" type="button"
                onclick="openEditDoctor('${safeId}')">Edit</button>
        <button class="np-btn np-btn--ghost np-btn--sm" type="button"
                onclick="toggleDoctor('${safeId}', ${!d.isAvailable})">${d.isAvailable ? 'Disable' : 'Enable'}</button>
        <button class="np-btn np-btn--ghost np-btn--icon np-btn--danger" type="button"
                title="Permanently delete" aria-label="Delete doctor permanently"
                onclick="hardDeleteDoctor('${safeId}','${escapeHtml(safeName)}')">🗑</button>
      </div>

    </article>`;
}
function renderDoctors(){
  const q = ($('#docSearch').value || '').trim().toLowerCase();
  const av = $('#docFilterAvail').value;
  let docs = __doctorsCache.slice();
  if (av === 'active')   docs = docs.filter(d => d.isAvailable);
  if (av === 'inactive') docs = docs.filter(d => !d.isAvailable);
  if (q){
    docs = docs.filter(d => [d.name, d.email, d.phone, d.clinicName, d.specialization, d.qualification]
      .some(v => v && String(v).toLowerCase().includes(q)));
  }
  // Pinned: Dr. Vishal Parmar's card always leads the grid, regardless of
  // search/filter/sort — the rest keep their normal relative order.
  const pinnedIdx = docs.findIndex(d => stripDrPrefix(d.name || '').trim().toLowerCase() === 'vishal parmar');
  if (pinnedIdx > 0) docs.unshift(docs.splice(pinnedIdx, 1)[0]);
  const grid = $('#doctorsGrid');
  if (!docs.length){
    grid.innerHTML = `<div class="np-empty" style="grid-column:1/-1;">
      <div class="np-empty__title">No doctors match</div>
      <div class="np-empty__sub">Try clearing the search or adding a doctor.</div>
    </div>`;
    return;
  }
  grid.innerHTML = docs.map(_docCard).join('');
}
async function toggleDoctor(id, isAvailable) {
  await api('/admin/doctors/' + id, { method: 'PUT', body: JSON.stringify({ isAvailable }) });
  loadDoctors();
}
async function hardDeleteDoctor(id, name) {
  const ok = await NPModal.confirm({
    title: 'Permanently delete doctor?',
    message: `Permanently delete ${drName(name)}? This is only allowed if the doctor has no appointments. This action cannot be undone.`,
    okText: 'Delete permanently',
    cancelText: 'Cancel',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('/admin/doctors/' + id + '/hard', { method: 'DELETE' });
    NPToast.success('Doctor deleted');
    loadDoctors();
  } catch (err) { NPToast.error(err.message); }
}

// v3.4.14 — Consultation-mode-aware doctor form.
// Only the fee fields relevant to the doctor's consultation mode are shown,
// so onboarding an online-only (or offline-only) doctor stays uncluttered.
function applyAdminModeVisibility(mode){
  const m = String(mode || 'BOTH').toUpperCase();
  const showOnline  = m === 'BOTH' || m === 'ONLINE';
  const showOffline = m === 'BOTH' || m === 'OFFLINE';
  const on  = document.getElementById('adminFeeOnlineField');
  const off = document.getElementById('adminFeeOfflineField');
  if (on)  on.classList.toggle('hidden', !showOnline);
  if (off) off.classList.toggle('hidden', !showOffline);
}

document.addEventListener('change', (e) => {
  if (e.target && e.target.name === 'consultationModes' && e.target.form && e.target.form.id === 'doctorForm') {
    applyAdminModeVisibility(e.target.value);
  }
});

// Shared by app.js (doctors) and staff.js (receptionists/pharmacy) — shows
// the outcome of an admin-triggered "Send Invite" call, with a copy-link
// fallback for when SMTP delivery can't be confirmed.
function showInviteResult(res, roleLabel) {
  const ttl = res.inviteExpiresInMinutes ? ` (expires in ${res.inviteExpiresInMinutes} min)` : '';
  const status = res.inviteSent
    ? `Invite sent to the ${roleLabel}.`
    : `Invite created — email delivery NOT confirmed.`;
  if (!res.invitePreviewUrl) {
    if (typeof NPToast !== 'undefined') NPToast.success(status);
    else alert(status);
    return;
  }
  if (typeof NPToast !== 'undefined') {
    NPToast.success(status + ' Click "Copy link" to share' + ttl + '.', {
      title: 'Invite link ready',
      duration: 15000,
      action: { label: 'Copy link', onClick: () => {
        try {
          navigator.clipboard.writeText(res.invitePreviewUrl);
          NPToast.info('Invite link copied to clipboard');
        } catch (_) {
          NPModal.alert({ title: 'Invite link', message: res.invitePreviewUrl });
        }
      } }
    });
  } else {
    alert(status + '\n\nInvite link' + ttl + ':\n' + res.invitePreviewUrl);
  }
}

async function sendDoctorInvite() {
  const f = $('#doctorForm');
  const id = f.dataset.id;
  if (!id) return;
  const btn = $('#sendDoctorInviteBtn');
  btn.disabled = true;
  try {
    const res = await api('/admin/doctors/' + id + '/invite', { method: 'POST' });
    showInviteResult(res, 'doctor');
  } catch (err) {
    if (typeof NPToast !== 'undefined') NPToast.error(err.message);
    else alert(err.message);
  } finally {
    btn.disabled = false;
  }
}

function setDoctorPhotoPreview(url){
  const img = $('#doctorPhotoPreview');
  const placeholder = $('#doctorPhotoPlaceholder');
  const removeBtn = $('#doctorPhotoRemoveBtn');
  if (url){
    img.src = url; img.classList.remove('hidden');
    img.style.cursor = 'zoom-in';
    img.onclick = () => NPLightbox.open(url, 'Doctor photo');
    placeholder.classList.add('hidden');
    removeBtn.classList.remove('hidden');
  } else {
    img.src = ''; img.classList.add('hidden');
    placeholder.classList.remove('hidden');
    removeBtn.classList.add('hidden');
  }
}

async function uploadDoctorPhoto(file){
  const f = $('#doctorForm');
  const id = f.dataset.id;
  const input = $('#doctorPhotoInput');
  if (!id) { if (typeof NPToast !== 'undefined') NPToast.warn('Save the doctor first, then add a photo.'); return; }
  if (!file) return;
  const fd = new FormData();
  fd.append('photo', file);
  try {
    const r = await fetch(API + '/admin/doctors/' + encodeURIComponent(id) + '/profile-image', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN }, // NO Content-Type — browser sets multipart boundary
      body: fd
    });
    let data = null; try { data = await r.json(); } catch(_) {}
    if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
    setDoctorPhotoPreview(data.photoUrl);
    if (typeof NPToast !== 'undefined') NPToast.success('Photo updated.');
    loadDoctors();
  } catch (err) {
    if (typeof NPToast !== 'undefined') NPToast.error(err.message);
    else alert(err.message);
  } finally {
    input.value = '';
  }
}

async function removeDoctorPhoto(){
  const f = $('#doctorForm');
  const id = f.dataset.id;
  if (!id) return;
  try {
    await api('/admin/doctors/' + id + '/profile-image', { method: 'DELETE' });
    setDoctorPhotoPreview(null);
    if (typeof NPToast !== 'undefined') NPToast.success('Photo removed.');
    loadDoctors();
  } catch (err) {
    if (typeof NPToast !== 'undefined') NPToast.error(err.message);
    else alert(err.message);
  }
}

function openDoctorModal() {
  $('#doctorModalTitle').textContent = 'Add Doctor';
  const f = $('#doctorForm');
  f.dataset.mode = 'create';
  f.dataset.id = '';
  f.email.disabled = false;
  f.email.readOnly = false;
  f.password.placeholder = '(invite link is preferred)';
  $('#sendDoctorInviteBtn').classList.add('hidden');
  $('#doctorPhotoBlock').classList.add('hidden');
  loadKycForDoctor(null);
  applyAdminModeVisibility(f.consultationModes ? f.consultationModes.value : 'BOTH');
  $('#doctorModal').classList.remove('hidden');
  if (typeof NPDropzone !== 'undefined') {
    setTimeout(() => {
      ['aadhaar','pan','cancelledCheque','medicalRegCert'].forEach(name => {
        const input = document.querySelector(`#doctorForm input[name="${name}"]`);
        if (input) NPDropzone.bind(input, { label: 'Drop ' + name + ' here', hint: 'or click to browse (PDF or image)' });
      });
    }, 0);
  }
}
function closeDoctorModal() {
  $('#doctorModal').classList.add('hidden');
  const f = $('#doctorForm'); f.reset();
  f.email.disabled = false; f.email.readOnly = false;
  $('#doctorFormError').textContent = ''; $('#doctorFormError').classList.add('hidden');
}
function openEditDoctor(id) {
  const d = __doctorsCache.find(x => x.id === id);
  if (!d) return alert('Doctor not found in cache; refresh and try again.');
  $('#doctorModalTitle').textContent = 'Edit Doctor';
  const f = $('#doctorForm');
  f.dataset.mode = 'edit'; f.dataset.id = id;
  $('#sendDoctorInviteBtn').classList.remove('hidden');
  $('#doctorPhotoBlock').classList.remove('hidden');
  setDoctorPhotoPreview(d.photoUrl || null);
  f.name.value  = d.name || '';
  f.email.value = d.email || '';
  f.email.disabled = false; f.email.readOnly = true;
  f.password.value = ''; f.password.placeholder = 'New password (leave blank to keep)';
  f.phone.value = d.phone || '';
  f.specialization.value = d.specialization || '';
  f.qualification.value  = d.qualification  || '';
  f.experience.value     = d.experience ?? '';
  f.bio.value            = d.bio || '';
  f.consultationModes.value = d.consultationModes || 'BOTH';
  f.onlineConsultFee.value   = d.onlineConsultFee   ?? '';
  f.physicalConsultFee.value = d.physicalConsultFee ?? '';
  if (f.clinicSharePercent) f.clinicSharePercent.value = d.clinicSharePercent ?? 25;
  if (f.doctorSharePercent) f.doctorSharePercent.value = d.doctorSharePercent ?? 75;
  if (f.tdsPercent)         f.tdsPercent.value         = d.tdsPercent ?? 10;
  if (f.canAddPreviousRecords) f.canAddPreviousRecords.checked = !!d.canAddPreviousRecords;
  loadKycForDoctor(id);
  applyAdminModeVisibility(d.consultationModes || 'BOTH');
  $('#doctorModal').classList.remove('hidden');
}

document.addEventListener('input', (e) => {
  if (e.target && (e.target.id === 'docClinicPct' || e.target.id === 'docDoctorPct')) {
    const clinic = $('#docClinicPct'); const doc = $('#docDoctorPct');
    if (!clinic || !doc) return;
    const v = Number(e.target.value);
    if (Number.isFinite(v) && v >= 0 && v <= 100) {
      const other = Math.round((100 - v) * 100) / 100;
      (e.target === clinic ? doc : clinic).value = other;
    }
  }
});

$('#doctorForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#doctorFormError'); errEl.textContent = ''; errEl.classList.add('hidden');
  const f = e.target;
  const fd = new FormData(f);
  const raw = Object.fromEntries(fd.entries());
  const isEdit = f.dataset.mode === 'edit';
  const payload = {
    name: (raw.name || '').trim(),
    // Only strip a genuine country-code prefix (12 digits total, e.g. a
    // pasted "+91 9876543210"). A bare replace(/^91/,'') would also mangle
    // any valid 10-digit number that simply starts with 91, e.g.
    // "9177211867" → "77211867" (8 digits, then fails phone validation).
    phone: (() => { const d = (raw.phone || '').replace(/\D/g, ''); return d.length === 12 && d.startsWith('91') ? d.slice(2) : d; })(),
    specialization: (raw.specialization || '').trim() || undefined,
    qualification: (raw.qualification || '').trim() || undefined,
    experience: raw.experience === '' ? 0 : Number(raw.experience),
    bio: (raw.bio || '').trim() || undefined,
    consultationModes: raw.consultationModes || 'BOTH',
    onlineConsultFee: raw.onlineConsultFee === '' ? 0 : Number(raw.onlineConsultFee),
    physicalConsultFee: raw.physicalConsultFee === '' ? 0 : Number(raw.physicalConsultFee),
    canAddPreviousRecords: !!f.canAddPreviousRecords?.checked
  };
  if (raw.clinicSharePercent !== undefined && raw.clinicSharePercent !== '') {
    payload.clinicSharePercent = Number(raw.clinicSharePercent);
  }
  if (raw.doctorSharePercent !== undefined && raw.doctorSharePercent !== '') {
    payload.doctorSharePercent = Number(raw.doctorSharePercent);
  }
  if (raw.tdsPercent !== undefined && raw.tdsPercent !== '') {
    payload.tdsPercent = Number(raw.tdsPercent);
  }
  if (!isEdit) payload.email = (raw.email || '').trim().toLowerCase();
  if (raw.password && raw.password.trim()) payload.password = raw.password;
  try {
    if (isEdit) {
      await api('/admin/doctors/' + f.dataset.id, { method: 'PUT', body: JSON.stringify(payload) });
      alert('Doctor updated.');
    } else {
      const res = await api('/admin/doctors', { method: 'POST', body: JSON.stringify(payload) });
      if (typeof NPToast !== 'undefined') NPToast.success('Doctor created. Send the invite whenever you\'re ready.');
      else alert('Doctor created. Send the invite whenever you\'re ready.');
      f.dataset.mode = 'edit';
      f.dataset.id   = res.id;
      f.email.readOnly = true;
      $('#doctorModalTitle').textContent = 'Edit Doctor';
      $('#sendDoctorInviteBtn').classList.remove('hidden');
      await loadKycForDoctor(res.id);
      loadDoctors();
      return;
    }
    closeDoctorModal(); loadDoctors();
  } catch (err) { errEl.textContent = err.message; errEl.classList.remove('hidden'); }
});

async function openInsights(id){
  const drawer = $('#doctorDrawer');
  const body = $('#drawerBody');
  $('#drawerTitle').textContent = 'Doctor insights';
  body.innerHTML = `<div class="np-empty"><div class="np-empty__title">Loading insights…</div></div>`;
  drawer.classList.remove('hidden');
  try {
    const insights = await api('/admin/doctors/' + id + '/insights');
    const d = insights.doctor, s = insights.summary;
    $('#drawerTitle').textContent = drName(d.name);
    const max = Math.max(1, ...insights.daily.map(x => x.total));
    const bars = insights.daily.map(x => {
      const h = Math.max(2, Math.round((x.total / max) * 60));
      const cls = x.total === 0 ? 'np-bars__bar np-bars__bar--muted' : 'np-bars__bar';
      return `<div class="${cls}" style="height:${h}px" title="${x.date}: ${x.total} appts"></div>`;
    }).join('');
    const upcoming = (insights.upcoming || []).map(u => `
      <div class="np-appt-row" style="padding:.5rem .25rem;">
        <div class="np-appt-row__time">
          <div class="np-appt-row__time-h">${escapeHtml(fmtTime(u.startTime))}</div>
          <div class="np-appt-row__time-d">${escapeHtml(fmtDate(u.date))}</div>
        </div>
        <div class="np-appt-row__body">
          <div class="np-appt-row__name">${escapeHtml((u.patient && u.patient.name) || '—')}</div>
          <div class="np-appt-row__meta">${escapeHtml((u.patient && u.patient.phone) || '')}</div>
        </div>
        <div class="np-appt-row__right">${statusBadge(u.status)} ${typeBadge(u.consultationType)}</div>
      </div>`).join('') || `<div class="np-empty" style="padding:1rem;"><div class="np-empty__sub">No upcoming appointments.</div></div>`;

    body.innerHTML = `
      <div class="np-row" style="gap:.85rem; margin-bottom:1rem;">
        ${d.photoUrl ? `<img class="np-profile__avatar" style="width:60px;height:60px;border-radius:14px;cursor:zoom-in" src="${escapeHtml(d.photoUrl)}" alt="Dr. ${escapeHtml(d.name)}" onclick="NPLightbox.open('${escapeHtml(d.photoUrl)}', 'Dr. ${escapeHtml((d.name||'').replace(/'/g, "\\'"))}')"/>`
                    : `<div class="np-profile__avatar" style="width:60px;height:60px;border-radius:14px;">${escapeHtml((d.name||'D').split(/\s+/).map(s=>s[0]).slice(0,2).join('').toUpperCase())}</div>`}
        <div style="flex:1;">
          <div style="font-weight:700; color:var(--np-ink);">${drNameHtml(d.name)}</div>
          <div class="np-mut" style="font-size:.82rem;">${escapeHtml(d.specialization||'Pediatrician')} · ${escapeHtml(d.qualification||'')}</div>
          <div class="np-mut" style="font-size:.78rem;">${escapeHtml(d.email)} · +91 ${escapeHtml(d.phone)}</div>
          ${d.clinicName ? `<div class="np-mut" style="font-size:.78rem;">🏥 ${escapeHtml(d.clinicName)}</div>` : ''}
          <div style="margin-top:.35rem;">${d.isAvailable ? '<span class="np-badge np-badge--green"><span class="np-badge__dot"></span>Active</span>' : '<span class="np-badge np-badge--slate"><span class="np-badge__dot"></span>Inactive</span>'}</div>
        </div>
      </div>

      <div class="np-uuid-card" role="group" aria-label="Doctor EMR UUID">
        <div class="np-uuid-card__label">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9h10M7 13h10M7 17h6"/></svg>
          <span>Doctor EMR UUID</span>
        </div>
        <div class="np-uuid-card__row">
          <input class="np-uuid-card__value" type="text" readonly value="${escapeHtml(d.id || '')}" aria-label="Doctor EMR UUID (read-only)" onclick="this.select()"/>
          <button type="button" class="np-uuid-card__copy" data-copy="${escapeHtml(d.id || '')}" aria-label="Copy Doctor UUID">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
            <span>Copy</span>
          </button>
        </div>
      </div>

      <div class="np-kpi-grid" style="grid-template-columns: repeat(2, 1fr);">
        <div class="np-kpi np-kpi--blue">
          <div class="np-kpi__label">Total appointments</div>
          <div class="np-kpi__value">${s.total}</div>
          <div class="np-kpi__sub">${s.apptsLast30} in last 30 days</div>
        </div>
        <div class="np-kpi np-kpi--mint">
          <div class="np-kpi__label">Completion rate</div>
          <div class="np-kpi__value">${s.completionRate}%</div>
          <div class="np-kpi__sub">${s.completed} of ${s.total}</div>
        </div>
        <div class="np-kpi np-kpi--cream">
          <div class="np-kpi__label">Revenue (lifetime)</div>
          <div class="np-kpi__value">${fmtCurrency(s.revenueLifetime)}</div>
          <div class="np-kpi__sub">${fmtCurrency(s.revenueLast30)} in last 30d</div>
        </div>
        <div class="np-kpi np-kpi--rose">
          <div class="np-kpi__label">Cancellations</div>
          <div class="np-kpi__value">${s.cancellationRate}%</div>
          <div class="np-kpi__sub">${s.cancelled} cancelled</div>
        </div>
      </div>

      <div class="np-row" style="gap:.5rem; flex-wrap:wrap; margin: 1rem 0 .5rem;">
        <span class="np-badge np-badge--green">${s.completed} Completed</span>
        <span class="np-badge np-badge--blue">${s.confirmed} Confirmed</span>
        <span class="np-badge np-badge--amber">${s.pending} Pending</span>
        <span class="np-badge np-badge--red">${s.cancelled} Cancelled</span>
        <span class="np-badge np-badge--mint">${s.online} Online</span>
        <span class="np-badge np-badge--violet">${s.offline} In-person</span>
      </div>

      <div class="np-panel" style="box-shadow:none; border-radius:14px; margin-top:.5rem;">
        <div class="np-panel__head">
          <div>
            <div class="np-panel__title">Last 14 days</div>
            <div class="np-panel__subtitle">Appointment volume per day</div>
          </div>
        </div>
        <div class="np-panel__body">
          <div class="np-bars" style="height:60px;">${bars}</div>
        </div>
      </div>

      <div class="np-panel" style="box-shadow:none; border-radius:14px; margin-top:.85rem;">
        <div class="np-panel__head">
          <div>
            <div class="np-panel__title">Upcoming appointments</div>
            <div class="np-panel__subtitle">Next 10 confirmed/pending visits</div>
          </div>
        </div>
        <div class="np-panel__body" style="padding:0;">${upcoming}</div>
      </div>
    `;
    const copyBtn = body.querySelector('.np-uuid-card__copy');
    if (copyBtn) copyBtn.addEventListener('click', () => __npCopyToClipboard(copyBtn.getAttribute('data-copy') || '', copyBtn));
  } catch (err) {
    body.innerHTML = `<div class="np-error">${escapeHtml(err.message)}</div>`;
  }
}
function closeDoctorDrawer(){ $('#doctorDrawer').classList.add('hidden'); }

function __npCopyToClipboard(text, btn){
  if (!text) return;
  const done = () => {
    if (!btn) return;
    const span = btn.querySelector('span');
    const original = span ? span.textContent : '';
    btn.classList.add('is-copied');
    if (span) span.textContent = 'Copied';
    setTimeout(() => {
      btn.classList.remove('is-copied');
      if (span) span.textContent = original || 'Copy';
    }, 1400);
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => __npCopyFallback(text, done));
    } else {
      __npCopyFallback(text, done);
    }
  } catch(_) {
    __npCopyFallback(text, done);
  }
}
function __npCopyFallback(text, done){
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    done && done();
  } catch(_){}
}

$('#docSearch').addEventListener('input', renderDoctors);
$('#docFilterAvail').addEventListener('change', renderDoctors);

async function loadDoctorsForFilter(){
  try {
    if (!__doctorsCache.length) __doctorsCache = await api('/admin/doctors');
    const sel = $('#filterDoctor');
    sel.innerHTML = '<option value="">All doctors</option>' +
      __doctorsCache.map(d => `<option value="${escapeHtml(d.id)}">${drNameHtml(d.name)}</option>`).join('');
  } catch(_) {}
}
function __ensureAutoCancelledFilter(){
  var form = document.getElementById('apptFilters');
  if (!form || document.getElementById('filterHideAutoCancelled')) return;
  var label = document.createElement('label');
  label.className = 'np-filter-check';
  label.style.cssText = 'display:inline-flex;align-items:center;gap:.4rem;font-size:.82rem;font-weight:600;color:var(--np-ink,#0F2A47);cursor:pointer;white-space:nowrap;';
  label.innerHTML = '<input type="checkbox" id="filterHideAutoCancelled" checked style="width:16px;height:16px;accent-color:#89BCBD;"> Hide auto-cancelled';
  form.appendChild(label);
  label.querySelector('input').addEventListener('change', function(){ loadAppointments(); });
}
async function loadAppointments() {
  const tbody = $('#apptsTbody');
  tbody.innerHTML = `<tr><td colspan="7" class="np-mut" style="padding:1.5rem; text-align:center;">Loading…</td></tr>`;
  const qs = new URLSearchParams();
  const status   = $('#filterStatus').value;
  const type     = $('#filterType').value;
  const payment  = $('#filterPayment').value;
  const doctorId = $('#filterDoctor').value;
  const from     = $('#filterFrom').value;
  const to       = $('#filterTo').value;
  const q        = $('#apptSearch').value.trim();
  __ensureAutoCancelledFilter();
  const __hideAutoEl = document.getElementById('filterHideAutoCancelled');
  const __hideAutoCancelled = !__hideAutoEl || __hideAutoEl.checked;
  if (status)   qs.set('status',   status);
  if (type)     qs.set('type',     type);
  if (payment)  qs.set('payment',  payment);
  if (doctorId) qs.set('doctorId', doctorId);
  if (from)     qs.set('from',     from);
  if (to)       qs.set('to',       to);
  if (q.length >= 2) qs.set('q', q);
  if (__hideAutoCancelled) qs.set('excludeAutoCancelled', '1');
  try {
    const appts = await api('/admin/appointments' + (qs.toString() ? '?' + qs.toString() : ''));
    __apptsCache = appts;
    if (!appts.length){
      tbody.innerHTML = `<tr><td colspan="7"><div class="np-empty"><div class="np-empty__title">No appointments match</div><div class="np-empty__sub">Try clearing some filters.</div></div></td></tr>`;
      return;
    }
    appts.sort((a,b) => {
      const ka = String(a.date).slice(0,10) + ' ' + String(a.startTime||'');
      const kb = String(b.date).slice(0,10) + ' ' + String(b.startTime||'');
      return ka > kb ? -1 : ka < kb ? 1 : 0;
    });
    tbody.innerHTML = appts.map(a => {
      const rowAccent = a.consultationType === 'ONLINE'
        ? 'border-left:3px solid #10b981;'
        : (a.consultationType === 'OFFLINE' ? 'border-left:3px solid #3b82f6;' : '');
      return `
      <tr class="np-appt-tr" style="${rowAccent}">
        <td data-label="When" class="np-cell-when">
          <div class="np-cell-when__line"><b>${escapeHtml(fmtDate(a.date))}</b>
            <span class="np-mut np-cell-when__time">${escapeHtml(fmtTime(a.startTime))}${a.endTime ? ' – ' + escapeHtml(fmtTime(a.endTime)) : ''}</span>
          </div>
        </td>
        <td data-label="Patient">
          <div><b>${escapeHtml(a.patient.name)}</b></div>
          <div class="np-mut" style="font-size:.78rem;">+91 ${escapeHtml(a.patient.phone||'')}</div>
          ${a.primaryProblem ? `<div class="np-mut" style="font-size:.75rem; margin-top:.15rem;">${escapeHtml(a.primaryProblem)}</div>` : ''}
        </td>
        <td data-label="Doctor">${drNameHtml(a.doctor.name)}<br/><span class="np-mut" style="font-size:.75rem;">${escapeHtml(a.doctor.specialization||'')}</span></td>
        <td data-label="Type">${typeBadge(a.consultationType)}</td>
        <td data-label="Status">${statusBadge(a.status)}${a.status === 'CANCELLED' && a.notes ? `<div style="font-size:.72rem; color:#B91C1C; margin-top:.2rem;">${escapeHtml(a.notes)}</div>` : ''}</td>
        <td data-label="Payment">${paymentBadge(a.paymentStatus)}</td>
        <td data-label="Fee" style="text-align:right;"><b>${fmtCurrencyFull(a.feeAtBooking)}</b></td>
      </tr>`;
    }).join('');
    _renderApptFilterChips({ status, type, payment, doctorId, from, to, q });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="np-error">${escapeHtml(err.message)}</div></td></tr>`;
  }
}
$('#apptFilters').addEventListener('submit', (event) => { event.preventDefault(); loadAppointments(); });
$('#clearFilters').addEventListener('click', () => {
  ['filterStatus','filterType','filterPayment','filterDoctor','filterFrom','filterTo','apptSearch'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  loadAppointments();
});
function _renderApptFilterChips(state){
  const host = document.getElementById('apptFilterChips');
  if (!host || typeof NPChips === 'undefined') return;
  const labels = {
    status:'Status', type:'Type', payment:'Payment',
    doctorId:'Doctor', from:'From', to:'To', q:'Search'
  };
  const docName = (id) => {
    const d = (__doctorsCache || []).find(x => x.id === id);
    return d ? drName(d.name) : id;
  };
  const chips = [];
  Object.keys(labels).forEach(k => {
    const v = state[k];
    if (!v || (k === 'q' && v.length < 2)) return;
    const display = k === 'doctorId' ? docName(v) : v;
    chips.push({
      label: labels[k] + ': ' + display,
      onClear: () => {
        const map = {
          status:'filterStatus', type:'filterType', payment:'filterPayment',
          doctorId:'filterDoctor', from:'filterFrom', to:'filterTo', q:'apptSearch'
        };
        const el = document.getElementById(map[k]); if (el) el.value = '';
        loadAppointments();
      },
    });
  });
  NPChips.render(host, chips, () => {
    document.getElementById('clearFilters').click();
  });
}
function _setupApptDateRange(){
  const host = document.getElementById('apptDateRange');
  if (!host || host.dataset.wired === '1' || typeof NPDateRange === 'undefined') return;
  host.dataset.wired = '1';
  NPDateRange.render(host, (range) => {
    const f = document.getElementById('filterFrom');
    const t = document.getElementById('filterTo');
    if (f) f.value = range.fromIso;
    if (t) t.value = range.toIso;
    loadAppointments();
  });
}
$('#apptSearch').addEventListener('input', () => { 
  clearTimeout(window.__apptSearchTimer);
  window.__apptSearchTimer = setTimeout(loadAppointments, 280);
});

let __notifTemplatesCache = null;

const __NOTIF_TEMPLATE_LABELS = {
  neokids_booking_confirms_offline_v2: 'Appointment Confirmation (Clinic)',
  neokids_online_appt_confirm_v2:      'Appointment Confirmation (Online)',
  neokids_reminder_offline:            'Appointment Reminder (Clinic)',
  neokids_reminder_offline_v2:         'Appointment Reminder (Clinic)',
  neokids_reminder_online:             'Appointment Reminder (Online)',
  neokids_reminder_online_v2:          'Appointment Reminder (Online)',
  neokids_prescription_pdf:            'Prescription Sent',
  neokids_prescription_pdf__resend:    'Prescription Resent',
  neokids_invoice_pdf:                 'Invoice Sent',
  neokids_vaccination_reminder:        'Vaccination Reminder',
  reschedule_online_v2:                'Appointment Rescheduled',
  cancellation_notice:                 'Appointment Cancelled',
  PHYSICAL_CONFIRMED:                  'Appointment Confirmation (Clinic)',
  ONLINE_CONFIRMED:                    'Appointment Confirmation (Online)',
  RESCHEDULED:                         'Appointment Rescheduled',
  CANCELLED:                           'Appointment Cancelled',
  PRESCRIPTION:                        'Prescription Sent',
  PRESCRIPTION_RESEND:                 'Prescription Resent',
  PAYMENT_RECEIVED:                    'Payment Confirmation',

  doctor_new_booking_offline:          'New Clinic Booking',
  doctor_new_booking_online_v2:        'New Online Booking',
  doctor_reminder_offline:             'Consultation Reminder (Clinic)',
  doctor_reminder_online:              'Consultation Reminder (Online)',
  PHYSICAL_CONFIRMED_DOCTOR:           'New Clinic Booking',
  ONLINE_CONFIRMED_DOCTOR:             'New Online Booking',
  RESCHEDULED_DOCTOR:                  'Appointment Rescheduled (Doctor)',
  CANCELLED_DOCTOR:                    'Appointment Cancelled (Doctor)',
  doctor_welcome_email:                'Doctor Welcome',

  DOCTOR_INVITE:                       'Doctor Invitation',
  DOCTOR_INVITATION:                   'Doctor Invitation',
  PASSWORD_RESET:                      'Password Reset',
  ADMIN_PASSWORD_RESET:                'Password Reset (Admin)',
  DOCTOR_PASSWORD_RESET:               'Password Reset (Doctor)',
  ADMIN_LOGIN_ALERT:                   'Admin Login Alert',
  ADMIN_ACCOUNT_NOTICE:                'Admin Account Notification',
  SYSTEM_ERROR_ALERT:                  'System Error Alert',
  SYSTEM_MAINTENANCE:                  'System Maintenance Notice'
};

const __NOTIF_AUDIENCE_LABELS = {
  '':      'All notifications',
  PATIENT: 'Patient Notifications',
  DOCTOR:  'Doctor Notifications',
  SYSTEM:  'System Notifications'
};

function __notifClassifyAudience(rawTemplate){
  const n = String(rawTemplate || '').toLowerCase();
  if (!n) return 'SYSTEM';
  if (/^doctor_/.test(n)) return 'DOCTOR';
  if (/_doctor(_|$)/.test(n)) return 'DOCTOR';
  if (/(settlement|payout|kyc|earning|onboard)/.test(n)) return 'DOCTOR';
  if (/^(neokids_|patient_|booking_|appointment_|prescription_|payment_|invoice_|recall|followup|follow_up|consult_|reschedule_|cancellation_)/.test(n)) return 'PATIENT';
  if (/^(physical_confirmed|online_confirmed|rescheduled|cancelled|prescription|prescription_resend)$/.test(n)) return 'PATIENT';
  if (/(booking|appointment|prescription|invoice|reminder|recall|follow|consult|payment|vaccination)/.test(n)) return 'PATIENT';
  return 'SYSTEM';
}

function __notifPrettyName(rawTemplate){
  if (!rawTemplate) return '';
  if (__NOTIF_TEMPLATE_LABELS[rawTemplate]) return __NOTIF_TEMPLATE_LABELS[rawTemplate];
  return String(rawTemplate)
    .replace(/[_\-.]+/g, ' ')
    .toLowerCase()
    .replace(/\b([a-z])/g, (_, c) => c.toUpperCase())
    .trim();
}

function __notifChannelLabel(ch){
  if (!ch) return '';
  const map = { WHATSAPP: 'WhatsApp', EMAIL: 'Email', SMS: 'SMS', PUSH: 'Push' };
  return map[String(ch).toUpperCase()] || String(ch);
}

async function loadNotifTemplates(){
  try {
    const data = await api('/admin/notifications/templates');
    let payload;
    if (Array.isArray(data)) {
      payload = { flat: data, groups: null };
    } else {
      payload = data || { flat: [], groups: null };
    }

    const normalizedGroups = {
      PATIENT: { label: 'Patient Notifications', items: [] },
      DOCTOR:  { label: 'Doctor Notifications',  items: [] },
      SYSTEM:  { label: 'System Notifications',  items: [] }
    };
    const push = (bucket, item) => {
      const key = (bucket === 'PATIENT' || bucket === 'DOCTOR') ? bucket : 'SYSTEM';
      normalizedGroups[key].items.push(item);
    };
    if (payload.groups) {
      for (const [k, g] of Object.entries(payload.groups)) {
        if (!g || !Array.isArray(g.items)) continue;
        for (const it of g.items) push(k, it);
      }
    } else if (Array.isArray(payload.flat)) {
      for (const it of payload.flat) {
        push(__notifClassifyAudience(it.template), it);
      }
    }
    for (const g of Object.values(normalizedGroups)) {
      const seen = new Set();
      g.items = g.items.filter(it => {
        const k = (it.template || '') + '|' + (it.channel || '');
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    __notifTemplatesCache = { flat: payload.flat || [], groups: normalizedGroups };
    renderNotifTemplateOptions();
  } catch(_) {}
}

function renderNotifTemplateOptions(){
  const sel = $('#notifTemplate');
  if (!sel || !__notifTemplatesCache) return;
  const current  = sel.value;
  const audience = ($('#notifAudience') && $('#notifAudience').value) || '';

  sel.classList.add('np-notif-template-select');

  let html = '<option value="">All templates</option>';
  const { groups, flat } = __notifTemplatesCache;

  const audSel = $('#notifAudience');
  if (audSel && groups) {
    const totalFlat = (flat || []).length;
    [...audSel.options].forEach(opt => {
      const k = opt.value;
      const count = k ? ((groups[k] && groups[k].items.length) || 0) : totalFlat;
      const base  = __NOTIF_AUDIENCE_LABELS[k] || opt.textContent;
      opt.textContent = base + '  (' + count + ')';
    });
  }

  const buildOption = (it) => {
    const pretty  = __notifPrettyName(it.template);
    const channel = __notifChannelLabel(it.channel);
    const label   = channel ? (pretty + '  •  ' + channel) : pretty;
    return `<option value="${escapeHtml(it.template)}" title="${escapeHtml(it.template)}">${escapeHtml(label)}</option>`;
  };

  if (groups) {
    const order = ['PATIENT','DOCTOR','SYSTEM'];
    let rendered = 0;
    for (const key of order) {
      const g = groups[key];
      if (!g) continue;
      if (audience && key !== audience) continue;
      if (!g.items.length) continue;
      const groupLabel = __NOTIF_AUDIENCE_LABELS[key] || g.label;
      const items = g.items.slice().sort((a, b) =>
        __notifPrettyName(a.template).localeCompare(__notifPrettyName(b.template))
      );
      html += `<optgroup label="— ${escapeHtml(groupLabel)}  (${items.length}) —">`;
      for (const it of items) html += buildOption(it);
      html += '</optgroup>';
      rendered++;
    }
    if (!rendered) {
      html += '<option value="" disabled>— No templates in this category yet —</option>';
    }
  } else if (flat) {
    const items = flat.slice().sort((a, b) =>
      __notifPrettyName(a.template).localeCompare(__notifPrettyName(b.template))
    );
    html += items.map(buildOption).join('');
  }
  sel.innerHTML = html;

  const stillVisible = [...sel.options].some(o => o.value === current && !o.disabled);
  sel.value = stillVisible ? current : '';
}
let __notifPage = 1;
async function loadNotifications(){
  const tbody = $('#notifTbody');
  tbody.innerHTML = `<tr><td colspan="6" class="np-mut" style="padding:1.5rem; text-align:center;">Loading…</td></tr>`;
  const qs = new URLSearchParams();
  const status = $('#notifStatus').value;
  const channel = $('#notifChannel').value;
  const template = $('#notifTemplate').value;
  const from = $('#notifFrom').value;
  const to   = $('#notifTo').value;
  const q    = $('#notifSearch').value.trim();
  if (status)   qs.set('status', status);
  if (channel)  qs.set('channel', channel);
  if (template) qs.set('template', template);
  if (from)     qs.set('from', from);
  if (to)       qs.set('to', to);
  if (q.length >= 2) qs.set('q', q);
  qs.set('page', String(__notifPage));
  qs.set('limit', '50');
  try {
    const data = await api('/admin/notifications' + (qs.toString() ? '?' + qs.toString() : ''));
    const rows = data.rows || [];
    const counts = data.counts || {};
    $('#notifCounts').innerHTML = [
      `<span class="np-badge np-badge--green">${counts.SENT || 0} Sent</span>`,
      `<span class="np-badge np-badge--red">${counts.FAILED || 0} Failed</span>`,
      counts.QUEUED ? `<span class="np-badge np-badge--amber">${counts.QUEUED} Queued</span>` : ''
    ].join('');
    renderNotifPagination(data);
    if (!rows.length){
      tbody.innerHTML = `<tr><td colspan="6"><div class="np-empty"><div class="np-empty__icon" aria-hidden="true">🔔</div><div class="np-empty__title">No notifications match</div><div class="np-empty__sub">Adjust filters or wait for the next event.</div></div></td></tr>`;
      return;
    }
  tbody.innerHTML = rows.map(n => `
  <tr class="np-notif-row" style="cursor:pointer;" data-id="${escapeHtml(n.id)}">
    <td data-label="Date &amp; Time" class="np-col-datetime">${escapeHtml(fmtDateTime(n.createdAt))}</td>
    <td data-label="Channel">${channelBadge(n.channel)}</td>
    <td data-label="Template" title="${escapeHtml(n.template || '')}">${escapeHtml(__notifPrettyName(n.template) || '')}</td>
    <td data-label="Recipient" style="overflow-wrap:anywhere;">${escapeHtml(n.recipient || '')}</td>
    <td data-label="Status"><span class="np-badge-group">${notifStatusBadge(n.status)}${n.direction ? `<span class="np-badge np-badge--slate">${escapeHtml(n.direction)}</span>` : ''}</span></td>
    ${n.status === 'FAILED' && n.errorMessage
      ? `<td class="np-notif-error" data-label="Error" style="max-width:280px; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(n.errorMessage)}</td>`
      : `<td data-label="Error" class="np-mut">—</td>`}
  </tr>`).join('');
    $$('#notifTbody tr').forEach(tr => tr.addEventListener('click', () => {
      const id = tr.getAttribute('data-id');
      const n = rows.find(r => r.id === id);
      if (n) openNotifModal(n);
    }));
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="np-error">${escapeHtml(err.message)}</div></td></tr>`;
  }
}
function renderNotifPagination(data){
  const info = $('#notifPaginationInfo');
  const prevBtn = $('#notifPrevPage');
  const nextBtn = $('#notifNextPage');
  if (!info || !prevBtn || !nextBtn) return;
  const total = data.total || 0;
  const limit = data.limit || 50;
  const page  = data.page || 1;
  const totalPages = data.totalPages || 1;
  if (!total){
    info.textContent = '';
  } else {
    const start = (page - 1) * limit + 1;
    const end   = Math.min(page * limit, total);
    info.textContent = `Showing ${start}–${end} of ${total}`;
  }
  prevBtn.disabled = page <= 1;
  nextBtn.disabled = !data.hasMore;
}
function openNotifModal(n){
  $('#notifModalBody').innerHTML = `
    <div class="np-grid-2">
      <div class="np-field"><div class="np-field__label">Date &amp; Time</div><div>${escapeHtml(fmtDateTime(n.createdAt))}</div></div>
      <div class="np-field"><div class="np-field__label">Status</div><div>${notifStatusBadge(n.status)}</div></div>
      <div class="np-field"><div class="np-field__label">Channel</div><div>${channelBadge(n.channel)}</div></div>
      <div class="np-field"><div class="np-field__label">Direction</div><div>${escapeHtml(n.direction || '—')}</div></div>
      <div class="np-field"><div class="np-field__label">Template</div><div title="${escapeHtml(n.template || '')}">${escapeHtml(__notifPrettyName(n.template) || '—')}${n.template ? `<div class="np-mut" style="font-size:.7rem; margin-top:.15rem; font-family: ui-monospace, monospace;">${escapeHtml(n.template)}</div>` : ''}</div></div>
      <div class="np-field"><div class="np-field__label">Recipient</div><div>${escapeHtml(n.recipient || '—')}</div></div>
      <div class="np-field" style="grid-column: span 2;"><div class="np-field__label">Appointment</div><div>${escapeHtml(n.appointmentId || '—')}</div></div>
    </div>
    ${n.status === 'FAILED' && n.errorMessage ? `
      <div class="np-field">
        <div class="np-field__label">Error</div>
        <div class="np-error" style="font-family: ui-monospace, monospace; font-size:.78rem; white-space:pre-wrap; padding:.6rem .75rem;">${escapeHtml(n.errorMessage)}</div>
      </div>` : ''}
    ${n.payload ? `
      <div class="np-field">
        <div class="np-field__label">Payload</div>
        <pre class="np-code-block">${escapeHtml(JSON.stringify(n.payload, null, 2))}</pre>
      </div>` : ''}
  `;
  const __nm = $('#notifModal');
  __nm.classList.remove('hidden');
  requestAnimationFrame(() => {
    const scrollers = __nm.querySelectorAll('.np-modal__panel, .np-modal__body');
    scrollers.forEach(el => { el.scrollTop = 0; });
    __nm.scrollTop = 0;
  });
}
function closeNotifModal(){ $('#notifModal').classList.add('hidden'); }

$('#refreshNotifs').addEventListener('click', () => { __notifPage = 1; loadNotifications(); });
$('#notifFilters').addEventListener('submit', (event) => { event.preventDefault(); __notifPage = 1; loadNotifications(); });
$('#clearNotifFilters').addEventListener('click', () => {
  ['notifStatus','notifChannel','notifAudience','notifTemplate','notifFrom','notifTo','notifSearch'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  renderNotifTemplateOptions();
  __notifPage = 1;
  loadNotifications();
});
$('#notifPrevPage').addEventListener('click', () => {
  if (__notifPage <= 1) return;
  __notifPage -= 1;
  loadNotifications();
});
$('#notifNextPage').addEventListener('click', () => {
  __notifPage += 1;
  loadNotifications();
});
const __audSel = document.getElementById('notifAudience');
if (__audSel) __audSel.addEventListener('change', () => { renderNotifTemplateOptions(); __notifPage = 1; loadNotifications(); });
$('#notifSearch').addEventListener('input', () => {
  clearTimeout(window.__notifSearchTimer);
  window.__notifSearchTimer = setTimeout(() => { __notifPage = 1; loadNotifications(); }, 280);
});

$('#passwordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const data = Object.fromEntries(fd.entries());
  if (data.newPassword !== data.confirmPassword){ alert('New passwords do not match.'); return; }
  if (!/^(?=.*[A-Za-z])(?=.*\d).{8,}$/.test(data.newPassword)){
    alert('New password must be at least 8 characters and contain letters and numbers.'); return;
  }
  try {
    await api('/auth/change-password', { method: 'POST', body: JSON.stringify(data) });
    alert('Password changed successfully.');
    e.target.reset();
  } catch (err) { alert(err.message); }
});

async function showDashboard() {
  $('#loginScreen').classList.add('hidden');
  $('#dashboard').classList.remove('hidden');
  try {
    const me = await api('/auth/me');
    const u = (me && me.user) || me; // backend returns {role, user:{...}}
    if (u && u.name){
      const initials = u.name.split(/\s+/).map(s=>s[0]).slice(0,2).join('').toUpperCase();
      $('#adminName').textContent = u.name;
      $('#adminInitials').textContent = initials;
      // Same identity, mirrored into the dropdown's "logged in as" block --
      // this is the only place it stays visible once the header hides
      // .np-profile__meta on narrow screens.
      if ($('#adminIdName')) $('#adminIdName').textContent = u.name;
      if ($('#adminIdInitials')) $('#adminIdInitials').textContent = initials;
      if ($('#adminIdEmail')) $('#adminIdEmail').textContent = u.email || '';
      const nameEl = $('#dashWelcomeName');
      if (nameEl) nameEl.textContent = 'Welcome back, ' + u.name + ' 👋';
    }
    startDashClock();
  } catch(e) {
    if (e && e.status === 401) return;
  }
  setupSidebar();
  setupProfileMenu();
  const restored = (function(){
    try {
      const h = (location.hash || '').replace(/^#/, '').trim();
      if (!h) return null;
      const candidate = h + 'View';
      return document.getElementById(candidate) ? candidate : null;
    } catch (_) { return null; }
  })();
  setView(restored || 'dashboardView', { skipHash: !!restored });
  if (typeof NPSession !== 'undefined' && TOKEN) NPSession.start(TOKEN);
  if (typeof NPPalette !== 'undefined' && !window.__npPaletteWired) {
    window.__npPaletteWired = true;
    [
      ['Go to Dashboard',     '🏠', () => setView('dashboardView')],
      ['Go to Doctors',       '👩‍⚕️', () => setView('doctorsView')],
      ['Go to Appointments',  '📅', () => setView('apptsView')],
      ['Go to Revenue',       '💰', () => setView('revenueView')],
      ['Go to Settlements',   '🧾', () => setView('settlementsView')],
      ['Go to Invoices',      '📄', () => setView('invoicesView')],
      ['Go to Notifications', '🔔', () => setView('notifView')],
      ['Go to Settings',      '⚙️', () => setView('settingsView')],
      ['Add Doctor',          '➕', () => { setView('doctorsView'); setTimeout(() => openDoctorModal(), 50); }],
      ['Toggle dark mode',    '🌙', () => NPTheme && NPTheme.toggle()],
      ['Sign out',            '⏻', () => logout()],
    ].forEach(([label, icon, run]) => NPPalette.register({ label, icon, run, keywords: label }));
  }

  if (window.Finance && typeof window.Finance.refreshPendingBadge === 'function') {
    window.Finance.refreshPendingBadge();
  }
}

(async () => {
  $('#dashboard').classList.add('hidden');
  $('#loginScreen').classList.add('hidden');

  if (TOKEN) {
    try {
      const me = await api('/auth/me');
      if (me && me.role === 'ADMIN') return showDashboard();
      localStorage.removeItem('np_admin_token');
      TOKEN = null;
    } catch {
    }
  }
  showLogin();
})();

let __currentKycDoctorId = null;

function kycBadge(status){
  const map = {
    PENDING:  ['np-badge--slate', 'PENDING'],
    UPLOADED: ['np-badge--amber', 'UPLOADED'],
    VERIFIED: ['np-badge--green', 'VERIFIED'],
    REJECTED: ['np-badge--red',   'REJECTED']
  };
  const m = map[status] || map.PENDING;
  return `<span class="np-badge ${m[0]}"><span class="np-badge__dot"></span>${m[1]}</span>`;
}

function setKycFieldStatus(elId, viewElId, url){
  // SECURITY FIX (audit finding #2): KYC documents are no longer served
  // by a public static mount. Rewrite the stored /files/kyc-documents/...
  // URL to the authenticated admin route (Bearer header attached by the
  // panel's fetch; for <a> navigation we fall back to the fetch+blob
  // helper below when the browser cannot attach headers).

  const statusEl = $('#' + elId);
  const viewEl   = $('#' + viewElId);
  if (!statusEl || !viewEl) return;
  if (url) {
    statusEl.textContent = '— uploaded ✓';
    statusEl.style.color = '#0F8A4F';
    const fname = String(url).split('/').pop();
    const KIND_BY_VIEW = {
      kycAadhaarView: 'aadhaar',
      kycPanView: 'pan',
      kycChequeView: 'cancelledCheque',
      kycMedCertView: 'medicalRegCert'
    };
    const kind = KIND_BY_VIEW[viewElId] || '';
    viewEl.href = '/api/admin/kyc/' + encodeURIComponent(__currentKycDoctorId) +
                  '/' + encodeURIComponent(kind);
    viewEl.classList.remove('hidden');
  } else {
    statusEl.textContent = '— not uploaded';
    statusEl.style.color = '';
    viewEl.classList.add('hidden');
    viewEl.removeAttribute('href');
  }
}

// KYC document links need the admin Bearer token, which a plain <a href>
// navigation cannot send. Intercept clicks on any protected KYC link,
// fetch with Authorization, and open the resulting blob instead.
document.addEventListener('click', async (ev) => {
  const a = ev.target.closest('a[href^="/api/admin/kyc/"]');
  if (!a) return;
  ev.preventDefault();
  try {
    const res = await fetch(a.href, {
      headers: { Authorization: 'Bearer ' + (localStorage.getItem('nkp_admin_token') || '') }
    });
    if (!res.ok) { alert('Could not open document (HTTP ' + res.status + ')'); return; }
    const blob = await res.blob();
    const obj = URL.createObjectURL(blob);
    window.open(obj, '_blank', 'noopener');
  } catch (e) { alert('Could not open document: ' + e.message); }
});

async function loadKycForDoctor(doctorId){
  __currentKycDoctorId = doctorId;
  const panel = $('#doctorKycPanel');
  const hint  = $('#kycCreateHint');
  const upload = $('#kycUploadBlock');
  const verify = $('#kycVerifyBlock');
  const rejBox = $('#kycRejectionBox');
  const badge  = $('#kycStatusBadge');
  const verifiedAt = $('#kycVerifiedAt');

  setKycFieldStatus('kycAadhaarStatus', 'kycAadhaarView', null);
  setKycFieldStatus('kycPanStatus',     'kycPanView',     null);
  setKycFieldStatus('kycChequeStatus',  'kycChequeView',  null);
  setKycFieldStatus('kycMedCertStatus', 'kycMedCertView', null);
  rejBox.classList.add('hidden');
  $('#kycRejectionText').textContent = '';
  verifiedAt.textContent = '';

  if (!doctorId){
    hint.classList.remove('hidden');
    upload.classList.add('hidden');
    verify.classList.add('hidden');
    const bEl = $('#kycStatusBadge');
    if (bEl) bEl.outerHTML = kycBadge('PENDING').replace('<span ', '<span id="kycStatusBadge" ');
    return;
  }

  hint.classList.add('hidden');
  upload.classList.remove('hidden');

  let kyc;
  try {
    kyc = await api('/admin/doctors/' + encodeURIComponent(doctorId) + '/kyc');
  } catch (err) {
    const errEl = $('#kycUploadError');
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
    return;
  }

  const bEl = $('#kycStatusBadge');
  if (bEl) bEl.outerHTML = kycBadge(kyc.kycStatus).replace('<span ', '<span id="kycStatusBadge" ');

  setKycFieldStatus('kycAadhaarStatus', 'kycAadhaarView', kyc.aadhaarUrl);
  setKycFieldStatus('kycPanStatus',     'kycPanView',     kyc.panUrl);
  setKycFieldStatus('kycChequeStatus',  'kycChequeView',  kyc.cancelledChequeUrl);
  setKycFieldStatus('kycMedCertStatus', 'kycMedCertView', kyc.medicalRegCertUrl);

  if (kyc.kycStatus === 'REJECTED' && kyc.rejectionReason){
    rejBox.classList.remove('hidden');
    $('#kycRejectionText').textContent = kyc.rejectionReason;
  }

  const anyUploaded = !!(kyc.aadhaarUrl || kyc.panUrl || kyc.cancelledChequeUrl || kyc.medicalRegCertUrl);
  if (anyUploaded) verify.classList.remove('hidden'); else verify.classList.add('hidden');

  if (kyc.kycStatus === 'VERIFIED' && kyc.verifiedAt){
    verifiedAt.textContent = '✓ Verified ' + fmtDateTime(kyc.verifiedAt);
  }
}

async function uploadKycDocs(){
  const errEl = $('#kycUploadError');
  errEl.textContent = ''; errEl.classList.add('hidden');

  if (!__currentKycDoctorId){
    errEl.textContent = 'Save the doctor first, then upload KYC.';
    errEl.classList.remove('hidden');
    return;
  }

  const f = $('#doctorForm');
  const fd = new FormData();
  let hasAny = false;
  ['aadhaar','pan','cancelledCheque','medicalRegCert'].forEach(name => {
    const input = f.querySelector(`input[type="file"][name="${name}"]`);
    if (input && input.files && input.files[0]){
      fd.append(name, input.files[0]);
      hasAny = true;
    }
  });

  if (!hasAny){
    errEl.textContent = 'Pick at least one file to upload.';
    errEl.classList.remove('hidden');
    return;
  }

  try {
    const r = await fetch(API + '/admin/doctors/' + encodeURIComponent(__currentKycDoctorId) + '/kyc', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN },  // NO Content-Type — browser sets multipart boundary
      body: fd
    });
    let data = null; try { data = await r.json(); } catch(_) {}
    if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));

    ['aadhaar','pan','cancelledCheque','medicalRegCert'].forEach(name => {
      const input = f.querySelector(`input[type="file"][name="${name}"]`);
      if (input) input.value = '';
    });

    alert('KYC documents uploaded.');
    await loadKycForDoctor(__currentKycDoctorId);
    loadDoctors();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

async function verifyKyc(targetStatus){
  if (!__currentKycDoctorId) return;
  let body = { status: targetStatus };
  if (targetStatus === 'REJECTED'){
    const reason = await NPModal.prompt({
      title: 'Reject KYC',
      message: 'Please provide a clear rejection reason. This will be shown to the doctor.',
      placeholder: 'e.g. Aadhaar card image is blurred — please re-upload',
      okText: 'Reject KYC',
    });
    if (!reason || !reason.trim()){
      NPToast.warn('Rejection reason is required.');
      return;
    }
    body.rejectionReason = reason.trim();
  } else if (targetStatus === 'VERIFIED'){
    const ok = await NPModal.confirm({
      title: 'Verify KYC?',
      message: 'Mark this doctor\u2019s KYC as VERIFIED. This will allow settlement generation.',
      okText: 'Mark verified',
    });
    if (!ok) return;
  }
  try {
    await api('/admin/doctors/' + encodeURIComponent(__currentKycDoctorId) + '/kyc/status', {
      method: 'PATCH',
      body: JSON.stringify(body)
    });
    await loadKycForDoctor(__currentKycDoctorId);
    loadDoctors();
  } catch (err){
    alert(err.message);
  }
}

(function(){
  'use strict';
  var doc = document;
  var mqMobile = window.matchMedia ? window.matchMedia('(max-width:1023px)') : null;

  function setBodyLock(locked){
    if (!doc.body) return;
    doc.body.classList.toggle('np-drawer-open', !!locked);
  }

  function wire(){
    var sidebar  = doc.getElementById('sidebar');
    var backdrop = doc.getElementById('sidebarBackdrop');
    var toggle   = doc.getElementById('sidebarToggle');
    if (!sidebar || !backdrop) return;
    // v3.3.2: idempotent — never shadow the primary setupSidebar handlers.
    if (backdrop.__npBound) return; backdrop.__npBound = true;

    function isOpen(){ return sidebar.classList.contains('is-open'); }
    function open(){
      sidebar.classList.add('is-open');
      backdrop.classList.add('is-open');
      backdrop.setAttribute('aria-hidden','false');
      setBodyLock(true);
    }
    function close(){
      sidebar.classList.remove('is-open');
      backdrop.classList.remove('is-open');
      backdrop.setAttribute('aria-hidden','true');
      setBodyLock(false);
    }

    // v3.3.2: safety-net backdrop click MUST close the drawer. Missing before.
    backdrop.addEventListener('click', close);
    backdrop.addEventListener('touchend', function(e){ e.preventDefault(); close(); }, { passive:false });

    if (toggle && !toggle.__npSafetyBound){
      toggle.__npSafetyBound = true;
      // Do NOT double-toggle the classes (setupSidebar already handles that);
      // only reconcile the body-lock state after the primary handler runs.
      toggle.addEventListener('click', function(){
        setTimeout(function(){ setBodyLock(isOpen()); }, 0);
      });
    }

    doc.addEventListener('keydown', function(e){
      if (e.key === 'Escape' && isOpen()) close();
    });

    function onResize(){ if (!mqMobile || !mqMobile.matches) close(); }
    if (mqMobile && mqMobile.addEventListener) mqMobile.addEventListener('change', onResize);
    else if (mqMobile && mqMobile.addListener) mqMobile.addListener(onResize);
  }

  function wireThemeSwitch(){
    var opts = doc.querySelectorAll('#setting-appearance [data-theme-choice]');
    if (!opts.length || !window.NPTheme) return;
    function paint(){
      var mode = window.NPTheme.current ? window.NPTheme.current() :
        (doc.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
      opts.forEach(function(el){
        var active = el.dataset.themeChoice === mode;
        el.classList.toggle('is-active', active);
        el.setAttribute('aria-checked', active ? 'true' : 'false');
      });
    }
    opts.forEach(function(el){
      el.addEventListener('click', function(){
        window.NPTheme.set(el.dataset.themeChoice);
        paint();
      });
    });
    doc.addEventListener('np-theme-change', paint);
    paint();
  }

  function bootAdminExtras(){
    try { wire(); } catch(_){}
    try { wireThemeSwitch(); } catch(_){}
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', bootAdminExtras);
  else bootAdminExtras();
})();


/* =====================================================================
   Feature 1/1A — Historical / Manual Appointments (admin)
   Feature 2    — Medical Certificates (admin oversight)
   Appended module — defensive: delegates to existing helpers when present.
   ===================================================================== */

function _adm$(sel, root){ return (root || document).querySelector(sel); }
function _admEsc(s){
  if (typeof escapeHtml === 'function') return escapeHtml(s);
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}
function _admFmtDate(d){
  if (typeof fmtDate === 'function') return fmtDate(d);
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }); }
  catch(e){ return String(d); }
}
function _admToast(kind, msg){
  if (window.NPToast && NPToast[kind]) { NPToast[kind](msg); return; }
  try { alert(msg); } catch(e){}
}
function _admToken(){
  try {
    if (typeof TOKEN !== 'undefined' && TOKEN) return TOKEN;
  } catch(e){}
  try {
    var keys = ['np_admin_token','nkp_admin_token','np_token','token','auth_token'];
    for (var i = 0; i < keys.length; i++){
      var v = localStorage.getItem(keys[i]);
      if (v) return v;
    }
  } catch(e){}
  return null;
}
async function _admApi(path, opts){
  opts = opts || {};
  if (typeof api === 'function') return api(path, opts);
  var headers = Object.assign({}, opts.headers || {});
  var tok = _admToken();
  if (tok) headers['Authorization'] = 'Bearer ' + tok;
  if (!(opts.body instanceof FormData) && opts.body && typeof opts.body === 'object'){
    headers['Content-Type'] = 'application/json';
    opts = Object.assign({}, opts, { body: JSON.stringify(opts.body) });
  }
  var res = await fetch('/api' + path, Object.assign({}, opts, { headers: headers }));
  var data = null;
  try { data = await res.json(); } catch(e){}
  if (!res.ok){
    var err = new Error((data && (data.message || data.error)) || ('HTTP ' + res.status));
    err.status = res.status; err.data = data; throw err;
  }
  return data;
}

var _admHistWired = false;
var _admLinkCandidates = [];

/* ---------- Feature 2: admin certificates oversight ---------- */
async function loadAdmCertificates(){
  var wrap = _adm$('#admCertList');
  if (!wrap) return;
  wrap.innerHTML = '<div class="np-empty"><div class="np-empty__title">Loading…</div></div>';
  try {
    var res = await _admApi('/admin/certificates');
    var rows = Array.isArray(res) ? res : (res.certificates || res.items || []);
    if (!rows.length){
      wrap.innerHTML = '<div class="np-empty"><div class="np-empty__title">No certificates yet</div><div class="np-empty__sub">Certificates issued by doctors will appear here.</div></div>';
      return;
    }
    var CERT_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>';
    wrap.innerHTML = '<div class="np-cert-list">' + rows.map(function(c){
      var patientName = c.patientNameSnapshot || (c.patient && c.patient.name) || '—';
      var doctorName = c.doctorName || (c.doctor && c.doctor.name) || '';
      var tpl = (c.templateKey || 'GENERAL').replace(/_/g, ' ');
      var when = _admFmtDate(c.issuedAt || c.createdAt);
      return '<article class="np-cert-card">'
        + '<div class="np-cert-card__icon">' + CERT_ICON + '</div>'
        + '<div class="np-cert-card__main">'
        + '<div class="np-cert-card__top">'
        + '<span class="np-cert-card__name">' + _admEsc(patientName) + '</span>'
        + '<span class="np-badge np-badge--mint">' + _admEsc(tpl) + '</span>'
        + '</div>'
        + '<div class="np-cert-card__meta">'
        + (doctorName ? '<span>Dr. ' + _admEsc(doctorName) + '</span>' : '')
        + (c.certificateNumber ? '<span class="np-cert-card__num">' + _admEsc(c.certificateNumber) + '</span>' : '')
        + '<span>' + _admEsc(when) + '</span>'
        + '</div>'
        + (c.reason ? '<div class="np-cert-card__reason">' + _admEsc(c.reason) + '</div>' : '')
        + '</div>'
        + '<div class="np-cert-card__actions">'
        + '<button type="button" class="np-btn np-btn--sm" onclick="viewAdmCert(\'' + _admEsc(c.id) + '\')">View</button>'
        + '</div>'
        + '</article>';
    }).join('') + '</div>';
  } catch(ex){
    wrap.innerHTML = '<div class="np-error">' + _admEsc(ex.message || 'Failed to load certificates') + '</div>';
  }
}

async function viewAdmCert(id){
  var modal = _adm$('#admCertModal');
  var body = _adm$('#admCertDetail');
  body.innerHTML = '<div class="np-mut">Loading…</div>';
  modal.classList.remove('hidden');
  try {
    var d = await _admApi('/admin/certificates/' + encodeURIComponent(id));
    var c = d.certificate || d;
    var pdfUrl = c.pdfUrl || d.pdfUrl || null;
    var rows = [
      ['Certificate ID', c.certificateNumber],
      ['Patient', c.patientNameSnapshot || (c.patient && c.patient.name)],
      ['Doctor', c.doctor ? ('Dr. ' + c.doctor.name) : c.doctorName],
      ['Template', (c.templateKey || '').replace(/_/g, ' ')],
      ['Issued', _admFmtDate(c.issuedAt || c.createdAt)],
      ['Reason', c.reason],
      ['Diagnosis', c.diagnosis],
      ['Rest', c.restDays ? (c.restDays + ' day(s)') : null],
      ['Notes', c.additionalNotes]
    ].filter(function(r){ return r[1]; });
    body.innerHTML = rows.map(function(r){
      return '<div style="display:flex; gap:.75rem; padding:.35rem 0; border-bottom:1px solid var(--np-border);">'
        + '<div class="np-mut" style="width:130px; flex:none; font-size:.85rem;">' + _admEsc(r[0]) + '</div>'
        + '<div style="font-size:.9rem;">' + _admEsc(r[1]) + '</div></div>';
    }).join('')
    + (pdfUrl ? '<div style="margin-top:.9rem;"><a class="np-btn np-btn--primary np-btn--sm" href="' + _admEsc(pdfUrl) + '" target="_blank" rel="noopener">Open PDF</a></div>' : '');
  } catch(ex){
    body.innerHTML = '<div class="np-error">' + _admEsc(ex.message || 'Could not load certificate') + '</div>';
  }
}
function closeAdmCertModal(){ _adm$('#admCertModal').classList.add('hidden'); }

function openAdmCertInfo(){
  var modal = _adm$('#admCertModal');
  _adm$('#admCertDetail').innerHTML =
    '<p class="np-mut" style="font-size:.9rem;">Certificates are signed with the issuing doctor\'s digital signature, so they must be generated from the <b>Doctor Panel</b> (Appointments → Medical certificate, or the Certificates tab). This view gives admins read-only oversight of every issued certificate.</p>';
  modal.classList.remove('hidden');
}

/* ---------- Wire-up ---------- */
function setupAdmFeatureUI(){
  var cbtn = document.querySelector('[data-view="certsView"]');
  if (cbtn && !cbtn.__admFeat){ cbtn.__admFeat = true; cbtn.addEventListener('click', loadAdmCertificates); }
  var nb = _adm$('#admNewCertBtn');
  if (nb && !nb.__wired){ nb.__wired = true; nb.addEventListener('click', openAdmCertInfo); }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupAdmFeatureUI);
else setupAdmFeatureUI();


(function(){
  var btn = document.getElementById('admNewCertBtn');
  if (btn && !btn.__readOnlyWired){
    btn.__readOnlyWired = true;
    btn.addEventListener('click', function(){
      if (typeof NPModal !== 'undefined' && NPModal.alert) {
        NPModal.alert({ title:'Read-only in admin', message:'Admins can review, download and audit certificates here. Doctors must create or edit certificates from the doctor panel.' });
      } else {
        alert('Admins can review, download and audit certificates here. Doctors must create or edit certificates from the doctor panel.');
      }
    });
  }
})();
