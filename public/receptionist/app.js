const API = '/api';
let TOKEN = localStorage.getItem('np_reception_token');
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
let __me = null, __doctors = [], __assignments = [], __appts = [], __bills = [], __inv = [];

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(TOKEN && { Authorization: 'Bearer ' + TOKEN }), ...(opts.headers || {}) };
  const r = await fetch(API + path, { ...opts, headers });
  let data = null; try { data = await r.json(); } catch(_) {}
  if (r.status === 401 && TOKEN) { localStorage.removeItem('np_reception_token'); TOKEN = null; showLogin(); throw new Error('Session expired'); }
  if (!r.ok) throw new Error((data && (data.error || data.message)) || ('HTTP ' + r.status));
  return data;
}
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function toast(m, kind){ if (window.NPToast && NPToast[kind||'success']) NPToast[kind||'success'](m); else alert(m); }
function fmtDate(d){ if(!d) return ''; return new Date(d).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}); }
function fmtTime(t){ if(!t) return ''; const m=String(t).match(/^(\d{1,2}):(\d{2})/); if(!m) return t; let h=parseInt(m[1],10); const s=h>=12?'PM':'AM'; h=h%12||12; return h+':'+m[2]+' '+s; }
function inr(n){ return '₹' + Number(n||0).toLocaleString('en-IN',{minimumFractionDigits:2}); }
function todayIso(){ return new Date().toISOString().slice(0,10); }
function statusBadge(s){ const m={CONFIRMED:'np-badge--green',PENDING:'np-badge--amber',COMPLETED:'np-badge--blue',CANCELLED:'np-badge--red'}; return `<span class="np-badge ${m[s]||'np-badge--slate'}"><span class="np-badge__dot"></span>${esc(s||'—')}</span>`; }
function sourceBadge(s){
  if (s==='CLINIC_RECEPTION') return `<span class="np-badge np-badge--violet"><span class="np-badge__dot"></span>Reception</span>`;
  if (s==='WALK_IN') return `<span class="np-badge np-badge--amber"><span class="np-badge__dot"></span>Walk-in</span>`;
  if (s==='PHONE') return `<span class="np-badge np-badge--blue"><span class="np-badge__dot"></span>Phone</span>`;
  if (s==='OTHER') return `<span class="np-badge np-badge--slate"><span class="np-badge__dot"></span>Other</span>`;
  if (s==='NEOKIDSPRO') return `<span class="np-badge np-badge--mint"><span class="np-badge__dot"></span>Online</span>`;
  if (s==='MANUAL') return `<span class="np-badge np-badge--slate"><span class="np-badge__dot"></span>Manual</span>`;
  return '';
}
function payBadge(p){ const m={PAID:['np-badge--green','Paid'],CASH_COLLECTED:['np-badge--green','Cash collected'],CASH_PENDING:['np-badge--amber','Cash pending'],UNPAID:['np-badge--amber','Unpaid']}; const x=m[p]; return x?`<span class="np-badge ${x[0]}"><span class="np-badge__dot"></span>${x[1]}</span>`:`<span class="np-badge np-badge--slate">${esc(p||'—')}</span>`; }

// Single source of truth for which appointment actions are visible.
// Used by both the dashboard "today" list and the full appointments table
// so buttons never appear/disappear inconsistently between the two views.
function apptActionsHtml(a){
  const open = a.status!=='CANCELLED' && a.status!=='COMPLETED';
  const btns=[];
  if(!a.arrivedAt && open) btns.push(`<button class="np-btn np-btn--sm np-btn--primary" onclick="markArrived('${a.id}')">Mark arrived</button>`);
  if(open){
    btns.push(`<button class="np-btn np-btn--sm" onclick="resched('${a.id}')">Reschedule</button>`);
    btns.push(`<button class="np-btn np-btn--sm np-btn--ghost" onclick="cancelAppt('${a.id}')">Cancel</button>`);
  }
  if(!a.consultationInvoice && a.status!=='CANCELLED'){
    btns.push(`<button class="np-btn np-btn--sm" onclick="genInvoice('${a.id}')">Invoice</button>`);
  } else if(a.consultationInvoice){
    btns.push(`<button class="np-btn np-btn--sm np-btn--ghost" onclick="openInvoiceActions('${a.consultationInvoice.id}','${esc(a.consultationInvoice.pdfUrl||'')}','${a.patient.phone||''}','${esc(a.patient.email||'')}')">Invoice</button>`);
  }
  if(__me.canIssueCertificates && a.status!=='CANCELLED'){
    btns.push(`<button class="np-btn np-btn--sm np-btn--ghost" onclick="openCertModal('${a.id}')">Certificate</button>`);
  }
  return btns.join(' ');
}

// Single "Actions" entry point for an invoice row — replaces the old
// PDF/Print/Send buttons crammed side by side, which especially broke down
// on the mobile stacked-card layout. Send re-uses openInvoiceSendModal.
function openInvoiceActions(invoiceId, pdfUrl, phone, email){
  const hasPdf = !!pdfUrl;
  $('#modalHost').innerHTML=`<div class="np-modal"><div class="np-modal__panel"><header class="np-modal__head"><div class="np-modal__title">Invoice actions</div><button class="np-modal__close" onclick="closeModal()">×</button></header><div class="np-modal__body">
    <div class="np-action-list">
      <button type="button" class="np-btn np-btn--block" ${hasPdf?'':'disabled'} onclick="window.open('${esc(pdfUrl)}','_blank')">View</button>
      <a class="np-btn np-btn--block ${hasPdf?'':'np-btn--disabled'}" ${hasPdf?`href="${esc(pdfUrl)}" download`:'aria-disabled="true"'}>Download</a>
      <button type="button" class="np-btn np-btn--block" ${hasPdf?'':'disabled'} onclick="printPdf('${esc(pdfUrl)}')">Print</button>
      <button type="button" class="np-btn np-btn--block np-btn--primary" onclick="closeModal();openInvoiceSendModal('${invoiceId}','${esc(phone)}','${esc(email)}')">Send</button>
    </div>
    ${hasPdf?'':'<p style="margin:.75rem 0 0;font-size:.8rem;color:var(--np-muted)">PDF isn\'t ready yet — View, Download and Print will be available once it\'s generated.</p>'}
  </div></div></div>`;
}

