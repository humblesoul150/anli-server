const Notification = require("../models/notification");
const CreditReminderSettings = require("../models/creditReminderSettings");
const audit = require("../lib/audit");
const { emitToUser } = require("../lib/notificationRealtime");
const { serializeNotification } = require("../lib/notificationEvents");

const actorId = (request) => request.authUser._id;
const categories = new Set(["approval", "leave", "payroll", "salary_advance", "expense", "inventory", "sales", "security", "general"]);

async function listNotifications(request, response) {
  const limitValue = Number(request.query.limit || 50);
  const limit = Number.isInteger(limitValue) ? Math.min(100, Math.max(1, limitValue)) : 50;
  const filter = {
    recipientId: actorId(request),
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  };
  if (request.query.unread === "true") filter.readAt = null;
  if (request.query.category) {
    const category = String(request.query.category);
    if (category === "action_required") filter.severity = { $in: ["action_required", "urgent"] };
    else if (categories.has(category)) filter.category = category;
    else return response.status(400).json({ error: "Notification category is invalid." });
  }
  if (request.query.cursor !== undefined) {
    const cursor = String(request.query.cursor);
    if (!/^[a-f\d]{24}$/i.test(cursor)) return response.status(400).json({ error: "Notification cursor is invalid." });
    const previous = await Notification.findOne({ _id: cursor, recipientId: actorId(request) }).select("_id createdAt").lean();
    if (!previous) return response.status(400).json({ error: "Notification cursor was not found." });
    filter.$and = [{
      $or: [
        { createdAt: { $lt: previous.createdAt } },
        { createdAt: previous.createdAt, _id: { $lt: previous._id } },
      ],
    }];
  }
  const results = await Notification.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
  const hasMore = results.length > limit;
  const notifications = results.slice(0, limit);
  const unreadCount = await Notification.countDocuments({
    recipientId: actorId(request),
    readAt: null,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  });
  return response.json({
    notifications: notifications.map(serializeNotification),
    unreadCount,
    nextCursor: hasMore ? String(notifications[notifications.length - 1]._id) : null,
  });
}

async function markRead(request, response) {
  if (!/^[a-f\d]{24}$/i.test(request.params.id)) {
    return response.status(400).json({ error: "Notification ID is invalid." });
  }
  let notification = await Notification.findOneAndUpdate(
    { _id: request.params.id, recipientId: actorId(request), readAt: null },
    { $set: { readAt: new Date() } },
    { new: true },
  ).lean();
  if (!notification) {
    notification = await Notification.findOne({
      _id: request.params.id,
      recipientId: actorId(request),
    }).lean();
  }
  if (!notification) return response.status(404).json({ error: "Notification not found." });
  const unreadCount = await Notification.countDocuments({
    recipientId: actorId(request),
    readAt: null,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  });
  emitToUser(actorId(request), "notification.unread_count", { unreadCount });
  return response.json({ notification: serializeNotification(notification), unreadCount });
}

async function markAllRead(request, response) {
  const result = await Notification.updateMany(
    {
      recipientId: actorId(request),
      readAt: null,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    },
    { $set: { readAt: new Date() } },
  );
  emitToUser(actorId(request), "notification.unread_count", { unreadCount: 0 });
  return response.json({ updated: result.modifiedCount, unreadCount: 0 });
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
