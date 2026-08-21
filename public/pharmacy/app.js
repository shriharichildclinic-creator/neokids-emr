const API = '/api';
let TOKEN = localStorage.getItem('np_pharmacy_token');
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
let __me=null, __items=[], __doctors=[], __bills=[];

async function api(path, opts={}){ const headers={'Content-Type':'application/json',...(TOKEN&&{Authorization:'Bearer '+TOKEN}),...(opts.headers||{})}; const r=await fetch(API+path,{...opts,headers}); let d=null; try{d=await r.json();}catch(_){}
  if(r.status===401&&TOKEN){localStorage.removeItem('np_pharmacy_token');TOKEN=null;showLogin();throw new Error('Session expired');}
  if(!r.ok)throw new Error((d&&(d.error||d.message))||('HTTP '+r.status)); return d; }
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function toast(m,k){ if(window.NPToast&&NPToast[k||'success'])NPToast[k||'success'](m); else alert(m); }
function fmtDate(d){ if(!d)return''; return new Date(d).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}); }
function inr(n){ return '₹'+Number(n||0).toLocaleString('en-IN',{minimumFractionDigits:2}); }

const VIEWS={dashView:['Dashboard','Store overview'],rxView:['Prescriptions','Offline prescriptions'],invView:['Inventory','Medicines & stock'],billsView:['Bills','Sales & invoices'],settingsView:['Settings','Account']};
function setView(v){ $$('.tab-pane').forEach(x=>x.classList.add('hidden')); const el=document.getElementById(v); if(el)el.classList.remove('hidden'); $$('.np-nav-item').forEach(n=>n.classList.toggle('active',n.dataset.view===v)); const m=VIEWS[v]; if(m){$('#pageTitle').textContent=m[0];$('#pageSubtitle').textContent=m[1];}
  if(v==='dashView')loadDash(); if(v==='rxView')loadRx(); if(v==='invView')loadInv(); if(v==='billsView')loadBills(); }
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

$('#loginForm').addEventListener('submit',async e=>{e.preventDefault(); try{ const r=await fetch(API+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:$('#email').value,password:$('#password').value})}); const d=await r.json().catch(()=>({})); if(!r.ok)throw new Error(d.error||'Login failed'); if(d.role!=='PHARMACY')throw new Error('Not a pharmacy account'); TOKEN=d.token; localStorage.setItem('np_pharmacy_token',TOKEN); showDashboard(); }catch(err){ $('#loginError').textContent=err.message; $('#loginError').classList.remove('hidden'); }});
function logout(){ localStorage.removeItem('np_pharmacy_token'); TOKEN=null; showLogin(); }
function showLogin(){ $('#dashboard').classList.add('hidden'); $('#loginScreen').classList.remove('hidden'); }
async function showDashboard(){ $('#loginScreen').classList.add('hidden'); $('#dashboard').classList.remove('hidden'); setupSidebar(); setupProfileMenu(); try{ const me=await api('/auth/me'); __me=me.user||me; const __initials=__me.name.split(/\s+/).map(s=>s[0]).slice(0,2).join('').toUpperCase(); $('#userName').textContent=__me.name; $('#userInitials').textContent=__initials; /* mirror into dropdown "logged in as" block -- stays visible on mobile once header hides .np-profile__meta */ if($('#userIdName'))$('#userIdName').textContent=__me.name; if($('#userIdInitials'))$('#userIdInitials').textContent=__initials; if($('#userIdEmail'))$('#userIdEmail').textContent=__me.email||''; }catch(e){} setView('dashView'); }

async function loadDash(){ try{ const s=await api('/pharmacy/stats');
  $('#kpiGrid').innerHTML=[{k:'blue',l:'Medicines in stock',v:s.totalItems},{k:'amber',l:'Low stock (≤10)',v:s.lowStock},{k:'red',l:'Expiring ≤30 days',v:s.expiringSoon},{k:'green',l:'Bills today',v:s.todayBills},{k:'mint',l:'Revenue today',v:inr(s.todayRevenue)}].map(c=>`<div class="np-kpi np-kpi--${c.k}"><div class="np-kpi__label">${c.l}</div><div class="np-kpi__value">${c.v}</div></div>`).join('');
  const bills=await api('/pharmacy/bills'); $('#recentBills').innerHTML=(bills.slice(0,8).map(b=>`<div class="np-appt-row"><div class="np-appt-row__body"><div class="np-appt-row__name">${esc(b.billNumber)}</div><div class="np-appt-row__meta">${esc(b.customerName||'Walk-in')} · ${esc(fmtDate(b.createdAt))}</div></div><div class="np-appt-row__right"><b>${inr(b.total)}</b></div></div>`).join('')||'<div class="np-empty"><div class="np-empty__sub">No bills yet.</div></div>');
 }catch(e){ $('#kpiGrid').innerHTML=`<div class="np-error">${esc(e.message)}</div>`; } }

