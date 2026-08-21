// =====================================================================
// historical-record-pdf.service.js — v3.4.3
// Generate a professional EMR PDF for a Historical Record (same
// architecture as Prescriptions / Medical Certificates).
// =====================================================================
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const STORAGE_PATH = process.env.STORAGE_PATH || path.join(process.cwd(), 'storage');
const OUT_DIR = path.join(STORAGE_PATH, 'historical-pdf');
function ensureDir(p){ if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function humanType(t){
  const m = { LAB_REPORT:'Lab Report', CONSULTATION:'Consultation', RADIOLOGY:'Radiology / Imaging', PRESCRIPTION:'Prescription', VACCINATION:'Vaccination', DISCHARGE:'Discharge Summary', REFERRAL:'Referral Letter', OTHER:'Other' };
  return m[t] || t || 'General Record';
}
function fmt(d){ if(!d) return '—'; const x = new Date(d); return x.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }); }

// The doctor UI stores type-specific extras (findings, scanType,
// vaccine details, referral fields, admission/discharge dates, summary)
// as a JSON tail appended to `notes`. This helper splits the tail off
// so the printed PDF shows clean notes plus the extras as their own
// sections — without needing a schema change.
const EXTRAS_MARK_START = '\n\n<!--HR_EXTRAS_V1:';
const EXTRAS_MARK_END   = ':HR_EXTRAS_V1-->';
function extractExtras(notes){
  const s = String(notes == null ? '' : notes);
  const i = s.lastIndexOf(EXTRAS_MARK_START);
  if (i < 0) return { notes: s, extras: {} };
  const j = s.indexOf(EXTRAS_MARK_END, i);
  if (j < 0) return { notes: s, extras: {} };
  try {
    const extras = JSON.parse(s.slice(i + EXTRAS_MARK_START.length, j)) || {};
    return { notes: s.slice(0, i), extras };
  } catch (_) {
    return { notes: s, extras: {} };
  }
}

// Ordered map of which sections to print per record type. Keeps the
// generated PDF aligned with the Add/Edit and View modals.
const PDF_SECTIONS = {
  CONSULTATION: ['diagnosis','notes','treatment','medications'],
  PRESCRIPTION: ['diagnosis','notes','medications'],
  LAB_REPORT:   ['findings'],
  RADIOLOGY:    ['scanType','findings'],
  VACCINATION:  ['vaccineName','doseNumber','batchNumber','vaccinationDate','notes'],
  REFERRAL:     ['referredTo','reason'],
  DISCHARGE:    ['admissionDate','dischargeDate','summary'],
  OTHER:        ['diagnosis','notes','treatment','medications']
};

async function generateHistoricalRecordPdf(record){
  ensureDir(OUT_DIR);
  const filename = `historical-record-${record.id}.pdf`;
  const outPath = path.join(OUT_DIR, filename);
  const publicUrl = `/files/historical-pdf/${filename}`;

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);

    const L = 50, W = 495;
    doc.fontSize(18).font('Helvetica-Bold').text('NeoKidsPro — Historical Medical Record', L, 50);
    doc.fontSize(9).font('Helvetica').fillColor('#666').text('Pediatric Network of Doctors · neokidspro.in', L, 72);
    // Sub-brand is hardcoded (Shri Hari Child Clinic, Borivali) — same
    // constant used in pdf.service.js's letterhead — not the doctor's
    // dynamic clinicName. See pdf.service.js drawHeader for the rationale.
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#0F2E3A').text('Shri Hari Child Clinic, Borivali', L, doc.y);
    let headerBottom = doc.y + 8;
    doc.fillColor('#000');
    doc.moveTo(L, headerBottom).lineTo(L+W, headerBottom).lineWidth(1).stroke('#333');

    doc.fontSize(10).font('Helvetica');
    let y = headerBottom + 17;
    const row = (k, v) => { doc.font('Helvetica-Bold').text(k, L, y, { width: 140 }); doc.font('Helvetica').text(String(v || '—'), L+145, y, { width: W-145 }); y = doc.y + 4; };

    row('Patient:', record.patient ? record.patient.name : '');
    row('Record Title:', record.title || humanType(record.recordType));
    row('Record Type:', humanType(record.recordType));
    row('Record Date:', fmt(record.recordDate));
    row('Recorded By:', record.doctor ? 'Dr. ' + record.doctor.name : '');
    row('Generated:', fmt(new Date()));

    y += 6; doc.moveTo(L, y).lineTo(L+W, y).stroke('#999'); y += 10;
    const section = (title, body) => {
      if (!body) return;
      if (y > 720) { doc.addPage(); y = 50; }
      doc.font('Helvetica-Bold').fontSize(11).text(title, L, y); y = doc.y + 2;
      doc.font('Helvetica').fontSize(10).text(body, L, y, { width: W }); y = doc.y + 10;
    };

    // Render only the sections that belong to this record type; unpack
    // the JSON extras tail from `notes` first so the raw marker never
    // appears in the PDF and type-specific fields appear as their own
    // sections.
    const parsed = extractExtras(record.notes);
    const extras = parsed.extras || {};
    const cleanNotes = parsed.notes;
    const notesLabel = (record.recordType === 'PRESCRIPTION') ? 'Prescription Notes' : 'Clinical Notes';
    const sectionForKey = (key) => {
      switch (key) {
        case 'diagnosis':       section('Diagnosis',       record.diagnosis); break;
        case 'notes':           section(notesLabel,        cleanNotes);       break;
        case 'treatment':       section('Treatment Given', record.treatment); break;
        case 'medications':     section('Medications',     record.medications); break;
        case 'findings':        section('Findings',        extras.findings);  break;
        case 'scanType':        section('Scan Type',       extras.scanType);  break;
        case 'vaccineName':     section('Vaccine Name',    extras.vaccineName); break;
        case 'doseNumber':      section('Dose Number',     extras.doseNumber);  break;
        case 'batchNumber':     section('Batch Number',    extras.batchNumber); break;
        case 'vaccinationDate': section('Vaccination Date', extras.vaccinationDate ? fmt(extras.vaccinationDate) : ''); break;
        case 'referredTo':      section('Referred To',     extras.referredTo); break;
        case 'reason':          section('Reason',          extras.reason);     break;
        case 'admissionDate':   section('Admission Date',  extras.admissionDate ? fmt(extras.admissionDate) : ''); break;
        case 'dischargeDate':   section('Discharge Date',  extras.dischargeDate ? fmt(extras.dischargeDate) : ''); break;
        case 'summary':         section('Summary',         extras.summary);    break;
      }
    };
    const order = PDF_SECTIONS[record.recordType] || PDF_SECTIONS.OTHER;
    order.forEach(sectionForKey);

    if (record.attachments && record.attachments.length){
      if (y > 700) { doc.addPage(); y = 50; }
      doc.font('Helvetica-Bold').fontSize(11).text('Attachments', L, y); y = doc.y + 4;
      record.attachments.forEach((a, i) => {
        doc.font('Helvetica').fontSize(10).text(`${i+1}. ${a.label || a.originalName} (${a.kind || 'file'})`, L+12, y, { width: W-12 });
        y = doc.y + 2;
      });
    }

    doc.fontSize(8).fillColor('#777').text('Generated by NeoKidsPro (Shri Hari Child Clinic, Borivali) EMR. This document summarises a historical/external record uploaded to the patient timeline.', L, 780, { width: W, align: 'center' });
    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  return { absolutePath: outPath, publicUrl, filename };
}

module.exports = { generateHistoricalRecordPdf, humanType };
