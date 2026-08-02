

const API = '/api';
let TOKEN = localStorage.getItem('np_doctor_token');
let currentAppointment = null;
let allAppointmentsCache = [];
let doctorCache = null;
let activeConsultId = null;

const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

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
function fmtDate(d){
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
}
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
  if (years === 0) return months <= 0 ? 'newborn' : `${months} mo`;
  if (years < 2) return `${years} yr ${months} mo`;
  return `${years} yrs`;
}
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
  if (years === 0) return months <= 0 ? 'Newborn' : `${months} month${months === 1 ? '' : 's'}`;
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
    CASH_COLLECTED: {cls:'np-badge--green', txt:'Cash collected'},
    CASH_PENDING:   {cls:'np-badge--amber', txt:'Cash at clinic'},
    FAILED:         {cls:'np-badge--red',   txt:'Payment failed'}
  };
  const m = map[p]; if (!m) return '';
  return `<span class="np-badge ${m.cls}"><span class="np-badge__dot"></span>${m.txt}</span>`;
}

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
    if (typeof NPSession !== 'undefined') NPSession.start(TOKEN);
    init();
  } catch (ex){
    err.textContent = ex.message || 'Login failed';
    err.classList.remove('hidden');
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
  if (typeof NPSession !== 'undefined') NPSession.stop();
  location.reload();
}

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
    populateDoctorUuid(me);
  } catch (ex){
    if (ex.status === 401){ logout(); return; }
    console.warn('doctor/me failed', ex);
  }
  setupSidebar();
  setupProfileMenu();
  setupTabs();
  if (typeof NPSession !== 'undefined' && TOKEN) NPSession.start(TOKEN);
  if (typeof NPPalette !== 'undefined' && !window.__npPaletteWired) {
    window.__npPaletteWired = true;
    [
      ['Go to Dashboard',           '🏠', () => setActiveTab('dashboardTab')],
      ['Go to Waiting Room',        '⏳', () => setActiveTab('waitingTab')],
      ['Go to Appointments',        '📅', () => setActiveTab('allTab')],
      ['Go to Prescription Archive','📜', () => setActiveTab('rxArchiveTab')],
      ['Go to My Earnings',         '💰', () => setActiveTab('earningsTab')],
      ['Go to Settings',            '⚙️', () => setActiveTab('settingsTab')],
      ['Toggle dark mode',          '🌙', () => NPTheme && NPTheme.toggle()],
      ['Sign out',                  '⏻', () => logout()],
    ].forEach(([label, icon, run]) => NPPalette.register({ label, icon, run, keywords: label }));
  }
  setupSearchFilters();
  setupForms();
  setupRescheduleModal();
  setupCancelModal();
  setupPatientModalTabs();
  captureRxFormTemplate();

  const bridgeBtn = $('#modalOpenWorkspaceBtn');
  if (bridgeBtn) bridgeBtn.addEventListener('click', () => {
    if (!currentAppointment) return;
    const id = currentAppointment.id;
    closePatientModal();
    location.hash = '#consult/' + id;
  });

  ['rxSearch','rxFromDate','rxToDate'].forEach(id => {
    const el = document.getElementById(id);
    if (el){
      const ev = (el.tagName === 'INPUT' && el.type !== 'date') ? 'input' : 'change';
      el.addEventListener(ev, renderRxArchive);
    }
  });
  const clr = $('#rxClearFilters');
  if (clr) clr.addEventListener('click', () => {
    $('#rxSearch').value = ''; $('#rxFromDate').value = ''; $('#rxToDate').value = '';
    renderRxArchive();
  });

  window.addEventListener('hashchange', handleHashRoute);
  handleHashRoute(); // boot route
  if (!location.hash){
    setActiveTab('dashboardTab');
  }
  loadStats();
  loadDashSnapshot();
}
function _stripDrPrefix(n){ return String(n == null ? '' : n).replace(/^\s*(dr\.?\s+)+/i, '').trim(); }
function renderDoctorHeader(d){
  const clean = _stripDrPrefix(d.name);
  const name = clean ? ('Dr. ' + clean) : 'Doctor';
  $('#docName').textContent = name;
  $('#docSpec').textContent = d.specialization || 'Pediatrician';
  const initials = (clean || 'D').split(/\s+/).map(s=>s[0]).slice(0,2).join('').toUpperCase();
  if (d.photoUrl){
    $('#docPhotoTop').innerHTML = `<img src="${escapeHtml(d.photoUrl)}" alt="${escapeHtml(name)}">`;
    const large = $('#docPhotoLarge');
    if (large) large.innerHTML = `<img src="${escapeHtml(d.photoUrl)}" alt="${escapeHtml(name)}">`;
  } else {
    $('#docPhotoTop').innerHTML = `<span>${escapeHtml(initials)}</span>`;
    const large = $('#docPhotoLarge');
    if (large) large.innerHTML = `<span id="docPhotoPlaceholder">${escapeHtml(initials)}</span>`;
  }
}

function setupSidebar(){
  const sidebar = $('#sidebar');
  const backdrop = $('#sidebarBackdrop');
  const toggle = $('#sidebarToggle');
  if (!sidebar || !backdrop || !toggle || toggle.__bound) return;
  toggle.__bound = true;
  function open(){ sidebar.classList.add('is-open'); backdrop.classList.add('is-open'); document.body.classList.add('np-drawer-open'); }
  function close(){ sidebar.classList.remove('is-open'); backdrop.classList.remove('is-open'); document.body.classList.remove('np-drawer-open'); }
  toggle.addEventListener('click', () => sidebar.classList.contains('is-open') ? close() : open());
  backdrop.addEventListener('click', close);
  $$('.np-nav-item').forEach(b => b.addEventListener('click', () => {
    if (window.matchMedia('(max-width:1023px)').matches) close();
  }));
  window.addEventListener('resize', () => { if (window.innerWidth > 1023) close(); });
}
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
  $$('#profileDropdown [data-go]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-go');
      const sectionKey = btn.getAttribute('data-section');
      setActiveTab(tab); close();
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

const TAB_META = {
  dashboardTab:  { title:'Dashboard',           sub:"Welcome back — here's what's happening today." },
  waitingTab:    { title:'Waiting Room',        sub:'Patients currently waiting to be seen' },
  allTab:        { title:'Appointments',        sub:'Search and manage all your appointments' },
  consultTab:    { title:'Consultation',        sub:'Active patient consultation workspace' },
  rxArchiveTab:  { title:'Prescription Archive',sub:'All prescriptions you have issued' },
  earningsTab:   { title:'My Earnings',         sub:'Monthly revenue split, TDS, and settlement status' },
  settingsTab:   { title:'Settings',            sub:'Manage your profile, availability, and clinic' }
};
function setActiveTab(tabId){
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
  $$('.tab-pane').forEach(p => p.classList.toggle('hidden', p.id !== tabId));
  const meta = TAB_META[tabId];
  if (meta){
    $('#pageTitle').textContent = meta.title;
    $('#pageSubtitle').textContent = meta.sub;
  }
  if (tabId === 'waitingTab') loadWaiting();
  else if (tabId === 'allTab') loadAll();
  else if (tabId === 'settingsTab') loadSettings();
  else if (tabId === 'dashboardTab'){ loadStats(); loadDashSnapshot(); }
  else if (tabId === 'rxArchiveTab') loadRxArchive();
  else if (tabId === 'earningsTab' && window.Earnings) Earnings.load();
}
function setupTabs(){
  $$('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    if (tab !== 'consultTab' && location.hash.startsWith('#consult/')){
      activeConsultId = null;
      $('#navConsult').style.display = 'none';
      history.replaceState(null, '', location.pathname + location.search);
    }
    setActiveTab(tab);
  }));
  const refresh = $('#refreshWaiting');
  if (refresh) refresh.addEventListener('click', () => loadWaiting());
}