// Real modal (no browser confirm() popups) for choosing delivery channels.
// Only shows a channel if the patient actually has that contact detail on file,
// and never sends anything until the user explicitly clicks Send.
function openInvoiceSendModal(invoiceId, phone, email){
  const hasPhone = !!phone; const hasEmail = !!email;
  if(!hasPhone && !hasEmail){ toast('Patient has no phone or email on file — cannot send','error'); return; }
  $('#modalHost').innerHTML=`<div class="np-modal"><div class="np-modal__panel"><header class="np-modal__head"><div class="np-modal__title">Send invoice</div><button class="np-modal__close" onclick="closeModal()">×</button></header><div class="np-modal__body">
    <div class="np-row" style="flex-direction:column;align-items:flex-start;gap:.5rem">
      ${hasPhone?`<label class="np-row" style="gap:.5rem"><input type="checkbox" id="sendChWa" checked/> Send via WhatsApp</label>`:''}
      ${hasEmail?`<label class="np-row" style="gap:.5rem"><input type="checkbox" id="sendChEm" ${hasPhone?'':'checked'}/> Send via Email</label>`:''}
    </div>
    <div class="np-row" style="justify-content:flex-end;gap:.5rem;margin-top:1rem"><button type="button" class="np-btn" onclick="closeModal()">Cancel</button><button type="button" class="np-btn np-btn--primary" id="sendInvoiceConfirm">Send</button></div>
  </div></div></div>`;
  $('#sendInvoiceConfirm').addEventListener('click', async ()=>{
    const channels=[];
    if(hasPhone && $('#sendChWa').checked) channels.push('whatsapp');
    if(hasEmail && $('#sendChEm') && $('#sendChEm').checked) channels.push('email');
    if(!channels.length){ toast('Choose at least one channel','error'); return; }
    closeModal();
    try{
      const r=await api('/receptionist/invoices/'+invoiceId+'/send',{method:'POST',body:JSON.stringify({channels})});
      toast('Invoice sent — WhatsApp '+r.delivery.whatsapp+', Email '+r.delivery.email);
      loadAppointments(); loadInvoices();
    }catch(e){ toast(e.message,'error'); }
  });
}

const VIEWS = { dashView:['Dashboard','Today at your clinic'], apptsView:['Appointments','Bookings for your doctors'], patientsView:['Patients','Search & register'], invoicesView:['Consultation Invoices','Reception billing'], billingView:['Billing','Consultation · medicines · services · other'], certsView:['Certificates','Issued in the doctor name'], rxView:['Prescriptions','Offline prescriptions'], pharmBillsView:['Pharmacy Bills','Medicine sales'], settingsView:['Settings','Account'] };
function setView(v){ $$('.tab-pane').forEach(x=>x.classList.add('hidden')); const el=document.getElementById(v); if(el)el.classList.remove('hidden'); $$('.np-nav-item').forEach(n=>n.classList.toggle('active', n.dataset.view===v)); const m=VIEWS[v]; if(m){$('#pageTitle').textContent=m[0];$('#pageSubtitle').textContent=m[1];}
  if(v==='dashView')loadDashboard(); if(v==='apptsView')loadAppointments(); if(v==='patientsView')loadPatients(); if(v==='invoicesView')loadInvoices(); if(v==='billingView')loadBilling(); if(v==='certsView')loadCerts(); if(v==='rxView')loadRx(); if(v==='pharmBillsView')loadPharmBills(); }
$$('.np-nav-item').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));

function setupSidebar(){
  const sidebar=$('#sidebar'), backdrop=$('#sidebarBackdrop'), toggle=$('#sidebarToggle');
  if(!sidebar||!toggle||!backdrop) return;
  if(toggle.__bound) return; toggle.__bound=true;
  function open(){ sidebar.classList.add('is-open'); backdrop.classList.add('is-open'); document.body.classList.add('np-drawer-open'); }
  function close(){ sidebar.classList.remove('is-open'); backdrop.classList.remove('is-open'); document.body.classList.remove('np-drawer-open'); }
  toggle.addEventListener('click',()=>sidebar.classList.contains('is-open')?close():open());
  backdrop.addEventListener('click',close);
  window.addEventListener('resize',()=>{ if(window.innerWidth>1023) close(); });
  $$('.np-nav-item').forEach(b=>b.addEventListener('click',()=>{ if(window.matchMedia('(max-width:1023px)').matches) close(); }));
}

// Header profile menu (avatar/name button -> Settings + Sign out dropdown).
// Mirrors the admin/doctor portal pattern so every panel behaves the same way.
function setupProfileMenu(){
  const trigger = $('#profileTrigger'); const menu = $('#profileDropdown');
  if (!trigger || !menu) return;
  if (trigger.__bound) return; trigger.__bound = true;
  trigger.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('is-open'); trigger.setAttribute('aria-expanded', menu.classList.contains('is-open')); });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target) && !trigger.contains(e.target)) menu.classList.remove('is-open'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') menu.classList.remove('is-open'); });
}

$('#loginForm').addEventListener('submit', async e=>{ e.preventDefault(); try{ const r=await fetch(API+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:$('#email').value,password:$('#password').value})}); const d=await r.json().catch(()=>({})); if(!r.ok)throw new Error(d.error||'Login failed'); if(d.role!=='RECEPTIONIST')throw new Error('Not a receptionist account'); TOKEN=d.token; localStorage.setItem('np_reception_token',TOKEN); showDashboard(); }catch(err){ $('#loginError').textContent=err.message; $('#loginError').classList.remove('hidden'); }});
function logout(){ localStorage.removeItem('np_reception_token'); TOKEN=null; showLogin(); }
function showLogin(){ $('#dashboard').classList.add('hidden'); $('#loginScreen').classList.remove('hidden'); }

