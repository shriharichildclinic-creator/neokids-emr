const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { calcAge } = require('../utils/date');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '..', '..', 'storage');
// Brand palette — matches the actual site theme (public/assets/neokids-theme.css
// --nk-teal-*/--nk-ink), not the unrelated blue this file used to hardcode.
const BRAND_TEAL_LIGHT = '#89BCBD'; // nk-teal-400 — header band gradient start
const BRAND_TEAL_DARK  = '#5A9495'; // nk-teal-600 — header band gradient end
const BRAND_BLUE = BRAND_TEAL_DARK; // kept as the name every generator already calls
const BRAND_MINT = '#DCEBEB';       // nk-teal-100 — light fill for table headers
const BRAND_DARK = '#0F2E3A';       // nk-ink — unchanged, already on-brand
const BRAND_ACCENT = '#F9A945';     // nk-orange-400 — warm accent for highlights
// Drop a PNG/JPG here (pdfkit can't render SVG) to have every PDF pick it up
// automatically — drawHeader() below checks for it on every call.
const LOGO_PATH = path.join(__dirname, '..', '..', 'public', 'assets', 'logo-neokidspro.png');

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

// Sub-brand line printed INSIDE the blue letterhead band on every document.
// Kept as the single source of truth so no PDF template ever prints the
// clinic name a second time further down the page as a stray branding block.
const SUB_BRAND_NAME = 'Shri Hari Child Clinic, Borivali';
const HEADER_BAND_HEIGHT = 88;

// Single layout for every PDF letterhead. Three stacked lines inside one
// solid blue band at the top of the page so the brand reads as ONE header
// block, not a brand line + a stray clinic name in the document body.
//
//   ┌─────────────────────────────────────────────────────────┐
//   │ NeoKidsPro                                       TITLE  │
//   │ Pediatric Network of Doctors                            │
//   │ Shri Hari Child Clinic, Borivali                        │
//   └─────────────────────────────────────────────────────────┘
//
// Root-cause fix for empty trailing pages carried over: PDFKit auto
// page-breaks whenever a draw crosses (page.height - bottomMargin). These
// are fixed-layout single-page documents, so the auto-break is zeroed out
// once and the signature block is separately clamped to stay on this page.
// Caches the opened logo image (and whether it even exists) across calls —
// drawHeader() runs on every single PDF, and re-checking the filesystem
// plus re-decoding the PNG on every page/document would be wasteful.
let _logoImage; // undefined = not checked yet, null = missing/unreadable
function getLogoImage(doc) {
  if (_logoImage !== undefined) return _logoImage;
  try {
    _logoImage = fs.existsSync(LOGO_PATH) ? doc.openImage(LOGO_PATH) : null;
  } catch (_) {
    _logoImage = null; // corrupt/unreadable file — fall back to text-only header
  }
  return _logoImage;
}

function drawHeader(doc, title) {
  if (doc.page && doc.page.margins) doc.page.margins.bottom = 0;
  // The logo wordmark's "Neo" text is a pale colour meant for a plain white
  // background (matches the app icon) — it washed out to near-illegible on
  // the old solid teal band. Header is now a white band with a thin teal
  // accent rule underneath, so the logo renders exactly as designed while
  // the page still reads as branded.
  doc.rect(0, 0, doc.page.width, HEADER_BAND_HEIGHT).fill('#FFFFFF');
  doc.rect(0, HEADER_BAND_HEIGHT - 4, doc.page.width, 4).fill(BRAND_TEAL_DARK);

  const logo = getLogoImage(doc);
  let textX = 50;
  doc.fillColor(BRAND_DARK);

  if (logo) {
    // The logo is a full wordmark (icon + "NeoKidsPro" text baked into the
    // image) — drawing the brand name a second time next to it would look
    // redundant, so only the tagline/sub-brand run alongside it, vertically
    // centered against the logo instead of the old 3-line text stack.
    const logoH = 58;
    const logoW = logoH * (logo.width / logo.height);
    doc.image(logo, 50, (HEADER_BAND_HEIGHT - logoH) / 2 - 2, { height: logoH });
    textX = 50 + logoW + 16;
    doc.fillColor(BRAND_TEAL_DARK).font('Helvetica').fontSize(10).text('Pediatric Network of Doctors', textX, 30, { lineBreak: false });
    doc.fillColor(BRAND_DARK).font('Helvetica-Bold').fontSize(10).text(SUB_BRAND_NAME, textX, 46, { lineBreak: false });
  } else {
    doc.fillColor(BRAND_DARK).font('Helvetica-Bold').fontSize(22).text('NeoKidsPro', textX, 14, { lineBreak: false });
    doc.fillColor(BRAND_TEAL_DARK).font('Helvetica').fontSize(10).text('Pediatric Network of Doctors', textX, 40, { lineBreak: false });
    doc.fillColor(BRAND_DARK).font('Helvetica-Bold').fontSize(10).text(SUB_BRAND_NAME, textX, 55, { lineBreak: false });
  }

  doc.fillColor(BRAND_DARK).font('Helvetica-Bold').fontSize(16)
     .text(title, 0, 22, { align: 'right', width: doc.page.width - 50, lineBreak: false, ellipsis: true });
  doc.fillColor('black');
  doc.y = HEADER_BAND_HEIGHT + 12;
}