function handleHashRoute(){
  const m = (location.hash || '').match(/^#consult\/([A-Za-z0-9-]+)/);
  if (m){
    openConsultation(m[1]);
  } else {
    const navC = $('#navConsult');
    if (navC) navC.style.display = 'none';
  }
}

async function loadStats(){
  try {
    if (typeof NPSkeleton !== 'undefined') NPSkeleton.kpis($('#statsBar'), 4);
  } catch (_) {}
  try {
    const s = await api('/doctor/stats');
    const today = Number(s.todayAppointments || 0);
    const done  = Number(s.completedToday || 0);
    const total = Number(s.totalConsults || 0);
    const rev   = Number(s.totalRevenue || 0);
    $('#statsBar').innerHTML = `
      <div class="np-kpi np-kpi--blue" title="Total appointments scheduled for today (across all statuses).">
        <div class="np-kpi__label">Today's Patients</div>
        <div class="np-kpi__value">${today}</div>
        <div class="np-kpi__sub">${done} completed so far</div>
      </div>
      <div class="np-kpi np-kpi--mint" title="All-time consultations you've completed since joining.">
        <div class="np-kpi__label">Total Consults</div>
        <div class="np-kpi__value">${total}</div>
        <div class="np-kpi__sub">All-time consultations</div>
      </div>
      <div class="np-kpi np-kpi--coral" title="Patients marked as COMPLETED today.">
        <div class="np-kpi__label">Completed Today</div>
        <div class="np-kpi__value">${done}</div>
        <div class="np-kpi__sub">Out of ${today} scheduled</div>
      </div>
      <div class="np-kpi np-kpi--cream" title="Gross fee revenue billed to your patients (before clinic split).">
        <div class="np-kpi__label">Revenue</div>
        <div class="np-kpi__value">${fmtCurrencyFull(rev)}</div>
        <div class="np-kpi__sub">Lifetime</div>
      </div>`;
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
    const badge = $('#navBadgeWaiting');
    if (badge){
      if (list && list.length){ badge.textContent = list.length; badge.classList.remove('hidden'); }
      else { badge.classList.add('hidden'); }
    }
    if (!list || !list.length){
      el.innerHTML = emptyState('No patients waiting', 'Your waiting room is empty right now.', null);
      return;
    }
    const first5 = list.slice(0,5);
    el.innerHTML = `<div class="np-appt-list">${first5.map(apptCard).join('')}</div>`;
  } catch (ex){
    el.innerHTML = emptyState('Could not load appointments', ex.message || 'Try refreshing.', null);
  }
}
function emptyState(title, sub, ctaHtml){
  return `<div class="np-empty">
      <div class="np-empty__title">${escapeHtml(title)}</div>
      <div class="np-empty__sub">${escapeHtml(sub||'')}</div>
      ${ctaHtml || ''}
    </div>`;
}

async function loadWaiting(){
  const list = $('#waitingList');
  list.innerHTML = '';
  try {
    const data = await api('/doctor/waiting-room');
    if (!data || !data.length){
      list.innerHTML = emptyState('All clear', 'No patients are waiting right now.',
        `<button class="np-btn np-btn--ghost np-btn--sm" type="button" style="margin-top:.85rem;"
                 onclick="document.querySelector('[data-tab=allTab]').click()">
           View all appointments
         </button>`);
      return;
    }
    list.innerHTML = data.map(apptCard).join('');
  } catch (ex){
    list.innerHTML = emptyState('Could not load waiting room', ex.message || 'Try again later.', null);
  }
}
async function loadAll(){
  const list = $('#allList');
  list.innerHTML = '';
  try {
    const data = await api('/doctor/appointments');
    allAppointmentsCache = Array.isArray(data) ? data : [];
    renderAllAppointments();
  } catch (ex){
    list.innerHTML = emptyState('Could not load appointments', ex.message || 'Try again later.', null);
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
      return [p.name, p.phone, p.email, a.primaryProblem]
        .some(v => v && String(v).toLowerCase().includes(search));
    });
  }
  const apptTime = (x) => new Date(String(x.date).slice(0,10) + 'T' + (x.startTime || '00:00')).getTime();
  arr.sort((a,b) => {
    const ad = apptTime(a), bd = apptTime(b);
    return sort === 'date_asc' ? (ad - bd) : (bd - ad);
  });
  const list = $('#allList');
  if (!arr.length){
    list.innerHTML = emptyState('No matches', 'Try clearing filters or changing the search term.', null);
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

function apptCard(a){
  const p = a.patient || {};
  const timeMain = fmtTime(a.startTime) || '—';
  const dt = fmtDate(a.date);
  const isLive = !['CANCELLED','COMPLETED'].includes(a.status);
  const canJoin = (a.consultationType === 'ONLINE' && a.meetLink && isLive);
  const canCancel = isLive;
  const canComplete = a.status !== 'COMPLETED' && a.status !== 'CANCELLED';

  const overflowItems = [];
  if (canComplete) {
    overflowItems.push(`<button class="np-overflow-item" type="button" onclick="event.stopPropagation(); toggleComplete('${escapeHtml(a.id)}')">
      <svg class="np-overflow-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      Mark complete
    </button>`);
  }
  if (canCancel) {
    overflowItems.push(`<button class="np-overflow-item" type="button" onclick="event.stopPropagation(); openReschedule('${escapeHtml(a.id)}','${escapeHtml(a.consultationType||'OFFLINE')}')">
      <svg class="np-overflow-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
      Reschedule
    </button>`);
    overflowItems.push(`<button class="np-overflow-item is-danger" type="button" onclick="event.stopPropagation(); cancelAppt('${escapeHtml(a.id)}')">
      <svg class="np-overflow-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
      Cancel
    </button>`);
  }
  if (a.prescriptionUrl) {
    overflowItems.push(`<a class="np-overflow-item" href="${escapeHtml(a.prescriptionUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">
      <svg class="np-overflow-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      View prescription
    </a>`);
  }

  const overflow = overflowItems.length ? `
    <div class="np-overflow">
      <button type="button" class="np-overflow-trigger" aria-label="More actions" onclick="event.stopPropagation(); toggleOverflow(this)">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>
      </button>
      <div class="np-overflow-menu">${overflowItems.join('')}</div>
    </div>` : '';

  return `
  <article class="np-appt" data-id="${escapeHtml(a.id)}">
    <div class="np-appt__time">
      <div class="np-appt__time-h">${escapeHtml(timeMain)}</div>
      <div class="np-appt__time-d">${escapeHtml(dt)}</div>
    </div>
    <div class="np-appt__body">
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
      ${a.status === 'CANCELLED' && a.notes ? `<div class="np-appt__cancel-reason"><b>Cancelled:</b> ${escapeHtml(a.notes)}</div>` : ''}
    </div>
    <div class="np-appt__actions">
      ${isLive ? `<button class="np-btn np-btn--primary np-btn--sm" type="button" onclick="goToConsult('${escapeHtml(a.id)}')">Open Consultation</button>` : ''}
      ${!isLive ? `<button class="np-btn np-btn--ghost np-btn--sm" type="button" onclick="goToConsult('${escapeHtml(a.id)}')">View</button>` : ''}
      ${canJoin ? `<a class="np-btn np-btn--success np-btn--sm" href="${escapeHtml(a.meetLink)}" target="_blank" rel="noopener">Join Meeting</a>` : ''}
      ${overflow}
    </div>
  </article>`;
}

function goToConsult(id){
  location.hash = '#consult/' + id;
}

function closeOverflowMenus(except){
  document.querySelectorAll('.np-overflow-menu.is-open').forEach(menu => {
    if (menu === except) return;
    menu.classList.remove('is-open');
    menu.classList.remove('np-overflow-menu--sheet');
    menu.style.left = '';
    menu.style.top = '';
    menu.style.right = '';
    menu.style.bottom = '';
    menu.style.position = '';
    menu.style.maxHeight = '';
    menu.style.zIndex = '';
    menu.style.width = '';
    menu.style.maxWidth = '';
    const origParent = menu.__npOrigParent;
    const origNext   = menu.__npOrigNext;
    if (origParent && menu.parentNode !== origParent) {
      try {
        if (origNext && origNext.parentNode === origParent) {
          origParent.insertBefore(menu, origNext);
        } else {
          origParent.appendChild(menu);
        }
      } catch(_) {}
    }
    menu.__npOrigParent = null;
    menu.__npOrigNext = null;
  });
}
function positionOverflowMenu(trigger, menu){
  // Anchor the dropdown directly beside the trigger.
  // Never render detached at the top/bottom of the page as a full sheet;
  // always stay inside the viewport with an appropriate open direction.
  const margin = 12;
  const gap = 6;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Reset any prior sheet-mode styling.
  menu.classList.remove('np-overflow-menu--sheet');
  menu.style.position = 'fixed';
  menu.style.left = '0px';
  menu.style.top = '0px';
  menu.style.right = 'auto';
  menu.style.bottom = 'auto';
  menu.style.width = '';
  menu.style.zIndex = '1000';

  // Constrain width to viewport while keeping menu compact next to trigger.
  const availableW = vw - margin * 2;
  const desiredW = Math.min(menu.offsetWidth || 220, 260);
  const width = Math.min(desiredW, availableW);
  menu.style.maxWidth = availableW + 'px';
  menu.style.width = width + 'px';

  // Force layout so we can measure the final height.
  void menu.offsetWidth;

  const triggerRect = trigger.getBoundingClientRect();
  const height = Math.min(menu.offsetHeight || 200, vh - margin * 2);

  // Horizontal: right-align to trigger, then clamp inside viewport.
  let left = triggerRect.right - width;
  if (left < margin) left = Math.min(triggerRect.left, vw - margin - width);
  left = Math.max(margin, Math.min(left, vw - margin - width));

  // Vertical: prefer below the trigger; flip up only if genuinely needed.
  const spaceBelow = vh - triggerRect.bottom - margin;
  const spaceAbove = triggerRect.top - margin;
  const openUp = height > spaceBelow && spaceAbove > spaceBelow;
  const maxHeight = Math.max(160, openUp ? spaceAbove : spaceBelow);
  let top = openUp
    ? Math.max(margin, triggerRect.top - Math.min(height, maxHeight) - gap)
    : (triggerRect.bottom + gap);
  top = Math.max(margin, Math.min(top, vh - margin - Math.min(height, maxHeight)));

  menu.style.left = left + 'px';
  menu.style.top  = top  + 'px';
  menu.style.maxHeight = maxHeight + 'px';
}
function toggleOverflow(btn){
  const menu = btn && btn.nextElementSibling;
  if (!menu || !menu.classList.contains('np-overflow-menu')) return;
  const isOpen = menu.classList.contains('is-open');
  closeOverflowMenus();
  if (isOpen) return;

  if (menu.parentNode && menu.parentNode !== document.body) {
    menu.__npOrigParent = menu.parentNode;
    menu.__npOrigNext   = menu.nextSibling;
    document.body.appendChild(menu);
  }

  menu.classList.add('is-open');
  positionOverflowMenu(btn, menu);
}
document.addEventListener('click', (e) => {
  if (e.target.closest('.np-overflow') || e.target.closest('.np-overflow-menu')) return;
  closeOverflowMenus();
});
window.addEventListener('resize', () => closeOverflowMenus());
window.addEventListener('scroll', () => closeOverflowMenus(), true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeOverflowMenus();
});