async function showDashboard(){
  $('#loginScreen').classList.add('hidden'); $('#dashboard').classList.remove('hidden');
  setupSidebar();
  setupProfileMenu();
  try{
    const meRes = await api('/auth/me'); __me = meRes.user || meRes;
    const __initials = __me.name.split(/\s+/).map(s=>s[0]).slice(0,2).join('').toUpperCase();
    $('#userName').textContent = __me.name; $('#userInitials').textContent = __initials;
    // Same identity, mirrored into the dropdown's "logged in as" block --
    // stays visible on mobile even once the header hides .np-profile__meta.
    if($('#userIdName')) $('#userIdName').textContent = __me.name;
    if($('#userIdInitials')) $('#userIdInitials').textContent = __initials;
    if($('#userIdEmail')) $('#userIdEmail').textContent = __me.email || '';
    if(!__me.canManageConsultations){ ['apptsView','patientsView','invoicesView'].forEach(v=>{const b=document.querySelector(`[data-view="${v}"]`); if(b)b.style.display='none';}); }
    if(!__me.canIssueCertificates){ const b=document.querySelector('[data-view="certsView"]'); if(b)b.style.display='none'; }
    if(__me.canManagePharmacy){ $('#pharmSection').style.display=''; $('#navRx').style.display=''; $('#navPharmBills').style.display=''; }
    const asn = await api('/receptionist/assignments'); __assignments = asn; __doctors = asn.map(a=>a.doctor);
    const sel=$('#fDoctor'); if(sel) sel.innerHTML='<option value="">All doctors</option>'+__doctors.map(d=>`<option value="${d.id}">Dr. ${esc(d.name)}</option>`).join('');
  }catch(e){ if(e.message!=='Session expired') toast(e.message,'error'); }
  setView('dashView');
}

async function loadDashboard(){
  try{
    const s = await api('/receptionist/stats');
    $('#kpiGrid').innerHTML = [
      {k:'blue', l:"Today's appointments", v:s.todayAppointments},
      {k:'green', l:'Arrived', v:s.arrivedToday},
      {k:'amber', l:'Awaiting arrival', v:s.pendingToday},
      {k:'mint', l:'Invoices today', v:s.invoicesToday},
      {k:'violet', l:'Clinic patients', v:s.patientsTotal}
    ].map(c=>`<div class="np-kpi np-kpi--${c.k}"><div class="np-kpi__label">${c.l}</div><div class="np-kpi__value">${c.v}</div></div>`).join('');
    const rows = await api('/receptionist/appointments?date='+todayIso());
    __appts = rows;
    $('#todayList').innerHTML = rows.length ? rows.map(a=>`
      <div class="np-appt-row"><div class="np-appt-row__time"><div class="np-appt-row__time-h">${esc(fmtTime(a.startTime))}</div><div class="np-appt-row__time-d">${esc(fmtDate(a.date))}</div></div>
      <div class="np-appt-row__body"><div class="np-appt-row__name">${esc(a.patient.name)} ${a.arrivedAt?'<span class="np-badge np-badge--green"><span class="np-badge__dot"></span>Arrived</span>':''}</div><div class="np-appt-row__assign">Dr. ${esc(a.doctor.name)}</div><div class="np-appt-row__meta">${esc(a.primaryProblem||'')}</div></div>
      <div class="np-appt-row__right">${statusBadge(a.status)} ${sourceBadge(a.source)}
        ${apptActionsHtml(a)}
      </div></div>`).join('') : '<div class="np-empty"><div class="np-empty__title">No appointments today</div></div>';
  }catch(e){ $('#kpiGrid').innerHTML=`<div class="np-error">${esc(e.message)}</div>`; }
}

async function loadAppointments(){
  const tb=$('#apptsTbody'); tb.innerHTML='<tr><td colspan="7" style="text-align:center;padding:1.4rem" class="np-mut">Loading…</td></tr>';
  const qs=new URLSearchParams(); if($('#fDate').value)qs.set('date',$('#fDate').value); if($('#fDoctor').value)qs.set('doctorId',$('#fDoctor').value); if($('#fStatus').value)qs.set('status',$('#fStatus').value); if($('#fQ').value.trim().length>=2)qs.set('q',$('#fQ').value.trim());
  try{ const rows=await api('/receptionist/appointments?'+(qs.toString()||'')); __appts=rows;
    tb.innerHTML = rows.length ? rows.map(a=>`<tr><td data-label="Date/Time"><b>${esc(fmtDate(a.date))}</b><div class="np-mut" style="font-size:.78rem">${esc(fmtTime(a.startTime))}</div></td>
      <td data-label="Patient"><b>${esc(a.patient.name)}</b><div class="np-mut" style="font-size:.78rem">+91 ${esc(a.patient.phone||'')}</div></td>
      <td data-label="Doctor">Dr. ${esc(a.doctor.name)}</td><td data-label="Source">${sourceBadge(a.source)}</td><td data-label="Status">${statusBadge(a.status)}</td><td data-label="Payment">${payBadge(a.paymentStatus)}</td>
      <td data-label="Actions" style="text-align:right;white-space:nowrap">
        ${apptActionsHtml(a)}
      </td></tr>`).join('') : '<tr><td colspan="7"><div class="np-empty"><div class="np-empty__title">No appointments match</div></div></td></tr>';
  }catch(e){ tb.innerHTML=`<tr><td colspan="7"><div class="np-error">${esc(e.message)}</div></td></tr>`; }
}
$('#apptFilters').addEventListener('submit',e=>{e.preventDefault();loadAppointments();});

