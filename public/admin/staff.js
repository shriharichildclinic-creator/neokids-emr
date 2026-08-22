/* v4.0.0 — Admin: Medical Centres, Receptionists, Pharmacy Users, Reception Invoices, Staff Audit */
(function(){
'use strict';
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
let __centres = [], __offlineDoctors = [], __receptionists = [], __pharmUsers = [];

function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function toast(m, kind){ if (window.NPToast && NPToast[kind||'success']) NPToast[kind||'success'](m); else alert(m); }
function fmtDate(d){ if(!d) return ''; return new Date(d).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}); }
function fmtDateTime(d){ if(!d) return ''; const x=new Date(d); return x.toLocaleDateString('en-IN',{day:'2-digit',month:'short'})+' '+x.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}); }
function inr(n){ return '₹'+Number(n||0).toLocaleString('en-IN',{minimumFractionDigits:2}); }
function closeStaffModal(){ const h=$('#staffModalHost'); if(h) h.innerHTML=''; }
window.closeStaffModal = closeStaffModal;

// Shared admin-set profile-photo block for the Receptionist/Pharmacy edit
// modals — same optional-photo pattern as the Doctor edit modal in
// admin/app.js, just inline here since these modals are fully
// regenerated on every open (no persistent show/hide state to manage).
function staffPhotoBlockHtml(entity, kind){
  if (!entity) return '';
  const photoUrl = entity.photoUrl || '';
  return `
    <div class="np-row" style="align-items:center;gap:.75rem;margin-bottom:1rem;">
      <div style="width:48px;height:48px;border-radius:50%;overflow:hidden;background:var(--np-surface-2);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        ${photoUrl
          ? `<img src="${esc(photoUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;cursor:zoom-in" onclick="NPLightbox.open('${esc(photoUrl)}','${esc(entity.name).replace(/'/g,"\\'")}')"/>`
          : `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--np-muted)"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.5-6 8-6s8 2 8 6"/></svg>`}
      </div>
      <div>
        <button type="button" class="np-btn np-btn--sm" onclick="document.getElementById('staffPhotoInput').click()">Upload photo</button>
        ${photoUrl ? `<button type="button" class="np-btn np-btn--ghost np-btn--sm" onclick="removeStaffPhoto('${kind}','${entity.id}')">Remove</button>` : ''}
        <input id="staffPhotoInput" type="file" accept="image/png,image/jpeg,image/webp" class="hidden" onchange="uploadStaffPhoto('${kind}','${entity.id}',this.files[0])"/>
      </div>
    </div>`;
}

async function uploadStaffPhoto(kind, id, file){
  if (!file) return;
  const fd = new FormData();
  fd.append('photo', file);
  try {
    const r = await fetch(API + '/admin/' + (kind === 'RECEPTIONIST' ? 'receptionists' : 'pharmacy-users') + '/' + id + '/profile-image', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN },
      body: fd
    });
    let data = null; try { data = await r.json(); } catch(_) {}
    if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
    toast('Photo updated.');
    if (kind === 'RECEPTIONIST') { await loadReceptionists(); openReceptionistModal(id); }
    else { await loadPharmUsers(); openPharmUserModal(id); }
  } catch (err) { toast(err.message, 'error'); }
}
window.uploadStaffPhoto = uploadStaffPhoto;

async function removeStaffPhoto(kind, id){
  try {
    await api('/admin/' + (kind === 'RECEPTIONIST' ? 'receptionists' : 'pharmacy-users') + '/' + id + '/profile-image', { method: 'DELETE' });
    toast('Photo removed.');
    if (kind === 'RECEPTIONIST') { await loadReceptionists(); openReceptionistModal(id); }
    else { await loadPharmUsers(); openPharmUserModal(id); }
  } catch (err) { toast(err.message, 'error'); }
}
window.removeStaffPhoto = removeStaffPhoto;

try {
  VIEW_META.centresView       = { title:'Medical Centres',   sub:'Clinics & branches' };
  VIEW_META.receptionistsView = { title:'Receptionists',     sub:'Front-desk accounts & permissions' };
  VIEW_META.pharmUsersView    = { title:'Pharmacy Users',    sub:'Medical store accounts' };
  VIEW_META.recInvoicesView   = { title:'Reception Invoices',sub:'Consultation invoices from front desk' };
  VIEW_META.auditView         = { title:'Staff Audit',       sub:'Staff activity trail' };
} catch(_) {}

async function ensureRefData(){
  const jobs = [];
  if (!__centres.length)        jobs.push(api('/admin/medical-centres').then(r => { __centres = r; }));
  if (!__offlineDoctors.length) jobs.push(api('/admin/available-offline-doctors').then(r => { __offlineDoctors = r; }));
  await Promise.all(jobs);
}

// ─────────── Medical Centres ───────────
async function loadCentres(){
  const host = $('#centresList'); if (!host) return;
  host.innerHTML = '<div class="np-empty"><div class="np-empty__title">Loading…</div></div>';
  try {
    __centres = await api('/admin/medical-centres');
    host.innerHTML = __centres.length ? '<div class="np-table-wrap"><table class="np-table np-table--fixed np-table--scroll-x np-table--cards"><colgroup><col style="width:16%"><col style="width:30%"><col style="width:20%"><col style="width:14%"><col style="width:10%"><col style="width:10%"></colgroup><thead><tr><th>Name</th><th>Address</th><th>Contact</th><th>Staff / Appts</th><th>Status</th><th style="text-align:right">Actions</th></tr></thead><tbody>' +
      __centres.map(c => `<tr>
        <td data-label="Name"><b>${esc(c.name)}</b></td>
        <td data-label="Address" class="np-mut" style="font-size:.82rem">${esc([c.address, c.city, c.state, c.pincode].filter(Boolean).join(', ') || '—')}</td>
        <td data-label="Contact" class="np-mut" style="font-size:.82rem">${esc([c.phone, c.email].filter(Boolean).join(' · ') || '—')}</td>
        <td data-label="Staff / Appts" class="np-mut" style="font-size:.82rem">${(c._count && c._count.receptionistAssignments) || 0} reception · ${(c._count && c._count.appointments) || 0} appts</td>
        <td data-label="Status">${c.isActive ? '<span class="np-badge np-badge--green"><span class="np-badge__dot"></span>Active</span>' : '<span class="np-badge np-badge--slate"><span class="np-badge__dot"></span>Inactive</span>'}</td>
        <td data-label="Actions" style="text-align:right"><div style="display:flex;flex-wrap:wrap;gap:.4rem;justify-content:flex-end"><button class="np-btn np-btn--sm" onclick="openCentreModal('${c.id}')">Edit</button> ${c.isActive ? `<button class="np-btn np-btn--ghost np-btn--sm np-btn--danger" onclick="deactivateCentre('${c.id}')">Deactivate</button>` : ''}</div></td>
      </tr>`).join('') + '</tbody></table></div>'
      : '<div class="np-empty"><div class="np-empty__title">No medical centres yet</div><div class="np-empty__sub">Create your first clinic to assign receptionists.</div></div>';
  } catch(e){ host.innerHTML = `<div class="np-error">${esc(e.message)}</div>`; }
}
window.loadCentres = loadCentres;

function openCentreModal(id){
  const c = id ? __centres.find(x => x.id === id) : null;
  $('#staffModalHost').innerHTML = `<div class="np-modal"><div class="np-modal__panel">
    <header class="np-modal__head"><div class="np-modal__title">${c ? 'Edit' : 'Add'} Medical Centre</div><button class="np-modal__close" onclick="closeStaffModal()">×</button></header>
    <div class="np-modal__body"><form id="centreForm"><div class="np-grid-2">
      <div class="np-field" style="grid-column:span 2"><label class="np-field__label">Clinic / branch name *</label><input name="name" required class="np-input" value="${c ? esc(c.name) : ''}"/></div>
      <div class="np-field" style="grid-column:span 2"><label class="np-field__label">Address</label><textarea name="address" class="np-textarea">${c ? esc(c.address || '') : ''}</textarea></div>
      <div class="np-field"><label class="np-field__label">Phone</label><input name="phone" class="np-input" value="${c ? esc(c.phone || '') : ''}"/></div>
      <div class="np-field"><label class="np-field__label">Email</label><input name="email" type="email" class="np-input" value="${c ? esc(c.email || '') : ''}"/></div>
      <div class="np-field"><label class="np-field__label">City</label><input name="city" class="np-input" value="${c ? esc(c.city || '') : ''}"/></div>
      <div class="np-field"><label class="np-field__label">State</label><input name="state" class="np-input" value="${c ? esc(c.state || '') : ''}"/></div>
      <div class="np-field"><label class="np-field__label">Pincode</label><input name="pincode" class="np-input" value="${c ? esc(c.pincode || '') : ''}"/></div>
      <div class="np-field"><label class="np-field__label">Google Maps link</label><input name="mapUrl" class="np-input" value="${c ? esc(c.mapUrl || '') : ''}"/></div>
    </div>
    <div class="np-row" style="justify-content:flex-end;gap:.5rem"><button type="button" class="np-btn" onclick="closeStaffModal()">Cancel</button><button class="np-btn np-btn--primary" type="submit">Save</button></div>
    </form></div></div></div>`;
  $('#centreForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn.disabled) return; // already submitting — ignore a second click/Enter
    btn.disabled = true;
    const raw = Object.fromEntries(new FormData(e.target).entries());
    try {
      if (c) await api('/admin/medical-centres/' + c.id, { method:'PUT', body: JSON.stringify(raw) });
      else   await api('/admin/medical-centres', { method:'POST', body: JSON.stringify(raw) });
      toast('Medical centre saved'); closeStaffModal(); loadCentres();
    } catch(err){ toast(err.message, 'error'); btn.disabled = false; }
  });
}
window.openCentreModal = openCentreModal;

async function deactivateCentre(id){
  if (!confirm('Deactivate this centre? Assignments are kept for history.')) return;
  try { await api('/admin/medical-centres/' + id, { method:'DELETE' }); toast('Centre deactivated'); loadCentres(); }
  catch(e){ toast(e.message, 'error'); }
}
window.deactivateCentre = deactivateCentre;

// ─────────── Receptionists ───────────
async function loadReceptionists(){
  const host = $('#receptionistsList'); if (!host) return;
  host.innerHTML = '<div class="np-empty"><div class="np-empty__title">Loading…</div></div>';
  try {
    __receptionists = await api('/admin/receptionists');
    host.innerHTML = __receptionists.length ? '<div class="np-table-wrap"><table class="np-table np-table--cards"><thead><tr><th>Name</th><th>Contact</th><th>Assignments (Doctor @ Clinic)</th><th>Permissions</th><th>Status</th><th style="text-align:right">Actions</th></tr></thead><tbody>' +
      __receptionists.map(r => `<tr>
        <td data-label="Name"><b>${esc(r.name)}</b></td>
        <td data-label="Contact" class="np-mut" style="font-size:.82rem">${esc(r.email)}<br/>+91 ${esc(r.phone)}</td>
        <td data-label="Assignments (Doctor @ Clinic)" style="font-size:.8rem">${(r.assignments || []).map(a => `<div>Dr. ${esc(a.doctor.name)} <span class="np-mut">@ ${esc(a.medicalCentre.name)}</span></div>`).join('') || '—'}</td>
        <td data-label="Permissions" style="font-size:.78rem">
          ${r.canManageConsultations ? '<span class="np-badge np-badge--blue">Consultations</span>' : ''}
          ${r.canManagePharmacy ? '<span class="np-badge np-badge--mint">Pharmacy</span>' : ''}
          ${r.canIssueCertificates ? '<span class="np-badge np-badge--violet">Certificates</span>' : ''}
        </td>
        <td data-label="Status">${r.status === 'ACTIVE' ? '<span class="np-badge np-badge--green"><span class="np-badge__dot"></span>Active</span>' : '<span class="np-badge np-badge--red"><span class="np-badge__dot"></span>Suspended</span>'}</td>
        <td data-label="Actions" style="text-align:right;white-space:nowrap"><button class="np-btn np-btn--sm" onclick="openReceptionistModal('${r.id}')">Edit</button> <button class="np-btn np-btn--ghost np-btn--sm np-btn--danger" onclick="deleteReceptionist('${r.id}')">Deactivate</button></td>
      </tr>`).join('') + '</tbody></table></div>'
      : '<div class="np-empty"><div class="np-empty__title">No receptionists yet</div><div class="np-empty__sub">Receptionists cannot self-register — create their accounts here.</div></div>';
  } catch(e){ host.innerHTML = `<div class="np-error">${esc(e.message)}</div>`; }
}
window.loadReceptionists = loadReceptionists;

async function openReceptionistModal(id){
  await ensureRefData();
  if (!__offlineDoctors.length) { toast('No offline-available doctors found. Enable OFFLINE/BOTH mode for a doctor first.', 'warn'); }
  if (!__centres.length) { toast('Create a Medical Centre first.', 'warn'); return; }
  const r = id ? __receptionists.find(x => x.id === id) : null;

  const asnRows = (r && r.assignments.length ? r.assignments : [null]).map(a => assignmentRowHtml(a)).join('');
  $('#staffModalHost').innerHTML = `<div class="np-modal"><div class="np-modal__panel np-modal__panel--lg">
    <header class="np-modal__head"><div class="np-modal__title">${r ? 'Edit' : 'Add'} Receptionist</div><button class="np-modal__close" onclick="closeStaffModal()">×</button></header>
    <div class="np-modal__body">${staffPhotoBlockHtml(r, 'RECEPTIONIST')}<form id="recForm"><div class="np-grid-2">
      <div class="np-field"><label class="np-field__label">Full name *</label><input name="name" required class="np-input" value="${r ? esc(r.name) : ''}"/></div>
      <div class="np-field"><label class="np-field__label">Mobile (10 digits) *</label><input name="phone" required maxlength="10" class="np-input" value="${r ? esc(r.phone) : ''}"/></div>
      <div class="np-field"><label class="np-field__label">Email / username *</label><input name="email" type="email" required ${r ? 'readonly' : ''} class="np-input" value="${r ? esc(r.email) : ''}"/></div>
      <div class="np-field"><label class="np-field__label">${r ? 'Reset password (blank = keep)' : 'Temporary password (blank = email invite)'}</label><input name="password" type="password" minlength="8" class="np-input"/></div>
      <div class="np-field"><label class="np-field__label">Status</label><select name="status" class="np-select"><option value="ACTIVE" ${r && r.status !== 'ACTIVE' ? '' : 'selected'}>Active</option><option value="SUSPENDED" ${r && r.status === 'SUSPENDED' ? 'selected' : ''}>Suspended</option></select></div>
    </div>
    <div class="np-inline-panel" style="padding:.75rem;border-radius:8px;margin-top:.5rem">
      <div class="np-ink" style="font-weight:600;font-size:.85rem;margin-bottom:.4rem">Role permissions</div>
      <label class="np-row" style="gap:.5rem"><input type="checkbox" name="canManageConsultations" ${!r || r.canManageConsultations ? 'checked' : ''}/> <span>Consultation management — appointments, patients, consultation invoices, consultation records</span></label>
      <label class="np-row" style="gap:.5rem;margin-top:.35rem"><input type="checkbox" name="canManagePharmacy" ${r && r.canManagePharmacy ? 'checked' : ''}/> <span>Medical store / Pharmacy — view prescriptions, dispense, pharmacy billing</span></label>
      <label class="np-row" style="gap:.5rem;margin-top:.35rem"><input type="checkbox" name="canIssueCertificates" ${r && r.canIssueCertificates ? 'checked' : ''}/> <span>Issue medical certificates in the assigned doctor's name</span></label>
    </div>
    <div class="np-inline-panel" style="padding:.75rem;border-radius:8px;margin-top:.75rem">
      <div class="np-ink" style="font-weight:600;font-size:.85rem;margin-bottom:.2rem">Doctor &amp; clinic assignments</div>
      <div class="np-mut" style="font-size:.72rem;margin-bottom:.5rem">Only doctors available for OFFLINE consultations are listed, with their clinic address and registration number from their own profile.</div>
      <div id="asnRows">${asnRows}</div>
      <button type="button" class="np-btn np-btn--ghost np-btn--sm" onclick="addAssignmentRow()">+ Add assignment</button>
    </div>
    <div class="np-row" style="justify-content:flex-end;gap:.5rem;margin-top:.75rem">
      ${r ? `<button type="button" class="np-btn" onclick="sendReceptionistInvite('${r.id}')">Send Invite</button>` : ''}
      <button type="button" class="np-btn" onclick="closeStaffModal()">Cancel</button>
      <button class="np-btn np-btn--primary" type="submit">Save</button>
    </div>
    </form></div></div></div>`;

  $('#recForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button[type="submit"]');
    if (btn.disabled) return; // already submitting — ignore a second click/Enter
    const raw = Object.fromEntries(new FormData(f).entries());
    const assignments = $$('#asnRows .asn-row').map(row => ({
      doctorId: row.querySelector('.asn-doctor').value,
      medicalCentreId: row.querySelector('.asn-centre').value
    })).filter(a => a.doctorId && a.medicalCentreId);
    if (!assignments.length) { toast('Add at least one doctor + clinic assignment', 'error'); return; }
    btn.disabled = true;
    const payload = {
      name: raw.name, phone: raw.phone,
      status: raw.status,
      canManageConsultations: !!f.canManageConsultations.checked,
      canManagePharmacy: !!f.canManagePharmacy.checked,
      canIssueCertificates: !!f.canIssueCertificates.checked,
      assignments
    };
    if (!r) payload.email = (raw.email || '').trim().toLowerCase();
    if (raw.password && raw.password.trim()) payload.password = raw.password;
    try {
      const res = r
        ? await api('/admin/receptionists/' + r.id, { method:'PUT', body: JSON.stringify(payload) })
        : await api('/admin/receptionists', { method:'POST', body: JSON.stringify(payload) });
      toast(r ? 'Receptionist saved' : 'Receptionist created. Send the invite whenever you\'re ready.');
      closeStaffModal(); loadReceptionists();
    } catch(err){ toast(err.message, 'error'); btn.disabled = false; }
  });
}
window.openReceptionistModal = openReceptionistModal;

async function sendReceptionistInvite(id){
  const r = __receptionists.find(x => x.id === id);
  const ok = await NPModal.confirm({
    title: 'Send onboarding invite?',
    message: `This emails ${r ? esc(r.name) : 'this receptionist'} a one-time link to set their password and activate their account.`,
    okText: 'Send invite'
  });
  if (!ok) return;
  try {
    const res = await api('/admin/receptionists/' + id + '/invite', { method: 'POST' });
    showInviteResult(res, 'receptionist');
  } catch (e) { toast(e.message, 'error'); }
}
window.sendReceptionistInvite = sendReceptionistInvite;

function assignmentRowHtml(a){
  const docOpts = __offlineDoctors.map(d =>
    `<option value="${d.id}" ${a && a.doctorId === d.id ? 'selected' : ''}>Dr. ${esc(d.name)} — ${esc(d.clinicName || 'No clinic name')} · Reg ${esc(d.registrationNumber || '—')} · ₹${Number(d.physicalConsultFee || 0)}</option>`
  ).join('');
  const centreOpts = __centres.filter(c => c.isActive).map(c =>
    `<option value="${c.id}" ${a && a.medicalCentreId === c.id ? 'selected' : ''}>${esc(c.name)}${c.city ? ' (' + esc(c.city) + ')' : ''}</option>`
  ).join('');
  return `<div class="asn-row np-row" style="gap:.5rem;margin-bottom:.5rem;align-items:flex-end">
    <div class="np-field" style="flex:2;margin:0"><label class="np-field__label">Doctor (offline)</label><select class="np-select asn-doctor">${docOpts}</select></div>
    <div class="np-field" style="flex:1;margin:0"><label class="np-field__label">Medical centre</label><select class="np-select asn-centre">${centreOpts}</select></div>
    <button type="button" class="np-btn np-btn--ghost np-btn--sm" onclick="this.closest('.asn-row').remove()">✕</button>
  </div>`;
}
function addAssignmentRow(){
  const host = $('#asnRows');
  if (host) host.insertAdjacentHTML('beforeend', assignmentRowHtml(null));
}
window.addAssignmentRow = addAssignmentRow;

async function deleteReceptionist(id){
  if (!confirm('Deactivate this receptionist? They will no longer be able to sign in.')) return;
  try { await api('/admin/receptionists/' + id, { method:'DELETE' }); toast('Receptionist deactivated'); loadReceptionists(); }
  catch(e){ toast(e.message, 'error'); }
}
window.deleteReceptionist = deleteReceptionist;

// ─────────── Pharmacy Users ───────────
async function loadPharmUsers(){
  const host = $('#pharmUsersList'); if (!host) return;
  host.innerHTML = '<div class="np-empty"><div class="np-empty__title">Loading…</div></div>';
  try {
    __pharmUsers = await api('/admin/pharmacy-users');
    host.innerHTML = __pharmUsers.length ? '<div class="np-table-wrap"><table class="np-table np-table--cards"><thead><tr><th>Name</th><th>Contact</th><th>Centre</th><th>Responsible doctors</th><th>Status</th><th style="text-align:right">Actions</th></tr></thead><tbody>' +
      __pharmUsers.map(u => `<tr>
        <td data-label="Name"><b>${esc(u.name)}</b></td>
        <td data-label="Contact" class="np-mut" style="font-size:.82rem">${esc(u.email)}<br/>+91 ${esc(u.phone)}</td>
        <td data-label="Centre">${esc(u.medicalCentre ? u.medicalCentre.name : '—')}</td>
        <td data-label="Responsible doctors" style="font-size:.8rem">${(u.doctors || []).map(d => `<div>Dr. ${esc(d.doctor.name)}</div>`).join('') || '—'}</td>
        <td data-label="Status">${u.status === 'ACTIVE' ? '<span class="np-badge np-badge--green"><span class="np-badge__dot"></span>Active</span>' : '<span class="np-badge np-badge--red"><span class="np-badge__dot"></span>Suspended</span>'}</td>
        <td data-label="Actions" style="text-align:right;white-space:nowrap"><button class="np-btn np-btn--sm" onclick="openPharmUserModal('${u.id}')">Edit</button> <button class="np-btn np-btn--ghost np-btn--sm np-btn--danger" onclick="deletePharmUser('${u.id}')">Deactivate</button></td>
      </tr>`).join('') + '</tbody></table></div>'
      : '<div class="np-empty"><div class="np-empty__title">No pharmacy users yet</div></div>';
  } catch(e){ host.innerHTML = `<div class="np-error">${esc(e.message)}</div>`; }
}
window.loadPharmUsers = loadPharmUsers;

async function openPharmUserModal(id){
  await ensureRefData();
  if (!__centres.length) { toast('Create a Medical Centre first.', 'warn'); return; }
  const u = id ? __pharmUsers.find(x => x.id === id) : null;
  const selectedDocs = new Set(u ? (u.doctors || []).map(d => d.doctor.id) : []);
  const docChecks = __offlineDoctors.map(d =>
    `<label class="np-row" style="gap:.5rem;margin-bottom:.25rem"><input type="checkbox" name="pdoc" value="${d.id}" ${selectedDocs.has(d.id) ? 'checked' : ''}/> <span>Dr. ${esc(d.name)} <span class="np-mut">· ${esc(d.clinicName || '')} · Reg ${esc(d.registrationNumber || '—')}</span></span></label>`
  ).join('');
  const centreOpts = '<option value="">— No centre —</option>' + __centres.filter(c => c.isActive).map(c =>
    `<option value="${c.id}" ${u && u.medicalCentreId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');

  $('#staffModalHost').innerHTML = `<div class="np-modal"><div class="np-modal__panel np-modal__panel--lg">
    <header class="np-modal__head"><div class="np-modal__title">${u ? 'Edit' : 'Add'} Pharmacy User</div><button class="np-modal__close" onclick="closeStaffModal()">×</button></header>
    <div class="np-modal__body">${staffPhotoBlockHtml(u, 'PHARMACY')}<form id="puForm"><div class="np-grid-2">
      <div class="np-field"><label class="np-field__label">Full name *</label><input name="name" required class="np-input" value="${u ? esc(u.name) : ''}"/></div>
      <div class="np-field"><label class="np-field__label">Mobile (10 digits) *</label><input name="phone" required maxlength="10" class="np-input" value="${u ? esc(u.phone) : ''}"/></div>
      <div class="np-field"><label class="np-field__label">Email / username *</label><input name="email" type="email" required ${u ? 'readonly' : ''} class="np-input" value="${u ? esc(u.email) : ''}"/></div>
      <div class="np-field"><label class="np-field__label">${u ? 'Reset password (blank = keep)' : 'Temporary password (blank = email invite)'}</label><input name="password" type="password" minlength="8" class="np-input"/></div>
      <div class="np-field"><label class="np-field__label">Medical centre</label><select name="medicalCentreId" class="np-select">${centreOpts}</select></div>
      <div class="np-field"><label class="np-field__label">Status</label><select name="status" class="np-select"><option value="ACTIVE" ${u && u.status !== 'ACTIVE' ? '' : 'selected'}>Active</option><option value="SUSPENDED" ${u && u.status === 'SUSPENDED' ? 'selected' : ''}>Suspended</option></select></div>
    </div>
    <div class="np-inline-panel" style="padding:.75rem;border-radius:8px;margin-top:.5rem">
      <div class="np-ink" style="font-weight:600;font-size:.85rem;margin-bottom:.4rem">Responsible doctors (offline)</div>
      <div class="np-mut" style="font-size:.72rem;margin-bottom:.5rem">This pharmacy account sees prescriptions issued by these doctors only.</div>
      ${docChecks || '<div class="np-mut">No offline doctors available.</div>'}
    </div>
    <div class="np-row" style="justify-content:flex-end;gap:.5rem;margin-top:.75rem">
      ${u ? `<button type="button" class="np-btn" onclick="sendPharmUserInvite('${u.id}')">Send Invite</button>` : ''}
      <button type="button" class="np-btn" onclick="closeStaffModal()">Cancel</button>
      <button class="np-btn np-btn--primary" type="submit">Save</button>
    </div>
    </form></div></div></div>`;

  $('#puForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button[type="submit"]');
    if (btn.disabled) return; // already submitting — ignore a second click/Enter
    const raw = Object.fromEntries(new FormData(f).entries());
    const doctorIds = $$('input[name="pdoc"]:checked', f).map(x => x.value);
    if (!doctorIds.length) { toast('Assign at least one doctor', 'error'); return; }
    btn.disabled = true;
    const payload = { name: raw.name, phone: raw.phone, status: raw.status, doctorIds };
    payload.medicalCentreId = raw.medicalCentreId || null;
    if (!u) payload.email = (raw.email || '').trim().toLowerCase();
    if (raw.password && raw.password.trim()) payload.password = raw.password;
    try {
      const res = u
        ? await api('/admin/pharmacy-users/' + u.id, { method:'PUT', body: JSON.stringify(payload) })
        : await api('/admin/pharmacy-users', { method:'POST', body: JSON.stringify(payload) });
      toast(u ? 'Pharmacy user saved' : 'Pharmacy user created. Send the invite whenever you\'re ready.');
      closeStaffModal(); loadPharmUsers();
    } catch(err){ toast(err.message, 'error'); btn.disabled = false; }
  });
}
window.openPharmUserModal = openPharmUserModal;