// ─────────────────────────────────────────────────────────────────────
// Feature 3 — Doctor Digital Signature helper
//
// Resolves the local disk path for the doctor's uploaded signature PNG
// (if any) and returns it. Stored under storage/signatures/<uuid>.<ext>;
// the row only keeps the public/relative URL fragment so we re-derive
// the disk path here without hitting the auth layer.
// ─────────────────────────────────────────────────────────────────────
function resolveSignaturePath(doctor) {
  if (!doctor || !doctor.signatureUrl) return null;
  try {
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

// Draws the doctor's signature block at the bottom-right of the current
// page. Name, qualification, registration and signature image always stay
// TOGETHER — PDFKit auto page-breaks any draw that crosses the bottom
// margin, so the block is clamped to fit and uses flowing relative y
// offsets (never absolute jumps that could land across pages).
function drawSignatureBlock(doc, doctor, opts = {}) {
  const sigPath   = resolveSignaturePath(doctor);
  const leftX     = doc.page.width - 210;
  const blockW    = 200;
  const sigMaxH   = 46;
  const sigInset  = 6;
  const hasReg    = !!(doctor && doctor.registrationNumber);

  const blockH = sigMaxH + 6 + 14 + 12 + (hasReg ? 11 : 0) + 10;
  const bottomLimit = doc.page.height - 48;
  const maxY = bottomLimit - blockH;
  let y = Math.min(opts.y || maxY, maxY);
  if (y < 40) y = 40;

  let ty = y;
  if (sigPath) {
    try {
      doc.image(sigPath, leftX + sigInset, ty + sigInset,
        { fit: [blockW - sigInset * 2, sigMaxH - sigInset * 2], align: 'left', valign: 'top' });
    } catch (e) {
      doc.fontSize(10).fillColor('#555').text('___________________________', leftX, ty + sigMaxH - 16);
    }
  } else {
    doc.fontSize(10).fillColor('#555').text('___________________________', leftX, ty + sigMaxH - 16);
  }
  ty += sigMaxH + 6;

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
    doc.fillColor('#555').fontSize(9)
       .text(`Appointment: ${dayjs(appointment.date).format('DD MMM YYYY')} · ${appointment.startTime ? dayjs(`2000-01-01T${appointment.startTime}`).format('hh:mm A') : '—'}`, 320, 222);
    doc.fillColor('#333');

    const tableTop = 285;
    const amtX = 440, amtW = doc.page.width - 50 - amtX;
    doc.rect(50, tableTop, doc.page.width - 100, 25).fill(BRAND_MINT);
    doc.fillColor('#000').fontSize(11).font('Helvetica-Bold');
    doc.text('Description', 60, tableTop + 8);
    doc.text('Date', 260, tableTop + 8);
    doc.text('Type', 360, tableTop + 8);
    doc.text('Amount (Rs.)', amtX, tableTop + 8, { width: amtW, align: 'right' });

    doc.font('Helvetica').fontSize(11);
    const rowY = tableTop + 35;
    doc.text('Consultation Fee', 60, rowY);
    doc.text(dayjs(appointment.date).format('DD MMM YYYY'), 260, rowY);
    doc.text(appointment.consultationType, 360, rowY);
    doc.text(`${Number(appointment.feeAtBooking).toFixed(2)}`, amtX, rowY, { width: amtW, align: 'right' });

    doc.moveTo(50, rowY + 30).lineTo(doc.page.width - 50, rowY + 30).stroke();
    doc.font('Helvetica-Bold').fontSize(12);
    doc.text('Total Paid:', 360, rowY + 45);
    doc.text(`Rs. ${Number(appointment.feeAtBooking).toFixed(2)}`, amtX, rowY + 45, { width: amtW, align: 'right' });

    drawSignatureBlock(doc, appointment.doctor, { y: doc.page.height - 185 });

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

    if (appointment.consultationType === 'ONLINE') {
      const disclaimerText = 'This prescription has been issued following a teleconsultation conducted through NeoKidsPro, via NeoKidsPro.in. If your child develops worsening symptoms, experiences a medical emergency, or requires urgent medical attention, please visit your nearest hospital, emergency department, or healthcare facility immediately. Teleconsultation does not replace emergency medical care.';
      const boxX = 50, boxW = doc.page.width - 100, boxPad = 8;
      doc.fontSize(8).font('Helvetica');
      const textH = doc.heightOfString(disclaimerText, { width: boxW - boxPad * 2 });
      const boxH = textH + boxPad * 2;
      doc.rect(boxX, cursorY, boxW, boxH).fillAndStroke('#FFF8E1', '#F0D98C');
      doc.fillColor('#7A5B00').text(disclaimerText, boxX + boxPad, cursorY + boxPad, { width: boxW - boxPad * 2 });
      cursorY += boxH + 10;
    }

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

    doc.font('Helvetica').fillColor('#222').fontSize(11);
    doc.text('NeoKidsPro', 320, 207);
    // Letterhead already carries the brand + sub-brand — body only lists
    // the legal category and URL. No duplicate "Shri Hari Child Clinic"
    // block lower in the page.
    doc.text('Pediatric Network of Doctors', 320, 222);
    doc.text('neokidspro.in', 320, 237);

    const sumTop = 275;

    doc.rect(50, sumTop, doc.page.width - 100, 25)
       .fill(BRAND_MINT);

    doc.fillColor('#000')
       .fontSize(11)
       .font('Helvetica-Bold');

    doc.text('Description', 60, sumTop + 8);
    doc.text('Basis', 300, sumTop + 8);
    doc.text('Amount (Rs.)', 440, sumTop + 8, {
      width: doc.page.width - 50 - 440,
      align: 'right'
    });

    const num = (v) => Number(v || 0).toFixed(2);

    const lines = [
      ['Total Consultations', `${settlement.totalConsultations} appt(s)`, settlement.totalConsultations, false],
      ['Total Revenue Collected', 'Cashfree only', settlement.totalRevenue, true],
      [`NeoKidsPro Share (${Number(settlement.clinicSharePercent)}%)`, 'of total', settlement.clinicShareAmount, true],
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

      doc.text(String(row[0]), 60, y, { width: 230, lineBreak: false, ellipsis: true });
      doc.text(String(row[1]), 300, y, { width: 130, lineBreak: false, ellipsis: true });
      doc.text(
        row[3] ? num(row[2]) : String(row[2]),
        440, y, { width: doc.page.width - 50 - 440, align: 'right' }
      );

      y += 22;
    });

    y += 8;

    doc.rect(50, y, doc.page.width - 100, 32)
       .fill(BRAND_BLUE);

    doc.fillColor('white')
       .font('Helvetica-Bold')
       .fontSize(13);

    doc.text(`Net Payable to Doctor: Rs. ${num(settlement.netPayable)}`,
      50, y + 9, { width: doc.page.width - 100, align: 'center' });

    y += 50;

    if (settlement.notes) {
      doc.fontSize(10).font('Helvetica').fillColor('#555')
         .text(`Notes: ${settlement.notes}`, 50, y, { width: doc.page.width - 100 });
      y = doc.y + 8;
    }

    drawSignatureBlock(doc, doctor, { y });

    doc.fontSize(9).font('Helvetica').fillColor('#888');
    doc.text('This is a computer-generated settlement statement from NeoKidsPro EMR.',
      50, doc.page.height - 40, { align: 'center', width: doc.page.width - 100, lineBreak: false, ellipsis: true });

    doc.end();

    stream.on('finish', () => resolve({
      filepath, filename,
      url: `/api/files/settlement-invoices/${settlement.id}.pdf`
    }));
    stream.on('error', reject);
  });
}

