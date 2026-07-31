
(function () {
  'use strict';

  const $  = (s, root=document) => root.querySelector(s);
  const $$ = (s, root=document) => Array.from(root.querySelectorAll(s));

  const MONTH_NAMES = [
    'January','February','March','April','May','June',
    'July','August','September','October','November','December'
  ];

  function inr(n) {
    return '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function compactInr(n) {
    const v = Number(n || 0);
    if (v >= 100000) return '₹' + (v/100000).toFixed(v % 100000 === 0 ? 0 : 2) + 'L';
    if (v >= 1000)   return '₹' + (v/1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'k';
    return '₹' + v.toLocaleString('en-IN');
  }

  function statusPill(status) {
    const map = {
      DRAFT:         { cls:'np-badge--slate', label:'Awaiting month-end' },
      NOT_GENERATED: { cls:'np-badge--slate', label:'Not generated yet' },
      GENERATED:     { cls:'np-badge--amber', label:'Awaiting payout' },
      PAID:          { cls:'np-badge--green', label:'Paid' }
    };
    const s = map[status] || { cls:'np-badge--slate', label: status || '—' };
    return `<span class="np-badge ${s.cls}"><span class="np-badge__dot"></span>${s.label}</span>`;
  }

  function populatePeriodSelects() {
    const now = new Date();
    const curYear = now.getUTCFullYear();
    const curMonth = now.getUTCMonth() + 1;

    const mSel = $('#earnMonth');
    if (mSel && !mSel.options.length) {
      MONTH_NAMES.forEach((nm, idx) => {
        const o = document.createElement('option');
        o.value = String(idx + 1); o.textContent = nm;
        if (idx + 1 === curMonth) o.selected = true;
        mSel.appendChild(o);
      });
    }
    const ySel = $('#earnYear');
    if (ySel && !ySel.options.length) {
      for (let y = curYear; y >= curYear - 4; y--) {
        const o = document.createElement('option');
        o.value = String(y); o.textContent = String(y);
        if (y === curYear) o.selected = true;
        ySel.appendChild(o);
      }
    }
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

  async function load() {
    populatePeriodSelects();

    const year  = Number($('#earnYear').value);
    const month = Number($('#earnMonth').value);
    const q = new URLSearchParams({ year, month });

    const tbody = $('#earnTbody');
    tbody.innerHTML = `<tr><td colspan="7" class="np-empty"><div>Loading…</div></td></tr>`;

    let dash, breakdown, settlements;
    try {
      [dash, breakdown, settlements] = await Promise.all([
        api('/doctor/earnings/my-dashboard?' + q.toString()),
        api('/doctor/earnings/breakdown?' + q.toString()),
        api('/doctor/earnings/settlements')
      ]);
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="7" class="np-empty"><div>Failed: ${escapeHtml(err.message)}</div></td></tr>`;
      return;
    }

const t = dash.totals;
    const d = dash.doctor;
    $('#earnKpiGrid').innerHTML = [
      kpi('Total Patients',     String(t.consultations), 'Cashfree-paid only', 'blue'),
      kpi('Revenue Generated',  compactInr(t.totalRevenue), inr(t.totalRevenue), 'mint'),
      kpi('My Gross Share',     compactInr(t.doctorGross), `${d.doctorSharePercent}% of revenue`, 'cream'),
      kpi('TDS Deducted',       compactInr(t.tds), `${d.tdsPercent}% of gross`, 'coral'),
      kpi('Net Earnings',       compactInr(t.doctorNet), inr(t.doctorNet), 'blue')
    ].join('');

const sCard = $('#earnSettlementCard');
    const s = dash.settlement || { status: 'NOT_GENERATED' };
    sCard.classList.add('np-settlement-card');
    sCard.setAttribute('data-settlement-status', s.status || 'NOT_GENERATED');
    sCard.style.background = '';
    sCard.style.border = '';
    sCard.style.color = '';

    const period = `${MONTH_NAMES[month-1]} ${year}`;

    let msg = '';
    if (s.status === 'PAID') {
      msg = `<strong>${period} settlement is PAID.</strong>
             ${s.paidAt ? `Paid on ${escapeHtml(fmtDate(s.paidAt))}.` : ''}
             ${s.paymentReference ? `Reference: <code>${escapeHtml(s.paymentReference)}</code>.` : ''}
             ${s.id ? ` <button class="np-btn np-btn--ghost np-btn--sm" style="margin-left:.5rem;" onclick="Earnings.downloadInvoice('${s.id}')">Download invoice</button>` : ''}`;
    } else if (s.status === 'GENERATED') {
      msg = `<strong>${period} settlement is awaiting payout.</strong>
             Net payable: <strong>${inr(t.doctorNet)}</strong>. The clinic admin will mark it paid after the transfer.`;
    } else {
      msg = `<strong>${period} settlement has not been generated yet.</strong>
             Numbers above are live and will be frozen by the admin at month-end.`;
    }
    sCard.innerHTML = msg;
    sCard.style.display = 'block';

const rows = breakdown.rows || [];
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="np-empty"><div>No Cashfree-paid appointments in this period.</div></td></tr>`;
    } else {
      tbody.innerHTML = rows.map(r => `
        <tr>
          <td data-label="Date">${escapeHtml(fmtDate(r.date))} <span style="color:var(--np-muted); font-size:.7rem;">${escapeHtml(r.startTime || '')}</span></td>
          <td data-label="Patient">${escapeHtml(r.patient?.name || '—')}</td>
          <td data-label="Type">${escapeHtml(r.consultationType)}</td>
          <td data-label="Fee" style="text-align:right;">${inr(r.patientPayment)}</td>
          <td data-label="My Gross" style="text-align:right;">${inr(r.doctorGross)}</td>
          <td data-label="TDS" style="text-align:right; color:#B45309;">${inr(r.tds)}</td>
          <td data-label="My Net" style="text-align:right; font-weight:600;">${inr(r.doctorNet)}</td>
        </tr>
      `).join('');
    }

const stb = $('#earnSettlementsTbody');
    if (!settlements.length) {
      stb.innerHTML = `<tr><td colspan="7" class="np-empty"><div>No past settlements yet.</div></td></tr>`;
    } else {
      stb.innerHTML = settlements.map(x => {
        const per = `${MONTH_NAMES[x.periodMonth - 1]} ${x.periodYear}`;
        return `
          <tr>
            <td data-label="Period">${per}</td>
            <td data-label="Consults" style="text-align:right;">${x.totalConsultations}</td>
            <td data-label="Total Revenue" style="text-align:right;">${inr(x.totalRevenue)}</td>
            <td data-label="My Net" style="text-align:right; font-weight:600;">${inr(x.doctorNetAmount)}</td>
            <td data-label="Status">${statusPill(x.status)}</td>
            <td data-label="Paid On">${x.paidAt ? fmtDate(x.paidAt) : '—'}</td>
            <td data-label="Invoice" style="text-align:right;">
              ${x.status === 'PAID'
                ? `<button class="np-btn np-btn--ghost np-btn--sm" onclick="Earnings.downloadInvoice('${x.id}')">PDF</button>`
                : '—'}
            </td>
          </tr>
        `;
      }).join('');
    }
  }

  async function downloadInvoice(settlementId) {
    try {
      const token = localStorage.getItem('np_doctor_token') || localStorage.getItem('np_admin_token');
      const r = await fetch(`/api/doctor/earnings/settlements/${settlementId}/invoice`, {
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

  function init() {
    populatePeriodSelects();
    const refresh = $('#refreshEarnings');
    if (refresh && !refresh.__bound) { refresh.__bound = true; refresh.addEventListener('click', load); }
    const apply = $('#applyEarnings');
    if (apply && !apply.__bound) { apply.__bound = true; apply.addEventListener('click', load); }
  }

  window.Earnings = { load, downloadInvoice };
  document.addEventListener('DOMContentLoaded', init);
})();
