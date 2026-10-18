const assert = require("node:assert/strict");
const { test } = require("node:test");
const mongoose = require("mongoose");
const Session = require("../models/session");
const User = require("../models/user");
const audit = require("../lib/audit");
const { revokeSession } = require("../controllers/sessionController");

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
    end() {
      return this;
    },
  };
}

test("users cannot revoke another user's session", async () => {
  const originalFindOne = Session.findOne;
  let saved = false;
  Session.findOne = async () => ({
    userId: "507f1f77bcf86cd799439012",
    revokedAt: null,
    save: async () => {
      saved = true;
    },
  });

  try {
    const response = createResponse();
    await revokeSession(
      {
        params: { sessionId: "507f1f77bcf86cd799439011" },
        authUser: {
          _id: "507f1f77bcf86cd799439013",
          roles: ["Accountant"],
        },
      },
      response,
    );
    assert.equal(response.statusCode, 403);
    assert.equal(saved, false);
  } finally {
    Session.findOne = originalFindOne;
  }
});

test("Super Admin can revoke another user's session", async (t) => {
  const originalFindOne = Session.findOne;
  const originalFindOneAndUpdate = Session.findOneAndUpdate;
  const originalFindById = User.findById;
  const originalStartSession = mongoose.startSession;
  const originalAudit = audit.recordAudit;
  const transaction = {
    withTransaction: async (callback) => callback(),
    endSession: async () => {},
  };
  audit.recordAudit = async () => {};
  mongoose.startSession = async () => transaction;
  t.after(() => {
    audit.recordAudit = originalAudit;
    User.findById = originalFindById;
    Session.findOneAndUpdate = originalFindOneAndUpdate;
    mongoose.startSession = originalStartSession;
  });
  User.findById = () => ({
    session: async () => ({
      _id: "507f1f77bcf86cd799439012",
      name: "Target",
      email: "target@example.com",
      roles: ["Accountant"],
    }),
  });
  let revocationUpdate;
  Session.findOne = async () => ({
    userId: "507f1f77bcf86cd799439012",
    revokedAt: null,
    save: async function save() {
      savedSession = this;
    },
  });
  Session.findOneAndUpdate = async (_query, _update, options) => {
    assert.equal(options.session, transaction);
    revocationUpdate = _update;
    return { _id: "507f1f77bcf86cd799439011" };
  };

  try {
    const response = createResponse();
    await revokeSession(
      {
        params: { sessionId: "507f1f77bcf86cd799439011" },
        authUser: {
          _id: "507f1f77bcf86cd799439013",
          roles: ["Super Admin"],
        },
      },
      response,
    );
    assert.equal(response.statusCode, 204);
    assert.ok(revocationUpdate.$set.revokedAt instanceof Date);
  } finally {
    Session.findOne = originalFindOne;
  }
});
