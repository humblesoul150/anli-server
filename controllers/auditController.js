const mongoose = require("mongoose");
const AuditEvent = require("../models/auditEvent");
const User = require("../models/user");
const {
  AUDIT_EVENT_CATEGORIES,
  AUDIT_EVENT_TYPES,
  AUDIT_RESOURCE_TYPES,
} = require("../models/auditEvent");

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;

function parseCursor(value) {
  if (!value) return null;
  if (value.length > 256) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof decoded.createdAt !== "string" ||
      Number.isNaN(Date.parse(decoded.createdAt)) ||
      !mongoose.Types.ObjectId.isValid(decoded.id)
    ) return undefined;
    return { createdAt: new Date(decoded.createdAt), id: new mongoose.Types.ObjectId(decoded.id) };
  } catch {
    return undefined;
  }
}

function parseFilterDate(value, endOfDay = false) {
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const normalized = isDateOnly
    ? `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`
    : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;
  if (isDateOnly && date.toISOString().slice(0, 10) !== value) return null;
  return date;
}

function serializeEvent(event) {
  return {
    id: String(event._id),
    eventType: event.eventType,
    outcome: event.outcome,
    reason: event.reason,
    actor: event.actorId
      ? { id: String(event.actorId), name: event.actorName, roles: event.actorRoles || [] }
      : null,
    target: event.targetUserId
      ? { id: String(event.targetUserId), name: event.targetName, email: event.targetEmail }
      : null,
    resource: event.resource
      ? {
        type: event.resource.type,
        id: event.resource.id,
        reference: event.resource.reference,
      }
      : null,
    sessionId: event.sessionId ? String(event.sessionId) : null,
    ipAddress: event.ipAddress,
    userAgent: event.userAgent,
    details: event.details || {},
    createdAt: event.createdAt.toISOString(),
  };
}

async function listEvents(request, response, forcedTargetUserId) {
  const {
    eventType,
    category,
    outcome,
    actorId,
    targetUserId: queryTargetUserId,
    resourceType,
    from,
    to,
    cursor: cursorValue,
  } = request.query;
  const targetUserId = forcedTargetUserId || queryTargetUserId;
  for (const [name, value] of Object.entries({
    eventType,
    category,
    outcome,
    actorId,
    targetUserId,
    resourceType,
    from,
    to,
    cursor: cursorValue,
  })) {
    if (value !== undefined && typeof value !== "string") {
      return response.status(400).json({ error: `${name} must be a single value.` });
    }
  }
  if (request.query.limit !== undefined && typeof request.query.limit !== "string") {
    return response.status(400).json({ error: "limit must be a single value." });
  }
  const rawLimit = request.query.limit === undefined ? DEFAULT_PAGE_SIZE : Number(request.query.limit);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_PAGE_SIZE) {
    return response.status(400).json({ error: `limit must be an integer from 1 to ${MAX_PAGE_SIZE}.` });
  }
  if (eventType && !AUDIT_EVENT_TYPES.includes(eventType)) {
    return response.status(400).json({ error: "Unknown audit event type." });
  }
  if (category && !AUDIT_EVENT_CATEGORIES.includes(category)) {
    return response.status(400).json({ error: "Unknown audit event category." });
  }
  if (resourceType && !AUDIT_RESOURCE_TYPES.includes(resourceType)) {
    return response.status(400).json({ error: "Unknown audit resource type." });
  }
  if (outcome && !["success", "failure", "denied"].includes(outcome)) {
    return response.status(400).json({ error: "Choose a valid audit outcome." });
  }
  for (const [name, value] of [["actorId", actorId], ["targetUserId", targetUserId]]) {
    if (value && !mongoose.Types.ObjectId.isValid(value)) {
      return response.status(400).json({ error: `${name} must be a valid user id.` });
    }
  }

  const dateRange = {};
  if (from) {
    const date = parseFilterDate(from);
    if (!date) return response.status(400).json({ error: "from must be a valid date." });
    dateRange.$gte = date;
  }
  if (to) {
    const date = parseFilterDate(to, true);
    if (!date) return response.status(400).json({ error: "to must be a valid date." });
    dateRange.$lte = date;
  }
  if (dateRange.$gte && dateRange.$lte && dateRange.$gte > dateRange.$lte) {
    return response.status(400).json({ error: "from must be earlier than or equal to to." });
  }

  const cursor = parseCursor(cursorValue);
  if (cursor === undefined) return response.status(400).json({ error: "cursor is invalid." });
  const conditions = [];
  if (eventType) conditions.push({ eventType });
  if (category) conditions.push({ eventType: new RegExp(`^${category}\\.`) });
  if (outcome) conditions.push({ outcome });
  if (actorId) conditions.push({ actorId });
  if (targetUserId) conditions.push({ targetUserId });
  if (resourceType) conditions.push({ "resource.type": resourceType });
  if (Object.keys(dateRange).length) conditions.push({ createdAt: dateRange });
  if (cursor) {
    conditions.push({
      $or: [
        { createdAt: { $lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, _id: { $lt: cursor.id } },
      ],
    });
  }

  const query = conditions.length ? { $and: conditions } : {};
  const entries = await AuditEvent.find(query)
    .sort({ createdAt: -1, _id: -1 })
    .limit(rawLimit + 1)
    .lean();
  const hasMore = entries.length > rawLimit;
  const page = entries.slice(0, rawLimit);
  const last = page.at(-1);

  return response.json({
    events: page.map(serializeEvent),
    nextCursor: hasMore && last
      ? Buffer.from(JSON.stringify({ createdAt: last.createdAt.toISOString(), id: String(last._id) })).toString("base64url")
      : null,
  });
}

async function listEventTypes(_request, response) {
  return response.json({
    eventTypes: AUDIT_EVENT_TYPES,
    resourceTypes: AUDIT_RESOURCE_TYPES,
    categories: AUDIT_EVENT_CATEGORIES,
  });
}

async function listAccountEvents(request, response) {
  if (!mongoose.Types.ObjectId.isValid(request.params.userId)) {
    return response.status(400).json({ error: "Invalid user id." });
  }
  const exists = await User.exists({ _id: request.params.userId });
  if (!exists) return response.status(404).json({ error: "User not found." });
  return listEvents(request, response, request.params.userId);
}

module.exports = { listAccountEvents, listEventTypes, listEvents, parseCursor };
