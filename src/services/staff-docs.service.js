const prisma = require('../config/prisma');
const pdf = require('./pdf.service');
const waMedia = require('./whatsapp-media.service');
const emailSvc = require('./email.service');
const logger = require('../utils/logger');

async function logNotif(data) {
  try { await prisma.notificationLog.create({ data }); }
  catch (e) { logger.error('staff-doc notif log failed', e); }
}

async function nextInvoiceNumber() {
  const yr = new Date().getUTCFullYear();
  const count = await prisma.consultationInvoice.count();
  return `INV-C-${yr}-${String(count + 1).padStart(5, '0')}`;
}

async function nextBillNumber() {
  const yr = new Date().getUTCFullYear();
  const count = await prisma.pharmacyBill.count();
  return `PHB-${yr}-${String(count + 1).padStart(5, '0')}`;
}

async function generateAndStoreInvoicePdf(invoiceId, user) {
  const inv = await prisma.consultationInvoice.findUnique({
    where: { id: invoiceId },
    include: {
      appointment: { include: { patient: true, doctor: true } },
      medicalCentre: true,
      receptionist: { select: { id: true, name: true } }
    }
  });
  if (!inv) throw Object.assign(new Error('Invoice not found'), { statusCode: 404 });
  const result = await pdf.generateConsultationInvoice({
    invoice: inv,
    appointment: inv.appointment,
    patient: inv.appointment.patient,
    doctor: inv.appointment.doctor,
    medicalCentre: inv.medicalCentre
  });
  await prisma.consultationInvoice.update({
    where: { id: inv.id },
    data: { pdfUrl: result.url }
  });
  const { buildSignedFileUrl } = require('../utils/fileTokens');
  return {
    invoice: { ...inv, pdfUrl: result.url },
    filepath: result.filepath,
    filename: result.filename,
    signedUrl: buildSignedFileUrl({
      kind: 'consultation-invoice',
      appointmentId: inv.id,
      userId: user && user.id,
      role: user && user.role
    })
  };
}

async function generateAndStoreBillPdf(billId, user) {
  const bill = await prisma.pharmacyBill.findUnique({
    where: { id: billId },
    include: { items: true, medicalCentre: true, doctor: true, patient: true }
  });
  if (!bill) throw Object.assign(new Error('Bill not found'), { statusCode: 404 });
  const result = await pdf.generatePharmacyInvoice({
    bill,
    medicalCentre: bill.medicalCentre,
    doctor: bill.doctor
  });
  await prisma.pharmacyBill.update({
    where: { id: bill.id },
    data: { pdfUrl: result.url }
  });
  const { buildSignedFileUrl } = require('../utils/fileTokens');
  return {
    bill: { ...bill, pdfUrl: result.url },
    filepath: result.filepath,
    filename: result.filename,
    signedUrl: buildSignedFileUrl({
      kind: 'pharmacy-invoice',
      appointmentId: bill.id,
      userId: user && user.id,
      role: user && user.role
    })
  };
}

