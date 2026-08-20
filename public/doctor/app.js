

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
// v3.4.12 — Previous Records extras marker stripper. historical-fix.js
// stores type-specific extras (findings / scanType / vaccine / referral
// / discharge details) as a JSON tail on `notes`. When patient-history
// timeline snippets or the legacy previous-records list echo `notes`
// directly, strip that tail so users never see the raw marker.
function stripHrExtras(notes){
  const s = String(notes == null ? '' : notes);
  const i = s.lastIndexOf('\n\n<!--HR_EXTRAS_V1:');
  if (i < 0) return s;
  const j = s.indexOf(':HR_EXTRAS_V1-->', i);
  if (j < 0) return s;
  return s.slice(0, i);
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
// Feature 1 — visual distinction for manually added (historical) records.
function sourceBadge(source){
  if (source === 'CLINIC_RECEPTION')
    return `<span class="np-badge np-badge--violet" title="Booked at the clinic front desk"><span class="np-badge__dot"></span>Clinic reception</span>`;
  if (source === 'NEOKIDSPRO')
    return `<span class="np-badge np-badge--mint" title="Booked online by the patient"><span class="np-badge__dot"></span>NeoKidsPro online</span>`;
  if (source === 'MANUAL')
    return `<span class="np-badge np-badge--purple" title="Added manually by clinic staff"><span class="np-badge__dot"></span>Manual Record</span>`;
  return '';
}
function rxSourceBadge(source){
  if (source === 'CLINIC_RECEPTION')
    return `<span class="np-badge np-badge--violet" title="Entered at the clinic front desk"><span class="np-badge__dot"></span>Entered by reception</span>`;
  if (source === 'MANUAL')
    return `<span class="np-badge np-badge--purple" title="Uploaded by clinic staff (not generated in NeoKidsPro)"><span class="np-badge__dot"></span>Historical Rx</span>`;
  return '';
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
    applyHistoricalPermission(me);
    try { loadSignature(); } catch(_){}
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
  setupFeatureUI();
  captureRxFormTemplate();

  const bridgeBtn = $('#modalOpenWorkspaceBtn');
  if (bridgeBtn) bridgeBtn.addEventListener('click', () => {
    if (!currentAppointment) return;
    const id = currentAppointment.id;
    closePatientModal();
    // v3.4.11 FIX — same spurious-popstate guard as goToConsult().
    if (window.NPBackNav && typeof NPBackNav.routeHashNav === 'function'){
      NPBackNav.routeHashNav(() => { location.hash = '#consult/' + id; });
    } else {
      location.hash = '#consult/' + id;
    }
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
  loadDashWelcome();
  NPBackNav.init();  // v3.4.10 — arm global mobile back-button navigation
}
function applyHistoricalPermission(me){
  // Issue 1 — Previous Records is a permission-controlled Doctor Panel
  // feature. Admins only toggle access (canAddPreviousRecords); doctors
  // without permission never see the tab.
  const allowed = !!(me && me.canAddPreviousRecords);
  const navBtn = document.querySelector('[data-tab="historicalTab"]');
  if (navBtn) navBtn.classList.toggle('hidden', !allowed);
  const tab = document.getElementById('historicalTab');
  if (tab && !allowed){
    tab.innerHTML = '<div class="np-panel"><div class="np-panel__body"><div class="np-empty"><div class="np-empty__title">Previous Records are disabled</div><div class="np-empty__sub">Ask your clinic admin to enable this feature for your account.</div></div></div></div>';
  }
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

  // v3.4.10 FIX — "My Profile" and "Settings" used to open the same tab.
  // Now: data-action="open-profile" → dedicated profile modal.
  //      data-go="settingsTab"     → Settings tab.
  $$('#profileDropdown [data-action="open-profile"]').forEach(btn => {
    btn.addEventListener('click', () => {
      close();
      openMyProfile();
    });
  });
  $$('#profileDropdown [data-go]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-go');
      const sectionKey = btn.getAttribute('data-section');
      setActiveTab(tab); close();
      if (sectionKey === 'password'){
        const el = document.getElementById('setting-password');
        if (el) el.scrollIntoView({ behavior:'smooth', block:'start' });
      }
    });
  });
}

/* ---------- v3.4.10: My Profile modal ---------- */
let _myProfileCache = null;
async function openMyProfile(){
  try {
    const me = _myProfileCache || await api('/doctor/me');
    _myProfileCache = me;
    const clean = String(me.name || '').replace(/^\s*(dr\.?\s+)+/i, '').trim();
    const displayName = clean ? ('Dr. ' + clean) : 'Doctor';
    const initials = (clean || 'D').split(/\s+/).map(s => s[0]).slice(0,2).join('').toUpperCase();
    $('#myProfileName').textContent = displayName;
    $('#myProfileSpec').textContent = me.specialization || 'Pediatrician';
    const avatar = $('#myProfileAvatar');
    if (me.photoUrl) avatar.innerHTML = `<img src="${escapeHtml(me.photoUrl)}" alt="${escapeHtml(displayName)}">`;
    else avatar.innerHTML = `<span>${escapeHtml(initials)}</span>`;
    const badges = [];
    if (me.qualification) badges.push(`<span class="np-badge np-badge--blue">${escapeHtml(me.qualification)}</span>`);
    if (me.registrationNumber) badges.push(`<span class="np-badge np-badge--mint">Reg. ${escapeHtml(me.registrationNumber)}</span>`);
    $('#myProfileBadges').innerHTML = badges.join(' ');
    $('#myProfileEmail').textContent = me.email || '—';
    $('#myProfilePhone').textContent = me.phone || '—';
    $('#myProfileQual').textContent = me.qualification || '—';
    $('#myProfileReg').textContent = me.registrationNumber || '—';
    $('#myProfileClinic').textContent = me.clinicName || '—';
    $('#myProfileClinicAddr').textContent = me.clinicAddress || '—';
  } catch (_){ /* still open the shell */ }
  npOpenModal('myProfileModal');
}
function closeMyProfile(){ npCloseModal('myProfileModal'); }
window.openMyProfile = openMyProfile;
window.closeMyProfile = closeMyProfile;

