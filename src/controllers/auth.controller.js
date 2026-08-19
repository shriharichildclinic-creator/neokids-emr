/* =====================================================================
   auth.controller.js
   ---------------------------------------------------------------------
   Anti-enumeration on /api/auth/forgot-password.

   The endpoint always returns the same 200 success payload for ANY
   input (valid email, unknown email, malformed string, or a missing
   body). A response that varies by input shape would let an attacker
   diff responses to learn whether an email "passed validation and was
   processed as a real lookup" — a classic enumeration oracle. The real
   lookup + email send only happens when the input is a valid email;
   internal-only details are written to the server log instead.

   Login failure paths follow the same principle: every failure returns
   the same 401 INVALID body regardless of which check failed.
   ===================================================================== */
const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');
const { signToken } = require('../middleware/auth');
const {
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema
} = require('../utils/validators');
const { asyncHandler } = require('../middleware/errorHandler');
const { createPasswordToken, consumePasswordToken, revokeActivePasswordTokens } = require('../services/token.service');
const emailService = require('../services/email.service');
const logger = require('../utils/logger');

const SALT = parseInt(process.env.BCRYPT_SALT_ROUNDS || '12', 10);
const TOKEN_TTL_MINUTES = parseInt(process.env.PASSWORD_TOKEN_TTL_MINUTES || '60', 10);

// One generic message used for EVERY forgot-password response —
// real account, fake account, malformed input, missing body. Identical
// JSON, identical status, identical headers.
const FORGOT_GENERIC = Object.freeze({
  success: true,
  message: 'If the account exists, a reset link has been sent.'
});

function buildPasswordLink(rawToken) {
  // The password reset / invite page is served by the EMR itself
  // (not the WordPress patient site at APP_URL). Prefer an explicit
  // EMR_URL, fall back to API_URL, and only fall back to APP_URL as a
  // last resort so misconfigured environments never silently point at
  // the patient site again.
  const base = (
    process.env.EMR_URL ||
    process.env.API_URL ||
    process.env.APP_URL ||
    ''
  ).replace(/\/+$/, '');
  return `${base}/assets/reset-password.html?token=${encodeURIComponent(rawToken)}`;
}

async function sendPasswordEmail({ to, name, rawToken, purpose }) {
  const link = buildPasswordLink(rawToken);
  const isInvite = purpose === 'INVITE';
  await emailService.sendEmail({
    to,
    subject: isInvite ? 'Set your NeoKidsPro password' : 'Reset your NeoKidsPro password',
    html: `
      <h2>${isInvite ? 'Welcome to NeoKidsPro' : 'Reset your password'}</h2>
      <p>Hello ${name || 'there'},</p>
      <p>${isInvite ? 'An account has been created for you.' : 'We received a request to reset your password.'}</p>
      <p><a href="${link}">Click here to ${isInvite ? 'set' : 'reset'} your password</a></p>
      <p>This link will expire in ${TOKEN_TTL_MINUTES} minutes.</p>
    `
  });
  return link;
}

exports.login = asyncHandler(async (req, res) => {
  // Every login failure path returns this same body — the client
  // should never be able to distinguish "no such user" from "wrong
  // password" from "malformed input".
  const INVALID = { error: 'Invalid credentials' };

  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(401).json(INVALID);
  }

  const { email, password } = parsed.data;

  const admin = await prisma.admin.findUnique({ where: { email } });
  if (admin) {
    const ok = await bcrypt.compare(password, admin.passwordHash);
    if (!ok) return res.status(401).json(INVALID);
    const token = signToken({ id: admin.id, role: 'ADMIN', email: admin.email });
    return res.json({
      token,
      role: 'ADMIN',
      user: { id: admin.id, name: admin.name, email: admin.email, mustChangePassword: admin.mustChangePassword }
    });
  }

  const doctor = await prisma.doctor.findFirst({ where: { email, deletedAt: null } });
  if (doctor) {
    const ok = await bcrypt.compare(password, doctor.passwordHash);
    if (!ok) return res.status(401).json(INVALID);
    const token = signToken({ id: doctor.id, role: 'DOCTOR', email: doctor.email });
    return res.json({
      token,
      role: 'DOCTOR',
      user: {
        id: doctor.id,
        name: doctor.name,
        email: doctor.email,
        specialization: doctor.specialization,
        mustChangePassword: doctor.mustChangePassword
      }
    });
  }

  return res.status(401).json(INVALID);
});

