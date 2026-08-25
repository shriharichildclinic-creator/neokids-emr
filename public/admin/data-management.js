/* Admin: Data Management — permanent deletion of a doctor, patient,
   medical centre, receptionist, or pharmacy user, and everything
   attached to it. Deliberately its own screen (see index.html
   "Danger Zone" section) rather than a button on the regular Doctors/
   Patients/Staff lists — same admin auth as every other /api/admin/*
   route, just not one accidental click away from Edit/Deactivate.

   FEATURE ADD: this used to hardcode PATIENT/DOCTOR everywhere (column
   labels, detail-modal fields, API paths, confirm-dialog copy) — there
   was no way to hard-delete a medical centre, receptionist, or pharmacy
   user at all, and centres in particular had no way back to Active once
   deactivated (see admin-clinic.controller.js activateCentre). The
   per-type behaviour below is now a small config table (TYPE_CONFIG) so
   adding a type never means re-writing the search/view/purge functions
   again. */
(function(){
'use strict';
const $  = (s, r=document) => r.querySelector(s);
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function toast(m, kind){ if (window.NPToast && NPToast[kind||'success']) NPToast[kind||'success'](m); else alert(m); }

try { VIEW_META.dataManagementView = { title: 'Data Management', sub: 'Permanent deletion — irreversible' }; } catch(_) {}

// One entry per selectable type in #dmType. `path` is the
// /admin/data-management/<path>/:id segment used for both the detail
// GET and the purge DELETE. `rootKey` is the key the detail response
// nests the record under (varies per controller function — see
// admin-data.controller.js). `hasAppointments` toggles the "Recent
// appointments" table in the view modal (only patients/doctors have one).
const TYPE_CONFIG = {
  PATIENT:        { label: 'patient',        path: 'patients',         rootKey: 'patient',        hasAppointments: true  },
  DOCTOR:         { label: 'doctor',         path: 'doctors',          rootKey: 'doctor',         hasAppointments: true  },
  MEDICAL_CENTRE: { label: 'medical centre', path: 'medical-centres',  rootKey: 'centre',         hasAppointments: false },
  RECEPTIONIST:   { label: 'receptionist',   path: 'receptionists',    rootKey: 'receptionist',   hasAppointments: false },
  PHARMACY:       { label: 'pharmacy user',  path: 'pharmacy-users',   rootKey: 'pharmacyUser',   hasAppointments: false }
};

// What gets destroyed, spelled out per type for the delete-confirmation
// dialog — the patient/doctor wording was accurate only for those two;
// the others have a different (smaller) blast radius and deserve their
// own accurate description rather than a generic "and everything
// attached to it".
const PURGE_WARNING = {
  PATIENT:        'This deletes {name} AND every appointment, prescription, certificate and invoice attached to them.',
  DOCTOR:         'This deletes {name} AND every appointment, prescription, certificate, invoice and settlement attached to them.',
  MEDICAL_CENTRE: 'This deletes {name}. Receptionist assignments at this centre are removed with it; appointments, invoices and pharmacy bills tied to it keep their history but lose the centre reference.',
  RECEPTIONIST:   'This deletes {name} and their clinic assignments. Invoices they generated keep their history but lose the attribution.',
  PHARMACY:       'This deletes {name} and their doctor assignments.'
};

let __dmTimer = null;
let __dmReqSeq = 0;

function dmContactCell(r){
  return `${esc(r.email || '—')}${r.phone ? '<br/>+91 ' + esc(r.phone) : ''}`;
}

async function dmSearch(){
  // Switching the type dropdown fires immediately while a debounced
  // keystroke search for the previous type may still be in flight —
  // without a guard, whichever response lands last wins and can repaint
  // the table with results for a type/query the admin already moved
  // away from.
  const __seq = ++__dmReqSeq;
  const type = $('#dmType').value;
  const cfg = TYPE_CONFIG[type];
  const q = $('#dmSearch').value.trim();
  const host = $('#dmResults');
  if (!host || !cfg) return;
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
    // Every type except PATIENT gets a `status` field back from the
    // search endpoint; PATIENT shows Parent/Guardian in that column
    // instead since it has no active/deactivated concept of its own.
    const thirdHeader = type === 'PATIENT' ? 'Parent/Guardian' : 'Status';
    host.innerHTML = `<div class="np-table-wrap"><table class="np-table np-table--cards np-table--danger"><thead><tr>
        <th>Name</th><th>Contact</th><th>${thirdHeader}</th>
        <th style="text-align:right">Action</th>
      </tr></thead><tbody>` + rows.map(r => `
        <tr>
          <td data-label="Name"><b>${esc(r.name)}</b></td>
          <td data-label="Contact" class="np-mut" style="font-size:.82rem">${dmContactCell(r)}</td>
          <td data-label="${thirdHeader}">${type === 'PATIENT' ? esc(r.parentName || '—') : esc(r.status)}</td>
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

// Type-specific extra fields shown in the view modal's top grid, beyond
// the Phone/Email pair every type has. Kept as small render functions
// (rather than another data table) since each type's "interesting"
// fields are genuinely different shapes.
function dmExtraFields(type, rec, counts){
  if (type === 'DOCTOR') return `
    <div class="np-field"><label class="np-field__label">Status</label><div>${esc(rec.status)}</div></div>
    <div class="np-field"><label class="np-field__label">Specialization</label><div>${esc(rec.specialization || '—')}</div></div>`;
  if (type === 'PATIENT') return `
    <div class="np-field"><label class="np-field__label">Parent/Guardian</label><div>${esc(rec.parentName || '—')}</div></div>
    <div class="np-field"><label class="np-field__label">Date of birth</label><div>${dmFmtDate(rec.dateOfBirth)}</div></div>`;
  if (type === 'MEDICAL_CENTRE') return `
    <div class="np-field"><label class="np-field__label">Status</label><div>${esc(rec.status)}</div></div>
    <div class="np-field"><label class="np-field__label">City</label><div>${esc(rec.city || '—')}</div></div>
    <div class="np-field" style="grid-column:span 2"><label class="np-field__label">Address</label><div>${esc(rec.address || '—')}</div></div>`;
  if (type === 'RECEPTIONIST') return `
    <div class="np-field"><label class="np-field__label">Status</label><div>${esc(rec.status)}</div></div>
    <div class="np-field"><label class="np-field__label">Clinic assignments</label><div>${counts.assignments || 0}</div></div>`;
  if (type === 'PHARMACY') return `
    <div class="np-field"><label class="np-field__label">Status</label><div>${esc(rec.status)}</div></div>
    <div class="np-field"><label class="np-field__label">Medical centre</label><div>${esc((rec.medicalCentre && rec.medicalCentre.name) || '—')}</div></div>`;
  return '';
}

async function dmView(type, id){
  const cfg = TYPE_CONFIG[type];
  const host = $('#staffModalHost');
  if (!host || !cfg) return;
  host.innerHTML = `<div class="np-modal"><div class="np-modal__panel np-modal__panel--lg">
    <header class="np-modal__head"><div class="np-modal__title">Loading…</div><button class="np-modal__close" onclick="closeStaffModal()">×</button></header>
    <div class="np-modal__body"><div class="np-empty"><div class="np-empty__sub">Loading record…</div></div></div>
  </div></div>`;
  try {
    const data = await api('/admin/data-management/' + cfg.path + '/' + id);
    const rec = data[cfg.rootKey];
    const counts = data.counts || {};
    const countChips = Object.entries(counts).map(([k, v]) =>
      `<span class="np-badge np-badge--slate">${v} ${esc(k)}</span>`
    ).join(' ');
    const recentRows = cfg.hasAppointments ? (data.recentAppointments || []).map(a => `
      <tr>
        <td data-label="Date">${dmFmtDate(a.date)} ${esc(a.startTime || '')}</td>
        <td data-label="${type === 'DOCTOR' ? 'Patient' : 'Doctor'}">${esc(type === 'DOCTOR' ? (a.patient && a.patient.name) : (a.doctor && a.doctor.name))}</td>
        <td data-label="Status">${esc(a.status)}</td>
      </tr>`).join('') : '';
    host.innerHTML = `<div class="np-modal"><div class="np-modal__panel np-modal__panel--lg">
      <header class="np-modal__head"><div class="np-modal__title">${esc(rec.name)}</div><button class="np-modal__close" onclick="closeStaffModal()">×</button></header>
      <div class="np-modal__body">
        <div class="np-grid-2" style="margin-bottom:.75rem;">
          <div class="np-field"><label class="np-field__label">Phone</label><div>${esc(rec.phone || '—')}</div></div>
          <div class="np-field"><label class="np-field__label">Email</label><div>${esc(rec.email || '—')}</div></div>
          ${dmExtraFields(type, rec, counts)}
        </div>
        <div class="np-field__label" style="margin-bottom:.4rem;">Attached records</div>
        <div style="display:flex; gap:.4rem; flex-wrap:wrap; margin-bottom:1rem;">${countChips || '<span class="np-mut">None</span>'}</div>
        ${cfg.hasAppointments ? `
        <div class="np-field__label" style="margin-bottom:.4rem;">Recent appointments</div>
        ${recentRows
          ? `<div class="np-table-wrap"><table class="np-table np-table--cards"><thead><tr><th>Date</th><th>${type === 'DOCTOR' ? 'Patient' : 'Doctor'}</th><th>Status</th></tr></thead><tbody>${recentRows}</tbody></table></div>`
          : '<div class="np-empty"><div class="np-empty__sub">No appointments on record.</div></div>'}
        ` : ''}
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
  const cfg = TYPE_CONFIG[type];
  if (!cfg || __dmPurgeInFlight.has(id)) return;
  __dmPurgeInFlight.add(id);
  try {
    const warning = (PURGE_WARNING[type] || 'This permanently deletes {name}.').replace('{name}', name);
    const typed = await NPModal.prompt({
      title: `Permanently delete this ${cfg.label}?`,
      message: `${warning} This cannot be undone.\n\nType the name exactly to confirm: ${name}`,
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
      const res = await api('/admin/data-management/' + cfg.path + '/' + id, { method: 'DELETE', body: JSON.stringify({ confirmPassword: password }) });
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