function setupPatientModalTabs(){
  document.addEventListener('click', (e) => {
    const t = e.target.closest('.np-pm-tab');
    if (!t || !t.dataset.pmTab) return;
    const target = t.dataset.pmTab;
    const root = t.closest('.np-pm-scope') || document;
    root.querySelectorAll('.np-pm-tab').forEach(x => x.classList.toggle('active', x.dataset.pmTab === target));
    root.querySelectorAll('.np-pm-pane').forEach(x => x.classList.toggle('hidden', x.id !== 'pm-' + target && x.dataset.pmPaneId !== target));
    if (target === 'history' && currentAppointment){
      const patientId = currentAppointment.patientId || (currentAppointment.patient && currentAppointment.patient.id);
      const slot = root.querySelector('[data-history-body], #patientHistoryBody');
      if (slot) loadPatientHistoryInto(slot, patientId);
    }
  });
}

async function openPatient(id){
  try {
    const data = await api('/doctor/appointments/' + encodeURIComponent(id));
    const a = data.appointment || data;
    currentAppointment = a;
    renderConsultBody($('#patientDetail'), a, true);
    moveRxFormInto($('#patientDetail').querySelector('#rxFormSlot'), a, data);
    $('#patientModal').classList.remove('hidden');
  } catch (ex){
    alert(ex.message || 'Could not open patient');
  }
}

function closePatientModal(){
  $('#patientModal').classList.add('hidden');
}