const TAB_META = {
  dashboardTab:  { title:'Dashboard',           sub:"Welcome back — here's what's happening today." },
  waitingTab:    { title:'Waiting Room',        sub:'Patients currently waiting to be seen' },
  allTab:        { title:'Appointments',        sub:'Search and manage all your appointments' },
  consultTab:    { title:'Consultation',        sub:'Active patient consultation workspace' },
  rxArchiveTab:  { title:'Prescription Archive',sub:'All prescriptions you have issued' },
  earningsTab:   { title:'My Earnings',         sub:'Monthly revenue split, TDS, and settlement status' },
  historicalTab: { title:'Previous Records',  sub:'Add a past or offline visit to a patient timeline' },
  certificatesTab:{ title:'Medical Certificates', sub:'Certificates you have issued' },
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
  else if (tabId === 'dashboardTab'){ loadStats(); loadDashSnapshot(); loadDashWelcome(); }
  else if (tabId === 'rxArchiveTab') loadRxArchive();
  else if (tabId === 'earningsTab' && window.Earnings) Earnings.load();
  else if (tabId === 'certificatesTab') loadCertificates();
  else if (tabId === 'historicalTab') initHistoricalForm();
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
    if (typeof NPSkeleton !== 'undefined') NPSkeleton.kpis($('#statsBar'), 3);
  } catch (_) {}
  try {
    const s = await api('/doctor/stats');
    const today = Number(s.todayAppointments || 0);
    const done  = Number(s.completedToday || 0);
    const total = Number(s.totalConsults || 0);
    const rev   = Number(s.totalRevenue || 0);
    /* v3.4.13 — dedupe: "Today's Patients" / "Completed Today" duplicated
       each other (same two numbers), so the grid is now three cards:
       one day-of card (today + completed progress), one lifetime
       consults card, one lifetime revenue card. Remaining / waiting is
       surfaced by the header badge in the welcome strip. */
    $('#statsBar').innerHTML = `
      <div class="np-kpi np-kpi--blue" title="Total appointments scheduled for today (across all statuses) and how many you've completed.">
        <div class="np-kpi__label">Today's Patients</div>
        <div class="np-kpi__value">${today}</div>
        <div class="np-kpi__sub">${done} of ${today} completed</div>
      </div>
      <div class="np-kpi np-kpi--mint" title="All-time consultations you've completed since joining.">
        <div class="np-kpi__label">Total Consults</div>
        <div class="np-kpi__value">${total}</div>
        <div class="np-kpi__sub">All-time consultations</div>
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

/* ---------- Dashboard welcome section ---------- */
function updateDashWelcome(){
  try {
    const nameEl = $('#dashWelcomeName');
    const greetEl = $('#dashWelcomeGreeting');
    const dateEl  = $('#dashWelcomeDate');
    if (!nameEl || !greetEl || !dateEl) return;

    const raw = (($('#docName') && $('#docName').textContent) || '').trim() || 'Doctor';
    const display = raw === 'Doctor' ? raw : (/^dr\./i.test(raw) ? raw : 'Dr. ' + raw);
    nameEl.textContent = 'Welcome back, ' + display;

    const now = new Date();
    const h = now.getHours();
    const greet = h < 12 ? 'Good morning' : (h < 17 ? 'Good afternoon' : 'Good evening');
    greetEl.textContent = greet;

    try {
      dateEl.textContent = now.toLocaleDateString(undefined, {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      });
    } catch(_){ dateEl.textContent = now.toDateString(); }
  } catch(_){ /* welcome is decorative — never fail dashboard load */ }
}

function wireWelcomeStatJump(id, tabId){
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('click', () => {
    const tab = document.querySelector('[data-tab=' + tabId + ']');
    if (tab) tab.click();
  });
}

function setWelcomeStat(id, value){
  const el = document.querySelector('#' + id + ' .np-welcome__stat-value');
  if (el) el.textContent = String(value);
}

async function loadDashWelcome(){
  updateDashWelcome();
  wireWelcomeStatJump('dashStatToday',   'allTab');
  wireWelcomeStatJump('dashStatPending', 'allTab');
  wireWelcomeStatJump('dashStatWaiting', 'waitingTab');
  try {
    const [stats, waiting] = await Promise.all([
      api('/doctor/stats').catch(() => null),
      api('/doctor/waiting-room').catch(() => [])
    ]);

    const today     = stats ? Number(stats.todayAppointments || 0) : 0;
    const completed = stats ? Number(stats.completedToday || 0) : 0;
    const pending   = Math.max(0, today - completed);
    const waitCount = Array.isArray(waiting) ? waiting.length : 0;

    setWelcomeStat('dashStatToday',   today);
    setWelcomeStat('dashStatPending', pending);
    setWelcomeStat('dashStatWaiting', waitCount);

    const badge = document.getElementById('dashWaitingBadge');
    if (badge){
      badge.textContent = waitCount > 0
        ? waitCount + ' patient' + (waitCount === 1 ? '' : 's') + ' waiting'
        : 'Waiting room: all clear';
      badge.classList.toggle('is-active', waitCount > 0);
      badge.onclick = () => {
        const tab = document.querySelector('[data-tab=waitingTab]');
        if (tab) tab.click();
      };
    }
  } catch(_){}
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
  // Issue 4 — auto-cancelled (unpaid-expired) bookings are hidden by default.
  const hideAutoEl = $('#apptHideAutoCancelled');
  if (!hideAutoEl || hideAutoEl.checked) {
    arr = arr.filter(a => !(a.status === 'CANCELLED' && a.paymentStatus === 'FAILED' && /auto-cancelled/i.test(a.notes || '')));
  }
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
  ['apptSearch','apptStatusFilter','apptTypeFilter','apptSort','apptHideAutoCancelled'].forEach(id => {
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
  // Feature 2 — medical certificate from this appointment (completed or manual records).
  // closeOverflowMenus() runs FIRST (and openCertModal → npOpenModal closes
  // them again) so the portaled dropdown can never linger above the modal.
  if (a.status === 'COMPLETED' || a.source === 'MANUAL') {
    overflowItems.push(`<button class="np-overflow-item" type="button" onclick="event.stopPropagation(); closeOverflowMenus(); openCertModal(__apptById('${escapeHtml(a.id)}'))">
      <svg class="np-overflow-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M12 11v6M9 14h6"/></svg>
      Medical certificate
    </button>`);
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
        ${sourceBadge(a.source)}
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
  // v3.4.11 FIX — route through NPBackNav.routeHashNav() so a spurious
  // mobile-WebKit popstate doesn't get misread as a Back press and bounce
  // the user to the Dashboard (see NPBackNav.routeHashNav for details).
  if (window.NPBackNav && typeof NPBackNav.routeHashNav === 'function'){
    NPBackNav.routeHashNav(() => { location.hash = '#consult/' + id; });
  } else {
    location.hash = '#consult/' + id;
  }
}

// Resolve an appointment object from whichever cache holds it (all-list,
// waiting room, or the currently open consultation) for modal pre-fill.
function __apptById(id){
  if (currentAppointment && currentAppointment.id === id) return currentAppointment;
  const fromAll = (allAppointmentsCache || []).find(x => x.id === id);
  if (fromAll) return fromAll;
  return { id };
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
        ${statusBadge(a.status)} ${typeBadge(a.consultationType)} ${paymentBadge(a.paymentStatus)} ${sourceBadge(a.source)}
      </div>
      ${a.source === 'MANUAL' ? `<div class="np-callout np-callout--info" style="margin-bottom:.6rem; font-size:.82rem;">Added manually by clinic staff${a.addedByRole ? ' (' + escapeHtml(String(a.addedByRole).toLowerCase()) + ')' : ''}. This is not a NeoKidsPro booking.</div>` : ''}
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
        ${a.source === 'MANUAL' && a.diagnosis ? `
          <div class="np-field"><div class="np-field__label">Diagnosis</div>
            <div style="background:var(--np-surface); padding:.7rem .85rem; border-radius:10px; border:1px solid var(--np-border); font-size:.9rem;">
              ${escapeHtml(a.diagnosis)}
            </div>
          </div>` : ''}
        ${a.source === 'MANUAL' && a.manualPrescriptionUrl ? `
          <div class="np-field"><div class="np-field__label">Uploaded prescription</div>
            <a class="np-btn np-btn--ghost np-btn--sm" href="${escapeHtml(a.manualPrescriptionUrl)}" target="_blank" rel="noopener">📎 View uploaded file</a>
          </div>` : ''}
        ${a.source === 'MANUAL' && a.followUpDate ? `
          <div class="np-field"><div class="np-field__label">Follow-up date</div>
            <div>${escapeHtml(fmtDate(a.followUpDate))}</div>
          </div>` : ''}
        <div class="np-row" style="gap:.5rem; margin-top:.85rem; flex-wrap:wrap;">
          ${(a.status === 'COMPLETED' || a.source === 'MANUAL') ? `<button type="button" class="np-btn np-btn--ghost np-btn--sm" onclick="openCertModal(__apptById('${escapeHtml(a.id)}'))">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M12 11v6M9 14h6"/></svg>
            Generate Medical Certificate
          </button>` : ''}
        </div>
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
            ${statusBadge(v.status)} ${typeBadge(v.consultationType)} ${sourceBadge(v.source)}
          </div>
          ${v.primaryProblem ? `<div style="font-size:.88rem; margin-bottom:.25rem;"><b>Complaint:</b> ${escapeHtml(v.primaryProblem)}</div>` : ''}
          ${v.notes ? `<div style="font-size:.85rem;" class="np-mut"><b>Notes:</b> ${escapeHtml(v.notes)}</div>` : ''}
          <div class="np-row" style="gap:.5rem; margin-top:.4rem; flex-wrap:wrap;">
            ${v.hasPrescription && v.prescriptionUrl ? `<a class="np-btn np-btn--sm" href="${escapeHtml(v.prescriptionUrl)}" target="_blank" rel="noopener">📄 Prescription PDF</a>` : ''}
            ${v.manualPrescriptionUrl ? `<a class="np-btn np-btn--sm" href="${escapeHtml(v.manualPrescriptionUrl)}" target="_blank" rel="noopener">📎 Uploaded Rx</a>` : ''}
            ${v.meetLink ? `<a class="np-btn np-btn--ghost np-btn--sm" href="${escapeHtml(v.meetLink)}" target="_blank" rel="noopener">Meet</a>` : ''}
          </div>
        </div>
      </article>`).join('');

    const rxHtml = (h.prescriptions || []).map(rx => `
      <article class="np-history-rx">
        <div class="np-row" style="justify-content:space-between; align-items:center; margin-bottom:.25rem;">
          <b>${escapeHtml(fmtDate(rx.visitDate))}</b> ${rxSourceBadge(rx.source)}${rx.createdByRole === 'RECEPTIONIST' ? ' <span class="np-badge np-badge--violet" title="Entered at the clinic front desk"><span class="np-badge__dot"></span>by reception</span>' : ''}
          ${rx.pdfUrl ? `<a class="np-btn np-btn--sm" href="${escapeHtml(rx.pdfUrl)}" target="_blank" rel="noopener">View PDF</a>` : ''}
          ${rx.manualUrl ? `<a class="np-btn np-btn--sm" href="${escapeHtml(rx.manualUrl)}" target="_blank" rel="noopener">View uploaded file</a>` : ''}
        </div>
        <div style="font-size:.88rem;"><b>Diagnosis:</b> ${escapeHtml(rx.diagnosis || '—')}</div>
        ${rx.chiefComplaint ? `<div style="font-size:.85rem;" class="np-mut"><b>Complaint:</b> ${escapeHtml(rx.chiefComplaint)}</div>` : ''}
        ${rx.medications && rx.medications.length ? `<div style="font-size:.82rem; margin-top:.3rem;">${
          rx.medications.map(m => `• ${escapeHtml(m.name||'')} ${escapeHtml(m.dose||'')} ${escapeHtml(m.frequency||'')} × ${escapeHtml(m.duration||'')}`).join('<br/>')
        }</div>` : ''}
        ${rx.followUpDate ? `<div class="np-mut" style="font-size:.82rem; margin-top:.25rem;">Follow-up: ${escapeHtml(fmtDate(rx.followUpDate))}</div>` : ''}
      </article>`).join('');

    // v3.4.9 (part 4) — Patient History Previous Records visibility fix:
    // every record now has an explicit View action AND the whole card is
    // clickable, both opening the existing View Previous Record modal
    // (hrViewModal from historical-fix.js) so doctors can inspect the
    // full record, its attachments and metadata directly from history.
    const previousHtml = (h.previousRecords || []).map(pr => `
      <article class="np-history-rx hr-history-prev" data-prev-view="${escapeHtml(pr.id)}" style="cursor:pointer;" role="button" tabindex="0">
        <div class="np-row" style="justify-content:space-between; align-items:center; margin-bottom:.25rem;">
          <b>${escapeHtml(fmtDate(pr.recordDate))}</b>
          <span class="np-row" style="gap:.4rem;">
            <button type="button" class="np-btn np-btn--ghost np-btn--sm" data-prev-view="${escapeHtml(pr.id)}">View</button>
            ${pr.attachmentUrl ? `<a class="np-btn np-btn--sm" href="${escapeHtml(pr.attachmentUrl)}" target="_blank" rel="noopener">Open attachment</a>` : ''}
          </span>
        </div>
        ${pr.diagnosis ? `<div style="font-size:.88rem;"><b>Diagnosis:</b> ${escapeHtml(pr.diagnosis)}</div>` : ''}
        ${(function(){ const n = stripHrExtras(pr.notes); return n ? `<div style="font-size:.85rem;" class="np-mut"><b>Notes:</b> ${escapeHtml(n)}</div>` : ''; })()}
        ${pr.treatment ? `<div style="font-size:.85rem;" class="np-mut"><b>Treatment:</b> ${escapeHtml(pr.treatment)}</div>` : ''}
        ${pr.medications ? `<div style="font-size:.85rem;" class="np-mut"><b>Medications:</b> ${escapeHtml(pr.medications)}</div>` : ''}
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
      ${(h.previousRecords||[]).length ? `
        <div class="np-field" style="margin:.85rem 0 .5rem;">
          <div class="np-field__label">Previous Records (${h.previousRecords.length})</div>
        </div>
        ${previousHtml}` : ''}
      ${(h.prescriptions||[]).length ? `
        <div class="np-field" style="margin:.85rem 0 .5rem;">
          <div class="np-field__label">Prescriptions (${h.prescriptions.length})</div>
        </div>
        ${rxHtml}` : ''}
    `;
    // v3.4.9 (part 4) — Previous Records in Patient History are now
    // actionable: the View button and the whole card open the existing
    // View Previous Record modal (historical-fix.js). Fallback: jump to
    // the Previous Records tab if the modal hook isn't available.
    slot.querySelectorAll('[data-prev-view]').forEach(el => {
      const openPrev = (e) => {
        e.stopPropagation();
        const rid = el.getAttribute('data-prev-view');
        if (typeof window.hrOpenView === 'function') { window.hrOpenView(rid); return; }
        const navBtn = document.querySelector('[data-tab="historicalTab"]');
        if (navBtn) navBtn.click();
      };
      el.addEventListener('click', openPrev);
      if (el.tagName === 'ARTICLE') el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPrev(e); }
      });
    });
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
    applyModeVisibility(d);
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

