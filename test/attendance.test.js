const assert = require("node:assert/strict");
const { test } = require("node:test");
const mongoose = require("mongoose");
const AttendancePeriod = require("../models/attendancePeriod");
const AttendanceRecord = require("../models/attendanceRecord");
const Employee = require("../models/employee");
const audit = require("../lib/audit");
const attendanceRouter = require("../routes/attendance");
const {
  getMonthRange,
  listAttendance,
  saveDailyAttendance,
  validateAttendanceBatch,
} = require("../controllers/attendanceController");

const employeeId = "507f1f77bcf86cd799439011";

test("attendance schema enforces one record per employee and work date", () => {
  const record = new AttendanceRecord({
    employeeId,
    workDate: "2026-10-19",
    status: "Present",
    createdBy: "507f1f77bcf86cd799439012",
    updatedBy: "507f1f77bcf86cd799439012",
  });
  assert.equal(record.status, "Present");
  assert.equal(record.halfDay, false);
  assert.equal(record.late, false);
  assert.equal(record.validateSync(), undefined);
  assert.ok(AttendanceRecord.schema.indexes().some(([keys, options]) =>
    keys.employeeId === 1 && keys.workDate === 1 && options.unique === true,
  ));
  assert.equal(AttendanceRecord.schema.path("employeeId").options.ref, "Employee");
  assert.equal(AttendanceRecord.schema.path("updatedBy").options.ref, "User");
});

test("attendance month range validates calendar months and returns date-only bounds", () => {
  assert.deepEqual(getMonthRange("2026-02"), {
    from: "2026-02-01",
    to: "2026-02-28",
  });
  assert.equal(getMonthRange("2026-13"), null);
  assert.equal(getMonthRange("2026-2"), null);
});

test("daily attendance validation accepts supported records and rejects invalid data", () => {
  const valid = validateAttendanceBatch({
    entries: [{
      employeeId,
      status: "Present",
      halfDay: true,
      late: true,
      note: "  Arrived after opening  ",
    }],
  }, "2026-10-19");
  assert.equal(valid.error, undefined);
  assert.equal(valid.value[0].note, "Arrived after opening");

  assert.match(validateAttendanceBatch({ entries: [] }, "2026-10-19").error, /between 1 and/);
  assert.match(validateAttendanceBatch({ entries: [{ employeeId, status: "Absent", halfDay: true, late: false }] }, "2026-10-19").error, /only be set for Present/);
  assert.match(validateAttendanceBatch({ entries: [{ employeeId, status: "Present", halfDay: false, late: false }, { employeeId, status: "Absent", halfDay: false, late: false }] }, "2026-10-19").error, /only once/);
  assert.match(validateAttendanceBatch({ entries: [{ employeeId, status: "Present", halfDay: false, late: false, note: "x".repeat(301) }] }, "2026-10-19").error, /300 characters/);
  assert.match(validateAttendanceBatch({ entries: [{ employeeId, status: "Unmarked", halfDay: false, late: false, extra: true }] }, "2026-10-19").error, /unsupported fields/);
  assert.match(validateAttendanceBatch({ entries: [] }, "2026-02-30").error, /valid YYYY-MM-DD/);
});

test("daily attendance validation rejects non-object payloads and invalid employee ids", () => {
  assert.match(validateAttendanceBatch([], "2026-10-19").error, /request shape/);
  assert.match(validateAttendanceBatch({ entries: [{ employeeId: "not-an-id", status: "Absent", halfDay: false, late: false }] }, "2026-10-19").error, /valid employee/);
  assert.equal(mongoose.isValidObjectId(employeeId), true);
});