async function sendPharmUserInvite(id){
  const u = __pharmUsers.find(x => x.id === id);
  const ok = await NPModal.confirm({
    title: 'Send onboarding invite?',
    message: `This emails ${u ? esc(u.name) : 'this pharmacy user'} a one-time link to set their password and activate their account.`,
    okText: 'Send invite'
  });
  if (!ok) return;
  try {
    const res = await api('/admin/pharmacy-users/' + id + '/invite', { method: 'POST' });
    showInviteResult(res, 'pharmacy user');
  } catch (e) { toast(e.message, 'error'); }
}
window.sendPharmUserInvite = sendPharmUserInvite;

async function deletePharmUser(id){
  if (!confirm('Deactivate this pharmacy user?')) return;
  try { await api('/admin/pharmacy-users/' + id, { method:'DELETE' }); toast('Pharmacy user deactivated'); loadPharmUsers(); }
  catch(e){ toast(e.message, 'error'); }
}
window.deletePharmUser = deletePharmUser;

// ─────────── Reception Invoices (admin read-only) ───────────
let __invDoctors = [];
async function __ensureInvDoctors(){
  if (__invDoctors.length) return __invDoctors;
  try { __invDoctors = await api('/admin/doctors'); } catch(_) { __invDoctors = []; }
  return __invDoctors;
}
function __fillDoctorSelect(sel){
  if (!sel) return;
  const prev = sel.value;
  const head = sel.options[0];
  sel.innerHTML = '';
  if (head) sel.appendChild(head);
  __invDoctors.forEach(d => { const o = document.createElement('option'); o.value = d.id; o.textContent = 'Dr. ' + (d.name || ''); sel.appendChild(o); });
  if (prev && __invDoctors.some(d => d.id === prev)) sel.value = prev;
}
function __fillCentreSelect(sel){
  if (!sel) return;
  const prev = sel.value;
  const head = sel.options[0];
  sel.innerHTML = '';
  if (head) sel.appendChild(head);
  (__centres || []).forEach(c => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name || ''; sel.appendChild(o); });
  if (prev && (__centres || []).some(c => c.id === prev)) sel.value = prev;
}