async function loadRx(){ const list=$('#rxList'); const f=$('#rxFilter').value; try{ const rows=await api('/pharmacy/prescriptions'+(f?('?dispensed='+f):''));
  list.innerHTML=rows.length?rows.map(rx=>`<div class="np-appt-row"><div class="np-appt-row__body"><div class="np-appt-row__name">${esc(rx.patient.name)} ${rx.dispensed?'<span class="np-badge np-badge--green"><span class="np-badge__dot"></span>Dispensed</span>':'<span class="np-badge np-badge--amber"><span class="np-badge__dot"></span>Pending</span>'}</div><div class="np-appt-row__assign">Dr. ${esc(rx.doctor.name)} · ${esc(fmtDate(rx.visitDate))}</div><div class="np-appt-row__meta">${(rx.medications||[]).map(m=>esc(m.name)+' '+esc(m.dose||'')+' '+esc(m.frequency||'')).join('<br/>')}</div></div><div class="np-appt-row__right"><span class="np-badge ${rx.createdByRole==='RECEPTIONIST'?'np-badge--violet':'np-badge--mint'}">${rx.createdByRole==='RECEPTIONIST'?'by reception':'by doctor'}</span>${!rx.dispensed?` <button class="np-btn np-btn--sm np-btn--primary" onclick="openBillModal('${rx.id}')">Dispense & bill</button>`:''}</div></div>`).join(''):'<div class="np-empty"><div class="np-empty__title">No prescriptions</div></div>';
 }catch(e){ list.innerHTML=`<div class="np-error">${esc(e.message)}</div>`; } }

async function loadInv(q){ const tb=$('#invTbody'); try{ __items=await api('/pharmacy/inventory'+(q?('?q='+encodeURIComponent(q)):''));
  tb.innerHTML=__items.length?__items.map(i=>`<tr><td data-label="Medicine"><b>${esc(i.name)}</b><div class="np-mut" style="font-size:.75rem">${esc(i.manufacturer||'')}</div></td><td data-label="Batch">${esc(i.batchNumber||'—')}</td><td data-label="Price" style="text-align:right">${inr(i.sellingPrice)}</td><td data-label="Stock" style="text-align:right"><b class="${i.stock<=10?'np-error':''}">${i.stock}</b></td><td data-label="Expiry">${i.expiryDate?esc(fmtDate(i.expiryDate)):'—'}</td><td data-label="Actions" style="text-align:right;white-space:nowrap"><button class="np-btn np-btn--sm" onclick="openItemModal('${i.id}')">Edit</button> <button class="np-btn np-btn--sm np-btn--ghost" onclick="adjustStock('${i.id}')">Stock</button> <button class="np-btn np-btn--sm np-btn--ghost np-btn--danger" onclick="delItem('${i.id}')">Remove</button></td></tr>`).join(''):'<tr><td colspan="6"><div class="np-empty"><div class="np-empty__title">No medicines</div></div></td></tr>';
 }catch(e){ tb.innerHTML=`<tr><td colspan="6"><div class="np-error">${esc(e.message)}</div></td></tr>`; } }
$('#invSearch').addEventListener('input',e=>{clearTimeout(window.__is); window.__is=setTimeout(()=>loadInv(e.target.value.trim()),300);});

