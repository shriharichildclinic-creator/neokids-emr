const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { calcAge } = require('../utils/date');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '..', '..', 'storage');
const BRAND_BLUE = '#4DA8FF';
const BRAND_MINT = '#B8F2E6';
const BRAND_DARK = '#0F2E3A';

function appointmentModeLabel(type) {
  return type === 'ONLINE' ? 'Online Consultation' : type === 'OFFLINE' ? 'Clinic Visit' : (type || '—');
}

function publicUrlForAppointmentPdf(kind, appointmentId) {
  const segment = kind === 'invoice' ? 'invoices' : 'prescriptions';
  return `/api/files/${segment}/${appointmentId}.pdf`;
}

function ensureDir(p) {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true, mode: 0o755 });
    return;
  }
  try {
    fs.accessSync(p, fs.constants.W_OK);
  } catch (_) {
    try { fs.chmodSync(p, 0o755); } catch (_) { /* surfaced later by write */ }
  }
}

function drawHeader(doc, title) {
  // Root-cause fix for empty trailing pages: PDFKit auto page-breaks whenever
  // a draw crosses (page.height - bottomMargin). These are fixed-layout,
  // single-page documents, so we disable the auto-break by zeroing the bottom
  // margin. The signature block is separately clamped to stay on this page.
  if (doc.page && doc.page.margins) doc.page.margins.bottom = 0;
  doc.rect(0, 0, doc.page.width, 80).fill(BRAND_BLUE);
  doc.fillColor('white').fontSize(22).font('Helvetica-Bold').text('NeoKidsPro', 50, 28);
  doc.fontSize(10).font('Helvetica').text('Pediatric Clinic · neokidspro.in', 50, 55);
  doc.fontSize(16).font('Helvetica-Bold').fillColor('white')
     .text(title, 0, 32, { align: 'right', width: doc.page.width - 50 });
  doc.fillColor('black').moveDown(3);
}

// ─────────────────────────────────────────────────────────────────────
// Feature 3 — Doctor Digital Signature helper
//
// Given a doctor row, resolves the local disk path for their uploaded
// signature PNG (if any) and returns it, or null. The signature is
// stored under storage/signatures/<uuid>.<ext>; the doctor row keeps
// only the public/relative URL fragment, so we re-derive the disk path
// here without hitting the auth layer.
// ─────────────────────────────────────────────────────────────────────
function resolveSignaturePath(doctor) {
  if (!doctor || !doctor.signatureUrl) return null;
  try {
    // signatureUrl is stored as e.g. "/files/signatures/<uuid>.png"
    // OR just "<uuid>.png" — we tolerate both.
    const marker = 'signatures/';
    const idx = doctor.signatureUrl.indexOf(marker);
    const filename = idx >= 0
      ? doctor.signatureUrl.slice(idx + marker.length)
      : doctor.signatureUrl;
    const fp = path.join(STORAGE, 'signatures', path.basename(filename));
    if (fs.existsSync(fp)) return fp;
  } catch (_) { /* ignore */ }
  return null;
}

