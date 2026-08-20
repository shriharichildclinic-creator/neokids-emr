// =====================================================================
// whatsapp-media.service.js — WhatsApp PDF sharing (Meta Cloud API)
// ---------------------------------------------------------------------
// EXTENSION MODULE — does NOT modify or replace the existing
// whatsapp.service.js. It sits alongside it and adds:
//
//   1. uploadMediaToMeta(filepath, mimeType)
//      - Uploads a local PDF to /PHONE_ID/media and returns the media id.
//
//   2. sendDocumentByLink({ to, link, filename, caption })
//      - Sends a session document by public HTTPS link (24h window).
//
//   3. sendDocumentTemplate({ to, templateName, mediaId, bodyParams })
//      - Sends a template-driven document message (header type=document)
//        using the uploaded media id. Works OUTSIDE the 24h window and
//        is the production-safe path used for Prescription / Invoice.
//
//   4. sendPrescriptionPdf(appointment, filepath) / sendInvoicePdf(...)
//      - High-level helpers used by automation.service.js.
//
// The existing whatsapp.service.js `normalizePhone`, error handling and
// PROVIDER=MOCK short-circuit behaviours are reused.
// =====================================================================

const fs      = require('fs');
const path    = require('path');
const logger  = require('../utils/logger');
const { normalizePhone } = require('./whatsapp.service');

const PROVIDER  = (process.env.WA_PROVIDER || 'MOCK').toUpperCase();
const WA_LANG   = process.env.META_LANG_CODE || 'en';
const GRAPH_VER = process.env.META_GRAPH_VERSION || 'v19.0';

function metaCredentials() {
  const phoneId = process.env.META_PHONE_NUMBER_ID;
  const token   = process.env.META_ACCESS_TOKEN;
  if (!phoneId || !token) {
    const e = new Error('META_PHONE_NUMBER_ID or META_ACCESS_TOKEN missing');
    e.code = 'META_CONFIG_MISSING';
    throw e;
  }
  return { phoneId, token };
}

// ─── Upload a PDF to Meta and return a media_id ───
// Multipart form (Node 18+ has global FormData / Blob / fetch).
async function uploadMediaToMeta(filepath, mimeType = 'application/pdf') {
  if (PROVIDER !== 'META') {
    return { id: 'mock_media_' + Date.now(), mock: true };
  }
  const { phoneId, token } = metaCredentials();
  if (!fs.existsSync(filepath)) {
    const e = new Error(`Media file not found: ${filepath}`);
    e.code = 'MEDIA_FILE_MISSING';
    throw e;
  }

  const buf  = fs.readFileSync(filepath);
  const blob = new Blob([buf], { type: mimeType });
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', blob, path.basename(filepath));

  const res  = await fetch(`https://graph.facebook.com/${GRAPH_VER}/${phoneId}/media`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}` },
    body:    form
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    const err = new Error(data?.error?.message || `Meta media upload failed (${res.status})`);
    err.code  = data?.error?.code || 'META_MEDIA_UPLOAD_ERROR';
    err.raw   = data;
    logger.error(`[META-MEDIA] upload failed: ${err.message}`);
    throw err;
  }
  logger.info(`[META-MEDIA] uploaded ${path.basename(filepath)} → media_id=${data.id}`);
  return data;
}

// ─── Send document by public link (24h session window only) ───
async function sendDocumentByLink({ to, link, filename, caption }) {
  if (PROVIDER !== 'META') {
    logger.info(`[WA-MOCK-DOC-LINK] to=${to} filename=${filename} link=${link}`);
    return { sid: 'mock_' + Date.now(), mock: true };
  }
  const { phoneId, token } = metaCredentials();
  const payload = {
    messaging_product: 'whatsapp',
    to: normalizePhone(to),
    type: 'document',
    document: { link, filename, ...(caption ? { caption } : {}) }
  };
  const res  = await fetch(`https://graph.facebook.com/${GRAPH_VER}/${phoneId}/messages`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `WA doc-link send failed (${res.status})`);
    err.code  = data?.error?.code || 'META_HTTP_ERROR';
    err.raw   = data;
    throw err;
  }
  return data;
}