async function loadRecInvoices(){
  const tb = $('#recInvTbody'); if (!tb) return;
  await __ensureInvDoctors();
  if (!__centres.length) { try { __centres = await api('/admin/medical-centres'); } catch(_) {} }
  __fillDoctorSelect($('#recInvDoctor'));
  __fillCentreSelect($('#recInvCentre'));
  tb.innerHTML = '<tr><td colspan="8" class="np-mut" style="text-align:center;padding:1.4rem">Loading…</td></tr>';
  const qs = new URLSearchParams();
  const q = ($('#recInvSearch') && $('#recInvSearch').value || '').trim();
  if (q.length >= 2) qs.set('q', q);
  if ($('#recInvDoctor') && $('#recInvDoctor').value) qs.set('doctorId', $('#recInvDoctor').value);
  if ($('#recInvCentre') && $('#recInvCentre').value) qs.set('centreId', $('#recInvCentre').value);
  if ($('#recInvFrom') && $('#recInvFrom').value) qs.set('from', $('#recInvFrom').value);
  if ($('#recInvTo') && $('#recInvTo').value) qs.set('to', $('#recInvTo').value);
  try {
    const rows = await api('/admin/consultation-invoices' + (qs.toString() ? '?' + qs.toString() : ''));
    tb.innerHTML = rows.length ? rows.map(i => `<tr>
      <td data-label="Invoice #"><b>${esc(i.invoiceNumber)}</b></td>
      <td data-label="Patient">${esc(i.appointment.patient.name)}</td>
      <td data-label="Doctor">Dr. ${esc(i.appointment.doctor.name)}</td>
      <td data-label="Clinic">${esc(i.medicalCentre ? i.medicalCentre.name : '—')}</td>
      <td data-label="Receptionist">${esc(i.receptionist ? i.receptionist.name : '—')}</td>
      <td data-label="Amount" style="text-align:right"><b>${inr(i.amount)}</b></td>
      <td data-label="Date">${esc(fmtDateTime(i.createdAt))}</td>
      <td data-label="PDF" style="text-align:right">${i.pdfUrl ? `<a class="np-btn np-btn--sm" href="${i.pdfUrl}" target="_blank">PDF</a>` : '—'}</td>
    </tr>`).join('') : '<tr><td colspan="8"><div class="np-empty"><div class="np-empty__title">No reception invoices match</div></div></td></tr>';
  } catch(e){ tb.innerHTML = `<tr><td colspan="8"><div class="np-error">${esc(e.message)}</div></td></tr>`; }
}
window.loadRecInvoices = loadRecInvoices;

