const mongoose = require("mongoose");
const crypto = require("node:crypto");
const Employee = require("../models/employee");
const LegacyLeaveArchive = require("../models/legacyLeaveArchive");
const LeavePolicy = require("../models/leavePolicy");
const LeaveRequest = require("../models/leaveRequest");
const User = require("../models/user");
const audit = require("../lib/audit");
const { hasAnyDepartmentRole } = require("../lib/authorization");
const {
  DEFAULT_POLICY,
  addDays,
  addBusinessDays,
  calculateWorkingDays,
  expectedReturnDate,
  getReminderCandidates,
  isValidDate,
  leaveYearBounds,
} = require("../lib/leavePolicy");

const ADMIN_ROLES = ["Super Admin", "Admin", "Human Resource"];
const REQUEST_TYPES = ["Annual", "Sick", "Maternity/Paternity", "Compassionate", "Other"];
function hasRole(user, roles = ADMIN_ROLES) {
  return hasAnyDepartmentRole(user, roles);
}

async function denyLeaveAdmin(request, response, resource, message) {
  if (hasRole(request.authUser)) return false;
  await audit.recordAudit({
    request,
    eventType: "security.authorization_denied",
    outcome: "denied",
    reason: "leave_admin_required",
    details: { resource },
  });
  response.status(403).json({ error: message });
  return true;
}

function policyValue(policy) {
  if (!policy) return structuredClone(DEFAULT_POLICY);
  return {
    workingDays: policy.workingDays,
    holidays: policy.holidays,
    leaveYearStart: policy.leaveYearStart,
    entitlements: policy.entitlements instanceof Map
      ? Object.fromEntries(policy.entitlements)
      : policy.entitlements || {},
    carryoverEnabled: policy.carryoverEnabled,
    carryoverLimit: policy.carryoverLimit,
    reminderThresholds: policy.reminderThresholds,
  };
}

function validatePolicy(body) {
  const allowed = new Set([
    "workingDays",
    "holidays",
    "leaveYearStart",
    "entitlements",
    "carryoverEnabled",
    "carryoverLimit",
    "reminderThresholds",
  ]);
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some((key) => !allowed.has(key))) {
    return { error: "Provide leave policy fields in the supported request shape." };
  }
  const value = {};
  if ("workingDays" in body) {
    if (!Array.isArray(body.workingDays) || !body.workingDays.length
      || body.workingDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
      || new Set(body.workingDays).size !== body.workingDays.length) {
      return { error: "workingDays must contain distinct weekday numbers from 0 to 6." };
    }
    value.workingDays = body.workingDays;
  }
  if ("holidays" in body) {
    if (!Array.isArray(body.holidays) || body.holidays.length > 500
      || body.holidays.some((date) => !isValidDate(date))) {
      return { error: "holidays must contain valid YYYY-MM-DD dates (maximum 500)." };
    }
    value.holidays = [...new Set(body.holidays)].sort();
  }
  if ("leaveYearStart" in body) {
    if (typeof body.leaveYearStart !== "string" || !/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(body.leaveYearStart)
      || !isValidDate(`2000-${body.leaveYearStart}`)) {
      return { error: "leaveYearStart must be a valid MM-DD value." };
    }
    value.leaveYearStart = body.leaveYearStart;
  }
  if ("entitlements" in body) {
    if (!body.entitlements || typeof body.entitlements !== "object" || Array.isArray(body.entitlements)
      || Object.keys(body.entitlements).some((type) => !REQUEST_TYPES.includes(type))
      || Object.values(body.entitlements).some((days) => !Number.isFinite(days) || days < 0 || days > 366)) {
      return { error: "entitlements must map supported leave types to values from 0 to 366." };
    }
    value.entitlements = body.entitlements;
  }
  if ("carryoverEnabled" in body) {
    if (typeof body.carryoverEnabled !== "boolean") return { error: "carryoverEnabled must be true or false." };
    value.carryoverEnabled = body.carryoverEnabled;
  }
  if ("carryoverLimit" in body) {
    if (!Number.isInteger(body.carryoverLimit) || body.carryoverLimit < 0 || body.carryoverLimit > 366) {
      return { error: "carryoverLimit must be a whole number from 0 to 366." };
    }
    value.carryoverLimit = body.carryoverLimit;
  }
  if ("reminderThresholds" in body) {
    const thresholds = body.reminderThresholds;
    const thresholdKeys = new Set(["pendingApprovalBusinessDays", "beforeStartDays", "onStartDate", "returnFollowUp"]);
    if (!thresholds || typeof thresholds !== "object" || Array.isArray(thresholds)
      || Object.keys(thresholds).some((key) => !thresholdKeys.has(key))) {
      return { error: "reminderThresholds contains unsupported fields." };
    }
    if ("pendingApprovalBusinessDays" in thresholds
      && (!Number.isInteger(thresholds.pendingApprovalBusinessDays) || thresholds.pendingApprovalBusinessDays < 1 || thresholds.pendingApprovalBusinessDays > 60)) {
      return { error: "pendingApprovalBusinessDays must be a whole number from 1 to 60." };
    }
    if ("beforeStartDays" in thresholds
      && (!Array.isArray(thresholds.beforeStartDays) || thresholds.beforeStartDays.length > 10
        || thresholds.beforeStartDays.some((day) => !Number.isInteger(day) || day < 1 || day > 365)
        || new Set(thresholds.beforeStartDays).size !== thresholds.beforeStartDays.length)) {
      return { error: "beforeStartDays must contain distinct whole days from 1 to 365." };
    }
    if ("onStartDate" in thresholds && typeof thresholds.onStartDate !== "boolean") {
      return { error: "onStartDate must be true or false." };
    }
    if ("returnFollowUp" in thresholds && typeof thresholds.returnFollowUp !== "boolean") {
      return { error: "returnFollowUp must be true or false." };
    }
    value.reminderThresholds = { ...thresholds };
  }
  if (body.carryoverEnabled === false && body.carryoverLimit > 0) {
    return { error: "carryoverLimit must be zero when carryover is disabled." };
  }
  return { value };
}