async function markArrived(id){ try{ await api('/receptionist/appointments/'+id+'/arrive',{method:'POST',body:'{}'}); toast('Patient marked arrived'); loadDashboard(); }catch(e){toast(e.message,'error');} }
function resched(id){
  const appt=__appts.find(a=>a.id===id);
  const docId=appt&&appt.doctor?appt.doctor.id:'';
  const curDate=appt?String(appt.date).slice(0,10):todayIso();
  $('#modalHost').innerHTML=`<div class="np-modal"><div class="np-modal__panel"><header class="np-modal__head"><div class="np-modal__title">Reschedule appointment</div><button class="np-modal__close" onclick="closeModal()">×</button></header><div class="np-modal__body"><form id="reschedForm">
  <div class="np-field"><label class="np-field__label">New date *</label><input name="date" type="date" required class="np-input" value="${curDate}"/></div>
  <div class="np-field"><label class="np-field__label">Available slot *</label><select name="startTime" required class="np-select" id="reschedSlotSel"><option value="">Loading…</option></select></div>
  <div class="np-field"><label class="np-field__label">Reason *</label><textarea name="reason" required minlength="3" class="np-textarea" placeholder="Min 3 characters"></textarea></div>
  <div class="np-row" style="justify-content:flex-end;gap:.5rem"><button type="button" class="np-btn" onclick="closeModal()">Cancel</button><button class="np-btn np-btn--primary" type="submit">Reschedule</button></div></form></div></div></div>`;
  const f=$('#reschedForm');
  async function refreshReschedSlots(){ const date=f.date.value; if(!date||!docId){ $('#reschedSlotSel').innerHTML='<option value="">No slots</option>'; return; } try{ const r=await api(`/receptionist/slots?doctorId=${docId}&date=${date}&type=OFFLINE`); $('#reschedSlotSel').innerHTML=(r.slots||[]).filter(s=>s.available).map(s=>`<option value="${s.startTime}">${fmtTime(s.startTime)}</option>`).join('')||'<option value="">No slots available</option>'; }catch(e){ $('#reschedSlotSel').innerHTML='<option value="">No slots</option>'; } }
  f.date.addEventListener('change',refreshReschedSlots); refreshReschedSlots();
  f.addEventListener('submit',async e=>{e.preventDefault(); const raw=Object.fromEntries(new FormData(f).entries()); if(!raw.reason||raw.reason.trim().length<3){toast('Reason required (min 3 chars)','error');return;} try{ await api('/receptionist/appointments/'+id+'/reschedule',{method:'POST',body:JSON.stringify({date:raw.date,startTime:raw.startTime,reason:raw.reason})}); toast('Rescheduled'); closeModal(); loadAppointments(); loadDashboard(); }catch(err){toast(err.message,'error');} });
}
function cancelAppt(id){
  $('#modalHost').innerHTML=`<div class="np-modal"><div class="np-modal__panel"><header class="np-modal__head"><div class="np-modal__title">Cancel appointment</div><button class="np-modal__close" onclick="closeModal()">×</button></header><div class="np-modal__body"><form id="cancelForm">
  <div class="np-field"><label class="np-field__label">Cancellation reason *</label><textarea name="reason" required minlength="3" class="np-textarea" placeholder="Min 3 characters"></textarea></div>
  <div class="np-row" style="justify-content:flex-end;gap:.5rem"><button type="button" class="np-btn" onclick="closeModal()">Back</button><button class="np-btn np-btn--primary" type="submit">Confirm cancellation</button></div></form></div></div></div>`;
  $('#cancelForm').addEventListener('submit',async e=>{e.preventDefault(); const raw=Object.fromEntries(new FormData(e.target).entries()); if(!raw.reason||raw.reason.trim().length<3){toast('Reason required (min 3 chars)','error');return;} try{ await api('/receptionist/appointments/'+id+'/cancel',{method:'POST',body:JSON.stringify({reason:raw.reason})}); toast('Cancelled'); closeModal(); loadAppointments(); loadDashboard(); }catch(err){toast(err.message,'error');} });
}
async function genInvoice(id){ try{ const r=await api('/receptionist/appointments/'+id+'/invoice',{method:'POST',body:JSON.stringify({})}); toast(r.existing?'Invoice already exists':'Invoice generated'); loadAppointments(); loadDashboard(); }catch(e){toast(e.message,'error');} }

// Patients
async function loadPatients(q){ const list=$('#patientsList'); try{ const rows=await api('/receptionist/patients'+(q?('?q='+encodeURIComponent(q)):'')); list.innerHTML=rows.length?rows.map(p=>`<div class="np-appt-row"><div class="np-appt-row__body"><div class="np-appt-row__name">${esc(p.name)}</div><div class="np-appt-row__meta">+91 ${esc(p.phone||'')}${p.parentName?' · Guardian: '+esc(p.parentName):''}</div></div><div class="np-appt-row__right"><button class="np-btn np-btn--sm" onclick="openBookModal(null,'${p.id}')">Book</button></div></div>`).join(''):'<div class="np-empty"><div class="np-empty__sub">Type a name or phone to search, or register a new patient.</div></div>'; }catch(e){ list.innerHTML=`<div class="np-error">${esc(e.message)}</div>`; } }
$('#patientSearch').addEventListener('input',e=>{clearTimeout(window.__ps); window.__ps=setTimeout(()=>loadPatients(e.target.value.trim()),300);});

function openPatientModal(){
  $('#modalHost').innerHTML=`<div class="np-modal"><div class="np-modal__panel"><header class="np-modal__head"><div class="np-modal__title">Register patient</div><button class="np-modal__close" onclick="closeModal()">×</button></header><div class="np-modal__body"><form id="pForm"><div class="np-grid-2">
  <div class="np-field"><label class="np-field__label">Full name *</label><input name="name" required class="np-input"/></div>
  <div class="np-field"><label class="np-field__label">Phone (10 digits) *</label><input name="phone" required maxlength="10" class="np-input"/></div>
  <div class="np-field"><label class="np-field__label">Email</label><input name="email" type="email" class="np-input"/></div>
  <div class="np-field"><label class="np-field__label">Parent / guardian</label><input name="parentName" class="np-input"/></div>
  <div class="np-field"><label class="np-field__label">Date of birth</label><input name="dateOfBirth" type="date" class="np-input"/></div>
  <div class="np-field"><label class="np-field__label">Gender</label><select name="gender" class="np-select"><option value="">—</option><option value="MALE">Male</option><option value="FEMALE">Female</option><option value="OTHER">Other</option></select></div></div>
  <div class="np-field"><label class="np-field__label">Address</label><textarea name="address" class="np-textarea"></textarea></div>
  <div class="np-row" style="justify-content:flex-end;gap:.5rem"><button type="button" class="np-btn" onclick="closeModal()">Cancel</button><button class="np-btn np-btn--primary" type="submit">Register</button></div></form></div></div></div>`;
  $('#pForm').addEventListener('submit',async e=>{e.preventDefault(); const f=e.target; const raw=Object.fromEntries(new FormData(f).entries()); try{ const p=await api('/receptionist/patients',{method:'POST',body:JSON.stringify(raw)}); toast('Patient registered'); closeModal(); loadPatients(); }catch(err){toast(err.message,'error');}});
}

