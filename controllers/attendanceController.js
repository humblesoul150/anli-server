const mongoose = require("mongoose");
const AttendanceRecord = require("../models/attendanceRecord");
const Employee = require("../models/employee");
const audit = require("../lib/audit");

const MAX_MONTH_RECORDS = 20000;
const MAX_BATCH_SIZE = 500;

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  if (Number(value.slice(0, 4)) < 1900) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function getMonthRange(month) {
  if (typeof month !== "string" || !/^\d{4}-\d{2}$/.test(month)) return null;
  const [year, monthNumber] = month.split("-").map(Number);
  if (year < 1900 || monthNumber < 1 || monthNumber > 12) return null;
  const from = `${month}-01`;
  const to = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  return { from, to };
}

function validateAttendanceBatch(body, workDate) {
  if (!isValidDate(workDate)) return { error: "workDate must be a valid YYYY-MM-DD date." };
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "entries")) {
    return { error: "Provide attendance entries in the supported request shape." };
  }
  if (!Array.isArray(body.entries) || body.entries.length < 1 || body.entries.length > MAX_BATCH_SIZE) {
    return { error: `Provide between 1 and ${MAX_BATCH_SIZE} attendance entries.` };
  }

  const seen = new Set();
  const entries = [];
  for (const item of body.entries) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { error: "Each attendance entry must be an object." };
    }
    const allowed = new Set(["employeeId", "status", "halfDay", "late", "note"]);
    if (Object.keys(item).some((key) => !allowed.has(key))) {
      return { error: "Attendance entry contains unsupported fields." };
    }
    if (typeof item.employeeId !== "string" || !mongoose.isValidObjectId(item.employeeId)) {
      return { error: "Each attendance entry must reference a valid employee." };
    }
    const employeeId = String(new mongoose.Types.ObjectId(item.employeeId));
    if (seen.has(employeeId)) return { error: "An employee may appear only once per daily attendance batch." };
    seen.add(employeeId);
    if (!["Present", "Absent", "On leave", "Unmarked"].includes(item.status)) {
      return { error: "Attendance status is invalid." };
    }
    if (typeof item.halfDay !== "boolean" || typeof item.late !== "boolean") {
      return { error: "halfDay and late must be true or false." };
    }
    if (item.status !== "Present" && (item.halfDay || item.late)) {
      return { error: "Half-day and late flags can only be set for Present attendance." };
    }
    if (item.note !== undefined && (typeof item.note !== "string" || item.note.trim().length > 300)) {
      return { error: "Attendance notes must be text of 300 characters or fewer." };
    }
    entries.push({
      employeeId,
      status: item.status,
      halfDay: item.halfDay,
      late: item.late,
      note: item.note?.trim() || "",
    });
  }
  return { value: entries };
}

async function listAttendance(request, response) {
  const range = getMonthRange(request.query.month);
  if (!range) return response.status(400).json({ error: "month must be a valid YYYY-MM month." });
  if (request.query.employeeId && !mongoose.isValidObjectId(request.query.employeeId)) {
    return response.status(400).json({ error: "employeeId is invalid." });
  }

  const filter = {
    workDate: { $gte: range.from, $lte: range.to },
    ...(request.query.employeeId ? { employeeId: request.query.employeeId } : {}),
  };
  const records = await AttendanceRecord.find(filter)
    .sort({ workDate: 1, employeeId: 1 })
    .limit(MAX_MONTH_RECORDS + 1)
    .lean();
  if (records.length > MAX_MONTH_RECORDS) {
    return response.status(413).json({ error: "This attendance month is too large to load in one request." });
  }
  return response.json({
    records: records.map((record) => ({
      id: String(record._id),
      employeeId: String(record.employeeId),
      workDate: record.workDate,
      status: record.status,
      halfDay: record.halfDay,
      late: record.late,
      note: record.note || "",
      updatedAt: record.updatedAt,
    })),
  });
}

function changedFields(existing, entry) {
  if (!existing) return ["status", "halfDay", "late", "note"];
  return [
    ...(existing.status !== entry.status ? ["status"] : []),
    ...(existing.halfDay !== entry.halfDay ? ["halfDay"] : []),
    ...(existing.late !== entry.late ? ["late"] : []),
    ...((existing.note || "") !== entry.note ? ["note"] : []),
  ];
}

