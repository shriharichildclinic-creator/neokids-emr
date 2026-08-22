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

async function dmSearch(){
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
          <td data-label="Action" style="text-align:right">
            <button class="np-btn np-btn--danger np-btn--sm" onclick="dmPurge('${type}','${esc(r.id)}','${esc(r.name).replace(/'/g, "\\'")}')">Delete permanently</button>
          </td>
        </tr>`).join('') + '</tbody></table></div>';
  } catch (e) {
    host.innerHTML = `<div class="np-error">${esc(e.message)}</div>`;
  }
}

async function dmPurge(type, id, name){
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