function closeModal(){ $('#modalHost').innerHTML=''; }

// Booking
async function openBookModal(_, patientId){
  const docOpts=__assignments.map(a=>`<option value="${a.doctor.id}|${a.medicalCentre.id}">Dr. ${esc(a.doctor.name)} — ${esc(a.medicalCentre.name)}</option>`).join('');
  $('#modalHost').innerHTML=`<div class="np-modal"><div class="np-modal__panel"><header class="np-modal__head"><div class="np-modal__title">Book appointment / walk-in</div><button class="np-modal__close" onclick="closeModal()">×</button></header><div class="np-modal__body"><form id="bForm"><div class="np-grid-2">
  <div class="np-field" style="grid-column:span 2"><label class="np-field__label">Doctor & clinic *</label><select name="docCentre" required class="np-select">${docOpts}</select></div>
  <div class="np-field"><label class="np-field__label">Date *</label><input name="date" type="date" required class="np-input" value="${todayIso()}"/></div>
  <div class="np-field"><label class="np-field__label">Type</label><select name="consultationType" class="np-select"><option value="OFFLINE">In-person</option></select></div>
  <div class="np-field" style="grid-column:span 2"><label class="np-field__label">Available slot *</label><select name="startTime" required class="np-select" id="slotSel"><option value="">Pick doctor+date first</option></select></div>
  <div class="np-field" style="grid-column:span 2"><label class="np-field__label">Patient *</label><input id="bPatient" class="np-input" placeholder="Search existing or type new name" list="bPatients"/><datalist id="bPatients"></datalist><input type="hidden" id="bPatientId"/></div>
  <div class="np-field"><label class="np-field__label">Phone *</label><input name="phone" maxlength="10" class="np-input"/></div>
  <div class="np-field"><label class="np-field__label">Email</label><input name="email" type="email" class="np-input"/></div>
  <div class="np-field"><label class="np-field__label">Parent / guardian</label><input name="parentName" class="np-input"/></div>
  <div class="np-field"><label class="np-field__label">DOB</label><input name="dateOfBirth" type="date" class="np-input"/></div>
  <div class="np-field"><label class="np-field__label">Gender</label><select name="gender" class="np-select"><option value="">—</option><option value="MALE">Male</option><option value="FEMALE">Female</option><option value="OTHER">Other</option></select></div>
  <div class="np-field" style="grid-column:span 2"><label class="np-field__label">Reason / problem *</label><input name="primaryProblem" required class="np-input"/></div>
  <div class="np-field"><label class="np-field__label">Source</label><select name="source" class="np-select"><option value="CLINIC_RECEPTION">Clinic reception</option><option value="WALK_IN">Walk-in</option><option value="PHONE">Phone</option><option value="OTHER">Other</option></select></div></div></div>
  <div class="np-row" style="justify-content:flex-end;gap:.5rem"><button type="button" class="np-btn" onclick="closeModal()">Cancel</button><button class="np-btn np-btn--primary" type="submit">Book</button></div></form></div></div></div>`;
  const f=$('#bForm');
  async function bPrefillPatient(pid){ try{ const data=await api('/receptionist/patients/'+pid+'/history'); const p=data&&data.patient; if(!p)return; $('#bPatientId').value=p.id; $('#bPatient').value=`${p.name} — ${p.phone||''}`; if(f.phone) f.phone.value=p.phone||''; if(f.email) f.email.value=p.email||''; if(f.parentName) f.parentName.value=p.parentName||''; if(f.dateOfBirth) f.dateOfBirth.value=p.dateOfBirth?String(p.dateOfBirth).slice(0,10):''; if(f.gender) f.gender.value=p.gender||''; }catch(_){} }
  if (patientId) bPrefillPatient(patientId);
  async function refreshSlots(){ const v=f.docCentre.value; if(!v)return; const [docId]=v.split('|'); const date=f.date.value; if(!date)return; try{ const r=await api(`/receptionist/slots?doctorId=${docId}&date=${date}&type=OFFLINE`); $('#slotSel').innerHTML=(r.slots||[]).filter(s=>s.available).map(s=>`<option value="${s.startTime}">${fmtTime(s.startTime)}</option>`).join('')||'<option value="">No slots available</option>'; }catch(e){ $('#slotSel').innerHTML='<option value="">No slots</option>'; } }
  f.docCentre.addEventListener('change',refreshSlots); f.date.addEventListener('change',refreshSlots); refreshSlots();
  const bP=$('#bPatient'); bP.addEventListener('input',async e=>{ $('#bPatientId').value=''; clearTimeout(window.__bp); const q=e.target.value.trim(); if(q.length<2)return; window.__bp=setTimeout(async()=>{ try{ const rows=await api('/receptionist/patients?q='+encodeURIComponent(q)); $('#bPatients').innerHTML=rows.map(p=>`<option value="${esc(p.name)} — ${esc(p.phone)}" data-id="${p.id}"></option>`).join(''); window.__bplist=rows; }catch(_){}} ,250); });
  f.addEventListener('submit',async e=>{e.preventDefault(); const raw=Object.fromEntries(new FormData(f).entries()); const [docId,centreId]=raw.docCentre.split('|');
    let pid=$('#bPatientId').value||null; const typed=bP.value.trim();
    if(!pid && window.__bplist){ const match=window.__bplist.find(p=>`${p.name} — ${p.phone}`===typed); if(match) pid=match.id; }
    const payload={ doctorId:docId, medicalCentreId:centreId, date:raw.date, startTime:raw.startTime, consultationType:'OFFLINE', primaryProblem:raw.primaryProblem, source:raw.source||'CLINIC_RECEPTION' };
    if(pid){ payload.patientId=pid; } else {
      const namePart=typed.split(' — ')[0]; payload.patientName=namePart; payload.phone=raw.phone; payload.email=raw.email||''; payload.parentName=raw.parentName||''; payload.dateOfBirth=raw.dateOfBirth||''; payload.gender=raw.gender||undefined;
      if(!raw.phone){ toast('Phone is required for a new patient','error'); return; }
    }
    try{ const r=await api('/receptionist/appointments',{method:'POST',body:JSON.stringify(payload)}); toast('Appointment booked'); closeModal(); loadDashboard(); }catch(err){ toast(err.message,'error'); }
  });
}

