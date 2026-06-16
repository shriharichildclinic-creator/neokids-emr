/* =====================================================================
   NeoKidsPro Admin Panel v2.0
   - FIX 4: Modernized dashboard with rich KPIs + 14-day chart
   - FIX 5: Appointment table with full filters (search, status, type,
            payment, doctor, date range)
   - FIX 6: Doctor insights drawer (completion %, revenue, sparkline)
   - FIX 7: Notification Logs view with filters & detail modal
   - 100% backwards compatible: existing endpoints unchanged
   ===================================================================== */

const API = '/api';
let TOKEN = localStorage.getItem('np_admin_token');

const $  = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => Array.from(root.querySelectorAll(s));

let __doctorsCache = [];
let __apptsCache = [];

/* -------- API helper -------- */
async function api(path, opts = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(TOKEN && { Authorization: 'Bearer ' + TOKEN }),
    ...(opts.headers || {})
  };
  const r = await fetch(API + path, { ...opts, headers });
  let data = null;
  try { data = await r.json(); } catch(_) {}
  if (r.status === 401) {
    localStorage.removeItem('np_admin_token');
    TOKEN = null;
    location.reload();
    throw new Error('Session expired');
  }
  if (!r.ok) throw new Error((data && (data.error || data.message)) || ('HTTP ' + r.status));
  return data;
}

/* -------- Utils -------- */
function escapeHtml(s){
  return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
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
    const r = await fetch(API + '/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('#email').value, password: $('#password').value })
    });
    const data = await r.json();
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
function logout() {
  localStorage.removeItem('np_admin_token');
  TOKEN = null;
  location.reload();
}

/* =====================================================================
   SHELL
   ===================================================================== */
const VIEW_META = {
  dashboardView: { title:'Dashboard',        sub:'Overview of your clinic' },
  doctorsView:   { title:'Doctors',          sub:'Manage clinic doctors and their performance' },
  apptsView:     { title:'Appointments',     sub:'All bookings across the clinic' },
  notifView:     { title:'Notification Logs',sub:'Audit WhatsApp & email deliveries' },
  settingsView:  { title:'Settings',         sub:'Account management' }
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
}

