/* =====================================================================
   NeoKidsPro Admin Panel v2.1
   - FIX 4: Modernized dashboard with rich KPIs + 14-day chart
   - FIX 5: Appointment table with full filters (search, status, type,
            payment, doctor, date range)
   - FIX 6: Doctor insights drawer (completion %, revenue, sparkline)
   - FIX 7: Notification Logs view with filters & detail modal
   - FIX 8 (regression): Admin login broke after sign-out because:
              (a) finance.js polled a protected endpoint on every page
                  load — including the login screen — which returned 401,
              (b) the api() 401 interceptor blindly called location.reload()
                  even when no token had been sent, creating a tight
                  reload loop that ate the user's typing in the login form,
              (c) logout() itself called location.reload(), which re-armed
                  the same DOMContentLoaded → poll → 401 → reload chain.
            This file now (i) only reloads on 401 when a token WAS sent,
            (ii) makes logout a pure DOM swap (no reload), and
            (iii) drives Finance.refreshPendingBadge() from showDashboard()
            instead of from a global DOMContentLoaded timer.
   - 100% backwards compatible: all existing endpoints unchanged.
   ===================================================================== */

const API = '/api';
let TOKEN = localStorage.getItem('np_admin_token');

const $  = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => Array.from(root.querySelectorAll(s));

let __doctorsCache = [];
let __apptsCache = [];

/* -------- API helper --------
 *
 * The earlier version unconditionally did `location.reload()` on ANY 401.
 * That was the amplifier behind the post-logout reload loop:
 *   • finance.js polls /admin/finance/settlements on every page load
 *   • on the login screen there is no token → 401
 *   • api() reloads the page → DOMContentLoaded fires again → poll re-arms
 *   • the user can never finish typing the login form
 *
 * The patched helper only triggers a reload when a token WAS attached to
 * the failed request (i.e. genuine "session expired"). When the user has
 * no token to begin with, we simply throw so the caller can decide what
 * to do — typically the caller is on the login screen and silently
 * swallows the error.
 */
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
      // We DID send a token and the server rejected it → real session
      // expiry. Clean up and surface the login screen via a soft swap
      // (no full reload, so we don't risk re-arming background polls).
      localStorage.removeItem('np_admin_token');
      TOKEN = null;
      showLogin();
      const err = new Error('Session expired'); err.status = 401; throw err;
    }
    // No token attached → caller is unauthenticated background code
    // (typically running while the login screen is visible). Do NOT
    // reload — that would wipe the user's in-progress form input and,
    // combined with any DOMContentLoaded-scheduled work, create an
    // infinite loop. Just throw an ordinary error.
    const err = new Error((data && (data.error || data.message)) || 'Unauthorized');
    err.status = 401; throw err;
  }

  if (!r.ok) throw new Error((data && (data.error || data.message)) || ('HTTP ' + r.status));
  return data;
}