async function openConsultation(id){
  activeConsultId = id;
  const navC = $('#navConsult'); if (navC) navC.style.display = '';
  setActiveTab('consultTab');

  const container = $('#consultContainer');
  container.innerHTML = `
    <div class="np-panel">
      <div class="np-panel__body" style="padding:1.5rem;">
        <div class="np-empty">
          <div class="np-empty__title">Loading consultation…</div>
          <div class="np-empty__sub">Fetching patient data</div>
        </div>
      </div>
    </div>`;

  try {
    const data = await api('/doctor/appointments/' + encodeURIComponent(id));
    const a = data.appointment || data;
    currentAppointment = a;
    const p = a.patient || {};
    const isLive = !['CANCELLED','COMPLETED'].includes(a.status);
    const canJoin = (a.consultationType === 'ONLINE' && a.meetLink && isLive);

    container.innerHTML = `
      <div class="np-panel np-pm-scope" id="consultWorkspace">
        <div class="np-panel__head" style="flex-wrap:wrap;">
          <div style="flex:1; min-width:240px;">
            <div class="np-row" style="gap:.5rem; flex-wrap:wrap; margin-bottom:.25rem;">
              ${statusBadge(a.status)} ${typeBadge(a.consultationType)} ${paymentBadge(a.paymentStatus)}
            </div>
            <div class="np-panel__title" style="font-size:1.25rem;">${escapeHtml(p.name || 'Patient')}
              ${p.dateOfBirth ? `<span class="np-mut" style="font-size:.85rem; margin-left:.5rem; font-weight:500;">${escapeHtml(calcAgeLong(p.dateOfBirth))}</span>` : ''}
            </div>
            <div class="np-panel__subtitle">${fmtDate(a.date)} · ${fmtTime(a.startTime)}${a.endTime ? ' – ' + fmtTime(a.endTime) : ''} · ${fmtCurrency(a.feeAtBooking)}</div>
          </div>
          <div class="np-row" style="gap:.5rem;">
            ${canJoin ? `<a class="np-btn np-btn--success np-btn--sm" href="${escapeHtml(a.meetLink)}" target="_blank" rel="noopener">Join Meeting</a>` : ''}
            ${isLive ? `<button class="np-btn np-btn--ghost np-btn--sm" type="button" onclick="openReschedule('${escapeHtml(a.id)}','${escapeHtml(a.consultationType||'OFFLINE')}')">Reschedule</button>` : ''}
            ${isLive ? `<button class="np-btn np-btn--ghost np-btn--sm" type="button" onclick="cancelAppt('${escapeHtml(a.id)}')" style="color:#B91C1C;">Cancel</button>` : ''}
            ${a.status !== 'COMPLETED' && a.status !== 'CANCELLED' ? `<button class="np-btn np-btn--primary np-btn--sm" type="button" onclick="toggleComplete('${escapeHtml(a.id)}')">Mark Complete</button>` : ''}
          </div>
        </div>
        <div class="np-panel__body">

          <div class="np-pm-tabs np-row" style="gap:.25rem; border-bottom:1px solid var(--np-border); margin-bottom:1rem;">
            <button type="button" class="np-pm-tab active" data-pm-tab="summary">Summary</button>
            <button type="button" class="np-pm-tab" data-pm-tab="prescription">Prescription</button>
            <button type="button" class="np-pm-tab" data-pm-tab="history">Patient History</button>
          </div>

          <div id="pm-summary" class="np-pm-pane" data-pm-pane-id="summary">
            <div class="np-grid-2" style="margin-bottom:1rem;">
              ${p.phone ? `<div class="np-field"><div class="np-field__label">Phone</div><div>${escapeHtml(p.phone)}</div></div>` : ''}
              ${p.email ? `<div class="np-field"><div class="np-field__label">Email</div><div>${escapeHtml(p.email)}</div></div>` : ''}
              ${p.parentName ? `<div class="np-field"><div class="np-field__label">Parent / Guardian</div><div>${escapeHtml(p.parentName)}</div></div>` : ''}
              ${p.gender ? `<div class="np-field"><div class="np-field__label">Gender</div><div>${escapeHtml(p.gender)}</div></div>` : ''}
              ${p.dateOfBirth ? `<div class="np-field"><div class="np-field__label">Date of Birth</div><div>${escapeHtml(fmtDate(p.dateOfBirth))}</div></div>` : ''}
              ${a.meetLink ? `<div class="np-field"><div class="np-field__label">Meet Link</div><div><a href="${escapeHtml(a.meetLink)}" target="_blank" rel="noopener" style="color:var(--np-primary);">Join consultation</a></div></div>` : ''}
            </div>
            ${a.primaryProblem ? `
              <div class="np-field">
                <div class="np-field__label">Primary problem</div>
                <div style="background:var(--np-surface); padding:.7rem .85rem; border-radius:10px; border:1px solid var(--np-border); font-size:.9rem;">
                  ${escapeHtml(a.primaryProblem)}
                </div>
              </div>` : ''}
            ${a.notes ? `
              <div class="np-field" style="margin-top:.85rem;">
                <div class="np-field__label">Notes</div>
                <div class="np-inline-note" style="padding:.7rem .85rem; border-radius:10px; font-size:.9rem;">
                  ${escapeHtml(a.notes)}
                </div>
              </div>` : ''}
            ${a.rescheduledAt ? `
              <div class="np-mut" style="font-size:.82rem; margin-top:.75rem;">
                ⓘ Rescheduled on ${escapeHtml(fmtDate(a.rescheduledAt))}${a.rescheduleReason ? ` — "${escapeHtml(a.rescheduleReason)}"` : ''}
              </div>` : ''}
          </div>

          <div id="pm-prescription" class="np-pm-pane hidden" data-pm-pane-id="prescription">
            <div id="rxSuccessCard" class="np-success-card hidden" style="padding:.85rem 1rem; border-radius:12px; margin-bottom:.85rem;">
              <div class="np-success-card__title" style="font-weight:700; margin-bottom:.25rem;">✓ Prescription saved</div>
              <div id="rxSuccessSub" class="np-mut" style="font-size:.85rem; margin-bottom:.5rem;">PDF generated and emailed to patient.</div>
              <div class="np-row" style="gap:.5rem; flex-wrap:wrap;">
                <a id="rxViewBtn" class="np-btn np-btn--sm" href="#" target="_blank" rel="noopener">View PDF</a>
                <a id="rxDownloadBtn" class="np-btn np-btn--sm" href="#" download>Download PDF</a>
                <button id="rxResendBtn" type="button" class="np-btn np-btn--ghost np-btn--sm" onclick="resendPrescription()">Resend to patient</button>
              </div>
            </div>
            <div id="rxFormSlot"></div>
          </div>

          <div id="pm-history" class="np-pm-pane hidden" data-pm-pane-id="history">
            <div data-history-body class="np-mut" style="font-size:.9rem;">Loading patient history…</div>
          </div>

        </div>
      </div>`;

    moveRxFormInto($('#rxFormSlot'), a, data);
  } catch (ex){
    container.innerHTML = `<div class="np-panel"><div class="np-panel__body">
      <div class="np-empty">
        <div class="np-empty__title">Could not open consultation</div>
        <div class="np-empty__sub">${escapeHtml(ex.message || 'Unknown error')}</div>
        <button class="np-btn np-btn--ghost np-btn--sm" style="margin-top:.85rem;" onclick="document.querySelector('[data-tab=waitingTab]').click()">Back to Waiting Room</button>
      </div>
    </div></div>`;
  }
}

function renderConsultBody(root, a, compact){
  const p = a.patient || {};
  root.innerHTML = `
    <div class="np-pm-scope">
      <div class="np-row" style="gap:.6rem; margin-bottom:.5rem;">
        ${statusBadge(a.status)} ${typeBadge(a.consultationType)} ${paymentBadge(a.paymentStatus)}
      </div>
      <div style="font-size:1.15rem; font-weight:700; color:var(--np-ink);">${escapeHtml(p.name || 'Patient')}</div>
      <div class="np-mut" style="font-size:.85rem; margin-bottom:.75rem;">
        ${p.dateOfBirth
            ? `<b style="color:var(--np-ink);">${escapeHtml(calcAgeLong(p.dateOfBirth))}</b><span class="np-mut"> · DOB ${escapeHtml(fmtDate(p.dateOfBirth))}</span>`
            : '<span class="np-mut">DOB not recorded</span>'}
        ${p.gender ? ' · ' + escapeHtml(p.gender) : ''}
      </div>

      <div class="np-pm-tabs np-row" style="gap:.25rem; border-bottom:1px solid var(--np-border); margin-bottom:.75rem;">
        <button type="button" class="np-pm-tab active" data-pm-tab="current">Current Visit</button>
        <button type="button" class="np-pm-tab" data-pm-tab="prescription">Prescription</button>
        <button type="button" class="np-pm-tab" data-pm-tab="history">Patient History</button>
      </div>

      <div id="pm-current" class="np-pm-pane" data-pm-pane-id="current">
        <div class="np-grid-2" style="margin-bottom:1rem;">
          <div class="np-field"><div class="np-field__label">Date &amp; Time</div><div>${fmtDate(a.date)} · ${fmtTime(a.startTime)}${a.endTime ? ' – ' + fmtTime(a.endTime) : ''}</div></div>
          <div class="np-field"><div class="np-field__label">Fee</div><div>${fmtCurrency(a.feeAtBooking)}</div></div>
          ${p.phone ? `<div class="np-field"><div class="np-field__label">Phone</div><div>${escapeHtml(p.phone)}</div></div>` : ''}
          ${p.email ? `<div class="np-field"><div class="np-field__label">Email</div><div>${escapeHtml(p.email)}</div></div>` : ''}
        </div>
        ${a.primaryProblem ? `
          <div class="np-field"><div class="np-field__label">Primary problem</div>
            <div style="background:var(--np-surface); padding:.7rem .85rem; border-radius:10px; border:1px solid var(--np-border); font-size:.9rem;">
              ${escapeHtml(a.primaryProblem)}
            </div>
          </div>` : ''}
      </div>

      <div id="pm-prescription" class="np-pm-pane hidden" data-pm-pane-id="prescription">
        <div id="rxSuccessCard" class="np-success-card hidden" style="padding:.85rem 1rem; border-radius:12px; margin-bottom:.85rem;">
          <div class="np-success-card__title" style="font-weight:700; margin-bottom:.25rem;">✓ Prescription saved</div>
          <div id="rxSuccessSub" class="np-mut" style="font-size:.85rem; margin-bottom:.5rem;">PDF generated and emailed to patient.</div>
          <div class="np-row" style="gap:.5rem; flex-wrap:wrap;">
            <a id="rxViewBtn" class="np-btn np-btn--sm" href="#" target="_blank" rel="noopener">View PDF</a>
            <a id="rxDownloadBtn" class="np-btn np-btn--sm" href="#" download>Download PDF</a>
            <button id="rxResendBtn" type="button" class="np-btn np-btn--ghost np-btn--sm" onclick="resendPrescription()">Resend to patient</button>
          </div>
        </div>
        <div id="rxFormSlot"></div>
      </div>

      <div id="pm-history" class="np-pm-pane hidden" data-pm-pane-id="history">
        <div data-history-body class="np-mut" style="font-size:.9rem;">Loading patient history…</div>
      </div>
    </div>
  `;
}

