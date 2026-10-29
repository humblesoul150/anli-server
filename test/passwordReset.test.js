const assert = require("node:assert/strict");
const { test } = require("node:test");
const mongoose = require("mongoose");
const audit = require("../lib/audit");
const { changePassword, login, logout } = require("../controllers/authController");
const User = require("../models/user");
const SecuritySettings = require("../models/securitySettings");
const { resetUserPassword } = require("../controllers/userController");
const Session = require("../models/session");
const AuditEvent = require("../models/auditEvent");

function stubAudit(testContext) {
  const original = audit.recordAudit;
  audit.recordAudit = async () => {};
  testContext.after(() => {
    audit.recordAudit = original;
  });
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

test("reset creates a random 24-hour temporary password and invalidates sessions", async (t) => {
  const originalFindById = User.findById;
  const originalStartSession = mongoose.startSession;
  const originalAuditCreate = AuditEvent.create;
  let recordedAudit;
  let auditOptions;
  AuditEvent.create = async (events, options) => {
    recordedAudit = Array.isArray(events) ? events[0] : events;
    auditOptions = options;
  };
  t.after(() => {
    AuditEvent.create = originalAuditCreate;
  });
  const transaction = {
    withTransaction: async (callback) => callback(),
    endSession: async () => {},
  };
  mongoose.startSession = async () => transaction;
  const user = {
    _id: "507f1f77bcf86cd799439011",
    name: "Account User",
    email: "user@example.com",
    roles: ["Admin"],
    status: "Suspended",
    sessionVersion: 3,
    save: async () => {},
  };
  User.findById = () => ({ session: async () => user });

  try {
    const response = createResponse();
    await resetUserPassword(
      {
        authUser: { _id: "actor-super-admin", roles: ["Super Admin"] },
        params: { id: user._id },
      },
      response,
    );

    assert.equal(response.statusCode, 200);
    assert.match(response.body.temporaryPassword, /^[A-Za-z2-9]{6}$/);
    assert.doesNotMatch(response.body.temporaryPassword, /[ILOilo01]/);
    assert.equal(Buffer.byteLength(response.body.temporaryPassword, "utf8"), 6);
    assert.equal(user.mustChangePassword, true);
    assert.equal(user.sessionVersion, 4);
    assert.equal(user.status, "Suspended");
    assert.deepEqual(user.roles, ["Admin"]);
    assert.equal(recordedAudit.eventType, "account.password_reset");
    assert.equal(auditOptions.session, transaction);
    assert.equal(recordedAudit.details.resetExpiresAt, response.body.expiresAt);
    assert.equal(JSON.stringify(recordedAudit).includes(response.body.temporaryPassword), false);
    assert.equal(
      new Date(response.body.expiresAt).getTime() - Date.now() > 86_390_000,
      true,
    );
    assert.equal(
      new Date(response.body.expiresAt).getTime() - Date.now() <= 86_400_000,
      true,
    );
  } finally {
    User.findById = originalFindById;
    mongoose.startSession = originalStartSession;
  }
});

test("suspended accounts get a contact-admin message only with the correct password", async (t) => {
  stubAudit(t);
  const originalFindOne = User.findOne;
  let passwordMatches = true;
  User.findOne = () => ({
    select: async () => ({
      status: "Suspended",
      comparePassword: async () => passwordMatches,
    }),
  });

  try {
    const suspendedResponse = createResponse();
    await login(
      {
        body: { email: "user@example.com", password: "correct-password" },
        app: { locals: { config: { jwtSecret: "test-secret" } } },
      },
      suspendedResponse,
    );
    assert.equal(suspendedResponse.statusCode, 403);
    assert.equal(suspendedResponse.body.code, "ACCOUNT_SUSPENDED");
    assert.match(suspendedResponse.body.error, /contact an administrator/i);

    passwordMatches = false;
    const incorrectResponse = createResponse();
    await login(
      {
        body: { email: "user@example.com", password: "wrong-password" },
        app: { locals: { config: { jwtSecret: "test-secret" } } },
      },
      incorrectResponse,
    );
    assert.equal(incorrectResponse.statusCode, 401);
    assert.equal(incorrectResponse.body.error, "The email or password is incorrect.");
  } finally {
    User.findOne = originalFindOne;
  }
});

test("unknown-account sign-in failures are audited without storing submitted email", async (t) => {
  const originalFindOne = User.findOne;
  const originalCreate = AuditEvent.create;
  let recorded;
  User.findOne = () => ({ select: async () => null });
  AuditEvent.create = async (event) => {
    recorded = event;
  };
  t.after(() => {
    User.findOne = originalFindOne;
    AuditEvent.create = originalCreate;
  });

  const response = createResponse();
  await login(
    {
      body: { email: "unknown@example.com", password: "incorrect-password" },
      app: { locals: { config: { isProduction: false } } },
    },
    response,
  );

  assert.equal(response.statusCode, 401);
  assert.equal(recorded.eventType, "auth.login.failed");
  assert.equal(recorded.reason, "invalid_credentials");
  assert.equal(recorded.targetUserId, null);
  assert.doesNotMatch(JSON.stringify(recorded), /unknown@example\.com|incorrect-password/);
});

test("reset rejects invalid user ids without looking up an account", async () => {
  const originalFindById = User.findById;
  User.findById = () => {
    throw new Error("Unexpected account lookup");
  };

  try {
    const response = createResponse();
    await resetUserPassword({ params: { id: "invalid" } }, response);
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error, "Invalid user id.");
  } finally {
    User.findById = originalFindById;
  }
});

