const prisma = require('../config/prisma');
const { asyncHandler } = require('../middleware/errorHandler');
const { bookAppointmentSchema, slotQuerySchema } = require('../utils/validators');
const slotService = require('../services/slot.service');
const bookingService = require('../services/booking.service');
const cashfreeService = require('../services/cashfree.service');
const logger = require('../utils/logger');
const { getTodayDateString } = require('../utils/date');

exports.listDoctors = asyncHandler(async (req, res) => {
  const { mode } = req.query;
  const where = { isAvailable: true, deletedAt: null };
  if (mode === 'ONLINE') where.consultationModes = { in: ['ONLINE', 'BOTH'] };
  else if (mode === 'OFFLINE') where.consultationModes = { in: ['OFFLINE', 'BOTH'] };

  const doctors = await prisma.doctor.findMany({
    where,
    select: {
      id: true, name: true, specialization: true, qualification: true,
      experience: true, bio: true, photoUrl: true, consultationModes: true,
      onlineConsultFee: true, physicalConsultFee: true, slotDuration: true,
      availableFromOnline: true, availableToOnline: true,
      availableFromOffline: true, availableToOffline: true, workingDays: true
    },
    orderBy: { name: 'asc' }
  });
  res.json(doctors);
});

exports.doctorDetail = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const doctor = await prisma.doctor.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true, name: true, specialization: true, qualification: true,
      experience: true, bio: true, photoUrl: true, consultationModes: true,
      onlineConsultFee: true, physicalConsultFee: true, slotDuration: true,
      availableFromOnline: true, availableToOnline: true,
      availableFromOffline: true, availableToOffline: true, workingDays: true,
      isAvailable: true
    }
  });
  if (!doctor) return res.status(404).json({ error: 'Doctor not found' });
  res.json(doctor);
});

exports.getSlots = asyncHandler(async (req, res) => {
  // Issues 5 & 6 — validate every query param with Zod.
  //   * type must be exactly 'ONLINE' or 'OFFLINE' (no silent coercion)
  //   * date must be YYYY-MM-DD and not in the past
  //   * doctorId must be a UUID
  const parsed = slotQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid query parameters',
      details: parsed.error.flatten()
    });
  }
  const { doctorId, date, type } = parsed.data;
  const slots = await slotService.getLiveSlots(doctorId, date, type);
  res.json({ doctorId, date, type, slots });
});

exports.book = asyncHandler(async (req, res) => {
  const parsed = bookAppointmentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  const today = getTodayDateString();
  if (parsed.data.date < today) return res.status(400).json({ error: 'Appointment date cannot be in the past' });
  const result = await bookingService.bookAppointment(parsed.data);
  res.status(201).json(result);
});

// The public appointment lookup used to return the full appointment
// row including cashfreeOrderId, cashfreePaymentId, the raw
// paymentStatus history, meetLink, meetEventId, and the full patient
// phone number. Anyone who knew (or guessed, or found in a leaked
// confirmation email) the appointment UUID could pull all of it with
// zero authentication.
//
// To prevent that:
//   * By default we return a *confirmation-card* projection: enough for
//     the booking widget to render "booked / paid / your visit is on X
//     at Y with Dr Z" and nothing else. Payment IDs, meet event IDs,
//     and the meet link are NOT in this projection.
//   * To fetch sensitive fields (meetLink, full patient details), the
//     caller must prove possession of the booking phone by passing
//     ?phone=<full 10-digit phone> in the query string. We compare it
//     with the patient.phone we stored at booking time. This is a soft
//     verification — the phone is part of the WhatsApp/email payload
//     the patient already received — but it stops a stranger with just
//     a leaked UUID dead in their tracks.
//   * cashfreeOrderId / cashfreePaymentId / meetEventId are NEVER
//     returned on this endpoint, even with a correct phone. They have
//     no client-side use.
function _maskPhone(p) {
  const s = String(p || '');
  if (s.length < 4) return '****';
  return '******' + s.slice(-4);
}

exports.appointmentStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const appt = await prisma.appointment.findUnique({
    where: { id },
    include: {
      doctor:  { select: { name: true, specialization: true } },
      patient: { select: { name: true, phone: true } }
    }
  });
  if (!appt) return res.status(404).json({ error: 'Not found' });

  // Soft phone challenge: full match → unlock the meet link + full phone.
  const provided = String(req.query.phone || '').replace(/\D/g, '');
  const verified = provided && appt.patient && provided === appt.patient.phone;

  // Minimal confirmation projection — always safe to expose.
  const safe = {
    id:                appt.id,
    status:            appt.status,
    paymentStatus:     appt.paymentStatus,
    consultationType:  appt.consultationType,
    date:              appt.date,
    startTime:         appt.startTime,
    endTime:           appt.endTime,
    feeAtBooking:      appt.feeAtBooking,
    primaryProblem:    appt.primaryProblem,
    doctor:            appt.doctor,
    patient: appt.patient ? {
      name:  appt.patient.name,
      phone: verified ? appt.patient.phone : _maskPhone(appt.patient.phone)
    } : null
  };

  // Only reveal the Google Meet link if the caller knows the booking phone.
  if (verified && appt.consultationType === 'ONLINE') {
    safe.meetLink = appt.meetLink || null;
  }

  // cashfreeOrderId, cashfreePaymentId, meetEventId, full createdAt audit
  // trail — intentionally absent. Doctors/admins see those via
  // authenticated endpoints, not this public route.
  res.json(safe);
});

