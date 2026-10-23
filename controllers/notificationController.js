const Notification = require("../models/notification");
const CreditReminderSettings = require("../models/creditReminderSettings");
const audit = require("../lib/audit");

const actorId = (request) => request.authUser._id;

async function listNotifications(request, response) {
  const limitValue = Number(request.query.limit || 50);
  const limit = Number.isInteger(limitValue) ? Math.min(100, Math.max(1, limitValue)) : 50;
  const filter = { recipientId: actorId(request) };
  if (request.query.unread === "true") filter.readAt = null;
  const notifications = await Notification.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
  const unreadCount = await Notification.countDocuments({ recipientId: filter.recipientId, readAt: null });
  return response.json({ notifications: notifications.map(serialize), unreadCount });
}

function serialize(notification) {
  return {
    id: String(notification._id),
    type: notification.type,
    title: notification.title,
    message: notification.message,
    saleId: String(notification.saleId),
    receiptNumber: notification.receiptNumber,
    dueDate: notification.dueDate,
    balance: notification.balance,
    readAt: notification.readAt,
    createdAt: notification.createdAt,
  };
}

async function markRead(request, response) {
  if (!/^[a-f\d]{24}$/i.test(request.params.id)) {
    return response.status(400).json({ error: "Notification ID is invalid." });
  }
  const notification = await Notification.findOneAndUpdate(
    { _id: request.params.id, recipientId: actorId(request) },
    { $set: { readAt: new Date() } },
    { new: true },
  ).lean();
  if (!notification) return response.status(404).json({ error: "Notification not found." });
  return response.json({ notification: serialize(notification) });
}

async function markAllRead(request, response) {
  const result = await Notification.updateMany(
    { recipientId: actorId(request), readAt: null },
    { $set: { readAt: new Date() } },
  );
  return response.json({ updated: result.modifiedCount });
}

async function getReminderSettings(_request, response) {
  const settings = await CreditReminderSettings.findById("global").lean();
  return response.json({
    settings: settings || {
      daysBeforeDue: [7, 1, 0],
      daysAfterDue: [1, 3, 7],
      repeatOverdueEveryDays: 7,
      escalateAfterDays: 7,
      timeZone: "Africa/Kampala",
    },
  });
}

async function updateReminderSettings(request, response) {
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).length === 0 ||
      Object.keys(body).some((key) => !["daysBeforeDue", "daysAfterDue", "repeatOverdueEveryDays", "escalateAfterDays"].includes(key))) {
    return response.status(400).json({ error: "Provide supported credit reminder settings." });
  }
  const settings = new CreditReminderSettings({ _id: "global", ...body });
  const validationError = settings.validateSync();
  if (validationError) return response.status(400).json({ error: validationError.message });
  const saved = await CreditReminderSettings.findByIdAndUpdate(
    "global",
    { $set: body },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
  ).lean();
  await audit.recordAudit({
    request,
    eventType: "credit.reminder_settings_updated",
    outcome: "success",
    details: {
      daysBeforeDue: saved.daysBeforeDue,
      daysAfterDue: saved.daysAfterDue,
      repeatOverdueEveryDays: saved.repeatOverdueEveryDays,
      escalateAfterDays: saved.escalateAfterDays,
    },
  });
  return response.json({ settings: saved });
}

module.exports = { getReminderSettings, listNotifications, markAllRead, markRead, updateReminderSettings };
