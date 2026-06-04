const API = '/api';
let TOKEN = localStorage.getItem('np_doctor_token');
let currentAppointment = null;
let currentDoctor = null;

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ── Time Picker Helpers ──────────────────────────────────────────────────────
// We use split selects: [Hour 1–12 ▼] [AM/PM ▼] instead of a 96-item dropdown.
// The hidden <input name="availableFromOnline"> holds the real HH:MM value.

// Populate a hour select (1–12) with optional minute suffix (e.g. ":00")
function populateHourSelect(sel, selectedHour12) {
  if (!sel) return;
  sel.innerHTML = Array.from({ length: 12 }, (_, i) => {
    const h = i + 1;
    return `<option value="${h}"${h === selectedHour12 ? ' selected' : ''}>${h}:00</option>`;
  }).join('');
}

// Parse HH:MM → { hour12, ampm } e.g. "21:00" → { hour12: 9, ampm: "PM" }
function parseHHMM(hhmm) {
  if (!hhmm) return { hour12: null, ampm: 'AM' };
  const [h] = hhmm.split(':').map(Number);
  return { hour12: h % 12 || 12, ampm: h >= 12 ? 'PM' : 'AM' };
}

// Read split selects → HH:MM string e.g. hour=9, ampm=PM → "21:00"
function readSplitTime(prefix, form) {
  const hSel = form.querySelector(`[name="${prefix}_h"]`);
  const ampmSel = form.querySelector(`[name="${prefix}_ampm"]`);
  if (!hSel || !ampmSel) return '';
  let h = parseInt(hSel.value, 10);
  const ampm = ampmSel.value;
  if (ampm === 'AM') { if (h === 12) h = 0; }
  else { if (h !== 12) h += 12; }
  return `${String(h).padStart(2, '0')}:00`;
}

// Set split selects from an HH:MM string
function setSplitTime(prefix, form, hhmm) {
  const { hour12, ampm } = parseHHMM(hhmm);
  const hSel = form.querySelector(`[name="${prefix}_h"]`);
  const ampmSel = form.querySelector(`[name="${prefix}_ampm"]`);
  populateHourSelect(hSel, hour12);
  if (ampmSel) ampmSel.value = ampm;
}

// Sync hidden HH:MM fields whenever split selects change
function wireAvailabilitySelects(form) {
  const pairs = [
    ['availableFromOnline', 'availableFromOnline'],
    ['availableToOnline',   'availableToOnline'],
    ['availableFromOffline','availableFromOffline'],
    ['availableToOffline',  'availableToOffline']
  ];
  pairs.forEach(([prefix, hiddenName]) => {
    const hSel = form.querySelector(`[name="${prefix}_h"]`);
    const ampmSel = form.querySelector(`[name="${prefix}_ampm"]`);
    const hidden = form.querySelector(`[name="${hiddenName}"]`);
    const sync = () => { if (hidden) hidden.value = readSplitTime(prefix, form); };
    hSel?.addEventListener('change', sync);
    ampmSel?.addEventListener('change', sync);
  });
}

// Populate all 4 availability split-pickers from doctor record
function populateAvailabilitySelects(doc) {
  const form = $('#availForm');
  if (!form) return;
  const fields = ['availableFromOnline','availableToOnline','availableFromOffline','availableToOffline'];
  fields.forEach(f => {
    setSplitTime(f, form, doc?.[f] || '');
    // Sync hidden field immediately
    const hidden = form.querySelector(`[name="${f}"]`);
    if (hidden) hidden.value = doc?.[f] || '';
  });
  wireAvailabilitySelects(form);
}

// ── Slot Duration Button Group ───────────────────────────────────────────────
const SLOT_DURATIONS = [10, 15, 20, 30, 45, 60];
function renderSlotDurationBtns(selected) {
  const container = $('#slotDurationBtns');
  const hidden = $('#slotDurationVal');
  if (!container) return;
  container.querySelectorAll('button').forEach(b => b.remove());
  SLOT_DURATIONS.forEach(d => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = `${d} min`;
    btn.className = `px-4 py-2 rounded-xl border text-sm font-medium transition-colors ${
      d === selected
        ? 'bg-brand-blue text-white border-brand-blue'
        : 'bg-white text-slate-600 hover:border-brand-blue hover:text-brand-blue'
    }`;
    btn.onclick = () => {
      if (hidden) hidden.value = d;
      renderSlotDurationBtns(d);
    };
    container.appendChild(btn);
  });
  if (hidden && !hidden.value) hidden.value = selected || 15;
}