let RX_FORM_TEMPLATE = null;          // captured on first call, never null again

function captureRxFormTemplate(){
  if (RX_FORM_TEMPLATE) return;
  const existing = document.getElementById('rxForm');
  if (!existing) return;              // index.html guarantees this exists at load
  const clone = existing.cloneNode(true);
  clone.classList.remove('hidden');
  RX_FORM_TEMPLATE = clone.outerHTML;
  existing.parentNode && existing.parentNode.removeChild(existing);
}

function renderRxFormInto(slot, a, data){
  if (!slot) return;
  captureRxFormTemplate();
  if (!RX_FORM_TEMPLATE){
    slot.innerHTML = '<div class="np-empty"><div class="np-empty__title">Prescription builder unavailable</div><div class="np-empty__sub">Form template was not captured at boot. Please refresh the page.</div></div>';
    return;
  }

  if (!['CONFIRMED','PENDING','COMPLETED'].includes(a.status)){
    slot.innerHTML = '<div class="np-empty"><div class="np-empty__title">Prescription is read-only</div><div class="np-empty__sub">This appointment is ' + escapeHtml(a.status||'—') + '. You can no longer write a prescription.</div></div>';
    return;
  }

  slot.innerHTML = RX_FORM_TEMPLATE;

  const rxForm = slot.querySelector('#rxForm');
  if (!rxForm) return;
  rxForm.classList.remove('hidden');

  const tbody = rxForm.querySelector('#medsList');
  if (tbody) tbody.innerHTML = '';
  addMedRow();

  const p = a.patient || {};
  const rx = (data && data.appointment && data.appointment.prescription)
              || a.prescription
              || null;

  if (rx){
    rxForm.diagnosis.value      = rx.diagnosis || '';
    rxForm.chiefComplaint.value = rx.chiefComplaint || '';
    rxForm.advice.value         = rx.advice || '';
    if (rxForm.vitalsWeight)    rxForm.vitalsWeight.value    = rx.weight || '';
    if (rxForm.vitalsHeight)    rxForm.vitalsHeight.value    = rx.height || '';
    if (rxForm.allergies)       rxForm.allergies.value       = rx.allergies || '';
    if (rxForm.pastHistory)     rxForm.pastHistory.value     = rx.pastHistory || '';
    if (rxForm.investigations)  rxForm.investigations.value  = rx.investigations || '';
    if (rxForm.followUpDate)    rxForm.followUpDate.value    = rx.followUpDate ? String(rx.followUpDate).slice(0,10) : '';
    if (tbody && Array.isArray(rx.medications) && rx.medications.length){
      tbody.innerHTML = '';
      rx.medications.forEach(m => addMedRow(m));
    }
    showRxSuccessCard({
      pdfUrl: a.prescriptionUrl,
      emailRecipient: p.email,
      subtitle: 'Existing prescription on file. You can edit and re-save, or re-send to the patient.'
    });
  } else {
    const card = document.querySelector('#rxSuccessCard');
    if (card) card.classList.add('hidden');
  }
}

function moveRxFormInto(slot, a, data){ return renderRxFormInto(slot, a, data); }

async function loadPatientHistoryInto(slot, patientId){
  if (!slot) return;
  if (!patientId){ slot.innerHTML = 'No patient id available.'; return; }
  slot.innerHTML = 'Loading patient history…';
  try {
    const h = await api('/doctor/patients/' + encodeURIComponent(patientId) + '/history');
    const sum = h.summary || {};
    const siblings = (h.siblings || []).map(s => `
      <span class="np-badge np-badge--slate" title="DOB: ${escapeHtml(fmtDate(s.dateOfBirth))}">
        ${escapeHtml(s.name)} ${s.dateOfBirth ? '· ' + escapeHtml(calcAge(s.dateOfBirth)) : ''}
      </span>`).join(' ');

    const visitsHtml = (h.visits || []).map(v => `
      <article class="np-history-row">
        <div class="np-history-row__date">
          <div><b>${escapeHtml(fmtDate(v.date))}</b></div>
          <div class="np-mut" style="font-size:.8rem;">${escapeHtml(fmtTime(v.startTime))}</div>
        </div>
        <div class="np-history-row__body">
          <div class="np-row" style="gap:.4rem; margin-bottom:.25rem;">
            ${statusBadge(v.status)} ${typeBadge(v.consultationType)}
          </div>
          ${v.primaryProblem ? `<div style="font-size:.88rem; margin-bottom:.25rem;"><b>Complaint:</b> ${escapeHtml(v.primaryProblem)}</div>` : ''}
          ${v.notes ? `<div style="font-size:.85rem;" class="np-mut"><b>Notes:</b> ${escapeHtml(v.notes)}</div>` : ''}
          <div class="np-row" style="gap:.5rem; margin-top:.4rem; flex-wrap:wrap;">
            ${v.hasPrescription && v.prescriptionUrl ? `<a class="np-btn np-btn--sm" href="${escapeHtml(v.prescriptionUrl)}" target="_blank" rel="noopener">📄 Prescription PDF</a>` : ''}
            ${v.meetLink ? `<a class="np-btn np-btn--ghost np-btn--sm" href="${escapeHtml(v.meetLink)}" target="_blank" rel="noopener">Meet</a>` : ''}
          </div>
        </div>
      </article>`).join('');

    const rxHtml = (h.prescriptions || []).map(rx => `
      <article class="np-history-rx">
        <div class="np-row" style="justify-content:space-between; align-items:center; margin-bottom:.25rem;">
          <b>${escapeHtml(fmtDate(rx.visitDate))}</b>
          ${rx.pdfUrl ? `<a class="np-btn np-btn--sm" href="${escapeHtml(rx.pdfUrl)}" target="_blank" rel="noopener">View PDF</a>` : ''}
        </div>
        <div style="font-size:.88rem;"><b>Diagnosis:</b> ${escapeHtml(rx.diagnosis || '—')}</div>
        ${rx.chiefComplaint ? `<div style="font-size:.85rem;" class="np-mut"><b>Complaint:</b> ${escapeHtml(rx.chiefComplaint)}</div>` : ''}
        ${rx.medications && rx.medications.length ? `<div style="font-size:.82rem; margin-top:.3rem;">${
          rx.medications.map(m => `• ${escapeHtml(m.name||'')} ${escapeHtml(m.dose||'')} ${escapeHtml(m.frequency||'')} × ${escapeHtml(m.duration||'')}`).join('<br/>')
        }</div>` : ''}
        ${rx.followUpDate ? `<div class="np-mut" style="font-size:.82rem; margin-top:.25rem;">Follow-up: ${escapeHtml(fmtDate(rx.followUpDate))}</div>` : ''}
      </article>`).join('');

    slot.innerHTML = `
      <div class="np-grid-2" style="gap:.6rem; margin-bottom:.85rem;">
        <div class="np-field"><div class="np-field__label">Total visits</div><div>${escapeHtml(String(sum.totalVisits||0))}</div></div>
        <div class="np-field"><div class="np-field__label">Completed</div><div>${escapeHtml(String(sum.completedVisits||0))}</div></div>
        <div class="np-field"><div class="np-field__label">Last visit</div><div>${sum.lastVisitAt ? escapeHtml(fmtDate(sum.lastVisitAt)) : '—'}</div></div>
        <div class="np-field"><div class="np-field__label">Open follow-ups</div><div>${escapeHtml(String(sum.openFollowUps||0))}</div></div>
      </div>
      ${siblings ? `<div class="np-field" style="margin-bottom:.85rem;">
        <div class="np-field__label">Siblings on same parent phone</div>
        <div class="np-row" style="gap:.35rem; flex-wrap:wrap;">${siblings}</div>
      </div>` : ''}
      ${(h.diagnoses||[]).length ? `<div class="np-field" style="margin-bottom:.85rem;">
        <div class="np-field__label">Past diagnoses</div>
        <div>${h.diagnoses.map(d => `<span class="np-badge np-badge--mint" style="margin-right:.25rem; margin-bottom:.25rem;">${escapeHtml(d)}</span>`).join(' ')}</div>
      </div>` : ''}
      <div class="np-field" style="margin-bottom:.5rem;">
        <div class="np-field__label">Visits (${(h.visits||[]).length})</div>
      </div>
      ${visitsHtml || '<div class="np-mut">No previous visits with this doctor.</div>'}
      ${(h.prescriptions||[]).length ? `
        <div class="np-field" style="margin:.85rem 0 .5rem;">
          <div class="np-field__label">Prescriptions (${h.prescriptions.length})</div>
        </div>
        ${rxHtml}` : ''}
    `;
  } catch (ex){
    slot.innerHTML = `Could not load patient history: ${escapeHtml(ex.message || 'unknown error')}`;
  }
}

