/* =====================================================================
   NeoKidsPro EMR — Doctor App
   Modernized UI (v2). All original IDs, form names, API calls, and JS
   hooks are preserved. Rendering uses new CSS classes for a modern look.
   ===================================================================== */

const API = '/api';
let TOKEN = localStorage.getItem('np_doctor_token');
let currentAppointment = null;
let allAppointmentsCache = [];   // for client-side search/filter
let doctorCache = null;          // for current doctor profile

const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

/* ---------------------------------------------------------------------
   API helper
   --------------------------------------------------------------------- */
async function api(path, opts={}){
  const headers = opts.headers || {};
  if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
  if (!(opts.body instanceof FormData) && opts.body && typeof opts.body === 'object'){
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(API + path, { ...opts, headers });
  let data = null;
  try { data = await res.json(); } catch(_) {}
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || ('HTTP ' + res.status);
    const err = new Error(msg); err.status = res.status; err.data = data; throw err;
  }
  return data;
}

/* ---------------------------------------------------------------------
   Utils
   --------------------------------------------------------------------- */
function fmtCurrency(n){
  const v = Number(n||0);
  if (v >= 100000) return '₹' + (v/100000).toFixed(v%100000===0?0:1) + 'L';
  if (v >= 1000)   return '₹' + (v/1000).toFixed(v%1000===0?0:1) + 'k';
  return '₹' + v.toLocaleString('en-IN');
}
function fmtDate(d){
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
}
// Bug 6 — convert 24-hour "HH:MM" to 12-hour "h:MM AM/PM"
function fmtTime(t){
  if (!t) return '';
  const m = String(t).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return String(t);
  let h = parseInt(m[1], 10);
  const min = m[2];
  if (Number.isNaN(h)) return String(t);
  const suffix = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${min} ${suffix}`;
}

/* ---------------------------------------------------------------------
   Bug 1 — Age is ALWAYS derived from DOB on the client.
   Never stored, never cached. Mirrors src/utils/date.js → calcAge().
   --------------------------------------------------------------------- */
function calcAge(dob){
  if (!dob) return '';
  const d = (dob instanceof Date) ? dob : new Date(dob);
  if (isNaN(d.getTime())) return '';
  const today = new Date();
  let years  = today.getFullYear()  - d.getFullYear();
  let months = today.getMonth()     - d.getMonth();
  if (today.getDate() < d.getDate()) months -= 1;
  if (months < 0) { years -= 1; months += 12; }
  if (years < 0) return '';
  if (years === 0) {
    // Babies: show months (or "newborn" if <1 month)
    if (months <= 0) return 'newborn';
    return `${months} mo`;
  }
  // 1-2 yrs: years + months for clinical precision
  if (years < 2) return `${years} yr ${months} mo`;
  return `${years} yrs`;
}
/* Bug 1 — longer, more readable form for modals/details pages.
   Matches the server-side PDF format. */
function calcAgeLong(dob){
  if (!dob) return '';
  const d = (dob instanceof Date) ? dob : new Date(dob);
  if (isNaN(d.getTime())) return '';
  const today = new Date();
  let years  = today.getFullYear()  - d.getFullYear();
  let months = today.getMonth()     - d.getMonth();
  if (today.getDate() < d.getDate()) months -= 1;
  if (months < 0) { years -= 1; months += 12; }
  if (years < 0) return '';
  if (years === 0) {
    if (months <= 0) return 'Newborn';
    return `${months} month${months === 1 ? '' : 's'}`;
  }
  return `${years} year${years === 1 ? '' : 's'} ${months} month${months === 1 ? '' : 's'}`;
}


function escapeHtml(s){
  return String(s==null?'':s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
function statusBadge(status){
  const map = {
    CONFIRMED:{cls:'np-badge--green', txt:'Confirmed'},
    PENDING:  {cls:'np-badge--amber', txt:'Pending'},
    COMPLETED:{cls:'np-badge--blue',  txt:'Completed'},
    CANCELLED:{cls:'np-badge--red',   txt:'Cancelled'},
    NO_SHOW:  {cls:'np-badge--slate', txt:'No-show'}
  };
  const m = map[status] || {cls:'np-badge--slate', txt: (status||'—')};
  return `<span class="np-badge ${m.cls}"><span class="np-badge__dot"></span>${m.txt}</span>`;
}
function typeBadge(type){
  if (type === 'ONLINE')  return `<span class="np-badge np-badge--mint"><span class="np-badge__dot"></span>Online</span>`;
  if (type === 'OFFLINE') return `<span class="np-badge np-badge--blue"><span class="np-badge__dot"></span>In-person</span>`;
  return '';
}
function paymentBadge(p){
  const map = {
    PAID:           {cls:'np-badge--green', txt:'Paid'},
    UNPAID:         {cls:'np-badge--amber', txt:'Unpaid'},
    REFUNDED:       {cls:'np-badge--slate', txt:'Refunded'},
    CASH_COLLECTED: {cls:'np-badge--green', txt:'Cash collected'}
  };
  const m = map[p]; if (!m) return '';
  return `<span class="np-badge ${m.cls}"><span class="np-badge__dot"></span>${m.txt}</span>`;
}

/* =====================================================================
   LOGIN
   ===================================================================== */
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#loginError');
  err.classList.add('hidden');
  try {
    const data = await api('/auth/login', { method:'POST', body:{
      email: $('#email').value.trim(),
      password: $('#password').value
    }});
    if (!data || !data.token) throw new Error('Invalid response');
    if (data.role && data.role !== 'DOCTOR') throw new Error('Not a doctor account');
    TOKEN = data.token;
    localStorage.setItem('np_doctor_token', TOKEN);
    init();
  } catch (ex){
    err.textContent = ex.message || 'Login failed';
    err.classList.remove('hidden');
  }
});

function forgotPassword(){
  const email = ($('#email').value || '').trim();
  if (!email){ alert('Enter your email first, then click Forgot password.'); return; }
  api('/auth/forgot-password', { method:'POST', body:{ email } })
    .then(()=>alert('If that email exists, a reset link has been sent.'))
    .catch(ex=>alert(ex.message || 'Request failed'));
}

function logout(){
  localStorage.removeItem('np_doctor_token');
  TOKEN = null;
  location.reload();
}

/* =====================================================================
   INIT
   ===================================================================== */
async function init(){
  $('#loginScreen').classList.add('hidden');
  $('#dashboard').classList.remove('hidden');

  try {
    const me = await api('/doctor/me');
    doctorCache = me;
    renderDoctorHeader(me);
    populateAvailability(me);
    populateClinic(me);
    populateFees(me);
  } catch (ex){
    if (ex.status === 401){ logout(); return; }
    console.warn('doctor/me failed', ex);
  }

  // Activate default tab (Dashboard)
  setActiveTab('dashboardTab');
  loadStats();
  loadDashSnapshot();

  // Sidebar / header interactions
  setupSidebar();
  setupProfileMenu();
  setupTabs();
  setupSearchFilters();
  setupForms();
setupRescheduleModal();
setupCancelModal();
}

function renderDoctorHeader(d){
  const name = d.name ? ('Dr. ' + d.name) : 'Doctor';
  $('#docName').textContent = name;
  $('#docSpec').textContent = d.specialization || 'Pediatrician';

  const initials = (d.name || 'D').split(/\s+/).map(s=>s[0]).slice(0,2).join('').toUpperCase();

  if (d.photoUrl){
    $('#docPhotoTop').innerHTML = `<img src="${escapeHtml(d.photoUrl)}" alt="${escapeHtml(name)}">`;
    const large = $('#docPhotoLarge');
    if (large){
      large.innerHTML = `<img src="${escapeHtml(d.photoUrl)}" alt="${escapeHtml(name)}">`;
    }
  } else {
    $('#docPhotoTop').innerHTML = `<span>${escapeHtml(initials)}</span>`;
    const large = $('#docPhotoLarge');
    if (large){
      large.innerHTML = `<span id="docPhotoPlaceholder">${escapeHtml(initials)}</span>`;
    }
  }
}

/* =====================================================================
   SIDEBAR / DRAWER
   ===================================================================== */
function setupSidebar(){
  const sidebar = $('#sidebar');
  const backdrop = $('#sidebarBackdrop');
  const toggle = $('#sidebarToggle');
  function open(){ sidebar.classList.add('is-open'); backdrop.classList.add('is-open'); }
  function close(){ sidebar.classList.remove('is-open'); backdrop.classList.remove('is-open'); }
  toggle.addEventListener('click', () => sidebar.classList.contains('is-open') ? close() : open());
  backdrop.addEventListener('click', close);
  // Auto-close on nav click (mobile)
  $$('.np-nav-item').forEach(b => b.addEventListener('click', () => {
    if (window.matchMedia('(max-width:1023px)').matches) close();
  }));
  window.addEventListener('resize', () => {
    if (window.innerWidth > 1023) close();
  });
}

/* =====================================================================
   PROFILE DROPDOWN
   ===================================================================== */
function setupProfileMenu(){
  const trigger = $('#profileTrigger');
  const menu = $('#profileDropdown');
  function close(){ menu.classList.remove('is-open'); trigger.setAttribute('aria-expanded','false'); }
  function open(){ menu.classList.add('is-open'); trigger.setAttribute('aria-expanded','true'); }
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.contains('is-open') ? close() : open();
  });
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && !trigger.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  // Menu items that navigate to Settings tab
  $$('#profileDropdown [data-go]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-go');
      const sectionKey = btn.getAttribute('data-section');
      setActiveTab(tab);
      close();
      if (sectionKey === 'password'){
        const el = document.getElementById('setting-password');
        if (el) el.scrollIntoView({ behavior:'smooth', block:'start' });
      } else if (sectionKey === 'profile'){
        const el = document.getElementById('setting-profile');
        if (el) el.scrollIntoView({ behavior:'smooth', block:'start' });
      }
    });
  });
}

/* =====================================================================
   TABS
   ===================================================================== */
const TAB_META = {
  dashboardTab: { title:'Dashboard',     sub:"Welcome back — here's what's happening today." },
  waitingTab:   { title:'Waiting Room',  sub:'Patients currently waiting to be seen' },
  allTab:       { title:'Appointments',  sub:'Search and manage all your appointments' },
  settingsTab:  { title:'Settings',      sub:'Manage your profile, availability, and clinic' }
};

function setActiveTab(tabId){
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
  $$('.tab-pane').forEach(p => p.classList.toggle('hidden', p.id !== tabId));
  const meta = TAB_META[tabId];
  if (meta){
    $('#pageTitle').textContent = meta.title;
    $('#pageSubtitle').textContent = meta.sub;
  }
  // Lazy-load data per tab
  if (tabId === 'waitingTab') loadWaiting();
  else if (tabId === 'allTab') loadAll();
  else if (tabId === 'settingsTab') loadSettings();
  else if (tabId === 'dashboardTab'){ loadStats(); loadDashSnapshot(); }
}

function setupTabs(){
  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
  });
  const refresh = $('#refreshWaiting');
  if (refresh) refresh.addEventListener('click', () => loadWaiting());
}

/* =====================================================================
   STATS / KPIs
   ===================================================================== */
async function loadStats(){
  try {
    const s = await api('/doctor/stats');
    const today = Number(s.todayAppointments || 0);
    const done  = Number(s.completedToday || 0);
    const total = Number(s.totalConsults || 0);
    const rev   = Number(s.totalRevenue || 0);
    $('#statsBar').innerHTML = `
      <div class="np-kpi np-kpi--blue">
        <div class="np-kpi__icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        </div>
        <div class="np-kpi__label">Today's Patients</div>
        <div class="np-kpi__value">${today}</div>
        <div class="np-kpi__sub">${done} completed so far</div>
      </div>
      <div class="np-kpi np-kpi--mint">
        <div class="np-kpi__icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
        </div>
        <div class="np-kpi__label">Total Consults</div>
        <div class="np-kpi__value">${total}</div>
        <div class="np-kpi__sub">All-time consultations</div>
      </div>
      <div class="np-kpi np-kpi--coral">
        <div class="np-kpi__icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        <div class="np-kpi__label">Completed Today</div>
        <div class="np-kpi__value">${done}</div>
        <div class="np-kpi__sub">Out of ${today} scheduled</div>
      </div>
      <div class="np-kpi np-kpi--cream">
        <div class="np-kpi__icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
        </div>
        <div class="np-kpi__label">Revenue</div>
        <div class="np-kpi__value">${fmtCurrency(rev)}</div>
        <div class="np-kpi__sub">Lifetime</div>
      </div>
    `;
  } catch (ex){
    console.warn('stats failed', ex);
    $('#statsBar').innerHTML = '';
  }
}

async function loadDashSnapshot(){
  const el = $('#dashSnapshot');
  if (!el) return;
  try {
    const list = await api('/doctor/waiting-room');
    if (!list || !list.length){
      el.innerHTML = emptyState('No patients waiting', 'Your waiting room is empty right now.');
      return;
    }
    const first5 = list.slice(0,5);
    el.innerHTML = `<div class="np-appt-list">${first5.map(apptCard).join('')}</div>`;
  } catch (ex){
    el.innerHTML = emptyState('Could not load appointments', ex.message || 'Try refreshing.');
  }
}

function emptyState(title, sub){
  return `
    <div class="np-empty">
      <div class="np-empty__icon">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      </div>
      <div class="np-empty__title">${escapeHtml(title)}</div>
      <div class="np-empty__sub">${escapeHtml(sub||'')}</div>
    </div>`;
}

/* =====================================================================
   WAITING ROOM
   ===================================================================== */
async function loadWaiting(){
  const list = $('#waitingList');
  list.innerHTML = '';
  try {
    const data = await api('/doctor/waiting-room');
    if (!data || !data.length){
      list.innerHTML = emptyState('All clear', 'No patients are waiting right now.');
      return;
    }
    list.innerHTML = data.map(apptCard).join('');
  } catch (ex){
    list.innerHTML = emptyState('Could not load waiting room', ex.message || 'Try again later.');
  }
}

/* =====================================================================
   ALL APPOINTMENTS (search + filter + sort)
   ===================================================================== */
async function loadAll(){
  const list = $('#allList');
  list.innerHTML = '';
  try {
    const data = await api('/doctor/appointments');
    allAppointmentsCache = Array.isArray(data) ? data : [];
    renderAllAppointments();
  } catch (ex){
    list.innerHTML = emptyState('Could not load appointments', ex.message || 'Try again later.');
  }
}

function renderAllAppointments(){
  const search = ($('#apptSearch').value || '').trim().toLowerCase();
  const status = $('#apptStatusFilter').value;
  const type   = $('#apptTypeFilter').value;
  const sort   = $('#apptSort').value;

  let arr = allAppointmentsCache.slice();

  if (status) arr = arr.filter(a => a.status === status);
  if (type)   arr = arr.filter(a => a.consultationType === type);
  if (search) {
    arr = arr.filter(a => {
      const p = a.patient || {};
      return [
        p.name, p.phone, p.email, a.primaryProblem
      ].some(v => v && String(v).toLowerCase().includes(search));
    });
  }

  arr.sort((a,b) => {
    const ad = new Date(a.date + 'T' + (a.startTime||'00:00')).getTime();
    const bd = new Date(b.date + 'T' + (b.startTime||'00:00')).getTime();
    return sort === 'date_asc' ? (ad - bd) : (bd - ad);
  });

  const list = $('#allList');
  if (!arr.length){
    list.innerHTML = emptyState('No matches', 'Try clearing filters or changing the search term.');
    return;
  }
  list.innerHTML = arr.map(apptCard).join('');
}

function setupSearchFilters(){
  ['apptSearch','apptStatusFilter','apptTypeFilter','apptSort'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const ev = (el.tagName === 'INPUT') ? 'input' : 'change';
    el.addEventListener(ev, () => renderAllAppointments());
  });
}

/* =====================================================================
   APPOINTMENT CARD
   ===================================================================== */
function apptCard(a){
  const p = a.patient || {};
const timeMain = fmtTime(a.startTime) || '—';
  const dt = fmtDate(a.date);
  const meet = (a.consultationType === 'ONLINE' && a.meetLink)
    ? `<a class="np-btn np-btn--success np-btn--sm" href="${escapeHtml(a.meetLink)}" target="_blank" rel="noopener">
         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
         Join
       </a>` : '';
  const canCancel = !['CANCELLED','COMPLETED'].includes(a.status);
  return `
  <article class="np-appt" data-id="${escapeHtml(a.id)}">
    <div class="np-appt__time">
      <div class="np-appt__time-h">${escapeHtml(timeMain)}</div>
      <div class="np-appt__time-d">${escapeHtml(dt)}</div>
    </div>
    <div class="np-appt__body">
            <!-- Bug 7 — name on its own line, badges on a second line, both responsive -->
<div class="np-appt__namerow">
  <span class="np-appt__name">${escapeHtml(p.name || 'Patient')}</span>
  ${p.dateOfBirth ? `<span class="np-appt__age" title="DOB: ${escapeHtml(fmtDate(p.dateOfBirth))}">${escapeHtml(calcAge(p.dateOfBirth))}</span>` : ''}
</div>
<div class="np-appt__badges">
  ${statusBadge(a.status)}
  ${typeBadge(a.consultationType)}
  ${paymentBadge(a.paymentStatus)}
</div>
<div class="np-appt__meta">
  ${p.phone ? `<span>📞 ${escapeHtml(p.phone)}</span>` : ''}
  ${p.gender ? `<span>${escapeHtml(p.gender === 'MALE' ? '♂ Male' : p.gender === 'FEMALE' ? '♀ Female' : p.gender)}</span>` : ''}
  ${a.feeAtBooking != null ? `<span>${fmtCurrency(a.feeAtBooking)}</span>` : ''}
</div>

      ${a.primaryProblem ? `<div class="np-appt__problem">${escapeHtml(a.primaryProblem)}</div>` : ''}
    </div>
    <div class="np-appt__actions">
      ${meet}
      <button class="np-btn np-btn--sm" type="button" onclick="openPatient('${escapeHtml(a.id)}')">
        Open
      </button>
      ${a.status !== 'COMPLETED' ? `
        <button class="np-btn np-btn--sm" type="button" onclick="toggleComplete('${escapeHtml(a.id)}')">
          Complete
        </button>` : ''}
      ${canCancel ? `
        <button class="np-btn np-btn--ghost np-btn--sm" type="button" onclick="openReschedule('${escapeHtml(a.id)}','${escapeHtml(a.consultationType||'OFFLINE')}')">
          Reschedule
        </button>
        <button class="np-btn np-btn--danger np-btn--sm" type="button" onclick="cancelAppt('${escapeHtml(a.id)}')">
          Cancel
        </button>` : ''}
    </div>
  </article>`;
}

/* =====================================================================
   PATIENT MODAL
   ===================================================================== */
async function openPatient(id){
  try {
    const data = await api('/doctor/appointments/' + encodeURIComponent(id));
    const a = data.appointment || data;
    currentAppointment = a;
    const p = a.patient || {};

    $('#patientDetail').innerHTML = `
      <div class="np-row" style="gap:.6rem; margin-bottom:.5rem;">
        ${statusBadge(a.status)} ${typeBadge(a.consultationType)} ${paymentBadge(a.paymentStatus)}
      </div>
   
<div style="font-size:1.15rem; font-weight:700; color:var(--np-ink);">${escapeHtml(p.name || 'Patient')}</div>
<div class="np-mut" style="font-size:.85rem; margin-bottom:.75rem;">
  ${p.dateOfBirth
      ? `<b style="color:var(--np-ink);">${escapeHtml(calcAgeLong(p.dateOfBirth))}</b>
         <span class="np-mut"> · DOB ${escapeHtml(fmtDate(p.dateOfBirth))}</span>`
      : '<span class="np-mut">DOB not recorded</span>'}
  ${p.gender ? ' · ' + escapeHtml(p.gender) : ''}
</div>

      <div class="np-grid-2" style="margin-bottom:1rem;">
        <div class="np-field">
          <div class="np-field__label">Date & Time</div>
          <div>${fmtDate(a.date)} · ${fmtTime(a.startTime)}${a.endTime ? ' – ' + fmtTime(a.endTime) : ''}</div>
        </div>
        <div class="np-field">
          <div class="np-field__label">Fee</div>
          <div>${fmtCurrency(a.feeAtBooking)}</div>
        </div>
        ${p.phone ? `
        <div class="np-field"><div class="np-field__label">Phone</div><div>${escapeHtml(p.phone)}</div></div>` : ''}
        ${p.email ? `
        <div class="np-field"><div class="np-field__label">Email</div><div>${escapeHtml(p.email)}</div></div>` : ''}
        ${p.parentName ? `
        <div class="np-field"><div class="np-field__label">Parent / Guardian</div><div>${escapeHtml(p.parentName)}</div></div>` : ''}
        ${a.meetLink ? `
        <div class="np-field"><div class="np-field__label">Meet Link</div>
          <div><a href="${escapeHtml(a.meetLink)}" target="_blank" rel="noopener" style="color:var(--np-primary);">Join consultation</a></div>
        </div>` : ''}
      </div>

      ${a.primaryProblem ? `
        <div class="np-field">
          <div class="np-field__label">Primary problem</div>
          <div style="background:var(--np-surface); padding:.7rem .85rem; border-radius:10px; border:1px solid var(--np-border); font-size:.9rem;">
            ${escapeHtml(a.primaryProblem)}
          </div>
        </div>` : ''}
    `;

    // Show Rx form for active appts
    const rxForm = $('#rxForm');
    if (['CONFIRMED','PENDING','COMPLETED'].includes(a.status)){
      rxForm.classList.remove('hidden');
      const tbody = $('#medsList');
      tbody.innerHTML = '';
      addMedRow();
      // Pre-fill if existing prescription
      if (data.prescription){
        const r = data.prescription;
        rxForm.diagnosis.value = r.diagnosis || '';
        rxForm.advice.value    = r.advice || '';
        if (r.vitals){
          rxForm.vitalsWeight.value      = r.vitals.weight || '';
          rxForm.vitalsTemperature.value = r.vitals.temperature || '';
          rxForm.vitalsHeartRate.value   = r.vitals.heartRate || '';
        }
        if (Array.isArray(r.medications) && r.medications.length){
          tbody.innerHTML = '';
          r.medications.forEach(m => addMedRow(m));
        }
      }
    } else {
      rxForm.classList.add('hidden');
    }

    $('#patientModal').classList.remove('hidden');
  } catch (ex){
    alert(ex.message || 'Could not open patient');
  }
}

function closePatientModal(){
  $('#patientModal').classList.add('hidden');
  currentAppointment = null;
}

function addMedRow(prefill){
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input class="med-name"  placeholder="e.g. Paracetamol 250mg syrup" value="${escapeHtml(prefill?.name||'')}"></td>
    <td><input class="med-dose"  placeholder="2.5 ml"                          value="${escapeHtml(prefill?.dosage||'')}"></td>
    <td><input class="med-freq"  placeholder="TDS / BD / SOS"                  value="${escapeHtml(prefill?.frequency||'')}"></td>
    <td><input class="med-dur"   placeholder="3 days"                          value="${escapeHtml(prefill?.duration||'')}"></td>
    <td><input class="med-inst"  placeholder="After food"                      value="${escapeHtml(prefill?.instructions||'')}"></td>
    <td><button type="button" class="np-remove-row" title="Remove">×</button></td>
  `;
  tr.querySelector('.np-remove-row').addEventListener('click', () => tr.remove());
  $('#medsList').appendChild(tr);
}

