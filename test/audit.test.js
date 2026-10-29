const assert = require("node:assert/strict");
const { test } = require("node:test");
const AuditEvent = require("../models/auditEvent");
const audit = require("../lib/audit");
const notificationAuditBridge = require("../lib/notificationAuditBridge");
const {
  listAccountEvents,
  listEventTypes,
  listEvents,
  parseCursor,
} = require("../controllers/auditController");
const User = require("../models/user");
const { requireSuperAdmin } = require("../middleware/authentication");
const { captureAuthenticatedActivity } = require("../middleware/auditReads");
const { EventEmitter } = require("node:events");

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
  assert.ok(indexes.some((keys) => keys["resource.type"] === 1 && keys.createdAt === -1));
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
    assert.equal(inserted.resource.type, "account");
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

test("notification enqueue failure is reported without failing audit persistence", async () => {
  const originalCreate = AuditEvent.create;
  const originalEnqueue = notificationAuditBridge.enqueueFromAudit;
  const originalConsoleError = console.error;
  let inserted;
  const logged = [];
  AuditEvent.create = async (event) => { inserted = event; };
  notificationAuditBridge.enqueueFromAudit = async () => {
    throw new Error("outbox unavailable");
  };
  console.error = (...args) => logged.push(args);
  try {
    await audit.recordAudit({
      eventType: "order.created",
      outcome: "success",
      details: { orderId: "507f1f77bcf86cd799439099" },
    });
    assert.equal(inserted.eventType, "order.created");
    assert.equal(inserted.resource.id, "507f1f77bcf86cd799439099");
    assert.equal(logged[0][0], "Audit notification enqueue failed:");
  } finally {
    AuditEvent.create = originalCreate;
    notificationAuditBridge.enqueueFromAudit = originalEnqueue;
    console.error = originalConsoleError;
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
          category: "auth",
          outcome: "failure",
          actorId: null,
          targetUserId: null,
          sessionId: null,
          resource: { type: "auth", id: "session-record" },
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
        category: "auth",
        outcome: "failure",
        actorId: "507f1f77bcf86cd799439011",
        resourceType: "raw_material",
        from: "2026-10-01T00:00:00.000Z",
        to: "2026-10-31T23:59:59.999Z",
        limit: "1",
      },
    };
    const response = createResponse();
    await listEvents(request, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.events.length, 1);
    assert.deepEqual(response.body.events[0].resource, {
      type: "auth",
      id: "session-record",
      reference: undefined,
    });
    assert.ok(response.body.nextCursor);
    assert.ok(query.$and.some((condition) => condition.eventType === "auth.login.failed"));
    assert.ok(query.$and.some((condition) => condition.eventType?.test?.("auth.login.succeeded")));
    assert.ok(query.$and.some((condition) => condition.outcome === "failure"));
    assert.ok(query.$and.some((condition) => condition.actorId === request.query.actorId));
    assert.ok(query.$and.some((condition) => condition["resource.type"] === "raw_material"));
    assert.equal(
      query.$and.find((condition) => condition.createdAt).createdAt.$lte.toISOString(),
      "2026-10-31T23:59:59.999Z",
    );
    assert.ok(parseCursor(response.body.nextCursor));

    const invalid = createResponse();
    await listEvents({ query: { limit: "101" } }, invalid);
    assert.equal(invalid.statusCode, 400);

    const invalidResourceType = createResponse();
    await listEvents({ query: { resourceType: "admin@example.com" } }, invalidResourceType);
    assert.equal(invalidResourceType.statusCode, 400);

    const invalidCategory = createResponse();
    await listEvents({ query: { category: "admin@example.com" } }, invalidCategory);
    assert.equal(invalidCategory.statusCode, 400);
  } finally {
    AuditEvent.find = originalFind;
  }
});

test("audit list filters grouped categories with the same server cursor", async () => {
  const originalFind = AuditEvent.find;
  let query;
  AuditEvent.find = (filter) => {
    query = filter;
    return {
      sort() { return this; },
      limit() { return this; },
      lean: async () => [],
    };
  };

  try {
    const cursor = Buffer.from(JSON.stringify({
      createdAt: "2026-10-18T08:00:00.000Z",
      id: "507f1f77bcf86cd799439021",
    })).toString("base64url");
    const response = createResponse();
    await listEvents({ query: { categories: "sale,credit,receipt", cursor } }, response);

    assert.equal(response.statusCode, 200);
    const categoryCondition = query.$and.find((condition) => condition.$or);
    assert.equal(categoryCondition.$or.length, 3);
    assert.ok(categoryCondition.$or[0].eventType.test("sale.created"));
    assert.ok(categoryCondition.$or[1].eventType.test("credit.sale_updated"));
    assert.ok(categoryCondition.$or[2].eventType.test("receipt.archived"));
    assert.ok(!categoryCondition.$or[0].eventType.test("data.read.succeeded"));
    assert.ok(query.$and.some((condition) => condition.$or?.some((part) => part._id)));

    const invalid = createResponse();
    await listEvents({ query: { categories: "sale,unknown" } }, invalid);
    assert.equal(invalid.statusCode, 400);
  } finally {
    AuditEvent.find = originalFind;
  }
});

