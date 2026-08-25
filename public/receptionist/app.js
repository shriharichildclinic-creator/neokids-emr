const API = '/api';
let TOKEN = localStorage.getItem('np_reception_token');
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
// Null-safe innerHTML/textContent setters — a missing element should
// never throw and blank an entire dashboard section.
function setHtml(id, html){ const el = document.getElementById(id); if (el) el.innerHTML = html; }
function setText(id, text){ const el = document.getElementById(id); if (el) el.textContent = text; }
let __me = null, __doctors = [], __assignments = [], __appts = [], __todayAppts = [], __bills = [], __pharmBills = [], __inv = [];

function setTopBarAvatar(photoUrl){
  ['myAvatar', 'myIdAvatar'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const initials = el.querySelector('span');
    let img = el.querySelector('img');
    if (photoUrl){
      if (!img){ img = document.createElement('img'); el.insertBefore(img, initials); }
      img.src = photoUrl; img.alt = '';
      if (initials) initials.style.display = 'none';
    } else {
      if (img) img.remove();
      if (initials) initials.style.display = '';
    }
  });
}

function setOwnPhotoPreview(url){
  const img = $('#ownPhotoPreview');
  const placeholder = $('#ownPhotoPlaceholder');
  const removeBtn = $('#ownPhotoRemoveBtn');
  if (!img || !placeholder || !removeBtn) return;
  if (url){
    img.src = url; img.classList.remove('hidden');
    img.style.cursor = 'zoom-in';
    img.onclick = () => NPLightbox.open(url, 'Profile photo');
    placeholder.classList.add('hidden');
    removeBtn.classList.remove('hidden');
  } else {
    img.src = ''; img.classList.add('hidden');
    placeholder.classList.remove('hidden');
    removeBtn.classList.add('hidden');
  }
}

async function uploadOwnPhoto(file){
  if (!file) return;
  const fd = new FormData();
  fd.append('photo', file);
  try {
    const r = await fetch(API + '/receptionist/profile-image', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN },
      body: fd
    });
    let data = null; try { data = await r.json(); } catch(_) {}
    if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
    setOwnPhotoPreview(data.photoUrl);
    setTopBarAvatar(data.photoUrl);
    toast('Photo updated.');
  } catch (err) { toast(err.message, 'error'); }
  finally { const input = $('#ownPhotoInput'); if (input) input.value = ''; }
}

async function removeOwnPhoto(){
  try {
    await api('/receptionist/profile-image', { method: 'DELETE' });
    setOwnPhotoPreview(null);
    setTopBarAvatar(null);
    toast('Photo removed.');
  } catch (err) { toast(err.message, 'error'); }
}

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
function calcAge(dob){
  if(!dob) return '';
  const d=new Date(dob), now=new Date();
  let years=now.getFullYear()-d.getFullYear();
  const m=now.getMonth()-d.getMonth();
  if(m<0 || (m===0 && now.getDate()<d.getDate())) years--;
  if(years<1){
    let months=(now.getFullYear()-d.getFullYear())*12+(now.getMonth()-d.getMonth());
    if(now.getDate()<d.getDate()) months--;
    return Math.max(months,0)+'mo';
  }
  return years+'y';
}

// ─── Overflow ("…") menu — ported from /doctor/app.js so secondary
// appointment-card actions behave identically (fixed-position on mobile so
// they never clip inside a scrolling card list, closes on outside
// click/scroll/resize/Escape). ───
function closeOverflowMenus(except){
  document.querySelectorAll('.np-overflow-menu.is-open').forEach(menu => {
    if (menu === except) return;
    menu.classList.remove('is-open');
    menu.style.left = ''; menu.style.top = ''; menu.style.right = ''; menu.style.bottom = '';
    menu.style.position = ''; menu.style.maxHeight = ''; menu.style.zIndex = '';
    menu.style.width = ''; menu.style.maxWidth = '';
    const origParent = menu.__npOrigParent;
    const origNext   = menu.__npOrigNext;
    if (origParent && menu.parentNode !== origParent) {
      try {
        if (origNext && origNext.parentNode === origParent) origParent.insertBefore(menu, origNext);
        else origParent.appendChild(menu);
      } catch(_) {}
    }
    menu.__npOrigParent = null; menu.__npOrigNext = null;
  });
}
function positionOverflowMenu(trigger, menu){
  const margin = 12, gap = 6;
  const vw = window.innerWidth, vh = window.innerHeight;
  menu.style.position = 'fixed';
  menu.style.left = '0px'; menu.style.top = '0px'; menu.style.right = 'auto'; menu.style.bottom = 'auto';
  menu.style.width = ''; menu.style.zIndex = '1000';
  const availableW = vw - margin * 2;
  const desiredW = Math.min(menu.offsetWidth || 220, 260);
  const width = Math.min(desiredW, availableW);
  menu.style.maxWidth = availableW + 'px'; menu.style.width = width + 'px';
  void menu.offsetWidth;
  const triggerRect = trigger.getBoundingClientRect();
  const height = Math.min(menu.offsetHeight || 200, vh - margin * 2);
  let left = triggerRect.right - width;
  if (left < margin) left = Math.min(triggerRect.left, vw - margin - width);
  left = Math.max(margin, Math.min(left, vw - margin - width));
  const spaceBelow = vh - triggerRect.bottom - margin;
  const spaceAbove = triggerRect.top - margin;
  const openUp = height > spaceBelow && spaceAbove > spaceBelow;
  const maxHeight = Math.max(160, openUp ? spaceAbove : spaceBelow);
  let top = openUp
    ? Math.max(margin, triggerRect.top - Math.min(height, maxHeight) - gap)
    : (triggerRect.bottom + gap);
  top = Math.max(margin, Math.min(top, vh - margin - Math.min(height, maxHeight)));
  menu.style.left = left + 'px'; menu.style.top = top + 'px'; menu.style.maxHeight = maxHeight + 'px';
}
function toggleOverflow(btn){
  const menu = btn && btn.nextElementSibling;
  if (!menu || !menu.classList.contains('np-overflow-menu')) return;
  const isOpen = menu.classList.contains('is-open');
  closeOverflowMenus();
  if (isOpen) return;
  if (menu.parentNode && menu.parentNode !== document.body) {
    menu.__npOrigParent = menu.parentNode; menu.__npOrigNext = menu.nextSibling;
    document.body.appendChild(menu);
  }
  menu.classList.add('is-open');
  positionOverflowMenu(btn, menu);
}
document.addEventListener('click', (e) => {
  if (e.target.closest('.np-overflow') || e.target.closest('.np-overflow-menu')) return;
  closeOverflowMenus();
});
window.addEventListener('resize', () => closeOverflowMenus());
window.addEventListener('scroll', () => closeOverflowMenus(), true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOverflowMenus(); });
// Dashboard welcome header: time-of-day greeting + live date/clock. Purely
// presentational; never throws.
let __dashClockTimer = null;
function startDashClock(){
  const greetEl = document.getElementById('dashGreeting');
  const dateEl  = document.getElementById('dashWelcomeDate');
  const timeEl  = document.getElementById('dashWelcomeTime');
  if (!dateEl && !timeEl && !greetEl) return;
  function tick(){
    const now = new Date();
    const h = now.getHours();
    const greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    if (greetEl) greetEl.textContent = greet;
    if (dateEl) dateEl.textContent = now.toLocaleDateString('en-IN', { weekday:'short', day:'2-digit', month:'short', year:'numeric' });
    if (timeEl) timeEl.textContent = now.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' });
  }
  tick();
  if (__dashClockTimer) clearInterval(__dashClockTimer);
  __dashClockTimer = setInterval(tick, 30000);
}
function statusBadge(s){ const m={CONFIRMED:'np-badge--green',PENDING:'np-badge--amber',COMPLETED:'np-badge--blue',CANCELLED:'np-badge--red'}; return `<span class="np-badge ${m[s]||'np-badge--slate'}"><span class="np-badge__dot"></span>${esc(s||'—')}</span>`; }
function sourceBadge(s){
  // Distinguishes how the appointment was booked — NeoKidsPro's own website
  // vs. reception handling it directly (by phone call or in person at the
  // desk) — since those are operationally different (a reception-made
  // booking may still need confirmation/desk handling; a website booking
  // came in on its own, and if paid online, is already invoiced too).
  if (s==='WALK_IN' || s==='CLINIC_RECEPTION') return `<span class="np-badge np-badge--amber" title="Booked in person at the clinic front desk"><span class="np-badge__dot"></span>Reception · Walk-in</span>`;
  if (s==='PHONE') return `<span class="np-badge np-badge--blue" title="Booked over a phone call to reception"><span class="np-badge__dot"></span>Reception · Phone</span>`;
  if (s==='OTHER') return `<span class="np-badge np-badge--slate" title="Booked via another channel"><span class="np-badge__dot"></span>Other</span>`;
  if (s==='NEOKIDSPRO') return `<span class="np-badge np-badge--mint" title="Booked online by the patient on the NeoKidsPro website"><span class="np-badge__dot"></span>NeoKidsPro Website</span>`;
  if (s==='MANUAL') return `<span class="np-badge np-badge--violet" title="Added manually by clinic staff (historical record)"><span class="np-badge__dot"></span>Manual Record</span>`;
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
  if(a.consultationInvoice){
    btns.push(`<button class="np-btn np-btn--sm np-btn--ghost" onclick="openInvoiceActions('${a.consultationInvoice.id}','${esc(a.consultationInvoice.pdfUrl||'')}','${a.patient.phone||''}','${esc(a.patient.email||'')}')">Invoice</button>`);
  } else if(a.invoiceUrl){
    // Booked & paid online — already invoiced automatically at booking, no
    // reception invoice needed. View-only, no Send (it was already sent).
    btns.push(`<button class="np-btn np-btn--sm np-btn--ghost" onclick="window.open('${esc(a.invoiceUrl)}','_blank')" title="Paid and invoiced online at booking">Invoiced online</button>`);
  } else if(a.cashfreeOrderId){
    // BUG FIX: payment succeeded online (cashfreeOrderId is set the moment
    // Cashfree confirms the charge) but the automated invoice PDF/WhatsApp/
    // email step failed silently on the backend, so invoiceUrl never got
    // set. Without this branch that read as "unbilled", and reception saw
    // the ordinary Invoice button — letting them generate and Send a
    // second, redundant invoice for money the patient already paid and
    // was already sent a receipt for (or should have been). Never offer
    // Send here; only a disabled state until the PDF actually exists.
    btns.push(`<button class="np-btn np-btn--sm np-btn--ghost" disabled title="Paid online — invoice PDF is still being generated, check back shortly">Paid online</button>`);
  } else if(a.status!=='CANCELLED'){
    btns.push(`<button class="np-btn np-btn--sm" onclick="genInvoice('${a.id}','${a.patient.phone||''}','${esc(a.patient.email||'')}')">Invoice</button>`);
  }
  if(__me.canIssueCertificates && a.status!=='CANCELLED'){
    btns.push(`<button class="np-btn np-btn--sm np-btn--ghost" onclick="openCertModal('${a.id}')">Certificate</button>`);
  }
  if(a.paymentStatus==='CASH_PENDING' && a.status!=='CANCELLED'){
    btns.push(`<button class="np-btn np-btn--sm np-btn--primary" onclick="markAppointmentPaid('${a.id}')">Mark as paid</button>`);
  }
  return btns.join(' ');
}