// Invoices
async function loadInvoices(){ const tb=$('#invTbody'); try{ const rows=await api('/receptionist/invoices'); tb.innerHTML=rows.length?rows.map(i=>`<tr><td data-label="Invoice #"><b>${esc(i.invoiceNumber)}</b></td><td data-label="Patient">${esc(i.appointment.patient.name)}</td><td data-label="Doctor">Dr. ${esc(i.appointment.doctor.name)}</td><td data-label="Clinic">${esc(i.medicalCentre?i.medicalCentre.name:'—')}</td><td data-label="Amount" style="text-align:right"><b>${inr(i.amount)}</b></td><td data-label="Date">${esc(fmtDate(i.createdAt))}</td><td data-label="Actions" style="text-align:right;white-space:nowrap"><button class="np-btn np-btn--sm" onclick="openInvoiceActions('${i.id}','${esc(i.pdfUrl||'')}','${i.appointment.patient.phone||''}','${esc(i.appointment.patient.email||'')}')">Actions</button></td></tr>`).join(''):'<tr><td colspan="7"><div class="np-empty"><div class="np-empty__title">No invoices yet</div></div></td></tr>'; }catch(e){ tb.innerHTML=`<tr><td colspan="7"><div class="np-error">${esc(e.message)}</div></td></tr>`; } }
function printPdf(url){ if(!url){toast('Generate the invoice first','warn');return;} const w=window.open(url,'_blank'); if(w){w.addEventListener('load',()=>{try{w.print();}catch(_){}});} }

// Certificates
async function loadCerts(){ const list=$('#certsList'); try{ const rows=await api('/receptionist/certificates'); list.innerHTML=rows.length?'<div class="np-table-wrap"><table class="np-table"><thead><tr><th>Cert ID</th><th>Patient</th><th>Doctor</th><th>Template</th><th>Issued</th><th>Actions</th></tr></thead><tbody>'+rows.map(c=>`<tr><td data-label="Cert ID">${esc(c.certificateNumber)}</td><td data-label="Patient">${esc(c.patientNameSnapshot||(c.patient&&c.patient.name)||'')}</td><td data-label="Doctor">Dr. ${esc((c.doctor&&c.doctor.name)||'')}</td><td data-label="Template">${esc((c.templateKey||'').replace(/_/g,' '))}</td><td data-label="Issued">${esc(fmtDate(c.issuedAt))}</td><td data-label="Actions">${c.pdfUrl?`<a class="np-btn np-btn--sm" href="${c.pdfUrl}" target="_blank">PDF</a>`:''} <button class="np-btn np-btn--sm np-btn--ghost" onclick="openCertSendModal('${c.id}','${esc((c.patient&&c.patient.phone)||'')}','${esc((c.patient&&c.patient.email)||'')}')">Send</button></td></tr>`).join('')+'</tbody></table></div>':'<div class="np-empty"><div class="np-empty__title">No certificates yet</div></div>'; }catch(e){ list.innerHTML=`<div class="np-error">${esc(e.message)}</div>`; } }
function openCertSendModal(certId, phone, email){
  const hasPhone=!!phone; const hasEmail=!!email;
  if(!hasPhone && !hasEmail){ toast('Patient has no phone or email on file — cannot send','error'); return; }
  $('#modalHost').innerHTML=`<div class="np-modal"><div class="np-modal__panel"><header class="np-modal__head"><div class="np-modal__title">Send certificate</div><button class="np-modal__close" onclick="closeModal()">×</button></header><div class="np-modal__body">
    <div class="np-row" style="flex-direction:column;align-items:flex-start;gap:.5rem">
      ${hasPhone?`<label class="np-row" style="gap:.5rem"><input type="checkbox" id="sendCertWa" checked/> Send via WhatsApp</label>`:''}
      ${hasEmail?`<label class="np-row" style="gap:.5rem"><input type="checkbox" id="sendCertEm" ${hasPhone?'':'checked'}/> Send via Email</label>`:''}
    </div>
    <div class="np-row" style="justify-content:flex-end;gap:.5rem;margin-top:1rem"><button type="button" class="np-btn" onclick="closeModal()">Cancel</button><button type="button" class="np-btn np-btn--primary" id="sendCertConfirm">Send</button></div>
  </div></div></div>`;
  $('#sendCertConfirm').addEventListener('click', async ()=>{
    const channels=[];
    if(hasPhone && $('#sendCertWa').checked) channels.push('whatsapp');
    if(hasEmail && $('#sendCertEm') && $('#sendCertEm').checked) channels.push('email');
    if(!channels.length){ toast('Choose at least one channel','error'); return; }
    closeModal();
    try{ const r=await api('/receptionist/certificates/'+certId+'/send',{method:'POST',body:JSON.stringify({channels})}); toast('Delivery: WhatsApp '+r.delivery.whatsapp+', Email '+r.delivery.email); }catch(e){ toast(e.message,'error'); }
  });
}
async function openCertModal(appointmentId){
  let tpls=[]; try{ tpls=await api('/receptionist/certificates/templates'); }catch(_){}
  const docOpts=__doctors.map(d=>`<option value="${d.id}">Dr. ${esc(d.name)}</option>`).join('');
  $('#modalHost').innerHTML=`<div class="np-modal"><div class="np-modal__panel"><header class="np-modal__head"><div class="np-modal__title">Issue medical certificate</div><button class="np-modal__close" onclick="closeModal()">×</button></header><div class="np-modal__body"><form id="cForm"><div class="np-grid-2">
  ${appointmentId?'':'<div class="np-field"><label class="np-field__label">Doctor *</label><select name="doctorId" class="np-select">'+docOpts+'</select></div><div class="np-field"><label class="np-field__label">Patient *</label><input id="certPatient" class="np-input" placeholder="Search by name or phone" list="certPatients" autocomplete="off"/><datalist id="certPatients"></datalist><input type="hidden" id="certPatientId"/></div>'}
  <div class="np-field" style="grid-column:span 2"><label class="np-field__label">Template</label><select name="templateKey" class="np-select">${tpls.map(t=>`<option value="${t.key}">${esc(t.label)}</option>`).join('')}</select></div>
  <div class="np-field" style="grid-column:span 2"><label class="np-field__label">Reason *</label><textarea name="reason" required class="np-textarea"></textarea></div>
  <div class="np-field"><label class="np-field__label">Diagnosis</label><input name="diagnosis" class="np-input"/></div>
  <div class="np-field"><label class="np-field__label">Rest days</label><input name="restDays" type="number" min="0" class="np-input"/></div>
  <div class="np-field"><label class="np-field__label">From date</label><input name="fromDate" type="date" class="np-input"/></div>
  <div class="np-field"><label class="np-field__label">To date</label><input name="toDate" type="date" class="np-input"/></div></div>
  <div class="np-row" style="justify-content:flex-end;gap:.5rem"><button type="button" class="np-btn" onclick="closeModal()">Cancel</button><button class="np-btn np-btn--primary" type="submit">Issue & generate PDF</button></div></form></div></div></div>`;
  if(!appointmentId){
    const cP=$('#certPatient');
    cP.addEventListener('input',e=>{ $('#certPatientId').value=''; clearTimeout(window.__cp); const q=e.target.value.trim(); if(q.length<2)return; window.__cp=setTimeout(async()=>{ try{ const rows=await api('/receptionist/patients?q='+encodeURIComponent(q)); $('#certPatients').innerHTML=rows.map(p=>`<option value="${esc(p.name)} — ${esc(p.phone)}" data-id="${p.id}"></option>`).join(''); window.__cplist=rows; }catch(_){}} ,250); });
  }
  $('#cForm').addEventListener('submit',async e=>{e.preventDefault(); const raw=Object.fromEntries(new FormData(e.target).entries()); const payload={ templateKey:raw.templateKey, reason:raw.reason, diagnosis:raw.diagnosis||'', restDays:raw.restDays===''?undefined:Number(raw.restDays), fromDate:raw.fromDate||'', toDate:raw.toDate||'' };
    const url = appointmentId? '/receptionist/appointments/'+appointmentId+'/certificate' : '/receptionist/certificates';
    if(!appointmentId){
      let pid=$('#certPatientId').value||null; const typed=$('#certPatient').value.trim();
      if(!pid && window.__cplist){ const match=window.__cplist.find(p=>`${p.name} — ${p.phone}`===typed); if(match) pid=match.id; }
      if(!pid){ toast('Select a patient from the search results','error'); return; }
      payload.doctorId=raw.doctorId; payload.patientId=pid;
    }
    try{ const r=await api(url,{method:'POST',body:JSON.stringify(payload)}); toast('Certificate issued'); if(r.pdfUrl)window.open(r.pdfUrl,'_blank'); closeModal(); loadCerts(); }catch(err){toast(err.message,'error');} });
}

