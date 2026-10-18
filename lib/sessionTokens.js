const crypto = require("node:crypto");
const Session = require("../models/session");
const { SESSION_SECONDS } = require("./sessionConstants");

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function createSession(user, request, response) {
  const now = new Date();
  const absoluteExpiresAt = new Date(now.getTime() + SESSION_SECONDS * 1000);
  const token = crypto.randomBytes(32).toString("base64url");
  const session = await Session.create({
    userId: user._id,
    tokenHash: hashSessionToken(token),
    userAgent: String(request.get("user-agent") || "Unknown device").slice(0, 300),
    createdAt: now,
    lastActivityAt: now,
    absoluteExpiresAt,
    expiresAt: absoluteExpiresAt,
    sessionVersion: user.sessionVersion,
  });

  response.setHeader(
    "Set-Cookie",
    sessionCookie(token, request.app.locals.config.isProduction, SESSION_SECONDS),
  );
  return session;
}

function sessionCookie(token, isProduction, maxAgeSeconds) {
  const attributes = [
    `anli_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (isProduction) attributes.push("Secure");
  return attributes.join("; ");
}

async function revokeToken(token) {
  if (!token) return;
  await Session.updateOne(
    { tokenHash: hashSessionToken(token), revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}

module.exports = {
  createSession,
  hashSessionToken,
  revokeToken,
  sessionCookie,
};
