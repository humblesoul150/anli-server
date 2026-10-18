const mongoose = require("mongoose");

const SECURITY_ROLES = [
  "Super Admin",
  "Admin",
  "General Manager",
  "Human Resource",
  "Marketing Manager",
  "Sales Manager",
  "Production Manager",
  "Inventory Manager",
  "Accountant",
];

const SECURITY_AREAS = [
  "User Management",
  "Company Profile",
  "Sales & orders",
  "Customer records",
  "HR & payroll",
  "Expenses & finance",
  "Inventory & production",
  "Company assets",
  "Data backup",
];

const PERMISSION_CAPABILITIES = ["view", "create", "edit", "delete"];

function createDefaultPermissions() {
  return Object.fromEntries(
    SECURITY_ROLES.map((role) => [
      role,
      Object.fromEntries(
        SECURITY_AREAS.map((area) => [
          area,
          Object.fromEntries(
            PERMISSION_CAPABILITIES.map((capability) => [
              capability,
              capability === "view"
                ? ["Super Admin", "Admin", "General Manager"].includes(role)
                : capability === "delete"
                  ? role === "Super Admin"
                  : ["Super Admin", "Admin"].includes(role),
            ]),
          ),
        ]),
      ),
    ]),
  );
}

const securitySettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "global" },
    lockoutEnabled: { type: Boolean, default: true },
    maxAttempts: { type: Number, min: 3, max: 20, default: 5 },
    attemptWindow: { type: Number, min: 1, max: 120, default: 15 },
    lockDuration: { type: Number, min: 1, max: 1440, default: 15 },
    privilegedIdle: { type: Number, min: 5, max: 240, default: 15 },
    generalIdle: { type: Number, min: 5, max: 480, default: 30 },
    warningPeriod: { type: Number, min: 1, max: 10, default: 2 },
    mfaRequired: { type: Boolean, default: true },
    notifyLockouts: { type: Boolean, default: true },
    permissions: {
      type: mongoose.Schema.Types.Mixed,
      default: createDefaultPermissions,
    },
  },
  { timestamps: true },
);

const SecuritySettings =
  mongoose.models.SecuritySettings ||
  mongoose.model("SecuritySettings", securitySettingsSchema);

module.exports = SecuritySettings;
module.exports.SECURITY_ROLES = SECURITY_ROLES;
module.exports.SECURITY_AREAS = SECURITY_AREAS;
module.exports.PERMISSION_CAPABILITIES = PERMISSION_CAPABILITIES;
module.exports.createDefaultPermissions = createDefaultPermissions;