function validateRequestInput(body) {
  const allowed = new Set([
    "employeeId",
    "leaveType",
    "otherLeaveType",
    "reason",
    "startDate",
    "endDate",
    "handoverEmployeeId",
    "handoverContact",
  ]);
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some((key) => !allowed.has(key))) {
    return { error: "Provide leave request fields in the supported request shape." };
  }
  if (typeof body.leaveType !== "string" || !REQUEST_TYPES.includes(body.leaveType)) {
    return { error: "Select a supported leave type." };
  }
  if (body.leaveType === "Other" && (typeof body.otherLeaveType !== "string" || !body.otherLeaveType.trim() || body.otherLeaveType.trim().length > 80)) {
    return { error: "Specify the other leave type in 80 characters or fewer." };
  }
  if (typeof body.reason !== "string" || !body.reason.trim() || body.reason.trim().length > 1000) {
    return { error: "Enter a reason of 1,000 characters or fewer." };
  }
  if (!isValidDate(body.startDate) || !isValidDate(body.endDate) || body.startDate > body.endDate) {
    return { error: "Provide a valid date range in YYYY-MM-DD format." };
  }
  if (typeof body.handoverEmployeeId !== "string" || !mongoose.isValidObjectId(body.handoverEmployeeId)) {
    return { error: "Select a valid handover employee." };
  }
  if (body.employeeId !== undefined && (typeof body.employeeId !== "string" || !mongoose.isValidObjectId(body.employeeId))) {
    return { error: "employeeId is invalid." };
  }
  if (body.handoverContact !== undefined && (typeof body.handoverContact !== "string" || body.handoverContact.trim().length > 80)) {
    return { error: "handoverContact must be 80 characters or fewer." };
  }
  return { value: body };
}

function validateLegacyLeave(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "Leave record must be an object." };
  }
  const employeeName = typeof value.employeeName === "string" ? value.employeeName.trim().slice(0, 180) : "";
  const leaveType = value.leaveType;
  const startDate = value.startDate;
  const endDate = value.endDate;
  const allowedStatuses = ["Pending", "Approved", "Rejected", "Cancelled"];
  if (!employeeName || !REQUEST_TYPES.includes(leaveType)
    || !isValidDate(startDate) || !isValidDate(endDate) || startDate > endDate) {
    return { error: "Employee name, leave type, and valid leave dates are required." };
  }
  const reason = typeof value.reason === "string" ? value.reason.trim().slice(0, 1000) : "";
  const requestedAt = value.requestedAt && !Number.isNaN(new Date(value.requestedAt).getTime())
    ? new Date(value.requestedAt)
    : undefined;
  return {
    value: {
      legacyId: String(value.id || value._id || "").trim().slice(0, 120),
      reference: typeof value.reference === "string" ? value.reference.trim().slice(0, 40) : "",
      employeeNumber: typeof value.employeeNumber === "string" ? value.employeeNumber.trim().slice(0, 40) : "",
      employeeName,
      department: typeof value.department === "string" ? value.department.trim().slice(0, 100) : "",
      role: typeof value.role === "string" ? value.role.trim().slice(0, 100) : "",
      leaveType,
      otherLeaveType: leaveType === "Other" && typeof value.otherLeaveType === "string"
        ? value.otherLeaveType.trim().slice(0, 80)
        : "",
      reason,
      startDate,
      endDate,
      handoverName: typeof value.handoverName === "string" ? value.handoverName.trim().slice(0, 180) : "",
      handoverContact: typeof value.handoverContact === "string" ? value.handoverContact.trim().slice(0, 80) : "",
      originalStatus: allowedStatuses.includes(value.status) ? value.status : "Unknown",
      requestedAt,
    },
  };
}

function legacyLeaveImportKey(leave) {
  const identity = leave.legacyId || [
    leave.reference,
    leave.employeeNumber,
    leave.employeeName,
    leave.leaveType,
    leave.startDate,
    leave.endDate,
  ].join("|");
  return `legacy-${crypto.createHash("sha256").update(identity).digest("hex")}`;
}

async function getPolicy() {
  return policyValue(await LeavePolicy.findById("global").lean());
}