test("monthly attendance listing applies a date and employee filter", async () => {
  const originalFind = AttendanceRecord.find;
  let filter;
  AttendanceRecord.find = (value) => {
    filter = value;
    return {
      sort() { return this; },
      limit() { return this; },
      lean: async () => [{
        _id: new mongoose.Types.ObjectId(),
        employeeId: new mongoose.Types.ObjectId(employeeId),
        workDate: "2026-10-19",
        status: "Present",
        halfDay: false,
        late: true,
        note: "Late",
        updatedAt: new Date("2026-10-19T08:00:00.000Z"),
      }],
    };
  };
  try {
    const response = { json(body) { this.body = body; return this; } };
    await listAttendance({ query: { month: "2026-10", employeeId } }, response);
    assert.deepEqual(filter, {
      workDate: { $gte: "2026-10-01", $lte: "2026-10-31" },
      employeeId,
    });
    assert.equal(response.body.records.length, 1);
    assert.equal(response.body.records[0].employeeId, employeeId);
    assert.equal(response.body.records[0].status, "Present");
  } finally {
    AttendanceRecord.find = originalFind;
  }
});

test("daily attendance saves are retry-safe, preserve existing employee records, and audit changes", async () => {
  const originalEmployeeFind = Employee.find;
  const originalPeriodFindOne = AttendancePeriod.findOne;
  const originalAttendanceFind = AttendanceRecord.find;
  const originalBulkWrite = AttendanceRecord.bulkWrite;
  const originalAudit = audit.recordAudit;
  const originalStartSession = mongoose.startSession;
  const stored = [];
  const operations = [];
  const events = [];
  AttendancePeriod.findOne = () => ({
    session() { return this; },
    lean: async () => null,
  });
  Employee.find = () => ({
    select() { return this; },
    session() { return this; },
    lean: async () => [{ _id: new mongoose.Types.ObjectId(employeeId), status: "Active" }],
  });
  AttendanceRecord.bulkWrite = async (items) => {
    operations.push(...items);
    for (const operation of items) {
      const update = operation.updateOne;
      const existing = stored.find((item) =>
        item.employeeId === String(update.filter.employeeId)
        && item.workDate === update.filter.workDate,
      );
      const value = { ...update.update.$set, employeeId: String(update.filter.employeeId) };
      if (existing) Object.assign(existing, value);
      else stored.push({ _id: new mongoose.Types.ObjectId(), ...value });
    }
  };
  AttendanceRecord.find = (filter) => ({
    session() { return this; },
    lean: async () => filter.workDate
      ? stored.filter((record) => record.workDate === filter.workDate)
      : [],
    sort() { return this; },
  });
  audit.recordAudit = async (event) => events.push(event);
  mongoose.startSession = async () => ({
    withTransaction: async (callback) => callback(),
    endSession: async () => {},
  });
  try {
    const response = {
      status() { return this; },
      json(body) { this.body = body; return this; },
    };
    await saveDailyAttendance({
      params: { workDate: "2026-10-19" },
      body: { entries: [{ employeeId, status: "Present", halfDay: false, late: true, note: "Late arrival" }] },
      authUser: { _id: "507f1f77bcf86cd799439012" },
    }, response);
    assert.equal(response.body.records.length, 1);
    assert.equal(response.body.records[0].status, "Present");
    assert.equal(events[0].eventType, "attendance.recorded");
    assert.equal(events[0].details.note, undefined);
    assert.deepEqual(events[0].details.changedFields, ["status", "halfDay", "late", "note"]);
    assert.ok(events[0].transaction);
    assert.equal(operations.length, 1);
    await saveDailyAttendance({
      params: { workDate: "2026-10-19" },
      body: { entries: [{ employeeId, status: "Present", halfDay: false, late: true, note: "Late arrival" }] },
      authUser: { _id: "507f1f77bcf86cd799439012" },
    }, response);
    assert.equal(operations.length, 1);
    assert.equal(events.length, 1);
  } finally {
    Employee.find = originalEmployeeFind;
    AttendancePeriod.findOne = originalPeriodFindOne;
    AttendanceRecord.find = originalAttendanceFind;
    AttendanceRecord.bulkWrite = originalBulkWrite;
    audit.recordAudit = originalAudit;
    mongoose.startSession = originalStartSession;
  }
});

