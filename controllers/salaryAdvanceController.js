const crypto = require("node:crypto");
const mongoose = require("mongoose");
const Employee = require("../models/employee");
const SalaryAdvance = require("../models/salaryAdvance");
const audit = require("../lib/audit");

const FREQUENCIES = ["Weekly", "Monthly"];
const METHODS = ["Cash", "Mobile Money", "Bank Transfer"];

function isDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function companyDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Kampala",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function nextDate(date, frequency) {
  const [year, month, day] = date.split("-").map(Number);
  if (frequency === "Weekly") {
    return new Date(Date.UTC(year, month - 1, day + 7)).toISOString().slice(0, 10);
  }
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

function makeSchedule(firstDueDate, frequency, installment, amount) {
  const schedule = [];
  if (!isDate(firstDueDate) || !FREQUENCIES.includes(frequency) || !Number.isSafeInteger(installment) || installment < 1 || !Number.isSafeInteger(amount) || amount < 1) {
    return schedule;
  }
  let remaining = amount;
  let dueDate = firstDueDate;
  while (remaining > 0 && schedule.length < 120) {
    const plannedAmount = Math.min(installment, remaining);
    schedule.push({ dueDate, plannedAmount });
    remaining -= plannedAmount;
    dueDate = nextDate(dueDate, frequency);
  }
  return schedule;
}

function safeInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateCreate(body) {
  const allowed = ["employeeId", "requestedAmount", "reason", "dateTaken", "proposedFrequency", "proposedInstallmentAmount"];
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key))) {
    return { error: "Provide salary-advance request fields in the supported shape." };
  }
  if (!mongoose.isValidObjectId(body.employeeId)) return { error: "employeeId must reference a valid employee." };
  if (!safeInt(body.requestedAmount) || body.requestedAmount > 1000000000000) return { error: "requestedAmount must be a positive whole amount." };
  if (!safeInt(body.proposedInstallmentAmount) || body.proposedInstallmentAmount > body.requestedAmount) return { error: "proposedInstallmentAmount must be positive and no greater than requestedAmount." };
  if (!FREQUENCIES.includes(body.proposedFrequency)) return { error: "proposedFrequency must be Weekly or Monthly." };
  if (typeof body.reason !== "string" || !body.reason.trim() || body.reason.trim().length > 2000) return { error: "reason is required and must be 2,000 characters or fewer." };
  if (!isDate(body.dateTaken) || body.dateTaken > companyDate()) return { error: "dateTaken must be a valid date no later than today." };
  return { value: { ...body, reason: body.reason.trim() } };
}