/* -------- Utils -------- */
function escapeHtml(s){
  return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
/* Strip any leading "Dr." / "Dr " the user may have typed when adding
   a doctor, so we never render "Dr. Dr Anita Rao". Use drName(d.name)
   wherever you would have written `'Dr. ' + d.name`. */
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
function deltaTag(curr, prev){
  const diff = curr - prev;
  if (diff > 0) return `<div class="np-kpi__delta np-kpi__delta--up">▲ ${diff} vs yesterday</div>`;
  if (diff < 0) return `<div class="np-kpi__delta np-kpi__delta--down">▼ ${Math.abs(diff)} vs yesterday</div>`;
  return `<div class="np-kpi__delta np-kpi__delta--flat">— same as yesterday</div>`;
}

/* =====================================================================
   AUTH
   ===================================================================== */
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginError').classList.add('hidden');
  try {
    // We intentionally use raw fetch here, not api(), so we never attach a
    // (possibly stale) Authorization header to the login request and so a
    // 401 from bad credentials does NOT enter the api() 401 interceptor.
    const r = await fetch(API + '/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('#email').value, password: $('#password').value })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Login failed');
    if (data.role !== 'ADMIN') throw new Error('Not an admin account');
    TOKEN = data.token;
    localStorage.setItem('np_admin_token', TOKEN);
    showDashboard();
  } catch (err) {
    $('#loginError').textContent = err.message;
    $('#loginError').classList.remove('hidden');
  }
});
async function forgotPassword() {
  const email = prompt('Enter your admin account email');
  if (!email) return;
  try {
    const res = await api('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
    alert(res.previewUrl ? `Reset link (mock mode): ${res.previewUrl}` : 'If the account exists, a reset link has been sent.');
  } catch (err) { alert(err.message); }
}
/* Logout — pure DOM swap, NO location.reload().
 *
 * Reloading on logout was actively harmful: it re-fired DOMContentLoaded,
 * which re-armed the finance.js 1.5 s poll, which hit /admin/finance/...
 * with no token, which 401'd, which (in the old api() helper) triggered
 * yet another reload. Now we just clear the token, restore the login
 * screen, and reset any in-page state we own. */
function logout() {
  localStorage.removeItem('np_admin_token');
  TOKEN = null;
  __doctorsCache = [];
  __apptsCache = [];
  showLogin();
}

/* Show / hide screens — both helpers also reset transient form/error
 * state so leftover content from the previous session never leaks. */
function showLogin() {
  $('#dashboard').classList.add('hidden');
  $('#loginScreen').classList.remove('hidden');
  const f = $('#loginForm'); if (f) f.reset();
  const err = $('#loginError'); if (err) { err.textContent = ''; err.classList.add('hidden'); }
}

/* =====================================================================
   SHELL
   ===================================================================== */
const VIEW_META = {
  dashboardView:   { title:'Dashboard',          sub:'Overview of your clinic' },
  doctorsView:     { title:'Doctors',            sub:'Manage clinic doctors and their performance' },
  apptsView:       { title:'Appointments',       sub:'All bookings across the clinic' },
  revenueView:     { title:'Revenue Reports',    sub:'Monthly clinic revenue — Cashfree only' },
  settlementsView: { title:'Doctor Settlements', sub:'Generate, review, and pay monthly doctor settlements' },
  invoicesView:    { title:'Invoices',           sub:'Settlement invoices issued to doctors' },
  notifView:       { title:'Notification Logs',  sub:'Audit WhatsApp & email deliveries' },
  settingsView:    { title:'Settings',           sub:'Account management' }
};
function setView(view) {
  $$('.tab-pane').forEach(v => v.classList.add('hidden'));
  const el = document.getElementById(view); if (el) el.classList.remove('hidden');
  $$('.np-nav-item').forEach(n => n.classList.remove('active'));
  const link = document.querySelector(`[data-view="${view}"]`);
  if (link) link.classList.add('active');
  const meta = VIEW_META[view];
  if (meta) { $('#pageTitle').textContent = meta.title; $('#pageSubtitle').textContent = meta.sub; }
  if (view === 'dashboardView') loadDashboard();
  if (view === 'doctorsView')   loadDoctors();
  if (view === 'apptsView')     { loadDoctorsForFilter(); loadAppointments(); }
  if (view === 'notifView')     { loadNotifTemplates(); loadNotifications(); }
  // ─ Revenue Management views (handlers live in finance.js) ─
  if (view === 'revenueView'     && window.Finance) Finance.loadRevenue();
  if (view === 'settlementsView' && window.Finance) Finance.loadSettlements();
  if (view === 'invoicesView'    && window.Finance) Finance.loadInvoices();
}

function setupSidebar(){
  const sidebar = $('#sidebar'); const backdrop = $('#sidebarBackdrop'); const toggle = $('#sidebarToggle');
  if (!sidebar || !toggle || !backdrop) return;
  if (toggle.__bound) return; toggle.__bound = true;
  function open(){ sidebar.classList.add('is-open'); backdrop.classList.add('is-open'); }
  function close(){ sidebar.classList.remove('is-open'); backdrop.classList.remove('is-open'); }
  toggle.addEventListener('click', () => sidebar.classList.contains('is-open') ? close() : open());
  backdrop.addEventListener('click', close);
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

/* =====================================================================
   DASHBOARD — FIX 4
   ===================================================================== */
async function loadDashboard() {
  try {
    const a = await api('/admin/analytics');
    // KPI cards
    const cards = [
      { kind:'blue',  label:"Today's Appointments", value: a.todayAppointments,
        extra: deltaTag(a.todayAppointments, a.yesterdayAppointments) },
      { kind:'mint',  label:"Last 7 days",          value: a.last7Appointments,
        sub: `${a.last30Appointments} in last 30 days` },
      { kind:'coral', label:"Total Patients",       value: a.totalPatients,
        sub: `${a.totalDoctors} active doctors` },
      { kind:'cream', label:"Lifetime Revenue",     value: fmtCurrency(a.totalRevenue),
        sub: `${fmtCurrency(a.revenueLast30)} in last 30 days` },
      { kind:'violet',label:"Completion Rate",      value: a.completionRate + '%',
        sub: `${a.completedAppointments} of ${a.totalAppointments} completed` },
      { kind:'rose',  label:"Cancellation Rate",    value: a.cancellationRate + '%',
        sub: `${a.cancelledAppointments} cancelled` }
    ];
    $('#statsGrid').innerHTML = cards.map(c => `
      <div class="np-kpi np-kpi--${c.kind}">
        <div class="np-kpi__label">${escapeHtml(c.label)}</div>
        <div class="np-kpi__value">${escapeHtml(String(c.value))}</div>
        ${c.sub ? `<div class="np-kpi__sub">${escapeHtml(c.sub)}</div>` : ''}
        ${c.extra || ''}
      </div>`).join('');

    // 14-day bars
    const max = Math.max(1, ...(a.daily || []).map(d => d.total));
    $('#dailyBars').innerHTML = (a.daily || []).map(d => {
      const h = Math.max(2, Math.round((d.total / max) * 80));
      const cls = d.total === 0 ? 'np-bars__bar np-bars__bar--muted' : 'np-bars__bar';
      return `<div class="${cls}" style="height:${h}px" title="${d.date}: ${d.total} appts, ${d.completed} completed, ${fmtCurrency(d.revenue)}"></div>`;
    }).join('');
    $('#dailyLabels').innerHTML = (a.daily || []).map((d, i) => {
      if (i === 0 || i === a.daily.length - 1 || i === Math.floor(a.daily.length / 2)) {
        return `<span>${d.date.slice(5)}</span>`;
      }
      return '<span></span>';
    }).join('');

    // Sidebar failed-notifs badge
    const fail = a.notificationsFailed || 0;
    const badge = $('#navBadgeFailed');
    if (badge) {
      if (fail > 0) { badge.textContent = fail; badge.classList.remove('hidden'); }
      else { badge.classList.add('hidden'); }
    }

    // Recent appts
    const appts = await api('/admin/appointments?limit=10');
    $('#recentAppts').innerHTML = (appts.length === 0)
      ? `<div class="np-empty"><div class="np-empty__title">No appointments yet</div><div class="np-empty__sub">Bookings will show up here.</div></div>`
      : appts.slice(0, 10).map(a => `
        <div class="np-appt-row" onclick="setView('apptsView')">
          <div class="np-appt-row__time">
            <div class="np-appt-row__time-h">${escapeHtml(fmtTime(a.startTime))}</div>
            <div class="np-appt-row__time-d">${escapeHtml(fmtDate(a.date))}</div>
          </div>
          <div class="np-appt-row__body">
            <div class="np-appt-row__name">${escapeHtml(a.patient.name)} → ${drNameHtml(a.doctor.name)}</div>
            <div class="np-appt-row__meta">${escapeHtml(a.primaryProblem || '—')}</div>
          </div>
          <div class="np-appt-row__right">
            ${statusBadge(a.status)}
          </div>
        </div>`).join('');
  } catch (err) {
    $('#statsGrid').innerHTML = `<div class="np-error">${escapeHtml(err.message)}</div>`;
  }
}

/* =====================================================================
   DOCTORS — modernized cards + insights drawer (FIX 6)
   ===================================================================== */
async function loadDoctors() {
  try {
    const docs = await api('/admin/doctors');
    // Fetch KYC for each doctor in parallel. The endpoint always returns a
    // valid shape (empty record → kycStatus: 'PENDING'), so this never 404s.
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
/* ---------------------------------------------------------------------
 * Doctor card rendering
 *
 * Design goals (addressing the UI/UX issues raised):
 *  1. Equal-height cards — .np-doc-card uses grid-template-rows so every
 *     section sits at the exact same vertical position across cards.
 *  2. Single-line name with ellipsis — enforced via CSS, plus we keep the
 *     full name in a title attribute for hover.
 *  3. Avatar never clipped — fixed 44px basis, never shrinks; card has
 *     min-width:0 and box-sizing:border-box; grid uses minmax(min(280px,100%),1fr).
 *  4. Clean info hierarchy — name > specialization > qualification.
 *     Email/phone moved to a dedicated icon-prefixed contact strip.
 *  5. Qualification dedup — if d.qualification is already contained in
 *     d.specialization (case-insensitive) we hide it.
 *  6. Compact pills replace the wrapped password warning text.
 *  7. Stats locked to a 2×2 grid — layout is identical no matter the width.
 *  8. Actions row uses 1fr 1fr 1fr auto grid so spacing is identical.
 * ------------------------------------------------------------------ */
function _docInitials(name){
  const clean = stripDrPrefix(name) || 'D';
  return clean.split(/\s+/).map(s => s[0]).slice(0,2).join('').toUpperCase();
}
function _docAvatar(d){
  if (d.photoUrl) {
    return `<img class="np-doc-card__avatar" src="${escapeHtml(d.photoUrl)}" alt="${drNameHtml(d.name)}"/>`;
  }
  return `<div class="np-doc-card__avatar" aria-hidden="true">${escapeHtml(_docInitials(d.name))}</div>`;
}
function _docQualification(d){
  const q = String(d.qualification || '').trim();
  if (!q) return '';
  const spec = String(d.specialization || '').trim().toLowerCase();
  // Suppress qualification if specialization already contains it (e.g.
  // specialization = "Pediatrician — MBBS, MD" and qualification = "MBBS, MD")
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
  if (!confirm(`Permanently delete ${drName(name)}? This is only allowed if the doctor has no appointments.`)) return;
  try {
    await api('/admin/doctors/' + id + '/hard', { method: 'DELETE' });
    loadDoctors();
  } catch (err) { alert(err.message); }
}

/* ---- Doctor Modal (Add/Edit) ---- */
function openDoctorModal() {
  $('#doctorModalTitle').textContent = 'Add Doctor';
  const f = $('#doctorForm');
  f.dataset.mode = 'create';
  f.dataset.id = '';
  f.email.disabled = false;
  f.email.readOnly = false;
  f.password.placeholder = '(invite link is preferred)';
  loadKycForDoctor(null);
  $('#doctorModal').classList.remove('hidden');
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
  // Revenue Management — per-doctor split
  if (f.clinicSharePercent) f.clinicSharePercent.value = d.clinicSharePercent ?? 25;
  if (f.doctorSharePercent) f.doctorSharePercent.value = d.doctorSharePercent ?? 75;
  if (f.tdsPercent)         f.tdsPercent.value         = d.tdsPercent ?? 10;
  loadKycForDoctor(id);
  $('#doctorModal').classList.remove('hidden');
}

// Auto-keep the clinic + doctor share fields balanced to 100. The user can
// edit either side; we update the other to (100 - this).
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
    phone: (raw.phone || '').replace(/\D/g, '').replace(/^91/, ''),
    specialization: (raw.specialization || '').trim() || undefined,
    qualification: (raw.qualification || '').trim() || undefined,
    experience: raw.experience === '' ? 0 : Number(raw.experience),
    bio: (raw.bio || '').trim() || undefined,
    consultationModes: raw.consultationModes || 'BOTH',
    onlineConsultFee: raw.onlineConsultFee === '' ? 0 : Number(raw.onlineConsultFee),
    physicalConsultFee: raw.physicalConsultFee === '' ? 0 : Number(raw.physicalConsultFee)
  };
  // Revenue Management — only send share fields when the user actually filled them.
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
      // Issue 12 — the backend now ALWAYS returns the invite link in
      // `invitePreviewUrl` (regardless of SMTP mode), plus a boolean
      // `inviteSent` describing whether email delivery succeeded.
      // Show the link to the admin every time so it can be copy-pasted
      // to the doctor over WhatsApp / Slack if email fails silently.
      const ttl = res.inviteExpiresInMinutes ? ` (expires in ${res.inviteExpiresInMinutes} min)` : '';
      if (res.invitePreviewUrl) {
        const status = res.inviteSent
          ? 'Doctor created — invite email sent.'
          : 'Doctor created — email delivery NOT confirmed.';
        alert(`${status}\n\nInvite link${ttl}:\n${res.invitePreviewUrl}\n\nCopy this link if the doctor does not receive the email.`);
      } else {
        alert('Doctor created and invite email sent.');
      }
      // Flip the modal into edit-mode for this new doctor so the admin can
      // upload KYC documents immediately without re-opening.
      f.dataset.mode = 'edit';
      f.dataset.id   = res.id;
      f.email.readOnly = true;
      $('#doctorModalTitle').textContent = 'Edit Doctor';
      await loadKycForDoctor(res.id);
      loadDoctors();
      return;
    }
    closeDoctorModal(); loadDoctors();
  } catch (err) { errEl.textContent = err.message; errEl.classList.remove('hidden'); }
});