// ── Working Days Checkbox Group ──────────────────────────────────────────────
const ALL_DAYS = ['MON','TUE','WED','THU','FRI','SAT','SUN'];
const DAY_LABELS = { MON:'Mon', TUE:'Tue', WED:'Wed', THU:'Thu', FRI:'Fri', SAT:'Sat', SUN:'Sun' };
function renderWorkingDaysBtns(selectedCsv) {
  const container = $('#workingDaysBtns');
  const hidden = $('#workingDaysVal');
  if (!container) return;
  const selected = new Set((selectedCsv || '').split(',').map(s => s.trim()).filter(Boolean));
  container.querySelectorAll('button').forEach(b => b.remove());
  const syncHidden = () => {
    if (hidden) hidden.value = ALL_DAYS.filter(d => selected.has(d)).join(',');
  };
  ALL_DAYS.forEach(day => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = DAY_LABELS[day];
    const active = () => selected.has(day);
    const setStyle = () => {
      btn.className = `px-3 py-2 rounded-xl border text-sm font-medium transition-colors ${
        active()
          ? 'bg-brand-blue text-white border-brand-blue'
          : 'bg-white text-slate-600 hover:border-brand-blue hover:text-brand-blue'
      }`;
    };
    btn.onclick = () => {
      if (active()) selected.delete(day); else selected.add(day);
      setStyle();
      syncHidden();
    };
    setStyle();
    container.appendChild(btn);
  });
  syncHidden();
}

// ── Reschedule Time Select ───────────────────────────────────────────────────
// Uses slot-duration-aware intervals so options match actual available slots







function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-IN', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });
}

function formatDateInput(dateStr) {
  return new Date(dateStr).toISOString().slice(0, 10);
}

function formatTime(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}

function api(path, opts = {}) {
  return fetch(API + path, {
    ...opts,
    headers: {
      ...(opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(TOKEN && { Authorization: 'Bearer ' + TOKEN }),
      ...(opts.headers || {})
    }
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Request failed');
    return data;
  });
}

function renderDoctorPhoto(photoUrl) {
  const top = $('#docPhotoTop');
  const large = $('#docPhotoLarge');
  const placeholder = $('#docPhotoPlaceholder');
  if (photoUrl) {
    top.src = large.src = photoUrl;
    top.classList.remove('hidden');
    large.classList.remove('hidden');
    placeholder.classList.add('hidden');
  } else {
    top.classList.add('hidden');
    large.classList.add('hidden');
    placeholder.classList.remove('hidden');
  }
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginError').classList.add('hidden');
  try {
    const r = await fetch(API + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('#email').value, password: $('#password').value })
    }).then((x) => x.json().then((d) => { if (!x.ok) throw new Error(d.error); return d; }));
    if (r.role !== 'DOCTOR') throw new Error('Not a doctor account');
    TOKEN = r.token;
    localStorage.setItem('np_doctor_token', TOKEN);
    await init();
  } catch (e) {
    $('#loginError').textContent = e.message;
    $('#loginError').classList.remove('hidden');
  }
});