test("audit list ignores Express next callback when called as a route handler", async () => {
  const originalFind = AuditEvent.find;
  let query;
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
    await listEvents({ query: {} }, response, () => {});

    assert.equal(response.statusCode, 200);
    assert.deepEqual(query, {});
    assert.deepEqual(response.body, { events: [], nextCursor: null });
  } finally {
    AuditEvent.find = originalFind;
  }
});

test("audit event catalog exposes the complete event and resource filters", async () => {
  const response = createResponse();
  await listEventTypes({}, response);
  assert.ok(response.body.eventTypes.includes("data.read.succeeded"));
  assert.ok(response.body.eventTypes.includes("order.fulfilled"));
  assert.ok(response.body.eventTypes.includes("credit.sale_updated"));
  assert.ok(response.body.eventTypes.includes("credit.reminder_settings_updated"));
  assert.ok(response.body.resourceTypes.includes("raw_material"));
  assert.ok(response.body.categories.includes("inventory"));
});

test("authenticated activity is audited with route templates, resource IDs, and response outcomes", async () => {
  const originalAudit = audit.recordAudit;
  const recorded = [];
  audit.recordAudit = async (entry) => recorded.push(entry);
  try {
    const request = {
      method: "GET",
      baseUrl: "/api/employees",
      route: { path: "/:id" },
      params: { id: "EMP-001" },
      authUser: { _id: "507f1f77bcf86cd799439011", name: "HR", roles: ["Human Resource"] },
    };
    const response = new EventEmitter();
    response.statusCode = 200;
    captureAuthenticatedActivity(request, response, () => {});
    response.emit("finish");
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].eventType, "data.read.succeeded");
    assert.deepEqual(recorded[0].resource, { type: "employees", id: "EMP-001" });
    assert.deepEqual(recorded[0].details, {
      method: "GET",
      route: "/api/employees/:id",
      statusCode: 200,
    });

    const userRead = new EventEmitter();
    userRead.statusCode = 200;
    captureAuthenticatedActivity({
      ...request,
      baseUrl: "/api/users",
      route: { path: "/:id" },
      params: { id: "507f1f77bcf86cd799439012" },
    }, userRead, () => {});
    userRead.emit("finish");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(recorded[1].resource.type, "users");
    assert.equal(recorded[1].targetUserIdOverride, "507f1f77bcf86cd799439012");

    const denied = new EventEmitter();
    denied.statusCode = 403;
    captureAuthenticatedActivity({
      ...request,
      route: { path: "/" },
      params: {},
    }, denied, () => {});
    denied.emit("finish");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(recorded[2].eventType, "data.read.denied");
    assert.equal(recorded[2].reason, "http_403");

    const writeResponse = new EventEmitter();
    writeResponse.statusCode = 201;
    captureAuthenticatedActivity({
      ...request,
      method: "POST",
      baseUrl: "/api/orders",
      route: { path: "/" },
      params: {},
    }, writeResponse, () => {});
    writeResponse.emit("finish");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(recorded[3].eventType, "data.write.succeeded");
    assert.equal(recorded[3].resource.type, "orders");

    const failedWrite = new EventEmitter();
    failedWrite.statusCode = 400;
    captureAuthenticatedActivity({
      ...request,
      method: "PUT",
      baseUrl: "/api/employees",
      route: { path: "/:id" },
      params: { id: "EMP-001" },
    }, failedWrite, () => {});
    failedWrite.emit("finish");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(recorded[4].eventType, "data.write.failed");
    assert.equal(recorded[4].outcome, "failure");
    assert.ok(AuditEvent.AUDIT_EVENT_TYPES.includes(recorded[4].eventType));

    const failedRead = new EventEmitter();
    failedRead.statusCode = 500;
    captureAuthenticatedActivity({
      ...request,
      route: { path: "/:id" },
      params: { id: "EMP-001" },
    }, failedRead, () => {});
    failedRead.emit("finish");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(recorded[5].eventType, "data.read.failed");
    assert.equal(recorded[5].outcome, "failure");
    assert.ok(AuditEvent.AUDIT_EVENT_TYPES.includes(recorded[5].eventType));
  } finally {
    audit.recordAudit = originalAudit;
  }
});

test("unauthenticated reads and activity/notification acknowledgements are excluded", async () => {
  const originalAudit = audit.recordAudit;
  let calls = 0;
  audit.recordAudit = async () => { calls += 1; };
  try {
    const response = new EventEmitter();
    response.statusCode = 200;
    captureAuthenticatedActivity({ method: "GET", baseUrl: "/api/users" }, response, () => {});
    response.emit("finish");
    captureAuthenticatedActivity({
      method: "POST",
      baseUrl: "/api/sessions",
      route: { path: "/activity" },
      authUser: { _id: "user" },
    }, response, () => {});
    captureAuthenticatedActivity({
      method: "PATCH",
      baseUrl: "/api/notifications",
      route: { path: "/:id/read" },
      authUser: { _id: "user" },
    }, response, () => {});
    captureAuthenticatedActivity({ method: "OPTIONS", authUser: { _id: "user" } }, response, () => {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 0);
  } finally {
    audit.recordAudit = originalAudit;
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

test("audit resource references are bounded and reject values that look like personal data", () => {
  assert.deepEqual(audit.safeResource({ type: "order", id: "ORD-2026-01" }), {
    type: "order",
    id: "ORD-2026-01",
  });
  assert.throws(
    () => audit.safeResource({ type: "users", id: "admin@example.com" }),
    /resource id is invalid/,
  );
});
