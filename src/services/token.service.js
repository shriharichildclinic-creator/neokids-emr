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

async function consumePasswordToken({ rawToken, purposes }) {
  const tokenHash = sha256(rawToken);
  const token = await prisma.passwordToken.findFirst({
    where: {
      tokenHash,
      usedAt: null,
      expiresAt: { gt: new Date() },
      ...(purposes?.length ? { purpose: { in: purposes } } : {})
    }
  });

  if (!token) {
    throw Object.assign(new Error('Invalid or expired password token'), { statusCode: 400 });
  }

  await prisma.passwordToken.update({
    where: { id: token.id },
    data: { usedAt: new Date() }
  });

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
  consumePasswordToken,
  revokeActivePasswordTokens
};
