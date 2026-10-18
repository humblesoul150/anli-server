const AuditEvent = require("../models/auditEvent");
const { AUDIT_EVENT_TYPES } = require("../models/auditEvent");

const SAFE_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const SECRET_KEY = /password|token|secret|cookie|credential|authorization/i;

function safeDetails(value, depth = 0) {
  if (depth > 3 || value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value.slice(0, 300);
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => safeDetails(item, depth + 1));
  }
  if (typeof value !== "object") return undefined;

  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 30)) {
    if (!SAFE_KEY.test(key) || SECRET_KEY.test(key)) continue;
    const safeValue = safeDetails(item, depth + 1);
    if (safeValue !== undefined) result[key] = safeValue;
  }
  return result;
}

function snapshot(user) {
  if (!user?._id) return {};
  return {
    id: user._id,
    name: typeof user.name === "string" ? user.name.slice(0, 120) : undefined,
    email: typeof user.email === "string" ? user.email.slice(0, 254) : undefined,
    roles: Array.isArray(user.roles) ? user.roles.slice(0, 20) : [],
  };
}

async function recordAudit({
  request,
  eventType,
  outcome,
  reason,
  actor = request?.authUser,
  target,
  details = {},
  transaction,
  sessionId = request?.authSession?._id,
}) {
  if (!AUDIT_EVENT_TYPES.includes(eventType)) {
    throw new TypeError(`Unsupported audit event type: ${eventType}`);
  }
  if (!["success", "failure", "denied"].includes(outcome)) {
    throw new TypeError(`Unsupported audit outcome: ${outcome}`);
  }
  if (reason && !/^[a-z0-9_.-]{1,80}$/i.test(reason)) {
    throw new TypeError("Audit reason must be a short reason code.");
  }

  const actorSnapshot = snapshot(actor);
  const targetSnapshot = snapshot(target);
  const getHeader = (name) => {
    if (typeof request?.get === "function") return request.get(name);
    return request?.headers?.[name.toLowerCase()];
  };
  const ipAddress = typeof request?.ip === "string"
    ? request.ip.slice(0, 64)
    : undefined;
  const userAgent = getHeader("user-agent");

  const event = {
    eventType,
    outcome,
    reason,
    actorId: actorSnapshot.id || null,
    actorName: actorSnapshot.name,
    actorRoles: actorSnapshot.roles,
    targetUserId: targetSnapshot.id || null,
    targetName: targetSnapshot.name,
    targetEmail: targetSnapshot.email,
    sessionId: sessionId || null,
    ipAddress,
    userAgent: typeof userAgent === "string" ? userAgent.slice(0, 300) : undefined,
    details: safeDetails(details) || {},
    createdAt: new Date(),
  };

  if (transaction) {
    await AuditEvent.create([event], { session: transaction });
  } else {
    await AuditEvent.create(event);
  }
}

module.exports = { recordAudit, safeDetails };
