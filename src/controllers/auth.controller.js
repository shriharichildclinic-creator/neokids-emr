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

const SALT = parseInt(process.env.BCRYPT_SALT_ROUNDS || '12', 10);
const TOKEN_TTL_MINUTES = parseInt(process.env.PASSWORD_TOKEN_TTL_MINUTES || '60', 10);

function buildPasswordLink(rawToken) {
  return `${process.env.APP_URL || ''}/assets/reset-password.html?token=${encodeURIComponent(rawToken)}`;
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
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });

  const { email, password } = parsed.data;

  const admin = await prisma.admin.findUnique({ where: { email } });
  if (admin) {
    const ok = await bcrypt.compare(password, admin.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
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
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
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

  return res.status(401).json({ error: 'Invalid credentials' });
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

exports.forgotPassword = asyncHandler(async (req, res) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });

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
    const previewUrl = await sendPasswordEmail({ to: user.email, name: user.name, rawToken, purpose: 'RESET' });
    return res.json({ success: true, message: 'If the account exists, a reset link has been sent.', ...(process.env.SMTP_HOST ? {} : { previewUrl }) });
  }

  res.json({ success: true, message: 'If the account exists, a reset link has been sent.' });
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
