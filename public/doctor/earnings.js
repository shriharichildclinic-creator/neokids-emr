
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

  // Shared with Admin/Doctor/Receptionist/Pharmacy dashboards — see
  // NPFmt.trendChip in /assets/np-ui.js (single source of truth).
  const trendChip = NPFmt.trendChip;

  function pctDelta(curr, prev) {
    if (!prev) return curr > 0 ? 100 : 0;
    return Math.round(((curr - prev) / prev) * 100);
  }

  function renderEarningsAnalytics(dash, prevDash, periodLabel) {
    const t = dash.totals;
    const d = dash.doctor;
    const cash = dash.cash || { consultations: 0, totalCash: 0 };
    const pt = prevDash && prevDash.totals;

    const revDelta = pt ? pctDelta(t.totalRevenue, pt.totalRevenue) : 0;
    const netDelta = pt ? pctDelta(t.doctorNet, pt.doctorNet) : 0;

    $('#earnAnalytics').innerHTML = `
      <div class="np-analytics-card np-analytics-card--revenue">
        <div class="np-analytics-card__head">
          <div class="np-analytics-card__eyebrow">${escapeHtml(periodLabel)}</div>
          <div class="np-analytics-card__trend">${pt ? trendChip(revDelta, 'vs last month', true) : ''}</div>
        </div>
        <div class="np-analytics-card__value">${inr(t.totalRevenue)}</div>
        <div class="np-analytics-card__breakdown">
          <span class="np-dot-item"><span class="np-dot np-dot--blue"></span>${t.consultations} online consult${t.consultations === 1 ? '' : 's'}</span>
          <span class="np-dot-item"><span class="np-dot np-dot--mint"></span>${inr(t.doctorGross)} my gross (${d.doctorSharePercent}%)</span>
          <span class="np-dot-item"><span class="np-dot np-dot--amber"></span>${inr(t.tds)} TDS (${d.tdsPercent}%)</span>
        </div>
      </div>
      <div class="np-analytics-card np-analytics-card--today">
        <div class="np-analytics-card__head">
          <div class="np-analytics-card__eyebrow">Net Payout (Online)</div>
          <div class="np-analytics-card__trend">${pt ? trendChip(netDelta, 'vs last month', true) : ''}</div>
        </div>
        <div class="np-analytics-card__value">${inr(t.doctorNet)}</div>
        <div class="np-analytics-card__breakdown">
          <span class="np-dot-item"><span class="np-dot np-dot--mint"></span>${inr(t.doctorGross)} gross before TDS</span>
        </div>
      </div>
      <div class="np-analytics-card np-analytics-card--warn">
        <div class="np-analytics-card__head">
          <div class="np-analytics-card__eyebrow">Collected Outside Gateway</div>
        </div>
        <div class="np-analytics-card__value">${inr(cash.totalCash)}</div>
        <div class="np-analytics-card__breakdown">
          <span class="np-dot-item"><span class="np-dot np-dot--amber"></span>${cash.offlineConsultations || 0} in-clinic visit${cash.offlineConsultations === 1 ? '' : 's'}</span>
          ${cash.onlineCashConsultations ? `<span class="np-dot-item"><span class="np-dot np-dot--blue"></span>${cash.onlineCashConsultations} teleconsult${cash.onlineCashConsultations === 1 ? '' : 's'} paid in cash</span>` : ''}
          <span class="np-dot-item">Not part of settlement</span>
        </div>
      </div>
    `;
  }

  async function load() {
    populatePeriodSelects();

    const year  = Number($('#earnYear').value);
    const month = Number($('#earnMonth').value);
    const q = new URLSearchParams({ year, month });

    // Same endpoint, previous calendar month — gives a real period-over-
    // period trend for free, no backend change needed.
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear  = month === 1 ? year - 1 : year;
    const prevQ = new URLSearchParams({ year: prevYear, month: prevMonth });

    const tbody = $('#earnTbody');
    tbody.innerHTML = `<tr><td colspan="7" class="np-empty"><div>Loading…</div></td></tr>`;

    let dash, prevDash, breakdown, settlements;
    try {
      [dash, prevDash, breakdown, settlements] = await Promise.all([
        api('/doctor/earnings/my-dashboard?' + q.toString()),
        api('/doctor/earnings/my-dashboard?' + prevQ.toString()).catch(() => null),
        api('/doctor/earnings/breakdown?' + q.toString()),
        api('/doctor/earnings/settlements')
      ]);
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="7" class="np-empty"><div>Failed: ${escapeHtml(err.message)}</div></td></tr>`;
      return;
    }

const t = dash.totals;
    renderEarningsAnalytics(dash, prevDash, `${MONTH_NAMES[month-1]} ${year}`);

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
