const crypto = require("node:crypto");
const mongoose = require("mongoose");
const User = require("../models/user");
const RoleClaim = require("../models/roleClaim");
const { toPublicUser } = require("../lib/userDto");
const audit = require("../lib/audit");
const {
  canAssignRoles,
  canManageAccount,
  EXCLUSIVE_ROLES,
  validateCredentials,
  validateRoles,
} = require("../lib/userPolicy");

const TEMPORARY_PASSWORD_LIFETIME_MS = 24 * 60 * 60 * 1000;
const TEMPORARY_PASSWORD_LENGTH = 6;
const TEMPORARY_PASSWORD_CHARACTERS =
  "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function ensureSuperAdminRemains(user, nextRoles, nextStatus, session) {
  const isRemovingActiveSuperAdmin = user.status === "Active"
    && user.roles.includes("Super Admin")
    && (nextStatus !== "Active" || !nextRoles.includes("Super Admin"));
  if (!isRemovingActiveSuperAdmin) return;

  const anotherActiveSuperAdmin = await User.exists({
    _id: { $ne: user._id },
    roles: "Super Admin",
    status: "Active",
  }).session(session);
  if (!anotherActiveSuperAdmin) {
    throw httpError(409, "At least one active Super Admin must remain assigned.");
  }
}

async function synchronizeRoleClaims(user, session) {
  const desiredRoles = user.status === "Deactivated"
    ? []
    : user.roles.filter((role) => EXCLUSIVE_ROLES.includes(role));

  await RoleClaim.deleteMany({
    userId: user._id,
    _id: { $nin: desiredRoles },
  }).session(session);

  for (const role of desiredRoles) {
    const otherOwner = await User.findOne({
      _id: { $ne: user._id },
      roles: role,
      status: { $ne: "Deactivated" },
    }).select("_id").session(session);
    if (otherOwner) {
      throw httpError(409, `${role} is already assigned to another account.`);
    }

    await RoleClaim.findOneAndUpdate(
      { _id: role },
      { $set: { userId: user._id } },
      { upsert: true, new: true, session, setDefaultsOnInsert: true },
    );
  }
}

function validateUserId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function handleDuplicate(error, response) {
  if (error.code !== 11000) return false;
  response.status(409).json({ error: "An account with this email or role already exists." });
  return true;
}

async function listUsers(request, response) {
  const users = await User.find().sort({ name: 1, email: 1 });
  return response.json({
    users: users
      .filter((user) => canManageAccount(request.authUser, user))
      .map(toPublicUser),
  });
}

async function createUser(request, response) {
  const credentials = validateCredentials(request.body || {});
  if (credentials.error) return response.status(400).json({ error: credentials.error });
  const roles = validateRoles(request.body?.roles);
  if (roles.error) return response.status(400).json({ error: roles.error });
  if (!canAssignRoles(request.authUser, roles.value)) {
    return response.status(403).json({ error: "You cannot create an account with one or more of these roles." });
  }

  const session = await mongoose.startSession();
  let created;
  try {
    await session.withTransaction(async () => {
      [created] = await User.create(
        [{
          ...credentials.value,
          roles: roles.value,
          status: "Active",
          mustChangePassword: true,
        }],
        { session },
      );
      await synchronizeRoleClaims(created, session);
      await audit.recordAudit({
        request,
        eventType: "account.created",
        outcome: "success",
        target: created,
        details: { roles: [...created.roles] },
        transaction: session,
      });
    });
    return response.status(201).json({ user: toPublicUser(created) });
  } catch (error) {
    if (handleDuplicate(error, response)) return;
    if (error.statusCode) return response.status(error.statusCode).json({ error: error.message });
    throw error;
  } finally {
    await session.endSession();
  }
}