// ─────────── Online Booking Invoices (admin read-only) ───────────
async function loadOnlineInvoices(){
  const tb = $('#onlineInvTbody'); if (!tb) return;
  await __ensureInvDoctors();
  __fillDoctorSelect($('#onlineInvDoctor'));
  tb.innerHTML = '<tr><td colspan="7" class="np-mut" style="text-align:center;padding:1.4rem">Loading…</td></tr>';
  const qs = new URLSearchParams();
  const q = ($('#onlineInvSearch') && $('#onlineInvSearch').value || '').trim();
  if (q.length >= 2) qs.set('q', q);
  if ($('#onlineInvDoctor') && $('#onlineInvDoctor').value) qs.set('doctorId', $('#onlineInvDoctor').value);
  if ($('#onlineInvFrom') && $('#onlineInvFrom').value) qs.set('from', $('#onlineInvFrom').value);
  if ($('#onlineInvTo') && $('#onlineInvTo').value) qs.set('to', $('#onlineInvTo').value);
  try {
    const rows = await api('/admin/online-invoices' + (qs.toString() ? '?' + qs.toString() : ''));
    const payBadge = p => {
      const paid = p === 'PAID' || p === 'CASH_COLLECTED';
      return `<span class="np-badge ${paid ? 'np-badge--green' : 'np-badge--amber'}"><span class="np-badge__dot"></span>${esc(p || '—')}</span>`;
    };
    tb.innerHTML = rows.length ? rows.map(i => `<tr>
      <td data-label="Invoice #"><b>${esc(i.invoiceNumber)}</b></td>
      <td data-label="Patient">${esc(i.patient.name)}<div class="np-mut" style="font-size:.72rem">+91 ${esc(i.patient.phone || '')}</div></td>
      <td data-label="Doctor">Dr. ${esc(i.doctor.name)}</td>
      <td data-label="Payment">${payBadge(i.paymentStatus)}</td>
      <td data-label="Amount" style="text-align:right"><b>${inr(i.amount)}</b></td>
      <td data-label="Date">${esc(fmtDateTime(i.createdAt))}</td>
      <td data-label="PDF" style="text-align:right">${i.pdfUrl ? `<a class="np-btn np-btn--sm" href="${i.pdfUrl}" target="_blank">PDF</a>` : '—'}</td>
    </tr>`).join('') : '<tr><td colspan="7"><div class="np-empty"><div class="np-empty__title">No online booking invoices match</div></div></td></tr>';
  } catch(e){ tb.innerHTML = `<tr><td colspan="7"><div class="np-error">${esc(e.message)}</div></td></tr>`; }
}
window.loadOnlineInvoices = loadOnlineInvoices;

