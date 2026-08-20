const prisma = require('../config/prisma');
const logger = require('../utils/logger');

async function log({ actor, action, entityType, entityId, summary, meta, medicalCentreId, doctorId }) {
  try {
    await prisma.staffAuditLog.create({
      data: {
        actorId:   (actor && actor.id)   || 'system',
        actorRole: (actor && actor.role) || 'SYSTEM',
        actorName: (actor && actor.name) || null,
        action,
        entityType: entityType || null,
        entityId:   entityId   || null,
        summary:    summary ? String(summary).slice(0, 500) : null,
        meta:       meta || undefined,
        medicalCentreId: medicalCentreId || null,
        doctorId:        doctorId        || null
      }
    });
  } catch (e) {
    logger.error('audit log failed', { action, err: e.message });
  }
}

module.exports = { log };