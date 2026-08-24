/* Admin: Data Management — permanent deletion of a doctor or patient and
   everything attached to it. Deliberately its own screen (see index.html
   "Danger Zone" section) rather than a button on the regular Doctors/
   Patients lists — same admin auth as every other /api/admin/* route,
   just not one accidental click away from Edit/Deactivate. */
(function(){
'use strict';
const $  = (s, r=document) => r.querySelector(s);
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function toast(m, kind){ if (window.NPToast && NPToast[kind||'success']) NPToast[kind||'success'](m); else alert(m); }

try { VIEW_META.dataManagementView = { title: 'Data Management', sub: 'Permanent deletion — irreversible' }; } catch(_) {}

let __dmTimer = null;
let __dmReqSeq = 0;

async function dmSearch(){
  // Switching the Patient/Doctor type dropdown fires immediately while a
  // debounced keystroke search for the previous type may still be in
  // flight — without a guard, whichever response lands last wins and can
  // repaint the table with results for a type/query the admin already
  // moved away from.
  const __seq = ++__dmReqSeq;
  const type = $('#dmType').value;
  const q = $('#dmSearch').value.trim();
  const host = $('#dmResults');
  if (!host) return;
  if (q.length < 2){
    host.innerHTML = `<div class="np-empty"><div class="np-empty__sub">Type at least 2 characters to search.</div></div>`;
    return;
  }
  host.innerHTML = `<div class="np-empty"><div class="np-empty__sub">Searching…</div></div>`;
  try {
    const rows = await api('/admin/data-management/search?type=' + type + '&q=' + encodeURIComponent(q));
    if (__seq !== __dmReqSeq) return;
    if (!rows.length){
      host.innerHTML = `<div class="np-empty"><div class="np-empty__title">No matches</div></div>`;
      return;
    }
    host.innerHTML = `<div class="np-table-wrap"><table class="np-table np-table--cards np-table--danger"><thead><tr>
        <th>Name</th><th>Contact</th>${type === 'DOCTOR' ? '<th>Status</th>' : '<th>Parent/Guardian</th>'}
        <th style="text-align:right">Action</th>
      </tr></thead><tbody>` + rows.map(r => `
        <tr>
          <td data-label="Name"><b>${esc(r.name)}</b></td>
          <td data-label="Contact" class="np-mut" style="font-size:.82rem">${esc(r.email || '—')}${r.phone ? '<br/>+91 ' + esc(r.phone) : ''}</td>
          <td data-label="${type === 'DOCTOR' ? 'Status' : 'Parent/Guardian'}">${type === 'DOCTOR' ? esc(r.status) : esc(r.parentName || '—')}</td>
          <td data-label="Action" style="text-align:right;">
            <button class="np-btn np-btn--ghost np-btn--sm" onclick="dmView('${type}','${esc(r.id)}')">View</button>
            <button class="np-btn np-btn--danger np-btn--sm" onclick="dmPurge('${type}','${esc(r.id)}','${esc(r.name).replace(/'/g, "\\'")}')">Delete permanently</button>
          </td>
        </tr>`).join('') + '</tbody></table></div>';
  } catch (e) {
    if (__seq !== __dmReqSeq) return;
    host.innerHTML = `<div class="np-error">${esc(e.message)}</div>`;
  }
}

function dmFmtDate(d){
  if (!d) return '—';
  try { return (typeof fmtDate === 'function') ? fmtDate(d) : new Date(d).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }); }
  catch(_) { return String(d); }
}