// v3.4.14 — Consultation-mode-aware settings.
// Doctors only see configuration that matches how they actually consult:
//   ONLINE  only → hide practice-location card, in-person hours, in-person fee
//   OFFLINE only → hide online hours and online fee
//   BOTH (hybrid) → everything stays visible
function applyModeVisibility(d){
  const mode = String((d && d.consultationModes) || 'BOTH').toUpperCase();
  const showOnline  = mode === 'BOTH' || mode === 'ONLINE';
  const showOffline = mode === 'BOTH' || mode === 'OFFLINE';

  const _show = (id, show) => { const el = document.getElementById(id); if (el) el.classList.toggle('hidden', !show); };

  _show('setting-clinic', showOffline);
  _show('availOnlineFrom',  showOnline);
  _show('availOnlineTo',    showOnline);
  _show('availOfflineFrom', showOffline);
  _show('availOfflineTo',   showOffline);
  _show('feeOnlineField',  showOnline);
  _show('feeOfflineField', showOffline);

  const notice = document.getElementById('availModeNotice');
  if (notice) {
    if (mode === 'ONLINE') {
      notice.textContent = 'You consult online only — in-person availability and practice-location settings are hidden.';
      notice.classList.remove('hidden');
    } else if (mode === 'OFFLINE') {
      notice.textContent = 'You consult in person only — online availability and online fee settings are hidden.';
      notice.classList.remove('hidden');
    } else {
      notice.textContent = '';
      notice.classList.add('hidden');
    }
  }
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
    // v3.4.14 — only send the availability fields relevant to this doctor's
    // consultation mode; mode-irrelevant fields are omitted entirely so the
    // server-side mode guard never trips on hidden inputs.
    const mode = String((doctorCache && doctorCache.consultationModes) || 'BOTH').toUpperCase();
    const body = {
      slotDuration: Number($('#slotDurationVal').value || 15),
      workingDays:  $('#workingDaysVal').value || '',
      isAvailable:  !!e.target.isAvailable.checked
    };
    if (mode === 'BOTH' || mode === 'ONLINE') {
      body.availableFromOnline = readTimePicker('availableFromOnline');
      body.availableToOnline   = readTimePicker('availableToOnline');
    }
    if (mode === 'BOTH' || mode === 'OFFLINE') {
      body.availableFromOffline = readTimePicker('availableFromOffline');
      body.availableToOffline   = readTimePicker('availableToOffline');
    }
    function _hm(s){ if (!s) return null; const m = String(s).match(/^(\d{1,2}):(\d{2})$/); return m ? (Number(m[1])*60 + Number(m[2])) : null; }
    const pairs = [];
    if (mode === 'BOTH' || mode === 'ONLINE')  pairs.push(['Online',  body.availableFromOnline,  body.availableToOnline]);
    if (mode === 'BOTH' || mode === 'OFFLINE') pairs.push(['Offline', body.availableFromOffline, body.availableToOffline]);
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
    try { await api('/doctor/clinic', { method:'PUT', body }); alert('Practice location saved.'); }
    catch (ex){ alert(ex.message || 'Could not save'); }
  });
  $('#feesForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    // v3.4.14 — only send the fee relevant to this doctor's consultation mode.
    const mode = String((doctorCache && doctorCache.consultationModes) || 'BOTH').toUpperCase();
    const body = {};
    if (mode === 'BOTH' || mode === 'ONLINE')  body.onlineConsultFee   = Number(e.target.onlineConsultFee.value || 0);
    if (mode === 'BOTH' || mode === 'OFFLINE') body.physicalConsultFee = Number(e.target.physicalConsultFee.value || 0);
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



/* =====================================================================
   Feature 1/1A — Historical / Manual Appointments
   Feature 2    — Medical Certificates
   Feature 3    — Digital Signature
   ===================================================================== */

let _histFormWired = false;
let _certState = { patient: null, templates: [], editingAppt: null, editingCert: null, durationType: 'DATE_RANGE', consultMode: null, toAuto: true, actionsCert: null };

/* ─── v3.4.0 — Modal portal ─────────────────────────────────────────
   Root cause of "certificate modal renders below the sidebar": the
   modal lived inside the scrollable main column while the sidebar is a
   fixed/sticky element with its own stacking context (z-index 40/50).
   On mobile drawers and any transformed/filtered ancestor, position:fixed
   is computed against that ancestor — so the dialog surfaced far below
   the viewport or beneath the drawer. Fix: move every modal to <body>
   once (a portal), so its fixed positioning is always viewport-relative
   and its z-index (1300) always wins over sidebar/header/overflow menu. */
function npPortalModal(id){
  const el = document.getElementById(id);
  if (el && el.parentNode !== document.body) document.body.appendChild(el);
  return el;
}
function npOpenModal(id){
  closeOverflowMenus();           // never leave a floating menu above a modal
  const el = npPortalModal(id);
  if (el) el.classList.remove('hidden');
  // v3.4.10 — push a history entry so device Back closes this modal first,
  // instead of exiting the page. Guarded by a flag to survive re-open cycles.
  try { if (window.NPBackNav) NPBackNav.pushModal(id); } catch(_){}
  return el;
}
function npCloseModal(id){
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
  try { if (window.NPBackNav) NPBackNav.popModal(id); } catch(_){}
}

function _toast(kind, msg){
  if (window.NPToast && NPToast[kind]) NPToast[kind](msg);
  else alert(msg);
}

/* ---------- Feature 1: Historical appointment form ----------
 * v3.4.6: The historical/previous-records UI has been fully refactored
 * into public/doctor/historical-fix.js (records-first layout with its
 * own Add/Edit/View modals). The legacy fields this function relied on
 * (#histPhone, #histName, DOB, etc.) no longer exist, so wiring here
 * would just no-op AND conflict with the new module's submit handler
 * on the shared #historicalForm.
 *
 * We therefore delegate to the new module's public entry-point when
 * available, and otherwise no-op. The legacy backend endpoint
 * (POST /doctor/historical-appointments) is unchanged and can still be
 * reached programmatically — nothing in the current UI calls it now
 * that the refactored panel uses /doctor/previous-records.
 */
function initHistoricalForm(){
  if (typeof window.initHistoricalForm === 'function' && window.initHistoricalForm !== initHistoricalForm){
    try { window.initHistoricalForm(); } catch(_) {}
  }
}

async function lookupHistoricalPatient(){
  const phone = ($('#histPhone').value || '').replace(/\D/g, '');
  const box = $('#histMatchBox');
  if (!/^[6-9]\d{9}$/.test(phone)) { _toast('error', 'Enter a valid 10-digit Indian mobile number'); return; }
  box.classList.remove('hidden');
  box.innerHTML = '<div class="np-mut" style="font-size:.85rem;">Searching…</div>';
  try {
    const res = await api('/doctor/appointments/lookup-patient?phone=' + encodeURIComponent(phone));
    const rows = (res && res.matches) || [];
    if (!rows.length){
      box.innerHTML = '<div class="np-mut" style="font-size:.85rem;">No existing patient with this number. A new patient will be created.</div>';
      $('#histPatientId').value = '';
      return;
    }
    box.innerHTML = rows.map(p => `
      <label style="display:flex; align-items:center; gap:.5rem; padding:.5rem; border:1px solid var(--np-border); border-radius:10px; cursor:pointer;">
        <input type="radio" name="histMatch" value="${escapeHtml(p.id)}">
        <span>
          <b>${escapeHtml(p.name)}</b>
          <span class="np-mut" style="font-size:.8rem;"> · ${p.dateOfBirth ? escapeHtml(fmtDate(p.dateOfBirth)) : 'DOB —'} · ${escapeHtml(p.gender||'')}</span>
        </span>
      </label>`).join('');
    box.querySelectorAll('input[name="histMatch"]').forEach(r => {
      r.addEventListener('change', () => {
        $('#histPatientId').value = r.value;
        const sel = rows.find(x => x.id === r.value);
        if (sel){
          if (!$('#histName').value) $('#histName').value = sel.name || '';
          if (sel.dateOfBirth && !form_dob().value) form_dob().value = String(sel.dateOfBirth).slice(0,10);
          const g = $('#historicalForm [name="gender"]');
          if (g && sel.gender && !g.value) g.value = sel.gender;
        }
      });
    });
    _toast('info', rows.length + ' patient(s) found. Select one to link, or leave unselected to create new.');
  } catch (ex){
    box.innerHTML = '<div class="np-error">' + escapeHtml(ex.message || 'Lookup failed') + '</div>';
  }
}
function form_dob(){ return $('#historicalForm [name="dateOfBirth"]'); }

async function submitHistorical(e){
  e.preventDefault();
  const form = e.target;
  const fd = new FormData();
  const g = (n) => (form.querySelector('[name="'+n+'"]') || {}).value || '';
  const file = ($('#histRxFile') && $('#histRxFile').files[0]) || null;

  fd.append('phone', g('phone').replace(/\D/g,''));
  fd.append('patientName', g('patientName').trim());
  if (g('parentName')) fd.append('parentName', g('parentName').trim());
  if (g('dateOfBirth')) fd.append('dateOfBirth', g('dateOfBirth'));
  if (g('gender')) fd.append('gender', g('gender'));
  if (g('email')) fd.append('email', g('email').trim());
  if (g('patientId') || $('#histPatientId').value) fd.append('patientId', $('#histPatientId').value);
  fd.append('linkConfirmed', $('#histLinkConfirmed').value || 'false');
  fd.append('date', g('date'));
  fd.append('consultationType', g('consultationType'));
  fd.append('reasonForVisit', g('reasonForVisit').trim());
  if (g('diagnosis')) fd.append('diagnosis', g('diagnosis').trim());
  if (g('notes')) fd.append('notes', g('notes').trim());
  if (g('followUpDate')) fd.append('followUpDate', g('followUpDate'));
  if (file) fd.append('prescriptionFile', file);

  const btn = $('#histSubmitBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const res = await api('/doctor/historical-appointments', { method:'POST', body: fd });
    _toast('success', 'Previous record added to ' + (res.patient ? res.patient.name : 'patient') + "'s timeline.");
    form.reset();
    $('#histPatientId').value = ''; $('#histLinkConfirmed').value = 'false';
    const box = $('#histMatchBox'); if (box) box.classList.add('hidden');
    if (typeof loadAll === 'function') loadAll();
  } catch (ex){
    // Smart-match conflict → show resolver.
    if (ex.status === 409 && ex.data && ex.data.code === 'PATIENT_LINK_REQUIRED'){
      showLinkConflict(ex.data.candidates || []);
    } else if (ex.status === 409 && ex.data && ex.data.code === 'SLOT_CONFLICT'){
      _toast('error', ex.data.error || 'A record for this date/time already exists.');
    } else {
      _toast('error', ex.message || 'Could not save previous record');
    }
  } finally {
    btn.disabled = false; btn.textContent = 'Save previous record';
  }
}

/* ---------- Smart-match conflict resolver ---------- */
let _linkCandidates = [];
function showLinkConflict(candidates){
  _linkCandidates = candidates;
  const list = $('#linkConflictList');
  list.innerHTML = candidates.map((p, i) => `
    <label style="display:flex; align-items:center; gap:.5rem; padding:.55rem; border:1px solid var(--np-border); border-radius:10px; cursor:pointer;">
      <input type="radio" name="linkCand" value="${escapeHtml(p.id)}" ${i===0?'checked':''}>
      <span>
        <b>${escapeHtml(p.name)}</b>
        <span class="np-mut" style="font-size:.8rem;"> · ${p.dateOfBirth ? escapeHtml(fmtDate(p.dateOfBirth)) : 'DOB —'} · ${escapeHtml(p.gender||'')}</span>
      </span>
    </label>`).join('');
  $('#linkConflictModal').classList.remove('hidden');
}
function closeLinkConflict(){ $('#linkConflictModal').classList.add('hidden'); }
function resolveLinkConflict(choice){
  if (choice === 'link'){
    const sel = document.querySelector('input[name="linkCand"]:checked');
    if (sel){ $('#histPatientId').value = sel.value; }
    $('#histLinkConfirmed').value = 'true';
  } else {
    $('#histPatientId').value = '';
    $('#histLinkConfirmed').value = 'true'; // user acknowledged conflict, wants separate
  }
  closeLinkConflict();
  // Auto-resubmit.
  const form = $('#historicalForm');
  if (form) form.requestSubmit();
}

/* ---------- Feature 2: Medical Certificates (v3.4.0 rework) ---------- */

/* Small formatting helpers for the patient picker. */
function _npInitials(name){
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function _npGenderLabel(g){
  return g === 'MALE' ? 'Male' : g === 'FEMALE' ? 'Female' : (g || '');
}
function _npPatientMeta(p){
  const bits = [];
  const gl = _npGenderLabel(p && p.gender);
  if (gl) bits.push(gl);
  const age = p && p.dateOfBirth ? calcAge(p.dateOfBirth) : '';
  if (age) bits.push(age.replace(/ yrs?$/, ' Years').replace(/ mo$/, ' Months'));
  return bits.join(' • ');
}
function _npPatientPhone(p){
  return p && p.phone ? `+91 ${String(p.phone).replace(/^(\d{5})(\d{5})$/, '$1 $2')}` : '';
}

async function loadCertificates(){
  const wrap = $('#certList');
  if (!wrap) return;
  wrap.innerHTML = '<div class="np-empty"><div class="np-empty__title">Loading…</div></div>';
  try {
    const rows = await api('/doctor/certificates');
    if (!rows.length){
      wrap.innerHTML = '<div class="np-empty"><div class="np-empty__title">No certificates yet</div><div class="np-empty__sub">Generate one from an appointment or click "+ New certificate".</div></div>';
    } else {
      wrap.innerHTML = rows.map(c => `
        <article class="np-cert-row">
          <div class="np-cert-row__meta">
            <span class="np-cert-row__date">${escapeHtml(fmtDate(c.issuedAt))}</span>
            <span class="np-cert-row__number">${escapeHtml(c.certificateNumber)}</span>
          </div>
          <div class="np-cert-row__body">
            <div class="np-cert-row__top">
              <div class="np-cert-row__who">
                <b>${escapeHtml(c.patientNameSnapshot || (c.patient && c.patient.name) || '—')}</b>
                <span class="np-pills">
                  <span class="np-badge np-badge--mint">${escapeHtml((c.templateKey||'GENERAL').replace(/_/g,' '))}</span>
                  ${(c.consultationType === 'ONLINE' || (c.appointment && c.appointment.consultationType === 'ONLINE'))
                    ? '<span class="np-badge np-badge--blue">Online</span>' : ''}
                </span>
              </div>
              <div class="np-row np-cert-row__actions">
                ${c.pdfUrl ? `<a class="np-btn np-btn--sm" href="${escapeHtml(c.pdfUrl)}" target="_blank" rel="noopener">View PDF</a>` : ''}
                <button type="button" class="np-btn np-btn--primary np-btn--sm" data-cert-send="${escapeHtml(c.id)}">Send</button>
                <button type="button" class="np-btn np-btn--ghost np-btn--sm" data-cert-edit="${escapeHtml(c.id)}">Edit</button>
              </div>
            </div>
            ${c.diagnosis ? `<div class="np-cert-row__diag"><b>Diagnosis:</b> ${escapeHtml(c.diagnosis)}</div>` : ''}
            <div class="np-mut np-cert-row__reason">${escapeHtml(c.reason || '')}</div>
          </div>
        </article>`).join('');
      wrap.querySelectorAll('[data-cert-edit]').forEach(btn => {
        btn.addEventListener('click', () => {
          const cert = rows.find(x => x.id === btn.getAttribute('data-cert-edit'));
          if (cert) openCertEdit(cert);
        });
      });
      wrap.querySelectorAll('[data-cert-send]').forEach(btn => {
        btn.addEventListener('click', () => {
          const cert = rows.find(x => x.id === btn.getAttribute('data-cert-send'));
          if (cert) openCertActions(cert);
        });
      });
    }
  } catch (ex){
    wrap.innerHTML = '<div class="np-error">' + escapeHtml(ex.message || 'Failed to load') + '</div>';
  }
  // wire "+ New certificate"
  const nb = $('#newCertBtn');
  if (nb && !nb.__wired){ nb.__wired = true; nb.addEventListener('click', () => openCertModal(null)); }
}

/* ── Certificate actions modal: View / Download / WhatsApp / Email ── */
function openCertActions(cert){
  _certState.actionsCert = cert;
  $('#certActionsTitle').textContent = cert.certificateNumber || 'Certificate';
  $('#certActionsSub').textContent =
    `${cert.patientNameSnapshot || (cert.patient && cert.patient.name) || '—'} · issued ${fmtDate(cert.issuedAt)}`;
  const view = $('#certActView'), dl = $('#certActDownload');
  if (cert.pdfUrl){
    view.href = cert.pdfUrl; view.style.display = '';
    dl.href = cert.pdfUrl;   dl.style.display = '';
    dl.setAttribute('download', `medical_certificate_${cert.certificateNumber || cert.id}.pdf`);
  } else {
    view.style.display = 'none'; dl.style.display = 'none';
  }
  // Email needs a patient address on file; reflect that before the click.
  const emailBtn = $('#certActEmail');
  const hasEmail = !!(cert.patient && cert.patient.email);
  emailBtn.disabled = false;
  emailBtn.title = hasEmail ? '' : 'No patient email on file — the server will report this';
  $('#certActStatus').textContent = '';
  npOpenModal('certActionsModal');
}
function closeCertActions(){ npCloseModal('certActionsModal'); _certState.actionsCert = null; }

async function sendCertificateChannel(channel){
  const cert = _certState.actionsCert;
  if (!cert) return;
  const status = $('#certActStatus');
  const btn = channel === 'whatsapp' ? $('#certActWa') : $('#certActEmail');
  btn.disabled = true;
  status.textContent = channel === 'whatsapp' ? 'Sending on WhatsApp…' : 'Sending email…';
  try {
    const r = await api('/doctor/certificates/' + encodeURIComponent(cert.id) + '/send', {
      method: 'POST', body: { channels: [channel] }
    });
    const st = (r.delivery && r.delivery[channel]) || 'sent';
    if (st === 'sent'){
      status.textContent = channel === 'whatsapp'
        ? '✓ Sent on WhatsApp (PDF attached).'
        : '✓ Email sent with the PDF attached.';
      _toast('success', channel === 'whatsapp' ? 'Certificate sent on WhatsApp.' : 'Certificate emailed.');
    } else if (st === 'no_email'){
      status.textContent = 'Patient has no email address on file.';
      _toast('error', 'Patient has no email on file');
    } else {
      status.textContent = 'Delivery failed' + (r.delivery && r.delivery.whatsappError ? `: ${r.delivery.whatsappError}` : '.') + ' Try again.';
      _toast('error', 'Delivery failed');
    }
  } catch (ex){
    status.textContent = ex.message || 'Delivery failed';
    _toast('error', ex.message || 'Delivery failed');
  } finally {
    btn.disabled = false;
  }
}

/* ── Duration segmented control + smart auto-date ── */
function setCertDuration(type){
  _certState.durationType = type === 'SINGLE_DAY' ? 'SINGLE_DAY' : 'DATE_RANGE';
  const single = _certState.durationType === 'SINGLE_DAY';
  $$('#certDurationSeg .np-seg__btn').forEach(b =>
    b.classList.toggle('is-active', b.getAttribute('data-duration') === _certState.durationType));
  $('#certSingleDayWrap').classList.toggle('hidden', !single);
  $('#certRangeWrap').classList.toggle('hidden', single);
  if (single){
    // Default the certificate date to today for one-tap issuing.
    if (!$('#certSingleDate').value) $('#certSingleDate').value = new Date().toISOString().slice(0,10);
  }
}

/* Auto-calculate the end date: fromDate + restDays (inclusive).
   10 Aug + 5 days of rest → ends 14 Aug. A manual edit of the To field
   marks it as overridden until From/rest changes again. */
function _npAddDays(iso, days){
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0,10);
}
function certAutoToDate(){
  const from = $('#certFrom').value;
  const rest = parseInt($('#certRestDays').value, 10);
  const autoEl = $('#certToAuto');
  if (from && rest >= 1){
    $('#certTo').value = _npAddDays(from, rest - 1);
    _certState.toAuto = true;
    if (autoEl) autoEl.textContent = '(auto)';
  }
}

/* Reverse direction: doctor edits End Date directly → recompute Days
   from Start/End (inclusive count, matching certAutoToDate's convention:
   10 Aug → 15 Aug = 6 days, 10 Aug → 12 Aug = 3 days). */
function certAutoRestDays(){
  const from = $('#certFrom').value;
  const to = $('#certTo').value;
  if (!from || !to) return;
  const fromD = new Date(from + 'T00:00:00');
  const toD = new Date(to + 'T00:00:00');
  if (isNaN(fromD.getTime()) || isNaN(toD.getTime())) return;
  const days = Math.round((toD - fromD) / 86400000) + 1;
  if (days >= 1) $('#certRestDays').value = days;
}

/* ── Consultation mode segmented control ── */
function setCertConsultMode(mode, hint){
  _certState.consultMode = mode === 'ONLINE' ? 'ONLINE' : 'OFFLINE';
  $$('#certConsultMode .np-seg__btn').forEach(b =>
    b.classList.toggle('is-active', b.getAttribute('data-mode') === _certState.consultMode));
  $('#certConsultModeHint').textContent = hint || (_certState.consultMode === 'ONLINE'
    ? 'Certificate will show "Teleconsultation / Online Consultation" with doctor details only.'
    : 'Certificate will include the clinic name, address and contact block.');
}

async function openCertModal(appointment){
  _certState.patient = null;
  _certState.editingAppt = appointment || null;
  _certState.editingCert = null;
  _certState.toAuto = true;
  $('#certModalTitle').textContent = 'Generate Medical Certificate';
  $('#certSubmitBtn').textContent = 'Generate certificate PDF';
  $('#certApptId').value = appointment ? appointment.id : '';
  $('#certPatientId').value = '';
  $('#certPatientChosen').classList.add('hidden');
  $('#certPatientChosen').innerHTML = '';
  $('#certPatientSearch').value = '';
  $('#certPatientSearch').closest('.np-ppicker__searchwrap').style.display = '';
  $('#certPatientResults').classList.add('hidden');
  $('#certReason').value = '';
  $('#certDiagnosis').value = appointment ? (appointment.diagnosis || appointment.primaryProblem || '') : '';
  $('#certRestDays').value = '';
  $('#certFrom').value = ''; $('#certTo').value = ''; $('#certNotes').value = '';
  $('#certSingleDate').value = '';
  setCertDuration('DATE_RANGE');

  // Consultation mode: follow the appointment when there is one.
  setCertConsultMode(appointment && appointment.consultationType === 'ONLINE' ? 'ONLINE' : 'OFFLINE');

  // Load templates once.
  if (!_certState.templates.length){
    try { _certState.templates = await api('/doctor/certificates/templates'); }
    catch(_){ _certState.templates = [{key:'GENERAL',label:'General Medical Certificate'}]; }
  }
  $('#certTemplate').innerHTML = _certState.templates.map(t =>
    `<option value="${escapeHtml(t.key)}">${escapeHtml(t.label)}</option>`).join('');

  // If from an appointment, pre-fill the patient.
  if (appointment && appointment.patient){
    setCertPatient(appointment.patient);
  }
  npOpenModal('certModal');   // portals to <body> + closes any overflow menu
}
function closeCertModal(){ npCloseModal('certModal'); }

// Edit workflow — re-opens the same modal pre-filled from an issued
// certificate; submit performs PUT and regenerates the PDF server-side.
async function openCertEdit(cert){
  if (!cert) return;
  await openCertModal(null);
  _certState.editingCert = cert;
  $('#certModalTitle').textContent = 'Edit Medical Certificate';
  $('#certSubmitBtn').textContent = 'Update certificate';
  $('#certApptId').value = cert.appointmentId || '';
  const p = cert.patient && cert.patient.id
    ? cert.patient
    : { id: cert.patientId, name: cert.patientNameSnapshot || 'Patient', phone: '' };
  if (p.id) setCertPatient(p);
  if (cert.templateKey) $('#certTemplate').value = cert.templateKey;
  $('#certReason').value = cert.reason || '';
  $('#certDiagnosis').value = cert.diagnosis || '';
  $('#certRestDays').value = (cert.restDays != null) ? cert.restDays : '';
  $('#certFrom').value = cert.fromDate ? String(cert.fromDate).slice(0,10) : '';
  $('#certTo').value = cert.toDate ? String(cert.toDate).slice(0,10) : '';
  $('#certNotes').value = cert.additionalNotes || '';
  if (cert.durationType === 'SINGLE_DAY'){
    setCertDuration('SINGLE_DAY');
    $('#certSingleDate').value = cert.certificateDate ? String(cert.certificateDate).slice(0,10) : '';
  }
  if (cert.consultationType) setCertConsultMode(cert.consultationType);
}

/* Selected patient → prominent card with a Change button (the tiny pill
   design is gone for good). */
function setCertPatient(p){
  _certState.patient = p;
  $('#certPatientId').value = p.id;
  const box = $('#certPatientChosen');
  box.classList.remove('hidden');
  box.innerHTML = `
    <div class="np-ppicker__card">
      <span class="np-ppicker__card-avatar">${escapeHtml(_npInitials(p.name))}</span>
      <div class="np-ppicker__card-main">
        <div class="np-ppicker__card-name">${escapeHtml(p.name || 'Patient')}</div>
        <div class="np-ppicker__card-meta">${escapeHtml([_npPatientMeta(p), _npPatientPhone(p)].filter(Boolean).join(' · '))}</div>
      </div>
      <button type="button" class="np-btn np-btn--ghost np-btn--sm np-ppicker__change" onclick="clearCertPatient()">Change patient</button>
    </div>`;
  $('#certPatientResults').classList.add('hidden');
  $('#certPatientSearch').value = '';
  // Hide the search box while a patient is selected — the card owns the slot.
  $('#certPatientSearch').closest('.np-ppicker__searchwrap').style.display = 'none';
}
function clearCertPatient(){
  _certState.patient = null; $('#certPatientId').value = '';
  $('#certPatientChosen').classList.add('hidden');
  $('#certPatientChosen').innerHTML = '';
  const wrap = $('#certPatientSearch').closest('.np-ppicker__searchwrap');
  wrap.style.display = '';
  $('#certPatientSearch').focus();
}

/* Patient search (debounced) — rich dropdown rows with avatar, name,
   gender • age and phone. Uses event delegation (no inline JSON in
   onclick attributes — that broke on names containing quotes). */
let _certSearchTimer = null;
let _certSearchRows = [];
function setupCertPatientSearch(){
  const inp = $('#certPatientSearch');
  if (!inp || inp.__wired) return; inp.__wired = true;
  const box = $('#certPatientResults');

  inp.addEventListener('input', () => {
    clearTimeout(_certSearchTimer);
    const q = inp.value.trim();
    if (q.length < 2){ box.classList.add('hidden'); return; }
    _certSearchTimer = setTimeout(async () => {
      try {
        const rows = await api('/doctor/patients/search?q=' + encodeURIComponent(q));
        _certSearchRows = rows || [];
        if (!_certSearchRows.length){
          box.classList.remove('hidden');
          box.innerHTML = '<div class="np-ppicker__empty">No patients match "' + escapeHtml(q) + '"</div>';
          return;
        }
        box.classList.remove('hidden');
        box.innerHTML = _certSearchRows.slice(0,8).map((p, i) => `
          <button type="button" class="np-ppicker__item" role="option" data-cert-pick="${i}">
            <span class="np-ppicker__avatar">${escapeHtml(_npInitials(p.name))}</span>
            <span class="np-ppicker__item-main">
              <span class="np-ppicker__item-name">${escapeHtml(p.name)}</span>
              <span class="np-ppicker__item-meta">${escapeHtml(_npPatientMeta(p))}</span>
            </span>
            <span class="np-ppicker__item-phone">${escapeHtml(_npPatientPhone(p))}</span>
          </button>`).join('');
      } catch(_){}
    }, 300);
  });

  box.addEventListener('click', (e) => {
    const item = e.target.closest('[data-cert-pick]');
    if (!item) return;
    const p = _certSearchRows[Number(item.getAttribute('data-cert-pick'))];
    if (p) setCertPatient(p);
  });

  // Close the dropdown on outside tap (mobile) / click.
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#certPatientPicker')) box.classList.add('hidden');
  });

  // Duration segmented control.
  $$('#certDurationSeg .np-seg__btn').forEach(b => {
    if (b.__wired) return; b.__wired = true;
    b.addEventListener('click', () => setCertDuration(b.getAttribute('data-duration')));
  });
  // Consultation mode segmented control.
  $$('#certConsultMode .np-seg__btn').forEach(b => {
    if (b.__wired) return; b.__wired = true;
    b.addEventListener('click', () => setCertConsultMode(b.getAttribute('data-mode')));
  });

  // Smart auto-date: From/rest changes recompute To unless overridden;
  // editing To manually marks it as doctor-controlled.
  const fromEl = $('#certFrom'), restEl = $('#certRestDays'), toEl = $('#certTo');
  if (fromEl && !fromEl.__wired){ fromEl.__wired = true; fromEl.addEventListener('change', certAutoToDate); }
  if (restEl && !restEl.__wired){ restEl.__wired = true; restEl.addEventListener('input', certAutoToDate); }
  if (toEl && !toEl.__wired){
    toEl.__wired = true;
    toEl.addEventListener('input', () => {
      _certState.toAuto = false;
      const autoEl = $('#certToAuto');
      if (autoEl) autoEl.textContent = '(manual)';
      certAutoRestDays();
    });
  }
}