async function generateConsultationInvoice({ invoice, appointment, patient, doctor, medicalCentre }) {
  ensureDir(path.join(STORAGE, 'consultation-invoices'));
  const filename = `consult_invoice_${invoice.id}.pdf`;
  const filepath = path.join(STORAGE, 'consultation-invoices', filename);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true, autoFirstPage: true });
    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);
    // Letterhead already carries the clinic sub-brand. Body prints only
    // the location-specific address (which varies per centre/doctor).
    const clinicAddr = (medicalCentre && medicalCentre.address) || doctor.clinicAddress || null;
    drawHeader(doc, 'INVOICE');

    doc.fontSize(11).font('Helvetica').fillColor('#333');
    doc.text(`Invoice No: ${invoice.invoiceNumber}`, 50, 110);
    doc.text(`Date: ${dayjs(invoice.createdAt).format('DD MMM YYYY')}`, 50, 125);
    doc.text(`Payment: ${invoice.paymentMethod || 'CASH'} · ${invoice.status}`, 50, 140);

    doc.fontSize(12).font('Helvetica-Bold').text('Bill To:', 50, 175);
    doc.fontSize(11).font('Helvetica');
    doc.text(patient.name, 50, 192);
    doc.text(`Phone: +91 ${patient.phone}`, 50, 207);
    if (patient.email) doc.text(`Email: ${patient.email}`, 50, 222);

    doc.fontSize(12).font('Helvetica-Bold').text('Consultation By:', 320, 175);
    doc.fontSize(11).font('Helvetica');
    doc.text(`Dr. ${doctor.name}`, 320, 192);
    doc.text(doctor.specialization || 'Pediatrician', 320, 207);
    doc.fillColor('#555').fontSize(9)
       .text(`Appointment: ${dayjs(appointment.date).format('DD MMM YYYY')} · ${appointment.startTime ? dayjs(`2000-01-01T${appointment.startTime}`).format('hh:mm A') : '—'}`, 320, 222);
    doc.fillColor('#333');

    let cy = 245;
    if (clinicAddr) {
      doc.fontSize(9).font('Helvetica').fillColor('#555').text(String(clinicAddr), 50, cy, { width: 300 });
      cy += 24;
    }
    if (invoice.receptionist && invoice.receptionist.name) {
      doc.fontSize(9).font('Helvetica').fillColor('#777').text(`Billed by: ${invoice.receptionist.name} (Clinic Reception)`, 50, cy);
      cy += 12;
    }

    const tableTop = Math.max(285, cy + 12);
    const amtX = 440, amtW = doc.page.width - 50 - amtX;
    doc.rect(50, tableTop, doc.page.width - 100, 25).fill(BRAND_MINT);
    doc.fillColor('#000').fontSize(11).font('Helvetica-Bold');
    doc.text('Description', 60, tableTop + 8);
    doc.text('Date', 260, tableTop + 8);
    doc.text('Type', 360, tableTop + 8);
    doc.text('Amount (Rs.)', amtX, tableTop + 8, { width: amtW, align: 'right' });

    doc.font('Helvetica').fontSize(11);
    const rowY = tableTop + 35;
    doc.text('Consultation Fee', 60, rowY);
    doc.text(dayjs(appointment.date).format('DD MMM YYYY'), 260, rowY);
    doc.text(appointment.consultationType, 360, rowY);
    doc.text(`${Number(invoice.amount).toFixed(2)}`, amtX, rowY, { width: amtW, align: 'right' });

    doc.moveTo(50, rowY + 30).lineTo(doc.page.width - 50, rowY + 30).stroke();
    doc.font('Helvetica-Bold').fontSize(12);
    doc.text('Total Paid:', 360, rowY + 45);
    doc.text(`Rs. ${Number(invoice.amount).toFixed(2)}`, amtX, rowY + 45, { width: amtW, align: 'right' });

    drawSignatureBlock(doc, doctor, { y: doc.page.height - 185 });

    doc.fontSize(9).font('Helvetica').fillColor('#888');
    doc.text('Thank you for choosing NeoKidsPro. This is a computer-generated invoice.',
             50, doc.page.height - 40, { align: 'center', width: doc.page.width - 100, lineBreak: false, ellipsis: true });

    doc.end();
    stream.on('finish', () => resolve({
      filepath, filename,
      url: `/api/files/consultation-invoices/${invoice.id}.pdf`
    }));
    stream.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────────────