async function saveLeaveAndAudit(request, leave, eventType, details, options = {}) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      if (options.lockEmployee) {
        const lock = await Employee.updateOne(
          { _id: leave.employeeId },
          { $inc: { leaveRequestVersion: 1 } },
          { session },
        );
        if (!lock.matchedCount) {
          const error = new Error("The employee record no longer exists.");
          error.statusCode = 409;
          throw error;
        }
      }
      if (options.validate) await options.validate(session);
      await leave.save({ session });
      await audit.recordAudit({
        request,
        eventType,
        outcome: "success",
        details,
        transaction: session,
      });
    });
  } catch (error) {
    if (error.name === "VersionError") {
      error.statusCode = 409;
      error.message = "This leave request changed while you were working. Refresh and try again.";
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

async function currentEmployee(user) {
  return Employee.findOne({ userId: user._id, status: "Active" });
}

async function findApprover(employee, requesterId) {
  const linked = employee.supervisorUserId
    ? await User.findOne({ _id: employee.supervisorUserId, status: "Active" })
    : null;
  if (linked && String(linked._id) !== String(requesterId)) return linked;
  const hr = await User.findOne({ roles: "Human Resource", status: "Active", _id: { $ne: requesterId } }).sort({ createdAt: 1 });
  if (hr) return hr;
  return User.findOne({
    roles: { $in: ["Admin", "Super Admin"] },
    status: "Active",
    _id: { $ne: requesterId },
  }).sort({ createdAt: 1 });
}

async function employeeBalance(employeeId, leaveType, startDate, requests, policy) {
  const entitlement = policy.entitlements[leaveType];
  if (entitlement === undefined) return { configured: false, entitlement: null, carryover: 0, used: 0, pending: 0, available: null };
  const year = leaveYearBounds(startDate, policy.leaveYearStart);
  let used = 0;
  let pending = 0;
  for (const request of requests) {
    if (request.leaveType !== leaveType || request.endDate < year.start || request.startDate > year.end) continue;
    const from = request.startDate < year.start ? year.start : request.startDate;
    const to = request.endDate > year.end ? year.end : request.endDate;
    const days = calculateWorkingDays(from, to, policy);
    if (request.status === "Approved") used += days;
    if (request.status === "Pending") pending += days;
  }
  let carryover = 0;
  if (leaveType === "Annual" && policy.carryoverEnabled && policy.carryoverLimit > 0) {
    const previousYear = leaveYearBounds(addDays(year.start, -1), policy.leaveYearStart);
    let previousYearUsage = 0;
    for (const request of requests) {
      if (request.leaveType !== leaveType || request.endDate < previousYear.start || request.startDate > previousYear.end) continue;
      const from = request.startDate < previousYear.start ? previousYear.start : request.startDate;
      const to = request.endDate > previousYear.end ? previousYear.end : request.endDate;
      if (request.status === "Approved" || request.status === "Pending") {
        previousYearUsage += calculateWorkingDays(from, to, policy);
      }
    }
    carryover = Math.min(policy.carryoverLimit, Math.max(0, entitlement - previousYearUsage));
  }
  return { configured: true, entitlement, carryover, used, pending, available: entitlement + carryover - used - pending };
}

function populateRequests(query) {
  return query
    .populate("employeeId", "name firstName secondName otherNames number department role phone userId")
    .populate("handoverEmployeeId", "name firstName secondName otherNames number userId")
    .populate("requesterUserId", "name email")
    .populate("approverUserId", "name email")
    .sort({ createdAt: -1, _id: -1 })
    .limit(500)
    .lean();
}

function serializeRequest(request) {
  const employee = request.employeeId && typeof request.employeeId === "object" ? request.employeeId : null;
  const handover = request.handoverEmployeeId && typeof request.handoverEmployeeId === "object" ? request.handoverEmployeeId : null;
  const name = (value) => [value?.firstName, value?.secondName, value?.otherNames].filter(Boolean).join(" ") || value?.name || "Unknown employee";
  return {
    ...request,
    id: String(request._id),
    employeeId: String(employee?._id || request.employeeId),
    employeeName: name(employee),
    employeeNumber: employee?.number || "",
    department: employee?.department || "",
    role: employee?.role || "",
    employeeContact: employee?.phone || "",
    handoverEmployeeId: String(handover?._id || request.handoverEmployeeId),
    handoverName: request.handoverName || name(handover),
    requesterUserId: String(request.requesterUserId?._id || request.requesterUserId),
    approverUserId: String(request.approverUserId?._id || request.approverUserId),
    handoverUserId: request.handoverUserId ? String(request.handoverUserId) : null,
    requestedAt: request.createdAt,
    updatedAt: request.updatedAt,
    decisions: (request.decisions || []).map((decision) => ({ ...decision, id: String(decision._id) })),
    amendments: (request.amendments || []).map((amendment) => ({ ...amendment, id: String(amendment._id) })),
  };
}

async function getLeavePolicy(_request, response) {
  return response.json({ policy: await getPolicy() });
}

async function listLeavePeople(request, response) {
  if (!hasRole(request.authUser)) {
    await audit.recordAudit({
      request,
      eventType: "security.authorization_denied",
      outcome: "denied",
      reason: "leave_admin_required",
      details: { resource: "leave.routing" },
    });
    return response.status(403).json({ error: "Only HR or an administrator can configure leave routing." });
  }
  const [employees, users] = await Promise.all([
    Employee.find({ status: "Active" }).select("_id name firstName secondName otherNames number department role userId supervisorUserId").sort({ name: 1 }).limit(500).lean(),
    User.find({ status: "Active" }).select("_id name email roles").sort({ name: 1 }).limit(500).lean(),
  ]);
  return response.json({
    employees: employees.map((employee) => ({
      id: String(employee._id),
      name: [employee.firstName, employee.secondName, employee.otherNames].filter(Boolean).join(" ") || employee.name,
      number: employee.number,
      department: employee.department,
      role: employee.role,
      userId: employee.userId ? String(employee.userId) : null,
      supervisorUserId: employee.supervisorUserId ? String(employee.supervisorUserId) : null,
    })),
    users: users.map((user) => ({ id: String(user._id), name: user.name, email: user.email, roles: user.roles })),
  });
}

async function updateLeaveRouting(request, response) {
  if (!hasRole(request.authUser)) {
    await audit.recordAudit({
      request,
      eventType: "security.authorization_denied",
      outcome: "denied",
      reason: "leave_admin_required",
      details: { resource: "leave.routing" },
    });
    return response.status(403).json({ error: "Only HR or an administrator can configure leave routing." });
  }
  if (!mongoose.isValidObjectId(request.params.employeeId)) return response.status(400).json({ error: "Invalid employee ID." });
  const body = request.body || {};
  if (!Object.keys(body).length || Object.keys(body).some((key) => !["userId", "supervisorUserId"].includes(key))) {
    return response.status(400).json({ error: "Provide userId and/or supervisorUserId." });
  }
  for (const field of ["userId", "supervisorUserId"]) {
    if (!(field in body)) continue;
    if (body[field] !== null && (typeof body[field] !== "string" || !mongoose.isValidObjectId(body[field]))) {
      return response.status(400).json({ error: `${field} must be a valid user ID or null.` });
    }
    if (body[field] !== null) {
      const user = await User.findOne({ _id: body[field], status: "Active" }).select("_id");
      if (!user) return response.status(400).json({ error: `${field} must reference an active user account.` });
    }
  }
  const employee = await Employee.findOne({ _id: request.params.employeeId, status: "Active" });
  if (!employee) return response.status(404).json({ error: "Active employee not found." });
  if (body.userId !== undefined) {
    if (body.userId && await Employee.exists({ userId: body.userId, _id: { $ne: employee._id } })) {
      return response.status(409).json({ error: "A login account can be linked to only one employee profile." });
    }
    employee.userId = body.userId;
  }
  if (body.supervisorUserId !== undefined) employee.supervisorUserId = body.supervisorUserId;
  employee.updatedBy = request.authUser._id;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await employee.save({ session });
      await audit.recordAudit({
        request,
        eventType: "leave.routing_updated",
        outcome: "success",
        details: {
          employeeId: String(employee._id),
          linkedUserId: employee.userId ? String(employee.userId) : null,
          supervisorUserId: employee.supervisorUserId ? String(employee.supervisorUserId) : null,
        },
        transaction: session,
      });
    });
  } catch (error) {
    if (error.code === 11000) return response.status(409).json({ error: "A login account can be linked to only one employee profile." });
    throw error;
  } finally {
    await session.endSession();
  }
  return response.json({
    employee: {
      id: String(employee._id),
      userId: employee.userId ? String(employee.userId) : null,
      supervisorUserId: employee.supervisorUserId ? String(employee.supervisorUserId) : null,
    },
  });
}