/* Prescription submit (preserves rxForm submit semantics) */
/* Prescription submit — fixed URL + payload shape (Bug 2) */
document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'rxForm') return;
  e.preventDefault();
  if (!currentAppointment) return;

  const meds = $$('#medsList tr').map(tr => ({
    name:         tr.querySelector('.med-name').value.trim(),
    dose:         tr.querySelector('.med-dose').value.trim(),   // schema key: dose (NOT dosage)
    frequency:    tr.querySelector('.med-freq').value.trim(),
    duration:     tr.querySelector('.med-dur').value.trim(),
    instructions: tr.querySelector('.med-inst').value.trim() || undefined
  })).filter(m => m.name && m.dose && m.frequency && m.duration);

  if (!meds.length) {
    alert('Please add at least one medication with name, dose, frequency, and duration.');
    return;
  }
  const chiefComplaint = (e.target.chiefComplaint?.value || '').trim();
  const diagnosis      = (e.target.diagnosis.value || '').trim();
  if (chiefComplaint.length < 2) { alert('Please enter the chief complaint.'); return; }
  if (diagnosis.length < 2)      { alert('Please enter a diagnosis.'); return; }

  const body = {
    chiefComplaint,
    diagnosis,
    advice:         e.target.advice.value.trim() || undefined,
    weight:         e.target.vitalsWeight.value.trim() || undefined,
    height:         e.target.vitalsHeight?.value.trim() || undefined,
    pastHistory:    e.target.pastHistory?.value.trim() || undefined,
    allergies:      e.target.allergies?.value.trim() || undefined,
    investigations: e.target.investigations?.value.trim() || undefined,
    followUpDate:   e.target.followUpDate?.value || undefined,
    medications:    meds
  };

  try {
    // Correct URL per src/routes/doctor.routes.js:
    //   POST /api/doctor/appointments/:id/prescription
    await api(
      '/doctor/appointments/' + encodeURIComponent(currentAppointment.id) + '/prescription',
      { method:'POST', body }
    );
    alert('Prescription saved.');
    // Refresh the patient view so the saved Rx + completed status reflect immediately
    openPatient(currentAppointment.id);
    loadStats(); loadDashSnapshot(); loadWaiting();
  } catch (ex){
    alert(ex.message || 'Could not save prescription');
  }
});


