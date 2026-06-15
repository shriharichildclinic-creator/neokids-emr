const API = '/api';
let TOKEN = localStorage.getItem('np_admin_token');

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-IN', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });
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
      'Content-Type': 'application/json',
      ...(TOKEN && { Authorization: 'Bearer ' + TOKEN }),
      ...(opts.headers || {})
    }
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    // Bug 1 — 401 interceptor
    if (r.status === 401) {
      localStorage.removeItem('np_admin_token');
      TOKEN = null;
      location.reload();
      throw new Error('Session expired');
    }
    if (!r.ok) throw new Error(data.error || 'Request failed');
    return data;
  });
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginError').classList.add('hidden');
  try {
    const r = await fetch(API + '/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('#email').value, password: $('#password').value })
    }).then((x) => x.json().then((d) => { if (!x.ok) throw new Error(d.error); return d; }));
    if (r.role !== 'ADMIN') throw new Error('Not an admin account');
    TOKEN = r.token;
    localStorage.setItem('np_admin_token', TOKEN);
    showDashboard();
  } catch (e) {
    $('#loginError').textContent = e.message;
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

function setView(view) {


  $$('.view').forEach((v) => v.classList.add('hidden'));
  $('#' + view).classList.remove('hidden');


  $$('.nav-link').forEach((n) => n.classList.remove('active', 'bg-brand-blue/10'));
  const link = document.querySelector(`[data-view="${view}"]`);
  if (link) link.classList.add('active', 'bg-brand-blue/10');
  if (view === 'dashboardView') loadDashboard();
  if (view === 'doctorsView') loadDoctors();
  if (view === 'apptsView') loadAppointments();
}


$$('.nav-link').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); setView(a.dataset.view); }));

function statusColor(s) {
  return ({ PENDING: 'bg-yellow-100 text-yellow-700', CONFIRMED: 'bg-blue-100 text-blue-700', COMPLETED: 'bg-green-100 text-green-700', CANCELLED: 'bg-red-100 text-red-700', NO_SHOW: 'bg-gray-100 text-gray-700' })[s] || 'bg-slate-100 text-slate-700';
}
function paymentLabel(status, type) {
  if (status === 'PAID') return { text: '✅ Paid Online', cls: 'text-green-600' };
  if (status === 'CASH_COLLECTED') return { text: '✅ Cash Collected', cls: 'text-green-600' };
  if (status === 'CASH_PENDING') return { text: '💵 Cash at Clinic', cls: 'text-amber-600' };
  if (status === 'FAILED') return { text: '❌ Payment Failed', cls: 'text-red-500' };
  if (status === 'UNPAID' && type === 'ONLINE') return { text: '⏳ Awaiting Payment', cls: 'text-amber-600' };
  return { text: status, cls: 'text-slate-400' };
}

async function loadDashboard() {
  const a = await api('/admin/analytics');
  const cards = [
    { label: 'Total Doctors', value: a.totalDoctors, color: 'bg-brand-blue', icon: '👨‍⚕️' },
    { label: 'Total Patients', value: a.totalPatients, color: 'bg-brand-mint', icon: '👶' },
    { label: "Today's Appts", value: a.todayAppointments, color: 'bg-brand-coral', icon: '📅' },
    { label: 'Revenue (₹)', value: a.totalRevenue.toLocaleString(), color: 'bg-brand-cream', icon: '💰' }
  ];
  $('#statsGrid').innerHTML = cards.map((c) => `<div class="bg-white rounded-2xl p-5 shadow-sm"><div class="flex justify-between items-start"><div><p class="text-sm text-slate-500">${c.label}</p><p class="text-2xl font-bold mt-1">${c.value}</p></div><div class="w-12 h-12 rounded-xl ${c.color} flex items-center justify-center text-2xl">${c.icon}</div></div></div>`).join('');
  const appts = await api('/admin/appointments');
  $('#recentAppts').innerHTML = appts.slice(0, 10).map((a) => `<div class="flex items-center justify-between p-3 rounded-xl hover:bg-slate-50"><div><p class="font-medium">${a.patient.name} → Dr. ${a.doctor.name}</p><p class="text-xs text-slate-500">${formatDate(a.date)} at ${formatTime(a.startTime)} · ${a.consultationType}</p></div><span class="px-3 py-1 text-xs rounded-full ${statusColor(a.status)}">${a.status}</span></div>`).join('') || '<p class="text-slate-400 text-center py-8">No appointments yet</p>';
}

// SVG icon helpers
const ICON_EDIT  = `<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>`;
const ICON_TRASH = `<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"/></svg>`;