test("login rejects an expired temporary password", async (t) => {
  stubAudit(t);
  const originalFindOne = User.findOne;
  User.findOne = () => ({
    select: async () => ({
      status: "Active",
      mustChangePassword: true,
      temporaryPasswordExpiresAt: new Date(Date.now() - 1),
      comparePassword: async () => true,
    }),
  });

  try {
    const response = createResponse();
    await login(
      {
        body: { email: "user@example.com", password: "temporary-password" },
        app: { locals: { config: { jwtSecret: "test-secret" } } },
      },
      response,
    );
    assert.equal(response.statusCode, 401);
    assert.equal(response.body.code, "TEMPORARY_PASSWORD_EXPIRED");
  } finally {
    User.findOne = originalFindOne;
  }
});

test("successful password change clears temporary expiry and renews the session", async (t) => {
  stubAudit(t);
  const originalFindById = User.findById;
  const originalSessionFindById = Session.findById;
  const originalStartSession = mongoose.startSession;
  const originalSettingsFindById = SecuritySettings.findById;
  const transaction = {
    withTransaction: async (callback) => callback(),
    endSession: async () => {},
  };
  mongoose.startSession = async () => transaction;
  const session = {
    _id: "session-id",
    createdAt: new Date(),
    absoluteExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    lastActivityAt: new Date(),
    userAgent: "Test browser",
    save: async () => {},
  };
  const user = {
    _id: "507f1f77bcf86cd799439011",
    email: "user@example.com",
    name: "Account User",
    roles: ["Admin"],
    status: "Active",
    mustChangePassword: true,
    temporaryPasswordExpiresAt: new Date(Date.now() + 60_000),
    sessionVersion: 4,
    comparePassword: async () => true,
    save: async () => {},
  };
  User.findById = () => ({ select: () => ({ session: async () => user }) });
  Session.findById = () => ({ session: async () => session });
  SecuritySettings.findById = () => ({
    lean: async () => ({ privilegedIdle: 15, generalIdle: 30, warningPeriod: 2 }),
  });

  try {
    const response = createResponse();
    await changePassword(
      {
        body: { currentPassword: "temporary-password", newPassword: "a-new-password" },
        authUser: { _id: user._id },
        authSession: session,
        authSessionToken: "opaque-session-token",
        app: { locals: { config: { jwtSecret: "test-secret", isProduction: false } } },
      },
      response,
    );

    assert.equal(response.statusCode, 200);
    assert.equal(user.mustChangePassword, false);
    assert.equal(user.temporaryPasswordExpiresAt, undefined);
    assert.equal(user.sessionVersion, 5);
    assert.match(response.headers["Set-Cookie"], /anli_session=/);
    assert.equal(session.sessionVersion, 5);
    assert.equal(response.body.session.id, "session-id");
  } finally {
    User.findById = originalFindById;
    Session.findById = originalSessionFindById;
    mongoose.startSession = originalStartSession;
    SecuritySettings.findById = originalSettingsFindById;
  }
});

test("logout revokes its session and records the event in the same transaction", async (t) => {
  const originals = {
    startSession: mongoose.startSession,
    sessionFindOne: Session.findOne,
    userFindById: User.findById,
    auditCreate: AuditEvent.create,
  };
  const transaction = {
    withTransaction: async (callback) => callback(),
    endSession: async () => {},
  };
  const token = "opaque-token-never-audited";
  const session = {
    _id: "507f1f77bcf86cd799439013",
    userId: "507f1f77bcf86cd799439012",
    revokedAt: null,
    save: async () => {},
  };
  const user = {
    _id: session.userId,
    name: "Account User",
    email: "user@example.com",
    roles: ["Admin"],
  };
  let storedEvent;
  let writeOptions;
  mongoose.startSession = async () => transaction;
  Session.findOne = () => ({ session: async () => session });
  User.findById = () => ({ session: async () => user });
  AuditEvent.create = async (events, options) => {
    storedEvent = Array.isArray(events) ? events[0] : events;
    writeOptions = options;
  };
  t.after(() => {
    mongoose.startSession = originals.startSession;
    Session.findOne = originals.sessionFindOne;
    User.findById = originals.userFindById;
    AuditEvent.create = originals.auditCreate;
  });

  const response = createResponse();
  await logout(
    {
      get: (name) => name === "cookie" ? `anli_session=${token}` : undefined,
      app: { locals: { config: { isProduction: false } } },
    },
    response,
  );

  assert.equal(response.statusCode, 204);
  assert.equal(response.ended, true);
  assert.ok(session.revokedAt instanceof Date);
  assert.equal(storedEvent.eventType, "auth.logout");
  assert.equal(String(storedEvent.targetUserId), user._id);
  assert.equal(writeOptions.session, transaction);
  assert.equal(JSON.stringify(storedEvent).includes(token), false);
});