async function updateLeavePolicy(request, response) {
  const { value, error } = validatePolicy(request.body);
  if (error) return response.status(400).json({ error });
  if (!Object.keys(value).length) return response.status(400).json({ error: "Provide at least one policy field to update." });
  let policy;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const previous = policyValue(await LeavePolicy.findById("global").session(session).lean());
      const merged = {
        ...previous,
        ...value,
        entitlements: value.entitlements ?? previous.entitlements,
        reminderThresholds: value.reminderThresholds
          ? { ...previous.reminderThresholds, ...value.reminderThresholds }
          : previous.reminderThresholds,
      };
      if (merged.carryoverEnabled === false) merged.carryoverLimit = 0;
      policy = await LeavePolicy.findByIdAndUpdate(
        "global",
        { $set: { ...merged, updatedBy: request.authUser._id } },
        { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true, session },
      );
      await audit.recordAudit({
        request,
        eventType: "leave.policy_updated",
        outcome: "success",
        details: { changedFields: Object.keys(value) },
        transaction: session,
      });
    });
  } finally {
    await session.endSession();
  }
  return response.json({ policy: policyValue(policy) });
}

async function listLeaveRequests(request, response) {
  const privileged = hasRole(request.authUser);
  let filter = {};
  if (!privileged) {
    const employee = await currentEmployee(request.authUser);
    filter = {
      $or: [
        { requesterUserId: request.authUser._id },
        { approverUserId: request.authUser._id },
        ...(employee ? [{ employeeId: employee._id }, { handoverEmployeeId: employee._id }] : []),
      ],
    };
  }
  if (request.query.status) {
    if (!["Pending", "Approved", "Rejected", "Cancelled"].includes(request.query.status)) {
      return response.status(400).json({ error: "status is invalid." });
    }
    filter.status = request.query.status;
  }
  const records = await populateRequests(LeaveRequest.find(filter));
  return response.json({ requests: records.map(serializeRequest) });
}

