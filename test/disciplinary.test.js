const assert = require("node:assert/strict");
const { test } = require("node:test");
const mongoose = require("mongoose");
const DisciplinaryCase = require("../models/disciplinaryCase");
const DisciplinaryPolicy = require("../models/disciplinaryPolicy");
const User = require("../models/user");
const audit = require("../lib/audit");
const {
  DEFAULT_RESPONSE_RULES,
  computeIndicator,
  decideApproval,
  issueCase,
  submitForApproval,
  updateCase,
  validateCaseFields,
  validatePolicy,
} = require("../controllers/disciplinaryController");

const ids = {
  employee: "507f1f77bcf86cd799439011",
  hr: "507f1f77bcf86cd799439012",
  manager: "507f1f77bcf86cd799439013",
  admin: "507f1f77bcf86cd799439014",
};

function baseCase(overrides = {}) {
  return {
    employeeId: ids.employee,
    type: "Written warning",
    incidentDate: "2026-05-14",
    allegation: "The reported concern is being reviewed.",
    reason: "Describe the facts reviewed.",
    signatory: "HR",
    assignedApprovers: {
      humanResource: ids.hr,
      generalManager: ids.manager,
      superAdmin: ids.admin,
    },
    ...overrides,
  };
}

test("disciplinary case validation preserves type and requires distinct-stage approver assignments", () => {
  const valid = validateCaseFields(baseCase());
  assert.equal(valid.error, undefined);
  assert.equal(valid.value.type, "Written warning");
  assert.deepEqual(valid.value.assignedApprovers, {
    humanResource: ids.hr,
    generalManager: ids.manager,
    superAdmin: ids.admin,
  });

  assert.match(validateCaseFields(baseCase({ assignedApprovers: undefined })).error, /approvers/);
  assert.match(validateCaseFields(baseCase({
    assignedApprovers: {
      humanResource: ids.hr,
      generalManager: ids.hr,
      superAdmin: ids.admin,
    },
  })).error, /different accounts/);
  assert.match(validateCaseFields(baseCase({ incidentDate: "2026-02-30" })).error, /valid YYYY-MM-DD/);
});

test("disciplinary validation enforces type-specific date requirements", () => {
  assert.match(validateCaseFields(baseCase({
    type: "Suspension",
  })).error, /valid start and end date/);
  assert.equal(validateCaseFields(baseCase({
    type: "Suspension",
    suspensionStartDate: "2026-05-18",
    suspensionEndDate: "2026-05-20",
    returnDate: "2026-05-21",
  })).error, undefined);
  assert.match(validateCaseFields(baseCase({
    type: "Termination",
  })).error, /effective date/);
  assert.equal(validateCaseFields(baseCase({
    type: "Termination",
    effectiveDate: "2026-06-01",
  })).error, undefined);
});

test("response policy validation covers every letter type and bounds response windows", () => {
  const policy = validatePolicy({
    responseRules: {
      "Written warning": { required: true, responseWindowDays: 3 },
      Suspension: { required: false, responseWindowDays: 5 },
      Termination: { required: true, responseWindowDays: 10 },
    },
  });
  assert.equal(policy.error, undefined);
  assert.deepEqual(policy.value.responseRules.Suspension, {
    required: false,
    responseWindowDays: 5,
  });
  assert.deepEqual(Object.keys(DEFAULT_RESPONSE_RULES), [
    "Written warning",
    "Suspension",
    "Termination",
  ]);
  assert.match(validatePolicy({ responseRules: { "Written warning": { required: true, responseWindowDays: 0 } } }).error, /response rule/);
  assert.equal(new DisciplinaryPolicy().responseRules instanceof Map, true);
});

test("disciplinary case schema requires audit, employee, and all assigned approver fields", () => {
  const record = new DisciplinaryCase({
    ...baseCase(),
    reference: "DC-2026-TEST0001",
    employeeName: "Test Employee",
    employeeNumber: "EMP-001",
    department: "HR",
    role: "HR Officer",
    createdBy: ids.hr,
    updatedBy: ids.hr,
  });
  assert.equal(record.validateSync(), undefined);
  assert.equal(DisciplinaryCase.schema.options.optimisticConcurrency, true);
  assert.equal(DisciplinaryCase.schema.path("employeeId").options.ref, "Employee");
  assert.equal(DisciplinaryCase.schema.path("assignedApprovers.superAdmin").options.ref, "User");
  assert.equal(DisciplinaryCase.schema.path("reference").options.immutable, true);
});

test("employee indicators use issued status and inclusive effective date boundaries", () => {
  const today = "2026-05-14";
  assert.equal(computeIndicator({
    status: "Issued",
    type: "Written warning",
    reviewDate: today,
    reference: "DC-WARN",
  }, today).icon, "flag-outline");
  assert.equal(computeIndicator({
    status: "Issued",
    type: "Written warning",
    reviewDate: "2026-05-13",
    reference: "DC-EXPIRED",
  }, today), null);
  assert.equal(computeIndicator({
    status: "Issued",
    type: "Suspension",
    suspensionStartDate: today,
    suspensionEndDate: today,
    reference: "DC-SUSP",
  }, today).icon, "flag-filled");
  assert.equal(computeIndicator({
    status: "Issued",
    type: "Termination",
    effectiveDate: today,
    reference: "DC-TERM",
  }, today).icon, "user-x");
  assert.equal(computeIndicator({
    status: "Under investigation",
    type: "Termination",
    effectiveDate: today,
    reference: "DC-NOT-ISSUED",
  }, today), null);
  assert.equal(computeIndicator({
    status: "Issued",
    rescindedAt: new Date(),
    type: "Termination",
    effectiveDate: today,
    reference: "DC-RESCINDED",
  }, today), null);
});