// Draw the doctor's signature block at the bottom-right of the current
// page. Name, qualification and signature image always stay TOGETHER.
//
// Bug fix (PDF rendering): the old implementation drew every line with a
// hard-coded absolute y-offset (y+55, y+70, y+82 …). PDFKit triggers an
// automatic page break whenever ANY draw lands past the bottom margin, so
// a tall/long name or a lower start-y pushed the doctor name, the
// qualification and the "Digital Signature" caption onto separate pages.
// We now compute the exact raster height, clamp the whole block so it
// fits on one page, and use flowing relative y offsets (never absolute).
function drawSignatureBlock(doc, doctor, opts = {}) {
  const sigPath   = resolveSignaturePath(doctor);
  // v3.3.9: nudged right per doctor feedback ("slightly too far toward
  // center"). blockW is trimmed from 220 to 200 to keep a ~10pt print-safe
  // buffer from the true page edge at the new position — this only
  // affects the text-wrap/image-fit *container* width, not the size of
  // anything rendered inside it (name/qualification text and the
  // signature image are both comfortably narrower than either value, so
  // nothing changes visually except the horizontal position).
  const leftX     = doc.page.width - 210;   // block's left edge — every element shares this x
  const blockW    = 200;                    // shared width for text wrapping + image box
  const sigMaxH   = 46;                     // signature image never exceeds this height
  const sigInset  = 6;                      // margin inside the image's box on every side, so
                                             // ink that runs close to the source PNG's own edges
                                             // still reads with breathing room, never "cut off"
  const hasReg    = !!(doctor && doctor.registrationNumber);

  // Required layout (per doctor sign-off): signature image ABOVE the
  // printed name, everything left-aligned to `leftX`:
  //   [Signature Image]
  //   Doctor Name
  //   Qualifications
  // Total block height: image (sigMaxH) + gap (6) + name (14) +
  // qualification (12) + optional reg. no (11) + caption (10).
  const blockH = sigMaxH + 6 + 14 + 12 + (hasReg ? 11 : 0) + 10;
  const bottomLimit = doc.page.height - 48;   // keep clear of the footer band
  // The ENTIRE block (image + every text line) must end above bottomLimit,
  // otherwise PDFKit auto page-breaks mid-block.
  const maxY = bottomLimit - blockH;
  let y = Math.min(opts.y || maxY, maxY);
  if (y < 40) y = 40;                          // never collide with the header

  // ── Signature image first, left-aligned at `leftX` ──
  let ty = y;
  if (sigPath) {
    try {
      // `fit` alone (no `height` passed alongside it) — passing both throws
      // "unsupported number: NaN" in this pdfkit version because the
      // redundant height conflicts with fit's own aspect-ratio math. `fit`
      // preserves the source aspect ratio and never crops on its own.
      // The image is fit into a box inset by `sigInset` on every side
      // (rather than the full block width/height) so it never visually
      // touches the block's outer edges, and `align:'left'` keeps that
      // inset consistent with the text below instead of centering it.
      doc.image(sigPath, leftX + sigInset, ty + sigInset,
        { fit: [blockW - sigInset * 2, sigMaxH - sigInset * 2], align: 'left', valign: 'top' });
    } catch (e) {
      doc.fontSize(10).fillColor('#555').text('___________________________', leftX, ty + sigMaxH - 16);
    }
  } else {
    doc.fontSize(10).fillColor('#555').text('___________________________', leftX, ty + sigMaxH - 16);
  }
  ty += sigMaxH + 6;

  // ── Text lines below the image, all left-aligned to the same `leftX` ──
  doc.font('Helvetica-Bold').fillColor('#000').fontSize(11)
     .text(`Dr. ${doctor.name}`, leftX, ty, { width: blockW, lineBreak: false, ellipsis: true });
  ty += 14;
  doc.font('Helvetica').fillColor('#555').fontSize(9)
     .text(doctor.qualification || 'MBBS, MD (Pediatrics)', leftX, ty, { width: blockW, lineBreak: false, ellipsis: true });
  ty += 12;
  if (hasReg) {
    doc.text(`Reg. No: ${doctor.registrationNumber}`, leftX, ty, { width: blockW, lineBreak: false, ellipsis: true });
    ty += 11;
  }

  doc.fillColor('#888').fontSize(8)
     .text('Digital Signature', leftX, ty, { width: blockW, lineBreak: false });
}