function validateLegacyAdvance(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "Advance record must be an object." };
  const employeeName = typeof value.employeeName === "string" ? value.employeeName.trim().slice(0, 180) : "";
  const employeeNumber = typeof value.employeeNumber === "string" ? value.employeeNumber.trim().slice(0, 40) : "";
  const reason = typeof value.reason === "string" ? value.reason.trim().slice(0, 2000) : "";
  const amount = Number(value.requestedAmount);
  const installmentAmount = Number(value.proposedInstallmentAmount);
  const dateTaken = String(value.dateTaken || "");
  const proposedFrequency = value.proposedFrequency;
  if (!employeeName || !safeInt(amount) || !safeInt(installmentAmount) || installmentAmount > amount || !reason || !isDate(dateTaken) || !FREQUENCIES.includes(proposedFrequency)) {
    return { error: "Employee, requested amount, reason, date taken, and repayment terms must be valid." };
  }
  const allowedStatuses = ["Pending HR review", "Pending GM review", "Pending review", "Approved", "Rejected", "Active", "Settled"];
  const requestedAt = value.requestedAt && !Number.isNaN(new Date(value.requestedAt).getTime())
    ? new Date(value.requestedAt)
    : new Date(`${dateTaken}T12:00:00.000Z`);
  const approvedAmount = safeInt(Number(value.approvedAmount)) && Number(value.approvedAmount) <= amount
    ? Number(value.approvedAmount)
    : undefined;
  const schedule = Array.isArray(value.schedule)
    ? value.schedule.slice(0, 120).filter((entry) => entry && isDate(entry.dueDate) && safeInt(Number(entry.plannedAmount))).map((entry) => ({ dueDate: entry.dueDate, plannedAmount: Number(entry.plannedAmount) }))
    : [];
  const repayments = Array.isArray(value.repayments)
    ? value.repayments.slice(0, 500).filter((entry) => entry && isDate(entry.date) && safeInt(Number(entry.amount)) && METHODS.concat("Payroll").includes(entry.method)).map((entry) => ({
        date: entry.date,
        amount: Number(entry.amount),
        method: entry.method,
        reference: typeof entry.reference === "string" ? entry.reference.trim().slice(0, 160) : undefined,
        note: "Imported from browser archive; original repayment actor is unverified.",
      }))
    : [];
  const disbursementValue = value.disbursement && typeof value.disbursement === "object" ? value.disbursement : null;
  const disbursement = disbursementValue && safeInt(Number(disbursementValue.amount)) && isDate(disbursementValue.date) && METHODS.includes(disbursementValue.method)
    ? { amount: Number(disbursementValue.amount), date: disbursementValue.date, method: disbursementValue.method, reference: typeof disbursementValue.reference === "string" ? disbursementValue.reference.trim().slice(0, 160) : undefined }
    : undefined;
  return {
    value: {
      legacyId: String(value.id || value.reference || "").slice(0, 120),
      reference: typeof value.reference === "string" ? value.reference.trim().slice(0, 40) : "",
      employeeId: mongoose.isValidObjectId(value.employeeId) ? String(value.employeeId) : "",
      employeeNumber,
      employeeName,
      department: typeof value.department === "string" ? value.department.trim().slice(0, 100) : "",
      role: typeof value.role === "string" ? value.role.trim().slice(0, 100) : "",
      category: typeof value.category === "string" ? value.category.trim().slice(0, 80) : "Other",
      paymentFrequency: ["Weekly", "Monthly"].includes(value.paymentFrequency) ? value.paymentFrequency : "",
      requestedAmount: amount,
      reason,
      dateTaken,
      requestedAt,
      proposedFrequency,
      proposedInstallmentAmount: installmentAmount,
      legacyStatus: allowedStatuses.includes(value.status) ? value.status : "Unknown",
      approvedAmount,
      approvedFrequency: FREQUENCIES.includes(value.approvedFrequency) ? value.approvedFrequency : undefined,
      approvedInstallmentAmount: safeInt(Number(value.approvedInstallmentAmount)) ? Number(value.approvedInstallmentAmount) : undefined,
      dateApproved: isDate(value.dateApproved) ? value.dateApproved : undefined,
      schedule,
      repayments,
      disbursement,
    },
  };
}

function legacyImportKey(advance) {
  const identity = advance.legacyId || [advance.reference, advance.employeeNumber, advance.dateTaken, advance.requestedAmount].join("|");
  return `legacy-${crypto.createHash("sha256").update(identity).digest("hex")}`;
}

function hasReviewerConflict(advance, actorId, role) {
  if (!actorId) return false;
  if (advance.createdBy && String(advance.createdBy) === String(actorId)) return true;
  return Boolean(role === "General Manager" &&
    advance.hrDecision?.actorId &&
    String(advance.hrDecision.actorId) === String(actorId));
}

async function previewLegacySalaryAdvances(request, response) {
  const input = request.body?.advances;
  if (!Array.isArray(input) || input.length > 500) return response.status(400).json({ error: "Provide up to 500 legacy salary-advance records." });
  const results = await Promise.all(input.map(async (record, index) => {
    const validation = validateLegacyAdvance(record);
    if (validation.error) return { index, reference: record?.reference || "", importable: false, duplicate: false, employeeMatched: false, reason: validation.error };
    const advance = validation.value;
    const employee = advance.employeeNumber
      ? await Employee.findOne({ number: advance.employeeNumber }).select("_id").lean()
      : advance.employeeId ? await Employee.findById(advance.employeeId).select("_id").lean() : null;
    const duplicate = await SalaryAdvance.exists({ legacyImportKey: legacyImportKey(advance) });
    return {
      index,
      reference: advance.reference,
      employeeName: advance.employeeName,
      employeeMatched: Boolean(employee),
      importable: !duplicate,
      duplicate: Boolean(duplicate),
      reason: duplicate ? "This legacy record has already been imported." : "",
    };
  }));
  return response.json({ records: results, importableCount: results.filter((item) => item.importable).length, duplicateCount: results.filter((item) => item.duplicate).length });
}