// Card layout for the full Appointments tab — matches the doctor portal's
// .np-appt card (see appt-card.css): time block + name/badges/meta on the
// left, a couple of primary buttons plus an overflow ("…") menu for
// secondary actions on the right, instead of a dense table row.
function apptCard(a){
  const p = a.patient || {};
  const open = a.status!=='CANCELLED' && a.status!=='COMPLETED';

  const overflowItems = [];
  if(open){
    overflowItems.push(`<button class="np-overflow-item" type="button" onclick="event.stopPropagation();resched('${a.id}')">
      <svg class="np-overflow-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
      Reschedule
    </button>`);
    overflowItems.push(`<button class="np-overflow-item is-danger" type="button" onclick="event.stopPropagation();cancelAppt('${a.id}')">
      <svg class="np-overflow-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
      Cancel
    </button>`);
  }
  if(__me.canIssueCertificates && a.status!=='CANCELLED'){
    overflowItems.push(`<button class="np-overflow-item" type="button" onclick="event.stopPropagation();closeOverflowMenus();openCertModal('${a.id}')">
      <svg class="np-overflow-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M12 11v6M9 14h6"/></svg>
      Medical certificate
    </button>`);
  }
  const overflow = overflowItems.length ? `
    <div class="np-overflow">
      <button type="button" class="np-overflow-trigger" aria-label="More actions" onclick="event.stopPropagation();toggleOverflow(this)">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>
      </button>
      <div class="np-overflow-menu">${overflowItems.join('')}</div>
    </div>` : '';

  // Primary, always-visible buttons — the ones reception reaches for most:
  // arriving a patient, collecting/viewing payment, marking paid.
  const primary = [];
  if(!a.arrivedAt && open) primary.push(`<button class="np-btn np-btn--primary np-btn--sm" type="button" onclick="markArrived('${a.id}')">Mark arrived</button>`);
  if(a.consultationInvoice){
    primary.push(`<button class="np-btn np-btn--ghost np-btn--sm" type="button" onclick="openInvoiceActions('${a.consultationInvoice.id}','${esc(a.consultationInvoice.pdfUrl||'')}','${p.phone||''}','${esc(p.email||'')}')">Invoice</button>`);
  } else if(a.invoiceUrl){
    primary.push(`<button class="np-btn np-btn--ghost np-btn--sm" type="button" onclick="window.open('${esc(a.invoiceUrl)}','_blank')" title="Paid and invoiced online at booking — already sent to the patient">Invoiced online</button>`);
  } else if(a.cashfreeOrderId){
    // See apptActionsHtml above for why this branch exists.
    primary.push(`<button class="np-btn np-btn--ghost np-btn--sm" type="button" disabled title="Paid online — invoice PDF is still being generated, check back shortly">Paid online</button>`);
  } else if(a.status!=='CANCELLED'){
    primary.push(`<button class="np-btn np-btn--ghost np-btn--sm" type="button" onclick="genInvoice('${a.id}','${p.phone||''}','${esc(p.email||'')}')">Invoice</button>`);
  }
  if(a.paymentStatus==='CASH_PENDING' && a.status!=='CANCELLED'){
    primary.push(`<button class="np-btn np-btn--primary np-btn--sm" type="button" onclick="markAppointmentPaid('${a.id}')">Mark as paid</button>`);
  }

  return `
  <article class="np-appt" data-id="${esc(a.id)}">
    <div class="np-appt__time">
      <div class="np-appt__time-h">${esc(fmtTime(a.startTime))}</div>
      <div class="np-appt__time-d">${esc(fmtDate(a.date))}</div>
    </div>
    <div class="np-appt__body">
      <div class="np-appt__namerow">
        <span class="np-appt__name">${esc(p.name||'Patient')}</span>
        ${p.dateOfBirth ? `<span class="np-appt__age" title="DOB: ${esc(fmtDate(p.dateOfBirth))}">${esc(calcAge(p.dateOfBirth))}</span>` : ''}
        ${a.arrivedAt ? '<span class="np-badge np-badge--green"><span class="np-badge__dot"></span>Arrived</span>' : ''}
      </div>
      <div class="np-appt__badges">
        ${statusBadge(a.status)}
        ${payBadge(a.paymentStatus)}
        ${sourceBadge(a.source)}
      </div>
      <div class="np-appt__meta">
        <span>Dr. ${esc(a.doctor.name)}</span>
        ${p.phone ? `<span>📞 ${esc(p.phone)}</span>` : ''}
        ${a.feeAtBooking!=null ? `<span>${inr(a.feeAtBooking)}</span>` : ''}
      </div>
      ${a.primaryProblem ? `<div class="np-appt__problem">${esc(a.primaryProblem)}</div>` : ''}
      ${a.status==='CANCELLED' && a.notes ? `<div class="np-appt__cancel-reason"><b>Cancelled:</b> ${esc(a.notes)}</div>` : ''}
    </div>
    <div class="np-appt__actions">
      ${primary.join('')}
      ${overflow}
    </div>
  </article>`;
}