async function generateInvoice(appointment) {
  ensureDir(path.join(STORAGE, 'invoices'));
  const filename = `invoice_${appointment.id}.pdf`;
  const filepath = path.join(STORAGE, 'invoices', filename);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true, autoFirstPage: true });
    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);
    drawHeader(doc, 'INVOICE');

    doc.fontSize(11).font('Helvetica').fillColor('#333');
    doc.text(`Invoice No: INV-${appointment.id.slice(0, 8).toUpperCase()}`, 50, 110);
    doc.text(`Date: ${dayjs().format('DD MMM YYYY')}`, 50, 125);
    doc.text(`Payment ID: ${appointment.cashfreePaymentId || 'N/A'}`, 50, 140);

    doc.fontSize(12).font('Helvetica-Bold').text('Bill To:', 50, 175);
    doc.fontSize(11).font('Helvetica');
    doc.text(appointment.patient.name, 50, 192);
    doc.text(`Phone: +91 ${appointment.patient.phone}`, 50, 207);
    if (appointment.patient.email) doc.text(`Email: ${appointment.patient.email}`, 50, 222);

    doc.fontSize(12).font('Helvetica-Bold').text('Consultation By:', 320, 175);
    doc.fontSize(11).font('Helvetica');
    doc.text(`Dr. ${appointment.doctor.name}`, 320, 192);
    doc.text(appointment.doctor.specialization || 'Pediatrician', 320, 207);
    // Issue 5 — appointment date + time on the invoice.
    doc.fillColor('#555').fontSize(9)
       .text(`Appointment: ${dayjs(appointment.date).format('DD MMM YYYY')} · ${appointment.startTime ? dayjs(`2000-01-01T${appointment.startTime}`).format('hh:mm A') : '—'}`, 320, 222);
    doc.fillColor('#333');

    const tableTop = 285;
    doc.rect(50, tableTop, doc.page.width - 100, 25).fill(BRAND_MINT);
    doc.fillColor('#000').fontSize(11).font('Helvetica-Bold');
    doc.text('Description', 60, tableTop + 8);
    doc.text('Date', 280, tableTop + 8);
    doc.text('Type', 380, tableTop + 8);
    doc.text('Amount (₹)', 460, tableTop + 8);

    doc.font('Helvetica').fontSize(11);
    const rowY = tableTop + 35;
    doc.text('Consultation Fee', 60, rowY);
    doc.text(dayjs(appointment.date).format('DD MMM YYYY'), 280, rowY);
    doc.text(appointment.consultationType, 380, rowY);
    doc.text(`${Number(appointment.feeAtBooking).toFixed(2)}`, 460, rowY);

    doc.moveTo(50, rowY + 30).lineTo(doc.page.width - 50, rowY + 30).stroke();
    doc.font('Helvetica-Bold').fontSize(12);
    doc.text('Total Paid:', 380, rowY + 45);
    doc.text(`₹ ${Number(appointment.feeAtBooking).toFixed(2)}`, 460, rowY + 45);

    // Optional signature on invoice (kept on this page).
    drawSignatureBlock(doc, appointment.doctor, { y: doc.page.height - 185 });

    // Footer — lineBreak:false so PDFKit never auto page-breaks the line
    // onto a blank page (bottom margin auto-break was the root cause).
    doc.fontSize(9).font('Helvetica').fillColor('#888');
    doc.text('Thank you for choosing NeoKidsPro. This is a computer-generated invoice.',
             50, doc.page.height - 40, { align: 'center', width: doc.page.width - 100, lineBreak: false, ellipsis: true });

    doc.end();
    stream.on('finish', () => resolve({
      filepath, filename,
      url: publicUrlForAppointmentPdf('invoice', appointment.id)
    }));
    stream.on('error', reject);
  });
}