async function importLegacySalaryAdvances(request, response) {
  const input = request.body?.advances;
  if (!Array.isArray(input) || input.length > 500) return response.status(400).json({ error: "Provide up to 500 legacy salary-advance records." });
  try {
    const result = await withTransaction(async (session) => {
      const imported = [];
      const skipped = [];
      const seenKeys = new Set();
      for (let index = 0; index < input.length; index += 1) {
        const validation = validateLegacyAdvance(input[index]);
        if (validation.error) {
          skipped.push({ index, reference: input[index]?.reference || "", reason: validation.error });
          continue;
        }
        const legacy = validation.value;
        const key = legacyImportKey(legacy);
        if (seenKeys.has(key) || await SalaryAdvance.exists({ legacyImportKey: key }).session(session)) {
          skipped.push({ index, reference: legacy.reference, reason: "This legacy record has already been imported." });
          continue;
        }
        seenKeys.add(key);
        const employee = legacy.employeeNumber
          ? await Employee.findOne({ number: legacy.employeeNumber }).select("_id").session(session).lean()
          : legacy.employeeId ? await Employee.findById(legacy.employeeId).select("_id").session(session).lean() : null;
        const advance = new SalaryAdvance({
          ...(employee ? { employeeId: employee._id } : {}),
          employeeNumber: legacy.employeeNumber,
          employeeName: legacy.employeeName,
          department: legacy.department || "Unknown",
          role: legacy.role || "Unknown",
          category: legacy.category,
          paymentFrequency: legacy.paymentFrequency,
          reference: `ADV-L-${key.slice(-8).toUpperCase()}`,
          legacyReference: legacy.reference || undefined,
          requestedAmount: legacy.requestedAmount,
          reason: legacy.reason,
          dateTaken: legacy.dateTaken,
          requestedAt: legacy.requestedAt,
          proposedFrequency: legacy.proposedFrequency,
          proposedInstallmentAmount: legacy.proposedInstallmentAmount,
          status: "Legacy archive",
          legacyStatus: legacy.legacyStatus,
          legacyUnverified: true,
          legacyImportKey: key,
          approvedAmount: legacy.approvedAmount,
          approvedFrequency: legacy.approvedFrequency,
          approvedInstallmentAmount: legacy.approvedInstallmentAmount,
          dateApproved: legacy.dateApproved,
          schedule: legacy.schedule,
          disbursement: legacy.disbursement ? { ...legacy.disbursement, recordedAt: legacy.requestedAt, recordedBy: request.authUser._id } : undefined,
          repayments: legacy.repayments.map((repayment) => ({ ...repayment, recordedBy: request.authUser._id, legacy: true })),
          attachments: [],
          activity: [{
            action: "Legacy browser record imported",
            actorId: request.authUser._id,
            actorName: request.authUser.name,
            note: "Approval and attachment data remain unverified; browser backup retained by the client.",
            at: new Date(),
          }],
          createdBy: request.authUser._id,
          updatedBy: request.authUser._id,
        });
        await advance.save({ session });
        await writeAudit(request, advance, "salary_advance.imported", session, { legacy: true, legacyStatus: legacy.legacyStatus });
        imported.push(advance);
      }
      return { imported, skipped };
    });
    return response.status(201).json({
      imported: result.imported.map((advance) => advance.toJSON()),
      skipped: result.skipped,
    });
  } catch (error) {
    if (error.code === 11000) return response.status(409).json({ error: "One or more legacy salary advances were imported concurrently. Refresh the archive preview and retry." });
    throw error;
  }
}

