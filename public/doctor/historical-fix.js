/* =====================================================================
   historical-fix.js  \u2014  v3.4.6 Doctor Panel: full Previous Records
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

  // ---- patient ownership helpers (Patient Linkage fix) ----------------
  // A record's "owner" is either a real directory patient (r.patient set,
  // patientSource 'EXISTING') or a manually-entered legacy patient
  // (patientSource 'LEGACY', legacyPatientName etc). These two helpers
  // are the single source of truth every render function pulls from, so
  // the list, cards, and View/Edit modals never disagree about whose
  // record it is.
  const isLegacy = (r) => (r && r.patientSource === 'LEGACY');
  const ownerName = (r) => isLegacy(r) ? (r.legacyPatientName || 'Legacy patient') : ((r && r.patient && r.patient.name) || '\u2014');
  const ownerPhone = (r) => isLegacy(r) ? (r.legacyPatientPhone || '') : ((r && r.patient && r.patient.phone) || '');
  const ownershipChip = (r) => isLegacy(r)
    ? '<span class="hr-chip hr-chip--legacy">Legacy / Historical Patient</span>'
    : '<span class="hr-chip hr-chip--linked">Linked NeoKidsPro Patient</span>';

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
    existingAttachments: [],
    modalStack: []        // ids of currently-open modals, in open order
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
    // BUGFIX (Preview button): #hrAttPreviewModal must be portaled LAST.
    // portalModal() uses appendChild, which *moves* an element to the
    // end of <body>. hrAttPreviewModal already sits at the end of the
    // document (see index.html), so once the two calls above moved
    // hrRecordModal/hrViewModal to the very end of <body>, the preview
    // modal was left BEFORE them in DOM order. All three share the same
    // `.np-modal` z-index (1300), so with equal z-index, later DOM
    // position wins the paint order — the still-open Edit/View modal
    // was rendering on TOP of the preview modal, completely hiding it.
    // That's the "brief flash then nothing" symptom: the preview modal
    // *did* open, it was just stacked underneath the modal you opened
    // it from. Portaling it last guarantees it's always the topmost
    // element whenever it's shown.
    portalModal('hrAttPreviewModal');

    wireToolbar();
    wireAddButton();
    wireModal();
    wireResponsive();

    // v3.4.10 (part 5) — hardware/browser back button integration for
    // the attachment preview. If the preview is open when the back
    // event fires, we close ONLY the preview (leaving the parent
    // Previous Record / View modal in place, same as the header ✕ and
    // the header Back button) and swallow the navigation.
    window.addEventListener('popstate', () => {
      const previewOpen = !document.getElementById('hrAttPreviewModal')?.classList.contains('hidden');
      if (previewOpen) {
        // pushState → popstate has already popped the history entry, so
        // just clear our flag and close the modal directly (don't call
        // history.back() again from closeModal).
        state.previewPushed = false;
        closeModal('hrAttPreviewModal');
      }
    });

    // Kick off the initial list load and permission check so the tab is
    // ready before the doctor clicks it. Permission gate lives in the
    // main app.js already.
    initialLoad();
  }

  function portalModal(id) {
    const el = document.getElementById(id);
    // BUGFIX (attachment Preview never opening): this used to skip the
    // appendChild whenever the element was ALREADY a direct child of
    // <body> (`if (el.parentElement !== document.body) …`). That guard
    // was meant as a harmless no-op optimisation, but appendChild is
    // being used here for its side effect of *reordering* — it moves
    // the node to become the LAST child of body, which is what decides
    // paint order among the (all-equal-z-index) portaled modals.
    // #hrAttPreviewModal already sits at the end of <body> in the raw
    // HTML, so the guard made its portalModal() call a no-op. Then the
    // two calls before it (hrRecordModal / hrViewModal) — whose modals
    // start out NESTED inside the panel, so the guard doesn't block
    // them — got appendChild'd *past* hrAttPreviewModal's original
    // position, leaving the preview modal first (i.e. UNDERNEATH the
    // still-open Edit/View modal) instead of last. Clicking "Preview"
    // did open it — it was just rendering beneath the modal you opened
    // it from, so nothing appeared to happen. Always appendChild, with
    // no guard, so every call unconditionally moves its element to the
    // new end of <body>, regardless of where it already was.
    if (el) document.body.appendChild(el);
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
      renderError(ex && ex.message || 'Could not load previous records');
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
      if (!rows.length) count.textContent = filtered ? 'No records match the current filters.' : 'No previous records yet.';
      else count.textContent = state.total + ' record' + (state.total === 1 ? '' : 's') +
        (filtered ? ' matching filters' : '') +
        ' \u2014 showing page ' + state.page + ' of ' + state.totalPages;
    }

    if (!rows.length) {
      const empty = `
        <div class="np-empty">
          <div class="np-empty__title">${filtered ? 'No matching records' : 'No previous records yet'}</div>
          <div class="np-empty__sub">${filtered ? 'Adjust your search or filters to see more.' : 'Click <b>Add Previous Record</b> to create your first entry.'}</div>
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
    const atts = r.attachments || [];
    return `
      <tr data-id="${esc(r.id)}">
        <td>
          <div class="hr-cell__patient">
            <div class="hr-cell__name">${esc(ownerName(r))}</div>
            <div class="hr-cell__meta">${ownerPhone(r) ? '+91 ' + esc(ownerPhone(r)) : ''}</div>
            <div class="hr-cell__owner">${ownershipChip(r)}</div>
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
    const atts = r.attachments || [];
    return `
      <div class="hr-card" data-id="${esc(r.id)}">
        <div class="hr-card__head">
          <div>
            <div class="hr-card__name">${esc(ownerName(r))}</div>
            <div class="hr-card__meta">${esc(fmtDate(r.recordDate))} \u00b7 ${esc(humanType(r.recordType))}</div>
            <div class="hr-card__owner">${ownershipChip(r)}</div>
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
    // Close handlers.
    // BUGFIX (Preview closes the parent View/Edit modal): every
    // [data-hr-close] button — including the one inside
    // #hrAttPreviewModal — used to call closeAllModals(), which hides
    // hrRecordModal + hrViewModal + hrAttPreviewModal together. So
    // closing the attachment preview from inside the View modal also
    // closed the View modal underneath it. Each close button now only
    // closes the single modal it actually lives inside (via the nearest
    // .np-modal ancestor), so the preview can close on its own and
    // leave the parent record modal open and in place.
    $$('[data-hr-close]').forEach(b => b.addEventListener('click', () => {
      const owner = b.closest('.np-modal');
      if (owner && owner.id) closeModal(owner.id);
      else closeTopModal();
    }));
    // Escape closes only the topmost open modal (e.g. the preview, if
    // it's open) rather than every modal at once, for the same reason.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeTopModal();
    });

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

    // Patient source toggle (Existing NeoKidsPro Patient <-> Legacy / Historical Patient)
    // These are user-driven switches, so no {initial:true} — which is
    // exactly what triggers the "clear the leaving branch + refresh the
    // ownership badge" behaviour in setPatientSource().
    $('#hrSourceExistingBtn')?.addEventListener('click', () => setPatientSource('EXISTING'));
    $('#hrSourceLegacyBtn')?.addEventListener('click', () => setPatientSource('LEGACY'));

    // Keep the ownership badge live-updated as the doctor types a legacy
    // patient name (previously it only refreshed on toggle-switch, so the
    // header still said "Enter the historical patient’s details below"
    // after the name was filled in).
    $('#hrLegacyName')?.addEventListener('input', debounce(() => {
      if ($('#hrPatientSource')?.value === 'LEGACY') refreshOwnershipBadge();
    }, 250));

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

  // BUGFIX (Preview closes the parent View/Edit modal): openModal/
  // closeModal now track a stack of currently-open modal ids.
  // closeModal(id) only ever removes that one id — closing the preview
  // (top of stack) leaves hrViewModal/hrRecordModal underneath it open
  // and untouched, and the body scroll-lock class is only released once
  // the stack is fully empty (so it doesn't unlock the page behind a
  // still-open parent modal). closeTopModal() is for triggers — Escape,
  // a close button not clearly inside one modal — that should only ever
  // affect whichever modal is currently on top.
  function closeModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.classList.add('hidden');
    state.modalStack = (state.modalStack || []).filter(x => x !== id);
    if (!state.modalStack.length) document.body.classList.remove('np-modal-open');
    // v3.4.10 — keep the global back-nav stack in sync so device Back
    // remains one-modal-at-a-time behavior after programmatic closes.
    try { if (window.NPBackNav) window.NPBackNav.popModal(id); } catch(_){}
    // Legacy preview-only history bookkeeping is now redundant with
    // NPBackNav.popModal above, but kept as a safety net for older paths.
    if (id === 'hrAttPreviewModal' && state.previewPushed) {
      state.previewPushed = false;
    }
  }
  function openModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.classList.remove('hidden');
    document.body.classList.add('np-modal-open');
    state.modalStack = (state.modalStack || []).filter(x => x !== id);
    state.modalStack.push(id);
    // v3.4.10 — register with the global back-nav manager so device
    // Back closes THIS overlay first instead of exiting the page.
    try { if (window.NPBackNav) window.NPBackNav.pushModal(id); } catch(_){}
  }
  function closeTopModal() {
    const top = (state.modalStack || [])[state.modalStack.length - 1];
    if (top) closeModal(top);
  }

  // ---- patient source toggle (Patient Linkage fix) --------------------
  //
  // v3.4.10 (part 5) — the highest-priority defect the QA report keeps
  // hitting is that a doctor could have a Linked NeoKidsPro Patient AND
  // type into the Legacy fields at the same time. The previous version
  // of setPatientSource() correctly hid + disabled the inactive panel,
  // but three real leaks remained:
  //
  //   (a) `disabled` only affects text inputs / selects / textareas / buttons.
  //       Contenteditable elements, wrapping <label>s that forward clicks,
  //       and (crucially) autofill events still poked values into the
  //       hidden panel's fields. We now also add `readonly`, `tabindex=-1`,
  //       `aria-hidden=true`, `inert` (where supported) AND `pointer-events:
  //       none` on the whole inactive panel so it is unreachable by any
  //       keyboard, touch, mouse or accessibility interaction path.
  //
  //   (b) Switching to LEGACY did not clear the ownership state — the
  //       ownership badge kept saying "Linked NeoKidsPro Patient", the
  //       hidden #histPatientId still held a real patient id, and the
  //       search input still held a name. So even though the legacy
  //       fields WERE editable, the doctor was staring at a form claiming
  //       to link a NeoKidsPro patient while entering a legacy patient.
  //       That's the conflicting ownership data the report describes.
  //       Switching source now fully resets whichever branch is being
  //       LEFT behind (patient selection cleared when moving to LEGACY,
  //       legacy fields wiped when moving to EXISTING) and refreshes the
  //       ownership badge so it always agrees with the toggle.
  //
  //   (c) The inactive panel's DOM values still made it into submit
  //       payloads through direct .value reads in submitRecord(). We
  //       already skipped those keys, but a safety pass at the toggle
  //       level (explicitly clearing hidden inputs on switch) means even
  //       a stray future call site cannot leak the wrong-branch data.
  //
  // The result: at any given moment exactly one branch is interactive,
  // exactly one branch's fields hold data, and the visible ownership
  // badge, the hidden #hrPatientSource field, and the record's saved
  // linkage are guaranteed to agree.
  function setPatientSource(source, opts) {
    source = (source === 'LEGACY') ? 'LEGACY' : 'EXISTING';
    const previous = ($('#hrPatientSource')?.value === 'LEGACY') ? 'LEGACY' : 'EXISTING';
    const initial  = !!(opts && opts.initial); // internal call from loadIntoForm/openRecordModal

    $('#hrPatientSource').value = source;
    $('#hrSourceExistingBtn')?.classList.toggle('is-active', source === 'EXISTING');
    $('#hrSourceExistingBtn')?.setAttribute('aria-selected', String(source === 'EXISTING'));
    $('#hrSourceExistingBtn')?.setAttribute('tabindex', source === 'EXISTING' ? '0' : '-1');
    $('#hrSourceLegacyBtn')?.classList.toggle('is-active', source === 'LEGACY');
    $('#hrSourceLegacyBtn')?.setAttribute('aria-selected', String(source === 'LEGACY'));
    $('#hrSourceLegacyBtn')?.setAttribute('tabindex', source === 'LEGACY' ? '0' : '-1');

    const exPanel = $('#hrExistingPatientPanel');
    const lgPanel = $('#hrLegacyPatientPanel');

    // Panel visibility — both a .hidden class AND inline display so no
    // stray display rule can override us. Also add .hr-panel--off which
    // is a hard "unreachable" style: pointer-events:none, opacity dim,
    // no text selection, tabindex=-1 on descendants (handled below).
    if (exPanel) {
      exPanel.classList.toggle('hidden', source === 'LEGACY');
      exPanel.style.display = (source === 'LEGACY') ? 'none' : '';
      exPanel.classList.toggle('hr-panel--off', source === 'LEGACY');
      applyInertToPanel(exPanel, source === 'LEGACY');
    }
    if (lgPanel) {
      lgPanel.classList.toggle('hidden', source !== 'LEGACY');
      lgPanel.style.display = (source === 'LEGACY') ? '' : 'none';
      lgPanel.classList.toggle('hr-panel--off', source !== 'LEGACY');
      applyInertToPanel(lgPanel, source !== 'LEGACY');
    }

    // Hidden inputs OUTSIDE the branch panels — mutual exclusivity at
    // the payload level too, regardless of what submitRecord() does with
    // them.
    const pidEl = $('#histPatientId'); if (pidEl) pidEl.disabled = (source === 'LEGACY');
    const srcEl = $('#hrPatientSource'); if (srcEl) srcEl.disabled = false;

    // On a REAL source change (not the initial pre-fill), reset the
    // branch we're leaving so the two states can never coexist. Skipped
    // on initial load so pre-filling an EXISTING record from the server
    // doesn't clobber its legacy fallback fields, and vice versa.
    if (!initial && previous !== source) {
      if (source === 'LEGACY') {
        // Leaving EXISTING → clear any linked NeoKidsPro patient.
        state.selectedPatient = null;
        if (pidEl) { pidEl.disabled = true; pidEl.value = ''; }
        const ps = $('#histPatientSearch'); if (ps) ps.value = '';
        $('#hrSelectedPatient')?.classList.add('hidden');
        const sp = $('#hrSelectedPatient'); if (sp) sp.innerHTML = '';
        $('#hrPatientResults')?.classList.add('hidden');
        const pr = $('#hrPatientResults'); if (pr) pr.innerHTML = '';
      } else {
        // Leaving LEGACY → clear the manually-entered legacy fields.
        ['hrLegacyName','hrLegacyPhone','hrLegacyDob','hrLegacyGender','hrLegacyGuardian','hrLegacyNotes']
          .forEach(id2 => { const el = $('#' + id2); if (el) el.value = ''; });
      }
      // Ownership badge must always mirror the current toggle state —
      // stale "Linked NeoKidsPro Patient" text after switching to Legacy
      // is exactly the "conflicting ownership data" the report calls out.
      refreshOwnershipBadge();
    }
  }

  // Marks a whole panel as unreachable to keyboard, touch, autofill and
  // AT. This is what makes the inactive branch genuinely non-functional
  // (rather than merely invisible). `inert` isn't universal yet, so we
  // combine every mechanism that IS supported.
  function applyInertToPanel(root, off) {
    if (!root) return;
    if (off) {
      root.setAttribute('aria-hidden', 'true');
      try { root.inert = true; } catch (_) { /* older browsers */ }
    } else {
      root.removeAttribute('aria-hidden');
      try { root.inert = false; } catch (_) { /* older browsers */ }
    }
    $$('input, button, select, textarea, a', root).forEach(el => {
      el.disabled = !!off;
      if (off) {
        el.setAttribute('tabindex', '-1');
        // readonly on text-ish inputs blocks typing/paste even if some
        // future style rule accidentally re-enables the field.
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          el.setAttribute('readonly', 'readonly');
        }
      } else {
        el.removeAttribute('tabindex');
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          el.removeAttribute('readonly');
        }
      }
    });
  }

  // Keeps the "Currently linked to" ownership summary in sync with the
  // current toggle state / selected patient. Called after switching
  // sources and after picking a patient / clearing the selection.
  function refreshOwnershipBadge() {
    const badge = $('#hrOwnershipBadge');
    if (!badge) return;
    const source = ($('#hrPatientSource')?.value === 'LEGACY') ? 'LEGACY' : 'EXISTING';
    if (source === 'EXISTING') {
      const p = state.selectedPatient;
      if (!p) { badge.classList.add('hidden'); badge.innerHTML = ''; return; }
      badge.classList.remove('hidden');
      badge.innerHTML = `<div class="np-callout np-callout--info np-callout--stack" style="margin-bottom:.6rem;">
        <div>Currently linked to: <span class="hr-chip hr-chip--linked">Linked NeoKidsPro Patient</span></div>
        <div style="margin-top:.3rem;"><b>${esc(p.name || '')}</b>${p.phone ? ' \u00b7 +91 ' + esc(p.phone) : ''}</div>
        <div class="np-mut" style="margin-top:.35rem;font-size:.78rem;">Switch to “Legacy / Historical Patient” to unlink and enter details manually, or pick a different patient to re-link.</div>
      </div>`;
    } else {
      const nm = ($('#hrLegacyName')?.value || '').trim();
      badge.classList.remove('hidden');
      badge.innerHTML = `<div class="np-callout np-callout--info np-callout--stack" style="margin-bottom:.6rem;">
        <div>Currently linked to: <span class="hr-chip hr-chip--legacy">Legacy / Historical Patient</span></div>
        ${nm ? `<div style="margin-top:.3rem;"><b>${esc(nm)}</b></div>` : '<div class="np-mut" style="margin-top:.3rem;font-size:.82rem;">Enter the historical patient\u2019s details below.</div>'}
        <div class="np-mut" style="margin-top:.35rem;font-size:.78rem;">This record will not be attached to any patient in your directory. Switch to “Existing NeoKidsPro Patient” to link it to one.</div>
      </div>`;
    }
  }

  function openRecordModal(id) {
    state.editingId = id || null;
    state.pendingFiles = [];
    state.pendingLabels = [];
    state.pendingTypes = [];
    state.pendingNotes = [];
    state.existingAttachments = [];

    // Header text
    $('#hrRecordModalTitle').textContent = id ? 'Edit Previous Record' : 'Add Previous Record';
    $('#hrRecordModalSub').textContent   = id ? 'Update the fields below or manage attachments.' : 'Fill the fields below and attach any supporting documents.';
    $('#histSubmitBtn').textContent      = id ? 'Save changes' : 'Save record';

    // Patient ownership area (Patient Linkage fix): the toggle + search /
    // legacy panels are now ALWAYS shown, for both new and existing
    // records. Editing an existing record pre-fills the toggle/panels
    // with its current linkage, and submitRecord() always sends the
    // patient-link fields — the backend (`update()` in
    // previous.controller.js) already supports re-linking a record, this
    // was purely a frontend gap where the picker was hidden and the
    // fields were stripped out of the PUT body. #hrOwnershipBadge is now
    // just an informational "currently linked to" strip shown above the
    // (fully interactive) picker when editing, not a dead-end read-only
    // summary.
    const toggle = $('.hr-source-toggle');
    const badge  = $('#hrOwnershipBadge');
    toggle && toggle.classList.remove('hidden');
    if (id) {
      const rec = state.records.find(r => r.id === id);
      // v3.4.9 (part 4) — if the list cache doesn't hold this record
      // (opened straight from Patient History, or the list has paged on),
      // open with a clean shell and fetch the authoritative record instead
      // of dropping into a half-filled, wrongly-linked form.
      if (!rec) {
        badge && badge.classList.add('hidden');
        clearForm();
        setPatientSource('LEGACY', { initial: true });
        $('#hrRecordDate').value = today();
        renderPendingFiles();
        renderExistingAttachments();
        hideFormError();
        openModal('hrRecordModal');
        loadRecordIntoForm(id);
        return;
      }
      loadIntoForm(rec);
      // refreshOwnershipBadge() runs at the end of loadIntoForm via
      // setPatientSource, so the badge now always mirrors the toggle
      // rather than being computed once from `rec` and going stale on
      // switch.
    } else {
      badge && badge.classList.add('hidden');
      clearForm();
      setPatientSource('EXISTING', { initial: true });
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
    // Legacy patient fields
    ['hrLegacyName','hrLegacyPhone','hrLegacyDob','hrLegacyGender','hrLegacyGuardian','hrLegacyNotes']
      .forEach(id2 => { const el = $('#' + id2); if (el) el.value = ''; });
    state.pendingFiles = [];
    state.pendingLabels = [];
    state.pendingTypes = [];
    state.pendingNotes = [];
    state.existingAttachments = [];
  }

  function loadIntoForm(rec) {
    if (!rec) return;
    const f = $('#historicalForm');
    // v3.4.9 (part 4) — tolerate every backend shape (raw Prisma row with
    // patient_id / snake_case legacy columns, decorated record with patient
    // + camelCase fields) so the ownership toggle is driven by real data
    // and never silently defaults to the wrong branch.
    rec = normalizeRecord(rec);
    $('#histRecordId').value  = rec.id;
    $('#histPatientId').value = (rec.patient && rec.patient.id) || rec.patientId || '';
    const source = rec.patientSource || (rec.patient ? 'EXISTING' : 'LEGACY');
    // Always reset both branches first so switching a record that was
    // previously LEGACY into being edited doesn't leave stale EXISTING
    // fields (or vice versa) sitting around in the form.
    $('#hrPatientResults')?.classList.add('hidden');
    $('#hrSelectedPatient')?.classList.add('hidden');
    if (rec.patient) {
      state.selectedPatient = rec.patient;
      $('#histPatientId').value = rec.patient.id;
      $('#histPatientSearch').value = rec.patient.name || '';
      renderSelectedPatientCard(rec.patient);
    } else {
      state.selectedPatient = null;
      $('#histPatientSearch').value = '';
    }
    $('#hrLegacyName').value      = rec.legacyPatientName || '';
    $('#hrLegacyPhone').value     = rec.legacyPatientPhone || '';
    $('#hrLegacyDob').value       = rec.legacyPatientDob ? String(rec.legacyPatientDob).slice(0, 10) : '';
    $('#hrLegacyGender').value    = rec.legacyPatientGender || '';
    $('#hrLegacyGuardian').value  = rec.legacyPatientGuardian || '';
    $('#hrLegacyNotes').value     = rec.legacyPatientNotes || '';
    // Drive the toggle through setPatientSource() so the visible panel,
    // the hidden #hrPatientSource field, and the tab button states all
    // agree — this is the same function the toggle buttons themselves
    // call, so editing behaves identically to picking a branch fresh.
    // opts.initial=true so the pre-fill doesn't wipe the branch we just
    // populated (setPatientSource clears the *leaving* branch on real
    // switches).
    setPatientSource(source, { initial: true });
    refreshOwnershipBadge();
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

  // v3.4.9 (part 4) — shape-tolerant record normaliser. Records can arrive
  // from the list endpoint (decorated, camelCase, patient object included),
  // from GET /previous-records/:id, or from Patient History payloads. The
  // previous code trusted one shape only; anything else silently read as
  // EXISTING-with-no-patient and left BOTH branches editable.
  function normalizeRecord(rec) {
    if (!rec) return rec;
    const patientId   = rec.patientId || rec.patient_id || (rec.patient && rec.patient.id) || null;
    const patientName = rec.legacyPatientName || rec.legacy_patient_name || null;
    return Object.assign({}, rec, {
      patientId,
      patientSource: rec.patientSource || rec.patient_source || (patientId ? 'EXISTING' : 'LEGACY'),
      legacyPatientName:     patientName,
      legacyPatientPhone:    rec.legacyPatientPhone    || rec.legacy_patient_phone    || null,
      legacyPatientDob:      rec.legacyPatientDob      || rec.legacy_patient_dob      || null,
      legacyPatientGender:   rec.legacyPatientGender   || rec.legacy_patient_gender   || null,
      legacyPatientGuardian: rec.legacyPatientGuardian || rec.legacy_patient_guardian || null,
      legacyPatientNotes:    rec.legacyPatientNotes    || rec.legacy_patient_notes    || null
    });
  }

  // Fetch a single record and drive the Edit form from it (used when the
  // record isn't in the list cache).
  async function loadRecordIntoForm(id) {
    try {
      const r = await api('/doctor/previous-records/' + encodeURIComponent(id));
      const rec = r && r.record ? r.record : r;
      if (!rec || !rec.id) throw new Error('Record not found');
      loadIntoForm(rec); // this now also calls refreshOwnershipBadge()
      const idx = state.records.findIndex(x => x.id === rec.id);
      if (idx >= 0) state.records[idx] = Object.assign({}, state.records[idx], rec);
    } catch (ex) {
      showFormError(ex && ex.message || 'Could not load this record');
    }
  }

  // Patient Linkage fix — shared renderer for the "selected existing
  // patient" card, used both when picking fresh from search results and
  // when loading an existing record into the Edit form. Includes a
  // "Change patient" action so a doctor can clear the current selection
  // and search again without having to reopen the modal.
  function renderSelectedPatientCard(p) {
    const sp = $('#hrSelectedPatient');
    if (!sp || !p) return;
    sp.innerHTML = `<div class="np-callout np-callout--success">
      <div><b>${esc(p.name || '')}</b>${p.phone ? ' \u00b7 +91 ' + esc(p.phone) : ''}</div>
      <button type="button" class="np-btn np-btn--ghost np-btn--sm" data-hr-clear-patient style="margin-top:.4rem;">Change patient</button>
    </div>`;
    sp.classList.remove('hidden');
    sp.querySelector('[data-hr-clear-patient]')?.addEventListener('click', () => {
      state.selectedPatient = null;
      $('#histPatientId').value = '';
      sp.classList.add('hidden');
      sp.innerHTML = '';
      const input = $('#histPatientSearch');
      if (input) { input.value = ''; input.focus(); }
      // Clearing the linked patient must also wipe the ownership badge —
      // otherwise it kept insisting the record was "Linked NeoKidsPro
      // Patient" while there was no patientId in the form.
      refreshOwnershipBadge();
    });
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
        renderSelectedPatientCard(p);
        box.classList.add('hidden');
        $('#histPatientSearch').value = p.name;
        // Patient Linkage fix (part 5) — picking a patient must update the
        // "Currently linked to" badge immediately so the doctor doesn't
        // see a stale label from before the pick.
        refreshOwnershipBadge();
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
      // v3.4.10 (part 5) three-dot menu fix — previously we called
      // `b.parentElement.querySelector('[data-more-menu]')`, but once the
      // menu had been portaled to <body> once and closed, it was put
      // back into its holder correctly. However, if the row was
      // re-rendered between opens (e.g. after a metadata save), the
      // NEW row's holder had a fresh menu while the OLD portaled menu
      // could still be sitting on <body> unresolved. Look up the menu
      // via the holder ref every time and, defensively, close any
      // orphaned portaled menus first.
      closeAllAttMenus();
      const holder = b.closest('.hr-att__more');
      const menu = holder && holder.querySelector('[data-more-menu]');
      if (!menu) return;
      menu.classList.remove('hidden');
      b.setAttribute('aria-expanded', 'true');
      positionAttMenu(b, menu);
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

  // v3.4.9 (part 4) — fixed-position popover for the three-dot attachment
  // menu. The menu used to be absolutely positioned INSIDE the scrolling
  // modal body: near the bottom of the modal it clipped, forced the modal
  // taller, and left a slab of white space. Now the open menu is moved to
  // <body> and positioned with viewport coordinates — it renders above the
  // modal, opens UPWARD when there isn't room below the trigger, and never
  // affects modal height or scroll. It is moved back into its original
  // container when closed so re-renders keep working.
  function positionAttMenu(btn, menu) {
    const holder = btn.closest('.hr-att__more') || btn.parentElement;
    // Remember the holder so we can move the menu back into the row on
    // close (keeps subsequent re-renders finding it via querySelector).
    menu.__holder = holder;
    if (menu.parentElement !== document.body) document.body.appendChild(menu);
    // .is-portaled switches to position:fixed with viewport coords — the
    // in-flow default (position:absolute + right:0) was fighting our JS
    // left/top values and shifting with page scroll.
    menu.classList.add('is-portaled');
    // Measure with hidden already removed but style values reset so a
    // previous position doesn't skew width/height calculations.
    menu.style.left = '0px';
    menu.style.top  = '0px';
    const r = btn.getBoundingClientRect();
    const mw = menu.offsetWidth || 160;
    const mh = menu.offsetHeight || 140;
    let left = r.right - mw;
    if (left < 8) left = 8;
    if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
    let top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) {
      top = r.top - mh - 6;
      if (top < 8) top = Math.max(8, window.innerHeight - mh - 8);
    }
    menu.style.left = left + 'px';
    menu.style.top  = top + 'px';
  }

  function closeAllAttMenus() {
    $$('[data-more-menu]').forEach(m => {
      const wasOpen = !m.classList.contains('hidden');
      m.classList.add('hidden');
      m.classList.remove('is-portaled');
      // Move back into the original holder if we portaled it, so future
      // re-renders can still find it via `holder.querySelector`. If the
      // holder has been removed from the DOM (row re-rendered), drop
      // the portaled menu entirely so it doesn't stack on <body>.
      if (m.parentElement === document.body) {
        if (m.__holder && m.__holder.isConnected) {
          m.__holder.appendChild(m);
        } else {
          m.parentElement.removeChild(m);
        }
      }
      m.style.left = ''; m.style.top = '';
      if (wasOpen) { /* no-op, hook for future analytics */ }
    });
    $$('[data-att-more]').forEach(b => b.setAttribute('aria-expanded', 'false'));
  }
  document.addEventListener('click', closeAllAttMenus);
  window.addEventListener('scroll', closeAllAttMenus, true);
  window.addEventListener('resize', closeAllAttMenus);

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
  // v3.4.10 (part 5) — preview now integrates with browser history so
  // the Android/browser back button returns to the parent Previous
  // Record modal instead of navigating the whole page away. Combined
  // with the explicit "← Back" button in the header (see index.html) and
  // the pre-existing per-modal close stack, the doctor now has three
  // consistent ways back: hardware back, header Back, header ✕ — all
  // of them land on the parent modal in the same state.
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
    // Push a history entry so a hardware Back press pops the preview
    // instead of leaving the page. Handled by the popstate listener
    // installed once at mount time.
    try {
      history.pushState({ hrPreview: true }, '', location.href);
      state.previewPushed = true;
    } catch (_) { /* private mode / non-browser env — safe to ignore */ }
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
    const recordDate = $('#hrRecordDate').value;
    const source = $('#hrPatientSource').value || 'EXISTING';

    // Patient Linkage fix: the toggle/panels are now shown \u2014 and
    // validated \u2014 for BOTH new and existing records, so a doctor can
    // unlink, re-link to a different NeoKidsPro patient, or convert to/
    // from a legacy patient while editing, not just at creation time.
    let patientId = '';
    let legacyName = '';
    if (source === 'LEGACY') {
      legacyName = ($('#hrLegacyName').value || '').trim();
      if (!legacyName) { showFormError('Please enter the legacy patient\u2019s name.'); return; }
    } else {
      patientId = $('#histPatientId').value || (state.selectedPatient && state.selectedPatient.id) || '';
      if (!patientId) { showFormError('Please select a patient, or switch to "Legacy / Historical Patient" and enter their details.'); return; }
    }
    if (!recordDate) { showFormError('Please choose a record date.'); return; }

    const fd = new FormData();
    fd.append('recordDate',  recordDate);
    fd.append('recordType',  $('#hrRecordType').value || 'CONSULTATION');
    fd.append('title',       $('#hrTitle').value.trim());
    fd.append('diagnosis',   $('#hrDiagnosis').value.trim());
    fd.append('notes',       $('#hrNotes').value.trim());
    fd.append('treatment',   $('#hrTreatment').value.trim());
    fd.append('medications', $('#hrMedications').value.trim());
    // Patient Linkage fix: send on every save, not just create, so
    // edits can actually change (or clear-and-reassign) who a record
    // belongs to. previous.controller.js#update() only touches linkage
    // when these fields are present, and re-resolves them the same way
    // create() does.
    fd.append('patientSource', source);
    if (source === 'LEGACY') {
      fd.append('legacyPatientName',     legacyName);
      fd.append('legacyPatientPhone',    ($('#hrLegacyPhone').value || '').trim());
      fd.append('legacyPatientDob',      $('#hrLegacyDob').value || '');
      fd.append('legacyPatientGender',   $('#hrLegacyGender').value || '');
      fd.append('legacyPatientGuardian', ($('#hrLegacyGuardian').value || '').trim());
      fd.append('legacyPatientNotes',    ($('#hrLegacyNotes').value || '').trim());
    } else {
      fd.append('patientId', patientId);
    }
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
        // v3.4.8 — generic create endpoint (no patientId in the URL) so
        // both Existing-patient and Legacy-patient branches share one
        // call; patientSource/patientId/legacyPatient* already travel
        // in `fd` above.
        saved = await api('/doctor/previous-records', { method: 'POST', body: fd });
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
      title: 'Delete previous record?',
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
    const name  = ownerName(rec);
    const phone = ownerPhone(rec);
    const atts = rec.attachments || [];
    $('#hrViewModalTitle').textContent = rec.title || (humanType(rec.recordType) + ' \u2014 ' + fmtDate(rec.recordDate));
    $('#hrViewModalSub').textContent   = name + (phone ? ' \u00b7 +91 ' + phone : '');
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

    // Patient Linkage fix: an explicit ownership section at the top of
    // the View modal, so it's never ambiguous whether this record is
    // tied to a real directory patient or a manually-entered legacy one.
    const ownerHtml = `
      <div class="hr-view__owner">
        ${ownershipChip(rec)}
        <div class="hr-view__ownerDetail">
          <b>${esc(name)}</b>${phone ? ' \u00b7 +91 ' + esc(phone) : ''}
        </div>
        ${isLegacy(rec) && (rec.legacyPatientGuardian || rec.legacyPatientDob || rec.legacyPatientGender) ? `
        <div class="hr-view__ownerMeta">
          ${rec.legacyPatientGuardian ? esc('Guardian: ' + rec.legacyPatientGuardian) : ''}
          ${rec.legacyPatientDob ? (rec.legacyPatientGuardian ? ' \u00b7 ' : '') + esc('DOB: ' + fmtDate(rec.legacyPatientDob)) : ''}
          ${rec.legacyPatientGender ? ((rec.legacyPatientGuardian || rec.legacyPatientDob) ? ' \u00b7 ' : '') + esc(rec.legacyPatientGender) : ''}
        </div>` : ''}
        ${isLegacy(rec) && rec.legacyPatientNotes ? `<div class="hr-view__ownerMeta">${esc(rec.legacyPatientNotes)}</div>` : ''}
      </div>`;

    $('#hrViewContent').innerHTML = `
      <div class="hr-view">
        ${ownerHtml}
        <div class="hr-view__grid">
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
  // v3.4.9 (part 4) — Patient History click-through: app.js opens the
  // existing View Previous Record modal through this hook so doctors can
  // review full record details, attachments and metadata from history.
  window.hrOpenView = function (id) { if (id) openViewModal(id); };

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
