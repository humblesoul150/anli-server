const { USER_ROLES } = require("../models/user");

const EXCLUSIVE_ROLES = ["Human Resource", "Inventory Manager"];
const MAX_PASSWORD_BYTES = 72;

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function validateCredentials({ name, email, password }, { requirePassword = true } = {}) {
  const normalizedName = String(name || "").trim();
  const normalizedEmail = normalizeEmail(email);
  const normalizedPassword = password == null ? "" : String(password);

  if (!normalizedName || normalizedName.length > 120) {
    return { error: "Enter a name of 1 to 120 characters." };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254) {
    return { error: "Enter a valid email address." };
  }
  if (requirePassword && normalizedPassword.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }
  if (requirePassword && Buffer.byteLength(normalizedPassword, "utf8") > MAX_PASSWORD_BYTES) {
    return { error: "Password must be no more than 72 UTF-8 bytes." };
  }
  return {
    value: {
      name: normalizedName,
      email: normalizedEmail,
      ...(password == null ? {} : { password: normalizedPassword }),
    },
  };
}

function validateRoles(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: "Assign at least one role." };
  }
  if (value.some((role) => !USER_ROLES.includes(role))) {
    return { error: "One or more assigned roles are invalid." };
  }
  const roles = [...new Set(value)];
  if (roles.length !== value.length) {
    return { error: "Duplicate roles are not allowed." };
  }
  if (roles.includes("Admin") && roles.length !== 1) {
    return { error: "Admin must be assigned as the account's only role." };
  }
  return { value: roles };
}

function hasRole(user, role) {
  return Boolean(user?.roles?.includes(role));
}

function canAccessUserManagement(user) {
  return ["Super Admin", "General Manager", "Human Resource"].some(
    (role) => hasRole(user, role),
  );
}

function creatableRolesForAccountManager(user) {
  if (hasRole(user, "Super Admin")) return ["Admin", "General Manager"];
  if (hasRole(user, "General Manager")) return ["Human Resource"];
  if (hasRole(user, "Human Resource")) {
    return [
      "Human Resource",
      "Marketing Manager",
      "Sales Manager",
      "Production Manager",
      "Inventory Manager",
      "Accountant",
    ];
  }
  return [];
}

function canManageAccount(actor, target) {
  if (!actor || !target || String(actor._id || actor.id) === String(target._id || target.id)) {
    return false;
  }
  const targetRoles = target.roles || [];
  if (targetRoles.length === 0) return false;

  if (hasRole(actor, "Super Admin")) {
    return targetRoles.length > 0
      && targetRoles.every((role) => ["Admin", "General Manager"].includes(role));
  }
  if (hasRole(actor, "General Manager")) {
    return targetRoles.length === 1 && targetRoles.includes("Human Resource");
  }
  if (hasRole(actor, "Human Resource")) {
    return targetRoles.every((role) =>
      !["Super Admin", "Admin", "General Manager"].includes(role),
    );
  }
  return false;
}

function canAssignRoles(actor, roles) {
  const allowedRoles = creatableRolesForAccountManager(actor);
  return roles.length > 0 && roles.every((role) => allowedRoles.includes(role));
}

module.exports = {
  EXCLUSIVE_ROLES,
  MAX_PASSWORD_BYTES,
  canAccessUserManagement,
  canAssignRoles,
  canManageAccount,
  creatableRolesForAccountManager,
  normalizeEmail,
  validateCredentials,
  validateRoles,
};