function validateDecision(body, role) {
  const allowed = role === "Human Resource"
    ? ["decision", "note", "amount", "frequency", "installmentAmount"]
    : ["decision", "note", "amount", "frequency", "installmentAmount"];
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key))) {
    return { error: "Provide decision fields in the supported shape." };
  }
  if (!["Approved", "Rejected"].includes(body.decision)) return { error: "decision must be Approved or Rejected." };
  if (body.note !== undefined && (typeof body.note !== "string" || body.note.trim().length > 1000)) return { error: "note must be 1,000 characters or fewer." };
  if (body.decision === "Rejected" && !body.note?.trim()) return { error: "A rejection reason is required." };
  if (body.decision === "Approved") {
    if (!safeInt(body.amount) || !FREQUENCIES.includes(body.frequency) || !safeInt(body.installmentAmount) || body.installmentAmount > body.amount) {
      return { error: "Approval requires a positive amount, valid frequency, and installment no greater than amount." };
    }
  }
  return { value: { ...body, note: body.note?.trim() || "" } };
}

function getBalance(advance) {
  const repaid = advance.repayments.reduce((sum, item) => sum + item.amount, 0);
  return Math.max(0, (advance.disbursement?.amount || 0) - repaid);
}

function snapshotEmployee(employee) {
  const name = employee.name || [employee.firstName, employee.secondName, employee.otherNames].filter(Boolean).join(" ");
  return {
    employeeNumber: employee.number,
    employeeName: name,
    department: employee.department,
    role: employee.role,
    category: employee.category,
    paymentFrequency: employee.paymentFrequency || "",
  };
}

function makeActivity(action, actor, note = "") {
  return { action, actorId: actor._id, actorName: actor.name, note };
}