/* =====================================================================
   APPOINTMENT ACTIONS
   ===================================================================== */
async function toggleComplete(id){
  if (!confirm('Mark this appointment as completed?')) return;
  try {
    await api('/doctor/appointments/' + encodeURIComponent(id) + '/complete', { method:'POST' });
    loadWaiting(); loadAll(); loadStats(); loadDashSnapshot();
  } catch (ex){ alert(ex.message || 'Could not complete'); }
}

function cancelAppt(id){
  // Bug 4 — replace browser prompt() with a real modal that requires a reason.
  $('#cancelApptId').value = id;
  $('#cancelReason').value = '';
  $('#cancelSubmitBtn').disabled = false;
  $('#cancelModal').classList.remove('hidden');
  setTimeout(() => $('#cancelReason').focus(), 50);
}
function closeCancelModal(){
  $('#cancelModal').classList.add('hidden');
}

/* =====================================================================
   RESCHEDULE
   ===================================================================== */
let rsType = 'OFFLINE';

function openReschedule(id, type){
  rsType = type || 'OFFLINE';
  $('#rsApptId').value = id;
  $('#rsStartTimeHidden').value = '';
  $('#rsSelectedDisplay').textContent = '—';
  $('#rsSubmitBtn').disabled = true;
  $('#rsSlotsGrid').innerHTML = '<div class="np-mut" style="font-size:.85rem;">Select a date to load slots.</div>';
  const today = new Date(); today.setDate(today.getDate() + 1);
  $('#rsDateInput').value = today.toISOString().slice(0,10);
  $('#rescheduleModal').classList.remove('hidden');
  loadRsSlots();
}
function closeRescheduleModal(){
  $('#rescheduleModal').classList.add('hidden');
}
async function loadRsSlots(){
  const date = $('#rsDateInput').value;
  if (!date) return;
  const grid = $('#rsSlotsGrid');
  grid.innerHTML = '<div class="np-mut" style="font-size:.85rem;">Loading slots…</div>';
  try {
    const doctorId = doctorCache?.id;
    if (!doctorId) throw new Error('Doctor not loaded');
    // Bug 3 — correct endpoint is /public/slots, not /booking/slots,
    // and the response shape is { doctorId, date, type, slots: [...] }.
    const url = '/public/slots?doctorId=' + encodeURIComponent(doctorId)
              + '&date=' + encodeURIComponent(date)
              + '&type=' + encodeURIComponent(rsType);
    const res = await api(url);
    const slots = Array.isArray(res) ? res : (res && res.slots) || [];
    if (!slots.length){
      grid.innerHTML = '<div class="np-mut" style="font-size:.85rem;">No slots available.</div>';
      return;
    }
    grid.innerHTML = slots.map(s => `
      <button type="button" class="np-slot-btn rs-slot-btn"
              data-time="${escapeHtml(s.startTime)}"
              ${s.available===false?'disabled':''}
              onclick="selectRsSlot('${escapeHtml(s.startTime)}')">
        ${escapeHtml(fmtTime(s.startTime))}
      </button>
    `).join('');
  } catch (ex){
    grid.innerHTML = '<div class="np-mut" style="font-size:.85rem;">Could not load slots.</div>';
  }
}