async function submitCert(e){
  e.preventDefault();
  const btn = $('#certSubmitBtn');
  const patientId = $('#certPatientId').value;
  const appointmentId = $('#certApptId').value;
  if (!patientId && !appointmentId){ _toast('error', 'Select a patient first'); return; }

  const single = _certState.durationType === 'SINGLE_DAY';
  if (single && !$('#certSingleDate').value){
    _toast('error', 'Pick the certificate date'); return;
  }

  const body = {
    templateKey: $('#certTemplate').value,
    reason: $('#certReason').value.trim(),
    diagnosis: $('#certDiagnosis').value.trim() || undefined,
    restDays: $('#certRestDays').value ? Number($('#certRestDays').value) : undefined,
    durationType: _certState.durationType,
    certificateDate: single ? $('#certSingleDate').value : undefined,
    fromDate: single ? undefined : ($('#certFrom').value || undefined),
    toDate: single ? undefined : ($('#certTo').value || undefined),
    additionalNotes: $('#certNotes').value.trim() || undefined,
    // Standalone certificates have no appointment to derive the mode from —
    // send the doctor's pick. Appointment-linked certificates snapshot the
    // mode server-side from the appointment itself.
    consultationType: _certState.consultMode
  };
  if (appointmentId) body.appointmentId = appointmentId;
  else body.patientId = patientId;

  const editing = _certState.editingCert;
  btn.disabled = true; btn.textContent = editing ? 'Updating…' : 'Generating…';
  try {
    const cert = editing
      ? await api('/doctor/certificates/' + encodeURIComponent(editing.id), { method:'PUT', body })
      : await api('/doctor/certificates', { method:'POST', body });
    _toast('success', 'Certificate ' + cert.certificateNumber + (editing ? ' updated.' : ' generated.'));
    _certState.editingCert = null;
    closeCertModal();
    if (!editing && cert.pdfUrl) window.open(cert.pdfUrl, '_blank', 'noopener');
    // Surface per-channel delivery so the doctor knows what went out.
    if (!editing && cert.delivery){
      const bits = [];
      if (cert.delivery.whatsapp === 'sent') bits.push('WhatsApp ✓');
      if (cert.delivery.email === 'sent') bits.push('Email ✓');
      if (cert.delivery.email === 'no_email') bits.push('no patient email on file');
      if (bits.length) _toast('success', 'Delivered: ' + bits.join(' · '));
    }
    loadCertificates();
  } catch (ex){
    _toast('error', ex.message || 'Could not generate certificate');
  } finally {
    btn.disabled = false; btn.textContent = editing ? 'Update certificate' : 'Generate certificate PDF';
  }
}