/* ---- Doctor Insights Drawer (FIX 6) ---- */
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
        ${d.photoUrl ? `<img class="np-profile__avatar" style="width:60px;height:60px;border-radius:14px;" src="${escapeHtml(d.photoUrl)}"/>`
                    : `<div class="np-profile__avatar" style="width:60px;height:60px;border-radius:14px;">${escapeHtml((d.name||'D').split(/\s+/).map(s=>s[0]).slice(0,2).join('').toUpperCase())}</div>`}
        <div style="flex:1;">
          <div style="font-weight:700; color:var(--np-ink);">${drNameHtml(d.name)}</div>
          <div class="np-mut" style="font-size:.82rem;">${escapeHtml(d.specialization||'Pediatrician')} · ${escapeHtml(d.qualification||'')}</div>
          <div class="np-mut" style="font-size:.78rem;">${escapeHtml(d.email)} · +91 ${escapeHtml(d.phone)}</div>
          ${d.clinicName ? `<div class="np-mut" style="font-size:.78rem;">🏥 ${escapeHtml(d.clinicName)}</div>` : ''}
          <div style="margin-top:.35rem;">${d.isAvailable ? '<span class="np-badge np-badge--green"><span class="np-badge__dot"></span>Active</span>' : '<span class="np-badge np-badge--slate"><span class="np-badge__dot"></span>Inactive</span>'}</div>
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
  } catch (err) {
    body.innerHTML = `<div class="np-error">${escapeHtml(err.message)}</div>`;
  }
}
function closeDoctorDrawer(){ $('#doctorDrawer').classList.add('hidden'); }

