const assert = require("node:assert/strict");
const { test } = require("node:test");
const SecuritySettings = require("../models/securitySettings");
const {
  PERMISSION_CAPABILITIES,
  SECURITY_AREAS,
  SECURITY_ROLES,
} = require("../models/securitySettings");

test("security settings schema matches the client protection controls", async () => {
  const settings = new SecuritySettings();
  await settings.validate();

  assert.deepEqual(
    {
      lockoutEnabled: settings.lockoutEnabled,
      maxAttempts: settings.maxAttempts,
      attemptWindow: settings.attemptWindow,
      lockDuration: settings.lockDuration,
      privilegedIdle: settings.privilegedIdle,
      generalIdle: settings.generalIdle,
      warningPeriod: settings.warningPeriod,
      mfaRequired: settings.mfaRequired,
      notifyLockouts: settings.notifyLockouts,
    },
    {
      lockoutEnabled: true,
      maxAttempts: 5,
      attemptWindow: 15,
      lockDuration: 15,
      privilegedIdle: 15,
      generalIdle: 30,
      warningPeriod: 2,
      mfaRequired: true,
      notifyLockouts: true,
    },
  );
});

test("permissions use the client role-area-capability shape in one Mixed field", () => {
  assert.equal(SecuritySettings.schema.path("permissions").instance, "Mixed");
  assert.deepEqual(
    Object.keys(SecuritySettings.schema.paths).filter((path) =>
      path.startsWith("permissions."),
    ),
    [],
  );

  const settings = new SecuritySettings();
  assert.deepEqual(Object.keys(settings.permissions), SECURITY_ROLES);
  for (const role of SECURITY_ROLES) {
    assert.deepEqual(Object.keys(settings.permissions[role]), SECURITY_AREAS);
    for (const area of SECURITY_AREAS) {
      assert.deepEqual(
        Object.keys(settings.permissions[role][area]),
        PERMISSION_CAPABILITIES,
      );
    }
  }

  assert.equal(settings.permissions["Super Admin"]["User Management"].delete, true);
  assert.equal(settings.permissions.Admin["User Management"].view, true);
  assert.equal(settings.permissions["General Manager"]["User Management"].view, true);
  assert.equal(settings.permissions["General Manager"]["User Management"].edit, false);
  assert.equal(settings.permissions.Accountant["User Management"].view, false);
});

test("security settings schema validates numeric Protection ranges", async () => {
  const settings = new SecuritySettings({ maxAttempts: 2 });
  await assert.rejects(settings.validate());
});