function selectRsSlot(time){
  $('#rsStartTimeHidden').value = time;
  $('#rsSelectedDisplay').textContent = fmtTime(time);
  $('#rsSubmitBtn').disabled = false;
  $$('.rs-slot-btn').forEach(b => b.classList.toggle('active', b.dataset.time === time));
}

function setupRescheduleModal(){
  $('#rsDateInput').addEventListener('change', loadRsSlots);
  $('#rescheduleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#rsApptId').value;
    const startTime = $('#rsStartTimeHidden').value;
    const date = $('#rsDateInput').value;
    const reason = e.target.reason.value || '';
    if (!startTime){ alert('Please select a slot.'); return; }
    try {
      await api('/doctor/appointments/' + encodeURIComponent(id) + '/reschedule', {
        method:'POST', body:{ date, startTime, reason }
      });
      closeRescheduleModal();
      loadWaiting(); loadAll(); loadStats(); loadDashSnapshot();
    } catch (ex){ alert(ex.message || 'Could not reschedule'); }
  });
}

function setupCancelModal(){

  $('#cancelForm').addEventListener('submit', async (e) => {

    e.preventDefault();

    const id = $('#cancelApptId').value;
    const reason = $('#cancelReason').value.trim();

    if (reason.length < 3){
      alert('Please enter a cancellation reason (at least 3 characters).');
      return;
    }

    $('#cancelSubmitBtn').disabled = true;

    try {

      await api(
        '/doctor/appointments/' +
        encodeURIComponent(id) +
        '/cancel',
        {
          method:'POST',
          body:{ reason }
        }
      );

      closeCancelModal();

      loadWaiting();
      loadAll();
      loadStats();
      loadDashSnapshot();

    } catch(ex){

      alert(ex.message || 'Could not cancel');

      $('#cancelSubmitBtn').disabled = false;
    }

  });

  document.addEventListener('keydown', (e) => {

    if (
      e.key === 'Escape' &&
      !$('#cancelModal').classList.contains('hidden')
    ){
      closeCancelModal();
    }

  });

}