async function previewLegacyLeaveRequests(request, response) {
  if (await denyLeaveAdmin(request, response, "leave.legacy_import.preview", "Only HR or an administrator can import legacy leave records.")) return;
  const input = request.body?.leaves;
  if (!Array.isArray(input) || input.length > 500) {
    return response.status(400).json({ error: "Provide up to 500 legacy leave records." });
  }
  const records = await Promise.all(input.map(async (record, index) => {
    const validation = validateLegacyLeave(record);
    if (validation.error) return { index, reference: record?.reference || "", importable: false, duplicate: false, employeeMatched: false, reason: validation.error };
    const legacy = validation.value;
    const employee = legacy.employeeNumber
      ? await Employee.findOne({ number: legacy.employeeNumber }).select("_id").lean()
      : null;
    const duplicate = await LegacyLeaveArchive.exists({ legacyImportKey: legacyLeaveImportKey(legacy) });
    return {
      index,
      reference: legacy.reference,
      employeeName: legacy.employeeName,
      originalStatus: legacy.originalStatus,
      employeeMatched: Boolean(employee),
      importable: !duplicate,
      duplicate: Boolean(duplicate),
      reason: duplicate ? "This legacy record has already been imported." : "",
    };
  }));
  return response.json({
    records,
    importableCount: records.filter((record) => record.importable).length,
    duplicateCount: records.filter((record) => record.duplicate).length,
  });
}

async function importLegacyLeaveRequests(request, response) {
  if (await denyLeaveAdmin(request, response, "leave.legacy_import", "Only HR or an administrator can import legacy leave records.")) return;
  const input = request.body?.leaves;
  if (!Array.isArray(input) || input.length > 500) {
    return response.status(400).json({ error: "Provide up to 500 legacy leave records." });
  }
  const policy = await getPolicy();
  const session = await mongoose.startSession();
  try {
    const result = await session.withTransaction(async () => {
      const imported = [];
      const skipped = [];
      const seenKeys = new Set();
      for (let index = 0; index < input.length; index += 1) {
        const validation = validateLegacyLeave(input[index]);
        if (validation.error) {
          skipped.push({ index, reference: input[index]?.reference || "", reason: validation.error });
          continue;
        }
        const legacy = validation.value;
        const key = legacyLeaveImportKey(legacy);
        if (seenKeys.has(key) || await LegacyLeaveArchive.exists({ legacyImportKey: key }).session(session)) {
          skipped.push({ index, reference: legacy.reference, reason: "This legacy record has already been imported." });
          continue;
        }
        seenKeys.add(key);
        const employee = legacy.employeeNumber
          ? await Employee.findOne({ number: legacy.employeeNumber }).select("_id").session(session).lean()
          : null;
        const archive = new LegacyLeaveArchive({
          legacyImportKey: key,
          legacyId: legacy.legacyId,
          reference: legacy.reference,
          employeeId: employee?._id || null,
          employeeNumber: legacy.employeeNumber,
          employeeName: legacy.employeeName,
          department: legacy.department,
          role: legacy.role,
          leaveType: legacy.leaveType,
          otherLeaveType: legacy.otherLeaveType,
          reason: legacy.reason,
          startDate: legacy.startDate,
          endDate: legacy.endDate,
          requestedDays: calculateWorkingDays(legacy.startDate, legacy.endDate, policy),
          handoverName: legacy.handoverName,
          handoverContact: legacy.handoverContact,
          originalStatus: legacy.originalStatus,
          originalRequestedAt: legacy.requestedAt,
          importedBy: request.authUser._id,
        });
        await archive.save({ session });
        await audit.recordAudit({
          request,
          eventType: "leave.legacy_imported",
          outcome: "success",
          details: {
            legacyArchiveId: String(archive._id),
            employeeId: employee ? String(employee._id) : null,
            reference: legacy.reference,
            originalStatus: legacy.originalStatus,
            unverified: true,
          },
          transaction: session,
        });
        imported.push(archive);
      }
      return { imported, skipped };
    });
    return response.status(201).json({
      imported: result.imported.map((archive) => archive.toJSON()),
      skipped: result.skipped,
    });
  } catch (error) {
    if (error.code === 11000) return response.status(409).json({ error: "One or more legacy leave records were imported concurrently. Refresh the archive preview and retry." });
    throw error;
  } finally {
    await session.endSession();
  }
}

async function listLegacyLeaveArchive(request, response) {
  if (await denyLeaveAdmin(request, response, "leave.legacy_archive", "Only HR or an administrator can view legacy leave records.")) return;
  const records = await LegacyLeaveArchive.find()
    .sort({ createdAt: -1, _id: -1 })
    .limit(500)
    .lean();
  return response.json({
    records: records.map((record) => ({ ...record, id: String(record._id) })),
  });
}