function newReference() {
  return `ADV-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
}

async function writeAudit(request, advance, eventType, transaction, details = {}) {
  await audit.recordAudit({
    request,
    eventType,
    outcome: "success",
    details: { advanceId: String(advance._id), reference: advance.reference, employeeId: String(advance.employeeId), ...details },
    transaction,
  });
}

async function withTransaction(callback) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await callback(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

function isCastError(error) {
  return error instanceof mongoose.Error.CastError || error?.name === "CastError";
}

async function listSalaryAdvances(request, response) {
  const filter = {};
  if (request.query.employeeId) {
    if (!mongoose.isValidObjectId(request.query.employeeId)) return response.status(400).json({ error: "employeeId is invalid." });
    filter.employeeId = request.query.employeeId;
  }
  if (request.query.status) {
    const valid = ["Pending HR review", "Pending GM review", "Approved", "Rejected", "Active", "Settled", "Legacy archive"];
    const statuses = String(request.query.status).split(",");
    if (statuses.some((status) => !valid.includes(status))) return response.status(400).json({ error: "status filter is invalid." });
    filter.status = statuses.length === 1 ? statuses[0] : { $in: statuses };
  }
  const advances = await SalaryAdvance.find(filter).sort({ createdAt: -1 }).limit(1000);
  return response.json({ advances });
}

async function getSalaryAdvance(request, response) {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(400).json({ error: "Salary advance ID is invalid." });
  const advance = await SalaryAdvance.findById(request.params.id);
  if (!advance) return response.status(404).json({ error: "Salary advance not found." });
  return response.json({ advance });
}

async function createSalaryAdvance(request, response) {
  const { value, error } = validateCreate(request.body);
  if (error) return response.status(400).json({ error });
  const employee = await Employee.findById(value.employeeId).select("number name firstName secondName otherNames department role category paymentFrequency status").lean();
  if (!employee) return response.status(404).json({ error: "Employee not found." });
  if (employee.status !== "Active") return response.status(400).json({ error: "Salary advances can only be requested for active employees." });
  const reference = newReference();
  const now = new Date();
  const advance = new SalaryAdvance({
    ...snapshotEmployee(employee),
    reference,
    employeeId: employee._id,
    requestedAmount: value.requestedAmount,
    reason: value.reason,
    dateTaken: value.dateTaken,
    requestedAt: now,
    proposedFrequency: value.proposedFrequency,
    proposedInstallmentAmount: value.proposedInstallmentAmount,
    status: "Pending HR review",
    createdBy: request.authUser._id,
    updatedBy: request.authUser._id,
    activity: [makeActivity("Request submitted", request.authUser)],
  });
  await advance.save();
  await writeAudit(request, advance, "salary_advance.requested");
  return response.status(201).json({ advance });
}

async function decideHr(request, response) {
  const validated = validateDecision(request.body, "Human Resource");
  if (validated.error) return response.status(400).json({ error: validated.error });
  try {
    const advance = await withTransaction(async (session) => {
      const current = await SalaryAdvance.findById(request.params.id).session(session);
      if (!current) return null;
      if (current.status !== "Pending HR review") {
        const error = new Error("This request is not awaiting HR review.");
        error.statusCode = 409;
        throw error;
      }
      if (hasReviewerConflict(current, request.authUser._id, "Human Resource")) {
        const error = new Error("The requester cannot provide the Human Resource decision.");
        error.statusCode = 403;
        throw error;
      }
      const { decision, note, amount, frequency, installmentAmount } = validated.value;
      current.hrDecision = { decision, role: "Human Resource", actorId: request.authUser._id, actorName: request.authUser.name, note, amount, frequency, installmentAmount };
      current.updatedBy = request.authUser._id;
      if (decision === "Rejected") {
        current.status = "Rejected";
        current.rejectionReason = note;
        current.activity.push(makeActivity("HR rejected request", request.authUser, note));
      } else {
        if (amount > current.requestedAmount) {
          const error = new Error("HR's proposed amount cannot exceed the requested amount.");
          error.statusCode = 400;
          throw error;
        }
        current.status = "Pending GM review";
        current.activity.push(makeActivity("HR approved and proposed terms", request.authUser, note));
      }
      await current.save({ session });
      await writeAudit(request, current, decision === "Rejected" ? "salary_advance.rejected" : "salary_advance.hr_approved", session, { decision });
      return current;
    });
    if (!advance) return response.status(404).json({ error: "Salary advance not found." });
    return response.json({ advance });
  } catch (error) {
    if (error.statusCode) return response.status(error.statusCode).json({ error: error.message });
    if (isCastError(error)) return response.status(400).json({ error: "Salary advance ID is invalid." });
    throw error;
  }
}

async function decideGeneralManager(request, response) {
  const validated = validateDecision(request.body, "General Manager");
  if (validated.error) return response.status(400).json({ error: validated.error });
  try {
    const advance = await withTransaction(async (session) => {
      const current = await SalaryAdvance.findById(request.params.id).session(session);
      if (!current) return null;
      if (current.status !== "Pending GM review") {
        const error = new Error("This request is not awaiting General Manager review.");
        error.statusCode = 409;
        throw error;
      }
      if (hasReviewerConflict(current, request.authUser._id, "General Manager")) {
        const error = new Error("The requester or HR reviewer cannot provide the General Manager decision.");
        error.statusCode = 403;
        throw error;
      }
      const { decision, note, amount, frequency, installmentAmount } = validated.value;
      current.gmDecision = { decision, role: "General Manager", actorId: request.authUser._id, actorName: request.authUser.name, note, amount, frequency, installmentAmount };
      current.updatedBy = request.authUser._id;
      if (decision === "Rejected") {
        current.status = "Rejected";
        current.rejectionReason = note;
        current.activity.push(makeActivity("General Manager rejected request", request.authUser, note));
      } else {
        if (amount > current.requestedAmount) {
          const error = new Error("Final approved amount cannot exceed the requested amount.");
          error.statusCode = 400;
          throw error;
        }
        const approvalDate = companyDate();
        const firstDueDate = nextDate(approvalDate, frequency);
        const schedule = makeSchedule(firstDueDate, frequency, installmentAmount, amount);
        if (!schedule.length) {
          const error = new Error("Could not generate a valid repayment schedule.");
          error.statusCode = 400;
          throw error;
        }
        current.status = "Approved";
        current.approvedAmount = amount;
        current.approvedFrequency = frequency;
        current.approvedInstallmentAmount = installmentAmount;
        current.dateApproved = approvalDate;
        current.schedule = schedule;
        current.activity.push(makeActivity("General Manager finalized approval terms", request.authUser, note));
      }
      await current.save({ session });
      await writeAudit(request, current, decision === "Rejected" ? "salary_advance.rejected" : "salary_advance.gm_approved", session, { decision });
      return current;
    });
    if (!advance) return response.status(404).json({ error: "Salary advance not found." });
    return response.json({ advance });
  } catch (error) {
    if (error.statusCode) return response.status(error.statusCode).json({ error: error.message });
    if (isCastError(error)) return response.status(400).json({ error: "Salary advance ID is invalid." });
    throw error;
  }
}

async function recordDisbursement(request, response) {
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["amount", "date", "method", "reference"].includes(key))) {
    return response.status(400).json({ error: "Provide disbursement fields in the supported shape." });
  }
  if (!safeInt(body.amount) || !isDate(body.date) || body.date > companyDate() || !METHODS.includes(body.method)) {
    return response.status(400).json({ error: "Disbursement amount, date, or method is invalid." });
  }
  if (body.reference !== undefined && (typeof body.reference !== "string" || body.reference.trim().length > 160)) return response.status(400).json({ error: "reference must be 160 characters or fewer." });
  try {
    const advance = await withTransaction(async (session) => {
      const current = await SalaryAdvance.findById(request.params.id).session(session);
      if (!current) return null;
      if (current.status !== "Approved" || current.disbursement?.amount) {
        const error = new Error("Only an approved advance without a disbursement can be paid.");
        error.statusCode = 409;
        throw error;
      }
      if (body.amount > current.approvedAmount) {
        const error = new Error("Disbursement cannot exceed the approved amount.");
        error.statusCode = 400;
        throw error;
      }
      current.disbursement = { amount: body.amount, date: body.date, method: body.method, reference: body.reference?.trim(), recordedAt: new Date(), recordedBy: request.authUser._id };
      current.status = "Active";
      current.updatedBy = request.authUser._id;
      current.activity.push(makeActivity("Advance disbursed", request.authUser, `${body.amount} via ${body.method}`));
      await current.save({ session });
      await writeAudit(request, current, "salary_advance.disbursed", session, { amount: body.amount, method: body.method });
      return current;
    });
    if (!advance) return response.status(404).json({ error: "Salary advance not found." });
    return response.json({ advance });
  } catch (error) {
    if (error.statusCode) return response.status(error.statusCode).json({ error: error.message });
    if (isCastError(error)) return response.status(400).json({ error: "Salary advance ID is invalid." });
    throw error;
  }
}

async function addManualRepayment(request, response) {
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["amount", "date", "method", "reference", "note"].includes(key))) {
    return response.status(400).json({ error: "Provide repayment fields in the supported shape." });
  }
  if (!safeInt(body.amount) || !isDate(body.date) || body.date > companyDate() || !METHODS.includes(body.method)) {
    return response.status(400).json({ error: "Repayment amount, date, or method is invalid." });
  }
  if (body.reference !== undefined && (typeof body.reference !== "string" || body.reference.trim().length > 160)) return response.status(400).json({ error: "reference must be 160 characters or fewer." });
  if (body.note !== undefined && (typeof body.note !== "string" || body.note.trim().length > 1000)) return response.status(400).json({ error: "note must be 1,000 characters or fewer." });
  try {
    const advance = await withTransaction(async (session) => {
      const current = await SalaryAdvance.findById(request.params.id).session(session);
      if (!current) return null;
      if (!["Active", "Settled"].includes(current.status) || !current.disbursement) {
        const error = new Error("Repayments can only be recorded after a disbursement.");
        error.statusCode = 409;
        throw error;
      }
      if (body.amount > getBalance(current)) {
        const error = new Error("Repayment cannot exceed the outstanding balance.");
        error.statusCode = 400;
        throw error;
      }
      current.repayments.push({
        amount: body.amount,
        date: body.date,
        method: body.method,
        reference: body.reference?.trim(),
        note: body.note?.trim(),
        recordedBy: request.authUser._id,
      });
      current.status = body.amount === getBalance(current) ? "Settled" : "Active";
      current.updatedBy = request.authUser._id;
      current.activity.push(makeActivity("Repayment recorded", request.authUser, `${body.amount} via ${body.method}`));
      await current.save({ session });
      await writeAudit(request, current, "salary_advance.repaid", session, { amount: body.amount, method: body.method });
      return current;
    });
    if (!advance) return response.status(404).json({ error: "Salary advance not found." });
    return response.json({ advance });
  } catch (error) {
    if (error.statusCode) return response.status(error.statusCode).json({ error: error.message });
    if (isCastError(error)) return response.status(400).json({ error: "Salary advance ID is invalid." });
    throw error;
  }
}

async function recordPayrollRepayments(request, response) {
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["payrollRunId", "payslipId", "employeeId", "periodEnd"].includes(key))) {
    return response.status(400).json({ error: "Provide payroll repayment fields in the supported shape." });
  }
  if (![body.payrollRunId, body.payslipId].every((value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(value))) {
    return response.status(400).json({ error: "Payroll run and payslip IDs are invalid." });
  }
  if (!mongoose.isValidObjectId(body.employeeId) || !isDate(body.periodEnd)) return response.status(400).json({ error: "employeeId or periodEnd is invalid." });
  if (!["Human Resource", "Accountant", "Super Admin"].some((role) => request.authUser.roles.includes(role))) return response.status(403).json({ error: "You do not have permission to post payroll repayments." });

  try {
    const result = await withTransaction(async (session) => {
      const advances = await SalaryAdvance.find({ employeeId: body.employeeId }).session(session);
      const existing = advances.flatMap((advance) => advance.repayments.filter((repayment) => repayment.payrollRunId === body.payrollRunId && repayment.payslipId === body.payslipId).map((repayment) => ({ advance, repayment })));
      if (existing.length) return { repayments: existing, idempotent: true };
      const created = [];
      for (const advance of advances) {
        if (advance.status !== "Active") continue;
        const outstanding = getBalance(advance);
        if (outstanding <= 0) continue;
        const paidScheduleIds = new Set(advance.repayments.flatMap((repayment) => repayment.scheduleEntryIds.map(String)));
        const due = advance.schedule.filter((entry) => entry.dueDate <= body.periodEnd && !paidScheduleIds.has(String(entry._id)));
        let remaining = Math.min(outstanding, due.reduce((sum, entry) => sum + entry.plannedAmount, 0));
        const newRepayments = [];
        for (const entry of due) {
          if (remaining <= 0) break;
          const amount = Math.min(entry.plannedAmount, remaining);
          const idempotencyKey = `${body.payrollRunId}:${body.payslipId}:${advance._id}:${entry._id}`;
          const repayment = {
            amount,
            date: entry.dueDate,
            method: "Payroll",
            reference: `${body.payrollRunId}/${body.payslipId}`,
            recordedBy: request.authUser._id,
            payrollRunId: body.payrollRunId,
            payslipId: body.payslipId,
            scheduleEntryIds: [entry._id],
            idempotencyKey,
          };
          advance.repayments.push(repayment);
          newRepayments.push(repayment);
          remaining -= amount;
        }
        if (!newRepayments.length) continue;
        const repaid = advance.repayments.reduce((sum, item) => sum + item.amount, 0);
        advance.status = repaid >= (advance.disbursement?.amount || 0) ? "Settled" : "Active";
        advance.updatedBy = request.authUser._id;
        advance.activity.push(makeActivity("Payroll repayment recorded", request.authUser, `${body.payrollRunId}/${body.payslipId}`));
        await advance.save({ session });
        await writeAudit(request, advance, "salary_advance.repaid", session, { method: "Payroll", amount: newRepayments.reduce((sum, item) => sum + item.amount, 0), payrollRunId: body.payrollRunId, payslipId: body.payslipId });
        created.push(...newRepayments.map((repayment) => ({ advance, repayment })));
      }
      return { repayments: created, idempotent: false };
    });
    return response.json({
      repayments: result.repayments.map(({ advance, repayment }) => ({
        advanceId: String(advance._id),
        advanceReference: advance.reference,
        amount: repayment.amount,
        date: repayment.date,
        method: repayment.method,
        id: String(repayment._id),
        idempotent: result.idempotent,
      })),
      idempotent: result.idempotent,
    });
  } catch (error) {
    if (isCastError(error)) return response.status(400).json({ error: "Payroll repayment reference is invalid." });
    throw error;
  }
}

module.exports = {
  addManualRepayment,
  companyDate,
  createSalaryAdvance,
  decideGeneralManager,
  decideHr,
  getBalance,
  getSalaryAdvance,
  hasReviewerConflict,
  importLegacySalaryAdvances,
  isDate,
  listSalaryAdvances,
  makeSchedule,
  previewLegacySalaryAdvances,
  recordDisbursement,
  recordPayrollRepayments,
  validateCreate,
  validateDecision,
  validateLegacyAdvance,
};