// Pharmacy (receptionist with permission)
async function loadRx(){ const list=$('#rxList'); try{ const rows=await api('/receptionist/pharmacy/prescriptions'); list.innerHTML=rows.length?rows.map(rx=>`<div class="np-appt-row"><div class="np-appt-row__body"><div class="np-appt-row__name">${esc(rx.patient.name)} ${rx.dispensed?'<span class="np-badge np-badge--green"><span class="np-badge__dot"></span>Dispensed</span>':'<span class="np-badge np-badge--amber"><span class="np-badge__dot"></span>Pending</span>'}</div><div class="np-appt-row__assign">Dr. ${esc(rx.doctor.name)} · ${esc(fmtDate(rx.visitDate))}</div><div class="np-appt-row__meta">${(rx.medications||[]).map(m=>esc(m.name)+' '+esc(m.dose||'')).join(', ')}</div></div><div class="np-appt-row__right"><span class="np-badge np-badge--slate">${esc(rx.createdByRole==='RECEPTIONIST'?'by reception':'by doctor')}</span>${!rx.dispensed?` <button class="np-btn np-btn--sm np-btn--primary" onclick="openBillModal(null,'${rx.id}')">Dispense</button>`:''}</div></div>`).join(''):'<div class="np-empty"><div class="np-empty__title">No offline prescriptions</div></div>'; }catch(e){ list.innerHTML=`<div class="np-error">${esc(e.message)}</div>`; } }
function billTypeBadge(t){ const m={PHARMACY:['np-badge--mint','Pharmacy'],CONSULT:['np-badge--blue','Consult'],SERVICE:['np-badge--violet','Service']}; const x=m[t]||['np-badge--slate',t||'Pharmacy']; return `<span class="np-badge ${x[0]}"><span class="np-badge__dot"></span>${x[1]}</span>`; }
function billStatusBadge(s){ return s==='PAID'?'<span class="np-badge np-badge--green"><span class="np-badge__dot"></span>Paid</span>':'<span class="np-badge np-badge--amber"><span class="np-badge__dot"></span>Draft</span>'; }
async function loadPharmBills(){ const tb=$('#pharmBillsTbody'); if(!tb)return; try{ const rows=await api('/receptionist/pharmacy/bills?billType=PHARMACY'); __bills=rows; tb.innerHTML=rows.length?rows.map(b=>`<tr><td data-label=\"Bill #\"><b>${esc(b.billNumber)}</b></td><td data-label=\"Customer\">${esc(b.customerName||'')}</td><td data-label=\"Total\" style=\"text-align:right\"><b>${inr(b.total)}</b></td><td data-label=\"Status\">${billStatusBadge(b.status)}</td><td data-label=\"Date\">${esc(fmtDate(b.createdAt))}</td><td data-label=\"Actions\" style=\"text-align:right;white-space:nowrap\"><button class=\"np-btn np-btn--sm\" onclick=\"showRecBillActions('${b.id}')\">Actions</button></td></tr>`).join(''):'<tr><td colspan=\"6\"><div class=\"np-empty\"><div class=\"np-empty__title\">No pharmacy bills yet</div></div></td></tr>'; }catch(e){ tb.innerHTML=`<tr><td colspan=\"6\"><div class=\"np-error\">${esc(e.message)}</div></td></tr>`; } }
async function __ensureBillingCtx(){ if(!__doctors.length){ try{ const asn=await api('/receptionist/assignments'); __doctors=(asn||[]).map(a=>a.doctor); }catch(_){__doctors=__doctors||[];} } if(!__inv.length){ try{ __inv=await api('/receptionist/pharmacy/inventory'); }catch(_){__inv=__inv||[];} } }
async function loadBilling(){ const tb=$('#billingTbody'); if(!tb)return; try{ const qs=new URLSearchParams(); const t=$('#billTypeFilter').value, st=$('#billStatusFilter').value; if(t)qs.set('billType',t); if(st)qs.set('status',st); const rows=await api('/receptionist/pharmacy/bills?'+(qs.toString()||'')); __bills=rows; tb.innerHTML=rows.length?rows.map(b=>`<tr><td data-label="Bill #"><b>${esc(b.billNumber)}</b></td><td data-label="Type">${billTypeBadge(b.billType)}</td><td data-label="Customer">${esc(b.customerName||'')}${b.patient?`<div class="np-mut" style="font-size:.72rem">${esc(b.patient.name||'')}</div>`:''}</td><td data-label="Total" style="text-align:right"><b>${inr(b.total)}</b></td><td data-label="Status">${billStatusBadge(b.status)}</td><td data-label="Date">${esc(fmtDate(b.createdAt))}</td><td data-label="Actions" style="text-align:right;white-space:nowrap"><button class="np-btn np-btn--sm" onclick="showRecBillActions('${b.id}')">Actions</button></td></tr>`).join(''):'<tr><td colspan="7"><div class="np-empty"><div class="np-empty__title">No bills yet</div></div></td></tr>'; }catch(e){ tb.innerHTML=`<tr><td colspan="7"><div class="np-error">${esc(e.message)}</div></td></tr>`; } }
function showRecBillActions(id){ const b=__bills.find(x=>x.id===id); if(!b)return; const isPaid=b.status==='PAID'; let rows=''; if(isPaid){ rows+='<button type="button" class="np-btn np-btn--block" disabled>Paid — locked</button>'; } else { rows+='<button type="button" class="np-btn np-btn--block" onclick="closeModal();editRecBill(\''+id+'\')">Edit draft</button>'; rows+='<button type="button" class="np-btn np-btn--block np-btn--primary" onclick="closeModal();__markRecPaid(\''+id+'\')">Mark paid</button>'; } if(b.pdfUrl){ rows+='<button type="button" class="np-btn np-btn--block" onclick="window.open(\''+b.pdfUrl+'\',\'_blank\')">View PDF</button><button type="button" class="np-btn np-btn--block" onclick="printPdf(\''+b.pdfUrl+'\')">Print</button>'; } $('#modalHost').innerHTML='<div class="np-modal"><div class="np-modal__panel"><header class="np-modal__head"><div class="np-modal__title">Bill actions — '+esc(b.billNumber)+'</div><button class="np-modal__close" onclick="closeModal()">×</button></header><div class="np-modal__body"><div class="np-action-list">'+rows+'</div></div></div></div>'; }
function __markRecPaid(id){ NPBilling.markPaid({api:api,esc:esc,fmt:fmtDate,toast:toast,onSaved:loadBilling,billsBase:'/receptionist/pharmacy/bills'},id,loadBilling); }
async function editRecBill(id){ await __ensureBillingCtx(); try{ const b=await api('/receptionist/pharmacy/bills/'+id); if(b.status!=='DRAFT'){ toast('This bill is already paid and locked','warn'); return; } NPBilling.open({ api, esc, fmt:fmtDate, toast, onSaved:loadBilling, inventory:__inv, doctors:__doctors, billsBase:'/receptionist/pharmacy/bills', role:'RECEPTIONIST', host:'#modalHost', canSwitchType:true, patientSearch:q=>api('/receptionist/patients?q='+encodeURIComponent(q)) }, b); }catch(e){ toast(e.message,'error'); } }
async function openBillModal(_, rxId){
  await __ensureBillingCtx();
  NPBilling.open({
    api, esc, fmt: fmtDate, toast, onSaved: loadBilling,
    inventory: __inv, doctors: __doctors, billsBase: '/receptionist/pharmacy/bills',
    role: 'RECEPTIONIST', host: '#modalHost', canSwitchType: true, rxId: rxId,
    defaultBillType: 'SERVICE',
    patientSearch: q => api('/receptionist/patients?q='+encodeURIComponent(q))
  });
}

