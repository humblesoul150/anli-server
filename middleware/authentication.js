const Session = require("../models/session");
const User = require("../models/user");
const { getSecuritySettings } = require("../lib/securitySettings");
const { idleTimeoutMs } = require("../lib/sessionPolicy");
const { hashSessionToken } = require("../lib/sessionTokens");
const { SESSION_SECONDS } = require("../lib/sessionConstants");
const audit = require("../lib/audit");

const COOKIE_NAME = "anli_session";

function getSessionToken(request) {
  const authorization = request.get("authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  const cookie = request.get("cookie");
  if (!cookie) return null;

  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE_NAME) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function clearSessionCookie(response, isProduction) {
  const attributes = [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (isProduction) attributes.push("Secure");
  response.setHeader("Set-Cookie", attributes.join("; "));
}

async function authenticate(request, response, next) {
  const token = getSessionToken(request);
  if (!token) {
    return response.status(401).json({ error: "Authentication required." });
  }

  const now = new Date();
  const session = await Session.findOne({ tokenHash: hashSessionToken(token) });
  if (!session || session.revokedAt) {
    clearSessionCookie(response, request.app.locals.config.isProduction);
    return response.status(401).json({ error: "Your session is no longer active." });
  }
  if (session.absoluteExpiresAt <= now) {
    const update = await Session.updateOne(
      { _id: session._id, revokedAt: null },
      { $set: { revokedAt: now } },
    );
    if (update.modifiedCount) {
      const user = await User.findById(session.userId);
      await audit.recordAudit({
        request,
        eventType: "session.absolute_expired",
        outcome: "denied",
        reason: "absolute_timeout",
        actor: user,
        target: user,
        sessionId: session._id,
      });
    }
    clearSessionCookie(response, request.app.locals.config.isProduction);
    return response.status(401).json({ error: "Your session is no longer active." });
  }
  const user = await User.findById(session.userId);
  if (
    !user ||
    user.status !== "Active" ||
    session.sessionVersion !== user.sessionVersion
  ) {
    clearSessionCookie(response, request.app.locals.config.isProduction);
    return response.status(401).json({ error: "Your session is no longer active." });
  }
  const settings = await getSecuritySettings();
  if (now.getTime() - session.lastActivityAt.getTime() >= idleTimeoutMs(user, settings)) {
    const update = await Session.updateOne(
      { _id: session._id, revokedAt: null },
      { $set: { revokedAt: now } },
    );
    if (update.modifiedCount) {
      await audit.recordAudit({
        request,
        eventType: "session.idle_expired",
        outcome: "denied",
        reason: "idle_timeout",
        actor: user,
        target: user,
        sessionId: session._id,
      });
    }
    clearSessionCookie(response, request.app.locals.config.isProduction);
    return response.status(401).json({
      error: "Your session expired after a period of inactivity. Please sign in again.",
      code: "SESSION_IDLE_EXPIRED",
    });
  }
  request.authUser = user;
  request.authSession = session;
  request.authSessionToken = token;
  return next();
}

async function requireSuperAdmin(request, response, next) {
  if (!request.authUser?.roles.includes("Super Admin")) {
    await audit.recordAudit({
      request,
      eventType: "security.authorization_denied",
      outcome: "denied",
      reason: "super_admin_required",
      actor: request.authUser,
      details: { resource: request.baseUrl || "protected_route" },
    });
    return response.status(403).json({ error: "Only an active Super Admin can manage accounts." });
  }
  return next();
}

async function requirePasswordChanged(request, response, next) {
  if (request.authUser?.mustChangePassword) {
    await audit.recordAudit({
      request,
      eventType: "security.authorization_denied",
      outcome: "denied",
      reason: "password_change_required",
      actor: request.authUser,
      details: { resource: request.baseUrl || "protected_route" },
    });
    return response.status(403).json({
      error: "Change your temporary password before continuing.",
      code: "PASSWORD_CHANGE_REQUIRED",
    });
  }
  return next();
}

module.exports = {
  COOKIE_NAME,
  SESSION_SECONDS,
  authenticate,
  clearSessionCookie,
  getSessionToken,
  requirePasswordChanged,
  requireSuperAdmin,
};