async function deliverConsultationInvoice(invoiceId, { channels = ['whatsapp', 'email'], user } = {}) {
  const { invoice, filepath, filename } = await generateAndStoreInvoicePdf(invoiceId, user);
  const patient = invoice.appointment.patient;
  const doctor = invoice.appointment.doctor;
  const delivery = { whatsapp: 'skipped', email: 'skipped' };
  const amount = Number(invoice.amount).toFixed(2);

  if (channels.includes('whatsapp') && patient.phone) {
    try {
      const r = await waMedia.sendInvoicePdf({
        appointment: { id: invoice.appointmentId, patient, doctor, feeAtBooking: invoice.amount },
        filepath
      });
      await logNotif({
        appointmentId: invoice.appointmentId, channel: 'WHATSAPP', recipient: patient.phone,
        template: process.env.WA_TPL_INVOICE_PDF || 'neokids_invoice_pdf',
        direction: 'PATIENT', status: 'SENT', payload: r || undefined
      });
      delivery.whatsapp = 'sent';
    } catch (e) {
      await logNotif({
        appointmentId: invoice.appointmentId, channel: 'WHATSAPP', recipient: patient.phone,
        template: process.env.WA_TPL_INVOICE_PDF || 'neokids_invoice_pdf',
        direction: 'PATIENT', status: 'FAILED', errorMessage: e.message
      });
      delivery.whatsapp = 'failed';
    }
  }

  if (channels.includes('email')) {
    if (patient.email) {
      try {
        await emailSvc.sendEmail({
          to: patient.email,
          subject: `Consultation Invoice – Dr. ${doctor.name}`,
          html: `<h2>Consultation Invoice</h2>
                 <p>Dear ${patient.name},</p>
                 <p>Thank you for visiting. Your consultation invoice for <strong>Dr. ${doctor.name}</strong> is attached.</p>
                 <p>Invoice No: <strong>${invoice.invoiceNumber}</strong> · Amount: <strong>₹${amount}</strong></p>
                 <p>Regards,<br>${(invoice.medicalCentre && invoice.medicalCentre.name) || doctor.clinicName || 'NeoKidsPro Clinic'}</p>`,
          attachments: [{ filename, path: filepath }]
        });
        await logNotif({
          appointmentId: invoice.appointmentId, channel: 'EMAIL', recipient: patient.email,
          template: 'CONSULTATION_INVOICE', direction: 'PATIENT', status: 'SENT'
        });
        delivery.email = 'sent';
      } catch (e) {
        await logNotif({
          appointmentId: invoice.appointmentId, channel: 'EMAIL', recipient: patient.email,
          template: 'CONSULTATION_INVOICE', direction: 'PATIENT', status: 'FAILED', errorMessage: e.message
        });
        delivery.email = 'failed';
      }
    } else {
      delivery.email = 'no_email';
    }
  }
  return delivery;
}

async function deliverPharmacyBill(billId, { channels = ['whatsapp', 'email'], user } = {}) {
  const { bill, filepath, filename } = await generateAndStoreBillPdf(billId, user);
  const delivery = { whatsapp: 'skipped', email: 'skipped' };
  const phone = bill.customerPhone || (bill.patient && bill.patient.phone);
  const email = bill.patient && bill.patient.email;
  const customerName = bill.customerName || (bill.patient && bill.patient.name) || 'Customer';
  const centreName = (bill.medicalCentre && bill.medicalCentre.name) || 'NeoKidsPro Pharmacy';
  const total = Number(bill.total).toFixed(2);

  if (channels.includes('whatsapp') && phone) {
    const tpl = process.env.WA_TPL_INVOICE_PDF || 'neokids_invoice_pdf';
    try {
      const r = await waMedia.sendInvoicePdf({
        appointment: { id: bill.id, patient: { name: customerName, phone }, feeAtBooking: bill.total },
        filepath
      });
      await logNotif({
        appointmentId: null, channel: 'WHATSAPP', recipient: phone,
        template: tpl, direction: 'PATIENT', status: 'SENT', payload: r || undefined
      });
      delivery.whatsapp = 'sent';
    } catch (e) {
      await logNotif({
        appointmentId: null, channel: 'WHATSAPP', recipient: phone,
        template: tpl, direction: 'PATIENT', status: 'FAILED', errorMessage: e.message
      });
      delivery.whatsapp = 'failed';
    }
  }

  if (channels.includes('email')) {
    if (email) {
      try {
        await emailSvc.sendEmail({
          to: email,
          subject: `Pharmacy Bill – ${centreName}`,
          html: `<h2>Pharmacy Bill</h2>
                 <p>Dear ${customerName},</p>
                 <p>Thank you for your purchase at <strong>${centreName}</strong>. Your bill is attached.</p>
                 <p>Bill No: <strong>${bill.billNumber}</strong> · Total: <strong>₹${total}</strong></p>
                 <p>Regards,<br>${centreName}</p>`,
          attachments: [{ filename, path: filepath }]
        });
        await logNotif({
          appointmentId: null, channel: 'EMAIL', recipient: email,
          template: 'PHARMACY_BILL', direction: 'PATIENT', status: 'SENT'
        });
        delivery.email = 'sent';
      } catch (e) {
        await logNotif({
          appointmentId: null, channel: 'EMAIL', recipient: email,
          template: 'PHARMACY_BILL', direction: 'PATIENT', status: 'FAILED', errorMessage: e.message
        });
        delivery.email = 'failed';
      }
    } else {
      delivery.email = 'no_email';
    }
  }
  return delivery;
}

module.exports = {
  nextInvoiceNumber,
  nextBillNumber,
  generateAndStoreInvoicePdf,
  generateAndStoreBillPdf,
  deliverConsultationInvoice,
  deliverPharmacyBill
};