async function loadDoctors() {
  const docs = await api('/admin/doctors');
  window.__doctorsCache = docs; // for edit lookups
  $('#doctorsGrid').innerHTML = docs.map((d) => `
    <div class="bg-white rounded-2xl p-5 shadow-sm">
      <div class="flex items-start gap-3 mb-3">
        ${d.photoUrl ? `<img src="${d.photoUrl}" class="w-14 h-14 rounded-2xl object-cover border"/>` : `<div class="w-14 h-14 rounded-2xl bg-brand-blue/20 flex items-center justify-center text-2xl">👨‍⚕️</div>`}
        <div class="flex-1">
          <h3 class="font-semibold">Dr. ${d.name}</h3>
          <p class="text-sm text-slate-500">${d.specialization}</p>
          <p class="text-xs text-slate-400">${d.experience} yrs · ${d.qualification || ''}</p>
          <p class="text-xs text-slate-400">${d.email} · +91 ${d.phone}</p>
          ${d.clinicName ? `<p class="text-xs text-slate-500 mt-1">🏥 ${d.clinicName}</p>` : ''}
        </div>
        <span class="px-2 py-1 text-xs rounded-full ${d.isAvailable ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}">${d.isAvailable ? 'Active' : 'Inactive'}</span>
      </div>
      <div class="grid grid-cols-2 gap-2 text-sm bg-slate-50 rounded-xl p-3"><div><span class="text-slate-500">Online:</span> ₹${d.onlineConsultFee}</div><div><span class="text-slate-500">Offline:</span> ₹${d.physicalConsultFee}</div><div><span class="text-slate-500">Consults:</span> ${d.consults}</div><div><span class="text-slate-500">Revenue:</span> ₹${Number(d.revenue).toLocaleString()}</div></div>
      <div class="mt-2 text-xs ${d.mustChangePassword ? 'text-amber-600' : 'text-slate-400'}">${d.mustChangePassword ? 'Doctor still needs to set/change password.' : 'Password already set.'}</div>
      <div class="mt-3 flex gap-2 items-center">
        <button onclick="toggleDoctor('${d.id}', ${!d.isAvailable})" class="flex-1 py-2 text-sm rounded-xl border hover:bg-slate-50">${d.isAvailable ? 'Deactivate' : 'Activate'}</button>
        <button onclick="openEditDoctor('${d.id}')" title="Edit doctor" class="px-2.5 py-2 rounded-xl border hover:bg-slate-50 text-slate-600">${ICON_EDIT}</button>
        <button onclick="hardDeleteDoctor('${d.id}', '${d.name.replace(/'/g, "\\'")}')" title="Permanently delete" class="px-2.5 py-2 rounded-xl border border-red-200 text-red-500 hover:bg-red-50">${ICON_TRASH}</button>
      </div>
    </div>`).join('') || '<p class="col-span-full text-center text-slate-400 py-12">No doctors yet. Click "Add Doctor" to begin.</p>';
}

async function toggleDoctor(id, isAvailable) {
  await api('/admin/doctors/' + id, { method: 'PUT', body: JSON.stringify({ isAvailable }) });
  loadDoctors();
}

// Hard-delete (recycle bin icon) — uses the /hard endpoint that blocks if appointments exist
async function hardDeleteDoctor(id, name) {
  if (!confirm(`Permanently delete Dr. ${name}? This is only allowed if the doctor has no appointments.`)) return;
  try {
    await api('/admin/doctors/' + id + '/hard', { method: 'DELETE' });
    loadDoctors();
  } catch (err) { alert(err.message); }
}

function openDoctorModal() {
  document.getElementById('doctorModalTitle').textContent = 'Add Doctor';
  const f = document.getElementById('doctorForm');
  f.dataset.mode = 'create';
  f.dataset.id = '';
  // Bug 2 — make sure the email field is enabled in create mode even if
  // the user previously opened the Edit modal (which disables it).
  f.email.disabled = false;
  f.email.readOnly = false;
  f.password.placeholder = 'Temporary password (optional)';
  $('#doctorModal').classList.remove('hidden');
}
function closeDoctorModal() {
  $('#doctorModal').classList.add('hidden');
  const f = $('#doctorForm');
  f.reset();
  // Bug 2 — reset the email lock so a stale "disabled" state doesn't carry over.
  f.email.disabled = false;
  f.email.readOnly = false;
  $('#doctorFormError').textContent = '';
  $('#doctorFormError').classList.add('hidden');
}