function setupSidebar(){
  const sidebar = $('#sidebar'); const backdrop = $('#sidebarBackdrop'); const toggle = $('#sidebarToggle');
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
            <div class="np-appt-row__name">${escapeHtml(a.patient.name)} → Dr. ${escapeHtml(a.doctor.name)}</div>
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
    __doctorsCache = docs;
    renderDoctors();
  } catch (err) {
    $('#doctorsGrid').innerHTML = `<div class="np-error">${escapeHtml(err.message)}</div>`;
  }
}
function renderDoctors(){
  const q = ($('#docSearch').value || '').trim().toLowerCase();
  const av = $('#docFilterAvail').value;
  let docs = __doctorsCache.slice();
  if (av === 'active')   docs = docs.filter(d => d.isAvailable);
  if (av === 'inactive') docs = docs.filter(d => !d.isAvailable);
  if (q){
    docs = docs.filter(d => [d.name, d.email, d.phone, d.clinicName, d.specialization]
      .some(v => v && String(v).toLowerCase().includes(q)));
  }
  if (!docs.length){
    $('#doctorsGrid').innerHTML = `<div class="np-empty" style="grid-column:1/-1;">
      <div class="np-empty__title">No doctors match</div>
      <div class="np-empty__sub">Try clearing the search or adding a doctor.</div>
    </div>`;
    return;
  }
  $('#doctorsGrid').innerHTML = docs.map(d => `
    <div class="np-doc-card" data-id="${escapeHtml(d.id)}">
      <div class="np-doc-card__head">
        ${d.photoUrl ? `<img class="np-doc-card__avatar" src="${escapeHtml(d.photoUrl)}" alt="Dr. ${escapeHtml(d.name)}"/>`
                    : `<div class="np-doc-card__avatar">${escapeHtml((d.name||'D').split(/\s+/).map(s=>s[0]).slice(0,2).join('').toUpperCase())}</div>`}
        <div style="flex:1; min-width:0;">
          <div class="np-doc-card__name">Dr. ${escapeHtml(d.name)}</div>
          <div class="np-doc-card__role">${escapeHtml(d.specialization || 'Pediatrician')} · ${escapeHtml((d.qualification||'').toString())}</div>
          <div class="np-doc-card__role">${escapeHtml(d.email || '')}</div>
          <div class="np-doc-card__role">+91 ${escapeHtml(d.phone || '')}</div>
        </div>
        ${d.isAvailable
          ? `<span class="np-badge np-badge--green"><span class="np-badge__dot"></span>Active</span>`
          : `<span class="np-badge np-badge--slate"><span class="np-badge__dot"></span>Inactive</span>`}
      </div>
      <div class="np-doc-card__stats">
        <div><span class="np-mut">Online:</span> <b>${fmtCurrency(d.onlineConsultFee)}</b></div>
        <div><span class="np-mut">In-person:</span> <b>${fmtCurrency(d.physicalConsultFee)}</b></div>
        <div><span class="np-mut">Consults:</span> <b>${d.consults || 0}</b></div>
        <div><span class="np-mut">Revenue:</span> <b>${fmtCurrency(d.revenue)}</b></div>
      </div>
      ${d.clinicName ? `<div class="np-mut" style="font-size:.8rem;">🏥 ${escapeHtml(d.clinicName)}</div>` : ''}
      <div style="font-size:.72rem;" class="${d.mustChangePassword ? '' : 'np-mut'}">
        ${d.mustChangePassword
          ? `<span style="color:#92400E;">⚠ Doctor still needs to set their password.</span>`
          : 'Password set.'}
      </div>
      <div class="np-doc-card__actions">
        <button class="np-btn np-btn--primary np-btn--sm" type="button" onclick="openInsights('${escapeHtml(d.id)}')">Insights</button>
        <button class="np-btn np-btn--sm" type="button" onclick="openEditDoctor('${escapeHtml(d.id)}')">Edit</button>
        <button class="np-btn np-btn--ghost np-btn--sm" type="button" onclick="toggleDoctor('${escapeHtml(d.id)}', ${!d.isAvailable})">${d.isAvailable ? 'Deactivate' : 'Activate'}</button>
        <button class="np-btn np-btn--ghost np-btn--sm" type="button" style="color:#B91C1C;" onclick="hardDeleteDoctor('${escapeHtml(d.id)}','${escapeHtml((d.name||'').replace(/'/g,"\\'"))}')">🗑</button>
      </div>
    </div>`).join('');
}
async function toggleDoctor(id, isAvailable) {
  await api('/admin/doctors/' + id, { method: 'PUT', body: JSON.stringify({ isAvailable }) });
  loadDoctors();
}
async function hardDeleteDoctor(id, name) {
  if (!confirm(`Permanently delete Dr. ${name}? This is only allowed if the doctor has no appointments.`)) return;
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
  $('#doctorModal').classList.remove('hidden');
}
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
  if (!isEdit) payload.email = (raw.email || '').trim().toLowerCase();
  if (raw.password && raw.password.trim()) payload.password = raw.password;
  try {
    if (isEdit) {
      await api('/admin/doctors/' + f.dataset.id, { method: 'PUT', body: JSON.stringify(payload) });
      alert('Doctor updated.');
    } else {
      const res = await api('/admin/doctors', { method: 'POST', body: JSON.stringify(payload) });
      alert(res.invitePreviewUrl ? `Doctor created. Mock invite link: ${res.invitePreviewUrl}` : 'Doctor created and invite email sent.');
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
    $('#drawerTitle').textContent = `Dr. ${d.name}`;
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
          <div style="font-weight:700; color:var(--np-ink);">Dr. ${escapeHtml(d.name)}</div>
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
      __doctorsCache.map(d => `<option value="${escapeHtml(d.id)}">Dr. ${escapeHtml(d.name)}</option>`).join('');
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
        <td>Dr. ${escapeHtml(a.doctor.name)}<br/><span class="np-mut" style="font-size:.75rem;">${escapeHtml(a.doctor.specialization||'')}</span></td>
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
async function loadNotifTemplates(){
  try {
    const rows = await api('/admin/notifications/templates');
    const sel = $('#notifTemplate');
    const current = sel.value;
    sel.innerHTML = '<option value="">All templates</option>' +
      (rows || []).map(r => `<option value="${escapeHtml(r.template)}">${escapeHtml(r.template)}${r.channel ? ' · ' + escapeHtml(r.channel) : ''}</option>`).join('');
    sel.value = current;
  } catch(_) {}
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
  ['notifStatus','notifChannel','notifTemplate','notifFrom','notifTo','notifSearch'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  loadNotifications();
});
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
   ===================================================================== */
async function showDashboard() {
  $('#loginScreen').classList.add('hidden');
  $('#dashboard').classList.remove('hidden');
  try {
    const me = await api('/auth/me');
    if (me && me.name){
      $('#adminName').textContent = me.name;
      $('#adminInitials').textContent = me.name.split(/\s+/).map(s=>s[0]).slice(0,2).join('').toUpperCase();
    }
  } catch(_) {}
  setupSidebar();
  setupProfileMenu();
  setView('dashboardView');
}

(async () => {
  if (TOKEN) {
    try {
      const me = await api('/auth/me');
      if (me.role === 'ADMIN') return showDashboard();
    } catch {}
  }
  $('#loginScreen').classList.remove('hidden');
})();