exports.me = asyncHandler(async (req, res) => {
  if (req.user.role === 'ADMIN') {
    const admin = await prisma.admin.findUnique({ where: { id: req.user.id } });
    return res.json({ role: 'ADMIN', user: admin && { id: admin.id, name: admin.name, email: admin.email, mustChangePassword: admin.mustChangePassword } });
  }

  const doctor = await prisma.doctor.findFirst({ where: { id: req.user.id, deletedAt: null } });
  if (!doctor) return res.status(404).json({ error: 'Not found' });
  const { passwordHash, ...rest } = doctor;
  res.json({ role: 'DOCTOR', user: rest });
});

/* ──────────────────────────────────────────────────────────────────────
 * forgot-password: uniform response for ALL inputs.
 *
 * Strategy:
 *   1. Parse with safeParse. NEVER let validation failure escape to a
 *      4xx with field details — that's the enumeration oracle.
 *   2. On invalid email shape (or missing body), log the rejection for
 *      ops visibility and return the SAME 200 success payload anonymous
 *      users would get for a valid-but-unknown email.
 *   3. On valid email shape, do the existing lookup + token issue and
 *      still return the SAME 200 success payload.
 *
 * The previewUrl debug field (only present when SMTP_HOST is unset, i.e.
 * in local dev) is intentionally kept identical in shape to the
 * production response so dev tooling stays unchanged but no signal leaks
 * in production where SMTP_HOST is always set.
 * ──────────────────────────────────────────────────────────────────── */
exports.forgotPassword = asyncHandler(async (req, res) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);

  if (!parsed.success) {
    // Don't reveal that validation failed. Log it internally with a
    // requestId-ish marker so ops can correlate, then return the same
    // success body any other path returns.
    logger.info('forgot-password: invalid input ignored', {
      // safe-by-construction: we don't echo back to the user.
      issues: parsed.error && parsed.error.issues
        ? parsed.error.issues.map(i => i.code)
        : 'unknown'
    });
    return res.json(FORGOT_GENERIC);
  }

  const { email } = parsed.data;
  const admin = await prisma.admin.findUnique({ where: { email } });
  const doctor = admin ? null : await prisma.doctor.findFirst({ where: { email, deletedAt: null } });

  if (admin || doctor) {
    const userType = admin ? 'ADMIN' : 'DOCTOR';
    const user = admin || doctor;
    await revokeActivePasswordTokens(userType, user.id, ['RESET']);
    const { rawToken } = await createPasswordToken({
      userType,
      userId: user.id,
      purpose: 'RESET',
      expiresInMinutes: TOKEN_TTL_MINUTES
    });
    try {
      const previewUrl = await sendPasswordEmail({ to: user.email, name: user.name, rawToken, purpose: 'RESET' });
      // Only attach previewUrl in dev (no SMTP configured). In prod,
      // the response is byte-identical to the "no user found" branch.
      if (!process.env.SMTP_HOST) {
        return res.json({ ...FORGOT_GENERIC, previewUrl });
      }
    } catch (mailErr) {
      // NEVER surface mail-send failures to the caller — that's another
      // enumeration oracle (the response time/shape would change).
      logger.error('forgot-password: mail send failed', { name: mailErr && mailErr.name });
    }
  }

  return res.json(FORGOT_GENERIC);
});

exports.resetPassword = asyncHandler(async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });

  const token = await consumePasswordToken({ rawToken: parsed.data.token, purposes: ['RESET', 'INVITE'] });
  const passwordHash = await bcrypt.hash(parsed.data.password, SALT);

  if (token.userType === 'ADMIN') {
    await prisma.admin.update({
      where: { id: token.userId },
      data: { passwordHash, mustChangePassword: false }
    });
  } else {
    await prisma.doctor.update({
      where: { id: token.userId },
      data: { passwordHash, mustChangePassword: false }
    });
  }

  await revokeActivePasswordTokens(token.userType, token.userId, ['RESET', 'INVITE']);
  res.json({ success: true, message: 'Password updated successfully' });
});

exports.changePassword = asyncHandler(async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });

  const isAdmin = req.user.role === 'ADMIN';
  const repo = isAdmin ? prisma.admin : prisma.doctor;
  const user = await repo.findUnique({ where: { id: req.user.id } });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const matches = await bcrypt.compare(parsed.data.currentPassword, user.passwordHash);
  if (!matches) return res.status(400).json({ error: 'Current password is incorrect' });

  const passwordHash = await bcrypt.hash(parsed.data.newPassword, SALT);
  await repo.update({
    where: { id: req.user.id },
    data: { passwordHash, mustChangePassword: false }
  });

  await revokeActivePasswordTokens(isAdmin ? 'ADMIN' : 'DOCTOR', req.user.id, ['RESET', 'INVITE']);
  res.json({ success: true, message: 'Password changed successfully' });
});

exports._helpers = { buildPasswordLink, sendPasswordEmail };