// v4.0.0 — Pharmacy bill. Same letterhead as the consultation invoice;
// the line-item table is medicine rows (name / qty / rate / amount) and
// totals include discount + tax.
// ─────────────────────────────────────────────────────────────────────
async function generatePharmacyInvoice({ bill, medicalCentre, doctor }) {
  ensureDir(path.join(STORAGE, 'pharmacy-invoices'));
  const filename = `pharmacy_invoice_${bill.id}.pdf`;
  const filepath = path.join(STORAGE, 'pharmacy-invoices', filename);

  // Letterhead band already carries the clinic sub-brand. Body never
  // re-prints the brand string — store name + address only.
  const centreName = medicalCentre ? medicalCentre.name : 'NeoKidsPro Pharmacy';
  const centreAddr = medicalCentre && medicalCentre.address;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true, autoFirstPage: true });
    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);
    drawHeader(doc, 'PHARMACY BILL');

    doc.fontSize(11).font('Helvetica').fillColor('#333');
    doc.text(`Bill No: ${bill.billNumber}`, 50, 110);
    doc.text(`Date: ${dayjs(bill.createdAt).format('DD MMM YYYY, hh:mm A')}`, 50, 125);
    doc.text(`Status: ${bill.status || 'DRAFT'}`, 50, 140);
    doc.text(`Payment: ${bill.paymentMethod || 'CASH'}`, 50, 155);
    if (bill.billType && bill.billType !== 'PHARMACY') doc.text(`Type: ${bill.billType === 'CONSULT' ? 'Consultation' : 'Service'}`, 50, 170);

    doc.fontSize(12).font('Helvetica-Bold').text('Customer:', 50, 175);
    doc.fontSize(11).font('Helvetica');
    doc.text(bill.customerName || (bill.patient && bill.patient.name) || 'Walk-in customer', 50, 192);
    const phone = bill.customerPhone || (bill.patient && bill.patient.phone);
    if (phone) doc.text(`Phone: +91 ${phone}`, 50, 207);

    doc.fontSize(12).font('Helvetica-Bold').text('Store:', 320, 175);
    doc.fontSize(11).font('Helvetica');
    doc.text(centreName, 320, 192, { width: 225 });
    if (centreAddr) doc.fontSize(9).fillColor('#555').text(String(centreAddr), 320, 207, { width: 225 });
    if (doctor) doc.fillColor('#555').fontSize(9).text(`Ref. Doctor: Dr. ${doctor.name}`, 320, 235, { width: 225 });
    doc.fillColor('#333');

    const tableTop = 270;
    const rightEdge = doc.page.width - 50;
    const amtX = 450, amtW = rightEdge - amtX;
    const rateX = 360, rateW = 80;
    const qtyX = 320, qtyW = 34;
    doc.rect(50, tableTop, doc.page.width - 100, 25).fill(BRAND_MINT);
    doc.fillColor('#000').fontSize(11).font('Helvetica-Bold');
    doc.text('Medicine', 60, tableTop + 8);
    doc.text('Qty', qtyX, tableTop + 8, { width: qtyW, align: 'right' });
    doc.text('Rate (Rs.)', rateX, tableTop + 8, { width: rateW, align: 'right' });
    doc.text('Amount (Rs.)', amtX, tableTop + 8, { width: amtW, align: 'right' });

    doc.font('Helvetica').fontSize(10);
    let rowY = tableTop + 32;
    const items = Array.isArray(bill.items) ? bill.items : [];
    items.forEach((it, i) => {
      if (i % 2 === 0) {
        doc.rect(50, rowY - 3, doc.page.width - 100, 20).fill('#F8FAFB').fillColor('#222');
      }
      doc.text(it.name || '', 60, rowY, { width: 250, lineBreak: false, ellipsis: true });
      doc.text(String(it.quantity), qtyX, rowY, { width: qtyW, align: 'right' });
      doc.text(Number(it.unitPrice).toFixed(2), rateX, rowY, { width: rateW, align: 'right' });
      doc.text(Number(it.total).toFixed(2), amtX, rowY, { width: amtW, align: 'right' });
      rowY += 22;
    });

    rowY += 8;
    const subtotal = Number(bill.subtotal);
    const discount = Number(bill.discount);
    const tax = Number(bill.tax);
    const total = Number(bill.total);
    const labelX = 330, labelW = amtX - labelX - 6;

    doc.font('Helvetica').fontSize(10).fillColor('#555');
    doc.text('Subtotal', labelX, rowY, { width: labelW, align: 'right' }); doc.text(subtotal.toFixed(2), amtX, rowY, { width: amtW, align: 'right' });
    rowY += 16;
    if (discount > 0) {
      doc.text('Discount', labelX, rowY, { width: labelW, align: 'right' }); doc.text(`-${discount.toFixed(2)}`, amtX, rowY, { width: amtW, align: 'right' });
      rowY += 16;
    }
    if (tax > 0) {
      doc.text('Tax', labelX, rowY, { width: labelW, align: 'right' }); doc.text(tax.toFixed(2), amtX, rowY, { width: amtW, align: 'right' });
      rowY += 16;
    }
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#000');
    doc.text('Total Paid', labelX, rowY, { width: labelW, align: 'right' });
    doc.text(`Rs. ${total.toFixed(2)}`, amtX, rowY, { width: amtW, align: 'right' });
    rowY += 24;

    if (bill.notes) {
      doc.font('Helvetica').fontSize(9).fillColor('#777').text(`Notes: ${bill.notes}`, 50, rowY, { width: doc.page.width - 100 });
      rowY = doc.y + 10;
    }

    doc.fontSize(9).font('Helvetica').fillColor('#888');
    doc.text('Thank you for choosing NeoKidsPro Pharmacy. This is a computer-generated bill.',
             50, doc.page.height - 40, { align: 'center', width: doc.page.width - 100, lineBreak: false, ellipsis: true });

    doc.end();
    stream.on('finish', () => resolve({
      filepath, filename,
      url: `/api/files/pharmacy-invoices/${bill.id}.pdf`
    }));
    stream.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────────────
