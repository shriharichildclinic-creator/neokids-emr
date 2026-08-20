const API = '/api';
let TOKEN = localStorage.getItem('np_reception_token');
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
let __me = null, __doctors = [], __assignments = [], __appts = [];

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
  if (s==='NEOKIDSPRO') return `<span class="np-badge np-badge--mint"><span class="np-badge__dot"></span>Online</span>`;
  if (s==='MANUAL') return `<span class="np-badge np-badge--slate"><span class="np-badge__dot"></span>Manual</span>`;
  return '';
}
function payBadge(p){ const m={PAID:['np-badge--green','Paid'],CASH_COLLECTED:['np-badge--green','Cash collected'],CASH_PENDING:['np-badge--amber','Cash pending'],UNPAID:['np-badge--amber','Unpaid']}; const x=m[p]; return x?`<span class="np-badge ${x[0]}"><span class="np-badge__dot"></span>${x[1]}</span>`:`<span class="np-badge np-badge--slate">${esc(p||'—')}</span>`; }

const VIEWS = { dashView:['Dashboard','Today at your clinic'], apptsView:['Appointments','Bookings for your doctors'], patientsView:['Patients','Search & register'], invoicesView:['Consultation Invoices','Reception billing'], certsView:['Certificates','Issued in the doctor name'], rxView:['Prescriptions','Offline prescriptions'], pharmBillsView:['Pharmacy Bills','Medicine sales'], settingsView:['Settings','Account'] };
function setView(v){ $$('.tab-pane').forEach(x=>x.classList.add('hidden')); const el=document.getElementById(v); if(el)el.classList.remove('hidden'); $$('.np-nav-item').forEach(n=>n.classList.toggle('active', n.dataset.view===v)); const m=VIEWS[v]; if(m){$('#pageTitle').textContent=m[0];$('#pageSubtitle').textContent=m[1];}
  if(v==='dashView')loadDashboard(); if(v==='apptsView')loadAppointments(); if(v==='patientsView')loadPatients(); if(v==='invoicesView')loadInvoices(); if(v==='certsView')loadCerts(); if(v==='rxView')loadRx(); if(v==='pharmBillsView')loadPharmBills(); }
$$('.np-nav-item').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));

$('#loginForm').addEventListener('submit', async e=>{ e.preventDefault(); try{ const r=await fetch(API+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:$('#email').value,password:$('#password').value})}); const d=await r.json().catch(()=>({})); if(!r.ok)throw new Error(d.error||'Login failed'); if(d.role!=='RECEPTIONIST')throw new Error('Not a receptionist account'); TOKEN=d.token; localStorage.setItem('np_reception_token',TOKEN); showDashboard(); }catch(err){ $('#loginError').textContent=err.message; $('#loginError').classList.remove('hidden'); }});
function logout(){ localStorage.removeItem('np_reception_token'); TOKEN=null; showLogin(); }
function showLogin(){ $('#dashboard').classList.add('hidden'); $('#loginScreen').classList.remove('hidden'); }

