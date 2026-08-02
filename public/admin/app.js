

const API = '/api';
let TOKEN = localStorage.getItem('np_admin_token');

const $  = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => Array.from(root.querySelectorAll(s));

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
function deltaTag(curr, prev){
  const diff = curr - prev;
  if (diff > 0) return `<div class="np-kpi__delta np-kpi__delta--up">▲ ${diff} vs yesterday</div>`;
  if (diff < 0) return `<div class="np-kpi__delta np-kpi__delta--down">▼ ${Math.abs(diff)} vs yesterday</div>`;
  return `<div class="np-kpi__delta np-kpi__delta--flat">— same as yesterday</div>`;
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
  notifView:       { title:'Notification Logs',  sub:'Audit WhatsApp & email deliveries' },
  settingsView:    { title:'Settings',           sub:'Account management' }
};
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

async function loadDashboard() {
  try {
    if (typeof NPSkeleton !== 'undefined') NPSkeleton.kpis($('#statsGrid'), 6);
  } catch (_) {}
  try {
    const a = await api('/admin/analytics');
    const cards = [
      { kind:'blue',  label:"Today's Appointments", value: a.todayAppointments,
        extra: deltaTag(a.todayAppointments, a.yesterdayAppointments),
        tip: 'Count of bookings scheduled for today across all doctors.' },
      { kind:'mint',  label:"Last 7 days",          value: a.last7Appointments,
        sub: `${a.last30Appointments} in last 30 days`,
        tip: 'Bookings made in the last 7 calendar days.' },
      { kind:'coral', label:"Total Patients",       value: a.totalPatients,
        sub: `${a.totalDoctors} active doctors`,
        tip: 'Unique patient records ever created in the system.' },
      { kind:'cream', label:"Lifetime Revenue",     value: fmtCurrency(a.totalRevenue),
        sub: `${fmtCurrency(a.revenueLast30)} in last 30 days`,
        tip: 'Sum of feeAtBooking for completed + confirmed paid appointments since launch.' },
      { kind:'violet',label:"Completion Rate",      value: a.completionRate + '%',
        sub: `${a.completedAppointments} of ${a.totalAppointments} completed`,
        tip: 'Completion Rate = completed ÷ (confirmed + completed). Higher is better.' },
      { kind:'rose',  label:"Cancellation Rate",    value: a.cancellationRate + '%',
        sub: `${a.cancelledAppointments} cancelled`,
        tip: 'Cancellation Rate = cancelled ÷ total appointments. Lower is better.' }
    ];
    $('#statsGrid').innerHTML = cards.map(c => `
      <div class="np-kpi np-kpi--${c.kind}" title="${escapeHtml(c.tip||'')}">
        <div class="np-kpi__label">${escapeHtml(c.label)}</div>
        <div class="np-kpi__value">${escapeHtml(String(c.value))}</div>
        ${c.sub ? `<div class="np-kpi__sub">${escapeHtml(c.sub)}</div>` : ''}
        ${c.extra || ''}
      </div>`).join('');

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

    const fail = a.notificationsFailed || 0;
    const badge = $('#navBadgeFailed');
    if (badge) {
      if (fail > 0) { badge.textContent = fail; badge.classList.remove('hidden'); }
      else { badge.classList.add('hidden'); }
    }

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
            <div class="np-appt-row__name">${escapeHtml(a.patient.name)}</div>
            <div class="np-appt-row__assign">${drNameHtml(a.doctor.name)}</div>
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
    return `<img class="np-doc-card__avatar" src="${escapeHtml(d.photoUrl)}" alt="${drNameHtml(d.name)}"/>`;
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
  loadKycForDoctor(id);
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
    phone: (raw.phone || '').replace(/\D/g, '').replace(/^91/, ''),
    specialization: (raw.specialization || '').trim() || undefined,
    qualification: (raw.qualification || '').trim() || undefined,
    experience: raw.experience === '' ? 0 : Number(raw.experience),
    bio: (raw.bio || '').trim() || undefined,
    consultationModes: raw.consultationModes || 'BOTH',
    onlineConsultFee: raw.onlineConsultFee === '' ? 0 : Number(raw.onlineConsultFee),
    physicalConsultFee: raw.physicalConsultFee === '' ? 0 : Number(raw.physicalConsultFee)
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
      const ttl = res.inviteExpiresInMinutes ? ` (expires in ${res.inviteExpiresInMinutes} min)` : '';
      if (res.invitePreviewUrl) {
        const status = res.inviteSent
          ? 'Doctor created — invite email sent.'
          : 'Doctor created — email delivery NOT confirmed.';
        if (typeof NPToast !== 'undefined') {
          NPToast.success(status + ' Click "Copy link" to share' + ttl + '.', {
            title: 'Invite link ready',
            duration: 15000,
            action: { label: 'Copy link', onClick: () => {
              try {
                navigator.clipboard.writeText(res.invitePreviewUrl);
                NPToast.info('Invite link copied to clipboard');
              } catch (_) {
                NPModal.alert({ title:'Invite link', message: res.invitePreviewUrl });
              }
            } }
          });
        } else {
          alert(status + '\n\nInvite link' + ttl + ':\n' + res.invitePreviewUrl);
        }
      } else {
        if (typeof NPToast !== 'undefined') NPToast.success('Doctor created and invite email sent.');
        else alert('Doctor created and invite email sent.');
      }
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
    <td data-label="When">${escapeHtml(fmtDateTime(n.createdAt))}</td>
    <td data-label="Channel">${channelBadge(n.channel)}</td>
    <td data-label="Template" title="${escapeHtml(n.template || '')}">${escapeHtml(__notifPrettyName(n.template) || '')}</td>
    <td data-label="Recipient" style="overflow-wrap:anywhere;">${escapeHtml(n.recipient || '')}</td>
    <td data-label="Status">${notifStatusBadge(n.status)}${n.direction ? ` <span class="np-badge np-badge--slate" style="margin-left:.25rem;">${escapeHtml(n.direction)}</span>` : ''}</td>
    ${n.errorMessage
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
function openNotifModal(n){
  $('#notifModalBody').innerHTML = `
    <div class="np-grid-2">
      <div class="np-field"><div class="np-field__label">When</div><div>${escapeHtml(fmtDateTime(n.createdAt))}</div></div>
      <div class="np-field"><div class="np-field__label">Status</div><div>${notifStatusBadge(n.status)}</div></div>
      <div class="np-field"><div class="np-field__label">Channel</div><div>${channelBadge(n.channel)}</div></div>
      <div class="np-field"><div class="np-field__label">Direction</div><div>${escapeHtml(n.direction || '—')}</div></div>
      <div class="np-field"><div class="np-field__label">Template</div><div title="${escapeHtml(n.template || '')}">${escapeHtml(__notifPrettyName(n.template) || '—')}${n.template ? `<div class="np-mut" style="font-size:.7rem; margin-top:.15rem; font-family: ui-monospace, monospace;">${escapeHtml(n.template)}</div>` : ''}</div></div>
      <div class="np-field"><div class="np-field__label">Recipient</div><div>${escapeHtml(n.recipient || '—')}</div></div>
      <div class="np-field" style="grid-column: span 2;"><div class="np-field__label">Appointment</div><div>${escapeHtml(n.appointmentId || '—')}</div></div>
    </div>
    ${n.errorMessage ? `
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

$('#refreshNotifs').addEventListener('click', loadNotifications);
$('#notifFilters').addEventListener('submit', (event) => { event.preventDefault(); loadNotifications(); });
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
      $('#adminName').textContent = u.name;
      $('#adminInitials').textContent = u.name.split(/\s+/).map(s=>s[0]).slice(0,2).join('').toUpperCase();
    }
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