/* ---- Doctor filter bar listeners ---- */
$('#docSearch').addEventListener('input', renderDoctors);
$('#docFilterAvail').addEventListener('change', renderDoctors);

/* =====================================================================
   APPOINTMENTS — FIX 5
   ===================================================================== */
async function loadDoctorsForFilter(){
  try {
    if (!__doctorsCache.length) __doctorsCache = await api('/admin/doctors');
    const sel = $('#filterDoctor');
    sel.innerHTML = '<option value="">All doctors</option>' +
      __doctorsCache.map(d => `<option value="${escapeHtml(d.id)}">${drNameHtml(d.name)}</option>`).join('');
  } catch(_) {}
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
  if (status)   qs.set('status',   status);
  if (type)     qs.set('type',     type);
  if (payment)  qs.set('payment',  payment);
  if (doctorId) qs.set('doctorId', doctorId);
  if (from)     qs.set('from',     from);
  if (to)       qs.set('to',       to);
  if (q.length >= 2) qs.set('q', q);
  try {
    const appts = await api('/admin/appointments' + (qs.toString() ? '?' + qs.toString() : ''));
    __apptsCache = appts;
    if (!appts.length){
      tbody.innerHTML = `<tr><td colspan="7"><div class="np-empty"><div class="np-empty__title">No appointments match</div><div class="np-empty__sub">Try clearing some filters.</div></div></td></tr>`;
      return;
    }
    tbody.innerHTML = appts.map(a => `
      <tr>
        <td>
          <div><b>${escapeHtml(fmtDate(a.date))}</b></div>
          <div class="np-mut" style="font-size:.78rem;">${escapeHtml(fmtTime(a.startTime))}${a.endTime ? ' – ' + escapeHtml(fmtTime(a.endTime)) : ''}</div>
        </td>
        <td>
          <div><b>${escapeHtml(a.patient.name)}</b></div>
          <div class="np-mut" style="font-size:.78rem;">+91 ${escapeHtml(a.patient.phone||'')}</div>
          ${a.primaryProblem ? `<div class="np-mut" style="font-size:.75rem; margin-top:.15rem;">${escapeHtml(a.primaryProblem)}</div>` : ''}
        </td>
        <td>${drNameHtml(a.doctor.name)}<br/><span class="np-mut" style="font-size:.75rem;">${escapeHtml(a.doctor.specialization||'')}</span></td>
        <td>${typeBadge(a.consultationType)}</td>
        <td>${statusBadge(a.status)}${a.status === 'CANCELLED' && a.notes ? `<div style="font-size:.72rem; color:#B91C1C; margin-top:.2rem;">${escapeHtml(a.notes)}</div>` : ''}</td>
        <td>${paymentBadge(a.paymentStatus)}</td>
        <td style="text-align:right;"><b>${fmtCurrency(a.feeAtBooking)}</b></td>
      </tr>`).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="np-error">${escapeHtml(err.message)}</div></td></tr>`;
  }
}
$('#applyFilters').addEventListener('click', loadAppointments);
$('#clearFilters').addEventListener('click', () => {
  ['filterStatus','filterType','filterPayment','filterDoctor','filterFrom','filterTo','apptSearch'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  loadAppointments();
});
$('#apptSearch').addEventListener('input', () => { /* debounce */
  clearTimeout(window.__apptSearchTimer);
  window.__apptSearchTimer = setTimeout(loadAppointments, 280);
});

/* =====================================================================
   NOTIFICATION LOGS — FIX 7
   ===================================================================== */
let __notifTemplatesCache = null;

async function loadNotifTemplates(){
  try {
    const data = await api('/admin/notifications/templates');
    if (Array.isArray(data)) {
      __notifTemplatesCache = { flat: data, groups: null };
    } else {
      __notifTemplatesCache = data || { flat: [], groups: null };
    }
    renderNotifTemplateOptions();
  } catch(_) {}
}

function renderNotifTemplateOptions(){
  const sel = $('#notifTemplate');
  if (!sel || !__notifTemplatesCache) return;
  const current  = sel.value;
  const audience = ($('#notifAudience') && $('#notifAudience').value) || '';

  let html = '<option value="">All templates</option>';
  const { groups, flat } = __notifTemplatesCache;

  // ── Update audience-filter labels with counts so an admin can see at a glance
  // how many templates exist in each bucket (also makes UX#2 visually obvious).
  const audSel = $('#notifAudience');
  if (audSel && groups) {
    const labels = {
      '':        'All recipient types',
      PATIENT:   'Patient Templates',
      DOCTOR:    'Doctor Templates',
      ADMIN:     'Admin / System Templates',
      OTHER:     'Other'
    };
    const totalFlat = (flat || []).length;
    [...audSel.options].forEach(opt => {
      const k = opt.value;
      const count = k ? ((groups[k] && groups[k].items.length) || 0) : totalFlat;
      opt.textContent = labels[k] + ' (' + count + ')';
    });
  }

  if (groups) {
    const order = ['PATIENT','DOCTOR','ADMIN','OTHER'];
    let rendered = 0;
    for (const key of order) {
      const g = groups[key];
      if (!g) continue;
      if (audience && key !== audience) continue;
      if (!g.items.length) continue;        // skip empty groups in the dropdown itself
      html += `<optgroup label="${escapeHtml(g.label)} (${g.items.length})">`;
      for (const it of g.items) {
        const lbl = it.template + (it.channel ? ' · ' + it.channel : '');
        html += `<option value="${escapeHtml(it.template)}">${escapeHtml(lbl)}</option>`;
      }
      html += '</optgroup>';
      rendered++;
    }
    if (!rendered) {
      // No matching templates under current audience filter → show a hint.
      html += '<option value="" disabled>— No templates in this category yet —</option>';
    }
  } else if (flat) {
    html += flat.map(r => `<option value="${escapeHtml(r.template)}">${escapeHtml(r.template)}${r.channel ? ' · ' + escapeHtml(r.channel) : ''}</option>`).join('');
  }
  sel.innerHTML = html;

  const stillVisible = [...sel.options].some(o => o.value === current && !o.disabled);
  sel.value = stillVisible ? current : '';
}
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
  try {
    const data = await api('/admin/notifications' + (qs.toString() ? '?' + qs.toString() : ''));
    const rows = data.rows || [];
    const counts = data.counts || {};
    // count chips
    $('#notifCounts').innerHTML = [
      `<span class="np-badge np-badge--green">${counts.SENT || 0} Sent</span>`,
      `<span class="np-badge np-badge--red">${counts.FAILED || 0} Failed</span>`,
      counts.QUEUED ? `<span class="np-badge np-badge--amber">${counts.QUEUED} Queued</span>` : ''
    ].join('');
    if (!rows.length){
      tbody.innerHTML = `<tr><td colspan="6"><div class="np-empty"><div class="np-empty__title">No notifications match</div><div class="np-empty__sub">Adjust filters or wait for the next event.</div></div></td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(n => `
      <tr class="np-notif-row" style="cursor:pointer;" data-id="${escapeHtml(n.id)}">
        <td>${escapeHtml(fmtDateTime(n.createdAt))}</td>
        <td>${channelBadge(n.channel)}</td>
        <td>${escapeHtml(n.template || '')}</td>
        <td>${escapeHtml(n.recipient || '')}</td>
        <td>${notifStatusBadge(n.status)}${n.direction ? ` <span class="np-badge np-badge--slate" style="margin-left:.25rem;">${escapeHtml(n.direction)}</span>` : ''}</td>
        <td class="np-notif-error" style="max-width:280px; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(n.errorMessage || '')}</td>
      </tr>`).join('');
    // click to open detail
    $$('#notifTbody tr').forEach(tr => tr.addEventListener('click', () => {
      const id = tr.getAttribute('data-id');
      const n = rows.find(r => r.id === id);
      if (n) openNotifModal(n);
    }));
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="np-error">${escapeHtml(err.message)}</div></td></tr>`;
  }
}
function openNotifModal(n){
  $('#notifModalBody').innerHTML = `
    <div class="np-grid-2">
      <div class="np-field"><div class="np-field__label">When</div><div>${escapeHtml(fmtDateTime(n.createdAt))}</div></div>
      <div class="np-field"><div class="np-field__label">Status</div><div>${notifStatusBadge(n.status)}</div></div>
      <div class="np-field"><div class="np-field__label">Channel</div><div>${channelBadge(n.channel)}</div></div>
      <div class="np-field"><div class="np-field__label">Direction</div><div>${escapeHtml(n.direction || '—')}</div></div>
      <div class="np-field"><div class="np-field__label">Template</div><div>${escapeHtml(n.template || '—')}</div></div>
      <div class="np-field"><div class="np-field__label">Recipient</div><div>${escapeHtml(n.recipient || '—')}</div></div>
      <div class="np-field" style="grid-column: span 2;"><div class="np-field__label">Appointment</div><div>${escapeHtml(n.appointmentId || '—')}</div></div>
    </div>
    ${n.errorMessage ? `
      <div class="np-field">
        <div class="np-field__label">Error</div>
        <div style="background:#FEF2F2; border:1px solid #FECACA; border-radius:10px; padding:.6rem .75rem; color:#991B1B; font-family: ui-monospace, monospace; font-size:.78rem; white-space:pre-wrap;">${escapeHtml(n.errorMessage)}</div>
      </div>` : ''}
    ${n.payload ? `
      <div class="np-field">
        <div class="np-field__label">Payload</div>
        <pre style="background:#F8FAFC; border:1px solid var(--np-border); border-radius:10px; padding:.7rem; font-size:.75rem; max-height: 320px; overflow:auto;">${escapeHtml(JSON.stringify(n.payload, null, 2))}</pre>
      </div>` : ''}
  `;
  $('#notifModal').classList.remove('hidden');
}
function closeNotifModal(){ $('#notifModal').classList.add('hidden'); }

$('#refreshNotifs').addEventListener('click', loadNotifications);
$('#applyNotifFilters').addEventListener('click', loadNotifications);
$('#clearNotifFilters').addEventListener('click', () => {
  ['notifStatus','notifChannel','notifAudience','notifTemplate','notifFrom','notifTo','notifSearch'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  renderNotifTemplateOptions();
  loadNotifications();
});
const __audSel = document.getElementById('notifAudience');
if (__audSel) __audSel.addEventListener('change', () => { renderNotifTemplateOptions(); loadNotifications(); });
$('#notifSearch').addEventListener('input', () => {
  clearTimeout(window.__notifSearchTimer);
  window.__notifSearchTimer = setTimeout(loadNotifications, 280);
});

/* =====================================================================
   SETTINGS — password change
   ===================================================================== */
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

/* =====================================================================
   BOOT
   =====================================================================
   Two important properties of this boot flow:
     1. We ALWAYS start by making sure the dashboard is hidden and the
        login screen is the source of truth. The HTML already has these
        classes, but a defensive reset costs nothing and protects against
        any future tweak to the markup.
     2. We only call showDashboard() once we know the token resolves to a
        valid ADMIN. Any failure path drops back to the login screen via
        showLogin() (which also clears the stale token), so the user is
        never stranded on an empty shell.
   ===================================================================== */
async function showDashboard() {
  $('#loginScreen').classList.add('hidden');
  $('#dashboard').classList.remove('hidden');
  try {
    const me = await api('/auth/me');
    const u = (me && me.user) || me; // backend returns {role, user:{...}}
    if (u && u.name){
      $('#adminName').textContent = u.name;
      $('#adminInitials').textContent = u.name.split(/\s+/).map(s=>s[0]).slice(0,2).join('').toUpperCase();
    }
  } catch(e) {
    // If /auth/me fails with 401, api() has already cleared the token and
    // called showLogin(); just bail out of dashboard mounting.
    if (e && e.status === 401) return;
  }
  setupSidebar();
  setupProfileMenu();
  setView('dashboardView');

  // Now that we are definitely authenticated, refresh the pending-
  // settlements sidebar badge. This replaces the unsafe global timer in
  // finance.js that used to fire on every page load (including the login
  // screen) and caused the post-logout 401 reload loop.
  if (window.Finance && typeof window.Finance.refreshPendingBadge === 'function') {
    window.Finance.refreshPendingBadge();
  }
}

(async () => {
  // Defensive: enforce initial visibility regardless of any classList drift.
  $('#dashboard').classList.add('hidden');
  $('#loginScreen').classList.add('hidden');

  if (TOKEN) {
    try {
      const me = await api('/auth/me');
      if (me && me.role === 'ADMIN') return showDashboard();
      // Token resolves but it is not an admin — clear and fall through.
      localStorage.removeItem('np_admin_token');
      TOKEN = null;
    } catch {
      // api() already cleared the token (real expiry) or threw with no
      // token attached (race). Either way, fall through to login screen.
    }
  }
  showLogin();
})();

/* =====================================================================
   KYC — Admin-managed onboarding documents (add/edit doctor modal)
   ===================================================================== */

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
  const statusEl = $('#' + elId);
  const viewEl   = $('#' + viewElId);
  if (!statusEl || !viewEl) return;
  if (url) {
    statusEl.textContent = '— uploaded ✓';
    statusEl.style.color = '#0F8A4F';
    viewEl.href = url;
    viewEl.classList.remove('hidden');
  } else {
    statusEl.textContent = '— not uploaded';
    statusEl.style.color = '';
    viewEl.classList.add('hidden');
    viewEl.removeAttribute('href');
  }
}

async function loadKycForDoctor(doctorId){
  __currentKycDoctorId = doctorId;
  const panel = $('#doctorKycPanel');
  const hint  = $('#kycCreateHint');
  const upload = $('#kycUploadBlock');
  const verify = $('#kycVerifyBlock');
  const rejBox = $('#kycRejectionBox');
  const badge  = $('#kycStatusBadge');
  const verifiedAt = $('#kycVerifiedAt');

  // Reset
  setKycFieldStatus('kycAadhaarStatus', 'kycAadhaarView', null);
  setKycFieldStatus('kycPanStatus',     'kycPanView',     null);
  setKycFieldStatus('kycChequeStatus',  'kycChequeView',  null);
  setKycFieldStatus('kycMedCertStatus', 'kycMedCertView', null);
  rejBox.classList.add('hidden');
  $('#kycRejectionText').textContent = '';
  verifiedAt.textContent = '';

  if (!doctorId){
    // Create mode — no doctor yet
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

  // Status badge
  const bEl = $('#kycStatusBadge');
  if (bEl) bEl.outerHTML = kycBadge(kyc.kycStatus).replace('<span ', '<span id="kycStatusBadge" ');

  // File status rows
  setKycFieldStatus('kycAadhaarStatus', 'kycAadhaarView', kyc.aadhaarUrl);
  setKycFieldStatus('kycPanStatus',     'kycPanView',     kyc.panUrl);
  setKycFieldStatus('kycChequeStatus',  'kycChequeView',  kyc.cancelledChequeUrl);
  setKycFieldStatus('kycMedCertStatus', 'kycMedCertView', kyc.medicalRegCertUrl);

  // Rejection reason
  if (kyc.kycStatus === 'REJECTED' && kyc.rejectionReason){
    rejBox.classList.remove('hidden');
    $('#kycRejectionText').textContent = kyc.rejectionReason;
  }

  // Verify/Reject controls — show when at least one file is on record
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

    // Clear the file inputs and reload status
    ['aadhaar','pan','cancelledCheque','medicalRegCert'].forEach(name => {
      const input = f.querySelector(`input[type="file"][name="${name}"]`);
      if (input) input.value = '';
    });

    alert('KYC documents uploaded.');
    await loadKycForDoctor(__currentKycDoctorId);
    // Refresh card badges in the background
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
    const reason = prompt('Rejection reason (required):', '');
    if (!reason || !reason.trim()){
      alert('Rejection reason is required.');
      return;
    }
    body.rejectionReason = reason.trim();
  } else if (targetStatus === 'VERIFIED'){
    if (!confirm('Mark this doctor\'s KYC as VERIFIED? This will allow settlement generation.')) return;
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