/* ---------- Feature 3: Digital Signature ---------- */
async function loadSignature(){
  try {
    const s = await api('/doctor/signature');
    const img = $('#sigPreviewImg'), empty = $('#sigPreviewEmpty');
    if (s.signatureUrl){
      img.src = s.signatureUrl + '?t=' + Date.now();
      img.style.display = 'block'; empty.style.display = 'none';
    } else {
      img.style.display = 'none'; empty.style.display = 'block';
    }
    if (s.registrationNumber) $('#regNumInput').value = s.registrationNumber;
  } catch(_){}
}

function setupSignature(){
  const form = $('#signatureForm');
  if (!form || form.__wired) return; form.__wired = true;
  const input = $('#sigInput');
  // Live preview before save.
  input.addEventListener('change', () => {
    const f = input.files[0];
    const wrap = $('#sigLiveWrap'), img = $('#sigLiveImg');
    if (!f){ wrap.classList.add('hidden'); return; }
    if (f.size > 1024*1024){ _toast('error', 'Signature image must be under 1 MB'); input.value=''; wrap.classList.add('hidden'); return; }
    const reader = new FileReader();
    reader.onload = (ev) => { img.src = ev.target.result; wrap.classList.remove('hidden'); };
    reader.readAsDataURL(f);
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = input.files[0];
    if (!f){ _toast('error', 'Choose a signature image first'); return; }
    const fd = new FormData(); fd.append('signature', f);
    try {
      await api('/doctor/signature', { method:'POST', body: fd });
      _toast('success', 'Signature saved. It will appear on new documents.');
      $('#sigLiveWrap').classList.add('hidden'); input.value='';
      loadSignature();
    } catch (ex){ _toast('error', ex.message || 'Upload failed'); }
  });
  $('#sigRemoveBtn').addEventListener('click', async () => {
    const ok = window.NPModal ? await NPModal.confirm({ title:'Remove signature?', message:'Your signature will be removed from future documents.', danger:true, okText:'Remove' }) : confirm('Remove signature?');
    if (!ok) return;
    try { await api('/doctor/signature', { method:'DELETE' }); _toast('success','Signature removed'); loadSignature(); }
    catch (ex){ _toast('error', ex.message || 'Could not remove'); }
  });
  $('#regNumForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/doctor/registration-number', { method:'PUT', body:{ registrationNumber: $('#regNumInput').value.trim() } });
      _toast('success', 'Registration number saved.');
    } catch (ex){ _toast('error', ex.message || 'Could not save'); }
  });
}