async function dmView(type, id){
  const host = $('#staffModalHost');
  if (!host) return;
  host.innerHTML = `<div class="np-modal"><div class="np-modal__panel np-modal__panel--lg">
    <header class="np-modal__head"><div class="np-modal__title">Loading…</div><button class="np-modal__close" onclick="closeStaffModal()">×</button></header>
    <div class="np-modal__body"><div class="np-empty"><div class="np-empty__sub">Loading record…</div></div></div>
  </div></div>`;
  try {
    const path = type === 'DOCTOR' ? '/admin/data-management/doctors/' : '/admin/data-management/patients/';
    const data = await api(path + id);
    const rec = type === 'DOCTOR' ? data.doctor : data.patient;
    const counts = data.counts || {};
    const countChips = Object.entries(counts).map(([k, v]) =>
      `<span class="np-badge np-badge--slate">${v} ${esc(k)}</span>`
    ).join(' ');
    const recentRows = (data.recentAppointments || []).map(a => `
      <tr>
        <td data-label="Date">${dmFmtDate(a.date)} ${esc(a.startTime || '')}</td>
        <td data-label="${type === 'DOCTOR' ? 'Patient' : 'Doctor'}">${esc(type === 'DOCTOR' ? (a.patient && a.patient.name) : (a.doctor && a.doctor.name))}</td>
        <td data-label="Status">${esc(a.status)}</td>
      </tr>`).join('');
    host.innerHTML = `<div class="np-modal"><div class="np-modal__panel np-modal__panel--lg">
      <header class="np-modal__head"><div class="np-modal__title">${esc(rec.name)}</div><button class="np-modal__close" onclick="closeStaffModal()">×</button></header>
      <div class="np-modal__body">
        <div class="np-grid-2" style="margin-bottom:.75rem;">
          <div class="np-field"><label class="np-field__label">Phone</label><div>${esc(rec.phone || '—')}</div></div>
          <div class="np-field"><label class="np-field__label">Email</label><div>${esc(rec.email || '—')}</div></div>
          ${type === 'DOCTOR'
            ? `<div class="np-field"><label class="np-field__label">Status</label><div>${esc(rec.status)}</div></div>
               <div class="np-field"><label class="np-field__label">Specialization</label><div>${esc(rec.specialization || '—')}</div></div>`
            : `<div class="np-field"><label class="np-field__label">Parent/Guardian</label><div>${esc(rec.parentName || '—')}</div></div>
               <div class="np-field"><label class="np-field__label">Date of birth</label><div>${dmFmtDate(rec.dateOfBirth)}</div></div>`
          }
        </div>
        <div class="np-field__label" style="margin-bottom:.4rem;">Attached records</div>
        <div style="display:flex; gap:.4rem; flex-wrap:wrap; margin-bottom:1rem;">${countChips || '<span class="np-mut">None</span>'}</div>
        <div class="np-field__label" style="margin-bottom:.4rem;">Recent appointments</div>
        ${recentRows
          ? `<div class="np-table-wrap"><table class="np-table np-table--cards"><thead><tr><th>Date</th><th>${type === 'DOCTOR' ? 'Patient' : 'Doctor'}</th><th>Status</th></tr></thead><tbody>${recentRows}</tbody></table></div>`
          : '<div class="np-empty"><div class="np-empty__sub">No appointments on record.</div></div>'}
        <div class="np-row" style="justify-content:flex-end; gap:.5rem; margin-top:1.25rem;">
          <button type="button" class="np-btn" onclick="closeStaffModal()">Close</button>
          <button type="button" class="np-btn np-btn--danger" onclick="closeStaffModal(); dmPurge('${type}','${esc(id)}','${esc(rec.name).replace(/'/g, "\\'")}')">Delete permanently</button>
        </div>
      </div>
    </div></div>`;
  } catch (e) {
    host.innerHTML = `<div class="np-modal"><div class="np-modal__panel">
      <header class="np-modal__head"><div class="np-modal__title">Error</div><button class="np-modal__close" onclick="closeStaffModal()">×</button></header>
      <div class="np-modal__body"><div class="np-error">${esc(e.message)}</div></div>
    </div></div>`;
  }
}
window.dmView = dmView;

// The list row and the detail-view modal both wire straight to this
// function, and it's the one place a double-click could matter — a second
// click while the first prompt is still up would otherwise stack a second
// independent confirm/password flow for the same record on top of the
// first. Both would still have to be typed out and confirmed separately
// (nothing here can delete twice from one click), but the guard keeps it
// to a single in-flight flow per record instead of a confusing stack of
// modals that outlives the row it refers to.
const __dmPurgeInFlight = new Set();

async function dmPurge(type, id, name){
  if (__dmPurgeInFlight.has(id)) return;
  __dmPurgeInFlight.add(id);
  try {
    const label = type === 'DOCTOR' ? 'doctor' : 'patient';
    const typed = await NPModal.prompt({
      title: `Permanently delete this ${label}?`,
      message: `This deletes ${name} AND every appointment, prescription, certificate and invoice attached to them. This cannot be undone.\n\nType the name exactly to confirm: ${name}`,
      placeholder: name,
      okText: 'Delete permanently'
    });
    if (typed == null) return;
    if (typed.trim() !== name){
      toast('Name did not match — nothing was deleted.', 'error');
      return;
    }
    const password = await NPModal.prompt({
      title: 'Confirm your password',
      message: `Re-enter your admin password to permanently delete ${name}.`,
      inputType: 'password',
      okText: 'Delete permanently'
    });
    if (password == null) return;
    if (!password){
      toast('Password is required — nothing was deleted.', 'error');
      return;
    }
    try {
      const path = type === 'DOCTOR' ? '/admin/data-management/doctors/' : '/admin/data-management/patients/';
      const res = await api(path + id, { method: 'DELETE', body: JSON.stringify({ confirmPassword: password }) });
      toast(res.message || 'Deleted.');
      dmSearch();
    } catch (e) {
      toast(e.message, 'error');
    }
  } finally {
    __dmPurgeInFlight.delete(id);
  }
}
window.dmPurge = dmPurge;

function wire(){
  const type = $('#dmType');
  const search = $('#dmSearch');
  if (search && !search.__dmWired){
    search.__dmWired = true;
    search.addEventListener('input', () => { clearTimeout(__dmTimer); __dmTimer = setTimeout(dmSearch, 300); });
  }
  if (type && !type.__dmWired){
    type.__dmWired = true;
    type.addEventListener('change', dmSearch);
  }
  const btn = document.querySelector('[data-view="dataManagementView"]');
  if (btn && !btn.__dmWired){
    btn.__dmWired = true;
    btn.addEventListener('click', () => { $('#dmResults').innerHTML = ''; if (search) search.value = ''; });
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
else wire();
})();
