// =====================================================================
// notification.service.js — in-app notification bell shared by all 4
// portals. Deliberately simple: no push/websocket delivery, just rows the
// portal polls/fetches on load and on an interval. Callers create()
// notifications from the specific event that matters (KYC review needed,
// low stock, a refund) rather than this file guessing what's important.
// =====================================================================
const prisma = require('../config/prisma');

async function create({ userType, userId = null, type, title, message, entityType = null, entityId = null }) {
  return prisma.notification.create({
    data: { userType, userId, type, title, message, entityType, entityId }
  });
}

// Admin notifications have userId: null (every admin account sees them),
// so listing for an admin means "userType=ADMIN, userId is null OR mine"
// — there's no per-admin-only notice today, but the shape allows one later.
function scopeFor(userType, userId) {
  if (userType === 'ADMIN') {
    return { userType, OR: [{ userId: null }, { userId }] };
  }
  return { userType, userId };
}

async function listForUser(userType, userId, { unreadOnly = false, limit = 30 } = {}) {
  const where = scopeFor(userType, userId);
  if (unreadOnly) where.isRead = false;
  return prisma.notification.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 100)
  });
}

async function unreadCount(userType, userId) {
  return prisma.notification.count({ where: { ...scopeFor(userType, userId), isRead: false } });
}

async function markRead(userType, userId, id) {
  const claim = await prisma.notification.updateMany({
    where: { id, ...scopeFor(userType, userId) },
    data: { isRead: true, readAt: new Date() }
  });
  return claim.count > 0;
}

async function markAllRead(userType, userId) {
  await prisma.notification.updateMany({
    where: { ...scopeFor(userType, userId), isRead: false },
    data: { isRead: true, readAt: new Date() }
  });
}

module.exports = { create, listForUser, unreadCount, markRead, markAllRead };