/* ---------- Wire-up on init ---------- */
function setupFeatureUI(){
  // Portal every modal to <body> once at startup — the root-cause fix for
  // dialogs rendering beneath the fixed sidebar / below the viewport.
  ['patientModal','certModal','certActionsModal','linkConflictModal','rescheduleModal','cancelModal']
    .forEach(npPortalModal);
  setupCertPatientSearch();
  setupSignature();
  const certForm = $('#certForm');
  if (certForm && !certForm.__wired){ certForm.__wired = true; certForm.addEventListener('submit', submitCert); }
  // Refresh signature preview when entering settings.
  const settingsBtn = document.querySelector('[data-tab="settingsTab"]');
  if (settingsBtn && !settingsBtn.__sigWired){
    settingsBtn.__sigWired = true;
    settingsBtn.addEventListener('click', loadSignature);
  }
}

/* =====================================================================
 * v3.4.10 — Global mobile back-button navigation via History API.
 *
 * Contract: whenever the app opens something the user *perceives* as a
 * new screen — a modal, drawer, preview, overlay or nested view — it
 * calls NPBackNav.pushModal(id). Pressing the device Back button then
 * closes THAT screen instead of exiting the page. When there are no
 * more open overlays and the user is not on the dashboard, Back returns
 * them to the dashboard; only from the dashboard does the browser exit
 * naturally.
 *
 * Expected flow (Dashboard → Patient → Previous Record → Preview):
 *   Preview → Previous Record → Patient → Dashboard → (exit)
 *
 * The manager is idempotent, safe to call before init, and never blocks
 * ordinary navigation — all guarding happens in popstate.
 * ===================================================================== */
