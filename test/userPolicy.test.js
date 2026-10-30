const assert = require("node:assert/strict");
const test = require("node:test");
const User = require("../models/user");
const { toPublicUser } = require("../lib/userDto");
const {
  normalizeEmail,
  validateCredentials,
  validateRoles,
  EXCLUSIVE_ROLES,
  canAssignRoles,
  canManageAccount,
  creatableRolesForAccountManager,
} = require("../lib/userPolicy");

test("normalizes account email addresses", () => {
  assert.equal(normalizeEmail("  Admin@Example.COM "), "admin@example.com");
});

test("validates user credentials and enforces initial password length", () => {
  assert.equal(
    validateCredentials({
      name: "  Ada Lovelace ",
      email: " ADA@example.com ",
      password: "a-secure-password",
    }).value.email,
    "ada@example.com",
  );
  assert.equal(
    validateCredentials({ name: "Ada", email: "ada@example.com", password: "short" }).error,
    "Password must be at least 8 characters.",
  );
  assert.equal(
    validateCredentials({ name: "Ada", email: "ada@example.com", password: "a".repeat(73) }).error,
    "Password must be no more than 72 UTF-8 bytes.",
  );
  assert.equal(
    validateCredentials({ name: "Ada", email: "ada@example.com", password: "é".repeat(37) }).error,
    "Password must be no more than 72 UTF-8 bytes.",
  );
  assert.equal(
    validateCredentials({ name: "Ada", email: "not-an-email" }, { requirePassword: false }).error,
    "Enter a valid email address.",
  );
});

test("accepts only non-empty, known, distinct roles", () => {
  assert.equal(validateRoles(["Admin", "Sales Manager"]).error, "Admin must be assigned as the account's only role.");
  assert.equal(validateRoles([]).error, "Assign at least one role.");
  assert.equal(validateRoles(["Admin", "Admin"]).error, "Duplicate roles are not allowed.");
  assert.equal(validateRoles(["Unknown"]).error, "One or more assigned roles are invalid.");
});

test("only HR and Inventory Manager are single-user roles", () => {
  assert.deepEqual(EXCLUSIVE_ROLES, ["Human Resource", "Inventory Manager"]);
  assert.equal(validateRoles(["Human Resource", "Sales Manager"]).error, undefined);
  assert.equal(validateRoles(["Sales Manager", "Marketing Manager"]).error, undefined);
});

test("account managers receive only their permitted creation roles", () => {
  assert.deepEqual(
    creatableRolesForAccountManager({ roles: ["Super Admin"] }),
    ["Admin", "General Manager"],
  );
  assert.deepEqual(
    creatableRolesForAccountManager({ roles: ["General Manager"] }),
    ["Human Resource"],
  );
  assert.ok(
    creatableRolesForAccountManager({ roles: ["Human Resource"] })
      .includes("Sales Manager"),
  );
  assert.deepEqual(creatableRolesForAccountManager({ roles: ["Accountant"] }), []);
});

test("account managers can manage only their permitted targets", () => {
  const superAdmin = { _id: "actor-sa", roles: ["Super Admin"] };
  const gm = { _id: "actor-gm", roles: ["General Manager"] };
  const hr = { _id: "actor-hr", roles: ["Human Resource"] };

  assert.equal(canManageAccount(superAdmin, { _id: "admin", roles: ["Admin"] }), true);
  assert.equal(canManageAccount(superAdmin, { _id: "sales", roles: ["Sales Manager"] }), false);
  assert.equal(canManageAccount(gm, { _id: "hr", roles: ["Human Resource"] }), true);
  assert.equal(canManageAccount(gm, { _id: "admin", roles: ["Admin"] }), false);
  assert.equal(canManageAccount(hr, { _id: "sales", roles: ["Sales Manager"] }), true);
  assert.equal(canManageAccount(hr, { _id: "gm", roles: ["General Manager"] }), false);
  assert.equal(canManageAccount(hr, hr), false);
  assert.equal(canManageAccount(hr, { _id: "multi", roles: ["Human Resource", "Sales Manager"] }), true);
  assert.equal(canAssignRoles(gm, ["Human Resource"]), true);
  assert.equal(canAssignRoles(gm, ["Sales Manager"]), false);
});

test("user model requires password and roles and does not select password by default", async () => {
  assert.equal(User.schema.path("password").options.select, false);
  assert.equal(User.schema.path("email").options.unique, true);
  assert.ok(User.schema.path("status").enumValues.includes("Deactivated"));

  const valid = new User({
    name: "Ada Lovelace",
    email: "ada@example.com",
    password: "initial-secret",
    roles: ["Super Admin"],
  });
  await valid.validate();
  assert.equal(valid.mustChangePassword, true);
  assert.equal(valid.sessionVersion, 0);

  const temporary = new User({
    name: "Temporary Password",
    email: "temporary@example.com",
    password: "Ab3xY7",
    mustChangePassword: true,
    temporaryPasswordExpiresAt: new Date(Date.now() + 60_000),
    roles: ["Admin"],
  });
  await temporary.validate();

  const shortPermanent = new User({
    name: "Short Permanent Password",
    email: "short@example.com",
    password: "Ab3xY7",
    mustChangePassword: false,
    roles: ["Admin"],
  });
  await assert.rejects(shortPermanent.validate());

  const invalid = new User({
    name: "Empty roles",
    email: "empty@example.com",
    password: "initial-secret",
    roles: [],
  });
  await assert.rejects(invalid.validate(), /Assign at least one distinct valid role/);
});

test("public account response omits credential fields and maps Mongo timestamps", () => {
  const response = toPublicUser({
    _id: { toString: () => "user-id" },
    name: "Ada Lovelace",
    email: "ada@example.com",
    password: "hashed-secret",
    sessionVersion: 4,
    roles: ["Super Admin"],
    status: "Active",
    mustChangePassword: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  });
  assert.equal(response.id, "user-id");
  assert.equal(response.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(response.mustChangePassword, true);
  assert.equal("password" in response, false);
  assert.equal("sessionVersion" in response, false);
});
