const assert = require("node:assert/strict");
const { test } = require("node:test");
const Session = require("../models/session");
const { SESSION_SECONDS } = require("../lib/sessionConstants");
const { idleTimeoutMs, sessionDetails } = require("../lib/sessionPolicy");

test("session token hash is private and TTL cleanup uses absolute expiry", () => {
  assert.equal(Session.schema.path("tokenHash").options.select, false);
  const ttlIndex = Session.schema.indexes().find(([keys, options]) =>
    keys.expiresAt === 1 && options.expireAfterSeconds === 0,
  );
  assert.ok(ttlIndex);
  assert.equal(SESSION_SECONDS, 8 * 60 * 60);
});

test("session idle limits use privileged timeout for Super Admin and Admin", () => {
  const settings = { privilegedIdle: 15, generalIdle: 30, warningPeriod: 2 };
  assert.equal(idleTimeoutMs({ roles: ["Super Admin"] }, settings), 900_000);
  assert.equal(idleTimeoutMs({ roles: ["Admin"] }, settings), 900_000);
  assert.equal(idleTimeoutMs({ roles: ["Accountant"] }, settings), 1_800_000);
});

test("session details cap idle deadline at absolute expiry and warning within timeout", () => {
  const lastActivityAt = new Date("2026-01-01T00:00:00.000Z");
  const absoluteExpiresAt = new Date("2026-01-01T00:08:00.000Z");
  const details = sessionDetails(
    {
      _id: "session-id",
      userAgent: "Test browser",
      createdAt: lastActivityAt,
      lastActivityAt,
      absoluteExpiresAt,
    },
    { roles: ["Accountant"] },
    { privilegedIdle: 15, generalIdle: 15, warningPeriod: 10 },
    true,
  );
  assert.equal(details.idleExpiresAt, absoluteExpiresAt.toISOString());
  assert.equal(details.warningPeriodMs, 450_000);
  assert.equal(details.current, true);
});