/* =====================================================================
   SETTINGS — Availability, Clinic, Fees, Password, Photo
   ===================================================================== */
function loadSettings(){
  // The forms are populated from doctorCache on init().
  // Refresh doctor profile to be safe.
  api('/doctor/me').then(d => {
    doctorCache = d;
    renderDoctorHeader(d);
    populateAvailability(d);
    populateClinic(d);
    populateFees(d);
  }).catch(()=>{});
}

/* ---- Availability ---- */
function populateAvailability(d){
  // Build hour selects (1..12)
  ['availableFromOnline_h','availableToOnline_h','availableFromOffline_h','availableToOffline_h'].forEach(name => {
    const el = document.querySelector(`[name="${name}"]`);
    if (!el || el.options.length) return;
    let html = '';
    for (let h=1; h<=12; h++) {
      for (let m=0; m<60; m+=15){
        const label = h + ':' + String(m).padStart(2,'0');
        html += `<option value="${label}">${label}</option>`;
      }
    }
    el.innerHTML = html;
  });

  // Set initial 24h values into hidden inputs and pickers
  setTimePicker('availableFromOnline',  d.availableFromOnline);
  setTimePicker('availableToOnline',    d.availableToOnline);
  setTimePicker('availableFromOffline', d.availableFromOffline);
  setTimePicker('availableToOffline',   d.availableToOffline);

  // Slot duration pills
  const dur = String(d.slotDuration || 15);
  $('#slotDurationVal').value = dur;
  $$('#slotDurationBtns .np-pill').forEach(b => b.classList.toggle('active', b.dataset.val === dur));

  // Working days pills
  const days = String(d.workingDays || 'MON,TUE,WED,THU,FRI,SAT').split(',').map(s=>s.trim()).filter(Boolean);
  $('#workingDaysVal').value = days.join(',');
  $$('#workingDaysBtns .np-pill').forEach(b => b.classList.toggle('active', days.includes(b.dataset.val)));

  const availForm = $('#availForm');
  if (availForm) availForm.isAvailable.checked = !!d.isAvailable;
}

