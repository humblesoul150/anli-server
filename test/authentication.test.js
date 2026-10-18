const assert = require("node:assert/strict");
const { test } = require("node:test");
const Session = require("../models/session");
const User = require("../models/user");
const SecuritySettings = require("../models/securitySettings");
const { cacheSecuritySettings } = require("../lib/securitySettings");
const { hashSessionToken } = require("../lib/sessionTokens");
const audit = require("../lib/audit");
const { authenticate } = require("../middleware/authentication");

function createRequest(token) {
  return {
    get(name) {
      if (name === "cookie") return `anli_session=${token}`;
      return undefined;
    },
    app: { locals: { config: { isProduction: false } } },
  };
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
  };
}

test("authentication resolves the opaque cookie to a valid server-side session", async () => {
  const originals = {
    findOne: Session.findOne,
    findById: User.findById,
    settingsFindById: SecuritySettings.findById,
  };
  const token = "test-session-token";
  const user = {
    _id: "507f1f77bcf86cd799439011",
    status: "Active",
    sessionVersion: 2,
    roles: ["Accountant"],
  };
  const session = {
    _id: "session-id",
    userId: user._id,
    revokedAt: null,
    sessionVersion: 2,
    lastActivityAt: new Date(),
    absoluteExpiresAt: new Date(Date.now() + 60_000),
  };
  Session.findOne = async (query) => {
    assert.equal(query.tokenHash, hashSessionToken(token));
    return session;
  };
  User.findById = async () => user;
  cacheSecuritySettings({ privilegedIdle: 15, generalIdle: 30, warningPeriod: 2 });

  try {
    const request = createRequest(token);
    const response = createResponse();
    let nextCalled = false;
    await authenticate(request, response, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.equal(request.authUser, user);
    assert.equal(request.authSession, session);
    assert.equal(request.authSessionToken, token);
    assert.equal(response.statusCode, 200);
  } finally {
    Session.findOne = originals.findOne;
    User.findById = originals.findById;
    SecuritySettings.findById = originals.settingsFindById;
  }
});

test("authentication revokes an idle session and rejects it", async (t) => {
  const originals = {
    findOne: Session.findOne,
    updateOne: Session.updateOne,
    findById: User.findById,
    settingsFindById: SecuritySettings.findById,
  };
  const token = "idle-session-token";
  let revoked = false;
  let recordedEvent;
  const originalAudit = audit.recordAudit;
  audit.recordAudit = async (event) => {
    recordedEvent = event;
  };
  t.after(() => {
    audit.recordAudit = originalAudit;
  });
  Session.findOne = async () => ({
    _id: "session-id",
    userId: "507f1f77bcf86cd799439011",
    revokedAt: null,
    sessionVersion: 2,
    lastActivityAt: new Date(Date.now() - 31 * 60_000),
    absoluteExpiresAt: new Date(Date.now() + 60_000),
  });
  Session.updateOne = async () => {
    revoked = true;
    return { modifiedCount: 1 };
  };
  User.findById = async () => ({
    status: "Active",
    sessionVersion: 2,
    roles: ["Accountant"],
  });
  cacheSecuritySettings({ privilegedIdle: 15, generalIdle: 30, warningPeriod: 2 });

  try {
    const response = createResponse();
    let nextCalled = false;
    await authenticate(createRequest(token), response, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(revoked, true);
    assert.equal(response.statusCode, 401);
    assert.equal(response.body.code, "SESSION_IDLE_EXPIRED");
    assert.equal(recordedEvent.eventType, "session.idle_expired");
    assert.equal(recordedEvent.reason, "idle_timeout");
  } finally {
    Session.findOne = originals.findOne;
    Session.updateOne = originals.updateOne;
    User.findById = originals.findById;
    SecuritySettings.findById = originals.settingsFindById;
  }
});