function openEditDoctor(id) {
  const d = (window.__doctorsCache || []).find(x => x.id === id);
  if (!d) return alert('Doctor not found in cache; refresh and try again.');
  document.getElementById('doctorModalTitle').textContent = 'Edit Doctor';
  const f = document.getElementById('doctorForm');
  f.dataset.mode = 'edit';
  f.dataset.id = id;
  f.name.value = d.name || '';
  f.email.value = d.email || '';
  // Bug 2 — show the email but DON'T disable it. `disabled` excludes the field
  // from FormData, which caused the server to receive an empty email and 400.
  // Use `readOnly` instead: user can't edit it but the value IS still submitted.
  // We then strip `email` from the payload in the edit branch of the submit
  // handler so the server-side partial schema is happy.
  f.email.disabled = false;
  f.email.readOnly = true;
  f.password.value = '';
  f.password.placeholder = 'New password (leave blank to keep)';
  f.phone.value = d.phone || '';
  f.qualification.value = d.qualification || '';
  f.experience.value = d.experience ?? '';
  f.bio.value = d.bio || '';
  f.consultationModes.value = d.consultationModes || 'BOTH';
  f.onlineConsultFee.value = d.onlineConsultFee ?? '';
  f.physicalConsultFee.value = d.physicalConsultFee ?? '';
  $('#doctorModal').classList.remove('hidden');
}

document.getElementById('doctorForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#doctorFormError'); errEl.textContent = ''; errEl.classList.add('hidden');
  const f = e.target;
  const fd = new FormData(f);
  const raw = Object.fromEntries(fd.entries());

  const isEdit = f.dataset.mode === 'edit';

  // Bug 7 — sanitize on the client before sending
  const payload = {
    name: (raw.name || '').trim(),
    phone: (raw.phone || '').replace(/\D/g, '').replace(/^91/, ''),
    qualification: (raw.qualification || '').trim() || undefined,
    experience: raw.experience === '' ? 0 : Number(raw.experience),
    bio: (raw.bio || '').trim() || undefined,
    consultationModes: raw.consultationModes || 'BOTH',
    onlineConsultFee: raw.onlineConsultFee === '' ? 0 : Number(raw.onlineConsultFee),
    physicalConsultFee: raw.physicalConsultFee === '' ? 0 : Number(raw.physicalConsultFee)
  };

  // Bug 2 — email is identity, never sent on edit. Server schema is .partial()
  // so omitting the key is valid; sending '' is NOT (fails .email()).
  if (!isEdit) {
    payload.email = (raw.email || '').trim().toLowerCase();
  }

  if (raw.password && raw.password.trim()) payload.password = raw.password;

  try {
    if (isEdit) {
      await api('/admin/doctors/' + f.dataset.id, { method: 'PUT', body: JSON.stringify(payload) });
      alert('Doctor updated.');
    } else {
      const res = await api('/admin/doctors', { method: 'POST', body: JSON.stringify(payload) });
      alert(res.invitePreviewUrl ? `Doctor created. Mock invite link: ${res.invitePreviewUrl}` : 'Doctor created and invite email sent.');
    }
    closeDoctorModal();
    loadDoctors();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

async function loadAppointments() {
  const status = $('#filterStatus').value;
  const qs = status ? `?status=${status}` : '';
  const appts = await api('/admin/appointments' + qs);
  $('#apptsList').innerHTML = appts.map((a) => `
    <div class="p-4 flex items-center justify-between hover:bg-slate-50">
      <div>
        <p class="font-medium">${a.patient.name} <span class="text-slate-400 text-sm">+91 ${a.patient.phone}</span></p>
        <p class="text-sm text-slate-500">Dr. ${a.doctor.name} · ${formatDate(a.date)} ${formatTime(a.startTime)} · ${a.consultationType}</p>
        <p class="text-xs text-slate-400 mt-1">Created: ${new Date(a.createdAt).toLocaleString('en-IN')}</p>
        <p class="text-xs text-slate-400 mt-1">Problem: ${a.primaryProblem}</p>
      </div>
      <div class="text-right">
        <span class="px-3 py-1 text-xs rounded-full ${statusColor(a.status)}">${a.status}</span>
        <p class="text-sm font-semibold mt-1">₹${Number(a.feeAtBooking).toFixed(2)}</p>
        <p class="text-xs ${paymentLabel(a.paymentStatus, a.consultationType).cls}">${paymentLabel(a.paymentStatus, a.consultationType).text}</p>
      </div>
    </div>`).join('') || '<p class="p-12 text-center text-slate-400">No appointments</p>';
}

$('#passwordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api('/auth/change-password', { method: 'POST', body: JSON.stringify(Object.fromEntries(fd.entries())) });
    alert('Password changed successfully.');
    e.target.reset();
  } catch (err) { alert(err.message); }
});

async function showDashboard() {
  $('#loginScreen').classList.add('hidden');
  $('#dashboard').classList.remove('hidden');
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
