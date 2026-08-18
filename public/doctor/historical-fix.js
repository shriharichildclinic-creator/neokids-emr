/* =====================================================================
   historical-fix.js  \u2014  v3.4.6 Doctor Panel: full Historical Records
   refactor.

   Design goals (per v3.4.6 spec):
     \u2022 Records-first layout \u2014 list is always visible, no patient
       selection required to see records.
     \u2022 Debounced instant search over patient / diagnosis / notes /
       medications / treatment / title.
     \u2022 Add / Edit / View flows live in dedicated modals portaled to
       <body> so the fixed sidebar never traps them.
     \u2022 Multi-attachment upload with per-file metadata; each existing
       attachment supports preview / download / open-in-new-tab /
       replace / delete.
     \u2022 Every legacy endpoint is preserved exactly; this file only ADDS
       new UI behaviour and calls existing routes plus one new
       aggregate route `GET /doctor/previous-records`.
     \u2022 Fully responsive: table on desktop, cards on mobile; modals
       become full-screen on narrow viewports (styled in styles.css).

   The module is defensive: it only activates when #historicalTab is
   present in the DOM, and never overrides globals that already exist
   (older builds keep working during rollout).
   ===================================================================== */
(function () {
  'use strict';

  // ---- shared helpers ------------------------------------------------
  const $  = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const api = (window.apiFetch || window.api);
  if (!api) return;

  const esc = (s) => (typeof window.escapeHtml === 'function')
    ? window.escapeHtml(s)
    : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[c]));

  const fmtDate = (d) => {
    if (!d) return '';
    if (typeof window.fmtDate === 'function') return window.fmtDate(d);
    const dt = new Date(d);
    if (isNaN(dt)) return String(d);
    return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  };

  const toast = (kind, msg) => {
    if (typeof window._toast === 'function') return window._toast(kind, msg);
    if (typeof window.toast === 'function') return window.toast(kind, msg);
    if (kind === 'error') console.error(msg); else console.log(msg);
  };

  const confirmDialog = async (opts) => {
    if (window.NPModal && typeof window.NPModal.confirm === 'function') {
      return window.NPModal.confirm(opts);
    }
    return window.confirm(opts && opts.message || 'Are you sure?');
  };

  const humanType = (t) => ({
    LAB_REPORT:   'Lab report',
    RADIOLOGY:    'Radiology / scan',
    CONSULTATION: 'Consultation',
    PRESCRIPTION: 'Prescription',
    VACCINATION:  'Vaccination',
    DISCHARGE:    'Discharge summary',
    REFERRAL:     'Referral letter',
    OTHER:        'Other'
  }[t] || (t || 'Record'));

  // Attachment categories are free-text on the backend (attachmentType
  // column), but we offer this fixed list in the UI for consistency —
  // doctors can still type a custom one via the "Other" + note pattern.
  const ATTACHMENT_TYPES = [
    'Lab Report', 'Prescription', 'Scan / Radiology', 'Discharge Summary',
    'Referral Letter', 'Vaccination Certificate', 'Consultation Note', 'Other'
  ];
  const attTypeOptions = (selected) => ATTACHMENT_TYPES.map(t =>
    `<option value="${esc(t)}" ${t === selected ? 'selected' : ''}>${esc(t)}</option>`
  ).join('');

  const fileIcon = (kind, mime) => {
    if (mime && mime.startsWith('image/')) return '\uD83D\uDDBC\uFE0F';
    if (kind === 'PDF' || kind === 'PRESCRIPTION' || (mime && mime.includes('pdf'))) return '\uD83D\uDCC4';
    if (mime && (mime.includes('word') || mime.includes('document'))) return '\uD83D\uDCDD';
    if (mime && (mime.includes('excel') || mime.includes('sheet'))) return '\uD83D\uDCCA';
    return '\uD83D\uDCCE';
  };

  const humanSize = (b) => {
    const n = Number(b || 0);
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const debounce = (fn, ms) => {
    let h; return function () {
      const args = arguments, self = this;
      clearTimeout(h);
      h = setTimeout(() => fn.apply(self, args), ms);
    };
  };

  const today = () => new Date().toISOString().slice(0, 10);

  // ---- module state --------------------------------------------------
  const state = {
    q: '',
    recordType: '',
    dateFrom: '',
    dateTo: '',
    page: 1,
    pageSize: 25,
    total: 0,
    totalPages: 1,
    records: [],
    loading: false,
    editingId: null,      // null = create, otherwise edit
    selectedPatient: null,
    pendingFiles: [],     // File[] pending upload
    pendingLabels: [],    // parallel display names
    pendingTypes: [],     // parallel attachment types
    pendingNotes: [],     // parallel notes
    existingAttachments: []
  };

  // =====================================================================
  //  MOUNT
  // =====================================================================
  function mount() {
    const tab = document.getElementById('historicalTab');
    if (!tab || tab.__hrMounted) return;
    tab.__hrMounted = true;

    portalModal('hrRecordModal');
    portalModal('hrViewModal');

    wireToolbar();
    wireAddButton();
    wireModal();
    wireResponsive();

    // Kick off the initial list load and permission check so the tab is
    // ready before the doctor clicks it. Permission gate lives in the
    // main app.js already.
    initialLoad();
  }

  function portalModal(id) {
    const el = document.getElementById(id);
    if (el && el.parentElement !== document.body) document.body.appendChild(el);
  }

  // =====================================================================
  //  TOOLBAR  \u2014 debounced live search + filters
  // =====================================================================
  function wireToolbar() {
    const input = $('#hrSearchInput');
    const clear = $('#hrSearchClear');
    const type  = $('#hrFilterType');
    const from  = $('#hrFilterFrom');
    const to    = $('#hrFilterTo');
    const reset = $('#hrFilterReset');

    const applySearch = debounce(function () {
      state.q = (input.value || '').trim();
      state.page = 1;
      clear.classList.toggle('hidden', !state.q);
      loadRecords();
    }, 220);

    if (input) input.addEventListener('input', applySearch);
    if (clear) clear.addEventListener('click', () => {
      input.value = ''; state.q = ''; clear.classList.add('hidden');
      state.page = 1; loadRecords(); input.focus();
    });
    if (type)  type.addEventListener('change', () => { state.recordType = type.value; state.page = 1; loadRecords(); });
    if (from)  from.addEventListener('change', () => { state.dateFrom  = from.value;  state.page = 1; loadRecords(); });
    if (to)    to.addEventListener('change',   () => { state.dateTo    = to.value;    state.page = 1; loadRecords(); });
    if (reset) reset.addEventListener('click', () => {
      if (input) input.value = '';
      if (type)  type.value  = '';
      if (from)  from.value  = '';
      if (to)    to.value    = '';
      clear.classList.add('hidden');
      Object.assign(state, { q: '', recordType: '', dateFrom: '', dateTo: '', page: 1 });
      loadRecords();
    });

    $('#hrPagerPrev')?.addEventListener('click', () => { if (state.page > 1) { state.page--; loadRecords(); } });
    $('#hrPagerNext')?.addEventListener('click', () => { if (state.page < state.totalPages) { state.page++; loadRecords(); } });
  }

  function wireAddButton() {
    $('#hrAddBtn')?.addEventListener('click', () => openRecordModal(null));
  }

  function wireResponsive() {
    const mq = window.matchMedia('(max-width: 780px)');
    const paint = () => document.getElementById('historicalTab')?.classList.toggle('hr-compact', mq.matches);
    if (mq.addEventListener) mq.addEventListener('change', paint); else mq.addListener(paint);
    paint();
  }

  // =====================================================================
  //  LIST LOAD  \u2014 /doctor/previous-records
  // =====================================================================
  async function initialLoad() {
    // The permission flag is fetched by the main app.js. We still want to
    // trigger the list; if the endpoint isn't allowed the server rejects
    // and we render an appropriate empty state.
    loadRecords();
  }

  async function loadRecords() {
    state.loading = true;
    renderLoading();
    try {
      const params = new URLSearchParams();
      if (state.q)          params.set('q', state.q);
      if (state.recordType) params.set('recordType', state.recordType);
      if (state.dateFrom)   params.set('dateFrom', state.dateFrom);
      if (state.dateTo)     params.set('dateTo',   state.dateTo);
      params.set('page', String(state.page));
      params.set('pageSize', String(state.pageSize));

      const resp = await api('/doctor/previous-records?' + params.toString());
      const list = Array.isArray(resp)          ? resp
                 : Array.isArray(resp?.records) ? resp.records
                 : [];
      state.records    = list;
      state.total      = Number(resp?.total ?? list.length);
      state.totalPages = Number(resp?.totalPages ?? 1);
      renderList();
    } catch (ex) {
      renderError(ex && ex.message || 'Could not load historical records');
    } finally {
      state.loading = false;
    }
  }

  // Skeleton placeholders shown while the list is in flight. Real
  // shimmering blocks instead of a plain "Loading…" text node, per the
  // mobile/QA fix spec — never show a bare loading text container.
  function skeletonRow() {
    return '<tr class="hr-skel-row">' +
      '<td><span class="hr-skel hr-skel-line"></span><span class="hr-skel hr-skel-line hr-skel-line--xs"></span></td>' +
      '<td><span class="hr-skel hr-skel-line hr-skel-line--sm"></span></td>' +
      '<td><span class="hr-skel hr-skel-chip"></span></td>' +
      '<td><span class="hr-skel hr-skel-line"></span></td>' +
      '<td><span class="hr-skel hr-skel-line hr-skel-line--sm"></span></td>' +
      '<td><span class="hr-skel hr-skel-line hr-skel-line--sm"></span></td>' +
      '</tr>';
  }

  function skeletonCard() {
    return '<div class="hr-skel-card">' +
      '<div class="hr-skel-card__top">' +
        '<span class="hr-skel hr-skel-line" style="width:55%"></span>' +
        '<span class="hr-skel hr-skel-chip"></span>' +
      '</div>' +
      '<span class="hr-skel hr-skel-line" style="width:80%"></span>' +
      '<span class="hr-skel hr-skel-line hr-skel-line--sm"></span>' +
      '</div>';
  }

  function renderLoading() {
    const tbody = $('#hrTableBody');
    const cards = $('#hrCardList');
    if (tbody) tbody.innerHTML = Array.from({ length: 6 }, skeletonRow).join('');
    if (cards) cards.innerHTML = Array.from({ length: 4 }, skeletonCard).join('');
    const count = $('#hrCountLine');
    if (count) count.innerHTML = '<span class="hr-skel hr-skel-line" style="display:inline-block;width:9rem;height:.75rem;vertical-align:middle;"></span>';
    $('#hrPager')?.classList.add('hidden');
  }

  function renderError(msg) {
    const tbody = $('#hrTableBody');
    const cards = $('#hrCardList');
    const html = `<div class="np-error">${esc(msg)}</div>`;
    if (tbody) tbody.innerHTML = `<tr><td colspan="6">${html}</td></tr>`;
    if (cards) cards.innerHTML = html;
    const count = $('#hrCountLine'); if (count) count.textContent = '';
  }

  function renderList() {
    const rows  = state.records;
    const tbody = $('#hrTableBody');
    const cards = $('#hrCardList');
    const count = $('#hrCountLine');
    const filtered = state.q || state.recordType || state.dateFrom || state.dateTo;

    if (count) {
      if (!rows.length) count.textContent = filtered ? 'No records match the current filters.' : 'No historical records yet.';
      else count.textContent = state.total + ' record' + (state.total === 1 ? '' : 's') +
        (filtered ? ' matching filters' : '') +
        ' \u2014 showing page ' + state.page + ' of ' + state.totalPages;
    }

    if (!rows.length) {
      const empty = `
        <div class="np-empty">
          <div class="np-empty__title">${filtered ? 'No matching records' : 'No historical records yet'}</div>
          <div class="np-empty__sub">${filtered ? 'Adjust your search or filters to see more.' : 'Click <b>Add Historical Record</b> to create your first entry.'}</div>
        </div>`;
      if (tbody) tbody.innerHTML = `<tr><td colspan="6">${empty}</td></tr>`;
      if (cards) cards.innerHTML = empty;
      $('#hrPager')?.classList.add('hidden');
      return;
    }

    // Desktop table
    if (tbody) {
      tbody.innerHTML = rows.map(rowHtml).join('');
      wireRowActions(tbody);
    }
    // Mobile cards
    if (cards) {
      cards.innerHTML = rows.map(cardHtml).join('');
      wireRowActions(cards);
    }

    // Pagination
    if (state.totalPages > 1) {
      $('#hrPager')?.classList.remove('hidden');
      $('#hrPagerInfo').textContent = 'Page ' + state.page + ' of ' + state.totalPages;
      $('#hrPagerPrev').disabled = state.page <= 1;
      $('#hrPagerNext').disabled = state.page >= state.totalPages;
    } else {
      $('#hrPager')?.classList.add('hidden');
    }
  }

  function rowHtml(r) {
    const p    = r.patient || {};
    const atts = r.attachments || [];
    return `
      <tr data-id="${esc(r.id)}">
        <td>
          <div class="hr-cell__patient">
            <div class="hr-cell__name">${esc(p.name || '\u2014')}</div>
            <div class="hr-cell__meta">${p.phone ? '+91 ' + esc(p.phone) : ''}</div>
          </div>
        </td>
        <td>${esc(fmtDate(r.recordDate))}</td>
        <td><span class="hr-chip">${esc(humanType(r.recordType))}</span></td>
        <td>
          ${r.title ? `<div class="hr-cell__title">${esc(r.title)}</div>` : ''}
          <div class="hr-cell__diag">${esc(r.diagnosis || '\u2014')}</div>
        </td>
        <td>${atts.length ? `<span class="hr-chip hr-chip--files">${atts.length} file${atts.length === 1 ? '' : 's'}</span>` : '<span class="np-mut">\u2014</span>'}</td>
        <td class="hr-cell__actions">
          <button type="button" class="np-btn np-btn--ghost np-btn--sm" data-hr-view="${esc(r.id)}">View</button>
          <button type="button" class="np-btn np-btn--ghost np-btn--sm" data-hr-edit="${esc(r.id)}">Edit</button>
          <button type="button" class="np-btn np-btn--danger np-btn--sm" data-hr-del="${esc(r.id)}">Delete</button>
        </td>
      </tr>`;
  }

  function cardHtml(r) {
    const p    = r.patient || {};
    const atts = r.attachments || [];
    return `
      <div class="hr-card" data-id="${esc(r.id)}">
        <div class="hr-card__head">
          <div>
            <div class="hr-card__name">${esc(p.name || '\u2014')}</div>
            <div class="hr-card__meta">${esc(fmtDate(r.recordDate))} \u00b7 ${esc(humanType(r.recordType))}</div>
          </div>
          <span class="hr-chip">${atts.length} file${atts.length === 1 ? '' : 's'}</span>
        </div>
        ${r.title     ? `<div class="hr-card__title">${esc(r.title)}</div>` : ''}
        ${r.diagnosis ? `<div class="hr-card__diag"><b>Diagnosis:</b> ${esc(r.diagnosis)}</div>` : ''}
        <div class="hr-card__actions">
          <button type="button" class="np-btn np-btn--ghost np-btn--sm" data-hr-view="${esc(r.id)}">View</button>
          <button type="button" class="np-btn np-btn--ghost np-btn--sm" data-hr-edit="${esc(r.id)}">Edit</button>
          <button type="button" class="np-btn np-btn--danger np-btn--sm" data-hr-del="${esc(r.id)}">Delete</button>
        </div>
      </div>`;
  }

  function wireRowActions(root) {
    $$('[data-hr-view]', root).forEach(b => b.addEventListener('click', () => openViewModal(b.getAttribute('data-hr-view'))));
    $$('[data-hr-edit]', root).forEach(b => b.addEventListener('click', () => openRecordModal(b.getAttribute('data-hr-edit'))));
    $$('[data-hr-del]',  root).forEach(b => b.addEventListener('click', () => deleteRecord(b.getAttribute('data-hr-del'))));
  }

  // =====================================================================
  //  ADD / EDIT MODAL
  // =====================================================================
  function wireModal() {
    // Close handlers (all modals)
    $$('[data-hr-close]').forEach(b => b.addEventListener('click', closeAllModals));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAllModals();    });

    // Add/Edit form submit
    const form = $('#historicalForm');
    if (form && !form.__hrWired) {
      form.__hrWired = true;
      form.addEventListener('submit', submitRecord);
    }

    // Reset button
    $('#histResetBtn')?.addEventListener('click', () => {
      if (state.editingId) loadIntoForm(state.records.find(r => r.id === state.editingId));
      else clearForm();
    });

    // Patient live search
    const psInput = $('#histPatientSearch');
    if (psInput) {
      psInput.addEventListener('input', debounce(patientSearch, 200));
    }

    // Drop zone
    const drop = $('#hrDropZone');
    const fileInput = $('#histRxFile');
    if (drop && fileInput) {
      drop.addEventListener('click', (e) => { if (e.target === drop || e.target.classList.contains('hr-drop__inner') || drop.contains(e.target) && e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') fileInput.click(); });
      drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
      ['dragenter', 'dragover'].forEach(n => drop.addEventListener(n, (e) => { e.preventDefault(); drop.classList.add('is-drop'); }));
      ['dragleave', 'dragend', 'drop'].forEach(n => drop.addEventListener(n, () => drop.classList.remove('is-drop')));
      drop.addEventListener('drop', (e) => {
        e.preventDefault();
        const files = Array.from(e.dataTransfer?.files || []);
        addPendingFiles(files);
      });
      fileInput.addEventListener('change', () => {
        addPendingFiles(Array.from(fileInput.files || []));
        fileInput.value = '';
      });
    }

    // View modal action buttons
    $('#hrViewEditBtn')?.addEventListener('click', () => {
      const id = $('#hrViewModal').getAttribute('data-record-id');
      if (id) { closeModal('hrViewModal'); openRecordModal(id); }
    });
    $('#hrViewPdfBtn')?.addEventListener('click', async () => {
      const id = $('#hrViewModal').getAttribute('data-record-id');
      if (!id) return;
      try {
        const r = await api('/doctor/previous-records/' + encodeURIComponent(id) + '/generate-pdf', { method: 'POST' });
        if (r && r.pdfUrl) window.open(r.pdfUrl, '_blank');
        else toast('error', 'Could not generate PDF');
      } catch (ex) { toast('error', ex && ex.message || 'PDF generation failed'); }
    });
  }

  function closeAllModals() { closeModal('hrRecordModal'); closeModal('hrViewModal'); closeModal('hrAttPreviewModal'); }
  function closeModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.classList.add('hidden');
    document.body.classList.remove('np-modal-open');
  }
  function openModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.classList.remove('hidden');
    document.body.classList.add('np-modal-open');
  }

  function openRecordModal(id) {
    state.editingId = id || null;
    state.pendingFiles = [];
    state.pendingLabels = [];
    state.pendingTypes = [];
    state.pendingNotes = [];
    state.existingAttachments = [];

    // Header text
    $('#hrRecordModalTitle').textContent = id ? 'Edit Historical Record' : 'Add Historical Record';
    $('#hrRecordModalSub').textContent   = id ? 'Update the fields below or manage attachments.' : 'Fill the fields below and attach any supporting documents.';
    $('#histSubmitBtn').textContent      = id ? 'Save changes' : 'Save record';

    // Show/hide patient picker depending on mode
    const picker = $('#hrPatientPickerField');
    if (id) {
      picker && picker.classList.add('hidden');
      const rec = state.records.find(r => r.id === id);
      loadIntoForm(rec);
    } else {
      picker && picker.classList.remove('hidden');
      clearForm();
      $('#hrRecordDate').value = today();
    }
    renderPendingFiles();
    renderExistingAttachments();
    hideFormError();
    openModal('hrRecordModal');
    setTimeout(() => {
      const first = id ? $('#hrRecordDate') : $('#histPatientSearch');
      first && first.focus();
    }, 40);
  }

  function clearForm() {
    const f = $('#historicalForm');
    if (!f) return;
    f.reset();
    $('#histRecordId').value  = '';
    $('#histPatientId').value = '';
    state.selectedPatient = null;
    $('#hrSelectedPatient')?.classList.add('hidden');
    $('#hrPatientResults')?.classList.add('hidden');
    $('#hrExistingAttWrap')?.classList.add('hidden');
    $('#hrPendingList')?.classList.add('hidden');
    state.pendingFiles = [];
    state.pendingLabels = [];
    state.pendingTypes = [];
    state.pendingNotes = [];
    state.existingAttachments = [];
  }

  function loadIntoForm(rec) {
    if (!rec) return;
    const f = $('#historicalForm');
    $('#histRecordId').value  = rec.id;
    $('#histPatientId').value = rec.patient?.id || rec.patientId || '';
    if (rec.patient) {
      state.selectedPatient = rec.patient;
      const sp = $('#hrSelectedPatient');
      sp.innerHTML = `<div class="np-callout np-callout--success"><div><b>${esc(rec.patient.name || '')}</b>${rec.patient.phone ? ' \u00b7 +91 ' + esc(rec.patient.phone) : ''}</div></div>`;
      sp.classList.remove('hidden');
    }
    f.recordDate.value  = rec.recordDate ? String(rec.recordDate).slice(0, 10) : today();
    $('#hrRecordType').value = rec.recordType || 'CONSULTATION';
    $('#hrTitle').value       = rec.title || '';
    $('#hrDiagnosis').value   = rec.diagnosis || '';
    $('#hrNotes').value       = rec.notes || '';
    $('#hrTreatment').value   = rec.treatment || '';
    $('#hrMedications').value = rec.medications || '';
    state.existingAttachments = rec.attachments || [];
    renderExistingAttachments();
  }

  async function patientSearch() {
    const q   = ($('#histPatientSearch')?.value || '').trim();
    const box = $('#hrPatientResults');
    if (!box) return;
    if (q.length < 2) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.innerHTML = '<div class="np-empty" style="padding:.75rem;"><div class="np-empty__title">Searching\u2026</div></div>';
    try {
      const rows = await api('/doctor/patients/search?q=' + encodeURIComponent(q));
      if (!rows || !rows.length) {
        box.innerHTML = '<div class="np-empty" style="padding:.75rem;"><div class="np-empty__title">No matching patient</div><div class="np-empty__sub">Only patients already registered in your clinic can be selected.</div></div>';
        return;
      }
      box.innerHTML = rows.map(p => `
        <button type="button" class="hr-picker__item" data-pid="${esc(p.id)}">
          <div class="hr-picker__name">${esc(p.name || '')}</div>
          <div class="hr-picker__meta">${p.phone ? '+91 ' + esc(p.phone) : ''}${p.parentName ? ' \u00b7 ' + esc(p.parentName) : ''}</div>
        </button>`).join('');
      $$('.hr-picker__item', box).forEach(btn => btn.addEventListener('click', () => {
        const p = rows.find(x => x.id === btn.getAttribute('data-pid'));
        state.selectedPatient = p;
        $('#histPatientId').value = p.id;
        const sp = $('#hrSelectedPatient');
        sp.innerHTML = `<div class="np-callout np-callout--success"><div><b>${esc(p.name)}</b>${p.phone ? ' \u00b7 +91 ' + esc(p.phone) : ''}</div></div>`;
        sp.classList.remove('hidden');
        box.classList.add('hidden');
        $('#histPatientSearch').value = p.name;
      }));
    } catch (ex) {
      box.innerHTML = '<div class="np-error">' + esc(ex && ex.message || 'Search failed') + '</div>';
    }
  }

  // ---- attachments (pending + existing) ------------------------------
  function addPendingFiles(files) {
    const allowed = /^(application\/pdf|image\/(jpeg|jpg|png|webp|gif)|application\/(vnd\.openxmlformats-officedocument\.(word|spreadsheet).+|msword|vnd\.ms-excel))$/i;
    for (const f of files) {
      if (!f) continue;
      if (f.size > 25 * 1024 * 1024) { toast('error', f.name + ' exceeds 25 MB'); continue; }
      if (!allowed.test(f.type) && !/\.(pdf|jpe?g|png|webp|gif|docx?|xlsx?)$/i.test(f.name)) {
        toast('error', 'Unsupported file: ' + f.name); continue;
      }
      state.pendingFiles.push(f);
      state.pendingLabels.push(f.name.replace(/\.[^.]+$/, ''));
      state.pendingTypes.push('');
      state.pendingNotes.push('');
    }
    renderPendingFiles();
  }

  function renderPendingFiles() {
    const wrap = $('#hrPendingList'); if (!wrap) return;
    if (!state.pendingFiles.length) { wrap.classList.add('hidden'); wrap.innerHTML = ''; return; }
    wrap.classList.remove('hidden');
    wrap.innerHTML = state.pendingFiles.map((f, i) => `
      <div class="hr-att hr-att--pending" data-i="${i}">
        <span class="hr-att__icon">${fileIcon(null, f.type)}</span>
        <div class="hr-att__body">
          <input class="hr-att__label np-input np-input--sm" data-label="${i}" value="${esc(state.pendingLabels[i] || f.name)}" placeholder="Display name (e.g. 2023 Prescription)">
          <div class="hr-att__meta">${esc(f.name)} \u00b7 ${humanSize(f.size)}</div>
          <div class="hr-att__metaRow">
            <select class="np-input np-input--sm" data-type="${i}" aria-label="Attachment type">
              <option value="">Attachment type (optional)</option>
              ${attTypeOptions(state.pendingTypes[i])}
            </select>
            <input class="np-input np-input--sm" data-notes="${i}" value="${esc(state.pendingNotes[i] || '')}" placeholder="Notes (optional)">
          </div>
        </div>
        <button type="button" class="np-btn np-btn--ghost np-btn--sm" data-remove="${i}" aria-label="Remove">Remove</button>
      </div>
    `).join('');
    $$('[data-remove]', wrap).forEach(b => b.addEventListener('click', () => {
      const i = parseInt(b.getAttribute('data-remove'), 10);
      state.pendingFiles.splice(i, 1);
      state.pendingLabels.splice(i, 1);
      state.pendingTypes.splice(i, 1);
      state.pendingNotes.splice(i, 1);
      renderPendingFiles();
    }));
    $$('[data-label]', wrap).forEach(inp => inp.addEventListener('input', () => {
      const i = parseInt(inp.getAttribute('data-label'), 10);
      state.pendingLabels[i] = inp.value;
    }));
    $$('[data-type]', wrap).forEach(sel => sel.addEventListener('change', () => {
      const i = parseInt(sel.getAttribute('data-type'), 10);
      state.pendingTypes[i] = sel.value;
    }));
    $$('[data-notes]', wrap).forEach(inp => inp.addEventListener('input', () => {
      const i = parseInt(inp.getAttribute('data-notes'), 10);
      state.pendingNotes[i] = inp.value;
    }));
  }

  function renderExistingAttachments() {
    const wrap = $('#hrExistingAtt');
    const outer = $('#hrExistingAttWrap');
    if (!wrap || !outer) return;
    const atts = state.existingAttachments || [];
    if (!atts.length || !state.editingId) { outer.classList.add('hidden'); wrap.innerHTML = ''; return; }
    outer.classList.remove('hidden');
    wrap.innerHTML = atts.map((a, i) => `
      <div class="hr-att" data-att-id="${esc(a.id)}">
        <div class="hr-att__reorder">
          <button type="button" class="hr-att__moveBtn" data-att-up="${esc(a.id)}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>&#9650;</button>
          <button type="button" class="hr-att__moveBtn" data-att-down="${esc(a.id)}" aria-label="Move down" ${i === atts.length - 1 ? 'disabled' : ''}>&#9660;</button>
        </div>
        <span class="hr-att__icon">${fileIcon(a.kind, a.mimeType)}</span>
        <div class="hr-att__body">
          <div class="hr-att__viewRow" data-view-row>
            <div class="hr-att__label">${esc(a.label || a.originalName)}</div>
            <div class="hr-att__meta">
              ${a.attachmentType ? `<span class="hr-chip">${esc(a.attachmentType)}</span> \u00b7 ` : ''}${esc(a.originalName)} \u00b7 ${humanSize(a.sizeBytes)} \u00b7 ${esc(fmtDate(a.createdAt))}
            </div>
            ${a.notes ? `<div class="hr-att__notes">${esc(a.notes)}</div>` : ''}
          </div>
          <div class="hr-att__editRow hidden" data-edit-row>
            <input class="np-input np-input--sm" data-edit-label value="${esc(a.label || '')}" placeholder="Display name">
            <select class="np-input np-input--sm" data-edit-type aria-label="Attachment type">
              <option value="">No type</option>
              ${attTypeOptions(a.attachmentType)}
            </select>
            <input class="np-input np-input--sm" data-edit-notes value="${esc(a.notes || '')}" placeholder="Notes (optional)">
            <div class="hr-att__editActions">
              <button type="button" class="np-btn np-btn--primary np-btn--sm" data-edit-save="${esc(a.id)}">Save</button>
              <button type="button" class="np-btn np-btn--ghost np-btn--sm" data-edit-cancel="${esc(a.id)}">Cancel</button>
            </div>
          </div>
        </div>
        <div class="hr-att__actions">
          <button type="button" class="np-btn np-btn--ghost np-btn--sm" data-att-preview="${esc(a.id)}">Preview</button>
          <a class="np-btn np-btn--ghost np-btn--sm" href="${esc(a.downloadUrl || '#')}">Download</a>
          <div class="hr-att__more">
            <button type="button" class="np-btn np-btn--ghost np-btn--sm hr-att__moreBtn" data-att-more="${esc(a.id)}" aria-haspopup="true" aria-expanded="false" aria-label="More actions">&#8942;</button>
            <div class="hr-att__moreMenu hidden" data-more-menu>
              <button type="button" data-att-rename="${esc(a.id)}">Rename</button>
              <button type="button" data-att-replace="${esc(a.id)}">Replace</button>
              <button type="button" class="is-danger" data-att-delete="${esc(a.id)}">Delete</button>
            </div>
          </div>
        </div>
      </div>`).join('');
    $$('[data-att-delete]', wrap).forEach(b => b.addEventListener('click', () => { closeAllAttMenus(); deleteExistingAttachment(b.getAttribute('data-att-delete')); }));
    $$('[data-att-replace]', wrap).forEach(b => b.addEventListener('click', () => { closeAllAttMenus(); replaceExistingAttachment(b.getAttribute('data-att-replace')); }));
    $$('[data-att-preview]', wrap).forEach(b => b.addEventListener('click', () => {
      const a = state.existingAttachments.find(x => x.id === b.getAttribute('data-att-preview'));
      if (a) openAttachmentPreview(a);
    }));
    $$('[data-att-up]', wrap).forEach(b => b.addEventListener('click', () => moveAttachment(b.getAttribute('data-att-up'), -1)));
    $$('[data-att-down]', wrap).forEach(b => b.addEventListener('click', () => moveAttachment(b.getAttribute('data-att-down'), 1)));
    $$('[data-att-more]', wrap).forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = b.parentElement.querySelector('[data-more-menu]');
      const wasOpen = !menu.classList.contains('hidden');
      closeAllAttMenus();
      if (!wasOpen) { menu.classList.remove('hidden'); b.setAttribute('aria-expanded', 'true'); }
    }));
    $$('[data-att-rename]', wrap).forEach(b => b.addEventListener('click', () => {
      closeAllAttMenus();
      const row = b.closest('[data-att-id]');
      row?.querySelector('[data-view-row]')?.classList.add('hidden');
      row?.querySelector('[data-edit-row]')?.classList.remove('hidden');
    }));
    $$('[data-edit-cancel]', wrap).forEach(b => b.addEventListener('click', () => {
      const row = b.closest('[data-att-id]');
      row?.querySelector('[data-edit-row]')?.classList.add('hidden');
      row?.querySelector('[data-view-row]')?.classList.remove('hidden');
    }));
    $$('[data-edit-save]', wrap).forEach(b => b.addEventListener('click', () => saveAttachmentMeta(b.getAttribute('data-edit-save'))));
  }

  function closeAllAttMenus() {
    $$('[data-more-menu]').forEach(m => m.classList.add('hidden'));
    $$('[data-att-more]').forEach(b => b.setAttribute('aria-expanded', 'false'));
  }
  document.addEventListener('click', closeAllAttMenus);

  async function saveAttachmentMeta(attId) {
    if (!state.editingId) return;
    const row = $(`[data-att-id="${attId}"]`, $('#hrExistingAtt'));
    if (!row) return;
    const label = row.querySelector('[data-edit-label]')?.value.trim();
    const attachmentType = row.querySelector('[data-edit-type]')?.value || '';
    const notes = row.querySelector('[data-edit-notes]')?.value.trim() || '';
    try {
      await api('/doctor/previous-records/' + encodeURIComponent(state.editingId) + '/attachments/' + encodeURIComponent(attId), {
        method: 'PATCH',
        body: { label, attachmentType, notes }
      });
      const a = state.existingAttachments.find(x => x.id === attId);
      if (a) { a.label = label || a.label; a.attachmentType = attachmentType || null; a.notes = notes || null; }
      renderExistingAttachments();
      toast('success', 'Attachment updated');
      loadRecords();
    } catch (ex) { toast('error', ex && ex.message || 'Could not update attachment'); }
  }

  async function moveAttachment(attId, dir) {
    if (!state.editingId) return;
    const list = state.existingAttachments;
    const i = list.findIndex(a => a.id === attId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    renderExistingAttachments();
    try {
      await api('/doctor/previous-records/' + encodeURIComponent(state.editingId) + '/attachments/reorder', {
        method: 'PATCH',
        body: { order: list.map(a => a.id) }
      });
    } catch (ex) { toast('error', ex && ex.message || 'Could not save new order'); }
  }

  // ---- attachment preview modal ---------------------------------------
  function openAttachmentPreview(att) {
    const body = $('#hrAttPreviewBody');
    const isImg = att.mimeType && att.mimeType.startsWith('image/');
    const isPdf = att.mimeType === 'application/pdf' || /\.pdf$/i.test(att.originalName || '');
    if (isImg) {
      body.innerHTML = `<img class="hr-preview__img" src="${esc(att.viewUrl)}" alt="${esc(att.label || att.originalName || 'Attachment')}">`;
    } else if (isPdf) {
      body.innerHTML = `<iframe class="hr-preview__frame" src="${esc(att.viewUrl)}" title="${esc(att.label || att.originalName || 'Attachment')}"></iframe>`;
    } else {
      body.innerHTML = `<div class="np-empty"><div class="np-empty__title">No inline preview for this file type</div><div class="np-mut" style="margin-top:.35rem;">Use Open or Download instead.</div></div>`;
    }
    $('#hrAttPreviewTitle').textContent = att.label || att.originalName || 'Attachment';
    $('#hrAttPreviewSub').textContent = [att.attachmentType, att.originalName].filter(Boolean).join(' \u00b7 ');
    $('#hrAttPreviewDownload').href = att.downloadUrl || '#';
    openModal('hrAttPreviewModal');
  }

  async function deleteExistingAttachment(attId) {
    if (!state.editingId) return;
    const ok = await confirmDialog({ title: 'Delete attachment?', message: 'This will permanently remove the file from this record.', danger: true, okText: 'Delete' });
    if (!ok) return;
    try {
      await api('/doctor/previous-records/' + encodeURIComponent(state.editingId) + '/attachments/' + encodeURIComponent(attId), { method: 'DELETE' });
      state.existingAttachments = state.existingAttachments.filter(a => a.id !== attId);
      renderExistingAttachments();
      toast('success', 'Attachment deleted');
      loadRecords();
    } catch (ex) { toast('error', ex && ex.message || 'Could not delete attachment'); }
  }

  function replaceExistingAttachment(attId) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.pdf,image/*,.docx,.xlsx';
    inp.onchange = async () => {
      if (!inp.files[0]) return;
      const fd = new FormData();
      fd.append('file', inp.files[0]);
      try {
        await api('/doctor/previous-records/' + encodeURIComponent(state.editingId) + '/attachments/' + encodeURIComponent(attId) + '/replace', { method: 'POST', body: fd });
        toast('success', 'Attachment replaced');
        await refreshEditingRecord();
      } catch (ex) { toast('error', ex && ex.message || 'Replace failed'); }
    };
    inp.click();
  }

  async function refreshEditingRecord() {
    if (!state.editingId) return;
    try {
      const r = await api('/doctor/previous-records/' + encodeURIComponent(state.editingId));
      const rec = r && r.record ? r.record : null;
      if (rec) {
        state.existingAttachments = rec.attachments || [];
        renderExistingAttachments();
      }
      loadRecords();
    } catch (_) { /* fall through */ }
  }

  // ---- submit --------------------------------------------------------
  async function submitRecord(e) {
    e.preventDefault();
    hideFormError();
    const editingId = $('#histRecordId').value || state.editingId;
    const patientId = $('#histPatientId').value || (state.selectedPatient && state.selectedPatient.id);
    const recordDate = $('#hrRecordDate').value;

    if (!editingId && !patientId) { showFormError('Please select a patient first.'); return; }
    if (!recordDate)              { showFormError('Please choose a record date.'); return; }

    const fd = new FormData();
    fd.append('recordDate',  recordDate);
    fd.append('recordType',  $('#hrRecordType').value || 'CONSULTATION');
    fd.append('title',       $('#hrTitle').value.trim());
    fd.append('diagnosis',   $('#hrDiagnosis').value.trim());
    fd.append('notes',       $('#hrNotes').value.trim());
    fd.append('treatment',   $('#hrTreatment').value.trim());
    fd.append('medications', $('#hrMedications').value.trim());
    // v3.4.4 route accepts multer.array('attachment', 20) \u2014 append each file
    // under the same field name plus a parallel labels[] value.
    state.pendingFiles.forEach((f, i) => {
      fd.append('attachment', f, f.name);
      fd.append('labels[]',   state.pendingLabels[i] || f.name);
      fd.append('attachmentTypes[]', state.pendingTypes[i] || '');
      fd.append('attachmentNotes[]', state.pendingNotes[i] || '');
    });

    const submitBtn = $('#histSubmitBtn');
    submitBtn.disabled = true;
    const originalLabel = submitBtn.textContent;
    submitBtn.textContent = editingId ? 'Saving\u2026' : 'Saving\u2026';

    try {
      let saved;
      if (editingId) {
        saved = await api('/doctor/previous-records/' + encodeURIComponent(editingId), { method: 'PUT', body: fd });
      } else {
        saved = await api('/doctor/patients/' + encodeURIComponent(patientId) + '/previous-records', { method: 'POST', body: fd });
      }
      toast('success', editingId ? 'Record updated' : 'Record added');
      closeModal('hrRecordModal');
      await loadRecords();
    } catch (ex) {
      const msg = ex && (ex.message || (ex.data && (ex.data.error || ex.data.message))) || 'Could not save record';
      showFormError(msg);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  }

  function showFormError(msg) {
    const el = $('#hrFormError');
    if (!el) { toast('error', msg); return; }
    el.textContent = msg;
    el.classList.remove('hidden');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function hideFormError() {
    const el = $('#hrFormError'); if (!el) return;
    el.classList.add('hidden'); el.textContent = '';
  }

  // =====================================================================
  //  DELETE
  // =====================================================================
  async function deleteRecord(id) {
    const ok = await confirmDialog({
      title: 'Delete historical record?',
      message: 'This record and its attachments will be removed from the patient timeline. This action cannot be undone.',
      danger: true, okText: 'Delete'
    });
    if (!ok) return;
    try {
      await api('/doctor/previous-records/' + encodeURIComponent(id), { method: 'DELETE' });
      toast('success', 'Record deleted');
      // Remove locally for instant feedback, then reload for authoritative state.
      state.records = state.records.filter(r => r.id !== id);
      renderList();
      loadRecords();
    } catch (ex) { toast('error', ex && ex.message || 'Could not delete record'); }
  }

  // =====================================================================
  //  VIEW MODAL (read-only)
  // =====================================================================
  async function openViewModal(id) {
    const modal = $('#hrViewModal');
    modal.setAttribute('data-record-id', id);
    $('#hrViewContent').innerHTML = '<div class="hr-view__grid">' +
      Array.from({ length: 5 }, () =>
        '<div class="hr-view__row"><span class="hr-skel hr-skel-line hr-skel-line--sm"></span><span class="hr-skel hr-skel-line" style="margin-top:.3rem;"></span></div>'
      ).join('') + '</div>';
    openModal('hrViewModal');
    try {
      const r = await api('/doctor/previous-records/' + encodeURIComponent(id));
      const rec = r && r.record ? r.record : null;
      if (!rec) throw new Error('Record not found');
      renderViewContent(rec);
    } catch (ex) {
      $('#hrViewContent').innerHTML = '<div class="np-error">' + esc(ex && ex.message || 'Could not load record') + '</div>';
    }
  }

  function renderViewContent(rec) {
    const p = rec.patient || {};
    const atts = rec.attachments || [];
    $('#hrViewModalTitle').textContent = rec.title || (humanType(rec.recordType) + ' \u2014 ' + fmtDate(rec.recordDate));
    $('#hrViewModalSub').textContent   = (p.name || '') + (p.phone ? ' \u00b7 +91 ' + p.phone : '');
    const kv = (k, v) => v ? `<div class="hr-view__row"><div class="hr-view__key">${esc(k)}</div><div class="hr-view__val">${esc(v)}</div></div>` : '';
    const attHtml = atts.length
      ? `<div class="hr-view__section">
           <div class="hr-view__section-title">Attachments (${atts.length})</div>
           ${atts.map(a => `
             <div class="hr-att" data-att-id="${esc(a.id)}">
               <span class="hr-att__icon">${fileIcon(a.kind, a.mimeType)}</span>
               <div class="hr-att__body">
                 <div class="hr-att__label">${esc(a.label || a.originalName)}</div>
                 <div class="hr-att__meta">
                   ${a.attachmentType ? `<span class="hr-chip">${esc(a.attachmentType)}</span> \u00b7 ` : ''}${esc(a.originalName)} \u00b7 ${humanSize(a.sizeBytes)} \u00b7 uploaded ${esc(fmtDate(a.createdAt))}
                 </div>
                 ${a.notes ? `<div class="hr-att__notes">${esc(a.notes)}</div>` : ''}
               </div>
               <div class="hr-att__actions">
                 <button type="button" class="np-btn np-btn--ghost np-btn--sm" data-view-att-preview="${esc(a.id)}">Preview</button>
                 <a class="np-btn np-btn--ghost np-btn--sm" href="${esc(a.downloadUrl || '#')}">Download</a>
               </div>
             </div>`).join('')}
         </div>`
      : '<div class="np-mut" style="margin-top:.5rem;">No attachments on this record.</div>';

    $('#hrViewContent').innerHTML = `
      <div class="hr-view">
        <div class="hr-view__grid">
          ${kv('Patient',      p.name)}
          ${kv('Phone',        p.phone ? '+91 ' + p.phone : '')}
          ${kv('Record date',  fmtDate(rec.recordDate))}
          ${kv('Record type',  humanType(rec.recordType))}
          ${kv('Title',        rec.title)}
          ${kv('Diagnosis',    rec.diagnosis)}
          ${kv('Notes',        rec.notes)}
          ${kv('Treatment',    rec.treatment)}
          ${kv('Medications',  rec.medications)}
        </div>
        ${attHtml}
      </div>`;
    $$('[data-view-att-preview]', $('#hrViewContent')).forEach(b => b.addEventListener('click', () => {
      const a = atts.find(x => x.id === b.getAttribute('data-view-att-preview'));
      if (a) openAttachmentPreview(a);
    }));
  }

  // =====================================================================
  //  BACK-COMPAT SHIMS  \u2014 keep external callers (share/pdf helpers used
  //  elsewhere in the codebase) working exactly as before.
  // =====================================================================
  window.hrRenderAttachments = function (container, record) {
    if (!container) return;
    const atts = (record && record.attachments) || [];
    container.innerHTML = atts.map(a => `
      <div class="hr-att" data-id="${esc(a.id)}">
        <span class="hr-att__name">${esc(a.label || a.originalName)}</span>
        <a href="${esc(a.viewUrl)}" target="_blank" rel="noopener">Preview</a>
        <a href="${esc(a.downloadUrl)}">Download</a>
        <a href="${esc(a.viewUrl)}" target="_blank" rel="noopener">Open in new tab</a>
      </div>`).join('') || '<p class="np-empty">No attachments yet</p>';
  };
  window.hrShare = async function (recordId, channel) {
    try {
      const r = await api('/doctor/previous-records/' + encodeURIComponent(recordId) + '/share', {
        method: 'POST', body: JSON.stringify({ channel }),
        headers: { 'Content-Type': 'application/json' }
      });
      if (r && r.success) toast('success', 'Shared via ' + channel + ' successfully.');
      else toast('error', 'Share failed');
    } catch (ex) { toast('error', ex && ex.message || 'Share failed'); }
  };
  window.hrGeneratePdf = async function (recordId) {
    try {
      const r = await api('/doctor/previous-records/' + encodeURIComponent(recordId) + '/generate-pdf', { method: 'POST' });
      if (r && r.pdfUrl) window.open(r.pdfUrl, '_blank');
    } catch (ex) { toast('error', ex && ex.message || 'PDF generation failed'); }
  };

  // Expose a public re-init entry-point so app.js can still call the
  // legacy initHistoricalForm() name after switching tabs.
  window.initHistoricalForm = function () {
    // The panel is now always live \u2014 nothing to init per-tab-switch.
    // But we still refresh the list so newly-created records show up.
    if (document.getElementById('historicalTab')) loadRecords();
  };

  // =====================================================================
  //  BOOT
  // =====================================================================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
