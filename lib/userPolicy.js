const { USER_ROLES } = require("../models/user");

const EXCLUSIVE_ROLES = USER_ROLES.filter((role) => role !== "Admin");
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
  return { value: roles };
}

module.exports = {
  EXCLUSIVE_ROLES,
  MAX_PASSWORD_BYTES,
  normalizeEmail,
  validateCredentials,
  validateRoles,
};