async function generatePrescription(appointment, prescription) {
  ensureDir(path.join(STORAGE, 'prescriptions'));
  const filename = `prescription_${appointment.id}.pdf`;
  const filepath = path.join(STORAGE, 'prescriptions', filename);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true, autoFirstPage: true });
    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);
    drawHeader(doc, 'PRESCRIPTION');

    doc.fontSize(13).font('Helvetica-Bold').fillColor('#222')
       .text(`Dr. ${appointment.doctor.name}`, 50, 110);
    doc.fontSize(10).font('Helvetica').fillColor('#555')
       .text(`${appointment.doctor.qualification || 'MBBS, MD (Pediatrics)'} · ${appointment.doctor.specialization || 'Pediatrician'}`);
    if (appointment.doctor.clinicName) {
      doc.fontSize(9).fillColor('#777').text(`${appointment.doctor.clinicName}`);
    }
    if (appointment.doctor.registrationNumber) {
      doc.fontSize(9).fillColor('#777').text(`Reg. No: ${appointment.doctor.registrationNumber}`);
    }

    const py = 160;
    const dobObj = appointment.patient.dateOfBirth;
    const ageStr = calcAge(dobObj);
    const dobStr = dobObj ? dayjs(dobObj).format('DD MMM YYYY') : '';
    doc.fillColor('#000').fontSize(11);
    doc.font('Helvetica-Bold').text('Patient: ', 50, py, { continued: true })
       .font('Helvetica').text(appointment.patient.name);
    doc.font('Helvetica-Bold').text('Age: ', 50, py + 15, { continued: true })
       .font('Helvetica').text(
         ageStr
           ? (dobStr ? `${ageStr}  (DOB ${dobStr})` : ageStr)
           : (dobStr ? `(DOB ${dobStr})` : 'N/A')
       );
    doc.font('Helvetica-Bold').text('Gender: ', 50, py + 30, { continued: true })
       .font('Helvetica').text(appointment.patient.gender || 'N/A');
    doc.font('Helvetica-Bold').text('Phone: ', 50, py + 45, { continued: true })
       .font('Helvetica').text(`+91 ${appointment.patient.phone}`);

    doc.font('Helvetica-Bold').text('Date: ', 320, py, { continued: true })
       .font('Helvetica').text(dayjs(appointment.date).format('DD MMM YYYY'));
    doc.font('Helvetica-Bold').text('Time: ', 320, py + 15, { continued: true })
       .font('Helvetica').text(appointment.startTime ? dayjs(`2000-01-01T${appointment.startTime}`).format('hh:mm A') : '—');
    doc.font('Helvetica-Bold').text('Mode: ', 320, py + 30, { continued: true })
       .font('Helvetica').text(appointmentModeLabel(appointment.consultationType));

    // Vitals row (if recorded)
    if (prescription.weight || prescription.height) {
      doc.font('Helvetica-Bold').text('Weight: ', 320, py + 45, { continued: true })
         .font('Helvetica').text(prescription.weight ? `${prescription.weight} kg` : '—');
      doc.font('Helvetica-Bold').text('Height: ', 320, py + 60, { continued: true })
         .font('Helvetica').text(prescription.height);
    }

    doc.moveTo(50, py + 95).lineTo(doc.page.width - 50, py + 95).strokeColor(BRAND_BLUE).stroke();

    let cursorY = py + 110;
    const section = (label, value) => {
      if (!value) return;
      doc.fontSize(11).font('Helvetica-Bold').fillColor(BRAND_BLUE).text(label, 50, cursorY);
      doc.fontSize(11).font('Helvetica').fillColor('#222').text(value, 50, cursorY + 14, {
        width: doc.page.width - 100
      });
      cursorY = doc.y + 10;
    };

    section('Chief Complaint', prescription.chiefComplaint);
    section('Past History', prescription.pastHistory);
    section('Diagnosis', prescription.diagnosis);
    section('Allergies', prescription.allergies);
    section('Investigations', prescription.investigations);

    if (Array.isArray(prescription.medications) && prescription.medications.length) {
      doc.fontSize(11).font('Helvetica-Bold').fillColor(BRAND_BLUE).text('Medications', 50, cursorY);
      cursorY += 18;
      doc.rect(50, cursorY, doc.page.width - 100, 22).fill(BRAND_MINT);
      doc.fillColor('#000').fontSize(10).font('Helvetica-Bold');
      doc.text('Medicine', 60, cursorY + 6);
      doc.text('Dose', 200, cursorY + 6);
      doc.text('Frequency', 280, cursorY + 6);
      doc.text('Duration', 390, cursorY + 6);
      doc.text('Instructions', 470, cursorY + 6);
      cursorY += 25;
      doc.font('Helvetica').fontSize(10);
      prescription.medications.forEach((m, i) => {
        if (i % 2 === 0) {
          doc.rect(50, cursorY - 2, doc.page.width - 100, 20).fill('#F8FAFB').fillColor('#000');
        }
        doc.text(m.name || '', 60, cursorY + 3, { width: 130 });
        doc.text(m.dose || '', 200, cursorY + 3, { width: 70 });
        doc.text(m.frequency || '', 280, cursorY + 3, { width: 100 });
        doc.text(m.duration || '', 390, cursorY + 3, { width: 70 });
        doc.text(m.instructions || '', 470, cursorY + 3, { width: 80 });
        cursorY += 20;
      });
      cursorY += 10;
    }

    section('Advice', prescription.advice);
    if (prescription.followUpDate) section('Follow-up', dayjs(prescription.followUpDate).format('DD MMM YYYY'));

    // Signature block (uploaded signature image when available).
    drawSignatureBlock(doc, appointment.doctor, { y: doc.page.height - 110 });

    doc.fontSize(8).fillColor('#888')
       .text('This is a digitally generated prescription from NeoKidsPro EMR. neokidspro.in',
             50, doc.page.height - 40, { align: 'center', width: doc.page.width - 100, lineBreak: false, ellipsis: true });

    doc.end();
    stream.on('finish', () => resolve({
      filepath, filename,
      url: publicUrlForAppointmentPdf('prescription', appointment.id)
    }));
    stream.on('error', reject);
  });
}

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];

