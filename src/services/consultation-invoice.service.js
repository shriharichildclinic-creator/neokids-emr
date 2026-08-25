const prisma = require('../config/prisma');
const staffDocs = require('./staff-docs.service');
const audit = require('./audit.service');

/**
 * Create the ConsultationInvoice (+ PDF) behind an appointment being marked
 * paid — from whichever action triggered it: reception's own "mark paid",
 * reception's explicit "Invoice" button, or the doctor's own "mark paid".
 *
 * Centralizing this closes the gap where flipping paymentStatus and
 * actually recording revenue were two separate, easy-to-forget steps.
 * Every path that marks an appointment collected now goes through here, so
 * "paid" and "has an invoice that counts toward clinic revenue" can never
 * drift apart again.
 *
 * @param {object} appt - appointment row, must include `patient` (for the
 *   audit summary) and the plain scalar fields (doctorId, patientId,
 *   medicalCentreId, feeAtBooking, invoiceUrl).
 * @param {{id:string, role:'RECEPTIONIST'|'DOCTOR', name?:string}} actor -
 *   whoever performed the mark-paid/invoice action. When a receptionist,
 *   the invoice is attributed to them (receptionistId set) exactly as
 *   before. When a doctor collects cash directly with no receptionist
 *   involved, receptionistId is left null — crediting a specific staff
 *   member with money they didn't personally take would misattribute it —
 *   but the invoice still counts toward the clinic-wide (assigned-doctor)
 *   totals reception sees on their dashboard and Invoices tab.
 * @param {{amount?:number, paymentMethod?:string, notes?:string}} [opts]
 * @returns {Promise<{skipped:boolean, reason?:string, invoice?:object, pdfUrl?:string}>}
 */
async function issueInvoiceForAppointment(appt, actor, opts = {}) {
  // Never double-invoice. An appointment already billed by the automated
  // online flow (invoiceUrl set — Cashfree payment confirmed, PDF already
  // generated and sent, no reception step involved at all) must not get a
  // second, redundant paid record layered on top of it.
  if (appt.invoiceUrl) {
    return { skipped: true, reason: 'ALREADY_INVOICED_ONLINE' };
  }
  const existing = appt.consultationInvoice !== undefined
    ? appt.consultationInvoice
    : await prisma.consultationInvoice.findUnique({ where: { appointmentId: appt.id } });
  if (existing) {
    return { skipped: true, reason: 'ALREADY_INVOICED', invoice: existing };
  }

  const invoiceNumber = await staffDocs.nextInvoiceNumber();
  const amount = (opts.amount !== undefined && opts.amount !== null) ? opts.amount : Number(appt.feeAtBooking);
  let invoice;
  try {
    invoice = await prisma.consultationInvoice.create({
      data: {
        invoiceNumber,
        appointmentId: appt.id,
        doctorId: appt.doctorId,
        patientId: appt.patientId,
        receptionistId: actor.role === 'RECEPTIONIST' ? actor.id : null,
        medicalCentreId: appt.medicalCentreId,
        amount,
        status: 'PAID',
        paymentMethod: opts.paymentMethod || 'CASH',
        notes: opts.notes || (actor.role === 'DOCTOR' ? `Marked paid by Dr. ${actor.name || ''}`.trim() : null)
      }
    });
  } catch (e) {
    // Race: two calls (e.g. doctor and reception tapping "mark paid" within
    // the same instant) both passed the existence check above. The unique
    // constraint on appointmentId lets only one insert win; the loser just
    // reports the winner's invoice back rather than erroring.
    if (e && e.code === 'P2002') {
      const race = await prisma.consultationInvoice.findUnique({ where: { appointmentId: appt.id } });
      return { skipped: true, reason: 'ALREADY_INVOICED', invoice: race };
    }
    throw e;
  }

  const stored = await staffDocs.generateAndStoreInvoicePdf(invoice.id, { id: actor.id, role: actor.role });

  // Keep paymentStatus in lock-step with the invoice: an invoice is always
  // proof of collection, regardless of which action created it.
  if (appt.paymentStatus === 'CASH_PENDING') {
    await prisma.appointment.update({
      where: { id: appt.id },
      data: { paymentStatus: 'CASH_COLLECTED' }
    }).catch(() => null);
  }

  await audit.log({
    actor, action: 'INVOICE_GENERATED', entityType: 'CONSULTATION_INVOICE', entityId: invoice.id,
    summary: `Generated invoice ${invoiceNumber} (₹${Number(amount).toFixed(2)}) for ${appt.patient.name}`,
    medicalCentreId: appt.medicalCentreId, doctorId: appt.doctorId
  });

  return { skipped: false, invoice: stored.invoice, pdfUrl: stored.signedUrl };
}

module.exports = { issueInvoiceForAppointment };
