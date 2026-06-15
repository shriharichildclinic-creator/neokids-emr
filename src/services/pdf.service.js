const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { calcAge } = require('../utils/date');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '..', '..', 'storage');
const BRAND_BLUE = '#4DA8FF';
const BRAND_MINT = '#B8F2E6';

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function drawHeader(doc, title) {
  doc.rect(0, 0, doc.page.width, 80).fill(BRAND_BLUE);
  doc.fillColor('white').fontSize(22).font('Helvetica-Bold').text('NeoKidsPro', 50, 28);
  doc.fontSize(10).font('Helvetica').text('Pediatric Clinic · neokidspro.in', 50, 55);
  doc.fontSize(16).font('Helvetica-Bold').fillColor('white')
     .text(title, 0, 32, { align: 'right', width: doc.page.width - 50 });
  doc.fillColor('black').moveDown(3);
}

async function generateInvoice(appointment) {
  ensureDir(path.join(STORAGE, 'invoices'));
  const filename = `invoice_${appointment.id}.pdf`;
  const filepath = path.join(STORAGE, 'invoices', filename);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
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

    const tableTop = 270;
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

    doc.fontSize(9).font('Helvetica').fillColor('#888');
    doc.text('Thank you for choosing NeoKidsPro. This is a computer-generated invoice.',
             50, doc.page.height - 80, { align: 'center', width: doc.page.width - 100 });

    doc.end();
    stream.on('finish', () => resolve({
      filepath, filename,
      url: `${process.env.PUBLIC_STORAGE_URL || '/files'}/invoices/${filename}`
    }));
    stream.on('error', reject);
  });
}

async function generatePrescription(appointment, prescription) {
  ensureDir(path.join(STORAGE, 'prescriptions'));
  const filename = `prescription_${appointment.id}.pdf`;
  const filepath = path.join(STORAGE, 'prescriptions', filename);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);
    drawHeader(doc, 'PRESCRIPTION');

    // Doctor info
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#222')
       .text(`Dr. ${appointment.doctor.name}`, 50, 110);
    doc.fontSize(10).font('Helvetica').fillColor('#555')
       .text(`${appointment.doctor.qualification || 'MBBS, MD (Pediatrics)'} · ${appointment.doctor.specialization || 'Pediatrician'}`);
    if (appointment.doctor.clinicName) {
      doc.fontSize(9).fillColor('#777').text(`${appointment.doctor.clinicName}`);
    }

     // Bug 1 — Age is ALWAYS derived from DOB at render time. DOB is the
    // single source of truth (Patient.dateOfBirth); we never store age.
    // Print BOTH "Age: 3 yrs 4 months  (DOB 12 Mar 2022)" so the printed
    // record carries the immutable source-of-truth date alongside the
    // derived value.
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
    doc.font('Helvetica-Bold').text('Type: ', 320, py + 15, { continued: true })
       .font('Helvetica').text(appointment.consultationType);
    if (prescription.weight) {
      doc.font('Helvetica-Bold').text('Weight: ', 320, py + 30, { continued: true })
         .font('Helvetica').text(prescription.weight);
    }
    if (prescription.height) {
      doc.font('Helvetica-Bold').text('Height: ', 320, py + 45, { continued: true })
         .font('Helvetica').text(prescription.height);
    }

    doc.moveTo(50, py + 70).lineTo(doc.page.width - 50, py + 70).strokeColor(BRAND_BLUE).stroke();

    let cursorY = py + 85;
    const section = (label, value) => {
      if (!value) return;
      doc.fontSize(11).font('Helvetica-Bold').fillColor(BRAND_BLUE).text(label, 50, cursorY);
      doc.fontSize(11).font('Helvetica').fillColor('#222').text(value, 50, cursorY + 14, {
        width: doc.page.width - 100
      });
      cursorY = doc.y + 10;
    };

    section('Chief Complaint', prescription.chiefComplaint);
    section('Past History', prescription.pastHistory);     // Bug 3
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

    const sigY = doc.page.height - 110;
    doc.fontSize(10).fillColor('#555').text('___________________________', doc.page.width - 220, sigY);
    doc.font('Helvetica-Bold').fillColor('#000').text(`Dr. ${appointment.doctor.name}`, doc.page.width - 220, sigY + 12);
    doc.font('Helvetica').fillColor('#555').fontSize(9).text('Digital Signature', doc.page.width - 220, sigY + 26);

    doc.fontSize(8).fillColor('#888')
       .text('This is a digitally generated prescription from NeoKidsPro EMR. neokidspro.in',
             50, doc.page.height - 60, { align: 'center', width: doc.page.width - 100 });

    doc.end();
    stream.on('finish', () => resolve({
      filepath, filename,
      url: `${process.env.PUBLIC_STORAGE_URL || '/files'}/prescriptions/${filename}`
    }));
    stream.on('error', reject);
  });
}

module.exports = { generateInvoice, generatePrescription };