async function createLeaveRequest(request, response) {
  const { value, error } = validateRequestInput(request.body);
  if (error) return response.status(400).json({ error });
  const selfEmployee = await currentEmployee(request.authUser);
  const employeeId = value.employeeId || (selfEmployee ? String(selfEmployee._id) : "");
  if (!employeeId) return response.status(400).json({ error: "Your account is not linked to an active employee profile." });
  if (String(request.authUser._id) !== String(selfEmployee?.userId) && !hasRole(request.authUser)) {
    return response.status(403).json({ error: "You can submit leave only for your own employee profile." });
  }
  const employee = await Employee.findById(employeeId);
  if (!employee || employee.status !== "Active") return response.status(400).json({ error: "Select an active employee." });
  if (!hasRole(request.authUser) && String(employee._id) !== String(selfEmployee?._id)) {
    return response.status(403).json({ error: "You can submit leave only for your own employee profile." });
  }
  const handover = await Employee.findById(value.handoverEmployeeId);
  if (!handover || handover.status !== "Active" || String(handover._id) === String(employee._id)) {
    return response.status(400).json({ error: "Select a different active handover employee." });
  }
  const approver = await findApprover(employee, request.authUser._id);
  if (!approver) return response.status(409).json({ error: "No eligible incharge, HR, or administrator is configured to review this request." });
  const policy = await getPolicy();
  const requestedDays = calculateWorkingDays(value.startDate, value.endDate, policy);
  if (!requestedDays) return response.status(400).json({ error: "The selected period contains no working days." });
  const now = new Date();
  const handoverUserId = handover.userId || null;
  const leave = new LeaveRequest({
    reference: `LV-${now.getUTCFullYear()}-${new mongoose.Types.ObjectId().toString().slice(-8).toUpperCase()}`,
    employeeId: employee._id,
    employeeUserId: employee.userId || null,
    requesterUserId: request.authUser._id,
    approverUserId: approver._id,
    leaveType: value.leaveType,
    otherLeaveType: value.leaveType === "Other" ? value.otherLeaveType.trim() : "",
    reason: value.reason.trim(),
    startDate: value.startDate,
    endDate: value.endDate,
    requestedDays,
    handoverEmployeeId: handover._id,
    handoverUserId,
    handoverName: handover.name,
    handoverContact: value.handoverContact?.trim() || handover.phone || "",
    createdBy: request.authUser._id,
    updatedBy: request.authUser._id,
  });
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const lock = await Employee.updateOne(
        { _id: employee._id, status: "Active" },
        { $inc: { leaveRequestVersion: 1 } },
        { session },
      );
      if (!lock.matchedCount) {
        const error = new Error("Select an active employee.");
        error.statusCode = 409;
        throw error;
      }
      const existing = await LeaveRequest.find({
        employeeId: employee._id,
        status: { $in: ["Pending", "Approved"] },
        startDate: { $lte: value.endDate },
        endDate: { $gte: value.startDate },
      }).session(session).lean();
      if (existing.length) {
        const error = new Error("This employee has an overlapping pending or approved leave request.");
        error.statusCode = 409;
        throw error;
      }
      if (value.leaveType === "Annual" || Object.hasOwn(policy.entitlements, value.leaveType)) {
        const balanceRequests = await LeaveRequest.find({
          employeeId: employee._id,
          status: { $in: ["Pending", "Approved"] },
        }).session(session).lean();
        const balance = await employeeBalance(employee._id, value.leaveType, value.startDate, balanceRequests, policy);
        if (!balance.configured) {
          const error = new Error("Annual leave entitlement is not configured.");
          error.statusCode = 409;
          throw error;
        }
        if (balance.available < requestedDays) {
          const error = new Error("The request exceeds the available annual leave balance.");
          error.statusCode = 409;
          throw error;
        }
      }
      await leave.save({ session });
      await audit.recordAudit({
        request,
        eventType: "leave.requested",
        outcome: "success",
        target: request.authUser,
        details: { leaveRequestId: String(leave._id), employeeId: String(employee._id), startDate: value.startDate, endDate: value.endDate, approverUserId: String(approver._id) },
        transaction: session,
      });
    });
  } catch (error) {
    if (error.statusCode === 409 || error.statusCode === 400) return response.status(error.statusCode).json({ error: error.message });
    throw error;
  } finally {
    await session.endSession();
  }
  return response.status(201).json({
    request: serializeRequest({
      ...leave.toObject(),
      employeeId: employee,
      handoverEmployeeId: handover,
    }),
  });
}

async function decideLeaveRequest(request, response) {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(400).json({ error: "Invalid leave request ID." });
  const { decision, note = "" } = request.body || {};
  if (!["Approved", "Rejected"].includes(decision) || typeof note !== "string" || note.trim().length > 1000) {
    return response.status(400).json({ error: "Provide an Approved or Rejected decision and an optional note up to 1,000 characters." });
  }
  if (decision === "Rejected" && !note.trim()) return response.status(400).json({ error: "A reason is required when rejecting a leave request." });
  const leave = await LeaveRequest.findById(request.params.id);
  if (!leave) return response.status(404).json({ error: "Leave request not found." });
  if (String(leave.requesterUserId) === String(request.authUser._id)) return response.status(403).json({ error: "You cannot approve your own leave request." });
  if (!hasRole(request.authUser) && String(leave.approverUserId) !== String(request.authUser._id)) {
    return response.status(403).json({ error: "Only the assigned incharge or HR can decide this request." });
  }
  if (leave.status !== "Pending") return response.status(409).json({ error: "This request is no longer pending." });
  const policy = await getPolicy();
  const now = new Date();
  leave.status = decision;
  leave.updatedBy = request.authUser._id;
  leave.decisions.push({ decision, actorId: request.authUser._id, actorName: request.authUser.name, at: now, note: note.trim() });
  if (decision === "Approved") leave.returnConfirmation.expectedDate = expectedReturnDate(leave.endDate, policy);
  try {
    await saveLeaveAndAudit(
      request,
      leave,
      decision === "Approved" ? "leave.approved" : "leave.rejected",
      { leaveRequestId: String(leave._id), employeeId: String(leave.employeeId), note: note.trim() || undefined },
      {
        lockEmployee: true,
        validate: async (session) => {
          if (decision !== "Approved" || !(leave.leaveType === "Annual" || Object.hasOwn(policy.entitlements, leave.leaveType))) return;
          const existing = await LeaveRequest.find({
            employeeId: leave.employeeId,
            _id: { $ne: leave._id },
            status: { $in: ["Pending", "Approved"] },
          }).session(session).lean();
          const balance = await employeeBalance(leave.employeeId, leave.leaveType, leave.startDate, existing, policy);
          if (!balance.configured || balance.available < leave.requestedDays) {
            const error = new Error("Approval would exceed the configured leave balance.");
            error.statusCode = 409;
            throw error;
          }
        },
      },
    );
  } catch (error) {
    if (error.statusCode === 409) return response.status(409).json({ error: error.message });
    throw error;
  }
  return response.json({ request: serializeRequest(leave.toObject()) });
}

