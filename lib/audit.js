const mongoose = require("mongoose");
const AuditEvent = require("../models/auditEvent");
const { AUDIT_EVENT_TYPES } = require("../models/auditEvent");
const notificationAuditBridge = require("./notificationAuditBridge");

const SAFE_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const SECRET_KEY = /password|token|secret|cookie|credential|authorization/i;
const SAFE_RESOURCE_VALUE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/;
const RESOURCE_ID_FIELDS = {
  account: ["userId", "accountId"],
  employee: ["employeeId"],
  attendance: ["attendanceId", "recordId"],
  production: ["productId", "materialId", "runId"],
  inventory: ["materialId", "movementId"],
  leave: ["leaveRequestId", "requestId"],
  disciplinary: ["caseId"],
  salary_advance: ["advanceId"],
  asset: ["assetId"],
  payroll: ["runId"],
  expense: ["expenseId"],
  customer: ["customerId"],
  sale: ["saleId"],
  receipt: ["receiptId", "saleId"],
  order: ["orderId"],
  session: ["revokedSessionId", "sessionId"],
  company: [],
  credit: ["saleId"],
  security: [],
  auth: [],
};

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

function safeResource(resource) {
  if (resource === undefined || resource === null) return null;
  if (
    typeof resource !== "object" ||
    typeof resource.type !== "string" ||
    !/^[a-z][a-z0-9_-]{0,39}$/i.test(resource.type)
  ) {
    throw new TypeError("Audit resource type is invalid.");
  }
  const result = { type: resource.type };
  for (const key of ["id", "reference"]) {
    const value = resource[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string" || !SAFE_RESOURCE_VALUE.test(value)) {
      throw new TypeError(`Audit resource ${key} is invalid.`);
    }
    result[key] = value;
  }
  return result;
}

function inferResource(eventType, details) {
  const [domain, action = ""] = eventType.split(".");
  let type = domain;
  if (domain === "company") type = "company_profile";
  if (domain === "credit") type = action.startsWith("sale_") ? "sale" : "credit";
  if (domain === "production") {
    type = action.includes("material") ? "raw_material" : "production_product";
  }
  if (domain === "inventory") type = "raw_material";
  const idFields = RESOURCE_ID_FIELDS[domain] || [];
  const idField = idFields.find((field) => details?.[field] !== undefined);
  const rawId = idField ? details[idField] : undefined;
  const id = typeof rawId === "string" ? rawId : rawId?.toString?.();
  return { type, ...(id ? { id } : {}) };
}

async function recordAudit({
  request,
  eventType,
  outcome,
  reason,
  actor = request?.authUser,
  target,
  resource,
  targetUserIdOverride,
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
  if (targetUserIdOverride && (
    typeof targetUserIdOverride !== "string" ||
    !/^[a-f0-9]{24}$/i.test(targetUserIdOverride)
  )) {
    throw new TypeError("Audit target user id is invalid.");
  }
  const safeEventDetails = safeDetails(details) || {};
  const resourceSnapshot = safeResource(resource || inferResource(eventType, safeEventDetails));
  const getHeader = (name) => {
    if (typeof request?.get === "function") return request.get(name);
    return request?.headers?.[name.toLowerCase()];
  };
  const ipAddress = typeof request?.ip === "string"
    ? request.ip.slice(0, 64)
    : undefined;
  const userAgent = getHeader("user-agent");

  const event = {
    _id: new mongoose.Types.ObjectId(),
    eventType,
    outcome,
    reason,
    actorId: actorSnapshot.id || null,
    actorName: actorSnapshot.name,
    actorRoles: actorSnapshot.roles,
    targetUserId: targetSnapshot.id || targetUserIdOverride || null,
    targetName: targetSnapshot.name,
    targetEmail: targetSnapshot.email,
    resource: resourceSnapshot,
    sessionId: sessionId || null,
    ipAddress,
    userAgent: typeof userAgent === "string" ? userAgent.slice(0, 300) : undefined,
    details: safeEventDetails,
    createdAt: new Date(),
  };

  if (transaction) await AuditEvent.create([event], { session: transaction });
  else await AuditEvent.create(event);
  if (request) request.auditEventRecorded = true;
  try {
    await notificationAuditBridge.enqueueFromAudit(event, transaction);
  } catch (error) {
    console.error("Audit notification enqueue failed:", {
      eventId: String(event._id),
      eventType,
      error,
    });
  }
}

module.exports = { recordAudit, safeDetails, safeResource };