test("saving Unmarked removes the employee's date record and audits the removal", async () => {
  const originalEmployeeFind = Employee.find;
  const originalPeriodFindOne = AttendancePeriod.findOne;
  const originalAttendanceFind = AttendanceRecord.find;
  const originalBulkWrite = AttendanceRecord.bulkWrite;
  const originalAudit = audit.recordAudit;
  const originalStartSession = mongoose.startSession;
  const existing = {
    _id: new mongoose.Types.ObjectId(),
    employeeId: new mongoose.Types.ObjectId(employeeId),
    workDate: "2026-10-19",
    status: "Absent",
    halfDay: false,
    late: false,
    note: "",
  };
  const operations = [];
  const events = [];
  AttendancePeriod.findOne = () => ({
    session() { return this; },
    lean: async () => null,
  });
  let listCalls = 0;
  Employee.find = () => ({
    select() { return this; },
    session() { return this; },
    lean: async () => [{ _id: new mongoose.Types.ObjectId(employeeId), status: "Active" }],
  });
  AttendanceRecord.find = () => ({
    session() { return this; },
    lean: async () => {
      listCalls += 1;
      return listCalls === 1 ? [existing] : [];
    },
    sort() { return this; },
  });
  AttendanceRecord.bulkWrite = async (items) => operations.push(...items);
  audit.recordAudit = async (event) => events.push(event);
  mongoose.startSession = async () => ({
    withTransaction: async (callback) => callback(),
    endSession: async () => {},
  });
  try {
    const response = {
      status() { return this; },
      json(body) { this.body = body; return this; },
    };
    await saveDailyAttendance({
      params: { workDate: "2026-10-19" },
      body: { entries: [{ employeeId, status: "Unmarked", halfDay: false, late: false }] },
      authUser: { _id: "507f1f77bcf86cd799439012" },
    }, response);
    assert.equal(response.body.records.length, 0);
    assert.equal(operations.length, 1);
    assert.deepEqual(operations[0].deleteOne.filter, {
      employeeId,
      workDate: "2026-10-19",
    });
    assert.equal(events[0].eventType, "attendance.removed");
  } finally {
    Employee.find = originalEmployeeFind;
    AttendancePeriod.findOne = originalPeriodFindOne;
    AttendanceRecord.find = originalAttendanceFind;
    AttendanceRecord.bulkWrite = originalBulkWrite;
    audit.recordAudit = originalAudit;
    mongoose.startSession = originalStartSession;
  }
});

test("attendance writes are blocked inside a closed payroll period", async () => {
  const originalPeriodFindOne = AttendancePeriod.findOne;
  const originalStartSession = mongoose.startSession;
  AttendancePeriod.findOne = () => ({
    session() { return this; },
    lean: async () => ({ periodStart: "2026-10-01", periodEnd: "2026-10-31" }),
  });
  mongoose.startSession = async () => ({
    withTransaction: async (callback) => callback(),
    endSession: async () => {},
  });
  try {
    await assert.rejects(saveDailyAttendance({
      params: { workDate: "2026-10-19" },
      body: { entries: [{ employeeId, status: "Present", halfDay: false, late: false }] },
      authUser: { _id: "507f1f77bcf86cd799439012" },
    }, {}), (error) => error.statusCode === 409);
  } finally {
    AttendancePeriod.findOne = originalPeriodFindOne;
    mongoose.startSession = originalStartSession;
  }
});

test("attendance role middleware denies General Manager and unrelated roles", async () => {
  const originalAudit = audit.recordAudit;
  audit.recordAudit = async () => {};
  try {
    for (const role of ["General Manager", "Sales Manager"]) {
      let status;
      let body;
      let passed = false;
      await attendanceRouter.requireAttendanceRole(
        { authUser: { roles: [role], _id: "507f1f77bcf86cd799439012" }, baseUrl: "/api/attendance" },
        {
          status(value) { status = value; return this; },
          json(value) { body = value; return this; },
        },
        () => { passed = true; },
      );
      assert.equal(passed, false);
      assert.equal(status, 403);
      assert.match(body.error, /permission/);
    }
  } finally {
    audit.recordAudit = originalAudit;
  }
});

test("attendance role middleware allows HR, Admin, and Super Admin", async () => {
  for (const role of ["Human Resource", "Admin", "Super Admin"]) {
    let passed = false;
    await attendanceRouter.requireAttendanceRole(
      { authUser: { roles: [role] } },
      {},
      () => { passed = true; },
    );
    assert.equal(passed, true, role);
  }
});
