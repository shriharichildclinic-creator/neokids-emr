const prisma = require('../config/prisma');
const pdf = require('./pdf.service');
const waMedia = require('./whatsapp-media.service');
const emailSvc = require('./email.service');
const { renderBrandedEmail, esc } = require('./email-brand.service');
const logger = require('../utils/logger');

async function logNotif(data) {
  try { await prisma.notificationLog.create({ data }); }
  catch (e) { logger.error('staff-doc notif log failed', e); }
}

// BUG FIX (Internal Server Error on Invoice): these used to be a plain row
// COUNT for the year (`INV-C-<year>-<count+1>`). Deleting a patient/doctor
// cascades a consultationInvoice.deleteMany(), which shrinks the count but
// leaves the surviving invoices' numbers untouched — so a later count-based
// number can land on one that's still in use, hit the unique constraint on
// invoiceNumber, and crash (see issueInvoiceForAppointment's retry, and the
// P2002 handling there, for the other half of this fix). Deriving the next
// number from the highest one actually in use for the year means a deletion
// can never leave a gap that collides later, count-based or not.
async function nextInvoiceNumber() {
  const yr = new Date().getUTCFullYear();
  const prefix = `INV-C-${yr}-`;
  const last = await prisma.consultationInvoice.findFirst({
    where: { invoiceNumber: { startsWith: prefix } },
    orderBy: { invoiceNumber: 'desc' },
    select: { invoiceNumber: true }
  });
  const lastN = last ? parseInt(last.invoiceNumber.slice(prefix.length), 10) || 0 : 0;
  return `${prefix}${String(lastN + 1).padStart(5, '0')}`;
}

async function nextBillNumber() {
  const yr = new Date().getUTCFullYear();
  const prefix = `PHB-${yr}-`;
  const last = await prisma.pharmacyBill.findFirst({
    where: { billNumber: { startsWith: prefix } },
    orderBy: { billNumber: 'desc' },
    select: { billNumber: true }
  });
  const lastN = last ? parseInt(last.billNumber.slice(prefix.length), 10) || 0 : 0;
  return `${prefix}${String(lastN + 1).padStart(5, '0')}`;
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
        filepath,
        invoiceNumber: invoice.invoiceNumber
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
        const invoiceRegards = (invoice.medicalCentre && invoice.medicalCentre.name) || doctor.clinicName || 'NeoKidsPro Clinic';
        await emailSvc.sendEmail({
          to: patient.email,
          subject: `Consultation Invoice – Dr. ${doctor.name}`,
          html: renderBrandedEmail({
            preheader: `Your consultation invoice for Dr. ${doctor.name} is attached.`,
            headline: 'Consultation Invoice',
            subhead: `Dr. ${esc(doctor.name)}`,
            bodyHtml: `
              <p>Dear ${esc(patient.name)},</p>
              <p>Thank you for visiting. Your consultation invoice is attached to this email as a PDF.</p>
              <table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:14px 0;width:100%;">
                <tr>
                  <td style="padding:8px 12px;background:#F1F8FF;font-weight:bold;border:1px solid #E6EEF7;width:38%;">Invoice No</td>
                  <td style="padding:8px 12px;border:1px solid #E6EEF7;">${esc(invoice.invoiceNumber)}</td>
                </tr>
                <tr>
                  <td style="padding:8px 12px;background:#F1F8FF;font-weight:bold;border:1px solid #E6EEF7;">Amount</td>
                  <td style="padding:8px 12px;border:1px solid #E6EEF7;">₹${esc(amount)}</td>
                </tr>
              </table>
            `,
            footerNote: `Regards,<br>${esc(invoiceRegards)}`
          }),
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
        filepath,
        invoiceNumber: bill.billNumber
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
          html: renderBrandedEmail({
            preheader: `Your pharmacy bill from ${centreName} is attached.`,
            headline: 'Pharmacy Bill',
            subhead: esc(centreName),
            bodyHtml: `
              <p>Dear ${esc(customerName)},</p>
              <p>Thank you for your purchase. Your bill is attached to this email as a PDF.</p>
              <table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:14px 0;width:100%;">
                <tr>
                  <td style="padding:8px 12px;background:#F1F8FF;font-weight:bold;border:1px solid #E6EEF7;width:38%;">Bill No</td>
                  <td style="padding:8px 12px;border:1px solid #E6EEF7;">${esc(bill.billNumber)}</td>
                </tr>
                <tr>
                  <td style="padding:8px 12px;background:#F1F8FF;font-weight:bold;border:1px solid #E6EEF7;">Total</td>
                  <td style="padding:8px 12px;border:1px solid #E6EEF7;">₹${esc(total)}</td>
                </tr>
              </table>
            `,
            footerNote: `Regards,<br>${esc(centreName)}`
          }),
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