function addMedRow(prefill){
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td data-label="Medicine"><input class="med-name"  placeholder="e.g. Paracetamol 250mg syrup" value="${escapeHtml(prefill?.name||'')}"></td>
    <td data-label="Dosage"><input class="med-dose"  placeholder="2.5 ml"                          value="${escapeHtml(prefill?.dose||prefill?.dosage||'')}"></td>
    <td data-label="Frequency"><input class="med-freq"  placeholder="TDS / BD / SOS"                  value="${escapeHtml(prefill?.frequency||'')}"></td>
    <td data-label="Duration"><input class="med-dur"   placeholder="3 days"                          value="${escapeHtml(prefill?.duration||'')}"></td>
    <td data-label="Instructions"><input class="med-inst"  placeholder="After food"                      value="${escapeHtml(prefill?.instructions||'')}"></td>
    <td data-label=""><button type="button" class="np-remove-row" title="Remove">×</button></td>
  `;
  tr.querySelector('.np-remove-row').addEventListener('click', () => tr.remove());
  $('#medsList').appendChild(tr);
}

function showRxSuccessCard({ pdfUrl, emailRecipient, subtitle }){
  const card = document.querySelector('#rxSuccessCard');
  if (!card) return;
  const sub = card.querySelector('#rxSuccessSub');
  if (sub) sub.textContent = subtitle ||
    (emailRecipient ? `PDF generated and emailed to ${emailRecipient}.` : 'PDF generated. No patient email on file — use Resend after adding one.');
  const view = card.querySelector('#rxViewBtn');
  const dl   = card.querySelector('#rxDownloadBtn');
  if (pdfUrl){
    view.href = pdfUrl;
    dl.href   = pdfUrl;
    view.classList.remove('np-btn--disabled');
    dl.classList.remove('np-btn--disabled');
  } else {
    view.removeAttribute('href');
    dl.removeAttribute('href');
    view.classList.add('np-btn--disabled');
    dl.classList.add('np-btn--disabled');
  }
  const resend = card.querySelector('#rxResendBtn');
  if (resend) resend.disabled = !emailRecipient;
  card.classList.remove('hidden');
}

async function resendPrescription(){
  if (!currentAppointment){ alert('No appointment selected'); return; }
  const btn = document.querySelector('#rxResendBtn'); if (btn) btn.disabled = true;
  try {
    const r = await api('/doctor/appointments/' + encodeURIComponent(currentAppointment.id) + '/prescription/resend',
      { method:'POST' });
    alert('Prescription re-sent to ' + (r.recipient || 'patient'));
  } catch (ex){
    alert(ex.message || 'Could not resend');
  } finally {
    if (btn) btn.disabled = false;
  }
}

document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'rxForm') return;
  e.preventDefault();
  if (!currentAppointment) return;

  const meds = $$('#medsList tr').map(tr => ({
    name:         tr.querySelector('.med-name').value.trim(),
    dose:         tr.querySelector('.med-dose').value.trim(),
    frequency:    tr.querySelector('.med-freq').value.trim(),
    duration:     tr.querySelector('.med-dur').value.trim(),
    instructions: tr.querySelector('.med-inst').value.trim() || undefined
  })).filter(m => m.name && m.dose && m.frequency && m.duration);

  if (!meds.length) { alert('Please add at least one medication with name, dose, frequency, and duration.'); return; }
  const chiefComplaint = (e.target.chiefComplaint?.value || '').trim();
  const diagnosis      = (e.target.diagnosis.value || '').trim();
  if (chiefComplaint.length < 2) { alert('Please enter the chief complaint.'); return; }
  if (diagnosis.length < 2)      { alert('Please enter a diagnosis.'); return; }

  const body = {
    chiefComplaint, diagnosis,
    advice:         e.target.advice.value.trim() || undefined,
    weight:         e.target.vitalsWeight.value.trim() || undefined,
    height:         e.target.vitalsHeight?.value.trim() || undefined,
    pastHistory:    e.target.pastHistory?.value.trim() || undefined,
    allergies:      e.target.allergies?.value.trim() || undefined,
    investigations: e.target.investigations?.value.trim() || undefined,
    followUpDate:   e.target.followUpDate?.value || undefined,
    medications:    meds
  };

  const submitBtn = e.target.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;
  try {
    const r = await api(
      '/doctor/appointments/' + encodeURIComponent(currentAppointment.id) + '/prescription',
      { method:'POST', body }
    );
    showRxSuccessCard({
      pdfUrl: (r.delivery && r.delivery.pdfUrl) || (r.appointment && r.appointment.prescriptionUrl),
      emailRecipient: r.delivery && r.delivery.emailRecipient,
      subtitle: r.delivery && r.delivery.emailQueued
        ? `PDF generated and emailed to ${r.delivery.emailRecipient}.`
        : 'PDF generated. Patient has no email — use Resend after adding one.'
    });
    const scope = e.target.closest('.np-pm-scope');
    if (scope){
      const tab = scope.querySelector('.np-pm-tab[data-pm-tab="prescription"]');
      if (tab) tab.click();
    }
    loadStats(); loadDashSnapshot(); loadWaiting();
  } catch (ex){
    alert(ex.message || 'Could not save prescription');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
});

let rxArchiveCache = [];
async function loadRxArchive(){
  const list = $('#rxArchiveList');
  list.innerHTML = '<div class="np-empty"><div class="np-empty__title">Loading…</div></div>';
  try {
    const data = await api('/doctor/appointments');
    rxArchiveCache = (Array.isArray(data) ? data : [])
      .filter(a => a.prescription || a.prescriptionUrl);
    renderRxArchive();
  } catch (ex){
    list.innerHTML = emptyState('Could not load archive', ex.message || 'Try again later.', null);
  }
}
function renderRxArchive(){
  const list = $('#rxArchiveList'); if (!list) return;
  const search = ($('#rxSearch').value || '').trim().toLowerCase();
  const from = $('#rxFromDate').value;
  const to   = $('#rxToDate').value;
  let arr = rxArchiveCache.slice();
  if (from) arr = arr.filter(a => (a.date || '').slice(0,10) >= from);
  if (to)   arr = arr.filter(a => (a.date || '').slice(0,10) <= to);
  if (search){
    arr = arr.filter(a => {
      const p = a.patient || {};
      const dx = (a.prescription && a.prescription.diagnosis) || '';
      return [p.name, p.phone, p.email, a.primaryProblem, dx]
        .some(v => v && String(v).toLowerCase().includes(search));
    });
  }
  arr.sort((a,b) => new Date(String(b.date).slice(0,10)+'T'+(b.startTime||'00:00')) - new Date(String(a.date).slice(0,10)+'T'+(a.startTime||'00:00')));
  if (!arr.length){
    list.innerHTML = emptyState('No prescriptions found',
      'Try clearing filters or expanding the date range.',
      `<button class="np-btn np-btn--ghost np-btn--sm" style="margin-top:.85rem;" type="button" onclick="document.getElementById('rxClearFilters').click()">Clear filters</button>`);
    return;
  }
  list.innerHTML = arr.map(a => {
    const p = a.patient || {};
    const dx = (a.prescription && a.prescription.diagnosis) || '—';
    return `
    <article class="np-appt" data-id="${escapeHtml(a.id)}">
      <div class="np-appt__time">
        <div class="np-appt__time-h">${escapeHtml(fmtTime(a.startTime))}</div>
        <div class="np-appt__time-d">${escapeHtml(fmtDate(a.date))}</div>
      </div>
      <div class="np-appt__body">
        <div class="np-appt__namerow">
          <span class="np-appt__name">${escapeHtml(p.name || 'Patient')}</span>
          ${p.dateOfBirth ? `<span class="np-appt__age">${escapeHtml(calcAge(p.dateOfBirth))}</span>` : ''}
        </div>
        <div class="np-appt__meta">
          ${p.phone ? `<span>📞 ${escapeHtml(p.phone)}</span>` : ''}
          <span><b>Dx:</b> ${escapeHtml(dx)}</span>
        </div>
        ${a.primaryProblem ? `<div class="np-appt__problem">${escapeHtml(a.primaryProblem)}</div>` : ''}
      </div>
      <div class="np-appt__actions">
        ${a.prescriptionUrl ? `<a class="np-btn np-btn--primary np-btn--sm" href="${escapeHtml(a.prescriptionUrl)}" target="_blank" rel="noopener">View PDF</a>` : ''}
        ${a.prescriptionUrl ? `<a class="np-btn np-btn--ghost np-btn--sm" href="${escapeHtml(a.prescriptionUrl)}" download>Download</a>` : ''}
        <button class="np-btn np-btn--ghost np-btn--sm" type="button" onclick="goToConsult('${escapeHtml(a.id)}')">Open visit</button>
      </div>
    </article>`;
  }).join('');
}

async function toggleComplete(id){
  const ok = await NPModal.confirm({
    title: 'Mark appointment as completed?',
    message: 'This will close the consultation, finalise the invoice, and move the appointment out of the waiting room.',
    okText: 'Mark completed',
  });
  if (!ok) return;
  try {
    await api('/doctor/appointments/' + encodeURIComponent(id) + '/complete', { method:'POST' });
    NPToast.success('Appointment marked completed');
    loadWaiting(); loadAll(); loadStats(); loadDashSnapshot();
    if (activeConsultId === id) openConsultation(id);
  } catch (ex){ NPToast.error(ex.message || 'Could not complete'); }
}
function cancelAppt(id){
  $('#cancelApptId').value = id;
  $('#cancelReason').value = '';
  $('#cancelSubmitBtn').disabled = false;
  $('#cancelModal').classList.remove('hidden');
  setTimeout(() => $('#cancelReason').focus(), 50);
}
function closeCancelModal(){ $('#cancelModal').classList.add('hidden'); }

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
function closeRescheduleModal(){ $('#rescheduleModal').classList.add('hidden'); }
async function loadRsSlots(){
  const date = $('#rsDateInput').value;
  if (!date) return;
  const grid = $('#rsSlotsGrid');
  grid.innerHTML = '<div class="np-mut" style="font-size:.85rem;">Loading slots…</div>';
  try {
    const doctorId = doctorCache?.id;
    if (!doctorId) throw new Error('Doctor not loaded');
    const url = '/public/slots?doctorId=' + encodeURIComponent(doctorId)
              + '&date=' + encodeURIComponent(date) + '&type=' + encodeURIComponent(rsType);
    const res = await api(url);
    const slots = Array.isArray(res) ? res : (res && res.slots) || [];
    if (!slots.length){ grid.innerHTML = '<div class="np-mut" style="font-size:.85rem;">No slots available.</div>'; return; }
    grid.innerHTML = slots.map(s => `
      <button type="button" class="np-slot-btn rs-slot-btn"
              data-time="${escapeHtml(s.startTime)}"
              ${s.available===false?'disabled':''}
              onclick="selectRsSlot('${escapeHtml(s.startTime)}')">
        ${escapeHtml(fmtTime(s.startTime))}
      </button>`).join('');
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
      if (activeConsultId === id) openConsultation(id);
      alert('Appointment rescheduled. Patient and doctor have been notified by email and WhatsApp.');
    } catch (ex){ alert(ex.message || 'Could not reschedule'); }
  });
}
function setupCancelModal(){
  $('#cancelForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#cancelApptId').value;
    const reason = $('#cancelReason').value.trim();
    if (reason.length < 3){ alert('Please enter a cancellation reason (at least 3 characters).'); return; }
    $('#cancelSubmitBtn').disabled = true;
    try {
      await api('/doctor/appointments/' + encodeURIComponent(id) + '/cancel',
        { method:'POST', body:{ reason } });
      closeCancelModal();
      loadWaiting(); loadAll(); loadStats(); loadDashSnapshot();
      if (activeConsultId === id) openConsultation(id);
    } catch(ex){
      alert(ex.message || 'Could not cancel');
      $('#cancelSubmitBtn').disabled = false;
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#cancelModal').classList.contains('hidden')) closeCancelModal();
  });
}

function loadSettings(){
  api('/doctor/me').then(d => {
    doctorCache = d;
    renderDoctorHeader(d);
    populateAvailability(d);
    populateClinic(d);
    populateFees(d);
    populateDoctorUuid(d);
    if (typeof NPDropzone !== 'undefined') {
      const input = document.getElementById('photoInput');
      if (input) NPDropzone.bind(input, { label: 'Drop profile photo here', hint: 'or click to browse (JPG / PNG)' });
    }
  }).catch(()=>{});
}

function populateDoctorUuid(d){
  const input = document.getElementById('doctorUuidInput');
  const btn   = document.getElementById('doctorUuidCopyBtn');
  if (!input || !btn) return;
  const uuid = (d && d.id) || '';
  input.value = uuid;
  if (!btn.__wired) {
    btn.__wired = true;
    btn.addEventListener('click', () => __npCopyDoctorUuid(input.value, btn));
  }
  btn.disabled = !uuid;
}
function __npCopyDoctorUuid(text, btn){
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
  const fallback = () => {
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
      done();
    } catch(_){}
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else {
      fallback();
    }
  } catch(_) { fallback(); }
}
function populateAvailability(d){
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
  setTimePicker('availableFromOnline',  d.availableFromOnline);
  setTimePicker('availableToOnline',    d.availableToOnline);
  setTimePicker('availableFromOffline', d.availableFromOffline);
  setTimePicker('availableToOffline',   d.availableToOffline);
  const dur = String(d.slotDuration || 15);
  $('#slotDurationVal').value = dur;
  $$('#slotDurationBtns .np-pill').forEach(b => b.classList.toggle('active', b.dataset.val === dur));
  const days = String(d.workingDays || 'MON,TUE,WED,THU,FRI,SAT').split(',').map(s=>s.trim()).filter(Boolean);
  $('#workingDaysVal').value = days.join(',');
  $$('#workingDaysBtns .np-pill').forEach(b => b.classList.toggle('active', days.includes(b.dataset.val)));
  const availForm = $('#availForm');
  if (availForm) availForm.isAvailable.checked = !!d.isAvailable;
}
function setTimePicker(baseName, value24){
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
function populateClinic(d){
  const f = $('#clinicForm'); if (!f) return;
  f.clinicName.value    = d.clinicName    || '';
  f.clinicAddress.value = d.clinicAddress || '';
  f.clinicMapUrl.value  = d.clinicMapUrl  || '';
  f.clinicLat.value     = d.clinicLat     ?? '';
  f.clinicLng.value     = d.clinicLng     ?? '';
}
function populateFees(d){
  const f = $('#feesForm'); if (!f) return;
  f.onlineConsultFee.value   = d.onlineConsultFee   ?? '';
  f.physicalConsultFee.value = d.physicalConsultFee ?? '';
}
function setupForms(){
  $$('#slotDurationBtns .np-pill').forEach(b => {
    b.addEventListener('click', () => {
      $$('#slotDurationBtns .np-pill').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      $('#slotDurationVal').value = b.dataset.val;
    });
  });
  $$('#workingDaysBtns .np-pill').forEach(b => {
    b.addEventListener('click', () => {
      b.classList.toggle('active');
      const sel = $$('#workingDaysBtns .np-pill.active').map(x => x.dataset.val);
      $('#workingDaysVal').value = sel.join(',');
    });
  });
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
    function _hm(s){ if (!s) return null; const m = String(s).match(/^(\d{1,2}):(\d{2})$/); return m ? (Number(m[1])*60 + Number(m[2])) : null; }
    const pairs = [['Online', body.availableFromOnline, body.availableToOnline],
                   ['Offline', body.availableFromOffline, body.availableToOffline]];
    for (const [label, a, b] of pairs) {
      const av = _hm(a), bv = _hm(b);
      if (av != null && bv != null && av >= bv) {
        if (typeof NPToast !== 'undefined') NPToast.error(label + ' availability: start time must be before end time.');
        else alert(label + ' availability: start time must be before end time.');
        return;
      }
    }
    try { await api('/doctor/availability', { method:'PUT', body }); alert('Availability saved.'); loadSettings(); }
    catch (ex){ alert(ex.message || 'Could not save'); }
  });
  $('#clinicForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      clinicName:    e.target.clinicName.value.trim(),
      clinicAddress: e.target.clinicAddress.value.trim(),
      clinicMapUrl:  e.target.clinicMapUrl.value.trim(),
      clinicLat:     e.target.clinicLat.value ? Number(e.target.clinicLat.value) : null,
      clinicLng:     e.target.clinicLng.value ? Number(e.target.clinicLng.value) : null
    };
    try { await api('/doctor/clinic', { method:'PUT', body }); alert('Clinic details saved.'); }
    catch (ex){ alert(ex.message || 'Could not save'); }
  });
  $('#feesForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      onlineConsultFee:   Number(e.target.onlineConsultFee.value || 0),
      physicalConsultFee: Number(e.target.physicalConsultFee.value || 0)
    };
    try { await api('/doctor/fees', { method:'PUT', body }); alert('Fees saved.'); }
    catch (ex){ alert(ex.message || 'Could not save'); }
  });
  $('#passwordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.newPassword.value !== f.confirmPassword.value){ alert('New passwords do not match.'); return; }
    if (!/^(?=.*[A-Za-z])(?=.*\d).{8,}$/.test(f.newPassword.value)) {
      alert('New password must be at least 8 characters and contain letters and numbers.'); return;
    }
    try {
      await api('/auth/change-password', { method:'POST', body:{
        currentPassword: f.currentPassword.value,
        newPassword:     f.newPassword.value,
        confirmPassword: f.confirmPassword.value
      }});
      alert('Password updated.'); f.reset();
    } catch (ex){ alert(ex.message || 'Could not update password'); }
  });
  $('#photoForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = $('#photoInput').files[0];
    if (!file) { alert('Choose a file first.'); return; }
    const fd = new FormData(); fd.append('photo', file);
    try { await api('/doctor/profile-image', { method:'POST', body: fd }); alert('Photo updated.'); loadSettings(); }
    catch (ex){ alert(ex.message || 'Could not upload photo'); }
  });
}
async function removePhoto(){
  const ok = await NPModal.confirm({
    title: 'Remove profile photo?',
    message: 'Your photo will be removed from the public listing. You can upload a new one any time.',
    okText: 'Remove photo',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('/doctor/profile-image', { method:'DELETE' });
    NPToast.success('Profile photo removed');
    loadSettings();
  } catch (ex){ NPToast.error(ex.message || 'Could not remove photo'); }
}

(async function bootstrap(){
  if (TOKEN){
    try {
      const m = await api('/auth/me');
      if (m && m.role === 'DOCTOR') return init();
    } catch {}
  }
  $('#loginScreen').classList.remove('hidden');
})();

(function(){
  'use strict';
  var doc = document;
  var mqMobile = window.matchMedia ? window.matchMedia('(max-width:1023px)') : null;

  function setBodyLock(locked){
    if (!doc.body) return;
    doc.body.classList.toggle('np-drawer-open', !!locked);
  }

  function wireSidebar(){
    var sidebar  = doc.getElementById('sidebar');
    var backdrop = doc.getElementById('sidebarBackdrop');
    var toggle   = doc.getElementById('sidebarToggle');
    if (!sidebar || !backdrop) return;
    // v3.3.2: idempotent — never shadow the primary setupSidebar handlers.
    if (backdrop.__npBound) return; backdrop.__npBound = true;

    function isOpen(){ return sidebar.classList.contains('is-open'); }
    function close(){
      sidebar.classList.remove('is-open');
      backdrop.classList.remove('is-open');
      backdrop.setAttribute('aria-hidden','true');
      setBodyLock(false);
    }

    // v3.3.2: safety-net backdrop click MUST close the drawer.
    backdrop.addEventListener('click', close);
    backdrop.addEventListener('touchend', function(e){ e.preventDefault(); close(); }, { passive:false });

    if (toggle && !toggle.__npSafetyBound){
      toggle.__npSafetyBound = true;
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

function injectConsultBackButton(){
    var container = doc.getElementById('consultContainer');
    if (!container) return;
    var mo = new MutationObserver(function(){
      var workspace = doc.getElementById('consultWorkspace');
      if (!workspace) return;
      if (workspace.querySelector('.np-consult-backbar')) return;
      var bar = doc.createElement('div');
      bar.className = 'np-consult-backbar';
      bar.innerHTML =
        '<button type="button" class="np-consult-back" aria-label="Back to appointments">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>' +
          '<span>Back to Appointments</span>' +
        '</button>' +
        '<span class="np-consult-breadcrumb">Appointments &rsaquo; <span>Consultation</span></span>';
      workspace.insertBefore(bar, workspace.firstChild);
      bar.querySelector('.np-consult-back').addEventListener('click', function(){
        var prev = (window.__prevDoctorTab || 'appointmentsTab');
        if (typeof setActiveTab === 'function'){
          if (location.hash.indexOf('#consult/') === 0){
            history.replaceState(null, '', location.pathname + location.search);
          }
          setActiveTab(prev);
        } else if (window.history && history.length > 1){
          history.back();
        } else {
          location.hash = '';
        }
      });
    });
    mo.observe(container, { childList: true, subtree: true });
  }

  function trackPreviousTab(){
    if (typeof window.setActiveTab !== 'function') return;
    var orig = window.setActiveTab;
    window.setActiveTab = function(id){
      try { if (id !== 'consultTab') window.__prevDoctorTab = id; } catch(_){}
      return orig.apply(this, arguments);
    };
  }

  function wireThemeSwitch(){
    const opts = document.querySelectorAll('#setting-appearance [data-theme-choice]');
    if (!opts.length || !window.NPTheme) return;
    const paint = () => {
      const mode = window.NPTheme.current ? window.NPTheme.current() :
        (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
      opts.forEach(el => {
        const active = el.dataset.themeChoice === mode;
        el.classList.toggle('is-active', active);
        el.setAttribute('aria-checked', active ? 'true' : 'false');
      });
    };
    opts.forEach(el => {
      el.addEventListener('click', () => {
        window.NPTheme.set(el.dataset.themeChoice);
        paint();
      });
    });
    document.addEventListener('np-theme-change', paint);
    paint();
  }

  function boot(){
    try { wireSidebar(); } catch(_){}
    try { injectConsultBackButton(); } catch(_){}
    try { wireThemeSwitch(); } catch(_){}
    setTimeout(trackPreviousTab, 0);
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