// ─────────── Staff Audit ───────────
async function loadAudit(){
  const tb = $('#auditTbody'); if (!tb) return;
  tb.innerHTML = '<tr><td colspan="5" class="np-mut" style="text-align:center;padding:1.4rem">Loading…</td></tr>';
  const qs = new URLSearchParams();
  if ($('#auditRole').value)   qs.set('role', $('#auditRole').value);
  if ($('#auditAction').value) qs.set('action', $('#auditAction').value);
  if ($('#auditFrom').value)   qs.set('from', $('#auditFrom').value);
  if ($('#auditTo').value)     qs.set('to', $('#auditTo').value);
  qs.set('limit', '100');
  try {
    const data = await api('/admin/audit-trail?' + qs.toString());
    const rows = data.rows || [];
    const roleBadge = r => r === 'RECEPTIONIST' ? 'np-badge--violet' : r === 'PHARMACY' ? 'np-badge--mint' : 'np-badge--slate';
    tb.innerHTML = rows.length ? rows.map(a => `<tr>
      <td data-label="Time" class="np-mut" style="font-size:.8rem">${esc(fmtDateTime(a.createdAt))}</td>
      <td data-label="Staff"><b>${esc(a.actorName || a.actorId)}</b></td>
      <td data-label="Role"><span class="np-badge ${roleBadge(a.actorRole)}">${esc(a.actorRole)}</span></td>
      <td data-label="Action" style="font-size:.8rem">${esc(a.action.replace(/_/g, ' '))}</td>
      <td data-label="Details" class="np-mut" style="font-size:.8rem">${esc(a.summary || '—')}</td>
    </tr>`).join('') : '<tr><td colspan="5"><div class="np-empty"><div class="np-empty__title">No audit entries</div></div></td></tr>';
  } catch(e){ tb.innerHTML = `<tr><td colspan="5"><div class="np-error">${esc(e.message)}</div></td></tr>`; }
}
window.loadAudit = loadAudit;