window.NPBackNav = (function(){
  const stack = [];               // { type:'modal', id, marker }
  let installed = false;
  let internalPop = false;
  let internalHashNav = false;    // v3.4.11 FIX — see routeHashNav() below.

  function markerKey(){ return 'np-nav-' + Date.now() + '-' + Math.random().toString(36).slice(2,7); }

  // v3.4.11 FIX — Critical Bug: "View" redirects to Dashboard instead of
  // opening the appointment.
  //
  // Root cause: plain in-app routing like `location.hash = '#consult/'+id`
  // (used by goToConsult()) only creates a new hash entry and is NOT a
  // real Back-button traversal. On desktop Chrome that's all that happens.
  // But on mobile WebKit (iOS/Android Safari-based browsers), assigning
  // location.hash ALSO dispatches a spurious 'popstate' event as a
  // compatibility quirk left over from before 'hashchange' existed —
  // desktop Chrome does not do this.
  //
  // That spurious popstate landed in onPopState() Case 3 below: no modal
  // was open (stack is empty — goToConsult never pushes one), and the tab
  // had just switched to 'consultTab', which is "not dashboardTab" — so
  // the guard concluded the user pressed Back from a non-dashboard screen
  // and immediately called goToDashboard(), yanking them straight back to
  // the Dashboard the instant "View" was clicked.
  //
  // Fix: any code path that performs in-app hash routing (not an actual
  // Back-button press) must run through routeHashNav() so a same-tick
  // spurious popstate is swallowed instead of triggering that guard.
  function routeHashNav(fn){
    internalHashNav = true;
    try { fn(); }
    finally {
      // The spurious popstate (when the browser fires one at all) is
      // queued as part of the same hash-change navigation and is
      // processed before this timer fires, so it's still caught here.
      setTimeout(() => { internalHashNav = false; }, 0);
    }
  }

  function currentTab(){
    const active = document.querySelector('.tab-btn.active');
    return (active && active.dataset && active.dataset.tab) || 'dashboardTab';
  }

  function anyOpen(){ return stack.length > 0; }

  function pushModal(id){
    if (!id) return;
    // De-dupe: if the same modal is already on top, don't push again.
    if (stack.length && stack[stack.length-1].id === id) return;
    const marker = markerKey();
    try {
      history.pushState({ npNav: true, marker: marker, kind: 'modal', id: id }, '',
        location.pathname + location.search + location.hash);
    } catch(_){}
    stack.push({ type:'modal', id: id, marker: marker });
  }

  function popModal(id){
    // The modal is being closed programmatically (X button, save, etc.).
    // Unwind history if our marker is still on top.
    const idx = stack.map(s => s.id).lastIndexOf(id);
    if (idx < 0) return;
    // Remove from stack; step history back once if we're on top.
    const wasTop = idx === stack.length - 1;
    stack.splice(idx, 1);
    if (wasTop && !internalPop){
      try {
        internalPop = true;
        history.back();
        // internalPop is cleared inside the popstate handler below.
      } catch(_){ internalPop = false; }
    }
  }

  function closeTopModal(){
    const top = stack[stack.length - 1];
    if (!top) return false;
    stack.pop();
    // Close the DOM element without re-triggering history.back()
    const el = document.getElementById(top.id);
    if (el) el.classList.add('hidden');
    return true;
  }

  function goToDashboard(){
    try {
      const btn = document.querySelector('[data-tab="dashboardTab"]');
      if (btn) btn.click();
      else if (typeof window.setActiveTab === 'function') window.setActiveTab('dashboardTab');
    } catch(_){}
  }

  function onPopState(ev){
    // Case 1: this popstate is the internal history.back() we fired from
    // popModal() — just swallow it and stop.
    if (internalPop){ internalPop = false; return; }

    // Case 1b: this popstate is a spurious one fired by our own in-app
    // hash routing (see routeHashNav() above), not a real Back press —
    // swallow it too.
    if (internalHashNav){ internalHashNav = false; return; }

    // Case 2: an overlay is open → close the top one only.
    if (anyOpen()){
      closeTopModal();
      return;
    }

    // Case 3: nothing is open but the user is NOT on the dashboard.
    // Move them to the dashboard instead of leaving the page.
    const tab = currentTab();
    if (tab && tab !== 'dashboardTab'){
      // Re-arm a history entry so the NEXT device back also stays inside
      // the app until the user hits Back a second time (matches native
      // multi-screen apps). Then switch to the dashboard.
      try { history.pushState({ npNav: true, marker: markerKey(), kind: 'tab-guard' }, '',
        location.pathname + location.search + location.hash); } catch(_){}
      goToDashboard();
      return;
    }
    // Case 4: on dashboard with nothing open — let the browser exit.
  }

  function init(){
    if (installed) return;
    installed = true;
    // Seed one history entry so the first device-back from the dashboard
    // still has something to pop before actually exiting.
    try { history.pushState({ npNav: true, marker: markerKey(), kind: 'root-seed' }, '',
      location.pathname + location.search + location.hash); } catch(_){}
    window.addEventListener('popstate', onPopState);
  }

  return { init: init, pushModal: pushModal, popModal: popModal, anyOpen: anyOpen, routeHashNav: routeHashNav };
})();

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


