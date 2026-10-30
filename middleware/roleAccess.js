const audit = require("../lib/audit");
const { hasAnyDepartmentRole } = require("../lib/authorization");

function requireAnyRole(roles, reason, message) {
  return async (request, response, next) => {
    if (hasAnyDepartmentRole(request.authUser, roles)) return next();
    await audit.recordAudit({
      request,
      eventType: "security.authorization_denied",
      outcome: "denied",
      reason,
      actor: request.authUser,
      details: { resource: request.baseUrl },
    });
    return response.status(403).json({ error: message });
  };
}

module.exports = { requireAnyRole };