async function updateUser(request, response) {
  if (!validateUserId(request.params.id)) {
    return response.status(400).json({ error: "Invalid user id." });
  }
  const credentials = validateCredentials(
    { ...request.body, password: undefined },
    { requirePassword: false },
  );
  if (credentials.error) return response.status(400).json({ error: credentials.error });
  const roles = validateRoles(request.body?.roles);
  if (roles.error) return response.status(400).json({ error: roles.error });

  const session = await mongoose.startSession();
  let updated;
  try {
    await session.withTransaction(async () => {
      const user = await User.findById(request.params.id).session(session);
      if (!user) throw httpError(404, "User not found.");
      if (!canManageAccount(request.authUser, user)) {
        throw httpError(403, "You cannot manage this account.");
      }
      if (!canAssignRoles(request.authUser, roles.value)) {
        throw httpError(403, "You cannot assign one or more of these roles.");
      }
      await ensureSuperAdminRemains(user, roles.value, user.status, session);
      const changedFields = [];
      if (user.name !== credentials.value.name) changedFields.push("name");
      if (user.email !== credentials.value.email) changedFields.push("email");
      const rolesChanged = user.roles.length !== roles.value.length
        || user.roles.some((role, index) => role !== roles.value[index]);
      const previousRoles = [...user.roles];
      if (rolesChanged) changedFields.push("roles");
      user.name = credentials.value.name;
      user.email = credentials.value.email;
      user.roles = roles.value;
      await user.save({ session });
      await synchronizeRoleClaims(user, session);
      if (changedFields.length) {
        await audit.recordAudit({
          request,
          eventType: "account.updated",
          outcome: "success",
          target: user,
          details: {
            changedFields,
            ...(rolesChanged ? { previousRoles, roles: [...user.roles] } : {}),
          },
          transaction: session,
        });
      }
      updated = user;
    });
    return response.json({ user: toPublicUser(updated) });
  } catch (error) {
    if (handleDuplicate(error, response)) return;
    if (error.statusCode) return response.status(error.statusCode).json({ error: error.message });
    throw error;
  } finally {
    await session.endSession();
  }
}

async function updateUserStatus(request, response) {
  if (!validateUserId(request.params.id)) {
    return response.status(400).json({ error: "Invalid user id." });
  }
  const { status, suspensionReason } = request.body || {};
  if (!["Active", "Suspended", "Deactivated"].includes(status)) {
    return response.status(400).json({ error: "Choose a valid account status." });
  }
  const reason = typeof suspensionReason === "string" ? suspensionReason.trim() : "";
  if (status === "Suspended" && !reason) {
    return response.status(400).json({ error: "A suspension reason is required." });
  }
  if (reason.length > 500) {
    return response.status(400).json({ error: "Suspension reason must be 500 characters or fewer." });
  }

  const session = await mongoose.startSession();
  let updated;
  try {
    await session.withTransaction(async () => {
      const user = await User.findById(request.params.id).session(session);
      if (!user) throw httpError(404, "User not found.");
      if (!canManageAccount(request.authUser, user)) {
        throw httpError(403, "You cannot manage this account.");
      }
      await ensureSuperAdminRemains(user, user.roles, status, session);
      const previousStatus = user.status;
      if (user.status !== status) user.sessionVersion += 1;
      user.status = status;
      user.suspensionReason = status === "Suspended" ? reason : undefined;
      await user.save({ session });
      await synchronizeRoleClaims(user, session);
      if (previousStatus !== status) {
        await audit.recordAudit({
          request,
          eventType: "account.status_changed",
          outcome: "success",
          target: user,
          details: { from: previousStatus, to: status },
          transaction: session,
        });
      }
      updated = user;
    });
    return response.json({ user: toPublicUser(updated) });
  } catch (error) {
    if (handleDuplicate(error, response)) return;
    if (error.statusCode) return response.status(error.statusCode).json({ error: error.message });
    throw error;
  } finally {
    await session.endSession();
  }
}

async function resetUserPassword(request, response) {
  if (!validateUserId(request.params.id)) {
    return response.status(400).json({ error: "Invalid user id." });
  }

  const temporaryPassword = Array.from(
    { length: TEMPORARY_PASSWORD_LENGTH },
    () => TEMPORARY_PASSWORD_CHARACTERS[
      crypto.randomInt(TEMPORARY_PASSWORD_CHARACTERS.length)
    ],
  ).join("");
  const expiresAt = new Date(Date.now() + TEMPORARY_PASSWORD_LIFETIME_MS);
  const transaction = await mongoose.startSession();
  let user;
  try {
    await transaction.withTransaction(async () => {
      user = await User.findById(request.params.id).session(transaction);
      if (!user) throw httpError(404, "User not found.");
      if (!canManageAccount(request.authUser, user)) {
        throw httpError(403, "You cannot manage this account.");
      }
      user.password = temporaryPassword;
      user.mustChangePassword = true;
      user.temporaryPasswordExpiresAt = expiresAt;
      user.sessionVersion += 1;
      await user.save({ session: transaction });
      await audit.recordAudit({
        request,
        eventType: "account.password_reset",
        outcome: "success",
        target: user,
        details: { resetExpiresAt: expiresAt.toISOString() },
        transaction,
      });
    });
  } catch (error) {
    if (error.statusCode) return response.status(error.statusCode).json({ error: error.message });
    throw error;
  } finally {
    await transaction.endSession();
  }

  return response.json({
    temporaryPassword,
    expiresAt: expiresAt.toISOString(),
    message: "Temporary password created. It expires in 24 hours and must be changed at next sign-in.",
  });
}

module.exports = {
  createUser,
  listUsers,
  resetUserPassword,
  updateUser,
  updateUserStatus,
};