// ─────────── Wiring ───────────
function wire(){
  const binds = [
    ['centresView', loadCentres],
    ['receptionistsView', loadReceptionists],
    ['pharmUsersView', loadPharmUsers],
    ['recInvoicesView', loadRecInvoices],
    ['onlineInvoicesView', loadOnlineInvoices],
    ['auditView', loadAudit]
  ];
  binds.forEach(([view, loader]) => {
    const btn = document.querySelector(`[data-view="${view}"]`);
    if (btn && !btn.__staffWired) { btn.__staffWired = true; btn.addEventListener('click', loader); }
  });
  const af = $('#auditFilters');
  if (af && !af.__wired) { af.__wired = true; af.addEventListener('submit', e => { e.preventDefault(); loadAudit(); }); }

  const rif = $('#recInvFilters');
  if (rif && !rif.__wired) { rif.__wired = true; rif.addEventListener('submit', e => { e.preventDefault(); loadRecInvoices(); }); }
  const ris = $('#recInvSearch');
  if (ris && !ris.__wired) { ris.__wired = true; ris.addEventListener('input', () => { clearTimeout(window.__recInvT); window.__recInvT = setTimeout(loadRecInvoices, 280); }); }
  const ric = $('#recInvClear');
  if (ric && !ric.__wired) { ric.__wired = true; ric.addEventListener('click', () => { ['recInvSearch','recInvDoctor','recInvCentre','recInvFrom','recInvTo'].forEach(id => { const el = $('#' + id); if (el) el.value = ''; }); loadRecInvoices(); }); }

  const oif = $('#onlineInvFilters');
  if (oif && !oif.__wired) { oif.__wired = true; oif.addEventListener('submit', e => { e.preventDefault(); loadOnlineInvoices(); }); }
  const ois = $('#onlineInvSearch');
  if (ois && !ois.__wired) { ois.__wired = true; ois.addEventListener('input', () => { clearTimeout(window.__onlineInvT); window.__onlineInvT = setTimeout(loadOnlineInvoices, 280); }); }
  const oic = $('#onlineInvClear');
  if (oic && !oic.__wired) { oic.__wired = true; oic.addEventListener('click', () => { ['onlineInvSearch','onlineInvDoctor','onlineInvFrom','onlineInvTo'].forEach(id => { const el = $('#' + id); if (el) el.value = ''; }); loadOnlineInvoices(); }); }
  if (window.NPPalette) {
    [
      ['Go to Medical Centres', '🏥', () => setView('centresView')],
      ['Go to Receptionists',   '🖥️', () => setView('receptionistsView')],
      ['Go to Pharmacy Users',  '💊', () => setView('pharmUsersView')],
      ['Go to Reception Invoices', '🧾', () => setView('recInvoicesView')],
      ['Go to Online Invoices', '🌐', () => setView('onlineInvoicesView')],
      ['Go to Staff Audit',     '🕒', () => setView('auditView')]
    ].forEach(([label, icon, run]) => { try { NPPalette.register({ label, icon, run, keywords: label }); } catch(_) {} });
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
else wire();
})();