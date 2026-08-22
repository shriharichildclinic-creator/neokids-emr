// Shared notification-bell endpoints — identical logic for all 4 portals,
// scoped by req.user.role/req.user.id, so one controller is mounted under
// each of admin/doctor/receptionist/pharmacy routes instead of 4 copies.
const { asyncHandler } = require('../middleware/errorHandler');
const notifications = require('../services/notification.service');

exports.list = asyncHandler(async (req, res) => {
  const unreadOnly = req.query.unreadOnly === '1';
  const rows = await notifications.listForUser(req.user.role, req.user.id, { unreadOnly });
  res.json(rows);
});

exports.unreadCount = asyncHandler(async (req, res) => {
  const count = await notifications.unreadCount(req.user.role, req.user.id);
  res.json({ count });
});

exports.markRead = asyncHandler(async (req, res) => {
  const ok = await notifications.markRead(req.user.role, req.user.id, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Notification not found' });
  res.json({ success: true });
});

exports.markAllRead = asyncHandler(async (req, res) => {
  await notifications.markAllRead(req.user.role, req.user.id);
  res.json({ success: true });
});