function openItemModal(id){ const it=id?__items.find(x=>x.id===id):null;
  $('#modalHost').innerHTML=`<div class="np-modal"><div class="np-modal__panel"><header class="np-modal__head"><div class="np-modal__title">${it?'Edit':'Add'} medicine</div><button class="np-modal__close" onclick="closeModal()">×</button></header><div class="np-modal__body"><form id="iForm"><div class="np-grid-2">
  <div class="np-field" style="grid-column:span 2"><label class="np-field__label">Name *</label><input name="name" required class="np-input" value="${it?esc(it.name):''}"/></div>
  <div class="np-field"><label class="np-field__label">Batch #</label><input name="batchNumber" class="np-input" value="${it?esc(it.batchNumber||''):''}"/></div>
  <div class="np-field"><label class="np-field__label">Unit</label><input name="unit" class="np-input" value="${it?esc(it.unit||'strip'):'strip'}"/></div>
  <div class="np-field"><label class="np-field__label">Selling price (₹)</label><input name="sellingPrice" type="number" step="0.01" class="np-input" value="${it?it.sellingPrice:''}"/></div>
  <div class="np-field"><label class="np-field__label">MRP (₹)</label><input name="mrp" type="number" step="0.01" class="np-input" value="${it?it.mrp:''}"/></div>
  <div class="np-field"><label class="np-field__label">Stock</label><input name="stock" type="number" class="np-input" value="${it?it.stock:'0'}"/></div>
  <div class="np-field"><label class="np-field__label">Expiry</label><input name="expiryDate" type="date" class="np-input" value="${it&&it.expiryDate?String(it.expiryDate).slice(0,10):''}"/></div>
  <div class="np-field" style="grid-column:span 2"><label class="np-field__label">Manufacturer</label><input name="manufacturer" class="np-input" value="${it?esc(it.manufacturer||''):''}"/></div></div>
  <div class="np-row" style="justify-content:flex-end;gap:.5rem"><button type="button" class="np-btn" onclick="closeModal()">Cancel</button><button class="np-btn np-btn--primary" type="submit">Save</button></div></form></div></div></div>`;
  $('#iForm').addEventListener('submit',async e=>{e.preventDefault(); const raw=Object.fromEntries(new FormData(e.target).entries()); try{ if(it){ await api('/pharmacy/inventory/'+it.id,{method:'PUT',body:JSON.stringify(raw)});} else { await api('/pharmacy/inventory',{method:'POST',body:JSON.stringify(raw)});} toast('Saved'); closeModal(); loadInv(); }catch(err){toast(err.message,'error');} });
}
function closeModal(){ $('#modalHost').innerHTML=''; }
async function adjustStock(id){ const d=prompt('Stock adjustment (+/- quantity):'); if(!d)return; const n=parseInt(d,10); if(!n)return; try{ await api('/pharmacy/inventory/'+id+'/stock',{method:'POST',body:JSON.stringify({delta:n,reason:'Manual adjustment'})}); toast('Stock updated'); loadInv(); }catch(e){toast(e.message,'error');} }
async function delItem(id){ if(!confirm('Remove this medicine from active inventory?'))return; try{ await api('/pharmacy/inventory/'+id,{method:'DELETE'}); toast('Removed'); loadInv(); }catch(e){toast(e.message,'error');} }

