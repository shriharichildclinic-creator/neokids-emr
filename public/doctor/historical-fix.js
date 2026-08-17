/* =====================================================================
   historical-fix.js — v3.4.3 Doctor Panel enhancements (defensive,
   only activates when the Historical Records tab exists).
   ===================================================================== */
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const api = (window.apiFetch || window.api);
  if (!api) return;

  // 1) multi-file input + label inputs on the historical form
  const form = $('#historicalForm');
  if (form) {
    const fi = form.querySelector('input[type="file"]');
    if (fi) { fi.setAttribute('multiple', 'multiple'); fi.setAttribute('name', 'attachments'); fi.setAttribute('accept', '.pdf,image/*'); }
  }

  // 2) render attachment action buttons (preview/download/replace/delete/open)
  window.hrRenderAttachments = function (container, record) {
    if (!container) return;
    const atts = (record && record.attachments) || [];
    container.innerHTML = atts.map(a => `
      <div class="hr-att" data-id="${a.id}">
        <span class="hr-att__name">${a.label || a.originalName}</span>
        <a href="${a.viewUrl}" target="_blank" rel="noopener">Preview</a>
        <a href="${a.downloadUrl}">Download</a>
        <a href="${a.viewUrl}" target="_blank" rel="noopener">Open in new tab</a>
        <button type="button" data-act="replace">Replace</button>
        <button type="button" data-act="delete">Delete</button>
      </div>`).join('') || '<p class="np-empty">No attachments yet</p>';
    container.querySelectorAll('.hr-att button').forEach(btn => btn.addEventListener('click', async (e) => {
      const id = e.target.closest('.hr-att').dataset.id;
      if (e.target.dataset.act === 'delete' && confirm('Delete this attachment?')) {
        await api(`/doctor/previous-records/${record.id}/attachments/${id}`, { method: 'DELETE' });
        e.target.closest('.hr-att').remove();
      }
      if (e.target.dataset.act === 'replace') {
        const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.pdf,image/*';
        inp.onchange = async () => {
          const fd = new FormData(); fd.append('file', inp.files[0]);
          await api(`/doctor/previous-records/${record.id}/attachments/${id}/replace`, { method: 'POST', body: fd });
          location.reload();
        };
        inp.click();
      }
    }));
  };

  // 3) share buttons
  window.hrShare = async function (recordId, channel) {
    const r = await api(`/doctor/previous-records/${recordId}/share`, { method: 'POST', body: JSON.stringify({ channel }), headers: { 'Content-Type': 'application/json' } });
    if (r && r.success) alert('Shared via ' + channel + ' successfully.'); else alert('Share failed.');
  };
  window.hrGeneratePdf = async function (recordId) {
    const r = await api(`/doctor/previous-records/${recordId}/generate-pdf`, { method: 'POST' });
    if (r && r.pdfUrl) window.open(r.pdfUrl, '_blank');
  };
})();