async function showDashboard(){
  $('#loginScreen').classList.add('hidden'); $('#dashboard').classList.remove('hidden');
  try{
    const meRes = await api('/auth/me'); __me = meRes.user || meRes;
    $('#userName').textContent = __me.name; $('#userInitials').textContent = __me.name.split(/\s+/).map(s=>s[0]).slice(0,2).join('').toUpperCase();
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
        ${!a.arrivedAt && a.status!=='CANCELLED' && a.status!=='COMPLETED' ? `<button class="np-btn np-btn--sm np-btn--primary" onclick="markArrived('${a.id}')">Mark arrived</button>`:''}
        ${!a.consultationInvoice && a.status!=='CANCELLED' ? `<button class="np-btn np-btn--sm" onclick="genInvoice('${a.id}')">Invoice</button>`:''}
      </div></div>`).join('') : '<div class="np-empty"><div class="np-empty__title">No appointments today</div></div>';
  }catch(e){ $('#kpiGrid').innerHTML=`<div class="np-error">${esc(e.message)}</div>`; }
}

async function loadAppointments(){
  const tb=$('#apptsTbody'); tb.innerHTML='<tr><td colspan="7" style="text-align:center;padding:1.4rem" class="np-mut">Loading…</td></tr>';
  const qs=new URLSearchParams(); if($('#fDate').value)qs.set('date',$('#fDate').value); if($('#fDoctor').value)qs.set('doctorId',$('#fDoctor').value); if($('#fStatus').value)qs.set('status',$('#fStatus').value); if($('#fQ').value.trim().length>=2)qs.set('q',$('#fQ').value.trim());
  try{ const rows=await api('/receptionist/appointments?'+(qs.toString()||'')); __appts=rows;
    tb.innerHTML = rows.length ? rows.map(a=>`<tr><td><b>${esc(fmtDate(a.date))}</b><div class="np-mut" style="font-size:.78rem">${esc(fmtTime(a.startTime))}</div></td>
      <td><b>${esc(a.patient.name)}</b><div class="np-mut" style="font-size:.78rem">+91 ${esc(a.patient.phone||'')}</div></td>
      <td>Dr. ${esc(a.doctor.name)}</td><td>${sourceBadge(a.source)}</td><td>${statusBadge(a.status)}</td><td>${payBadge(a.paymentStatus)}</td>
      <td style="text-align:right;white-space:nowrap">
        ${a.status==='CONFIRMED'||a.status==='PENDING'?`<button class="np-btn np-btn--sm" onclick="resched('${a.id}')">Reschedule</button> <button class="np-btn np-btn--sm np-btn--ghost" onclick="cancelAppt('${a.id}')">Cancel</button>`:''}
        ${!a.consultationInvoice && a.status!=='CANCELLED'?`<button class="np-btn np-btn--sm" onclick="genInvoice('${a.id}')">Invoice</button>`:''}
        ${__me.canIssueCertificates?`<button class="np-btn np-btn--sm np-btn--ghost" onclick="openCertModal('${a.id}')">Certificate</button>`:''}
      </td></tr>`).join('') : '<tr><td colspan="7"><div class="np-empty"><div class="np-empty__title">No appointments match</div></div></td></tr>';
  }catch(e){ tb.innerHTML=`<tr><td colspan="7"><div class="np-error">${esc(e.message)}</div></td></tr>`; }
}
$('#apptFilters').addEventListener('submit',e=>{e.preventDefault();loadAppointments();});

async function markArrived(id){ try{ await api('/receptionist/appointments/'+id+'/arrive',{method:'POST',body:'{}'}); toast('Patient marked arrived'); loadDashboard(); }catch(e){toast(e.message,'error');} }
async function resched(id){ const date=prompt('New date (YYYY-MM-DD):',todayIso()); if(!date)return; const startTime=prompt('New start time (HH:MM):',''); if(!startTime)return; const reason=prompt('Reason for reschedule:'); if(!reason||reason.trim().length<3){toast('Reason required (min 3 chars)','error');return;} try{ await api('/receptionist/appointments/'+id+'/reschedule',{method:'POST',body:JSON.stringify({date,startTime,reason})}); toast('Rescheduled'); loadAppointments(); }catch(e){toast(e.message,'error');} }
async function cancelAppt(id){ const reason=prompt('Cancellation reason:'); if(!reason||reason.trim().length<3){toast('Reason required (min 3 chars)','error');return;} try{ await api('/receptionist/appointments/'+id+'/cancel',{method:'POST',body:JSON.stringify({reason})}); toast('Cancelled'); loadAppointments(); }catch(e){toast(e.message,'error');} }
async function genInvoice(id){ try{ const r=await api('/receptionist/appointments/'+id+'/invoice',{method:'POST',body:JSON.stringify({})}); toast(r.existing?'Invoice already exists — opening':'Invoice generated'); if(r.pdfUrl|| (r.invoice&&r.invoice.pdfUrl)) window.open(r.pdfUrl||r.invoice.pdfUrl,'_blank'); sendInvoicePrompt(r.invoice.id); loadAppointments(); }catch(e){toast(e.message,'error');} }
async function sendInvoicePrompt(id){ const wa=confirm('Send invoice to patient on WhatsApp?'); const em=confirm('Also send by email (if on file)?'); if(!wa&&!em)return; try{ const ch=[]; if(wa)ch.push('whatsapp'); if(em)ch.push('email'); const r=await api('/receptionist/invoices/'+id+'/send',{method:'POST',body:JSON.stringify({channels:ch})}); toast('Invoice delivery: WhatsApp '+r.delivery.whatsapp+', Email '+r.delivery.email); }catch(e){toast(e.message,'error');} }

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
  <div class="np-field"><label class="np-row" style="gap:.5rem;align-items:center"><input type="checkbox" name="isWalkIn"/> Walk-in</label></div></div>
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
    const payload={ doctorId:docId, medicalCentreId:centreId, date:raw.date, startTime:raw.startTime, consultationType:'OFFLINE', primaryProblem:raw.primaryProblem, isWalkIn:!!raw.isWalkIn };
    if(pid){ payload.patientId=pid; } else {
      const namePart=typed.split(' — ')[0]; payload.patientName=namePart; payload.phone=raw.phone; payload.email=raw.email||''; payload.parentName=raw.parentName||''; payload.dateOfBirth=raw.dateOfBirth||''; payload.gender=raw.gender||undefined;
      if(!raw.phone){ toast('Phone is required for a new patient','error'); return; }
    }
    try{ const r=await api('/receptionist/appointments',{method:'POST',body:JSON.stringify(payload)}); toast('Appointment booked'); closeModal(); loadDashboard(); }catch(err){ toast(err.message,'error'); }
  });
}

// Invoices
async function loadInvoices(){ const tb=$('#invTbody'); try{ const rows=await api('/receptionist/invoices'); tb.innerHTML=rows.length?rows.map(i=>`<tr><td><b>${esc(i.invoiceNumber)}</b></td><td>${esc(i.appointment.patient.name)}</td><td>Dr. ${esc(i.appointment.doctor.name)}</td><td>${esc(i.medicalCentre?i.medicalCentre.name:'—')}</td><td style="text-align:right"><b>${inr(i.amount)}</b></td><td>${esc(fmtDate(i.createdAt))}</td><td style="text-align:right;white-space:nowrap">${i.pdfUrl?`<a class="np-btn np-btn--sm" href="${i.pdfUrl}" target="_blank">PDF</a> `:''}<button class="np-btn np-btn--sm" onclick="printPdf('${i.pdfUrl||''}')">Print</button> <button class="np-btn np-btn--sm np-btn--ghost" onclick="sendInvoicePrompt('${i.id}')">Send</button></td></tr>`).join(''):'<tr><td colspan="7"><div class="np-empty"><div class="np-empty__title">No invoices yet</div></div></td></tr>'; }catch(e){ tb.innerHTML=`<tr><td colspan="7"><div class="np-error">${esc(e.message)}</div></td></tr>`; } }
function printPdf(url){ if(!url){toast('Generate the invoice first','warn');return;} const w=window.open(url,'_blank'); if(w){w.addEventListener('load',()=>{try{w.print();}catch(_){}});} }

// Certificates
async function loadCerts(){ const list=$('#certsList'); try{ const rows=await api('/receptionist/certificates'); list.innerHTML=rows.length?'<div class="np-table-wrap"><table class="np-table"><thead><tr><th>Cert ID</th><th>Patient</th><th>Doctor</th><th>Template</th><th>Issued</th><th></th></tr></thead><tbody>'+rows.map(c=>`<tr><td>${esc(c.certificateNumber)}</td><td>${esc(c.patientNameSnapshot||(c.patient&&c.patient.name)||'')}</td><td>Dr. ${esc((c.doctor&&c.doctor.name)||'')}</td><td>${esc((c.templateKey||'').replace(/_/g,' '))}</td><td>${esc(fmtDate(c.issuedAt))}</td><td>${c.pdfUrl?`<a class="np-btn np-btn--sm" href="${c.pdfUrl}" target="_blank">PDF</a>`:''} <button class="np-btn np-btn--sm np-btn--ghost" onclick="sendCert('${c.id}')">Send</button></td></tr>`).join('')+'</tbody></table></div>':'<div class="np-empty"><div class="np-empty__title">No certificates yet</div></div>'; }catch(e){ list.innerHTML=`<div class="np-error">${esc(e.message)}</div>`; } }
async function sendCert(id){ const wa=confirm('Send on WhatsApp?'); const em=confirm('Send by email?'); if(!wa&&!em)return; const ch=[]; if(wa)ch.push('whatsapp'); if(em)ch.push('email'); try{ const r=await api('/receptionist/certificates/'+id+'/send',{method:'POST',body:JSON.stringify({channels:ch})}); toast('Delivery: WhatsApp '+r.delivery.whatsapp+', Email '+r.delivery.email); }catch(e){toast(e.message,'error');} }
async function openCertModal(appointmentId){
  let tpls=[]; try{ tpls=await api('/receptionist/certificates/templates'); }catch(_){}
  const docOpts=__doctors.map(d=>`<option value="${d.id}">Dr. ${esc(d.name)}</option>`).join('');
  $('#modalHost').innerHTML=`<div class="np-modal"><div class="np-modal__panel"><header class="np-modal__head"><div class="np-modal__title">Issue medical certificate</div><button class="np-modal__close" onclick="closeModal()">×</button></header><div class="np-modal__body"><form id="cForm"><div class="np-grid-2">
  ${appointmentId?'':'<div class="np-field"><label class="np-field__label">Doctor *</label><select name="doctorId" class="np-select">'+docOpts+'</select></div><div class="np-field"><label class="np-field__label">Patient ID *</label><input name="patientId" required class="np-input" placeholder="UUID from Patients"/></div>'}
  <div class="np-field" style="grid-column:span 2"><label class="np-field__label">Template</label><select name="templateKey" class="np-select">${tpls.map(t=>`<option value="${t.key}">${esc(t.label)}</option>`).join('')}</select></div>
  <div class="np-field" style="grid-column:span 2"><label class="np-field__label">Reason *</label><textarea name="reason" required class="np-textarea"></textarea></div>
  <div class="np-field"><label class="np-field__label">Diagnosis</label><input name="diagnosis" class="np-input"/></div>
  <div class="np-field"><label class="np-field__label">Rest days</label><input name="restDays" type="number" min="0" class="np-input"/></div>
  <div class="np-field"><label class="np-field__label">From date</label><input name="fromDate" type="date" class="np-input"/></div>
  <div class="np-field"><label class="np-field__label">To date</label><input name="toDate" type="date" class="np-input"/></div></div>
  <div class="np-row" style="justify-content:flex-end;gap:.5rem"><button type="button" class="np-btn" onclick="closeModal()">Cancel</button><button class="np-btn np-btn--primary" type="submit">Issue & generate PDF</button></div></form></div></div></div>`;
  $('#cForm').addEventListener('submit',async e=>{e.preventDefault(); const raw=Object.fromEntries(new FormData(e.target).entries()); const payload={ templateKey:raw.templateKey, reason:raw.reason, diagnosis:raw.diagnosis||'', restDays:raw.restDays===''?undefined:Number(raw.restDays), fromDate:raw.fromDate||'', toDate:raw.toDate||'' };
    const url = appointmentId? '/receptionist/appointments/'+appointmentId+'/certificate' : '/receptionist/certificates';
    if(!appointmentId){ payload.doctorId=raw.doctorId; payload.patientId=raw.patientId; }
    try{ const r=await api(url,{method:'POST',body:JSON.stringify(payload)}); toast('Certificate issued'); if(r.pdfUrl)window.open(r.pdfUrl,'_blank'); closeModal(); loadCerts(); }catch(err){toast(err.message,'error');} });
}

// Pharmacy (receptionist with permission)
async function loadRx(){ const list=$('#rxList'); try{ const rows=await api('/receptionist/pharmacy/prescriptions'); list.innerHTML=rows.length?rows.map(rx=>`<div class="np-appt-row"><div class="np-appt-row__body"><div class="np-appt-row__name">${esc(rx.patient.name)} ${rx.dispensed?'<span class="np-badge np-badge--green"><span class="np-badge__dot"></span>Dispensed</span>':'<span class="np-badge np-badge--amber"><span class="np-badge__dot"></span>Pending</span>'}</div><div class="np-appt-row__assign">Dr. ${esc(rx.doctor.name)} · ${esc(fmtDate(rx.visitDate))}</div><div class="np-appt-row__meta">${(rx.medications||[]).map(m=>esc(m.name)+' '+esc(m.dose||'')).join(', ')}</div></div><div class="np-appt-row__right"><span class="np-badge np-badge--slate">${esc(rx.createdByRole==='RECEPTIONIST'?'by reception':'by doctor')}</span>${!rx.dispensed?` <button class="np-btn np-btn--sm np-btn--primary" onclick="openBillModal(null,'${rx.id}')">Dispense</button>`:''}</div></div>`).join(''):'<div class="np-empty"><div class="np-empty__title">No offline prescriptions</div></div>'; }catch(e){ list.innerHTML=`<div class="np-error">${esc(e.message)}</div>`; } }
async function loadPharmBills(){ const tb=$('#pharmBillsTbody'); try{ const rows=await api('/receptionist/pharmacy/bills'); tb.innerHTML=rows.length?rows.map(b=>`<tr><td><b>${esc(b.billNumber)}</b></td><td>${esc(b.customerName||'')}</td><td style="text-align:right"><b>${inr(b.total)}</b></td><td>${esc(fmtDate(b.createdAt))}</td><td style="text-align:right">${b.pdfUrl?`<a class="np-btn np-btn--sm" href="${b.pdfUrl}" target="_blank">PDF</a>`:''}</td></tr>`).join(''):'<tr><td colspan="5"><div class="np-empty"><div class="np-empty__title">No bills yet</div></div></td></tr>'; }catch(e){ tb.innerHTML=`<tr><td colspan="5"><div class="np-error">${esc(e.message)}</div></td></tr>`; } }
async function openBillModal(_, rxId){
  let items=[]; try{ items=await api('/receptionist/pharmacy/inventory'); }catch(_){}
  const opts=items.map(i=>`<option value="${i.id}" data-price="${i.sellingPrice}" data-name="${esc(i.name)}">${esc(i.name)} (₹${Number(i.sellingPrice).toFixed(2)} · stock ${i.stock})</option>`).join('');
  $('#modalHost').innerHTML=`<div class="np-modal"><div class="np-modal__panel"><header class="np-modal__head"><div class="np-modal__title">New pharmacy bill</div><button class="np-modal__close" onclick="closeModal()">×</button></header><div class="np-modal__body"><form id="billForm">
  <div class="np-field"><label class="np-field__label">Customer name</label><input name="customerName" class="np-input"/></div>
  <div class="np-field"><label class="np-field__label">Customer phone</label><input name="customerPhone" class="np-input" maxlength="10"/></div>
  <div id="billLines"></div>
  <button type="button" class="np-btn np-btn--sm np-btn--ghost" onclick="addBillLine()">+ Add item</button>
  <div class="np-grid-2" style="margin-top:.75rem"><div class="np-field"><label class="np-field__label">Discount (₹)</label><input name="discount" type="number" step="0.01" value="0" class="np-input"/></div><div class="np-field"><label class="np-field__label">Tax (₹)</label><input name="tax" type="number" step="0.01" value="0" class="np-input"/></div></div>
  <div class="np-row" style="justify-content:flex-end;gap:.5rem"><button type="button" class="np-btn" onclick="closeModal()">Cancel</button><button class="np-btn np-btn--primary" type="submit">Generate bill</button></div></form></div></div></div>`;
  window.__billItemOpts=opts;
  addBillLine();
  $('#billForm').addEventListener('submit',async e=>{e.preventDefault(); const raw=Object.fromEntries(new FormData(e.target).entries()); const lines=$$('#billLines .bill-line').map(l=>({ itemId:l.querySelector('.bl-item').value||undefined, name:l.querySelector('.bl-item').selectedOptions[0]?.dataset.name||l.querySelector('.bl-name').value, quantity:Number(l.querySelector('.bl-qty').value||1), unitPrice:Number(l.querySelector('.bl-price').value||0) })).filter(l=>l.name);
    if(!lines.length){toast('Add at least one item','error');return;}
    try{ const r=await api('/receptionist/pharmacy/bills',{method:'POST',body:JSON.stringify({ customerName:raw.customerName||'', customerPhone:raw.customerPhone||'', prescriptionId:rxId||undefined, discount:Number(raw.discount||0), tax:Number(raw.tax||0), items:lines })}); toast('Bill created'); if(r.pdfUrl)window.open(r.pdfUrl,'_blank'); closeModal(); loadPharmBills(); }catch(err){toast(err.message,'error');} });
}
function addBillLine(){ const host=$('#billLines'); const div=document.createElement('div'); div.className='bill-line np-row'; div.style.cssText='gap:.5rem;align-items:flex-end;margin-bottom:.5rem;'; div.innerHTML=`<div class="np-field" style="flex:2"><select class="np-select bl-item"><option value="">— manual —</option>${window.__billItemOpts}</select><input class="np-input bl-name" placeholder="Medicine name" style="margin-top:.35rem"/></div><div class="np-field"><label class="np-field__label">Qty</label><input type="number" class="np-input bl-qty" value="1" min="1"/></div><div class="np-field"><label class="np-field__label">Price</label><input type="number" step="0.01" class="np-input bl-price" value="0"/></div>`; host.appendChild(div);
  div.querySelector('.bl-item').addEventListener('change',e=>{ const o=e.target.selectedOptions[0]; if(o&&o.value){ div.querySelector('.bl-name').value=o.dataset.name; div.querySelector('.bl-price').value=o.dataset.price; } });
}

$('#passwordForm').addEventListener('submit',async e=>{e.preventDefault(); const d=Object.fromEntries(new FormData(e.target).entries()); if(d.newPassword!==d.confirmPassword){toast('Passwords do not match','error');return;} try{ await api('/auth/change-password',{method:'POST',body:JSON.stringify(d)}); toast('Password changed'); e.target.reset(); }catch(err){toast(err.message,'error');}});

(async()=>{ $('#dashboard').classList.add('hidden'); $('#loginScreen').classList.add('hidden'); if(TOKEN){ try{ const me=await api('/auth/me'); if(me&&me.role==='RECEPTIONIST') return showDashboard(); localStorage.removeItem('np_reception_token'); TOKEN=null; }catch{} } showLogin(); })();