/**
 * Force-verify a payment by asking Cashfree directly (server-to-server),
 * bypassing webhook delay. Idempotent.
 * GET /api/public/verify-payment?order_id=appt_<uuid>
 *
 * The DB row is the ultimate source of truth. We only confirm when BOTH
 *   (a) Cashfree order_status === 'PAID' AND
 *   (b) a SUCCESS payment row exists with amount == appt.feeAtBooking
 * (b) can be disabled via STRICT_PAYMENT_VERIFICATION=false. Any other
 * Cashfree status (ACTIVE, EXPIRED, TERMINATED, FAILED) never fires
 * automations.
 */
exports.verifyPayment = asyncHandler(async (req, res) => {
  const orderId = req.query.order_id || req.query.orderId;
  if (!orderId) return res.status(400).json({ error: 'order_id is required' });

  const appt = await prisma.appointment.findFirst({
    where: { cashfreeOrderId: orderId },
    include: { doctor: { select: { name: true } }, patient: { select: { name: true } } }
  });
  if (!appt) return res.status(404).json({ error: 'Appointment not found for this order' });

  // Already paid — short-circuit, do nothing
  if (appt.paymentStatus === 'PAID') {
    return res.json({
      orderId, appointmentId: appt.id,
      paymentStatus: 'PAID', appointmentStatus: appt.status, source: 'db'
    });
  }
  // Already failed or cancelled — short-circuit, do nothing
  if (appt.paymentStatus === 'FAILED' || appt.status === 'CANCELLED') {
    return res.json({
      orderId, appointmentId: appt.id,
      paymentStatus: 'FAILED', appointmentStatus: appt.status, source: 'db'
    });
  }

  let verdict;
  try {
    verdict = await cashfreeService.isOrderTrulyPaid(orderId, appt.feeAtBooking);
  } catch (e) {
    logger.error('verifyPayment: Cashfree verification failed', e);
    return res.status(502).json({
      error: 'Could not verify payment with Cashfree',
      orderId, appointmentId: appt.id, paymentStatus: appt.paymentStatus
    });
  }

  const cfStatus = (verdict.order && verdict.order.order_status || '').toUpperCase();
  logger.info(
    `verifyPayment: order=${orderId} cfStatus=${cfStatus} db=${appt.paymentStatus} ` +
    `paid=${verdict.paid} reason=${verdict.reason}`
  );

  // ── ONLY TRUE-PAID ORDERS TRIGGER CONFIRMATION ──
  if (verdict.paid) {
    const updated = await bookingService.confirmOnlineBooking(
      appt.id,
      verdict.cfPaymentId || orderId
    );
    return res.json({
      orderId, appointmentId: appt.id,
      paymentStatus: 'PAID', appointmentStatus: updated.status, source: 'cashfree-strict'
    });
  }

  // ── Mark FAILED only on explicit terminal states ──
  if (['EXPIRED', 'TERMINATED', 'CANCELLED', 'FAILED'].includes(cfStatus)) {
    if (appt.paymentStatus !== 'FAILED' && appt.paymentStatus !== 'PAID') {
      await prisma.appointment.update({
        where: { id: appt.id },
        data: { paymentStatus: 'FAILED' }
      });
    }
    return res.json({
      orderId, appointmentId: appt.id,
      paymentStatus: 'FAILED', cashfreeStatus: cfStatus, source: 'cashfree'
    });
  }

  // Everything else (ACTIVE, PARTIALLY_PAID, PAID-without-payment-row) → still pending.
  // Crucially: a "PAID-without-payment-row" no longer fires automation.
  return res.json({
    orderId, appointmentId: appt.id,
    paymentStatus: appt.paymentStatus, cashfreeStatus: cfStatus,
    note: verdict.reason, source: 'cashfree'
  });
});

/**
 * Cashfree redirects browser here after payment attempt.
 * URL: /payment-status?order_id=appt_xxxxx
 */
exports.paymentStatusPage = (req, res) => {
  res.type('html').send(PAYMENT_STATUS_HTML);
};

