const audit = require("../lib/audit");

const SAFE_RESOURCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/;

function resourceFor(request) {
  const base = typeof request.baseUrl === "string" ? request.baseUrl : "";
  const resourceType = base
    .replace(/^\/api\/?/, "")
    .split("/")[0]
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 40) || "api";
  const params = request.params || {};
  const rawId = params.id || params.userId || params.sessionId || params.employeeId;
  const id = typeof rawId === "string" && SAFE_RESOURCE_ID.test(rawId)
    ? rawId
    : undefined;
  return { type: resourceType, ...(id ? { id } : {}) };
}

function captureAuthenticatedActivity(request, response, next) {
  const isRead = request.method === "GET" || request.method === "HEAD";
  const isWrite = ["POST", "PUT", "PATCH", "DELETE"].includes(request.method);
  if (!isRead && !isWrite) return next();
  const resource = resourceFor(request);
  const routePath = request.route?.path;
  if (
    (resource.type === "sessions" && routePath === "/activity") ||
    (resource.type === "notifications" && /\/read(?:-all)?$/.test(routePath || ""))
  ) return next();
  const route = typeof routePath === "string"
    ? `${request.baseUrl || ""}${routePath}`.slice(0, 300)
    : (request.baseUrl || "/api").slice(0, 300);

  response.once("finish", () => {
    if (!request.authUser || request.auditEventRecorded) return;
    const statusCode = response.statusCode;
    const outcome = statusCode === 401 || statusCode === 403
      ? "denied"
      : statusCode >= 400
        ? "failure"
        : "success";
    const operation = isRead ? "read" : "write";
    void audit.recordAudit({
      request,
      eventType: `data.${operation}.${outcome === "success" ? "succeeded" : outcome}`,
      outcome,
      reason: outcome === "success" ? undefined : `http_${statusCode}`,
      resource,
      targetUserIdOverride: resource.type === "users" &&
        /^[a-f0-9]{24}$/i.test(resource.id || "")
        ? resource.id
        : undefined,
      details: { method: request.method, route, statusCode },
    }).catch((error) => {
      console.error("Authenticated read audit write failed:", {
        route,
        statusCode,
        error,
      });
    });
  });
  return next();
}

module.exports = { captureAuthenticatedActivity, resourceFor };