async function markAppointmentPaid(id){
  const ok = await NPModal.confirm({
    title: 'Mark cash collected?',
    message: 'Confirms this appointment’s consultation fee was received in cash at the clinic.',
    okText: 'Mark as paid',
  });
  if(!ok) return;
  try{ await api('/receptionist/appointments/'+id+'/mark-paid',{method:'POST',body:'{}'}); toast('Marked as paid'); loadDashboard(); loadAppointments(); }
  catch(e){ toast(e.message,'error'); }
}

// Single "Actions" entry point for an invoice row — replaces the old
// PDF/Print/Send buttons crammed side by side, which especially broke down
// on the mobile stacked-card layout. Send re-uses openInvoiceSendModal.
function openInvoiceActions(invoiceId, pdfUrl, phone, email){
  const hasPdf = !!pdfUrl;
  // BUG FIX ("nothing happens on clicking Send"): when a patient record has
  // no phone AND no email on file, the old flow closed THIS modal first
  // (closeModal() ran before openInvoiceSendModal) and only then discovered
  // there was nothing to send, surfacing a single toast after the modal had
  // already vanished — easy to read as "I clicked Send and nothing
  // happened" on a quick glance or on mobile. Checked up front instead, so
  // the Send button is visibly disabled with an explanatory title, same
  // pattern as the PDF-not-ready state below.
  const hasContact = !!(phone || email);
  $('#modalHost').innerHTML=`<div class="np-modal"><div class="np-modal__panel"><header class="np-modal__head"><div class="np-modal__title">Invoice actions</div><button class="np-modal__close" onclick="closeModal()">×</button></header><div class="np-modal__body">
    <div class="np-action-list">
      <button type="button" class="np-btn np-btn--block" ${hasPdf?'':'disabled'} onclick="window.open('${esc(pdfUrl)}','_blank')">View</button>
      <a class="np-btn np-btn--block ${hasPdf?'':'np-btn--disabled'}" ${hasPdf?`href="${esc(pdfUrl)}" download`:'aria-disabled="true"'}>Download</a>
      <button type="button" class="np-btn np-btn--block" ${hasPdf?'':'disabled'} onclick="printPdf('${esc(pdfUrl)}')">Print</button>
      <button type="button" class="np-btn np-btn--block np-btn--primary" ${hasContact?'':'disabled'} title="${hasContact?'':'Patient has no phone or email on file — add one before sending'}" onclick="closeModal();openInvoiceSendModal('${invoiceId}','${esc(phone)}','${esc(email)}')">Send</button>
    </div>
    ${hasPdf?'':'<p style="margin:.75rem 0 0;font-size:.8rem;color:var(--np-muted)">PDF isn\'t ready yet — View, Download and Print will be available once it\'s generated.</p>'}
    ${hasContact?'':'<p style="margin:.5rem 0 0;font-size:.8rem;color:var(--np-warn,#B45309)">This patient has no phone or email on file, so there\'s nothing to send to — add contact details on their patient record first.</p>'}
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
  </div>
  <div class="np-modal__foot"><button type="button" class="np-btn" onclick="closeModal()">Cancel</button><button type="button" class="np-btn np-btn--primary" id="sendInvoiceConfirm">Send</button></div>
  </div></div>`;
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

const VIEWS = { dashView:['Dashboard','Today at your clinic'], onboardingView:['Getting Started','A quick tour of the reception portal'], apptsView:['Appointments','Bookings for your doctors'], patientsView:['Patients','Search & register'], invoicesView:['Consultation Invoices','Reception billing'], billingView:['Billing','Consultation · medicines · services · other'], certsView:['Certificates','Issued in the doctor name'], rxView:['Prescriptions','Offline prescriptions'], pharmBillsView:['Pharmacy Bills','Medicine sales'], settingsView:['Settings','Account'] };
function setView(v, opts){ $$('.tab-pane').forEach(x=>x.classList.add('hidden')); const el=document.getElementById(v); if(el)el.classList.remove('hidden'); $$('.np-nav-item').forEach(n=>n.classList.toggle('active', n.dataset.view===v)); const m=VIEWS[v]; if(m){$('#pageTitle').textContent=m[0];$('#pageSubtitle').textContent=m[1];}
  // Keep the URL hash in sync so the view is deep-linkable and survives a
  // refresh — the same strategy the admin panel uses (#dash, #appts, …).
  try{ if(!(opts&&opts.skipHash)){ const slug=v.replace(/View$/,''); if(location.hash!=='#'+slug) history.replaceState(null,'','#'+slug); } }catch(_){}
  if(v==='dashView'){loadDashboard();loadClinicRevenue();} if(v==='onboardingView'&&typeof NPOnboarding!=='undefined')NPOnboarding.mount($('#onboardingMount'),'RECEPTIONIST',__me); if(v==='apptsView')loadAppointments(); if(v==='patientsView')loadPatients(); if(v==='invoicesView')loadInvoices(); if(v==='billingView')loadBilling(); if(v==='certsView')loadCerts(); if(v==='rxView')loadRx(); if(v==='pharmBillsView')loadPharmBills(); }
function viewFromHash(){ const h=(location.hash||'').replace(/^#/,'').trim(); if(!h) return null; const v=h.endsWith('View')?h:h+'View'; return VIEWS[v]?v:null; }
window.addEventListener('hashchange', ()=>{ const v=viewFromHash(); if(v) setView(v,{skipHash:true}); });
$$('.np-nav-item').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));

// Drill-down from the revenue sparkline — jump to Appointments filtered to
// exactly the day that was clicked, instead of a dead-end hover tooltip.
function goToAppointmentsForDate(dateStr){
  // Filter by when the money was actually collected (billedDate), not by
  // appointment date — see loadAppointments(). The date input still shows
  // the tapped day for context, but is ignored while __billedDateFilter is set.
  const d = $('#fDate'); if (d) d.value = dateStr;
  const q = $('#fQ'); if (q) q.value = '';
  // BUG FIX (Doctor Analytics Audit): a leftover doctor/status filter from
  // earlier browsing used to stay active across this jump, so the list you
  // landed on could silently exclude appointments the dashboard figure had
  // included — the exact "widget says one number, the list shows a
  // different one" symptom. The dashboard's daily figures are never
  // scoped to a single doctor or status, so the drill-down must start
  // from the same unfiltered view or the two will never agree.
  const doc = $('#fDoctor'); if (doc) doc.value = '';
  const st  = $('#fStatus'); if (st) st.value = '';
  __billedDateFilter = dateStr;
  setView('apptsView');
  loadAppointments();
}

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
function togglePasswordVisibility(btn){
  if(!btn) return;
  const input=document.getElementById(btn.getAttribute('data-target'));
  if(!input) return;
  const showIcon=btn.querySelector('.np-password-toggle__icon--show');
  const hideIcon=btn.querySelector('.np-password-toggle__icon--hide');
  const isHidden=input.type==='password';
  input.type=isHidden?'text':'password';
  btn.setAttribute('aria-pressed', isHidden?'true':'false');
  btn.setAttribute('aria-label', isHidden?'Hide password':'Show password');
  if(showIcon) showIcon.style.display=isHidden?'none':'';
  if(hideIcon) hideIcon.style.display=isHidden?'':'none';
}
async function forgotPassword(){
  const email=await NPModal.prompt({
    title:'Forgot password',
    message:'Enter the email address associated with your receptionist account. If it matches, we\u2019ll send you a reset link.',
    placeholder:'you@neokidspro.in',
    inputType:'email',
    defaultValue:($('#email').value||'').trim(),
    okText:'Send reset link',
  });
  if(!email||!email.trim()) return;
  try{
    const res=await api('/auth/forgot-password',{method:'POST',body:JSON.stringify({email:email.trim()})});
    if(res && res.previewUrl){
      await NPModal.alert({ title:'Reset link generated (mock mode)', message:res.previewUrl, okText:'Copy & close' });
      try{ await navigator.clipboard.writeText(res.previewUrl); toast('Reset link copied to clipboard'); }catch(_){ }
    } else {
      toast('If the account exists, a reset link has been sent.');
    }
  }catch(err){ toast(err.message,'error'); }
}
function logout(){ localStorage.removeItem('np_reception_token'); TOKEN=null; showLogin(); }
function showLogin(){ $('#dashboard').classList.add('hidden'); $('#loginScreen').classList.remove('hidden'); }

async function showDashboard(){
  $('#loginScreen').classList.add('hidden'); $('#dashboard').classList.remove('hidden');
  setupSidebar();
  setupProfileMenu();
  if (typeof NPNotifications !== 'undefined') {
    NPNotifications.mount($('#notifMount'), api, { basePath: '/receptionist' });
  }
  try{
    const meRes = await api('/auth/me'); __me = meRes.user || meRes;
    const __initials = __me.name.split(/\s+/).map(s=>s[0]).slice(0,2).join('').toUpperCase();
    $('#userName').textContent = __me.name; $('#userInitials').textContent = __initials;
    setTopBarAvatar(__me.photoUrl || null);
    setOwnPhotoPreview(__me.photoUrl || null);
    const __first = (__me.name || '').split(/\s+/)[0] || __me.name;
    if ($('#dashWelcomeName')) $('#dashWelcomeName').textContent = 'Welcome back, ' + __first + ' 👋';
    startDashClock();
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
    // Surface which clinic(s) the revenue/appointment figures below belong
    // to — the dashboard numbers are clinic-wide for these assignments,
    // not just this receptionist's own till, so naming the clinic here
    // avoids ambiguity about whose numbers are being shown.
    const clinicNames = [...new Set(asn.map(a=>a.medicalCentre && a.medicalCentre.name).filter(Boolean))];
    const clinicEl = $('#dashClinicName');
    if (clinicEl && clinicNames.length) {
      clinicEl.style.display = '';
      clinicEl.textContent = clinicNames.length === 1
        ? clinicNames[0] + ' — clinic-wide figures below'
        : clinicNames.join(' · ') + ' — clinic-wide figures below';
    }
  }catch(e){ if(e.message!=='Session expired') toast(e.message,'error'); }
  const __restore = viewFromHash();
  setView(__restore || 'dashView', __restore ? { skipHash: true } : undefined);
}

// Shared with Admin (app.js + finance.js), Doctor and Pharmacy — see
// NPFmt.trendChip in /assets/np-ui.js (single source of truth).
const trendChip = NPFmt.trendChip;

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function populateRevenuePeriodSelects(){
  const mSel = $('#revMonth'), ySel = $('#revYear');
  if (!mSel || !ySel) return;
  const now = new Date();
  if (!mSel.options.length){
    MONTH_NAMES.forEach((nm, idx) => {
      const o = document.createElement('option');
      o.value = String(idx + 1); o.textContent = nm;
      if (idx + 1 === now.getUTCMonth() + 1) o.selected = true;
      mSel.appendChild(o);
    });
    mSel.addEventListener('change', loadClinicRevenue);
  }
  if (!ySel.options.length){
    const curYear = now.getUTCFullYear();
    for (let y = curYear; y >= curYear - 4; y--){
      const o = document.createElement('option');
      o.value = String(y); o.textContent = String(y);
      if (y === curYear) o.selected = true;
      ySel.appendChild(o);
    }
    ySel.addEventListener('change', loadClinicRevenue);
  }
}

// Single KPI card markup, matching the same .np-kpi component the Admin
// Finance tab uses (see admin/finance.js `kpi()`) — one shared visual
// language for "a number in a card" across every EMR dashboard instead of
// bespoke inline-styled rows per portal.
function revKpiCard(label, big, sub, kind){
  return `<div class="np-kpi np-kpi--${kind||'blue'}">
    <div class="np-kpi__label">${esc(label)}</div>
    <div class="np-kpi__value">${esc(big)}</div>
    ${sub ? `<div class="np-kpi__sub">${esc(sub)}</div>` : ''}
  </div>`;
}

// In-person clinic revenue for the selected month — pulled from
// /receptionist/revenue, which calls the exact same
// revenue.service.getCashCollectedTotal() function a doctor's own
// Earnings page calls for themselves (just widened across every doctor
// assigned to this receptionist), reading only its in-person figures.
// Same function + same filters means this can never drift from what each
// doctor individually sees for their own in-person visits.
//
// SCOPE FIX (Platform-Wide Analytics Audit): this panel used to also
// render an "Online" split, pulled in via getOverallClinicRevenue() on
// the backend. Reception only manages in-person appointments and clinic
// cash — a teleconsultation and its payment are never a reception
// workflow step — so online revenue has no place in this panel. The
// endpoint now returns in-person cash only, and for the same reason
// "Total Revenue" / "In-Person Revenue" / "Cash Collected" are literally
// the same figure in this scope — shown as ONE headline card below,
// rather than three cards repeating the same number.
//
// UI FIX (Reception Analytics Audit): the old table-based "by doctor"
// breakdown (plus two bare inline-styled numbers above it) was the
// source of the reported overlapping/colliding text, especially on
// narrow screens. Replaced with the same .np-kpi-grid / .np-kpi card
// components the Admin, Doctor and Finance dashboards already use —
// those already carry the correct spacing, typography and responsive
// (auto-fit, stacks to 1-column) behavior, so this panel now matches the
// rest of the EMR and can't independently regress into a broken layout.
async function loadClinicRevenue(){
  populateRevenuePeriodSelects();
  const year = $('#revYear') ? $('#revYear').value : undefined;
  const month = $('#revMonth') ? $('#revMonth').value : undefined;
  const q = new URLSearchParams();
  if (year) q.set('year', year);
  if (month) q.set('month', month);
  try{
    const r = await api('/receptionist/revenue?' + q.toString());
    const consultations = r.consultations || 0;
    const pending = r.pendingCollection || { amount: 0, count: 0 };
    $('#revKpiGrid').innerHTML = [
      revKpiCard('Total Revenue', inr(r.totalRevenue || 0), `${consultations} consultation${consultations===1?'':'s'} · in-person cash`, 'blue'),
      revKpiCard('Total Consultations', String(consultations), 'In-person visits this period', 'mint'),
      revKpiCard('Pending Collections', inr(pending.amount || 0), pending.count ? `${pending.count} invoice${pending.count===1?'':'s'} awaiting payment` : 'Nothing outstanding', pending.count ? 'amber' : 'green')
    ].join('');
    const rows = Array.isArray(r.byDoctor) ? r.byDoctor : [];
    $('#revByDoctorLabel').style.display = rows.length ? '' : 'none';
    $('#revByDoctorGrid').innerHTML = rows.length ? rows.map(d =>
      revKpiCard('Dr. ' + (d.doctorName||''), inr(d.totalRevenue || 0), `${d.consultations || 0} consultation${(d.consultations||0)===1?'':'s'}`, 'cream')
    ).join('') : `<div class="np-empty"><div class="np-empty__title">No in-person revenue collected this period</div></div>`;
  }catch(e){ toast(e.message,'error'); }
}

async function loadDashboard(){
  try{
    const s = await api('/receptionist/stats');
    const trend = s.trend || {};
    const thisWeek = trend.thisWeek || { appointments: 0, collected: 0 };
    const prevWeek = trend.prevWeek || { appointments: 0, collected: 0 };
    const daily = Array.isArray(trend.daily) ? trend.daily : [];
    const vsYesterday = Number((trend.today && trend.today.vsYesterday) || 0);

    setHtml('trendToday', trendChip(vsYesterday, 'vs yesterday'));
    setText('statToday', s.todayAppointments || 0);
    setHtml('statTodayBreakdown',
      `<span class="np-dot-item"><span class="np-dot np-dot--mint"></span>${s.bookedToday||0} booked</span>` +
      `<span class="np-dot-item"><span class="np-dot np-dot--blue"></span>${s.walkinToday||0} walk-in</span>` +
      `<span class="np-dot-item"><span class="np-dot np-dot--amber"></span>${s.pendingToday||0} awaiting arrival</span>`);
    setText('statTodayFoot', `${s.arrivedToday||0} checked in today · ${s.patientsTotal||0} patients in your scope`);

    const weekDelta = prevWeek.collected > 0
      ? Math.round(((thisWeek.collected - prevWeek.collected) / prevWeek.collected) * 100)
      : (thisWeek.collected > 0 ? 100 : 0);
    setHtml('trendWeek', trendChip(weekDelta, 'vs last week', true));
    setText('statWeekCollected', inr(thisWeek.collected));

    const maxDaily = Math.max(1, ...daily.map(d => Number(d.collected) || 0));
    setHtml('statSparkline', daily.map(d => {
      const h = Math.max(3, Math.round(((Number(d.collected) || 0) / maxDaily) * 32));
      const label = new Date(d.date + 'T00:00:00Z').toLocaleDateString(undefined, { weekday: 'short' });
      return `<div class="np-sparkline__bar" style="height:${h}px" tabindex="0"
        data-tt-title="${esc(label)}" data-tt-value="${esc(inr(d.collected))}"
        data-tt-link="View appointments →" data-tt-onclick="goToAppointmentsForDate('${d.date}')"></div>`;
    }).join(''));
    if (window.NPSparkTooltip) NPSparkTooltip.bind($('#statSparkline'));
    setHtml('statTodaySplit',
      `<span class="np-dot-item"><span class="np-dot np-dot--mint"></span>${inr(s.cashCollectedToday||0)} cash today</span>` +
      `<span class="np-dot-item"><span class="np-dot np-dot--blue"></span>${inr(s.onlineCollectedToday||0)} online today</span>` +
      (s.pendingCollectionToday > 0 ? `<span class="np-dot-item"><span class="np-dot np-dot--amber"></span>${inr(s.pendingCollectionToday)} pending</span>` : ''));

    const rows = await api('/receptionist/appointments?date='+todayIso());
    // Own cache, separate from __appts (the full Appointments-view list) — the
    // two views load independently and must not clobber each other's data
    // out from under an in-flight action (same bug class as __bills vs
    // __pharmBills for the billing tables).
    __todayAppts = rows;
    $('#todayList').innerHTML = rows.length ? rows.map(a=>`
      <div class="np-appt-row"><div class="np-appt-row__time"><div class="np-appt-row__time-h">${esc(fmtTime(a.startTime))}</div><div class="np-appt-row__time-d">${esc(fmtDate(a.date))}</div></div>
      <div class="np-appt-row__body"><div class="np-appt-row__name">${esc(a.patient.name)} ${a.arrivedAt?'<span class="np-badge np-badge--green"><span class="np-badge__dot"></span>Arrived</span>':''}</div><div class="np-appt-row__assign">Dr. ${esc(a.doctor.name)}</div><div class="np-appt-row__meta">${esc(a.primaryProblem||'')}</div></div>
      <div class="np-appt-row__right">${statusBadge(a.status)} ${sourceBadge(a.source)}
        ${apptActionsHtml(a)}
      </div></div>`).join('') : '<div class="np-empty"><div class="np-empty__title">No appointments today</div></div>';
  }catch(e){ setHtml('dashAnalytics', `<div class="np-error">${esc(e.message)}</div>`); }
}

let __billedDateFilter = null;
async function loadAppointments(){
  const list=$('#apptsList'); list.innerHTML='<div style="text-align:center;padding:1.4rem" class="np-mut">Loading…</div>';
  const qs=new URLSearchParams();
  if(__billedDateFilter){ qs.set('billedDate',__billedDateFilter); }
  else if($('#fDate').value){ qs.set('date',$('#fDate').value); }
  if($('#fDoctor').value)qs.set('doctorId',$('#fDoctor').value); if($('#fStatus').value)qs.set('status',$('#fStatus').value); if($('#fQ').value.trim().length>=2)qs.set('q',$('#fQ').value.trim());
  setHtml('apptsBilledNote', __billedDateFilter ? `<div style="margin-bottom:.6rem;padding:.6rem .8rem;border-radius:10px;background:var(--nk-teal-50,#EFF8F8);border:1px solid var(--nk-teal-200,#BFE3E3);font-size:.82rem;color:var(--nk-text);display:flex;align-items:center;gap:.6rem;flex-wrap:wrap">
    <span>Showing visits billed on <b>${esc(fmtDate(__billedDateFilter))}</b> — matches the amount on the dashboard, not the appointment's scheduled date.</span>
    <button type="button" class="np-btn np-btn--sm np-btn--ghost" onclick="clearBilledDateFilter()">Clear</button>
  </div>` : '');
  try{ const rows=await api('/receptionist/appointments?'+(qs.toString()||'')); __appts=rows;
    list.innerHTML = rows.length ? '<div class="np-appt-list">'+rows.map(apptCard).join('')+'</div>' : '<div class="np-empty"><div class="np-empty__title">No appointments match</div></div>';
  }catch(e){ list.innerHTML=`<div class="np-error">${esc(e.message)}</div>`; }
}
function clearBilledDateFilter(){ __billedDateFilter = null; loadAppointments(); }
$('#apptFilters').addEventListener('submit',e=>{e.preventDefault();__billedDateFilter=null;loadAppointments();});

async function markArrived(id){ try{ await api('/receptionist/appointments/'+id+'/arrive',{method:'POST',body:'{}'}); toast('Patient marked arrived'); loadDashboard(); }catch(e){toast(e.message,'error');} }
function resched(id){
  const appt=__appts.find(a=>a.id===id) || __todayAppts.find(a=>a.id===id);
  const docId=appt&&appt.doctor?appt.doctor.id:'';
  const curDate=appt?String(appt.date).slice(0,10):todayIso();
  $('#modalHost').innerHTML=`<div class="np-modal"><div class="np-modal__panel"><header class="np-modal__head"><div class="np-modal__title">Reschedule appointment</div><button class="np-modal__close" onclick="closeModal()">×</button></header><div class="np-modal__body"><form id="reschedForm">
  <div class="np-field"><label class="np-field__label">New date *</label><input name="date" type="date" required class="np-input" value="${curDate}" min="${todayIso()}"/></div>
  <div class="np-field"><label class="np-field__label">Available slot *</label><select name="startTime" required class="np-select" id="reschedSlotSel"><option value="">Loading…</option></select></div>
  <div class="np-field"><label class="np-field__label">Reason *</label><textarea name="reason" required minlength="3" class="np-textarea" placeholder="Min 3 characters"></textarea></div>
  </form></div>
  <div class="np-modal__foot"><button type="button" class="np-btn" onclick="closeModal()">Cancel</button><button class="np-btn np-btn--primary" type="submit" form="reschedForm">Reschedule</button></div>
  </div></div>`;
  const f=$('#reschedForm');
  // Guarded against out-of-order responses: changing the date fires a new
  // fetch before the previous one resolves, and network timing gives no
  // guarantee the earlier request's response won't land last and overwrite
  // the slot list with stale data for a date that's no longer selected.
  let __reschedSlotReq=0;
  async function refreshReschedSlots(){ const date=f.date.value; const myReq=++__reschedSlotReq; if(!date||!docId){ $('#reschedSlotSel').innerHTML='<option value="">No slots</option>'; return; } try{ const r=await api(`/receptionist/slots?doctorId=${docId}&date=${date}&type=OFFLINE`); if(myReq!==__reschedSlotReq)return; $('#reschedSlotSel').innerHTML=(r.slots||[]).filter(s=>s.available).map(s=>`<option value="${s.startTime}">${fmtTime(s.startTime)}</option>`).join('')||'<option value="">No slots available</option>'; }catch(e){ if(myReq!==__reschedSlotReq)return; $('#reschedSlotSel').innerHTML='<option value="">No slots</option>'; } }
  f.date.addEventListener('change',refreshReschedSlots); refreshReschedSlots();
  f.addEventListener('submit',async e=>{e.preventDefault(); const raw=Object.fromEntries(new FormData(f).entries()); if(!raw.reason||raw.reason.trim().length<3){toast('Reason required (min 3 chars)','error');return;} try{ await api('/receptionist/appointments/'+id+'/reschedule',{method:'POST',body:JSON.stringify({date:raw.date,startTime:raw.startTime,reason:raw.reason})}); toast('Rescheduled'); closeModal(); loadAppointments(); loadDashboard(); }catch(err){toast(err.message,'error');} });
}
function cancelAppt(id){
  $('#modalHost').innerHTML=`<div class="np-modal"><div class="np-modal__panel"><header class="np-modal__head"><div class="np-modal__title">Cancel appointment</div><button class="np-modal__close" onclick="closeModal()">×</button></header><div class="np-modal__body"><form id="cancelForm">
  <div class="np-field"><label class="np-field__label">Cancellation reason *</label><textarea name="reason" required minlength="3" class="np-textarea" placeholder="Min 3 characters"></textarea></div>
  </form></div>
  <div class="np-modal__foot"><button type="button" class="np-btn" onclick="closeModal()">Back</button><button class="np-btn np-btn--primary" type="submit" form="cancelForm">Confirm cancellation</button></div>
  </div></div>`;
  $('#cancelForm').addEventListener('submit',async e=>{e.preventDefault(); const raw=Object.fromEntries(new FormData(e.target).entries()); if(!raw.reason||raw.reason.trim().length<3){toast('Reason required (min 3 chars)','error');return;} try{ await api('/receptionist/appointments/'+id+'/cancel',{method:'POST',body:JSON.stringify({reason:raw.reason})}); toast('Cancelled'); closeModal(); loadAppointments(); loadDashboard(); }catch(err){toast(err.message,'error');} });
}
// BUG FIX ("clicking Invoice does nothing"): this used to just toast
// "Invoice generated" and leave it there — reception had to notice the
// card had re-rendered and click "Invoice" a *second* time to reach the
// Send options. Now it goes straight into the same View/Download/Print/
// Send actions modal the second click used to require, in one action.
async function genInvoice(id, phone, email){
  try{
    const r = await api('/receptionist/appointments/'+id+'/invoice',{method:'POST',body:JSON.stringify({})});
    refreshAfterMutation(['apptsView','dashView','invoicesView']);
    if(r.existing) toast('Invoice already exists');
    const pdfUrl = r.pdfUrl || (r.invoice && r.invoice.pdfUrl) || '';
    if(r.invoice && r.invoice.id) openInvoiceActions(r.invoice.id, pdfUrl, phone||'', email||'');
  }catch(e){ toast(e.message,'error'); }
}

// Patients
let __patientQuery='';
// Request token: a slower in-flight search can otherwise resolve after a
// newer one and repaint the list with results for a query the user has
// since changed or cleared — stale/duplicate-looking results in the list.
let __patientReq=0;
async function loadPatients(q){ __patientQuery=q||''; const myReq=++__patientReq; const list=$('#patientsList'); try{ const rows=await api('/receptionist/patients'+(q?('?q='+encodeURIComponent(q)):'')); if(myReq!==__patientReq)return; list.innerHTML=rows.length?rows.map(p=>`<div class="np-appt-row"><div class="np-appt-row__body"><div class="np-appt-row__name">${esc(p.name)}</div><div class="np-appt-row__meta">+91 ${esc(p.phone||'')}${p.parentName?' · Guardian: '+esc(p.parentName):''}</div></div><div class="np-appt-row__right"><button class="np-btn np-btn--sm" onclick="openBookModal(null,'${p.id}')">Book</button></div></div>`).join(''):'<div class="np-empty"><div class="np-empty__sub">Type a name or phone to search, or register a new patient.</div></div>'; }catch(e){ if(myReq!==__patientReq)return; list.innerHTML=`<div class="np-error">${esc(e.message)}</div>`; } }
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
  </form></div>
  <div class="np-modal__foot"><button type="button" class="np-btn" onclick="closeModal()">Cancel</button><button class="np-btn np-btn--primary" type="submit" form="pForm">Register</button></div>
  </div></div>`;
  $('#pForm').addEventListener('submit',async e=>{e.preventDefault(); const f=e.target; const raw=Object.fromEntries(new FormData(f).entries()); try{ const p=await api('/receptionist/patients',{method:'POST',body:JSON.stringify(raw)}); toast('Patient registered'); closeModal(); loadPatients(__patientQuery); }catch(err){toast(err.message,'error');}});
}

function closeModal(){ $('#modalHost').innerHTML=''; }

// After any create/edit/delete/status-change, refresh the affected lists so
// the newest data appears without a manual browser refresh. Only the views
// passed in are reloaded, and the patients list keeps its active search term.
function refreshAfterMutation(views){
  const set = new Set(views || []);
  if (set.has('dashView')) { loadDashboard(); loadClinicRevenue(); }
  if (set.has('apptsView')) loadAppointments();
  if (set.has('patientsView')) loadPatients(__patientQuery);
  if (set.has('invoicesView')) loadInvoices();
  if (set.has('billingView')) loadBilling();
  if (set.has('certsView')) loadCerts();
  if (set.has('rxView')) loadRx();
  if (set.has('pharmBillsView')) loadPharmBills();
}

// Booking
async function openBookModal(_, patientId){
  const docOpts=__assignments.map(a=>`<option value="${a.doctor.id}|${a.medicalCentre.id}">Dr. ${esc(a.doctor.name)} — ${esc(a.medicalCentre.name)}</option>`).join('');
  $('#modalHost').innerHTML=`<div class="np-modal"><div class="np-modal__panel"><header class="np-modal__head"><div class="np-modal__title">Book appointment / walk-in</div><button class="np-modal__close" onclick="closeModal()">×</button></header><div class="np-modal__body"><form id="bForm"><div class="np-grid-2">
  <div class="np-field" style="grid-column:span 2"><label class="np-field__label">Doctor & clinic *</label><select name="docCentre" required class="np-select">${docOpts}</select></div>
  <div class="np-field" style="grid-column:span 2"><label class="np-field__label">Date *</label><input name="date" type="date" required class="np-input" value="${todayIso()}" min="${todayIso()}"/></div>
  <div class="np-field" style="grid-column:span 2"><label class="np-field__label">Available slot *</label><select name="startTime" required class="np-select" id="slotSel"><option value="">Pick doctor+date first</option></select></div>
  <div class="np-divider" style="grid-column:span 2"></div>
  <div class="np-field" style="grid-column:span 2"><label class="np-field__label">Patient *</label><input id="bPatient" class="np-input" placeholder="Search existing or type new name" list="bPatients"/><datalist id="bPatients"></datalist><input type="hidden" id="bPatientId"/></div>
  <div class="np-field"><label class="np-field__label">Phone *</label><input name="phone" maxlength="10" class="np-input"/></div>
  <div class="np-field"><label class="np-field__label">Email</label><input name="email" type="email" class="np-input"/></div>
  <div class="np-field"><label class="np-field__label">Parent / guardian</label><input name="parentName" class="np-input"/></div>
  <div class="np-field"><label class="np-field__label">DOB</label><input name="dateOfBirth" type="date" class="np-input"/></div>
  <div class="np-field"><label class="np-field__label">Gender</label><select name="gender" class="np-select"><option value="">—</option><option value="MALE">Male</option><option value="FEMALE">Female</option><option value="OTHER">Other</option></select></div>
  <div class="np-divider" style="grid-column:span 2"></div>
  <div class="np-field" style="grid-column:span 2"><label class="np-field__label">Reason / problem *</label><input name="primaryProblem" required class="np-input"/></div>
  <div class="np-field" style="grid-column:span 2"><label class="np-field__label">Source</label><select name="source" class="np-select"><option value="WALK_IN">Walk-in / Reception</option><option value="PHONE">Phone</option><option value="OTHER">Other</option></select></div></div>
  </form></div>
  <div class="np-modal__foot"><button type="button" class="np-btn" onclick="closeModal()">Cancel</button><button class="np-btn np-btn--primary" type="submit" form="bForm">Book</button></div>
  </div></div>`;
  const f=$('#bForm');
  async function bPrefillPatient(pid){ try{ const data=await api('/receptionist/patients/'+pid+'/history'); const p=data&&data.patient; if(!p)return; $('#bPatientId').value=p.id; $('#bPatient').value=`${p.name} — ${p.phone||''}`; if(f.phone) f.phone.value=p.phone||''; if(f.email) f.email.value=p.email||''; if(f.parentName) f.parentName.value=p.parentName||''; if(f.dateOfBirth) f.dateOfBirth.value=p.dateOfBirth?String(p.dateOfBirth).slice(0,10):''; if(f.gender) f.gender.value=p.gender||''; }catch(_){} }
  if (patientId) bPrefillPatient(patientId);
  // Guarded against out-of-order responses: switching doctor/clinic or date
  // fires a fresh fetch before the previous one resolves. Without tracking
  // which request is current, a slower response for a doctor/date the user
  // has already moved on from can land last and repopulate the picker with
  // slots that don't belong to the currently-selected doctor+date — i.e. a
  // walk-in could be booked against availability that isn't actually current.
  let __bookSlotReq=0;
  async function refreshSlots(){ const v=f.docCentre.value; if(!v)return; const [docId]=v.split('|'); const date=f.date.value; if(!date)return; const myReq=++__bookSlotReq; try{ const r=await api(`/receptionist/slots?doctorId=${docId}&date=${date}&type=OFFLINE`); if(myReq!==__bookSlotReq)return; $('#slotSel').innerHTML=(r.slots||[]).filter(s=>s.available).map(s=>`<option value="${s.startTime}">${fmtTime(s.startTime)}</option>`).join('')||'<option value="">No slots available</option>'; }catch(e){ if(myReq!==__bookSlotReq)return; $('#slotSel').innerHTML='<option value="">No slots</option>'; } }
  f.docCentre.addEventListener('change',refreshSlots); f.date.addEventListener('change',refreshSlots); refreshSlots();
  const bP=$('#bPatient'); let __bookPatientReq=0; bP.addEventListener('input',async e=>{ $('#bPatientId').value=''; clearTimeout(window.__bp); const q=e.target.value.trim(); if(q.length<2)return; window.__bp=setTimeout(async()=>{ const myReq=++__bookPatientReq; try{ const rows=await api('/receptionist/patients?q='+encodeURIComponent(q)); if(myReq!==__bookPatientReq)return; $('#bPatients').innerHTML=rows.map(p=>`<option value="${esc(p.name)} — ${esc(p.phone)}" data-id="${p.id}"></option>`).join(''); window.__bplist=rows; }catch(_){}} ,250); });
  f.addEventListener('submit',async e=>{e.preventDefault(); const raw=Object.fromEntries(new FormData(f).entries()); const [docId,centreId]=raw.docCentre.split('|');
    let pid=$('#bPatientId').value||null; const typed=bP.value.trim();
    if(!pid && window.__bplist){ const match=window.__bplist.find(p=>`${p.name} — ${p.phone}`===typed); if(match) pid=match.id; }
    const payload={ doctorId:docId, medicalCentreId:centreId, date:raw.date, startTime:raw.startTime, consultationType:'OFFLINE', primaryProblem:raw.primaryProblem, source:raw.source||'WALK_IN' };
    if(pid){ payload.patientId=pid; } else {
      const namePart=typed.split(' — ')[0]; payload.patientName=namePart; payload.phone=raw.phone; payload.email=raw.email||''; payload.parentName=raw.parentName||''; payload.dateOfBirth=raw.dateOfBirth||''; payload.gender=raw.gender||undefined;
      if(!raw.phone){ toast('Phone is required for a new patient','error'); return; }
    }
    try{ const r=await api('/receptionist/appointments',{method:'POST',body:JSON.stringify(payload)}); toast('Appointment booked'); closeModal(); refreshAfterMutation(['dashView','apptsView','patientsView']); }catch(err){ toast(err.message,'error'); }
  });
}

// Invoices
async function loadInvoices(){ const tb=$('#invTbody'); try{ const rows=await api('/receptionist/invoices'); tb.innerHTML=rows.length?rows.map(i=>`<tr><td data-label="Invoice #"><b>${esc(i.invoiceNumber)}</b></td><td data-label="Patient">${esc(i.appointment.patient.name)}</td><td data-label="Doctor">Dr. ${esc(i.appointment.doctor.name)}</td><td data-label="Clinic">${esc(i.medicalCentre?i.medicalCentre.name:'—')}</td><td data-label="Amount" style="text-align:right"><b>${inr(i.amount)}</b></td><td data-label="Date">${esc(fmtDate(i.createdAt))}</td><td data-label="Actions" style="text-align:right"><button class="np-btn np-btn--sm" onclick="openInvoiceActions('${i.id}','${esc(i.pdfUrl||'')}','${i.appointment.patient.phone||''}','${esc(i.appointment.patient.email||'')}')">Actions</button></td></tr>`).join(''):'<tr><td colspan="7"><div class="np-empty"><div class="np-empty__title">No invoices yet</div></div></td></tr>'; }catch(e){ tb.innerHTML=`<tr><td colspan="7"><div class="np-error">${esc(e.message)}</div></td></tr>`; } }
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
  </div>
  <div class="np-modal__foot"><button type="button" class="np-btn" onclick="closeModal()">Cancel</button><button type="button" class="np-btn np-btn--primary" id="sendCertConfirm">Send</button></div>
  </div></div>`;
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
  ${appointmentId?'':'<div class="np-field"><label class="np-field__label">Doctor *</label><select name="doctorId" class="np-select">'+docOpts+'</select></div><div class="np-field"><label class="np-field__label">Patient *</label><input id="certPatient" class="np-input" placeholder="Search by name or phone" list="certPatients" autocomplete="off"/><datalist id="certPatients"></datalist><input type="hidden" id="certPatientId"/></div><div class="np-divider" style="grid-column:span 2"></div>'}
  <div class="np-field" style="grid-column:span 2"><label class="np-field__label">Template</label><select name="templateKey" class="np-select">${tpls.map(t=>`<option value="${t.key}">${esc(t.label)}</option>`).join('')}</select></div>
  <div class="np-field" style="grid-column:span 2"><label class="np-field__label">Reason *</label><textarea name="reason" required class="np-textarea"></textarea></div>
  <div class="np-field"><label class="np-field__label">Diagnosis</label><input name="diagnosis" class="np-input"/></div>
  <div class="np-field"><label class="np-field__label">Rest days</label><input name="restDays" type="number" min="0" class="np-input"/></div>
  <div class="np-field"><label class="np-field__label">From date</label><input name="fromDate" type="date" class="np-input"/></div>
  <div class="np-field"><label class="np-field__label">To date</label><input name="toDate" type="date" class="np-input"/></div></div>
  </form></div>
  <div class="np-modal__foot"><button type="button" class="np-btn" onclick="closeModal()">Cancel</button><button class="np-btn np-btn--primary" type="submit" form="cForm">Issue & generate PDF</button></div>
  </div></div>`;
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
async function loadPharmBills(){ const tb=$('#pharmBillsTbody'); if(!tb)return; try{ const rows=await api('/receptionist/pharmacy/bills?billType=PHARMACY'); __pharmBills=rows; tb.innerHTML=rows.length?rows.map(b=>`<tr><td data-label=\"Bill #\"><b>${esc(b.billNumber)}</b></td><td data-label=\"Customer\">${esc(b.customerName||'')}</td><td data-label=\"Total\" style=\"text-align:right\"><b>${inr(b.total)}</b></td><td data-label=\"Status\">${billStatusBadge(b.status)}</td><td data-label=\"Date\">${esc(fmtDate(b.createdAt))}</td><td data-label=\"Actions\" style=\"text-align:right;white-space:nowrap\"><button class=\"np-btn np-btn--sm\" onclick=\"showRecBillActions('${b.id}')\">Actions</button></td></tr>`).join(''):'<tr><td colspan=\"6\"><div class=\"np-empty\"><div class=\"np-empty__title\">No pharmacy bills yet</div></div></td></tr>'; }catch(e){ tb.innerHTML=`<tr><td colspan=\"6\"><div class=\"np-error\">${esc(e.message)}</div></td></tr>`; } }
async function __ensureBillingCtx(){ if(!__doctors.length){ try{ const asn=await api('/receptionist/assignments'); __doctors=(asn||[]).map(a=>a.doctor); }catch(_){__doctors=__doctors||[];} } if(!__inv.length){ try{ __inv=await api('/receptionist/pharmacy/inventory'); }catch(e){__inv=__inv||[]; toast(e.message==='Pharmacy management is not enabled for your account' ? 'Pharmacy management is not enabled for your account — ask your admin, or add bill items manually instead of searching inventory.' : ('Could not load inventory: '+e.message), 'error'); } } }
async function loadBilling(){ const tb=$('#billingTbody'); if(!tb)return; try{ const qs=new URLSearchParams(); const t=$('#billTypeFilter').value, st=$('#billStatusFilter').value; if(t)qs.set('billType',t); if(st)qs.set('status',st); const rows=await api('/receptionist/pharmacy/bills?'+(qs.toString()||'')); __bills=rows; tb.innerHTML=rows.length?rows.map(b=>`<tr><td data-label="Bill #"><b>${esc(b.billNumber)}</b></td><td data-label="Type">${billTypeBadge(b.billType)}</td><td data-label="Customer">${esc(b.customerName||'')}${b.patient?`<div class="np-mut" style="font-size:.72rem">${esc(b.patient.name||'')}</div>`:''}</td><td data-label="Total" style="text-align:right"><b>${inr(b.total)}</b></td><td data-label="Status">${billStatusBadge(b.status)}</td><td data-label="Date">${esc(fmtDate(b.createdAt))}</td><td data-label="Actions" style="text-align:right"><button class="np-btn np-btn--sm" onclick="showRecBillActions('${b.id}')">Actions</button></td></tr>`).join(''):'<tr><td colspan="7"><div class="np-empty"><div class="np-empty__title">No bills yet</div></div></td></tr>'; }catch(e){ tb.innerHTML=`<tr><td colspan="7"><div class="np-error">${esc(e.message)}</div></td></tr>`; } }
function showRecBillActions(id){ const b=__bills.find(x=>x.id===id) || __pharmBills.find(x=>x.id===id); if(!b)return; const isPaid=b.status==='PAID'; let rows=''; if(isPaid){ rows+='<button type="button" class="np-btn np-btn--block" disabled>Paid — locked</button>'; } else { rows+='<button type="button" class="np-btn np-btn--block" onclick="closeModal();editRecBill(\''+id+'\')">Edit draft</button>'; rows+='<button type="button" class="np-btn np-btn--block np-btn--primary" onclick="closeModal();__markRecPaid(\''+id+'\')">Mark paid</button>'; } if(b.pdfUrl){ rows+='<button type="button" class="np-btn np-btn--block" onclick="window.open(\''+b.pdfUrl+'\',\'_blank\')">View PDF</button><button type="button" class="np-btn np-btn--block" onclick="printPdf(\''+b.pdfUrl+'\')">Print</button>'; } $('#modalHost').innerHTML='<div class="np-modal"><div class="np-modal__panel"><header class="np-modal__head"><div class="np-modal__title">Bill actions — '+esc(b.billNumber)+'</div><button class="np-modal__close" onclick="closeModal()">×</button></header><div class="np-modal__body"><div class="np-action-list">'+rows+'</div></div></div></div>'; }
// Both bill tables (Billing + Pharmacy Bills) and the Rx queue read from the
// same bills API, so any save/mark-paid/dispense refreshes all of them.
function refreshBillingViews(){ refreshAfterMutation(['billingView','pharmBillsView','rxView','dashView']); }
function __markRecPaid(id){ NPBilling.markPaid({api:api,esc:esc,fmt:fmtDate,toast:toast,onSaved:refreshBillingViews,billsBase:'/receptionist/pharmacy/bills'},id,refreshBillingViews); }
async function editRecBill(id){ await __ensureBillingCtx(); try{ const b=await api('/receptionist/pharmacy/bills/'+id); if(b.status!=='DRAFT'){ toast('This bill is already paid and locked','warn'); return; } NPBilling.open({ api, esc, fmt:fmtDate, toast, onSaved:refreshBillingViews, inventory:__inv, doctors:__doctors, billsBase:'/receptionist/pharmacy/bills', role:'RECEPTIONIST', host:'#modalHost', canSwitchType:true, patientSearch:q=>api('/receptionist/patients?q='+encodeURIComponent(q)) }, b); }catch(e){ toast(e.message,'error'); } }
async function openBillModal(_, rxId){
  await __ensureBillingCtx();
  NPBilling.open({
    api, esc, fmt: fmtDate, toast, onSaved: refreshBillingViews,
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