// ─────────────────────────────────────────────────────────────────
// Follow-up recall prefill
// Returns the minimum patient identity needed to pre-fill the booking
// widget from a recall link, plus the recommending doctor's id and the
// original primaryProblem string. No PHI beyond what the patient already
// knows about themselves — but we still 404 hard if the recall id is fake.
// ─────────────────────────────────────────────────────────────────
exports.recallPrefill = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!id || id.length < 8) return res.status(400).json({ error: 'Invalid recall id' });

  const rx = await prisma.prescription.findUnique({
    where: { id },
    include: {
      appointment: {
        include: {
          patient: {
            select: {
              name: true, phone: true, email: true,
              parentName: true, gender: true, dateOfBirth: true
            }
          },
          doctor: { select: { id: true, name: true } }
        }
      }
    }
  });
  if (!rx || !rx.appointment) {
    return res.status(404).json({ error: 'Recall not found' });
  }

  const a = rx.appointment;
  res.json({
    recallId: rx.id,
    doctorId: a.doctor.id,
    doctorName: a.doctor.name,
    followUpDate: rx.followUpDate,
    primaryProblem: a.primaryProblem,
    patient: {
      name: a.patient.name,
      phone: a.patient.phone,
      email: a.patient.email || '',
      parentName: a.patient.parentName || '',
      gender: a.patient.gender || '',
      dateOfBirth: a.patient.dateOfBirth
        ? new Date(a.patient.dateOfBirth).toISOString().slice(0, 10)
        : ''
    }
  });
});


const PAYMENT_STATUS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Payment Status · NeoKidsPro</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .spinner { width:48px;height:48px;border:4px solid #e5e7eb;border-top-color:#4DA8FF;border-radius:50%;animation:spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body class="bg-slate-50 min-h-screen flex items-center justify-center p-4">
  <div class="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full text-center">
    <div id="iconSlot" class="flex justify-center mb-4"><div class="spinner"></div></div>
    <h1 id="title" class="text-2xl font-bold text-slate-800 mb-2">Verifying your payment…</h1>
    <p id="message" class="text-slate-600 mb-6">Please wait while we confirm your transaction with Cashfree. This usually takes 5–30 seconds.</p>
    <div id="details" class="text-left text-sm bg-slate-50 rounded-xl p-4 hidden"></div>
    <div id="actions" class="mt-6 hidden">
      <a id="homeBtn" href="/" class="inline-block px-5 py-2 rounded-xl bg-[#4DA8FF] text-white font-medium hover:opacity-90">Done</a>
    </div>
  </div>
<script>
(function(){
  const params = new URLSearchParams(location.search);
  const orderId = params.get('order_id') || params.get('orderId');
  const $ = (id)=>document.getElementById(id);
  function showFinal(state, appt){
    const ICONS = {
      success: '<div style="width:64px;height:64px;border-radius:50%;background:#10b981;color:#fff;display:flex;align-items:center;justify-content:center;font-size:36px;">✓</div>',
      failed:  '<div style="width:64px;height:64px;border-radius:50%;background:#ef4444;color:#fff;display:flex;align-items:center;justify-content:center;font-size:36px;">✕</div>',
      pending: '<div style="width:64px;height:64px;border-radius:50%;background:#f59e0b;color:#fff;display:flex;align-items:center;justify-content:center;font-size:36px;">⏱</div>'
    };
    $('iconSlot').innerHTML = ICONS[state] || ICONS.pending;
    if(state==='success'){
      $('title').textContent = 'Payment Successful 🎉';
      $('message').innerHTML = 'Your online consultation is confirmed.<br/>Confirmation has been sent via <b>WhatsApp & Email</b> along with the Google Meet link and PDF invoice.';
    } else if(state==='failed'){
      $('title').textContent = 'Payment Failed';
      $('message').textContent = 'Your transaction was not completed. No amount has been charged. Please go back and try booking again.';
    } else {
      $('title').textContent = 'Payment Still Processing';
      $('message').innerHTML = 'We have not received the final status from Cashfree yet. If your payment succeeded, you will receive a WhatsApp & Email confirmation within a few minutes. Otherwise please try booking again.';
    }
    if(appt){
      $('details').classList.remove('hidden');
      $('details').innerHTML =
        '<div class="flex justify-between"><span class="text-slate-500">Order:</span><span class="font-mono">'+orderId+'</span></div>'+
        '<div class="flex justify-between"><span class="text-slate-500">Appointment:</span><span class="font-mono">'+(appt.appointmentId||'').slice(0,8).toUpperCase()+'</span></div>';
    }
    $('actions').classList.remove('hidden');
  }
  if(!orderId){
    showFinal('failed', null);
    $('message').textContent = 'Missing order_id in URL. If you completed a payment, please contact support.';
    return;
  }
  let attempts = 0;
  const MAX_ATTEMPTS = 20, INTERVAL_MS = 3000;
  async function poll(){
    attempts++;
    try{
      const r = await fetch('/api/public/verify-payment?order_id='+encodeURIComponent(orderId), { cache:'no-store' });
      const data = await r.json();
      if(data.paymentStatus === 'PAID')   return showFinal('success', data);
      if(data.paymentStatus === 'FAILED') return showFinal('failed', data);
      if(attempts >= MAX_ATTEMPTS)        return showFinal('failed', data);
      setTimeout(poll, INTERVAL_MS);
    }catch(e){
      if(attempts >= MAX_ATTEMPTS) return showFinal('failed', null);
      setTimeout(poll, INTERVAL_MS);
    }
  }
  poll();
})();
</script>
</body>
</html>`;