function billTypeBadge(t){ const m={PHARMACY:['np-badge--mint','Pharmacy'],CONSULT:['np-badge--blue','Consult'],SERVICE:['np-badge--violet','Service']}; const x=m[t]||['np-badge--slate',t||'Pharmacy']; return `<span class="np-badge ${x[0]}"><span class="np-badge__dot"></span>${x[1]}</span>`; }
function billStatusBadge(s){ return s==='PAID'?'<span class="np-badge np-badge--green"><span class="np-badge__dot"></span>Paid</span>':'<span class="np-badge np-badge--amber"><span class="np-badge__dot"></span>Draft</span>'; }
function billActionsHtml(b){
  const btns=[];
  if(b.pdfUrl) btns.push(`<a class="np-btn np-btn--sm" href="${b.pdfUrl}" target="_blank">PDF</a>`);
  btns.push(`<button class="np-btn np-btn--sm" onclick="showBillActions('${b.id}')">Actions</button>`);
  return btns.join(' ');
}
async function loadBills(){ const tb=$('#billsTbody'); try{ const rows=await api('/pharmacy/bills'); __bills=rows; tb.innerHTML=rows.length?rows.map(b=>`<tr><td data-label="Bill #"><b>${esc(b.billNumber)}</b></td><td data-label="Type">${billTypeBadge(b.billType)}</td><td data-label="Customer">${esc(b.customerName||'')}</td><td data-label="Items" style="text-align:right">${(b.items||[]).length}</td><td data-label="Total" style="text-align:right"><b>${inr(b.total)}</b></td><td data-label="Status">${billStatusBadge(b.status)}</td><td data-label="Date">${esc(fmtDate(b.createdAt))}</td><td data-label="Actions" style="text-align:right;white-space:nowrap">${billActionsHtml(b)}</td></tr>`).join(''):'<tr><td colspan="8"><div class="np-empty"><div class="np-empty__title">No bills yet</div></div></td></tr>'; }catch(e){ tb.innerHTML=`<tr><td colspan="8"><div class="np-error">${esc(e.message)}</div></td></tr>`; } }
function printPdf(url){ if(!url){toast('No PDF yet','warn');return;} const w=window.open(url,'_blank'); if(w){w.addEventListener('load',()=>{try{w.print();}catch(_){}});} }
function openBillSendModal(billId, phone, email){
  const hasPhone=!!phone; const hasEmail=!!email;
  if(!hasPhone && !hasEmail){ toast('Customer has no phone or email on file — cannot send','error'); return; }
  $('#modalHost').innerHTML=`<div class="np-modal"><div class="np-modal__panel"><header class="np-modal__head"><div class="np-modal__title">Send bill</div><button class="np-modal__close" onclick="closeModal()">×</button></header><div class="np-modal__body">
    <div class="np-row" style="flex-direction:column;align-items:flex-start;gap:.5rem">
      ${hasPhone?`<label class="np-row" style="gap:.5rem"><input type="checkbox" id="sendBillWa" checked/> Send via WhatsApp</label>`:''}
      ${hasEmail?`<label class="np-row" style="gap:.5rem"><input type="checkbox" id="sendBillEm" ${hasPhone?'':'checked'}/> Send via Email</label>`:''}
    </div>
    <div class="np-row" style="justify-content:flex-end;gap:.5rem;margin-top:1rem"><button type="button" class="np-btn" onclick="closeModal()">Cancel</button><button type="button" class="np-btn np-btn--primary" id="sendBillConfirm">Send</button></div>
  </div></div></div>`;
  $('#sendBillConfirm').addEventListener('click', async ()=>{
    const channels=[];
    if(hasPhone && $('#sendBillWa').checked) channels.push('whatsapp');
    if(hasEmail && $('#sendBillEm') && $('#sendBillEm').checked) channels.push('email');
    if(!channels.length){ toast('Choose at least one channel','error'); return; }
    closeModal();
    try{ const r=await api('/pharmacy/bills/'+billId+'/send',{method:'POST',body:JSON.stringify({channels})}); toast('Delivery: WhatsApp '+r.delivery.whatsapp+', Email '+r.delivery.email); }catch(e){ toast(e.message,'error'); }
  });
}

