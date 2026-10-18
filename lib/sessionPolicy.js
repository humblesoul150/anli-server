const IDLE_WRITE_INTERVAL_MS = 30_000;
const PRIVILEGED_ROLES = new Set(["Super Admin", "Admin"]);

function idleTimeoutMs(user, settings) {
  const minutes = user.roles.some((role) => PRIVILEGED_ROLES.has(role))
    ? settings.privilegedIdle
    : settings.generalIdle;
  return minutes * 60_000;
}

function sessionDetails(session, user, settings, current = false) {
  const timeoutMs = idleTimeoutMs(user, settings);
  return {
    id: String(session._id),
    userAgent: session.userAgent,
    createdAt: session.createdAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
    idleTimeoutMs: timeoutMs,
    warningPeriodMs: Math.min(
      settings.warningPeriod * 60_000,
      timeoutMs / 2,
    ),
    idleExpiresAt: new Date(
      Math.min(
        session.lastActivityAt.getTime() + timeoutMs,
        session.absoluteExpiresAt.getTime(),
      ),
    ).toISOString(),
    absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
    current,
  };
}

module.exports = { IDLE_WRITE_INTERVAL_MS, idleTimeoutMs, sessionDetails };