test("disciplinary responses gate submission and approval proceeds through three assigned actors", async () => {
  const creatorId = "507f1f77bcf86cd799439015";
  const caseRecord = new DisciplinaryCase({
    ...baseCase(),
    reference: "DC-2026-WORKFLOW01",
    employeeName: "Test Employee",
    employeeNumber: "EMP-001",
    department: "Operations",
    role: "Operator",
    responseRequired: true,
    responseDueDate: "2026-06-30",
    createdBy: creatorId,
    updatedBy: creatorId,
  });
  caseRecord.save = async function save() { return this; };

  const originalStartSession = mongoose.startSession;
  const originalFindCase = DisciplinaryCase.findById;
  const originalFindUser = User.findOne;
  const originalRecordAudit = audit.recordAudit;
  const auditEvents = [];
  mongoose.startSession = async () => ({
    withTransaction: async (callback) => callback(),
    endSession: async () => {},
  });
  DisciplinaryCase.findById = async () => caseRecord;
  User.findOne = (query) => ({
    select: async () => ({ _id: query._id }),
  });
  audit.recordAudit = async (event) => auditEvents.push(event);

  function responseRecorder() {
    return {
      statusCode: 200,
      body: null,
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

  try {
    const hr = { _id: ids.hr, name: "HR Reviewer", roles: ["Human Resource"] };
    const gm = { _id: ids.manager, name: "General Manager", roles: ["General Manager"] };
    const director = { _id: ids.admin, name: "Director", roles: ["Super Admin"] };
    const hrRequest = { authUser: hr, params: { caseId: String(caseRecord._id) }, body: {} };

    let result = responseRecorder();
    await submitForApproval(hrRequest, result);
    assert.equal(result.statusCode, 409);
    assert.equal(caseRecord.status, "Draft");
    assert.equal(auditEvents.length, 0);

    caseRecord.responseRequired = false;
    result = responseRecorder();
    await submitForApproval(hrRequest, result);
    assert.equal(result.statusCode, 200);
    assert.equal(caseRecord.status, "Pending Human Resource approval");
    assert.equal(caseRecord.approvalRound, 1);

    result = responseRecorder();
    await decideApproval({
      authUser: gm,
      params: { caseId: String(caseRecord._id) },
      body: { decision: "Approved" },
    }, result);
    assert.equal(result.statusCode, 403);
    assert.equal(caseRecord.approvals.length, 0);

    result = responseRecorder();
    await decideApproval({
      authUser: hr,
      params: { caseId: String(caseRecord._id) },
      body: { decision: "Approved" },
    }, result);
    assert.equal(result.statusCode, 200);
    assert.equal(caseRecord.status, "Pending General Manager approval");

    result = responseRecorder();
    await decideApproval({
      authUser: gm,
      params: { caseId: String(caseRecord._id) },
      body: { decision: "Approved" },
    }, result);
    assert.equal(result.statusCode, 200);
    assert.equal(caseRecord.status, "Pending Super Admin approval");

    result = responseRecorder();
    await decideApproval({
      authUser: director,
      params: { caseId: String(caseRecord._id) },
      body: { decision: "Approved" },
    }, result);
    assert.equal(result.statusCode, 200);
    assert.equal(caseRecord.status, "Approved");
    assert.deepEqual(caseRecord.approvals.map((entry) => entry.stage), [
      "Human Resource",
      "General Manager",
      "Super Admin",
    ]);
    assert.equal(new Set(caseRecord.approvals.map((entry) => String(entry.actorId))).size, 3);
    caseRecord.evidence.push({
      name: "evidence.pdf",
      url: "https://private.example/evidence",
      publicId: "private-public-id",
      resourceType: "raw",
      mediaType: "application/pdf",
      sizeBytes: 5,
      uploadedBy: ids.hr,
    });

    result = responseRecorder();
    await issueCase(hrRequest, result);
    assert.equal(result.statusCode, 200);
    assert.equal(caseRecord.status, "Issued");
    assert.equal(caseRecord.issuedLetterVersion, caseRecord.letterVersion);
    assert.equal("url" in result.body.case.evidence[0], false);
    assert.equal("publicId" in result.body.case.evidence[0], false);

    const issuedReason = caseRecord.reason;
    result = responseRecorder();
    await updateCase({
      authUser: hr,
      params: { caseId: String(caseRecord._id) },
      body: { reason: "Attempted post-issue edit." },
    }, result);
    assert.equal(result.statusCode, 409);
    assert.equal(caseRecord.reason, issuedReason);

    assert.equal(auditEvents.length, 6);
    assert.ok(auditEvents.filter((event) => event.outcome === "success")
      .every((event) => event.transaction));
  } finally {
    mongoose.startSession = originalStartSession;
    DisciplinaryCase.findById = originalFindCase;
    User.findOne = originalFindUser;
    audit.recordAudit = originalRecordAudit;
  }
});