async function openBillModal(rxId){
  // Root-cause fix for "pharmacy stock not updating": always re-fetch
  // inventory from the server when opening the bill modal so the dropdown,
  // stock hints and max-quantity clamp reflect the latest committed stock.
  // Cached __items would otherwise keep pre-sale quantities and mislead
  // the user into selling medicines already depleted.
  try{ __items=await api('/pharmacy/inventory'); }catch(_){__items=__items||[];}
  await loadPortalDoctors();
  window.NPBilling.open({
    api, esc, fmt: fmtDate, toast,
    onSaved: function () { refreshAll(); },
    inventory: __items, doctors: __doctors, billsBase: '/pharmacy/bills',
    role: 'PHARMACY', host: '#modalHost', rxId: rxId,
    patientSearch: q => api('/pharmacy/patients?q='+encodeURIComponent(q))
  });
}
function refreshAll(){
  // Re-pull every dependent dataset in parallel so the dashboard + bills
  // + inventory + KPIs never show stale stock or stale sale totals after a
  // mutation (bill save / edit / mark-paid / stock adjust / new item).
  Promise.all([
    api('/pharmacy/inventory').then(function (r) { __items = r; loadInv(); }).catch(function () {}),
    api('/pharmacy/bills').then(function (r) { __bills = r; loadBills(); }).catch(function () {}),
    api('/pharmacy/stats').then(function (s) {
      var kg = document.getElementById('kpiGrid');
      if (!kg) return;
      kg.innerHTML = [
        { k: 'blue',  l: 'Medicines in stock', v: s.totalItems },
        { k: 'amber', l: 'Low stock (\u226410)', v: s.lowStock },
        { k: 'red',   l: 'Expiring \u226430 days', v: s.expiringSoon },
        { k: 'green', l: 'Bills today', v: s.todayBills },
        { k: 'mint',  l: 'Revenue today', v: inr(s.todayRevenue) }
      ].map(function (c) {
        return '<div class="np-kpi np-kpi--' + c.k + '"><div class="np-kpi__label">' + c.l + '</div><div class="np-kpi__value">' + c.v + '</div></div>';
      }).join('');
    }).catch(function () {})
  ]);
}
async function loadPortalDoctors(){ try{ const a=await api('/pharmacy/assignments'); __doctors=(a&&a.doctors)||[]; }catch(_){__doctors=__doctors||[];} }
function __billUrlById(id){ const b=__bills.find(x=>x.id===id); return b?b.pdfUrl:''; }
function showBillActions(id){
  const b=__bills.find(x=>x.id===id); if(!b) return;
  const isPaid=b.status==='PAID';
  let rows='';
  if(isPaid){
    rows+='<button type="button" class="np-btn np-btn--block" disabled>Paid — locked</button>';
  } else {
    rows+="<button type='button' class='np-btn np-btn--block' onclick=\"closeModal();editBill('"+id+"')\">Edit draft</button>";
    rows+="<button type='button' class='np-btn np-btn--block np-btn--primary' onclick=\"closeModal();__markPaid('"+id+"')\">Mark paid</button>";
  }
  rows+="<button type='button' class='np-btn np-btn--block' onclick=\"closeModal();openBillSendModal2('"+id+"')\">Send</button>";
  if(b.pdfUrl){
    rows+="<button type='button' class='np-btn np-btn--block' onclick=\"window.open('"+b.pdfUrl+"','_blank')\">View PDF</button>";
    rows+="<button type='button' class='np-btn np-btn--block' onclick=\"printPdf('"+b.pdfUrl+"')\">Print</button>";
  }
  $('#modalHost').innerHTML='<div class="np-modal"><div class="np-modal__panel"><header class="np-modal__head"><div class="np-modal__title">Bill actions — '+esc(b.billNumber)+'</div><button class="np-modal__close" onclick="closeModal()">×</button></header><div class="np-modal__body"><div class="np-action-list">'+rows+'</div></div></div></div>';
}
function __markPaid(id){
  NPBilling.markPaid(
    { api:api, esc:esc, fmt:fmtDate, toast:toast, onSaved:loadBills, billsBase:'/pharmacy/bills' },
    id,
    function () { refreshAll(); }
  );
}
async function editBill(id){
  try{
    const b = await api('/pharmacy/bills/'+id);
    if (b.status !== 'DRAFT') { toast('This bill is already paid and locked','warn'); return; }
    // Same root-cause fix as openBillModal — refresh cached inventory
    // before re-rendering the modal so stock hints are accurate.
    try { __items = await api('/pharmacy/inventory'); } catch (_) { __items = __items || []; }
    await loadPortalDoctors();
    window.NPBilling.open(
      { api, esc, fmt: fmtDate, toast, onSaved: function () { refreshAll(); },
        inventory: __items, doctors: __doctors, billsBase: '/pharmacy/bills',
        role: 'PHARMACY', host: '#modalHost',
        patientSearch: function (q) { return api('/pharmacy/patients?q=' + encodeURIComponent(q)); } },
      b
    );
  } catch (e) { toast(e.message, 'error'); }
}
function openBillSendModal2(id){ api('/pharmacy/bills/'+id).then(b=>{ openBillSendModal(id, b.customerPhone||'', (b.patient&&b.patient.email)||''); }).catch(e=>toast(e.message,'error')); }

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

(async()=>{ $('#dashboard').classList.add('hidden'); $('#loginScreen').classList.add('hidden'); if(TOKEN){ try{ const me=await api('/auth/me'); if(me&&me.role==='PHARMACY') return showDashboard(); localStorage.removeItem('np_pharmacy_token'); TOKEN=null; }catch{} } showLogin(); })();