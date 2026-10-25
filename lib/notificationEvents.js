const mongoose = require("mongoose");
const Notification = require("../models/notification");
const NotificationOutbox = require("../models/notificationOutbox");
const User = require("../models/user");
const { emitToUser } = require("./notificationRealtime");

const CATEGORIES = new Set(["approval", "leave", "payroll", "salary_advance", "expense", "inventory", "sales", "security", "general"]);
const SEVERITIES = new Set(["info", "action_required", "urgent"]);

function validateEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new TypeError("Notification event must be an object.");
  }
  for (const field of ["eventKey", "type", "category", "title", "message"]) {
    if (typeof event[field] !== "string" || !event[field].trim()) {
      throw new TypeError(`Notification event ${field} is required.`);
    }
  }
  if (!CATEGORIES.has(event.category)) throw new TypeError("Notification event category is invalid.");
  if (event.severity !== undefined && !SEVERITIES.has(event.severity)) {
    throw new TypeError("Notification event severity is invalid.");
  }
  if (!event.resource || typeof event.resource.type !== "string" || !event.resource.type.trim() ||
      typeof event.resource.id !== "string" || !event.resource.id.trim()) {
    throw new TypeError("Notification event requires a typed resource reference.");
  }
  if (event.eventKey.length > 240 || event.type.length > 100 || event.title.length > 160 || event.message.length > 500) {
    throw new TypeError("Notification event exceeds a supported field length.");
  }
  if (!Array.isArray(event.recipientIds || []) || !Array.isArray(event.recipientRoles || [])) {
    throw new TypeError("Notification recipients must be arrays.");
  }
}

async function enqueueNotificationEvent(event, session) {
  validateEvent(event);
  const record = {
    ...event,
    resource: {
      type: event.resource.type.trim(),
      id: event.resource.id.trim(),
      reference: event.resource.reference?.trim(),
    },
    recipientIds: [...new Set((event.recipientIds || []).map(String))],
    recipientRoles: [...new Set((event.recipientRoles || []).map((role) => String(role).trim()))],
    excludeRecipientIds: [...new Set((event.excludeRecipientIds || []).map(String))],
    actorId: event.actorId || null,
  };
  if (session) {
    await NotificationOutbox.create([record], { session });
    return true;
  } else {
    try {
      await NotificationOutbox.create(record);
      return true;
    } catch (error) {
      if (error?.code === 11000) return false;
      throw error;
    }
  }
}

function legacyNotification(document) {
  if (document.resource) return document;
  if (!document.saleId) return document;
  return {
    ...document,
    category: "sales",
    severity: "action_required",
    resource: {
      type: "sale",
      id: String(document.saleId),
      reference: document.receiptNumber,
    },
    occurredAt: document.createdAt,
    dedupeKey: document.thresholdKey || `legacy:${document._id}`,
  };
}

function serializeNotification(document) {
  const value = legacyNotification(document);
  return {
    id: String(value._id),
    type: value.type,
    category: value.category || "general",
    severity: value.severity || "info",
    title: value.title,
    message: value.message,
    resource: {
      type: value.resource.type,
      id: String(value.resource.id),
      ...(value.resource.reference ? { reference: value.resource.reference } : {}),
    },
    occurredAt: value.occurredAt || value.createdAt,
    readAt: value.readAt || null,
    expiresAt: value.expiresAt || null,
    createdAt: value.createdAt,
  };
}

async function resolveRecipients(outboxEvent) {
  const ids = new Set((outboxEvent.recipientIds || []).map(String));
  if (outboxEvent.recipientRoles?.length) {
    const users = await User.find({
      status: "Active",
      roles: { $in: outboxEvent.recipientRoles },
    }).select("_id").lean();
    for (const user of users) ids.add(String(user._id));
  }
  for (const id of outboxEvent.excludeRecipientIds || []) ids.delete(String(id));
  if (!ids.size) return [];
  const validIds = [...ids].filter((id) => mongoose.isValidObjectId(id));
  if (!validIds.length) return [];
  const activeUsers = await User.find({ _id: { $in: validIds }, status: "Active" }).select("_id").lean();
  return activeUsers.map((user) => String(user._id));
}

async function deliverEvent(outboxEvent) {
  if (outboxEvent.expiresAt && new Date(outboxEvent.expiresAt) <= new Date()) {
    await NotificationOutbox.updateOne(
      { _id: outboxEvent._id, status: "processing" },
      { $set: { status: "delivered", processedAt: new Date(), leaseUntil: null } },
    );
    return;
  }
  const recipientIds = await resolveRecipients(outboxEvent);
  for (const recipientId of recipientIds) {
    let document;
    try {
      document = await Notification.create({
        recipientId,
        type: outboxEvent.type,
        category: outboxEvent.category,
        severity: outboxEvent.severity,
        title: outboxEvent.title,
        message: outboxEvent.message,
        resource: outboxEvent.resource,
        actorId: outboxEvent.actorId,
        eventId: String(outboxEvent._id),
        dedupeKey: outboxEvent.eventKey,
        occurredAt: outboxEvent.occurredAt,
        expiresAt: outboxEvent.expiresAt,
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      document = await Notification.findOne({
        recipientId,
        dedupeKey: outboxEvent.eventKey,
      }).lean();
      if (!document) throw error;
    }
    const notification = serializeNotification(document.toObject ? document.toObject() : document);
    emitToUser(recipientId, "notification.created", { notification });
    const unreadCount = await Notification.countDocuments({ recipientId, readAt: null });
    emitToUser(recipientId, "notification.unread_count", { unreadCount });
  }
  await NotificationOutbox.updateOne(
    { _id: outboxEvent._id, status: "processing" },
    { $set: { status: "delivered", processedAt: new Date(), leaseUntil: null, lastError: undefined } },
  );
}

async function processNotificationOutbox({ batchSize = 50, now = new Date() } = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new RangeError("Notification outbox batch size must be from 1 to 500.");
  }
  let processed = 0;
  for (let index = 0; index < batchSize; index += 1) {
    const event = await NotificationOutbox.findOneAndUpdate(
      {
        $or: [
          { status: "pending", nextAttemptAt: { $lte: now } },
          { status: "processing", leaseUntil: { $lte: now } },
        ],
      },
      {
        $set: { status: "processing", leaseUntil: new Date(now.getTime() + 60_000) },
        $inc: { attempts: 1 },
      },
      { new: true, sort: { createdAt: 1, _id: 1 } },
    ).lean();
    if (!event) break;
    try {
      await deliverEvent(event);
      processed += 1;
    } catch (error) {
      const delayMs = Math.min(60 * 60 * 1000, 1000 * (2 ** Math.min(event.attempts || 1, 10)));
      const permanentlyFailed = event.attempts >= 10;
      await NotificationOutbox.updateOne(
        { _id: event._id, status: "processing" },
        {
          $set: {
            status: permanentlyFailed ? "failed" : "pending",
            nextAttemptAt: new Date(now.getTime() + delayMs),
            leaseUntil: null,
            lastError: String(error?.message || error).slice(0, 500),
          },
        },
      );
      console.error("Notification outbox delivery failed:", error);
    }
  }
  return { processed };
}

module.exports = { enqueueNotificationEvent, processNotificationOutbox, serializeNotification };
