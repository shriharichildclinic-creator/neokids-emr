const crypto = require('crypto');
const prisma = require('../config/prisma');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function generateRawToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function createPasswordToken({ userType, userId, purpose, expiresInMinutes }) {
  const rawToken = generateRawToken();
  const tokenHash = sha256(rawToken);
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000);

  await prisma.passwordToken.create({
    data: { userType, userId, purpose, tokenHash, expiresAt }
  });

  return { rawToken, expiresAt };
}

async function peekPasswordToken({ rawToken, purposes }) {
  const tokenHash = sha256(rawToken);
  return prisma.passwordToken.findFirst({
    where: {
      tokenHash,
      usedAt: null,
      expiresAt: { gt: new Date() },
      ...(purposes?.length ? { purpose: { in: purposes } } : {})
    }
  });
}

async function consumePasswordToken({ rawToken, purposes }) {
  const tokenHash = sha256(rawToken);
  const where = {
    tokenHash,
    usedAt: null,
    expiresAt: { gt: new Date() },
    ...(purposes?.length ? { purpose: { in: purposes } } : {})
  };

  // Atomic claim: usedAt:null is re-checked by the DB inside the UPDATE
  // itself, not by a prior SELECT, so two concurrent requests racing on
  // the same raw token can't both see "unused" and both succeed — only
  // the first UPDATE's WHERE still matches.
  const token = await prisma.passwordToken.findFirst({ where });
  if (!token) {
    throw Object.assign(new Error('Invalid or expired password token'), { statusCode: 400 });
  }

  const claim = await prisma.passwordToken.updateMany({
    where: { id: token.id, usedAt: null },
    data: { usedAt: new Date() }
  });
  if (claim.count === 0) {
    throw Object.assign(new Error('Invalid or expired password token'), { statusCode: 400 });
  }

  return token;
}

async function revokeActivePasswordTokens(userType, userId, purposes) {
  await prisma.passwordToken.updateMany({
    where: {
      userType,
      userId,
      usedAt: null,
      ...(purposes?.length ? { purpose: { in: purposes } } : {})
    },
    data: { usedAt: new Date() }
  });
}

module.exports = {
  createPasswordToken,
  peekPasswordToken,
  consumePasswordToken,
  revokeActivePasswordTokens
};
