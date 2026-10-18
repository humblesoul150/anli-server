const assert = require("node:assert/strict");
const { test } = require("node:test");
const AuditEvent = require("../models/auditEvent");
const audit = require("../lib/audit");
const { listAccountEvents, listEvents, parseCursor } = require("../controllers/auditController");
const User = require("../models/user");
const { requireSuperAdmin } = require("../middleware/authentication");

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("audit schema indexes global, target, actor, and event timelines", () => {
  const indexes = AuditEvent.schema.indexes().map(([keys]) => keys);
  assert.ok(indexes.some((keys) => keys.createdAt === -1 && keys._id === -1));
  assert.ok(indexes.some((keys) => keys.targetUserId === 1 && keys.createdAt === -1));
  assert.ok(indexes.some((keys) => keys.actorId === 1 && keys.createdAt === -1));
  assert.ok(indexes.some((keys) => keys.eventType === 1 && keys.createdAt === -1));
});

test("audit writer snapshots actor/target, bounds request context, and removes credential fields", async () => {
  const originalCreate = AuditEvent.create;
  let inserted;
  AuditEvent.create = async (event) => {
    inserted = event;
  };

  try {
    await audit.recordAudit({
      request: {
        ip: "192.0.2.5",
        body: { password: "request-password", temporaryPassword: "request-temp-pass" },
        get: (name) => name === "user-agent" ? "Browser" : undefined,
      },
      eventType: "account.password_reset",
      outcome: "success",
      actor: { _id: "507f1f77bcf86cd799439011", name: "Admin", email: "admin@example.com", roles: ["Super Admin"] },
      target: { _id: "507f1f77bcf86cd799439012", name: "User", email: "user@example.com", roles: ["Accountant"] },
      details: {
        changedFields: ["password"],
        temporaryPassword: "secret",
        token: "raw-session-token",
        expiryHours: 24,
      },
    });

    assert.equal(String(inserted.actorId), "507f1f77bcf86cd799439011");
    assert.equal(String(inserted.targetUserId), "507f1f77bcf86cd799439012");
    assert.equal(inserted.ipAddress, "192.0.2.5");
    assert.deepEqual(inserted.details, { changedFields: ["password"], expiryHours: 24 });
    assert.doesNotMatch(JSON.stringify(inserted), /secret|raw-session-token|request-password|request-temp-pass/);
    assert.deepEqual(
      audit.safeDetails({ authorization: "Bearer secret", nested: { cookie: "secret", keep: "safe" } }),
      { nested: { keep: "safe" } },
    );
  } finally {
    AuditEvent.create = originalCreate;
  }
});

test("audit list validates filters and uses descending cursor pagination", async () => {
  const originalFind = AuditEvent.find;
  let query;
  const createdAt = new Date("2026-10-18T08:00:00.000Z");
  AuditEvent.find = (filter) => {
    query = filter;
    return {
      sort(sortOrder) {
        assert.deepEqual(sortOrder, { createdAt: -1, _id: -1 });
        return this;
      },
      limit(limit) {
        assert.equal(limit, 2);
        return this;
      },
      lean: async () => [
        {
          _id: "507f1f77bcf86cd799439021",
          eventType: "auth.login.failed",
          outcome: "failure",
          actorId: null,
          targetUserId: null,
          sessionId: null,
          details: {},
          createdAt,
        },
        {
          _id: "507f1f77bcf86cd799439022",
          eventType: "auth.logout",
          outcome: "success",
          actorId: null,
          targetUserId: null,
          sessionId: null,
          details: {},
          createdAt,
        },
      ],
    };
  };

  try {
    const request = {
      query: {
        eventType: "auth.login.failed",
        outcome: "failure",
        actorId: "507f1f77bcf86cd799439011",
        from: "2026-10-01T00:00:00.000Z",
        to: "2026-10-31T23:59:59.999Z",
        limit: "1",
      },
    };
    const response = createResponse();
    await listEvents(request, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.events.length, 1);
    assert.ok(response.body.nextCursor);
    assert.ok(query.$and.some((condition) => condition.eventType === "auth.login.failed"));
    assert.ok(query.$and.some((condition) => condition.outcome === "failure"));
    assert.ok(query.$and.some((condition) => condition.actorId === request.query.actorId));
    assert.equal(
      query.$and.find((condition) => condition.createdAt).createdAt.$lte.toISOString(),
      "2026-10-31T23:59:59.999Z",
    );
    assert.ok(parseCursor(response.body.nextCursor));

    const invalid = createResponse();
    await listEvents({ query: { limit: "101" } }, invalid);
    assert.equal(invalid.statusCode, 400);
  } finally {
    AuditEvent.find = originalFind;
  }
});

test("per-account audit endpoint fixes target to route user id", async () => {
  const originalFind = AuditEvent.find;
  const originalExists = User.exists;
  let query;
  User.exists = async () => true;
  AuditEvent.find = (filter) => {
    query = filter;
    return {
      sort() { return this; },
      limit() { return this; },
      lean: async () => [],
    };
  };
  try {
    const response = createResponse();
    await listAccountEvents(
      {
        params: { userId: "507f1f77bcf86cd799439011" },
        query: { targetUserId: "507f1f77bcf86cd799439012" },
      },
      response,
    );
    assert.equal(response.statusCode, 200);
    assert.ok(query.$and.some((condition) => condition.targetUserId === "507f1f77bcf86cd799439011"));
  } finally {
    AuditEvent.find = originalFind;
    User.exists = originalExists;
  }
});

test("denied privileged access is audited with the actor and a safe reason", async () => {
  const originalAudit = audit.recordAudit;
  let recorded;
  audit.recordAudit = async (event) => {
    recorded = event;
  };
  try {
    const response = createResponse();
    await requireSuperAdmin(
      {
        authUser: {
          _id: "507f1f77bcf86cd799439011",
          name: "Staff User",
          roles: ["Accountant"],
        },
        baseUrl: "/api/audit",
      },
      response,
      () => assert.fail("Denied user must not reach the next handler."),
    );
    assert.equal(response.statusCode, 403);
    assert.equal(recorded.eventType, "security.authorization_denied");
    assert.equal(recorded.reason, "super_admin_required");
    assert.equal(recorded.actor.name, "Staff User");
  } finally {
    audit.recordAudit = originalAudit;
  }
});
