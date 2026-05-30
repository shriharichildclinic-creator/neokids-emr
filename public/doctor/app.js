const API = '/api';
let TOKEN = localStorage.getItem('np_doctor_token');
let currentAppointment = null;
let currentDoctor = null;

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

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
  // Issue 3 fix: Show clear warning for PENDING (unpaid online) appointments
  const pendingWarning = a.status === 'PENDING'
    ? `<p class="text-xs text-amber-600 font-semibold mt-1">⚠️ Awaiting payment</p>`
    : '';
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
        ${a.meetLink ? `<a href="${a.meetLink}" target="_blank" class="px-3 py-1.5 text-xs rounded-xl bg-brand-blue text-white">Join Meet</a>` : ''}
        <button onclick="openPatient('${a.id}')" class="px-3 py-1.5 text-xs rounded-xl border hover:bg-slate-50">Open</button>
        ${showActions && !['CANCELLED','COMPLETED'].includes(a.status) ? `<button onclick="openReschedule('${a.id}')" class="px-3 py-1.5 text-xs rounded-xl border hover:bg-slate-50">Reschedule</button>` : ''}
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

  $('#patientDetail').innerHTML = `
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
      <div class="bg-slate-50 rounded-2xl p-4">
        <h4 class="text-xs uppercase text-slate-500 mb-2">Patient</h4>
        <p class="font-bold">${a.patient.name}</p>
        <p class="text-sm text-slate-600">+91 ${a.patient.phone}</p>
        ${a.patient.email ? `<p class="text-sm text-slate-600">${a.patient.email}</p>` : ''}
        ${a.patient.dateOfBirth ? `<p class="text-sm text-slate-600">DOB: ${formatDate(a.patient.dateOfBirth)}</p>` : ''}
        ${a.patient.gender ? `<p class="text-sm text-slate-600">${a.patient.gender}</p>` : ''}
        ${a.patient.parentName ? `<p class="text-sm text-slate-600">Parent: ${a.patient.parentName}</p>` : ''}
      </div>
      <div class="bg-slate-50 rounded-2xl p-4">
        <h4 class="text-xs uppercase text-slate-500 mb-2">Appointment</h4>
        <p class="text-sm">📅 ${formatDate(a.date)}</p>
        <p class="text-sm">⏰ ${formatTime(a.startTime)} - ${formatTime(a.endTime)}</p>
        <p class="text-sm">${a.consultationType === 'ONLINE' ? '🎥' : '🏥'} ${a.consultationType}</p>
        <p class="text-sm">💰 ₹${Number(a.feeAtBooking).toFixed(2)} · ${a.paymentStatus}</p>
        <p class="text-sm text-slate-500">Created: ${new Date(a.createdAt).toLocaleString('en-IN')}</p>
        ${a.completedAt ? `<p class="text-sm text-slate-500">Completed: ${new Date(a.completedAt).toLocaleString('en-IN')}</p>` : ''}
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
        <textarea name="chiefComplaint" required placeholder="Chief Complaint" class="w-full px-4 py-2 rounded-xl border">${a.prescription?.chiefComplaint || a.primaryProblem || ''}</textarea>
        <textarea name="diagnosis" required placeholder="Diagnosis" class="w-full px-4 py-2 rounded-xl border">${a.prescription?.diagnosis || ''}</textarea>
        <div class="grid grid-cols-2 gap-2">
          <textarea name="allergies" placeholder="Allergies (if any)" class="px-4 py-2 rounded-xl border">${a.prescription?.allergies || ''}</textarea>
          <textarea name="investigations" placeholder="Investigations" class="px-4 py-2 rounded-xl border">${a.prescription?.investigations || ''}</textarea>
        </div>
        <div><div class="flex justify-between items-center mb-2"><label class="font-medium">Medications</label><button type="button" onclick="addMedRow()" class="text-sm px-3 py-1 rounded-lg bg-brand-blue/10 text-brand-blue">+ Add Med</button></div><div id="medsList" class="space-y-2"></div></div>
        <textarea name="advice" placeholder="Advice / Lifestyle" class="w-full px-4 py-2 rounded-xl border">${a.prescription?.advice || ''}</textarea>
        <div><label class="text-sm text-slate-500">Follow-up Date</label><input name="followUpDate" type="date" class="w-full px-4 py-2 rounded-xl border" value="${a.prescription?.followUpDate ? formatDateInput(a.prescription.followUpDate) : ''}"/></div>
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
function openReschedule(id) { $('#rsApptId').value = id; $('#rescheduleModal').classList.remove('hidden'); }
function closeRescheduleModal() { $('#rescheduleModal').classList.add('hidden'); $('#rescheduleForm').reset(); }

$('#rescheduleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#rsApptId').value;
  const fd = new FormData(e.target);
  try {
    await api(`/doctor/appointments/${id}/reschedule`, { method: 'POST', body: JSON.stringify(Object.fromEntries(fd.entries())) });
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
  const af = $('#availForm');
  af.availableFromOnline.value = me.availableFromOnline || '';
  af.availableToOnline.value = me.availableToOnline || '';
  af.availableFromOffline.value = me.availableFromOffline || '';
  af.availableToOffline.value = me.availableToOffline || '';
  af.slotDuration.value = me.slotDuration || 15;
  af.workingDays.value = me.workingDays || 'MON,TUE,WED,THU,FRI,SAT';
  af.isAvailable.checked = me.isAvailable;
  const ff = $('#feesForm');
  ff.onlineConsultFee.value = me.onlineConsultFee || 0;
  ff.physicalConsultFee.value = me.physicalConsultFee || 0;
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
  if (me.mustChangePassword) alert('Please change your password from Settings before continuing regular use.');
  await loadStats();
  await loadWaiting();
}

(async () => {
  if (TOKEN) {
    try {
      const m = await api('/auth/me');
      if (m.role === 'DOCTOR') return init();
    } catch {}
  }
  $('#loginScreen').classList.remove('hidden');
})();