/* ===== v3.3.6 rework: Previous Records + drawn signature + read-only certificate UX ===== */
(function(){
  function fmtPrevRecord(record){
    return `
      <div class="np-panel" style="box-shadow:none; border-radius:14px; margin-top:.75rem;">
        <div class="np-panel__body">
          <div class="np-row" style="justify-content:space-between; gap:.75rem; align-items:flex-start;">
            <div>
              <div style="font-weight:700; color:var(--np-ink);">${escapeHtml(fmtDate(record.recordDate))}</div>
              ${record.diagnosis ? `<div class="np-mut" style="margin-top:.2rem;">Diagnosis: ${escapeHtml(record.diagnosis)}</div>` : ''}
            </div>
            <div class="np-row" style="gap:.4rem; flex-wrap:wrap;">
              <button type="button" class="np-btn np-btn--ghost np-btn--sm" data-prev-edit="${record.id}">Edit</button>
              <button type="button" class="np-btn np-btn--danger np-btn--sm" data-prev-del="${record.id}">Delete</button>
            </div>
          </div>
          ${(function(){ const n = stripHrExtras(record.notes); return n ? `<div style="margin-top:.55rem;"><b>Notes:</b> ${escapeHtml(n)}</div>` : ''; })()}
          ${record.treatment ? `<div style="margin-top:.45rem;"><b>Treatment:</b> ${escapeHtml(record.treatment)}</div>` : ''}
          ${record.medications ? `<div style="margin-top:.45rem;"><b>Medications:</b> ${escapeHtml(record.medications)}</div>` : ''}
          ${record.attachmentSignedUrl ? `<div style="margin-top:.55rem;"><a class="np-btn np-btn--ghost np-btn--sm" target="_blank" rel="noopener" href="${record.attachmentSignedUrl}">Open attachment</a></div>` : ''}
        </div>
      </div>`;
  }

  let __prevRecordsCache = [];
  let __prevSelectedPatient = null;

  async function checkPreviousRecordPermission(){
    try {
      const res = await api('/doctor/previous-records/permission');
      const navBtn = document.querySelector('[data-tab="historicalTab"]');
      if (navBtn) navBtn.classList.toggle('hidden', !res.allowed);
      const tab = document.getElementById('historicalTab');
      if (tab && !res.allowed) tab.innerHTML = `<div class="np-panel"><div class="np-panel__body"><div class="np-empty"><div class="np-empty__title">Previous Records are disabled</div><div class="np-empty__sub">Ask an admin to enable access for your account.</div></div></div></div>`;
      return !!res.allowed;
    } catch(_) { return false; }
  }

  async function lookupHistoricalPatient(){
    const q = ($('#histPatientSearch')?.value || '').trim();
    const box = $('#histMatchBox');
    if (!q || q.length < 2){ _toast('error', 'Enter at least 2 characters to search'); return; }
    box.classList.remove('hidden');
    box.innerHTML = `<div class="np-empty"><div class="np-empty__title">Searching…</div></div>`;
    try {
      const rows = await api('/doctor/patients/search?q=' + encodeURIComponent(q));
      if (!rows.length){
        box.innerHTML = `<div class="np-empty"><div class="np-empty__title">No matching patient found</div><div class="np-empty__sub">Previous records can only be added for an existing patient in your panel.</div></div>`;
        return;
      }
      box.innerHTML = rows.map(p => `
        <button type="button" class="np-list-item" data-pid="${p.id}" style="width:100%; text-align:left; border:1px solid var(--np-border); background:#fff; padding:.75rem; border-radius:12px; margin-bottom:.5rem;">
          <div style="font-weight:700; color:var(--np-ink);">${escapeHtml(p.name)}</div>
          <div class="np-mut" style="font-size:.82rem;">+91 ${escapeHtml(p.phone || '')}${p.parentName ? ` · ${escapeHtml(p.parentName)}` : ''}</div>
          <div class="np-mut" style="font-size:.76rem; margin-top:.2rem;">Last visit: ${p.lastVisit ? escapeHtml(fmtDate(p.lastVisit)) : '—'}</div>
        </button>`).join('');
      box.querySelectorAll('[data-pid]').forEach(btn => btn.addEventListener('click', async () => {
        const patient = rows.find(x => x.id === btn.getAttribute('data-pid'));
        __prevSelectedPatient = patient;
        $('#histPatientId').value = patient.id;
        box.innerHTML = `<div class="np-callout np-callout--success"><div><b>${escapeHtml(patient.name)}</b> selected · +91 ${escapeHtml(patient.phone || '')}</div></div>`;
        await loadPreviousRecordsForPatient(patient.id);
      }));
    } catch (ex){
      box.innerHTML = `<div class="np-error">${escapeHtml(ex.message || 'Could not search patients')}</div>`;
    }
  }

  async function loadPreviousRecordsForPatient(patientId){
    const wrap = $('#histListWrap');
    if (!wrap) return;
    wrap.innerHTML = `<div class="np-empty"><div class="np-empty__title">Loading previous records…</div></div>`;
    try {
      // v3.4.5 — the controller returns { success, records: [...] }, not a
      // bare array. Unwrap defensively so the page works whether the
      // backend returns either shape (legacy or new).
      const resp = await api('/doctor/patients/' + encodeURIComponent(patientId) + '/previous-records');
      const list = Array.isArray(resp) ? resp
                  : Array.isArray(resp && resp.records) ? resp.records
                  : [];
      __prevRecordsCache = list;
      if (!list.length){
        wrap.innerHTML = `<div class="np-empty"><div class="np-empty__title">No previous records yet</div><div class="np-empty__sub">Use the form above to add the first one.</div></div>`;
        return;
      }
      wrap.innerHTML = list.map(fmtPrevRecord).join('');
      wrap.querySelectorAll('[data-prev-edit]').forEach(btn => btn.addEventListener('click', () => editPreviousRecord(btn.getAttribute('data-prev-edit'))));
      wrap.querySelectorAll('[data-prev-del]').forEach(btn => btn.addEventListener('click', () => deletePreviousRecord(btn.getAttribute('data-prev-del'))));
    } catch (ex){
      wrap.innerHTML = `<div class="np-error">${escapeHtml(ex.message || 'Could not load previous records')}</div>`;
    }
  }

  function resetPreviousRecordForm(){
    const form = $('#historicalForm');
    if (!form) return;
    form.reset();
    $('#histRecordId').value = '';
    $('#histSubmitBtn').textContent = 'Save previous record';
  }

  function editPreviousRecord(id){
    const rec = (__prevRecordsCache || []).find(r => r.id === id);
    if (!rec) return;
    const form = $('#historicalForm');
    form.recordDate.value = rec.recordDate ? String(rec.recordDate).slice(0,10) : '';
    form.diagnosis.value = rec.diagnosis || '';
    form.notes.value = stripHrExtras(rec.notes) || '';
    form.treatment.value = rec.treatment || '';
    form.medications.value = rec.medications || '';
    $('#histRecordId').value = rec.id;
    $('#histSubmitBtn').textContent = 'Update previous record';
    form.scrollIntoView({ behavior:'smooth', block:'start' });
  }

  async function deletePreviousRecord(id){
    const ok = window.NPModal ? await NPModal.confirm({ title:'Delete previous record?', message:'This will permanently remove the selected previous record.', danger:true, okText:'Delete' }) : confirm('Delete previous record?');
    if (!ok) return;
    try {
      await api('/doctor/previous-records/' + encodeURIComponent(id), { method:'DELETE' });
      _toast('success', 'Previous record deleted');
      const pid = $('#histPatientId').value;
      if (pid) loadPreviousRecordsForPatient(pid);
      if ($('#histRecordId').value === id) resetPreviousRecordForm();
    } catch (ex){ _toast('error', ex.message || 'Could not delete previous record'); }
  }

  async function submitHistorical(e){
    e.preventDefault();
    const patientId = $('#histPatientId').value;
    if (!patientId){ _toast('error', 'Select a patient first'); return; }
    const form = e.target;
    const recordId = $('#histRecordId').value;
    const fd = new FormData();
    fd.append('recordDate', form.recordDate.value);
    fd.append('diagnosis', form.diagnosis.value.trim());
    fd.append('notes', form.notes.value.trim());
    fd.append('treatment', form.treatment.value.trim());
    fd.append('medications', form.medications.value.trim());
    if (form.attachment.files[0]) fd.append('attachment', form.attachment.files[0]);
    const btn = $('#histSubmitBtn');
    btn.disabled = true;
    btn.textContent = recordId ? 'Updating…' : 'Saving…';
    try {
      if (recordId) await api('/doctor/previous-records/' + encodeURIComponent(recordId), { method:'PUT', body: fd });
      else await api('/doctor/patients/' + encodeURIComponent(patientId) + '/previous-records', { method:'POST', body: fd });
      _toast('success', recordId ? 'Previous record updated' : 'Previous record saved');
      resetPreviousRecordForm();
      await loadPreviousRecordsForPatient(patientId);
    } catch (ex){
      _toast('error', ex.message || 'Could not save previous record');
    } finally {
      btn.disabled = false;
      btn.textContent = $('#histRecordId').value ? 'Update previous record' : 'Save previous record';
    }
  }

  // v3.4.6: the Previous Records IIFE's own initHistoricalForm() is now a
  // no-op — the refactored public/doctor/historical-fix.js owns the
  // #historicalForm submit + patient-lookup + reset wiring, and running
  // both handlers on the same form would double-fire (two POSTs per save)
  // and re-render results into containers that no longer exist. The
  // helpers below (fmtPrevRecord, editPreviousRecord, deletePreviousRecord,
  // loadPreviousRecordsForPatient, __prevRecordsCache) remain callable so
  // any other feature that references them keeps working.
  function initHistoricalForm(){
    // intentionally empty — see comment above
  }

  function setupSignatureCanvas(){
    const canvas = $('#sigCanvas');
    if (!canvas || canvas.__wired) return;
    canvas.__wired = true;
    const ctx = canvas.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#111827';
    let drawing = false;
    let hasInk = false;

    function pos(ev){
      const rect = canvas.getBoundingClientRect();
      const src = ev.touches && ev.touches[0] ? ev.touches[0] : ev;
      return { x:(src.clientX - rect.left) * (canvas.width / rect.width), y:(src.clientY - rect.top) * (canvas.height / rect.height) };
    }
    function start(ev){ drawing = true; const p = pos(ev); ctx.beginPath(); ctx.moveTo(p.x, p.y); ev.preventDefault?.(); }
    function move(ev){ if (!drawing) return; const p = pos(ev); ctx.lineTo(p.x, p.y); ctx.stroke(); hasInk = true; ev.preventDefault?.(); }
    function end(){ drawing = false; }
    ['mousedown','touchstart'].forEach(n => canvas.addEventListener(n, start, { passive:false }));
    ['mousemove','touchmove'].forEach(n => canvas.addEventListener(n, move, { passive:false }));
    ['mouseup','mouseleave','touchend','touchcancel'].forEach(n => canvas.addEventListener(n, end));

    $('#sigClearBtn')?.addEventListener('click', () => {
      ctx.clearRect(0,0,canvas.width,canvas.height);
      hasInk = false;
    });
    $('#sigSaveDrawnBtn')?.addEventListener('click', async () => {
      if (!hasInk){ _toast('error', 'Draw a signature first'); return; }
      try {
        await api('/doctor/signature/drawn', { method:'POST', body:{ dataUrl: canvas.toDataURL('image/png') } });
        _toast('success', 'Drawn signature saved');
        await loadSignature();
      } catch (ex){ _toast('error', ex.message || 'Could not save drawn signature'); }
    });
  }

  const __origLoadSignature = typeof loadSignature === 'function' ? loadSignature : null;
  loadSignature = async function(){
    if (__origLoadSignature) await __origLoadSignature();
    setupSignatureCanvas();
  };

  const __origSetupSignature = typeof setupSignature === 'function' ? setupSignature : null;
  setupSignature = function(){
    if (__origSetupSignature) __origSetupSignature();
    setupSignatureCanvas();
  };

  const __origLoadPatientHistoryInto = typeof loadPatientHistoryInto === 'function' ? loadPatientHistoryInto : null;
  loadPatientHistoryInto = async function(slot, patientId){
    const res = await __origLoadPatientHistoryInto(slot, patientId);
    try {
      const target = document.querySelector('#patientHistoryPanel') || document.querySelector('#patientHistoryWrap') || document.querySelector('#patientModal .np-modal__body');
      if (!target || !window.__lastPatientHistoryPayload || !(window.__lastPatientHistoryPayload.previousRecords || []).length) return res;
    } catch(_) {}
    return res;
  };

  const __origApi = api;
  api = async function(path, opts={}){
    const data = await __origApi(path, opts);
    if (/\/patients\/[^/]+\/history$/.test(path)) window.__lastPatientHistoryPayload = data;
    return data;
  };

  document.addEventListener('DOMContentLoaded', function(){
    setTimeout(function(){
      checkPreviousRecordPermission();
      initHistoricalForm();
      setupSignatureCanvas();
      const settingsBtn = document.querySelector('[data-tab="settingsTab"]');
      if (settingsBtn && !settingsBtn.__sigReloadWired){
        settingsBtn.__sigReloadWired = true;
        settingsBtn.addEventListener('click', loadSignature);
      }
    }, 0);
  });
})();