async function persistDailyAttendance(request, entries, session) {
  const employeeIds = entries.map((entry) => entry.employeeId);
  const employees = await Employee.find({ _id: { $in: employeeIds } })
    .select("_id status")
    .session(session)
    .lean();
  const employeeMap = new Map(employees.map((employee) => [String(employee._id), employee]));
  const missing = employeeIds.find((id) => !employeeMap.has(id));
  if (missing) {
    const error = new Error("Attendance references an employee that does not exist.");
    error.statusCode = 400;
    throw error;
  }

  const existingRecords = await AttendanceRecord.find({
    employeeId: { $in: employeeIds },
    workDate: request.params.workDate,
  }).session(session).lean();
  const existingMap = new Map(existingRecords.map((record) => [String(record.employeeId), record]));
  const inactiveWithoutHistory = entries.find((entry) =>
    entry.status !== "Unmarked"
    && employeeMap.get(entry.employeeId).status !== "Active"
    && !existingMap.has(entry.employeeId),
  );
  if (inactiveWithoutHistory) {
    const error = new Error("New attendance can only be recorded for active employees.");
    error.statusCode = 400;
    throw error;
  }

  const operations = [];
  const auditChanges = [];
  for (const entry of entries) {
    const existing = existingMap.get(entry.employeeId);
    if (entry.status === "Unmarked") {
      if (existing) {
        operations.push({ deleteOne: { filter: { employeeId: entry.employeeId, workDate: request.params.workDate } } });
        auditChanges.push({
          entry,
          existing,
          changedFields: ["record"],
          eventType: "attendance.removed",
        });
      }
      continue;
    }
    const changes = changedFields(existing, entry);
    if (existing && changes.length === 0) continue;
    const next = { ...entry, workDate: request.params.workDate };
    operations.push({
      updateOne: {
        filter: { employeeId: entry.employeeId, workDate: request.params.workDate },
        update: {
          $set: { ...next, updatedBy: request.authUser._id },
          $setOnInsert: { createdBy: request.authUser._id },
        },
        upsert: true,
      },
    });
    auditChanges.push({
      entry,
      existing,
      changedFields: changes,
      eventType: existing ? "attendance.updated" : "attendance.recorded",
    });
  }

  if (operations.length) {
    await AttendanceRecord.bulkWrite(operations, { ordered: true, session });
  }
  for (const change of auditChanges) {
    await audit.recordAudit({
      request,
      eventType: change.eventType,
      outcome: "success",
      details: {
        attendanceId: change.existing ? String(change.existing._id) : undefined,
        employeeId: change.entry.employeeId,
        workDate: request.params.workDate,
        previousStatus: change.existing?.status,
        status: change.entry.status === "Unmarked" ? undefined : change.entry.status,
        previousHalfDay: change.existing?.halfDay,
        halfDay: change.entry.status === "Unmarked" ? undefined : change.entry.halfDay,
        previousLate: change.existing?.late,
        late: change.entry.status === "Unmarked" ? undefined : change.entry.late,
        changedFields: change.changedFields,
      },
      transaction: session,
    });
  }

  const records = await AttendanceRecord.find({
    employeeId: { $in: employeeIds },
    workDate: request.params.workDate,
  }).session(session).sort({ employeeId: 1 }).lean();
  return records.map((record) => ({
      id: String(record._id),
      employeeId: String(record.employeeId),
      workDate: record.workDate,
      status: record.status,
      halfDay: record.halfDay,
      late: record.late,
      note: record.note || "",
      updatedAt: record.updatedAt,
    }));
}

async function saveDailyAttendance(request, response) {
  const { value: entries, error } = validateAttendanceBatch(request.body, request.params.workDate);
  if (error) return response.status(400).json({ error });

  let records;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        records = await persistDailyAttendance(request, entries, session);
      });
      break;
    } catch (transactionError) {
      if (transactionError?.code !== 11000 || attempt > 0) throw transactionError;
    } finally {
      await session.endSession();
    }
  }
  return response.json({ records });
}

module.exports = {
  getMonthRange,
  listAttendance,
  saveDailyAttendance,
  validateAttendanceBatch,
};
