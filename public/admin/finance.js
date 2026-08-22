
(function () {
  'use strict';

  const $  = (s, root=document) => root.querySelector(s);
  const $$ = (s, root=document) => Array.from(root.querySelectorAll(s));

const MONTH_NAMES = [
    'January','February','March','April','May','June',
    'July','August','September','October','November','December'
  ];

function inr(n) {
    const v = Number(n || 0);
    return '₹' + v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function compactInr(n) {
    const v = Number(n || 0);
    if (v >= 10000000) return '₹' + (v/10000000).toFixed(v % 10000000 === 0 ? 0 : 2) + ' Cr';
    if (v >= 100000)   return '₹' + (v/100000).toFixed(v % 100000 === 0 ? 0 : 2) + ' L';
    if (v >= 1000)     return '₹' + (v/1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'k';
    return '₹' + v.toLocaleString('en-IN');
  }

function populatePeriodSelects() {
    const now = new Date();
    const curYear = now.getUTCFullYear();
    const curMonth = now.getUTCMonth() + 1;
    const years = [];
    for (let y = curYear; y >= curYear - 4; y--) years.push(y);

    // Revenue is always computed for one concrete month, so it defaults to the
    // current period. Settlements and invoices span many months, so they get
    // an "All" option and default to it — otherwise selecting a doctor would
    // silently hide any settlement not generated in the current month, which
    // read as "no results even though records exist".
    ['revMonth','stlMonth','invMonth'].forEach(id => {
      const sel = $('#' + id); if (!sel || sel.options.length) return;
      const allowAll = id !== 'revMonth';
      if (allowAll) {
        const o = document.createElement('option');
        o.value = ''; o.textContent = 'All months'; o.selected = true;
        sel.appendChild(o);
      }
      MONTH_NAMES.forEach((nm, idx) => {
        const o = document.createElement('option');
        o.value = String(idx + 1); o.textContent = nm;
        if (!allowAll && idx + 1 === curMonth) o.selected = true;
        sel.appendChild(o);
      });
    });
    ['revYear','stlYear','invYear'].forEach(id => {
      const sel = $('#' + id); if (!sel || sel.options.length) return;
      const allowAll = id !== 'revYear';
      if (allowAll) {
        const o = document.createElement('option');
        o.value = ''; o.textContent = 'All years'; o.selected = true;
        sel.appendChild(o);
      }
      years.forEach(y => {
        const o = document.createElement('option');
        o.value = String(y); o.textContent = String(y);
        if (!allowAll && y === curYear) o.selected = true;
        sel.appendChild(o);
      });
    });
  }

  async function populateDoctorFilters() {
    let doctors = window.__doctorsCache || [];
    if (!doctors.length) {
      try { doctors = await api('/admin/doctors'); window.__doctorsCache = doctors; }
      catch (_) { doctors = []; }
    }
    ['revDoctor','stlDoctor','invDoctor'].forEach(id => {
      const sel = $('#' + id); if (!sel) return;
      // Rebuilding the <select> wipes whatever the user had picked, so the
      // doctor filter appeared to "reset itself" right after selection.
      // Capture the current value and restore it once the options are back.
      const prevValue = sel.value;
      const head = sel.options[0];
      sel.innerHTML = '';
      if (head) sel.appendChild(head);
      doctors.forEach(d => {
        const o = document.createElement('option');
        o.value = d.id; o.textContent = drName(d.name);
        sel.appendChild(o);
      });
      if (prevValue && doctors.some(d => d.id === prevValue)) {
        sel.value = prevValue;
      }
    });
  }

  function statusPill(status) {
    const map = {
      DRAFT:         { cls:'np-badge--slate', label:'Draft' },
      NOT_GENERATED: { cls:'np-badge--slate', label:'Not generated' },
      GENERATED:     { cls:'np-badge--amber', label:'Awaiting payment' },
      PAID:          { cls:'np-badge--green', label:'Paid' }
    };
    const s = map[status] || { cls:'np-badge--slate', label: status || '—' };
    return `<span class="np-badge ${s.cls}"><span class="np-badge__dot"></span>${s.label}</span>`;
  }

async function loadRevenue() {
    populatePeriodSelects();
    await populateDoctorFilters();

    const year     = Number($('#revYear').value);
    const month    = Number($('#revMonth').value);
    const doctorId = $('#revDoctor').value || '';
    const ptype    = $('#revPaymentType').value || '';
    const source   = ($('#revSource') && $('#revSource').value) || '';

    const q = new URLSearchParams({ year, month });
    if (doctorId) q.set('doctorId', doctorId);
    if (ptype)    q.set('paymentType', ptype);
    if (source)   q.set('source', source);

    // Same endpoint, previous calendar month — gives a real period-over-
    // period trend for free, no backend change needed.
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear  = month === 1 ? year - 1 : year;
    const prevQ = new URLSearchParams(q); prevQ.set('year', prevYear); prevQ.set('month', prevMonth);

    const tbody = $('#revenueTbody');
    tbody.innerHTML = `<tr><td colspan="9" class="np-empty"><div>Loading…</div></td></tr>`;

    let data, prevData;
    try {
      [data, prevData] = await Promise.all([
        api('/admin/finance/revenue-report?' + q.toString()),
        api('/admin/finance/revenue-report?' + prevQ.toString()).catch(() => null)
      ]);
    }
    catch (err) {
      tbody.innerHTML = `<tr><td colspan="9" class="np-empty"><div>Failed: ${escapeHtml(err.message)}</div></td></tr>`;
      return;
    }

    renderRevenueAnalytics(data.grandTotals, prevData && prevData.grandTotals, MONTH_NAMES[month - 1], year);

    if (!data.rows.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="np-empty"><div>No revenue for this period.</div></td></tr>`;
      return;
    }
    tbody.innerHTML = data.rows.map(r => {
      const ss = r.settlement ? r.settlement.status : 'NOT_GENERATED';
      const hasConsults = r.totals.consultations > 0;
      const actions = [
        ss === 'NOT_GENERATED' && hasConsults
          ? `<button class="np-btn np-btn--primary np-btn--sm" onclick="Finance.generateSettlement('${r.doctor.id}', ${year}, ${month})">Generate Settlement</button>`
          : '',
        r.settlement && r.settlement.id
          ? `<button class="np-btn np-btn--ghost np-btn--sm" onclick="Finance.openSettlement('${r.settlement.id}')">View</button>`
          : '',
        ss === 'PAID' && r.settlement && r.settlement.id
          ? `<a class="np-btn np-btn--ghost np-btn--sm" href="/api/admin/finance/invoices/${r.settlement.id}/download?_t=${Date.now()}" target="_blank" onclick="event.preventDefault(); Finance.downloadInvoice('${r.settlement.id}')">Invoice</a>`
          : ''
      ].filter(Boolean).join(' ');

      return `
        <tr>
          <td data-label="Doctor">
            <div style="font-weight:600;">${drNameHtml(r.doctor.name)}</div>
            <div style="font-size:.7rem; color:var(--np-muted);">
              ${escapeHtml(r.doctor.specialization || 'Pediatrician')}
              · ${r.doctor.clinicSharePercent}/${r.doctor.doctorSharePercent} split · TDS ${r.doctor.tdsPercent}%
            </div>
          </td>
          <td data-label="Consults" style="text-align:right;">${r.totals.consultations}</td>
          <td data-label="Total Revenue" style="text-align:right;">${inr(r.totals.totalRevenue)}</td>
          <td data-label="NeoKidsPro Share" style="text-align:right;">${inr(r.totals.clinicShare)}</td>
          <td data-label="Doctor Gross" style="text-align:right;">${inr(r.totals.doctorGross)}</td>
          <td data-label="TDS" style="text-align:right; color:#B45309;">${inr(r.totals.tds)}</td>
          <td data-label="Doctor Net" style="text-align:right; font-weight:600;">${inr(r.totals.doctorNet)}</td>
          <td data-label="Status">${statusPill(ss)}</td>
          <td data-label="Actions" style="text-align:right; white-space:nowrap;">${actions || '—'}</td>
        </tr>
      `;
    }).join('');
  }

  // Shared with Admin/app.js, Doctor, Receptionist and Pharmacy — see
  // NPFmt.trendChip in /assets/np-ui.js (single source of truth).
  const trendChip = NPFmt.trendChip;

  function pctDelta(curr, prev){
    if (!prev) return curr > 0 ? 100 : 0;
    return Math.round(((curr - prev) / prev) * 100);
  }

  function renderRevenueAnalytics(g, pg, monthLabel, year){
    const revEl = $('#revPeriodLabel');
    if (revEl) revEl.textContent = `${monthLabel} ${year}`;

    const revDelta = pg ? pctDelta(g.totalRevenue, pg.totalRevenue) : 0;
    const trendEl = $('#revTrend');
    if (trendEl) trendEl.innerHTML = pg ? trendChip(revDelta, 'vs last month', true) : '';
    const totalEl = $('#revTotal'); if (totalEl) totalEl.textContent = inr(g.totalRevenue);
    const bd = $('#revBreakdown');
    if (bd) bd.innerHTML =
      `<span class="np-dot np-dot--mint"></span>${inr(g.clinicShare)} NeoKidsPro share` +
      `<span class="np-dot np-dot--amber"></span>${inr(g.tds)} TDS deducted` +
      `<span class="np-dot np-dot--blue"></span>${g.consultations} consultations`;

    const netDelta = pg ? pctDelta(g.doctorNet, pg.doctorNet) : 0;
    const netTrendEl = $('#revNetTrend');
    if (netTrendEl) netTrendEl.innerHTML = pg ? trendChip(netDelta, 'vs last month', true) : '';
    const netEl = $('#revNet'); if (netEl) netEl.textContent = inr(g.doctorNet);
    const netBd = $('#revNetBreakdown');
    if (netBd) netBd.innerHTML = `<span class="np-dot np-dot--mint"></span>${inr(g.doctorGross)} gross before TDS`;
  }

  function kpi(label, big, sub, kind='blue') {
    return `
      <div class="np-kpi np-kpi--${kind}">
        <div class="np-kpi__label">${escapeHtml(label)}</div>
        <div class="np-kpi__value">${escapeHtml(big)}</div>
        ${sub ? `<div class="np-kpi__sub">${escapeHtml(sub)}</div>` : ''}
      </div>
    `;
  }

  async function generateSettlement(doctorId, year, month) {
    const ok = await NPModal.confirm({
      title: `Freeze ${MONTH_NAMES[month-1]} ${year} totals?`,
      message: 'This snapshots the numbers and links all eligible appointments. You can still re-generate before marking it PAID.',
      okText: 'Generate settlement',
    });
    if (!ok) return;
    try {
      await api('/admin/finance/settlements/generate', {
        method: 'POST',
        body: JSON.stringify({ doctorId, year, month })
      });
      NPToast.success('Settlement generated.');
      loadRevenue();
    } catch (err) { NPToast.error('Failed: ' + err.message); }
  }

function renderSettlementAnalytics(list){
    const generated = list.filter(s => s.status === 'GENERATED');
    const paid = list.filter(s => s.status === 'PAID');
    const sum = (rows) => rows.reduce((t, r) => t + Number(r.doctorNetAmount || 0), 0);

    const pendingEl = $('#stlPendingAmount');
    if (pendingEl) pendingEl.textContent = inr(sum(generated));
    const pendingBd = $('#stlPendingBreakdown');
    if (pendingBd) pendingBd.innerHTML =
      `<span class="np-dot np-dot--amber"></span>${generated.length} awaiting payment` +
      `<span class="np-dot np-dot--blue"></span>${generated.reduce((t,s)=>t+Number(s.totalConsultations||0),0)} consults`;

    const paidEl = $('#stlPaidAmount');
    if (paidEl) paidEl.textContent = inr(sum(paid));
    const paidBd = $('#stlPaidBreakdown');
    if (paidBd) paidBd.innerHTML =
      `<span class="np-dot np-dot--mint"></span>${paid.length} settlement(s) paid` +
      `<span class="np-dot np-dot--blue"></span>${paid.reduce((t,s)=>t+Number(s.totalConsultations||0),0)} consults`;
  }

async function loadSettlements() {
    populatePeriodSelects();
    await populateDoctorFilters();

    const q = new URLSearchParams();
    if ($('#stlYear').value)   q.set('year',   $('#stlYear').value);
    if ($('#stlMonth').value)  q.set('month',  $('#stlMonth').value);
    if ($('#stlDoctor').value) q.set('doctorId', $('#stlDoctor').value);
    if ($('#stlStatus').value) q.set('status', $('#stlStatus').value);

    const tbody = $('#settlementsTbody');
    tbody.innerHTML = `<tr><td colspan="8" class="np-empty"><div>Loading…</div></td></tr>`;

    let list;
    try { list = await api('/admin/finance/settlements?' + q.toString()); }
    catch (err) {
      tbody.innerHTML = `<tr><td colspan="8" class="np-empty"><div>Failed: ${escapeHtml(err.message)}</div></td></tr>`;
      return;
    }

    const pending = list.filter(s => s.status === 'GENERATED').length;
    const badge = $('#navBadgePendingSettlements');
    if (badge) {
      badge.textContent = pending;
      badge.classList.toggle('hidden', pending === 0);
    }
    renderSettlementAnalytics(list);

    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="np-empty"><div>No settlements yet for the selected filters.</div></td></tr>`;
      return;
    }

    tbody.innerHTML = list.map(s => {
      const period = `${MONTH_NAMES[s.periodMonth - 1]} ${s.periodYear}`;
      const actions = [
        `<button class="np-btn np-btn--ghost np-btn--sm" onclick="Finance.openSettlement('${s.id}')">View</button>`,
        s.status === 'GENERATED'
          ? `<button class="np-btn np-btn--primary np-btn--sm" onclick="Finance.openMarkPaid('${s.id}')">Mark Paid</button>`
          : '',
        s.status === 'PAID'
          ? `<button class="np-btn np-btn--ghost np-btn--sm" onclick="Finance.downloadInvoice('${s.id}')">Invoice</button>`
          : ''
      ].filter(Boolean).join(' ');
      return `
        <tr>
          <td data-label="Period">${period}</td>
          <td data-label="Doctor">
            <div style="font-weight:600;">${drNameHtml(s.doctor?.name || '—')}</div>
            <div style="font-size:.7rem; color:var(--np-muted);">${escapeHtml(s.doctor?.specialization || 'Pediatrician')}</div>
          </td>
          <td data-label="Consults" style="text-align:right;">${s.totalConsultations}</td>
          <td data-label="Total Revenue" style="text-align:right;">${inr(s.totalRevenue)}</td>
          <td data-label="Net Paid" style="text-align:right; font-weight:600;">${inr(s.doctorNetAmount)}</td>
          <td data-label="Status">${statusPill(s.status)}</td>
          <td data-label="Paid On">${s.paidAt ? fmtDate(s.paidAt) : '—'}</td>
          <td data-label="Actions" style="text-align:right; white-space:nowrap;">${actions}</td>
        </tr>
      `;
    }).join('');
  }

async function openSettlement(id) {
    const modal = $('#settlementModal');
    const body  = $('#settlementModalBody');
    body.innerHTML = `<div class="np-empty"><div>Loading…</div></div>`;
    modal.classList.remove('hidden');

    let data;
    try { data = await api('/admin/finance/settlements/' + id); }
    catch (err) {
      body.innerHTML = `<div class="np-error">${escapeHtml(err.message)}</div>`;
      return;
    }
    const s = data.settlement; const rows = data.rows || [];
    const period = `${MONTH_NAMES[s.periodMonth - 1]} ${s.periodYear}`;
    $('#settlementModalTitle').textContent = `Settlement · ${drName(s.doctor.name)} · ${period}`;

    const summary = `
      <div class="np-kpi-grid" style="margin-bottom:1rem;">
        ${kpi('Total Revenue', inr(s.totalRevenue), `${s.totalConsultations} appt(s)`, 'blue')}
        ${kpi('NeoKidsPro Share',  inr(s.clinicShareAmount), `${Number(s.clinicSharePercent)}% of revenue`, 'mint')}
        ${kpi('Doctor Gross',  inr(s.doctorGrossAmount), `${Number(s.doctorSharePercent)}% of revenue`, 'cream')}
        ${kpi('TDS Deducted',  inr(s.tdsAmount), `${Number(s.tdsPercent)}% of gross`, 'coral')}
        ${kpi('Doctor Net',    inr(s.doctorNetAmount), 'Final payable', 'blue')}
      </div>
      <div style="display:flex; gap:.5rem; flex-wrap:wrap; margin-bottom:1rem; font-size:.8rem;">
        <div><strong>Status:</strong> ${statusPill(s.status)}</div>
        ${s.paidAt ? `<div><strong>Paid:</strong> ${escapeHtml(fmtDateTime(s.paidAt))}</div>` : ''}
        ${s.paymentMode ? `<div><strong>Mode:</strong> ${escapeHtml(s.paymentMode)}</div>` : ''}
        ${s.paymentReference ? `<div><strong>Reference:</strong> ${escapeHtml(s.paymentReference)}</div>` : ''}
        ${s.invoiceNumber ? `<div><strong>Invoice:</strong> ${escapeHtml(s.invoiceNumber)}</div>` : ''}
      </div>
    `;

    const tableRows = rows.length ? rows.map(r => `
      <tr>
        <td>${escapeHtml(fmtDate(r.date))}</td>
        <td>${escapeHtml(r.startTime || '')}</td>
        <td>${escapeHtml(r.patient?.name || '—')}</td>
        <td>${escapeHtml(r.consultationType)}</td>
        <td style="text-align:right;">${inr(r.patientPayment)}</td>
        <td style="text-align:right;">${inr(r.doctorGross)}</td>
        <td style="text-align:right; color:#B45309;">${inr(r.tds)}</td>
        <td style="text-align:right; font-weight:600;">${inr(r.doctorNet)}</td>
      </tr>
    `).join('') : `<tr><td colspan="8" class="np-empty"><div>No appointments.</div></td></tr>`;

    const actionButtons = [
      s.status === 'GENERATED'
        ? `<button class="np-btn np-btn--primary np-btn--sm" onclick="Finance.closeSettlementModal(); Finance.openMarkPaid('${s.id}')">Mark Paid &amp; Generate Invoice</button>`
        : '',
      s.status === 'PAID'
        ? `<button class="np-btn np-btn--ghost np-btn--sm" onclick="Finance.downloadInvoice('${s.id}')">Download Invoice</button>`
        : ''
    ].filter(Boolean).join(' ');

    body.innerHTML = `
      ${summary}
      <div class="np-table-wrap" style="max-height:340px; overflow:auto;">
        <table class="np-table">
          <thead>
            <tr>
              <th>Date</th><th>Time</th><th>Patient</th><th>Type</th>
              <th style="text-align:right;">Fee</th>
              <th style="text-align:right;">Gross</th>
              <th style="text-align:right;">TDS</th>
              <th style="text-align:right;">Net</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
      <div class="np-row" style="justify-content:flex-end; gap:.5rem; margin-top:.75rem;">
        <button class="np-btn np-btn--ghost np-btn--sm" onclick="Finance.closeSettlementModal()">Close</button>
        ${actionButtons}
      </div>
    `;
  }

  function closeSettlementModal() { $('#settlementModal').classList.add('hidden'); }

let _currentMarkPaidSettlement = null;

  async function openMarkPaid(id) {
    try {
      const data = await api('/admin/finance/settlements/' + id);
      _currentMarkPaidSettlement = data.settlement;
      const s = data.settlement;
      const period = `${MONTH_NAMES[s.periodMonth - 1]} ${s.periodYear}`;
      $('#markPaidSummary').innerHTML = `
        <div><strong>Doctor:</strong> ${drNameHtml(s.doctor.name)}</div>
        <div><strong>Period:</strong> ${period}</div>
        <div><strong>Net Payable:</strong> <span class="np-amount-positive">${inr(s.doctorNetAmount)}</span></div>
        <div style="font-size:.7rem; color:var(--np-muted); margin-top:.35rem;">
          A settlement invoice PDF will be generated automatically.
        </div>
      `;
      const f = $('#markPaidForm');
      f.reset();
      f.settlementId.value = id;
      $('#markPaidError').classList.add('hidden');
      $('#markPaidModal').classList.remove('hidden');
    } catch (err) { alert('Failed: ' + err.message); }
  }

  function closeMarkPaidModal() {
    $('#markPaidModal').classList.add('hidden');
    _currentMarkPaidSettlement = null;
  }

function bindMarkPaidForm() {
    const form = $('#markPaidForm');
    if (!form || form.__bound) return;
    form.__bound = true;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = $('#markPaidError'); errEl.textContent = ''; errEl.classList.add('hidden');
      const fd = new FormData(form);
      const id   = fd.get('settlementId');
      const body = {
        paymentMode:      fd.get('paymentMode'),
        paymentReference: (fd.get('paymentReference') || '').toString().trim(),
        paymentNotes:     (fd.get('paymentNotes') || '').toString().trim() || undefined
      };
      try {
        await api(`/admin/finance/settlements/${id}/mark-paid`, {
          method: 'POST', body: JSON.stringify(body)
        });
        closeMarkPaidModal();
        alert('Settlement marked PAID. Invoice generated.');
        loadSettlements();
        loadRevenue();
      } catch (err) {
        errEl.textContent = err.message; errEl.classList.remove('hidden');
      }
    });
  }

async function loadInvoices() {
    populatePeriodSelects();
    await populateDoctorFilters();

    const q = new URLSearchParams();
    if ($('#invYear').value)   q.set('year',   $('#invYear').value);
    if ($('#invMonth').value)  q.set('month',  $('#invMonth').value);
    if ($('#invDoctor').value) q.set('doctorId', $('#invDoctor').value);

    const tbody = $('#invoicesTbody');
    tbody.innerHTML = `<tr><td colspan="7" class="np-empty"><div>Loading…</div></td></tr>`;

    let list;
    try { list = await api('/admin/finance/invoices?' + q.toString()); }
    catch (err) {
      tbody.innerHTML = `<tr><td colspan="7" class="np-empty"><div>Failed: ${escapeHtml(err.message)}</div></td></tr>`;
      return;
    }

    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="np-empty"><div>No invoices yet.</div></td></tr>`;
      return;
    }

    tbody.innerHTML = list.map(s => {
      const period = `${MONTH_NAMES[s.periodMonth - 1]} ${s.periodYear}`;
      return `
        <tr>
          <td data-label="Invoice #" style="font-family:'Courier New', monospace; font-size:.8rem;">${escapeHtml(s.invoiceNumber || '—')}</td>
          <td data-label="Period">${period}</td>
          <td data-label="Doctor">${drNameHtml(s.doctor?.name || '—')}</td>
          <td data-label="Doctor Net" style="text-align:right; font-weight:600;">${inr(s.doctorNetAmount)}</td>
          <td data-label="Reference">
            <div style="font-size:.78rem;">${escapeHtml(s.paymentMode || '')}</div>
            <div style="font-size:.7rem; color:var(--np-muted); font-family:'Courier New', monospace;">${escapeHtml(s.paymentReference || '')}</div>
          </td>
          <td data-label="Paid On">${s.paidAt ? fmtDateTime(s.paidAt) : '—'}</td>
          <td data-label="Actions" style="text-align:right; white-space:nowrap;">
            <button class="np-btn np-btn--primary np-btn--sm" onclick="Finance.downloadInvoice('${s.id}')">Download PDF</button>
          </td>
        </tr>
      `;
    }).join('');
  }

async function downloadInvoice(settlementId) {
    try {
      const token = localStorage.getItem('np_admin_token');
      if (!token) throw new Error('Not signed in');
      const r = await fetch(`/api/admin/finance/invoices/${settlementId}/download`, {
        headers: { Authorization: 'Bearer ' + token }
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(t || ('HTTP ' + r.status));
      }
      const blob = await r.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = `settlement_${settlementId}.pdf`;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    } catch (err) { alert('Download failed: ' + err.message); }
  }

function bindFilters() {
    const safe = (id, fn) => { const el = $('#' + id); if (el && !el.__bound) { el.__bound = true; el.addEventListener('click', fn); } };
    // Selecting a filter value should apply immediately — the Apply buttons
    // remain for discoverability but are no longer required, which is what
    // made the doctor filter feel like it "reset" (users changed the dropdown
    // and nothing loaded until a separate click).
    const onChange = (id, fn) => { const el = $('#' + id); if (el && !el.__changeBound) { el.__changeBound = true; el.addEventListener('change', fn); } };

    safe('refreshRevenue',    loadRevenue);
    safe('applyRevenue',      loadRevenue);
    ['revYear','revMonth','revDoctor','revPaymentType','revSource'].forEach(id => onChange(id, loadRevenue));

    safe('refreshSettlements', loadSettlements);
    safe('applySettlements',   loadSettlements);
    ['stlYear','stlMonth','stlDoctor','stlStatus'].forEach(id => onChange(id, loadSettlements));
    safe('clearSettlements',   () => {
      $('#stlDoctor').value = ''; $('#stlStatus').value = '';
      $('#stlMonth').value = ''; $('#stlYear').value = '';
      loadSettlements();
    });

    safe('refreshInvoices', loadInvoices);
    safe('applyInvoices',   loadInvoices);
    ['invYear','invMonth','invDoctor'].forEach(id => onChange(id, loadInvoices));
    safe('clearInvoices',   () => {
      $('#invDoctor').value = ''; $('#invMonth').value = ''; $('#invYear').value = '';
      loadInvoices();
    });
  }

function init() {
    populatePeriodSelects();
    bindFilters();
    bindMarkPaidForm();
  }

async function refreshPendingBadge() {
    if (!localStorage.getItem('np_admin_token')) return;
    try {
      const list = await api('/admin/finance/settlements?status=GENERATED');
      const badge = $('#navBadgePendingSettlements');
      if (badge) {
        badge.textContent = list.length;
        badge.classList.toggle('hidden', list.length === 0);
      }
    } catch (_) {  }
  }

  window.Finance = {
    loadRevenue,
    loadSettlements,
    loadInvoices,
    openSettlement,
    closeSettlementModal,
    openMarkPaid,
    closeMarkPaidModal,
    downloadInvoice,
    generateSettlement,
    refreshPendingBadge
  };

  window.closeSettlementModal = closeSettlementModal;
  window.closeMarkPaidModal   = closeMarkPaidModal;

  document.addEventListener('DOMContentLoaded', init);
})();
