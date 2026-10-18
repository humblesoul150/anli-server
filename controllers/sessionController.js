const mongoose = require("mongoose");
const Session = require("../models/session");
const User = require("../models/user");
const audit = require("../lib/audit");
const { getSecuritySettings } = require("../lib/securitySettings");
const {
  IDLE_WRITE_INTERVAL_MS,
  idleTimeoutMs,
  sessionDetails,
} = require("../lib/sessionPolicy");

async function reportActivity(request, response) {
  const now = new Date();
  const lastWriteBefore = new Date(now.getTime() - IDLE_WRITE_INTERVAL_MS);
  const session = await Session.findOneAndUpdate(
    {
      _id: request.authSession._id,
      revokedAt: null,
      lastActivityAt: { $lte: lastWriteBefore },
    },
    { $set: { lastActivityAt: now } },
    { new: true },
  );
  const current = session || request.authSession;
  if (session) request.authSession.lastActivityAt = session.lastActivityAt;
  const settings = await getSecuritySettings();
  return response.json({
    session: sessionDetails(current, request.authUser, settings, true),
  });
}

async function listSessionsForUser(user, currentSessionId, response) {
  const settings = await getSecuritySettings();
  const now = new Date();
  const timeout = idleTimeoutMs(user, settings);
  const sessions = await Session.find({
    userId: user._id,
    revokedAt: null,
    sessionVersion: user.sessionVersion,
    absoluteExpiresAt: { $gt: now },
    lastActivityAt: { $gt: new Date(now.getTime() - timeout) },
  }).sort({ lastActivityAt: -1 });
  return response.json({
    sessions: sessions.map((session) =>
      sessionDetails(session, user, settings, String(session._id) === String(currentSessionId)),
    ),
  });
}

async function listOwnSessions(request, response) {
  return listSessionsForUser(
    request.authUser,
    request.authSession._id,
    response,
  );
}

async function listUserSessions(request, response) {
  if (!mongoose.Types.ObjectId.isValid(request.params.userId)) {
    return response.status(400).json({ error: "Invalid user id." });
  }
  const user = await User.findById(request.params.userId);
  if (!user) return response.status(404).json({ error: "User not found." });
  return listSessionsForUser(user, request.authSession._id, response);
}

async function revokeSession(request, response) {
  if (!mongoose.Types.ObjectId.isValid(request.params.sessionId)) {
    return response.status(400).json({ error: "Invalid session id." });
  }
  const session = await Session.findOne({
    _id: request.params.sessionId,
    revokedAt: null,
  });
  if (!session) return response.status(404).json({ error: "Session not found." });

  const isOwner = String(session.userId) === String(request.authUser._id);
  const isSuperAdmin = request.authUser.roles.includes("Super Admin");
  if (!isOwner && !isSuperAdmin) {
    return response.status(403).json({ error: "You cannot revoke this session." });
  }

  const transaction = await mongoose.startSession();
  let revoked = false;
  try {
    await transaction.withTransaction(async () => {
      const changed = await Session.findOneAndUpdate(
        { _id: session._id, revokedAt: null },
        { $set: { revokedAt: new Date() } },
        { new: true, session: transaction },
      );
      if (!changed) return;
      const target = isOwner
        ? request.authUser
        : (await User.findById(session.userId).session(transaction)) || { _id: session.userId };
      await audit.recordAudit({
        request,
        eventType: "session.revoked",
        outcome: "success",
        actor: request.authUser,
        target,
        details: {
          revocationType: isOwner ? "self_service" : "admin",
          revokedSessionId: String(session._id),
        },
        transaction,
      });
      revoked = true;
    });
  } finally {
    await transaction.endSession();
  }
  if (!revoked) return response.status(404).json({ error: "Session not found." });
  return response.status(204).end();
}

module.exports = {
  listOwnSessions,
  listUserSessions,
  reportActivity,
  revokeSession,
};