async function cancelLeaveRequest(request, response) {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(400).json({ error: "Invalid leave request ID." });
  if (!hasRole(request.authUser)) return response.status(403).json({ error: "Only HR or an administrator can cancel a leave request." });
  const note = request.body?.note;
  if (typeof note !== "string" || !note.trim() || note.trim().length > 1000) {
    return response.status(400).json({ error: "Provide a cancellation reason of 1,000 characters or fewer." });
  }
  const leave = await LeaveRequest.findById(request.params.id);
  if (!leave) return response.status(404).json({ error: "Leave request not found." });
  if (!["Pending", "Approved"].includes(leave.status)) return response.status(409).json({ error: "Only pending or approved requests can be cancelled." });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Kampala" }).format(new Date());
  if (leave.status === "Approved" && leave.startDate <= today) {
    return response.status(409).json({ error: "In-progress leave must be corrected through an amendment." });
  }
  leave.status = "Cancelled";
  leave.updatedBy = request.authUser._id;
  leave.decisions.push({ decision: "Cancelled", actorId: request.authUser._id, actorName: request.authUser.name, at: new Date(), note: note.trim() });
  await saveLeaveAndAudit(request, leave, "leave.cancelled", {
    leaveRequestId: String(leave._id),
    employeeId: String(leave.employeeId),
  });
  return response.json({ request: serializeRequest(leave.toObject()) });
}

async function requestLeaveAmendment(request, response) {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(400).json({ error: "Invalid leave request ID." });
  if (!hasRole(request.authUser)) return response.status(403).json({ error: "Only HR or an administrator can amend leave." });
  const body = request.body || {};
  if (Object.keys(body).some((key) => !["startDate", "endDate", "reason"].includes(key))
    || !isValidDate(body.startDate) || !isValidDate(body.endDate) || body.startDate > body.endDate
    || typeof body.reason !== "string" || !body.reason.trim() || body.reason.trim().length > 1000) {
    return response.status(400).json({ error: "Provide a valid proposed date range and reason." });
  }
  const leave = await LeaveRequest.findById(request.params.id);
  if (!leave) return response.status(404).json({ error: "Leave request not found." });
  if (leave.status !== "Approved") return response.status(409).json({ error: "Only approved leave can be amended." });
  if (leave.amendments.some((amendment) => amendment.status === "Pending")) {
    return response.status(409).json({ error: "This leave already has a pending amendment." });
  }
  const policy = await getPolicy();
  const requestedDays = calculateWorkingDays(body.startDate, body.endDate, policy);
  if (!requestedDays) return response.status(400).json({ error: "The proposed dates contain no working days." });
  leave.amendments.push({
    startDate: body.startDate,
    endDate: body.endDate,
    requestedDays,
    reason: body.reason.trim(),
    requestedBy: request.authUser._id,
  });
  leave.updatedBy = request.authUser._id;
  await saveLeaveAndAudit(request, leave, "leave.amendment_requested", {
    leaveRequestId: String(leave._id),
    startDate: body.startDate,
    endDate: body.endDate,
  });
  return response.status(201).json({ request: serializeRequest(leave.toObject()) });
}

async function decideLeaveAmendment(request, response) {
  if (!mongoose.isValidObjectId(request.params.id) || !mongoose.isValidObjectId(request.params.amendmentId)) {
    return response.status(400).json({ error: "Invalid leave or amendment ID." });
  }
  const { decision, note = "" } = request.body || {};
  if (!["Approved", "Rejected"].includes(decision) || typeof note !== "string" || note.trim().length > 1000) {
    return response.status(400).json({ error: "Provide an Approved or Rejected decision and optional note." });
  }
  const leave = await LeaveRequest.findById(request.params.id);
  if (!leave || leave.status !== "Approved") return response.status(404).json({ error: "Approved leave request not found." });
  if (String(leave.approverUserId) !== String(request.authUser._id) && !hasRole(request.authUser)) {
    return response.status(403).json({ error: "Only the assigned incharge or HR can decide this amendment." });
  }
  const amendment = leave.amendments.id(request.params.amendmentId);
  if (!amendment || amendment.status !== "Pending") return response.status(404).json({ error: "Pending amendment not found." });
  if (String(amendment.requestedBy) === String(request.authUser._id)) {
    return response.status(403).json({ error: "You cannot approve your own leave amendment." });
  }
  const policy = await getPolicy();
  amendment.status = decision;
  amendment.decidedBy = request.authUser._id;
  amendment.decidedAt = new Date();
  amendment.decisionNote = note.trim();
  leave.updatedBy = request.authUser._id;
  try {
    await saveLeaveAndAudit(
      request,
      leave,
      decision === "Approved" ? "leave.amendment_approved" : "leave.amendment_rejected",
      { leaveRequestId: String(leave._id), amendmentId: String(amendment._id), startDate: amendment.startDate, endDate: amendment.endDate },
      {
        lockEmployee: true,
        validate: async (session) => {
          if (decision !== "Approved") return;
          const overlap = await LeaveRequest.findOne({
            _id: { $ne: leave._id },
            employeeId: leave.employeeId,
            status: { $in: ["Pending", "Approved"] },
            startDate: { $lte: amendment.endDate },
            endDate: { $gte: amendment.startDate },
          }).session(session).lean();
          if (overlap) {
            const error = new Error("The amended dates overlap another pending or approved leave request.");
            error.statusCode = 409;
            throw error;
          }
          if (leave.leaveType === "Annual" || Object.hasOwn(policy.entitlements, leave.leaveType)) {
            const existing = await LeaveRequest.find({
              employeeId: leave.employeeId,
              _id: { $ne: leave._id },
              status: { $in: ["Pending", "Approved"] },
            }).session(session).lean();
            const balance = await employeeBalance(leave.employeeId, leave.leaveType, amendment.startDate, existing, policy);
            if (!balance.configured || balance.available < amendment.requestedDays) {
              const error = new Error("The amended dates would exceed the configured leave balance.");
              error.statusCode = 409;
              throw error;
            }
          }
          leave.startDate = amendment.startDate;
          leave.endDate = amendment.endDate;
          leave.requestedDays = amendment.requestedDays;
          leave.returnConfirmation.expectedDate = expectedReturnDate(leave.endDate, policy);
          leave.returnConfirmation.actualDate = undefined;
          leave.returnConfirmation.confirmedBy = undefined;
          leave.returnConfirmation.confirmedAt = undefined;
        },
      },
    );
  } catch (error) {
    if (error.statusCode === 409) return response.status(409).json({ error: error.message });
    throw error;
  }
  return response.json({ request: serializeRequest(leave.toObject()) });
}