function setTimePicker(baseName, value24){
  // Parse "HH:MM" 24h -> "H:MM" + "AM/PM"
  if (!value24) return;
  const [hStr, mStr] = value24.split(':');
  let h = parseInt(hStr, 10); const m = parseInt(mStr||'0', 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  const label = h + ':' + String(m).padStart(2,'0');
  const hEl = document.querySelector(`[name="${baseName}_h"]`);
  const aEl = document.querySelector(`[name="${baseName}_ampm"]`);
  if (hEl) hEl.value = label;
  if (aEl) aEl.value = ampm;
  const hidden = document.getElementById(baseName);
  if (hidden) hidden.value = value24;
}
function readTimePicker(baseName){
  const hEl = document.querySelector(`[name="${baseName}_h"]`);
  const aEl = document.querySelector(`[name="${baseName}_ampm"]`);
  if (!hEl || !aEl) return '';
  const [hStr, mStr] = (hEl.value || '12:00').split(':');
  let h = parseInt(hStr,10); const m = parseInt(mStr||'0',10);
  if (aEl.value === 'PM' && h !== 12) h += 12;
  if (aEl.value === 'AM' && h === 12) h = 0;
  return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
}

/* ---- Clinic ---- */
function populateClinic(d){
  const f = $('#clinicForm'); if (!f) return;
  f.clinicName.value    = d.clinicName    || '';
  f.clinicAddress.value = d.clinicAddress || '';
  f.clinicMapUrl.value  = d.clinicMapUrl  || '';
  f.clinicLat.value     = d.clinicLat     ?? '';
  f.clinicLng.value     = d.clinicLng     ?? '';
}

/* ---- Fees ---- */
function populateFees(d){
  const f = $('#feesForm'); if (!f) return;
  f.onlineConsultFee.value   = d.onlineConsultFee   ?? '';
  f.physicalConsultFee.value = d.physicalConsultFee ?? '';
}

/* ---- Forms submission ---- */
function setupForms(){
  // Slot duration pills

  $$('#slotDurationBtns .np-pill').forEach(b => {
    b.addEventListener('click', () => {

      $$('#slotDurationBtns .np-pill').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      $('#slotDurationVal').value = b.dataset.val;
    });
  });
  // Working days pills

  $$('#workingDaysBtns .np-pill').forEach(b => {
    b.addEventListener('click', () => {
      b.classList.toggle('active');
      const sel = $$('#workingDaysBtns .np-pill.active').map(x => x.dataset.val);
      $('#workingDaysVal').value = sel.join(',');
    });
  });

  // ── Availability submit  → PUT /api/doctor/availability  (Bug 5) ──
  $('#availForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      availableFromOnline:  readTimePicker('availableFromOnline'),
      availableToOnline:    readTimePicker('availableToOnline'),
      availableFromOffline: readTimePicker('availableFromOffline'),
      availableToOffline:   readTimePicker('availableToOffline'),
      slotDuration: Number($('#slotDurationVal').value || 15),
      workingDays:  $('#workingDaysVal').value || '',
      isAvailable:  !!e.target.isAvailable.checked
    };
    try {
      await api('/doctor/availability', { method:'PUT', body });
      alert('Availability saved.');
      loadSettings();
    } catch (ex){ alert(ex.message || 'Could not save'); }
  });

  // ── Clinic submit  → PUT /api/doctor/clinic  (Bug 5) ──
  $('#clinicForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      clinicName:    e.target.clinicName.value.trim(),
      clinicAddress: e.target.clinicAddress.value.trim(),
      clinicMapUrl:  e.target.clinicMapUrl.value.trim(),
      clinicLat:     e.target.clinicLat.value ? Number(e.target.clinicLat.value) : null,
      clinicLng:     e.target.clinicLng.value ? Number(e.target.clinicLng.value) : null
    };
    try {
      await api('/doctor/clinic', { method:'PUT', body });
      alert('Clinic details saved.');
    } catch (ex){ alert(ex.message || 'Could not save'); }
  });

  // ── Fees submit  → PUT /api/doctor/fees  (Bug 5) ──
  $('#feesForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      onlineConsultFee:   Number(e.target.onlineConsultFee.value || 0),
      physicalConsultFee: Number(e.target.physicalConsultFee.value || 0)
    };
    try {
      await api('/doctor/fees', { method:'PUT', body });
      alert('Fees saved.');
    } catch (ex){ alert(ex.message || 'Could not save'); }
  });

  // ── Password submit  → POST /api/auth/change-password  (Bug 5) ──
  // Schema also requires `confirmPassword` — send it.
  $('#passwordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.newPassword.value !== f.confirmPassword.value){
      alert('New passwords do not match.'); return;
    }
    if (!/^(?=.*[A-Za-z])(?=.*\d).{8,}$/.test(f.newPassword.value)) {
      alert('New password must be at least 8 characters and contain letters and numbers.');
      return;
    }
    try {
      await api('/auth/change-password', { method:'POST', body:{
        currentPassword: f.currentPassword.value,
        newPassword:     f.newPassword.value,
        confirmPassword: f.confirmPassword.value
      }});
      alert('Password updated.');
      f.reset();
    } catch (ex){ alert(ex.message || 'Could not update password'); }
  });

  // ── Photo upload  → POST /api/doctor/profile-image  (Bug 5) ──
  $('#photoForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = $('#photoInput').files[0];
    if (!file) { alert('Choose a file first.'); return; }
    const fd = new FormData();
    fd.append('photo', file);
    try {
      await api('/doctor/profile-image', { method:'POST', body: fd });
      alert('Photo updated.');
      loadSettings();
    } catch (ex){ alert(ex.message || 'Could not upload photo'); }
  });
}


async function removePhoto(){
  if (!confirm('Remove your profile photo?')) return;
  try {
    await api('/doctor/profile-image', { method:'DELETE' });   // Bug 5
    loadSettings();
  } catch (ex){ alert(ex.message || 'Could not remove photo'); }
}


/* =====================================================================
   AUTO-LOGIN
   ===================================================================== */
(async function bootstrap(){
  if (TOKEN){
    try {
      const m = await api('/auth/me');
      if (m && m.role === 'DOCTOR') return init();
    } catch {}
  }
  $('#loginScreen').classList.remove('hidden');
})();