// ─── Send a template with a DOCUMENT header (uploaded media_id) ───
// This is the ONLY path that works outside the 24-h customer-care window.
async function sendDocumentTemplate({
  to, templateName, mediaId, filename,
  bodyParams = []
}) {
  if (PROVIDER !== 'META') {
    logger.info(`[WA-MOCK-DOC-TPL] to=${to} tpl=${templateName} media=${mediaId} params=${JSON.stringify(bodyParams)}`);
    return { sid: 'mock_' + Date.now(), mock: true };
  }
  const { phoneId, token } = metaCredentials();

  const components = [
    {
      type: 'header',
      parameters: [{
        type: 'document',
        document: {
          id: mediaId,
          filename: filename || 'document.pdf'
        }
      }]
    }
  ];
  if (bodyParams.length) {
    components.push({
      type: 'body',
      parameters: bodyParams.map(t => ({ type: 'text', text: String(t ?? '') }))
    });
  }

  const payload = {
    messaging_product: 'whatsapp',
    to: normalizePhone(to),
    type: 'template',
    template: { name: templateName, language: { code: WA_LANG }, components }
  };

  const res  = await fetch(`https://graph.facebook.com/${GRAPH_VER}/${phoneId}/messages`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `WA doc-template send failed (${res.status})`);
    err.code  = data?.error?.code || 'META_HTTP_ERROR';
    err.subcode    = data?.error?.error_subcode;
    err.title      = data?.error?.error_user_title;
    err.detail     = data?.error?.error_user_msg;
    err.httpStatus = res.status;
    err.raw   = data;
    throw err;
  }
  logger.info(`[META-DOC-TPL] Sent "${templateName}" to ${to} (mediaId=${mediaId})`);
  return data;
}

// ─── High-level helpers ───
// Prescription — uses template neokids_prescription_pdf
async function sendPrescriptionPdf({ appointment, filepath, publicUrl }) {
  const to      = appointment.patient.phone;
  const tplName = process.env.WA_TPL_PRESCRIPTION_PDF || 'neokids_prescription_pdf';
  const apptShort = appointment.id.slice(0, 8).toUpperCase();
  const fname   = `prescription_${apptShort}.pdf`;

  // Upload the PDF once → get media_id → send template
  const media = await uploadMediaToMeta(filepath, 'application/pdf');
  return sendDocumentTemplate({
    to,
    templateName: tplName,
    mediaId:  media.id,
    filename: fname,
    bodyParams: [
      appointment.patient.name,
      appointment.doctor.name
    ]
  });
}

// ─── Medical Certificate — uses template medical_certificate_ready ───
// Meta template contract (docs/META_WHATSAPP_TEMPLATES.md):
//   Header : Document (the PDF itself)
//   Body   : Hello {{1}},
//            Your medical certificate issued by {{2}} is ready.
//            Certificate Date: {{3}}
//            If you have any questions, please reach out to your doctor.
//            Regards, {{2}}
//   {{1}} = Patient Name, {{2}} = Issuing Doctor Name (never clinic/hospital name), {{3}} = Certificate Date
async function sendCertificatePdf({ certificate, doctor, patient, filepath }) {
  const dayjs  = require('dayjs');
  const to      = patient.phone;
  const tplName = process.env.WA_TPL_CERTIFICATE_PDF || 'medical_certificate_ready';
  const fname   = `medical_certificate_${certificate.certificateNumber}.pdf`;
  // Effective certificate date: single-day date, else the rest-period start,
  // else the issue date.
  const certDate = certificate.certificateDate || certificate.fromDate || certificate.issuedAt;

  const media = await uploadMediaToMeta(filepath, 'application/pdf');
  return sendDocumentTemplate({
    to,
    templateName: tplName,
    mediaId:  media.id,
    filename: fname,
    bodyParams: [
      patient.name,                                     // {{1}} patient
      `Dr. ${(doctor && doctor.name) || '—'}`,           // {{2}} issuing doctor (never clinic name)
      dayjs(certDate).format('DD MMM YYYY')             // {{3}} certificate date
    ]
  });
}

// Invoice — uses template neokids_invoice_pdf
async function sendInvoicePdf({ appointment, filepath, publicUrl }) {
  const to      = appointment.patient.phone;
  const tplName = process.env.WA_TPL_INVOICE_PDF || 'neokids_invoice_pdf';
  const apptShort = appointment.id.slice(0, 8).toUpperCase();
  const fname   = `invoice_${apptShort}.pdf`;

  const media = await uploadMediaToMeta(filepath, 'application/pdf');
  return sendDocumentTemplate({
    to,
    templateName: tplName,
    mediaId:  media.id,
    filename: fname,
    bodyParams: [
      appointment.patient.name,
      `INV-${apptShort}`,
      Number(appointment.feeAtBooking).toFixed(2)
    ]
  });
}

module.exports = {
  uploadMediaToMeta,
  sendDocumentByLink,
  sendDocumentTemplate,
  sendPrescriptionPdf,
  sendInvoicePdf,
  sendCertificatePdf
};
