const crypto = require("node:crypto");
const mongoose = require("mongoose");
const User = require("../models/user");
const Session = require("../models/session");
const RoleClaim = require("../models/roleClaim");
const BootstrapState = require("../models/bootstrapState");
const { toPublicUser } = require("../lib/userDto");
const {
  SESSION_SECONDS,
  clearSessionCookie,
  getSessionToken,
} = require("../middleware/authentication");
const { getSecuritySettings } = require("../lib/securitySettings");
const audit = require("../lib/audit");
const { sessionDetails } = require("../lib/sessionPolicy");
const {
  createSession,
  hashSessionToken,
  sessionCookie,
} = require("../lib/sessionTokens");
const {
  MAX_PASSWORD_BYTES,
  normalizeEmail,
  validateCredentials,
} = require("../lib/userPolicy");

const BOOTSTRAP_ID = "initial-super-admin";
const BOOTSTRAP_LOCK_TIMEOUT_MS = 60_000;

function bootstrapSecretMatches(provided, expected) {
  if (typeof provided !== "string" || !expected) return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return (
    providedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

function validPasswordPair(currentPassword, newPassword) {
  return (
    typeof currentPassword === "string" &&
    typeof newPassword === "string" &&
    newPassword.length >= 8 &&
    Buffer.byteLength(newPassword, "utf8") <= MAX_PASSWORD_BYTES &&
    newPassword !== currentPassword
  );
}

async function login(request, response) {
  const email = normalizeEmail(request.body?.email);
  const password = request.body?.password;
  if (!email || typeof password !== "string") {
    return response
      .status(400)
      .json({ error: "Enter your email and password." });
  }

  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    await audit.recordAudit({
      request,
      eventType: "auth.login.failed",
      outcome: "failure",
      reason: "invalid_credentials",
    });
    return response
      .status(401)
      .json({ error: "The email or password is incorrect." });
  }

  const user = await User.findOne({ email }).select("+password");
  if (
    !user ||
    !(await user.comparePassword(password))
  ) {
    await audit.recordAudit({
      request,
      eventType: "auth.login.failed",
      outcome: "failure",
      reason: "invalid_credentials",
      target: user,
    });
    return response
      .status(401)
      .json({ error: "The email or password is incorrect." });
  }
  if (user.status === "Suspended") {
    await audit.recordAudit({
      request,
      eventType: "auth.login.rejected_suspended",
      outcome: "denied",
      reason: "account_suspended",
      target: user,
    });
    return response.status(403).json({
      error: "Your account has been suspended. Please contact an administrator for more information.",
      code: "ACCOUNT_SUSPENDED",
    });
  }
  if (user.status !== "Active") {
    await audit.recordAudit({
      request,
      eventType: "auth.login.rejected_deactivated",
      outcome: "denied",
      reason: "account_deactivated",
      target: user,
    });
    return response
      .status(401)
      .json({ error: "The email or password is incorrect." });
  }
  if (
    user.mustChangePassword &&
    user.temporaryPasswordExpiresAt &&
    user.temporaryPasswordExpiresAt <= new Date()
  ) {
    await audit.recordAudit({
      request,
      eventType: "auth.login.temporary_password_expired",
      outcome: "denied",
      reason: "temporary_password_expired",
      target: user,
    });
    return response.status(401).json({
      error: "This temporary password has expired. Contact a Super Admin to reset it.",
      code: "TEMPORARY_PASSWORD_EXPIRED",
    });
  }

  user.lastActive = new Date();
  await user.save();
  const session = await createSession(user, request, response);
  try {
    await audit.recordAudit({
      request,
      eventType: "auth.login.succeeded",
      outcome: "success",
      actor: user,
      target: user,
      sessionId: session._id,
    });
  } catch (error) {
    await Session.updateOne({ _id: session._id }, { $set: { revokedAt: new Date() } });
    clearSessionCookie(response, request.app.locals.config.isProduction);
    throw error;
  }
  const settings = await getSecuritySettings();
  return response.json({
    user: toPublicUser(user),
    expiresIn: SESSION_SECONDS,
    session: sessionDetails(session, user, settings, true),
  });
}

async function getSession(request, response) {
  const settings = await getSecuritySettings();
  return response.json({
    user: toPublicUser(request.authUser),
    session: sessionDetails(request.authSession, request.authUser, settings, true),
  });
}

async function logout(request, response) {
  const token = getSessionToken(request);
  clearSessionCookie(response, request.app.locals.config.isProduction);
  if (token) {
    const transaction = await mongoose.startSession();
    try {
      await transaction.withTransaction(async () => {
        const session = await Session.findOne({
          tokenHash: hashSessionToken(token),
        }).session(transaction);
        if (!session || session.revokedAt) return;
        session.revokedAt = new Date();
        await session.save({ session: transaction });
        const user = await User.findById(session.userId).session(transaction);
        await audit.recordAudit({
          request,
          eventType: "auth.logout",
          outcome: "success",
          actor: user,
          target: user || { _id: session.userId },
          sessionId: session._id,
          transaction,
        });
      });
    } finally {
      await transaction.endSession();
    }
  }
  return response.status(204).end();
}

async function changePassword(request, response) {
  const { currentPassword, newPassword } = request.body || {};
  if (!validPasswordPair(currentPassword, newPassword)) {
    await audit.recordAudit({
      request,
      eventType: "auth.password_changed",
      outcome: "failure",
      reason: "invalid_request",
      target: request.authUser,
    });
    return response.status(400).json({
      error:
        "Enter your current password and a different new password of at least 8 characters.",
    });
  }

  const transaction = await mongoose.startSession();
  let user;
  let session;
  let passwordVerified = false;
  try {
    await transaction.withTransaction(async () => {
      user = await User.findById(request.authUser._id)
        .select("+password")
        .session(transaction);
      if (!user || !(await user.comparePassword(currentPassword))) return;

      session = await Session.findById(request.authSession._id).session(transaction);
      if (!session || session.revokedAt) {
        const error = new Error("Your session is no longer active.");
        error.statusCode = 401;
        throw error;
      }
      user.password = newPassword;
      user.mustChangePassword = false;
      user.temporaryPasswordExpiresAt = undefined;
      user.sessionVersion += 1;
      await user.save({ session: transaction });
      session.sessionVersion = user.sessionVersion;
      await session.save({ session: transaction });
      await audit.recordAudit({
        request,
        eventType: "auth.password_changed",
        outcome: "success",
        target: user,
        details: { invalidatedOtherSessions: true },
        transaction,
      });
      passwordVerified = true;
    });
  } finally {
    await transaction.endSession();
  }

  if (!passwordVerified) {
    await audit.recordAudit({
      request,
      eventType: "auth.password_changed",
      outcome: "failure",
      reason: "current_password_invalid",
      target: request.authUser,
    });
    return response
      .status(400)
      .json({ error: "The current password is incorrect." });
  }

  request.authSession = session;
  const remainingSeconds = Math.floor(
    (request.authSession.absoluteExpiresAt.getTime() - Date.now()) / 1000,
  );
  response.setHeader(
    "Set-Cookie",
    sessionCookie(
      request.authSessionToken,
      request.app.locals.config.isProduction,
      remainingSeconds,
    ),
  );
  const settings = await getSecuritySettings();
  return response.json({
    user: toPublicUser(user),
    session: sessionDetails(request.authSession, user, settings, true),
  });
}

async function bootstrapSuperAdmin(request, response) {
  const config = request.app.locals.config;
  if (!config.bootstrapSecret) {
    return response
      .status(503)
      .json({
        error: "First-admin bootstrap is not configured on this server.",
      });
  }
  if (
    !bootstrapSecretMatches(
      request.get("x-bootstrap-secret"),
      config.bootstrapSecret,
    )
  ) {
    return response
      .status(401)
      .json({ error: "Invalid bootstrap credentials." });
  }

  const credentials = validateCredentials(request.body || {});
  if (credentials.error)
    return response.status(400).json({ error: credentials.error });

  const ownerToken = crypto.randomUUID();
  const now = new Date();
  let lock;
  try {
    lock = await BootstrapState.findOneAndUpdate(
      {
        _id: BOOTSTRAP_ID,
        consumed: { $ne: true },
        $or: [
          { ownerToken: { $exists: false } },
          {
            claimedAt: {
              $lt: new Date(now.getTime() - BOOTSTRAP_LOCK_TIMEOUT_MS),
            },
          },
        ],
      },
      {
        $set: { ownerToken, claimedAt: now },
        $setOnInsert: { consumed: false },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (error) {
    if (error.code === 11000) {
      return response.status(409).json({
        error: "Bootstrap has already been used or is currently in progress.",
      });
    }
    throw error;
  }
  if (lock.ownerToken !== ownerToken || lock.consumed) {
    return response.status(409).json({
      error: "Bootstrap has already been used or is currently in progress.",
    });
  }

  const session = await mongoose.startSession();
  let created;
  try {
    await session.withTransaction(async () => {
      const existing = await User.exists({ roles: "Super Admin" }).session(
        session,
      );
      if (existing) {
        const error = new Error(
          "A Super Admin account already exists; bootstrap is closed.",
        );
        error.statusCode = 409;
        throw error;
      }

      [created] = await User.create(
        [
          {
            ...credentials.value,
            roles: ["Super Admin"],
            status: "Active",
            mustChangePassword: true,
          },
        ],
        { session },
      );
      await RoleClaim.create([{ _id: "Super Admin", userId: created._id }], {
        session,
      });
    });
    await BootstrapState.updateOne(
      { _id: BOOTSTRAP_ID, ownerToken },
      {
        $set: { consumed: true, userId: created._id },
        $unset: { ownerToken: 1, claimedAt: 1 },
      },
    );
    return response.status(201).json({
      message:
        "Initial Super Admin created. Sign in and change the temporary password to continue.",
      user: toPublicUser(created),
    });
  } catch (error) {
    await BootstrapState.updateOne(
      { _id: BOOTSTRAP_ID, ownerToken, consumed: { $ne: true } },
      { $unset: { ownerToken: 1, claimedAt: 1 } },
    );
    if (error.statusCode) {
      return response.status(error.statusCode).json({ error: error.message });
    }
    if (error.code === 11000) {
      return response
        .status(409)
        .json({ error: "An account with this email or role already exists." });
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

module.exports = {
  bootstrapSuperAdmin,
  changePassword,
  getSession,
  login,
  logout,
};
