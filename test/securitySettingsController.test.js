const assert = require("node:assert/strict");
const { test } = require("node:test");
const mongoose = require("mongoose");
const SecuritySettings = require("../models/securitySettings");
const audit = require("../lib/audit");
const { updateSettings } = require("../controllers/securitySettingsController");

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

test("session policy update rejects unrecognized or missing fields", async () => {
  const response = createResponse();
  await updateSettings(
    { body: { privilegedIdle: 15, generalIdle: 30, warningPeriod: 2, mfaRequired: true } },
    response,
  );
  assert.equal(response.statusCode, 400);
  assert.equal(
    response.body.error,
    "Provide privilegedIdle, generalIdle, and warningPeriod.",
  );
});

test("session policy update rejects values outside supported limits", async () => {
  const response = createResponse();
  await updateSettings(
    { body: { privilegedIdle: 2, generalIdle: 30, warningPeriod: 2 } },
    response,
  );
  assert.equal(response.statusCode, 400);
  assert.equal(
    response.body.error,
    "privilegedIdle must be an integer between 5 and 240.",
  );
});

test("session policy update and its audit event share a transaction", async (t) => {
  const originals = {
    startSession: mongoose.startSession,
    update: SecuritySettings.findByIdAndUpdate,
    recordAudit: audit.recordAudit,
  };
  const transaction = {
    withTransaction: async (callback) => callback(),
    endSession: async () => {},
  };
  let recorded;
  mongoose.startSession = async () => transaction;
  SecuritySettings.findByIdAndUpdate = async (_id, _update, options) => {
    assert.equal(options.session, transaction);
    return {
      privilegedIdle: 10,
      generalIdle: 45,
      warningPeriod: 3,
      toObject() {
        return { privilegedIdle: 10, generalIdle: 45, warningPeriod: 3 };
      },
    };
  };
  audit.recordAudit = async (event) => {
    recorded = event;
  };
  t.after(() => {
    mongoose.startSession = originals.startSession;
    SecuritySettings.findByIdAndUpdate = originals.update;
    audit.recordAudit = originals.recordAudit;
  });

  const response = createResponse();
  await updateSettings(
    {
      body: { privilegedIdle: 10, generalIdle: 45, warningPeriod: 3 },
      authUser: { _id: "507f1f77bcf86cd799439011", roles: ["Super Admin"] },
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(recorded.eventType, "security.session_policy_updated");
  assert.equal(recorded.transaction, transaction);
  assert.deepEqual(recorded.details, { privilegedIdle: 10, generalIdle: 45, warningPeriod: 3 });
});