// Medical Certificate generator. Reuses drawHeader so the clinic name
// only ever appears inside the blue band.
// ─────────────────────────────────────────────────────────────────────

const CERT_TEMPLATES = {
  GENERAL: {
    title: 'MEDICAL CERTIFICATE',
    body: ({ name, age, gender, examDate, examClause, reason }) =>
      `This is to certify that ${name}${age ? `, aged ${age}` : ''}${gender ? ` (${gender})` : ''}, ${examClause}.\n\nBased on the examination conducted, the patient is medically fit${reason ? ` for: ${reason}` : ''}. This certificate is issued on the patient's request for the purpose stated.`
  },
  SICK_LEAVE: {
    title: 'MEDICAL CERTIFICATE — SICK LEAVE',
    body: ({ name, age, gender, examDate, examClause, restDays, reason }) => {
      const days = restDays ? ` for a period of ${restDays} day(s)` : '';
      return `This is to certify that ${name}${age ? `, aged ${age}` : ''}${gender ? ` (${gender})` : ''}, ${examClause}.\n\nThe patient was found to be suffering from ${reason || 'a medical condition'} and advised rest${days} from the date of examination.\n\nThis certificate is issued for the purpose of leave/sick-record submission.`;
    }
  },
  FITNESS: {
    title: 'MEDICAL CERTIFICATE — FITNESS',
    body: ({ name, age, gender, examDate, examClause, reason }) =>
      `This is to certify that ${name}${age ? `, aged ${age}` : ''}${gender ? ` (${gender})` : ''}, ${examClause}.\n\nThe patient has been examined and is found to be medically fit${reason ? ` for: ${reason}` : ''} at the time of examination.\n\nThis certificate is valid for the purpose stated and is issued on the patient's request.`
  },
  CHRONIC: {
    title: 'MEDICAL CERTIFICATE — CHRONIC CONDITION',
    body: ({ name, age, gender, examDate, examClause, reason }) =>
      `This is to certify that ${name}${age ? `, aged ${age}` : ''}${gender ? ` (${gender})` : ''}, ${examClause}.\n\nThe patient has been diagnosed with a chronic condition (${reason || 'as documented in clinical records'}) and is under ongoing medical management.\n\nThis certificate is issued for the purpose stated.`
  }
};

function fmtCertDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * @param {{ certificate: any, doctor: any, patient: any }} opts
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

  // Consultation mode (snapshot first, live appointment second).
  // In-person (OFFLINE) → doctor details + clinic street address only
  //                         (the brand line is in the letterhead above).
  // Online    (ONLINE)    → doctor details only.
  const consultType = certificate.consultationType || (certificate.appointment && certificate.appointment.consultationType) || null;
  const isOnline = consultType === 'ONLINE';
  const examClause = isOnline
    ? `was examined via teleconsultation (online consultation) on ${examDate}`
    : `was examined at our clinic on ${examDate}`;

  // Duration semantics.
  const durationType = certificate.durationType === 'SINGLE_DAY' ? 'SINGLE_DAY' : 'DATE_RANGE';
  const singleDate = durationType === 'SINGLE_DAY' ? fmtCertDate(certificate.certificateDate) : null;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true, autoFirstPage: true });
    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);

    drawHeader(doc, tpl.title);

    let ly = 102;
    if (isOnline) {
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
         .text(`Dr. ${doctor.name}`, 50, ly);
      doc.fontSize(9).font('Helvetica').fillColor('#555');
      let ty = ly + 16;
      doc.text(`${doctor.qualification || 'MBBS, MD (Pediatrics)'} · ${doctor.specialization || 'Pediatrician'}`, 50, ty, { width: 260 });
      ty += 12;
      if (doctor.clinicAddress) {
        doc.text(String(doctor.clinicAddress), 50, ty, { width: 260 });
        ty += Math.min(3, Math.ceil(String(doctor.clinicAddress).length / 45)) * 11;
      }
      doc.text('neokidspro.in', 50, ty, { width: 260 });
    }

    doc.fontSize(9).fillColor('#555')
       .text(`Certificate ID: ${certificate.certificateNumber}`, 320, ly, { width: 225, align: 'right' });
    doc.text(`Date of Issue: ${examDate}`, 320, ly + 14, { width: 225, align: 'right' });
    doc.text(`Consultation: ${appointmentModeLabel(consultType || 'OFFLINE')}`, 320, ly + 28, { width: 225, align: 'right' });
    if (certificate.appointment && certificate.appointment.date) {
      const apptDt = `${fmtCertDate(certificate.appointment.date)}${certificate.appointment.startTime ? ' · ' + dayjs(`2000-01-01T${certificate.appointment.startTime}`).format('hh:mm A') : ''}`;
      doc.text(`Appointment: ${apptDt}`, 320, ly + 42, { width: 225, align: 'right' });
    }

    const titleY = 185;
    doc.fontSize(18).font('Helvetica-Bold').fillColor(BRAND_DARK)
       .text(tpl.title, 50, titleY, { align: 'center', width: doc.page.width - 100 });
    doc.moveTo(doc.page.width / 2 - 90, titleY + 26)
       .lineTo(doc.page.width / 2 + 90, titleY + 26)
       .strokeColor(BRAND_BLUE).lineWidth(1.5).stroke();

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

    if (durationType === 'DATE_RANGE' && (certificate.fromDate || certificate.toDate)) {
      doc.fontSize(11).font('Helvetica-Bold').fillColor(BRAND_DARK)
         .text(`Period: ${fmtCertDate(certificate.fromDate) || '—'} → ${fmtCertDate(certificate.toDate) || '—'}`, 50, cy);
      cy = doc.y + 12;
    } else if (singleDate) {
      doc.fontSize(11).font('Helvetica-Bold').fillColor(BRAND_DARK)
         .text(`Date: ${singleDate}`, 50, cy);
      cy = doc.y + 12;
    }

    if (certificate.notes) {
      doc.fontSize(10).font('Helvetica').fillColor('#555')
         .text(`Notes: ${certificate.notes}`, 50, cy + 8, { width: doc.page.width - 100 });
      cy = doc.y + 18;
    }

    drawSignatureBlock(doc, doctor, { y: doc.page.height - 130 });

    doc.fontSize(8).fillColor('#888')
       .text(`Issued via NeoKidsPro EMR. neokidspro.in`,
             50, doc.page.height - 40, { align: 'center', width: doc.page.width - 100, lineBreak: false, ellipsis: true });

    doc.end();
    stream.on('finish', () => resolve({
      filepath, filename,
      url: `/api/files/certificates/${certificate.id}.pdf`
    }));
    stream.on('error', reject);
  });
}

module.exports = {
  generateInvoice,
  generatePrescription,
  generateSettlementInvoice,
  generateConsultationInvoice,
  generatePharmacyInvoice,
  generateMedicalCertificate,
  SUB_BRAND_NAME,
  drawHeader,
  HEADER_BAND_HEIGHT,
  BRAND_TEAL_LIGHT,
  BRAND_TEAL_DARK,
  BRAND_MINT,
  BRAND_DARK,
  BRAND_ACCENT
};