$('#passwordForm').addEventListener('submit',async e=>{e.preventDefault(); const d=Object.fromEntries(new FormData(e.target).entries()); if(d.newPassword!==d.confirmPassword){toast('Passwords do not match','error');return;} try{ await api('/auth/change-password',{method:'POST',body:JSON.stringify(d)}); toast('Password changed'); e.target.reset(); }catch(err){toast(err.message,'error');}});

function wireThemeSwitch(){
  const opts=$$('#setting-appearance [data-theme-choice]');
  if(!opts.length || !window.NPTheme) return;
  function paint(){ const mode=window.NPTheme.current?window.NPTheme.current():(document.documentElement.getAttribute('data-theme')==='dark'?'dark':'light'); opts.forEach(el=>{ const active=el.dataset.themeChoice===mode; el.classList.toggle('is-active',active); el.setAttribute('aria-checked',active?'true':'false'); }); }
  opts.forEach(el=>el.addEventListener('click',()=>{ window.NPTheme.set(el.dataset.themeChoice); paint(); }));
  document.addEventListener('np-theme-change', paint);
  paint();
}
wireThemeSwitch();

(async()=>{ $('#dashboard').classList.add('hidden'); $('#loginScreen').classList.add('hidden'); if(TOKEN){ try{ const me=await api('/auth/me'); if(me&&me.role==='RECEPTIONIST') return showDashboard(); localStorage.removeItem('np_reception_token'); TOKEN=null; }catch{} } showLogin(); })();