async function generateSettlementInvoice({ settlement, doctor, rows, invoiceNumber }) {
  ensureDir(path.join(STORAGE, 'invoices'));

  const filename = `settlement_${settlement.id}.pdf`;
  const filepath = path.join(STORAGE, 'invoices', filename);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(filepath);

    doc.pipe(stream);

    drawHeader(doc, 'SETTLEMENT INVOICE');

    const monthLabel =
      `${MONTH_NAMES[settlement.periodMonth - 1]} ${settlement.periodYear}`;

    doc.fontSize(11).font('Helvetica').fillColor('#333');
    doc.text(`Invoice No: ${invoiceNumber}`, 50, 110);
    doc.text(`Period: ${monthLabel}`, 50, 125);
    doc.text(`Generated: ${dayjs().format('DD MMM YYYY, HH:mm')}`, 50, 140);

    doc.text(
      `Status: ${settlement.status}` +
      (settlement.paidAt
        ? ` · Paid ${dayjs(settlement.paidAt).format('DD MMM YYYY')}`
        : ''),
      50,
      155
    );

    doc.fontSize(12).font('Helvetica-Bold')
       .text('Payee (Doctor):', 50, 190);

    doc.fontSize(11).font('Helvetica');
    doc.text(`Dr. ${doctor.name}`, 50, 207);
    doc.text(doctor.specialization || 'Pediatrician', 50, 222);

    if (doctor.email) {
      doc.text(doctor.email, 50, 237);
    }

    doc.fontSize(12).font('Helvetica-Bold')
       .text('Payer (Clinic):', 320, 190);

    doc.fontSize(11).font('Helvetica');
    doc.text('NeoKidsPro Pediatric Clinic', 320, 207);
    doc.text('neokidspro.in', 320, 222);

    const sumTop = 275;

    doc.rect(50, sumTop, doc.page.width - 100, 25)
       .fill(BRAND_MINT);

    doc.fillColor('#000')
       .fontSize(11)
       .font('Helvetica-Bold');

    doc.text('Description', 60, sumTop + 8);
    doc.text('Basis', 300, sumTop + 8);
    doc.text('Amount (₹)', 460, sumTop + 8, {
      width: 80,
      align: 'right'
    });

    const num = (v) => Number(v || 0).toFixed(2);

    const lines = [
      ['Total Consultations', `${settlement.totalConsultations} appt(s)`, settlement.totalConsultations, false],
      ['Total Revenue Collected', 'Cashfree only', settlement.totalRevenue, true],
      [`Clinic Share (${Number(settlement.clinicSharePercent)}%)`, 'of total', settlement.clinicShareAmount, true],
      [`Doctor Gross Share (${Number(settlement.doctorSharePercent)}%)`, 'of total', settlement.doctorGrossAmount, true],
      [`TDS Deducted (${Number(settlement.tdsPercent)}%)`, 'of doctor gross', settlement.tdsAmount, true]
    ];

    let y = sumTop + 35;

    doc.font('Helvetica')
       .fontSize(11)
       .fillColor('#222');

    lines.forEach((row, i) => {
      if (i % 2 === 0) {
        doc.rect(50, y - 3, doc.page.width - 100, 20)
           .fill('#F8FAFB')
           .fillColor('#222');
      }

      doc.text(String(row[0]), 60, y);
      doc.text(String(row[1]), 300, y);
      doc.text(
        row[3] ? num(row[2]) : String(row[2]),
        460, y, { width: 80, align: 'right' }
      );

      y += 22;
    });

    y += 8;

    doc.rect(50, y, doc.page.width - 100, 32)
       .fill(BRAND_BLUE);

    doc.fillColor('white')
       .font('Helvetica-Bold')
       .fontSize(13);

    doc.text('Net Payable to Doctor', 60, y + 10);
    doc.text(`₹ ${num(settlement.doctorNetAmount)}`, 460, y + 10, {
      width: 80,
      align: 'right'
    });

    doc.fillColor('#000');
    doc.end();

 stream.on('finish', () =>
      resolve({
        filepath,
        filename,
        // Settlement invoices are downloaded via the protected admin /
        // doctor endpoints that stream `filepath` directly, so the URL
        // we store on the settlement row points at *that* endpoint — not
        // at any static mount, which would 404.
        url: `/api/admin/finance/invoices/${settlement.id}/download`
      })
    );
    stream.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────────────
// Feature 2 — Medical Certificate Generator
// ─────────────────────────────────────────────────────────────────────

// v3.4.0 — template catalog expanded; wording adapts to durationType:
//   SINGLE_DAY → "on <Certificate Date>" phrasing (school absence for one
//   day, doctor-visit proof, vaccination, etc.)
//   DATE_RANGE → "from <from> to <to>" phrasing.
// `ctx` carries: name, age, gender, examDate, examClause, reason, fromDate,
// toDate, restDays, singleDate.
const CERT_TEMPLATES = {
  GENERAL: {
    title: 'MEDICAL CERTIFICATE',
    body: ({ name, age, gender, examClause, reason }) =>
      `This is to certify that ${name}${age ? `, aged ${age}` : ''}${gender ? `, ${String(gender).toLowerCase()}` : ''}, ${examClause}. ${reason}`
  },
  SCHOOL_LEAVE: {
    title: 'SCHOOL LEAVE CERTIFICATE',
    body: ({ name, age, gender, examClause, reason, fromDate, toDate, restDays, singleDate }) => {
      let s = `This is to certify that ${name}${age ? `, aged ${age}` : ''}, ${examClause}. ${reason}`;
      if (singleDate) {
        s += ` ${cap(name)} is advised to remain absent from school on ${singleDate}.`;
      } else if (fromDate && toDate) {
        s += ` ${cap(name)} is advised to remain absent from school from ${fromDate} to ${toDate}${restDays ? ` (${restDays} day${restDays === 1 ? '' : 's'})` : ''}.`;
      }
      return s;
    }
  },
  FITNESS: {
    title: 'FITNESS CERTIFICATE',
    body: ({ name, age, gender, examClause, reason }) =>
      `This is to certify that ${name}${age ? `, aged ${age}` : ''}${gender ? `, ${String(gender).toLowerCase()}` : ''}, ${examClause} and is found to be medically fit. ${reason}`
  },
  MEDICAL_REST: {
    title: 'REST ADVISED CERTIFICATE',
    body: ({ name, age, gender, examClause, reason, fromDate, toDate, restDays, singleDate }) => {
      let s = `This is to certify that ${name}${age ? `, aged ${age}` : ''}${gender ? `, ${String(gender).toLowerCase()}` : ''}, ${examClause}. ${reason}`;
      if (singleDate) {
        s += ` ${cap(name)} is advised rest on ${singleDate}.`;
      } else if (restDays || (fromDate && toDate)) {
        s += ` ${cap(name)} is advised complete medical rest${restDays ? ` for ${restDays} day${restDays === 1 ? '' : 's'}` : ''}${fromDate && toDate ? ` from ${fromDate} to ${toDate}` : ''}.`;
      }
      return s;
    }
  },
  VACCINATION: {
    title: 'VACCINATION CERTIFICATE',
    body: ({ name, age, gender, examClause, reason, singleDate }) =>
      `This is to certify that ${name}${age ? `, aged ${age}` : ''}${gender ? `, ${String(gender).toLowerCase()}` : ''} was administered vaccination at our clinic on ${singleDate || examClause.replace(/^(was examined|was examined via teleconsultation) /, '')}. ${reason}`
  },
  RETURN_TO_SCHOOL: {
    title: 'RETURN TO SCHOOL CERTIFICATE',
    body: ({ name, age, gender, examClause, reason, singleDate }) => {
      const dateStr = singleDate ? ` on ${singleDate}` : '';
      return `This is to certify that ${name}${age ? `, aged ${age}` : ''}, ${examClause} and is now medically fit to return to school${dateStr}. ${reason}`;
    }
  }
};

function cap(s) {
  const str = String(s || '').trim();
  if (!str) return 'The patient';
  return str;
}

function fmtCertDate(d) {
  return d ? dayjs(d).format('DD MMM YYYY') : null;
}

/**
 * Generate a professional medical certificate PDF.
 *
 * @param {Object} args
 * @param {Object} args.certificate  MedicalCertificate row (with certificateNumber, templateKey, etc.)
 * @param {Object} args.doctor       Doctor row (name, qualification, registrationNumber, clinicName, clinicAddress, signatureUrl)
 * @param {Object} args.patient      Patient row
 * @returns {{ filepath, filename, url }}
 */
async function generateMedicalCertificate({ certificate, doctor, patient }) {
  ensureDir(path.join(STORAGE, 'certificates'));
  const filename = `certificate_${certificate.id}.pdf`;
  const filepath = path.join(STORAGE, 'certificates', filename);

  const tpl = CERT_TEMPLATES[certificate.templateKey] || CERT_TEMPLATES.GENERAL;
  const examDate = fmtCertDate(certificate.issuedAt);
  const name = certificate.patientNameSnapshot || (patient && patient.name) || 'the patient';
  const age = certificate.patientAgeSnapshot || (patient ? calcAge(patient.dateOfBirth) : '') || null;
  const gender = certificate.patientGenderSnapshot || (patient && patient.gender) || null;

  // ── v3.4.0 — consultation mode (snapshot first, live appointment second) ──
  // In-person (OFFLINE) → clinic name + address + contact block.
  // Online  (ONLINE)    → "Teleconsultation" identity, doctor details only,
  //                       no physical clinic address block.
  const consultType = certificate.consultationType || (certificate.appointment && certificate.appointment.consultationType) || null;
  const isOnline = consultType === 'ONLINE';
  const examClause = isOnline
    ? `was examined via teleconsultation (online consultation) on ${examDate}`
    : `was examined at our clinic on ${examDate}`;

  // ── v3.4.0 — duration semantics (legacy rows fall back to DATE_RANGE) ──
  const durationType = certificate.durationType === 'SINGLE_DAY' ? 'SINGLE_DAY' : 'DATE_RANGE';
  const singleDate = durationType === 'SINGLE_DAY' ? fmtCertDate(certificate.certificateDate) : null;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true, autoFirstPage: true });
    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);

    // ── Letterhead ──────────────────────────────────────────────────
    drawHeader(doc, tpl.title);

    // Identity block under the band (left) + certificate meta (right).
    let ly = 100;
    if (isOnline) {
      // Teleconsultation: doctor details only — never a physical clinic
      // address block (the consultation did not happen at the clinic).
      doc.fontSize(12).font('Helvetica-Bold').fillColor(BRAND_DARK)
         .text(`Dr. ${doctor.name}`, 50, ly);
      doc.fontSize(9).font('Helvetica').fillColor('#555');
      let ty = ly + 16;
      doc.text(`${doctor.qualification || 'MBBS, MD (Pediatrics)'} · ${doctor.specialization || 'Pediatrician'}`, 50, ty, { width: 260 });
      ty += 12;
      doc.fillColor(BRAND_BLUE).font('Helvetica-Bold')
         .text('Teleconsultation / Online Consultation', 50, ty, { width: 260 });
      ty += 12;
      doc.font('Helvetica').fillColor('#555').text('neokidspro.in', 50, ty, { width: 260 });
    } else {
      doc.fontSize(12).font('Helvetica-Bold').fillColor(BRAND_DARK)
         .text(doctor.clinicName || 'NeoKidsPro Pediatric Clinic', 50, ly);
      doc.fontSize(9).font('Helvetica').fillColor('#555');
      if (doctor.clinicAddress) {
        doc.text(String(doctor.clinicAddress), 50, ly + 16, { width: 260 });
      }
      doc.text('neokidspro.in', 50, ly + (doctor.clinicAddress ? 16 + Math.min(3, Math.ceil(String(doctor.clinicAddress).length / 45)) * 11 : 16), { width: 260 });
    }

    doc.fontSize(9).fillColor('#555')
       .text(`Certificate ID: ${certificate.certificateNumber}`, 320, ly, { width: 225, align: 'right' });
    doc.text(`Date of Issue: ${examDate}`, 320, ly + 14, { width: 225, align: 'right' });
    // Consultation mode is always explicit on the certificate.
    doc.text(`Consultation: ${appointmentModeLabel(consultType || 'OFFLINE')}`, 320, ly + 28, { width: 225, align: 'right' });
    // Show the linked appointment's date + time when available.
    if (certificate.appointment && certificate.appointment.date) {
      const apptDt = `${fmtCertDate(certificate.appointment.date)}${certificate.appointment.startTime ? ' · ' + dayjs(`2000-01-01T${certificate.appointment.startTime}`).format('hh:mm A') : ''}`;
      doc.text(`Appointment: ${apptDt}`, 320, ly + 42, { width: 225, align: 'right' });
    }

    // ── Title ────────────────────────────────────────────────────────
    const titleY = 185;
    doc.fontSize(18).font('Helvetica-Bold').fillColor(BRAND_DARK)
       .text(tpl.title, 50, titleY, { align: 'center', width: doc.page.width - 100 });
    doc.moveTo(doc.page.width / 2 - 90, titleY + 26)
       .lineTo(doc.page.width / 2 + 90, titleY + 26)
       .strokeColor(BRAND_BLUE).lineWidth(1.5).stroke();

    // ── Patient summary line ─────────────────────────────────────────
    let cy = titleY + 48;
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#000').text('Patient: ', 50, cy, { continued: true })
       .font('Helvetica').text(name);
    cy += 16;
    if (age || gender) {
      doc.font('Helvetica-Bold').text('Age / Gender: ', 50, cy, { continued: true })
         .font('Helvetica').text(`${age || 'N/A'}${gender ? ' / ' + gender : ''}`);
      cy += 16;
    }
    if (patient && patient.phone) {
      doc.font('Helvetica-Bold').text('Phone: ', 50, cy, { continued: true })
         .font('Helvetica').text(`+91 ${patient.phone}`);
      cy += 16;
    }

    // ── Certificate body ─────────────────────────────────────────────
    cy += 12;
    const bodyText = tpl.body({
      name, age, gender, examDate, examClause, singleDate,
      reason: certificate.reason,
      fromDate: fmtCertDate(certificate.fromDate),
      toDate: fmtCertDate(certificate.toDate),
      restDays: certificate.restDays
    });
    doc.fontSize(12).font('Helvetica').fillColor('#222')
       .text(bodyText, 50, cy, {
         width: doc.page.width - 100,
         lineGap: 4,
         align: 'left'
       });
    cy = doc.y + 14;

    if (certificate.diagnosis) {
      doc.font('Helvetica-Bold').fillColor(BRAND_DARK).fontSize(11).text('Diagnosis', 50, cy);
      doc.font('Helvetica').fillColor('#222').fontSize(11)
         .text(certificate.diagnosis, 50, cy + 14, { width: doc.page.width - 100 });
      cy = doc.y + 12;
    }

    if (durationType === 'SINGLE_DAY' && singleDate) {
      doc.font('Helvetica-Bold').fillColor(BRAND_DARK).fontSize(11).text('Certificate Date', 50, cy);
      doc.font('Helvetica').fillColor('#222').fontSize(11)
         .text(singleDate, 50, cy + 14, { width: doc.page.width - 100 });
      cy = doc.y + 12;
    } else if (certificate.restDays && certificate.fromDate && certificate.toDate) {
      doc.font('Helvetica-Bold').fillColor(BRAND_DARK).fontSize(11).text('Recommended Rest', 50, cy);
      doc.font('Helvetica').fillColor('#222').fontSize(11)
         .text(`${certificate.restDays} day${certificate.restDays === 1 ? '' : 's'} — from ${fmtCertDate(certificate.fromDate)} to ${fmtCertDate(certificate.toDate)}`,
               50, cy + 14, { width: doc.page.width - 100 });
      cy = doc.y + 12;
    }

    if (certificate.additionalNotes) {
      doc.font('Helvetica-Bold').fillColor(BRAND_DARK).fontSize(11).text('Additional Notes', 50, cy);
      doc.font('Helvetica').fillColor('#222').fontSize(11)
         .text(certificate.additionalNotes, 50, cy + 14, { width: doc.page.width - 100 });
    }

    // ── Signature block (stays on this page) ─────────────────────────
    drawSignatureBlock(doc, doctor, { y: doc.page.height - 175 });

    // ── Footer ───────────────────────────────────────────────────────
    const issuerLine = isOnline
      ? `This certificate was issued electronically by Dr. ${doctor.name} following a teleconsultation and is valid without a physical seal. Verify with Certificate ID: ${certificate.certificateNumber}`
      : `This certificate was issued electronically by ${doctor.clinicName || 'NeoKidsPro Pediatric Clinic'} and is valid without a physical seal. Verify with Certificate ID: ${certificate.certificateNumber}`;
    doc.fontSize(8).fillColor('#888')
       .text(issuerLine,
         50, doc.page.height - 40, { align: 'center', width: doc.page.width - 100, lineBreak: false, ellipsis: true }
       );

    doc.end();
    stream.on('finish', () => resolve({
      filepath,
      filename,
      url: `/api/files/certificates/${certificate.id}.pdf`
    }));
    stream.on('error', reject);
  });
}

module.exports = {
  generateInvoice,
  generatePrescription,
  generateSettlementInvoice,
  generateMedicalCertificate,
  // exported for tests / future document types
  resolveSignaturePath,
  drawSignatureBlock
};