async function forgotPassword() {
  const email = prompt('Enter your doctor account email');
  if (!email) return;
  try {
    const res = await api('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
    alert(res.previewUrl ? `Reset link (mock mode): ${res.previewUrl}` : 'If the account exists, a reset link has been sent.');
  } catch (err) {
    alert(err.message);
  }
}

function logout() {
  localStorage.removeItem('np_doctor_token');
  TOKEN = null;
  location.reload();
}

$$('.tab-btn').forEach((btn) => btn.addEventListener('click', () => {
  $$('.tab-btn').forEach((b) => {
    b.classList.remove('border-brand-blue', 'font-medium');
    b.classList.add('border-transparent', 'text-slate-500');
  });
  btn.classList.add('border-brand-blue', 'font-medium');
  btn.classList.remove('border-transparent', 'text-slate-500');
  $$('.tab-pane').forEach((p) => p.classList.add('hidden'));
  $('#' + btn.dataset.tab).classList.remove('hidden');
  if (btn.dataset.tab === 'waitingTab') loadWaiting();
  if (btn.dataset.tab === 'allTab') loadAll();
  if (btn.dataset.tab === 'settingsTab') loadSettings();
}));

function statusColor(s) {
  return ({
    PENDING: 'bg-yellow-100 text-yellow-700',
    CONFIRMED: 'bg-blue-100 text-blue-700',
    COMPLETED: 'bg-green-100 text-green-700',
    CANCELLED: 'bg-red-100 text-red-700'
  })[s] || 'bg-slate-100 text-slate-700';
}

function paymentLabel(status, type) {
  if (status === 'PAID') return { text: '✅ Paid Online', cls: 'text-green-600' };
  if (status === 'CASH_COLLECTED') return { text: '✅ Cash Collected', cls: 'text-green-600' };
  if (status === 'CASH_PENDING') return { text: '💵 Cash at Clinic', cls: 'text-amber-600' };
  if (status === 'FAILED') return { text: '❌ Payment Failed', cls: 'text-red-500' };
  if (status === 'UNPAID' && type === 'ONLINE') return { text: '⏳ Awaiting Payment', cls: 'text-amber-600' };
  return { text: status, cls: 'text-slate-400' };
}

async function loadStats() {
  const s = await api('/doctor/stats');
  const items = [
    { label: 'Today', value: s.todayAppointments, color: 'bg-brand-blue/10 text-brand-blue', icon: '📅' },
    { label: 'Completed Today', value: s.completedToday, color: 'bg-green-100 text-green-600', icon: '✅' },
    { label: 'Total Consults', value: s.totalConsults, color: 'bg-brand-mint/40 text-teal-700', icon: '🩺' },
    { label: 'Revenue', value: '₹' + s.totalRevenue.toLocaleString(), color: 'bg-brand-cream text-amber-700', icon: '💰' }
  ];
  $('#statsBar').innerHTML = items.map((i) => `
    <div class="bg-white rounded-2xl p-4 flex items-center gap-3">
      <div class="w-10 h-10 rounded-xl ${i.color} flex items-center justify-center text-xl">${i.icon}</div>
      <div><div class="text-xs text-slate-500">${i.label}</div><div class="font-bold">${i.value}</div></div>
    </div>`).join('');
}
function apptCard(a, showActions) {
  const isOnline = a.consultationType === 'ONLINE';
  const pendingWarning = a.status === 'PENDING'
    ? `<p class="text-xs text-amber-600 font-semibold mt-1">⚠️ Awaiting payment</p>` : '';
  // Feature: video icon button so doctor can clearly see and click Join Meet
  const meetBtn = a.meetLink ? `
    <a href="${a.meetLink}" target="_blank" title="Join Google Meet"
       class="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-brand-blue text-white hover:bg-blue-500 shadow-sm">
      <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/>
      </svg>
    </a>` : '';
  return `
    <div class="bg-white rounded-2xl p-4 shadow-sm flex items-center justify-between">
      <div class="flex items-center gap-3">
        <div class="w-12 h-12 rounded-xl ${isOnline ? 'bg-brand-blue/20' : 'bg-brand-mint/40'} flex items-center justify-center text-xl">${isOnline ? '🎥' : '🏥'}</div>
        <div>
          <p class="font-semibold">${a.patient.name}</p>
          <p class="text-xs text-slate-500">+91 ${a.patient.phone} · ${a.consultationType}</p>
          <p class="text-xs text-slate-400 mt-0.5">${formatDate(a.date)} · ${formatTime(a.startTime)}-${formatTime(a.endTime)}</p>
          <p class="text-xs text-slate-600 mt-0.5">🩺 ${a.primaryProblem}</p>
          ${pendingWarning}
        </div>
      </div>
      <div class="flex items-center gap-2 flex-wrap justify-end">
        <span class="px-3 py-1 text-xs rounded-full ${statusColor(a.status)}">${a.status}</span>
        ${meetBtn}
        <button onclick="openPatient('${a.id}')" class="px-3 py-1.5 text-xs rounded-xl border hover:bg-slate-50">Open</button>
        ${showActions && !['CANCELLED','COMPLETED'].includes(a.status) ? `<button onclick="openReschedule('${a.id}','${a.consultationType}')" class="px-3 py-1.5 text-xs rounded-xl border hover:bg-slate-50">Reschedule</button>` : ''}
        ${showActions && !['CANCELLED','COMPLETED'].includes(a.status) ? `<button onclick="cancelAppt('${a.id}')" class="px-3 py-1.5 text-xs rounded-xl border border-red-200 text-red-500 hover:bg-red-50">Cancel</button>` : ''}
      </div>
    </div>`;
}


async function loadWaiting() {
  const list = await api('/doctor/waiting-room');
  $('#waitingList').innerHTML = list.map((a) => apptCard(a, true)).join('') || '<div class="bg-white rounded-2xl p-12 text-center text-slate-400">No patients in today\'s waiting room.</div>';
}

async function loadAll() {
  const list = await api('/doctor/appointments');
  $('#allList').innerHTML = list.map((a) => apptCard(a, false)).join('') || '<div class="bg-white rounded-2xl p-12 text-center text-slate-400">No appointments yet.</div>';
}

async function openPatient(id) {
  const data = await api('/doctor/appointments/' + id);
  currentAppointment = data.appointment;
  const a = data.appointment;
  const h = data.history || [];
  const completeLabel = a.status === 'COMPLETED' ? 'Mark as Incomplete' : 'Mark as Complete';

  // Auto age helper (matches backend)
  function calcAge(dob) {
    if (!dob) return '';
    const d = new Date(dob); const today = new Date();
    let y = today.getUTCFullYear() - d.getUTCFullYear();
    let m = today.getUTCMonth() - d.getUTCMonth();
    if (today.getUTCDate() < d.getUTCDate()) m--;
    if (m < 0) { y--; m += 12; }
    if (y < 0) return '';
    if (y === 0) return `${m} month${m===1?'':'s'}`;
    return `${y} yr${y===1?'':'s'} ${m} month${m===1?'':'s'}`;
  }
  const ageStr = calcAge(a.patient.dateOfBirth);

  $('#patientDetail').innerHTML = `
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
      <div class="bg-slate-50 rounded-2xl p-4">
        <h4 class="text-xs uppercase text-slate-500 mb-2">Patient</h4>
        <p class="font-bold">${a.patient.name}</p>
        <p class="text-sm text-slate-600">+91 ${a.patient.phone}</p>
        ${a.patient.email ? `<p class="text-sm text-slate-600">${a.patient.email}</p>` : ''}
        ${ageStr ? `<p class="text-sm text-slate-600">Age: ${ageStr}</p>` : ''}
        ${a.patient.gender ? `<p class="text-sm text-slate-600">Gender: ${a.patient.gender}</p>` : ''}
        ${a.patient.parentName ? `<p class="text-sm text-slate-600">Parent: ${a.patient.parentName}</p>` : ''}
      </div>
      <div class="bg-slate-50 rounded-2xl p-4">
        <h4 class="text-xs uppercase text-slate-500 mb-2">Appointment</h4>
        <p class="text-sm">📅 ${formatDate(a.date)}</p>
        <p class="text-sm">⏰ ${formatTime(a.startTime)} - ${formatTime(a.endTime)}</p>
        <p class="text-sm">${a.consultationType === 'ONLINE' ? '🎥' : '🏥'} ${a.consultationType}</p>
        <p class="text-sm">💰 ₹${Number(a.feeAtBooking).toFixed(2)} · <span class="${paymentLabel(a.paymentStatus, a.consultationType).cls}">${paymentLabel(a.paymentStatus, a.consultationType).text}</span></p>
        ${a.meetLink ? `<a class="text-brand-blue text-sm underline" target="_blank" href="${a.meetLink}">Join Google Meet</a>` : ''}
      </div>
      <div class="bg-slate-50 rounded-2xl p-4">
        <h4 class="text-xs uppercase text-slate-500 mb-2">Primary Problem</h4>
        <p class="text-sm">${a.primaryProblem}</p>
        ${a.invoiceUrl ? `<a class="text-brand-blue text-sm underline block mt-2" target="_blank" href="${a.invoiceUrl}">📄 Invoice</a>` : ''}
        ${a.prescriptionUrl ? `<a class="text-brand-blue text-sm underline block" target="_blank" href="${a.prescriptionUrl}">💊 Prescription</a>` : ''}
      </div>
    </div>

    ${h.length ? `<details class="bg-amber-50 rounded-2xl p-4 mb-4"><summary class="cursor-pointer font-medium">📜 Visit History (${h.length})</summary><div class="mt-3 space-y-2">${h.map((v) => `<div class="bg-white rounded-xl p-3 text-sm"><p class="font-medium">${formatDate(v.date)} · Dr. ${v.doctor.name}</p>${v.prescription ? `<p class="text-slate-600">Dx: ${v.prescription.diagnosis}</p>` : ''}${v.prescriptionUrl ? `<a class="text-brand-blue underline text-xs" target="_blank" href="${v.prescriptionUrl}">View Rx</a>` : ''}</div>`).join('')}</div></details>` : ''}

    <div class="bg-white rounded-2xl border p-4">
      <h3 class="font-bold mb-3">💊 Prescription Builder</h3>
      <form id="rxForm" class="space-y-3">
        <div class="grid grid-cols-3 gap-2">
          <div><label class="text-xs text-slate-500">Name (auto)</label><input value="${a.patient.name}" disabled class="w-full px-3 py-2 rounded-lg border bg-slate-50 text-sm"/></div>
          <div><label class="text-xs text-slate-500">Age (auto)</label><input value="${ageStr}" disabled class="w-full px-3 py-2 rounded-lg border bg-slate-50 text-sm"/></div>
          <div><label class="text-xs text-slate-500">Gender (auto)</label><input value="${a.patient.gender || ''}" disabled class="w-full px-3 py-2 rounded-lg border bg-slate-50 text-sm"/></div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div><label class="text-xs text-slate-500">Weight</label><input name="weight" placeholder="e.g. 18 kg" value="${a.prescription?.weight || ''}" class="w-full px-3 py-2 rounded-lg border text-sm"/></div>
          <div><label class="text-xs text-slate-500">Height</label><input name="height" placeholder="e.g. 105 cm" value="${a.prescription?.height || ''}" class="w-full px-3 py-2 rounded-lg border text-sm"/></div>
        </div>
        <textarea name="chiefComplaint" required placeholder="Chief Complaint" class="w-full px-4 py-2 rounded-xl border">${a.prescription?.chiefComplaint || a.primaryProblem || ''}</textarea>
        <textarea name="pastHistory" placeholder="Past History (illnesses, surgeries, family history…)" class="w-full px-4 py-2 rounded-xl border">${a.prescription?.pastHistory || ''}</textarea>
        <textarea name="diagnosis" required placeholder="Diagnosis" class="w-full px-4 py-2 rounded-xl border">${a.prescription?.diagnosis || ''}</textarea>
        <div class="grid grid-cols-2 gap-2">
          <textarea name="allergies" placeholder="Allergy (if any)" class="px-4 py-2 rounded-xl border">${a.prescription?.allergies || ''}</textarea>
          <textarea name="investigations" placeholder="Investigations" class="px-4 py-2 rounded-xl border">${a.prescription?.investigations || ''}</textarea>
        </div>
        <div><div class="flex justify-between items-center mb-2"><label class="font-medium">Medicine</label><button type="button" onclick="addMedRow()" class="text-sm px-3 py-1 rounded-lg bg-brand-blue/10 text-brand-blue">+ Add Med</button></div><div id="medsList" class="space-y-2"></div></div>
        <textarea name="advice" placeholder="Advice / Lifestyle" class="w-full px-4 py-2 rounded-xl border">${a.prescription?.advice || ''}</textarea>
        <div><label class="text-sm text-slate-500">Follow Up Date</label><input name="followUpDate" type="date" class="w-full px-4 py-2 rounded-xl border" value="${a.prescription?.followUpDate ? formatDateInput(a.prescription.followUpDate) : ''}"/></div>
        <div class="flex gap-2"><button type="button" onclick="toggleComplete('${a.id}')" class="px-4 py-2.5 rounded-xl border">${completeLabel}</button><button type="submit" class="flex-1 py-2.5 bg-brand-blue text-white rounded-xl font-semibold">Save & Send to Patient</button></div>
      </form>
    </div>`;

  const existing = a.prescription?.medications || [{ name: '', dose: '', frequency: '', duration: '', instructions: '' }];
  existing.forEach((m) => addMedRow(m));
  $('#rxForm').addEventListener('submit', submitPrescription);
  $('#patientModal').classList.remove('hidden');
}


function addMedRow(m = { name: '', dose: '', frequency: '', duration: '', instructions: '' }) {
  const row = document.createElement('div');
  row.className = 'grid grid-cols-6 gap-2 items-center';
  row.innerHTML = `
    <input value="${m.name || ''}" placeholder="Medicine" class="med-name col-span-2 px-3 py-2 rounded-lg border text-sm"/>
    <input value="${m.dose || ''}" placeholder="Dose" class="med-dose px-3 py-2 rounded-lg border text-sm"/>
    <input value="${m.frequency || ''}" placeholder="Freq" class="med-freq px-3 py-2 rounded-lg border text-sm"/>
    <input value="${m.duration || ''}" placeholder="Duration" class="med-dur px-3 py-2 rounded-lg border text-sm"/>
    <div class="flex gap-1"><input value="${m.instructions || ''}" placeholder="Notes" class="med-inst px-3 py-2 rounded-lg border text-sm w-full"/><button type="button" onclick="this.closest('div.grid').remove()" class="text-red-500 px-2">✕</button></div>`;
  $('#medsList').appendChild(row);
}

async function submitPrescription(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const data = Object.fromEntries(fd.entries());
  if (!data.followUpDate) delete data.followUpDate;
  const meds = [...$$('#medsList > div')].map((r) => ({
    name: r.querySelector('.med-name').value,
    dose: r.querySelector('.med-dose').value,
    frequency: r.querySelector('.med-freq').value,
    duration: r.querySelector('.med-dur').value,
    instructions: r.querySelector('.med-inst').value
  })).filter((m) => m.name);
  data.medications = meds;
  try {
    await api(`/doctor/appointments/${currentAppointment.id}/prescription`, { method: 'POST', body: JSON.stringify(data) });
    alert('Prescription saved and sent to patient.');
    closePatientModal();
    loadWaiting();
    loadStats();
  } catch (err) { alert(err.message); }
}

async function toggleComplete(id) {
  // Issue 3 fix: UI guard — check status before calling API
  const appt = currentAppointment;
  if (appt && appt.id === id && appt.status === 'PENDING') {
    showInlineError('completeErr', 'Cannot complete a PENDING appointment. Payment must be confirmed first.');
    return;
  }
  try {
    await api(`/doctor/appointments/${id}/toggle-complete`, { method: 'POST' });
    closePatientModal();
    loadWaiting();
    loadAll();
    loadStats();
  } catch (err) { alert(err.message); }
}

// Issue 5 fix: Cancel appointment from waiting room
async function cancelAppt(id) {
  const reason = prompt('Reason for cancellation (optional):');
  if (reason === null) return; // user pressed Cancel on prompt
  try {
    await api(`/doctor/appointments/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason })
    });
    loadWaiting();
    loadAll();
    loadStats();
  } catch (err) { alert(err.message); }
}

// Issue 7 fix: Inline error helper (replaces alert popups for form validation)
function showInlineError(elementId, message) {
  const el = document.getElementById(elementId);
  if (el) {
    el.textContent = message;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 4000);
  } else {
    alert(message); // fallback
  }
}

function closePatientModal() { $('#patientModal').classList.add('hidden'); }
// ── Reschedule Modal ─────────────────────────────────────────────────────────
let rsCurrentAppt = null;

function openReschedule(id, consultationType) {
  rsCurrentAppt = { id, consultationType: consultationType || 'OFFLINE' };
  $('#rsApptId').value = id;
  $('#rsStartTimeHidden').value = '';
  $('#rsSelectedDisplay').classList.add('hidden');
  $('#rsSelectedDisplay').textContent = '';
  $('#rsSubmitBtn').disabled = true;
  $('#rsSlotsGrid').innerHTML = '<p class="col-span-3 text-sm text-slate-400 text-center py-3">Select a date above</p>';

  // IST today as min date
  const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const todayIST = `${nowIST.getFullYear()}-${String(nowIST.getMonth()+1).padStart(2,'0')}-${String(nowIST.getDate()).padStart(2,'0')}`;
  const dateInput = $('#rsDateInput');
  dateInput.min = todayIST;
  dateInput.value = '';

  $('#rescheduleModal').classList.remove('hidden');
}

function closeRescheduleModal() {
  $('#rescheduleModal').classList.add('hidden');
  $('#rescheduleForm').reset();
  $('#rsSlotsGrid').innerHTML = '<p class="col-span-3 text-sm text-slate-400 text-center py-3">Select a date above</p>';
  $('#rsSelectedDisplay').classList.add('hidden');
  $('#rsSubmitBtn').disabled = true;
  rsCurrentAppt = null;
}

function selectRsSlot(time) {
  $('#rsStartTimeHidden').value = time;
  $('#rsSubmitBtn').disabled = false;
  document.querySelectorAll('.rs-slot-btn').forEach(b => {
    const active = b.dataset.time === time;
    b.className = `rs-slot-btn py-2 rounded-xl border text-sm font-medium transition-colors ${
      active ? 'bg-brand-blue text-white border-brand-blue'
              : 'bg-white text-slate-600 border-slate-200 hover:border-brand-blue hover:text-brand-blue'}`;
  });
  const display = $('#rsSelectedDisplay');
  display.textContent = `✅ Selected: ${formatTime(time)}`;
  display.classList.remove('hidden');
}

async function loadRsSlots(date) {
  const grid = $('#rsSlotsGrid');
  if (!date) return;
  grid.innerHTML = '<p class="col-span-3 text-sm text-slate-400 text-center py-3">Loading slots...</p>';
  $('#rsStartTimeHidden').value = '';
  $('#rsSubmitBtn').disabled = true;
  $('#rsSelectedDisplay').classList.add('hidden');
  try {
    const doctorId = currentDoctor?.id;
    const type = rsCurrentAppt?.consultationType || 'OFFLINE';
    const { slots } = await api(`/public/slots?doctorId=${doctorId}&date=${date}&type=${type}`);
    const available = slots.filter(s => s.available);
    if (!available.length) {
      grid.innerHTML = '<p class="col-span-3 text-sm text-slate-400 text-center py-3">No slots available on this date</p>';
      return;
    }
    grid.innerHTML = available.map(s => `
      <button type="button" data-time="${s.startTime}" onclick="selectRsSlot('${s.startTime}')"
        class="rs-slot-btn py-2 rounded-xl border text-sm font-medium bg-white text-slate-600 border-slate-200 hover:border-brand-blue hover:text-brand-blue transition-colors">
        ${formatTime(s.startTime)}
      </button>`).join('');
  } catch (err) {
    grid.innerHTML = `<p class="col-span-3 text-sm text-red-400 text-center py-3">${err.message}</p>`;
  }
}

$('#rsDateInput')?.addEventListener('change', e => loadRsSlots(e.target.value));



$('#rescheduleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#rsApptId').value;
  const startTime = $('#rsStartTimeHidden').value;
  const date = $('#rsDateInput').value;
  const reason = e.target.reason.value;
  if (!startTime) { alert('Please select a time slot.'); return; }
  if (!date) { alert('Please select a date.'); return; }
  try {
    await api(`/doctor/appointments/${id}/reschedule`, {
      method: 'POST',
      body: JSON.stringify({ date, startTime, reason })
    });
    alert('Appointment rescheduled. Patient notifications attempted.');
    closeRescheduleModal();
    loadWaiting();
    loadAll();
  } catch (err) { alert(err.message); }
});



async function loadSettings() {
  const me = await api('/doctor/me');
  currentDoctor = me;
  renderDoctorPhoto(me.photoUrl);
  populateAvailabilitySelects(me);
  renderSlotDurationBtns(me.slotDuration || 15);
  renderWorkingDaysBtns(me.workingDays || 'MON,TUE,WED,THU,FRI,SAT');
  const af = $('#availForm');
  af.isAvailable.checked = me.isAvailable;
  const ff = $('#feesForm');
  ff.onlineConsultFee.value = me.onlineConsultFee || 0;
  ff.physicalConsultFee.value = me.physicalConsultFee || 0;

  // Bug 6 — populate clinic form
  const cf = $('#clinicForm');
  if (cf) {
    cf.clinicName.value = me.clinicName || '';
    cf.clinicAddress.value = me.clinicAddress || '';
    cf.clinicMapUrl.value = me.clinicMapUrl || '';
    cf.clinicLat.value = me.clinicLat ?? '';
    cf.clinicLng.value = me.clinicLng ?? '';
  }
}


$('#photoForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = $('#photoInput').files[0];
  if (!file) return alert('Please select an image.');
  const fd = new FormData();
  fd.append('photo', file);
  try {
    const res = await api('/doctor/profile-image', { method: 'POST', body: fd });
    renderDoctorPhoto(res.photoUrl);
    alert('Profile photo updated.');
  } catch (err) { alert(err.message); }
});

async function removePhoto() {
  try {
    await api('/doctor/profile-image', { method: 'DELETE' });
    renderDoctorPhoto(null);
    alert('Profile photo removed.');
  } catch (err) { alert(err.message); }
}

$('#availForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const data = Object.fromEntries(fd.entries());
  data.isAvailable = e.target.isAvailable.checked;
  data.slotDuration = parseInt(data.slotDuration, 10);
  // Remove the split-select fields (they are just UI — hidden fields hold HH:MM values)
  ['availableFromOnline_h','availableFromOnline_ampm',
   'availableToOnline_h','availableToOnline_ampm',
   'availableFromOffline_h','availableFromOffline_ampm',
   'availableToOffline_h','availableToOffline_ampm'].forEach(k => delete data[k]);
  try {
    await api('/doctor/availability', { method: 'PUT', body: JSON.stringify(data) });
    alert('Availability updated.');
  } catch (err) { alert(err.message); }
});

$('#feesForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const data = { onlineConsultFee: parseFloat(fd.get('onlineConsultFee')), physicalConsultFee: parseFloat(fd.get('physicalConsultFee')) };
  try {
    await api('/doctor/fees', { method: 'PUT', body: JSON.stringify(data) });
    alert('Fees updated.');
  } catch (err) { alert(err.message); }
});

$('#passwordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api('/auth/change-password', { method: 'POST', body: JSON.stringify(Object.fromEntries(fd.entries())) });
    alert('Password changed successfully.');
    e.target.reset();
  } catch (err) { alert(err.message); }
});

async function init() {
  $('#loginScreen').classList.add('hidden');
  $('#dashboard').classList.remove('hidden');
  const me = await api('/doctor/me');
  currentDoctor = me;
  $('#docName').textContent = 'Dr. ' + me.name;
  $('#docSpec').textContent = me.specialization || 'Pediatrician';
  renderDoctorPhoto(me.photoUrl);
  // Pre-populate availability pickers so settings tab is ready immediately
  populateAvailabilitySelects(me);
  renderSlotDurationBtns(me.slotDuration || 15);
  renderWorkingDaysBtns(me.workingDays || 'MON,TUE,WED,THU,FRI,SAT');
  if (me.mustChangePassword) alert('Please change your password from Settings before continuing regular use.');
  await loadStats();
  await loadWaiting();
}

// Bug 6 — Clinic form: press Enter on clinic name to auto-generate the Google Maps URL,
// and save clinic settings on submit.
(function wireClinicForm() {
  const cf = document.getElementById('clinicForm');
  if (!cf) return;
  const nameInput = document.getElementById('clinicNameInput');
  const urlInput  = cf.clinicMapUrl;
  const addrInput = cf.clinicAddress;

  function generateMapUrl() {
    const name = (nameInput.value || '').trim();
    const addr = (addrInput.value || '').trim();
    if (!name) return;
    const q = encodeURIComponent([name, addr].filter(Boolean).join(' '));
    urlInput.value = `https://maps.google.com/?q=${q}`;
  }
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); generateMapUrl(); }
  });
  addrInput.addEventListener('blur', () => { if (!urlInput.value) generateMapUrl(); });

  cf.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(cf);
    const payload = Object.fromEntries(fd.entries());
    ['clinicLat','clinicLng'].forEach(k => { if (payload[k] === '') delete payload[k]; });
    try {
      await api('/doctor/clinic', { method: 'PUT', body: JSON.stringify(payload) });
      alert('Clinic location saved. It will now appear in patient WhatsApp/email Get Directions buttons.');
    } catch (err) { alert(err.message); }
  });
})();


(async () => {
  if (TOKEN) {
    try {
      const m = await api('/auth/me');
      if (m.role === 'DOCTOR') return init();
    } catch {}
  }
  $('#loginScreen').classList.remove('hidden');
})();