async function confirmLeaveReturn(request, response) {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(400).json({ error: "Invalid leave request ID." });
  const actualDate = request.body?.actualDate;
  if (!isValidDate(actualDate)) return response.status(400).json({ error: "actualDate must be a valid YYYY-MM-DD date." });
  const leave = await LeaveRequest.findById(request.params.id);
  if (!leave || leave.status !== "Approved") return response.status(404).json({ error: "Approved leave request not found." });
  if (!hasRole(request.authUser) && String(leave.approverUserId) !== String(request.authUser._id)) {
    return response.status(403).json({ error: "Only the assigned incharge or HR can confirm an employee's return." });
  }
  if (actualDate < leave.startDate) return response.status(400).json({ error: "The return date cannot be before leave starts." });
  leave.returnConfirmation.actualDate = actualDate;
  leave.returnConfirmation.confirmedBy = request.authUser._id;
  leave.returnConfirmation.confirmedAt = new Date();
  leave.updatedBy = request.authUser._id;
  await saveLeaveAndAudit(request, leave, "leave.return_confirmed", {
    leaveRequestId: String(leave._id),
    employeeId: String(leave.employeeId),
    actualDate,
  });
  return response.json({ request: serializeRequest(leave.toObject()) });
}

async function getBalances(request, response) {
  if (!hasRole(request.authUser)) return response.status(403).json({ error: "Only HR or an administrator can view leave balances." });
  const policy = await getPolicy();
  const employees = await Employee.find({ status: "Active" }).select("_id name number department").sort({ name: 1 }).limit(500).lean();
  const requests = await LeaveRequest.find({ status: { $in: ["Pending", "Approved"] } }).lean();
  const balances = await Promise.all(employees.map(async (employee) => {
    const year = leaveYearBounds(new Date().toISOString().slice(0, 10), policy.leaveYearStart);
    const yearRequests = requests.filter((item) => String(item.employeeId) === String(employee._id));
    const totals = Object.fromEntries(await Promise.all(REQUEST_TYPES.map(async (type) => [
      type,
      await employeeBalance(employee._id, type, year.start, yearRequests, policy),
    ])));
    return {
      employeeId: String(employee._id),
      employeeName: employee.name,
      employeeNumber: employee.number,
      department: employee.department,
      leaveYear: year,
      byType: totals,
    };
  }));
  return response.json({ balances });
}

async function listReminderCandidates(request, response) {
  const [policy, requests] = await Promise.all([
    getPolicy(),
    LeaveRequest.find({ status: { $in: ["Pending", "Approved"] } }).lean(),
  ]);
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Africa/Kampala" }).format(new Date());
  const candidates = getReminderCandidates(requests, policy).filter((candidate) => candidate.dueDate <= today);
  const visible = hasRole(request.authUser)
    ? candidates
    : candidates.filter((candidate) => candidate.recipientUserId === String(request.authUser._id));
  return response.json({ candidates: visible });
}

module.exports = {
  addBusinessDays,
  calculateWorkingDays,
  cancelLeaveRequest,
  confirmLeaveReturn,
  createLeaveRequest,
  decideLeaveAmendment,
  decideLeaveRequest,
  employeeBalance,
  expectedReturnDate,
  getBalances,
  getLeavePolicy,
  listLeavePeople,
  listLegacyLeaveArchive,
  getReminderCandidates,
  listReminderCandidates,
  listLeaveRequests,
  importLegacyLeaveRequests,
  previewLegacyLeaveRequests,
  policyValue,
  requestLeaveAmendment,
  updateLeavePolicy,
  updateLeaveRouting,
  validatePolicy,
  validateLegacyLeave,
  legacyLeaveImportKey,
  validateRequestInput,
};
