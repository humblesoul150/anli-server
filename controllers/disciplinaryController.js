const mongoose = require("mongoose");
const crypto = require("node:crypto");
const DisciplinaryCase = require("../models/disciplinaryCase");
const DisciplinaryPolicy = require("../models/disciplinaryPolicy");
const Employee = require("../models/employee");
const User = require("../models/user");
const audit = require("../lib/audit");
const { cloudinary, uploadPdf, deleteAsset } = require("../configs/cloudinary");
const { hasAnyDepartmentRole } = require("../lib/authorization");

const LETTER_TYPES = ["Written warning", "Suspension", "Termination"];
const APPROVAL_STAGES = ["Human Resource", "General Manager", "Super Admin"];
const ALLOWED_CASE_STATUSES = [
  "Draft",
  "Under investigation",
  "Awaiting employee response",
  "Pending Human Resource approval",
  "Pending General Manager approval",
  "Pending Super Admin approval",
  "Changes requested",
  "Approved",
  "Issued",
  "Closed",
  "Rescinded",
];
const CASE_FIELDS = new Set([
  "employeeId",
  "type",
  "incidentDate",
  "allegation",
  "reason",
  "expectations",
  "reviewDate",
  "suspensionStartDate",
  "suspensionEndDate",
  "returnDate",
  "suspensionPayStatus",
  "conditions",
  "effectiveDate",
  "noticeDetails",
  "handoverDetails",
  "signatory",
  "responseRequired",
  "responseDueDate",
  "responseNotice",
  "assignedApprovers",
]);
const DEFAULT_RESPONSE_RULES = Object.freeze({
  "Written warning": { required: true, responseWindowDays: 5 },
  Suspension: { required: true, responseWindowDays: 5 },
  Termination: { required: true, responseWindowDays: 5 },
});

function isHr(user) {
  return hasAnyDepartmentRole(user, ["Human Resource"]);
}

function hasDisciplinaryRole(user) {
  return hasAnyDepartmentRole(user, ["Human Resource", "General Manager", "Admin"]);
}

function isValidDate(value) {
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

function addCalendarDays(value, days) {
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function policyValue(policy) {
  const rules = policy?.responseRules instanceof Map
    ? Object.fromEntries(policy.responseRules)
    : policy?.responseRules || {};
  return {
    responseRules: Object.fromEntries(LETTER_TYPES.map((type) => [
      type,
      { ...DEFAULT_RESPONSE_RULES[type], ...(rules[type] || {}) },
    ])),
  };
}

function validatePolicy(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some((key) => key !== "responseRules")
    || !body.responseRules || typeof body.responseRules !== "object" || Array.isArray(body.responseRules)
    || Object.keys(body.responseRules).some((type) => !LETTER_TYPES.includes(type))) {
    return { error: "Provide responseRules for supported letter types only." };
  }
  const responseRules = {};
  for (const [type, rule] of Object.entries(body.responseRules)) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)
      || Object.keys(rule).some((key) => !["required", "responseWindowDays"].includes(key))
      || typeof rule.required !== "boolean"
      || !Number.isInteger(rule.responseWindowDays) || rule.responseWindowDays < 1 || rule.responseWindowDays > 60) {
      return { error: `The ${type} response rule must include required and responseWindowDays (1-60).` };
    }
    responseRules[type] = rule;
  }
  if (Object.keys(responseRules).length !== LETTER_TYPES.length) {
    return { error: "Configure an employee-response rule for every letter type." };
  }
  return { value: { responseRules } };
}

function validateCaseFields(body, partial = false) {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some((key) => !CASE_FIELDS.has(key))) {
    return { error: "Provide disciplinary case fields in the supported request shape." };
  }
  const value = {};
  const textFields = {
    allegation: 3000,
    reason: 3000,
    expectations: 3000,
    conditions: 3000,
    noticeDetails: 3000,
    handoverDetails: 3000,
    signatory: 180,
    responseNotice: 3000,
  };
  for (const [field, max] of Object.entries(textFields)) {
    if (!(field in body)) continue;
    if (typeof body[field] !== "string" || body[field].trim().length > max
      || (["allegation", "reason", "signatory"].includes(field) && !body[field].trim())) {
      return { error: `${field} is required and must be ${max} characters or fewer.` };
    }
    value[field] = body[field].trim();
  }
  if ((!partial && typeof body.employeeId !== "string")
    || (body.employeeId !== undefined && !mongoose.isValidObjectId(body.employeeId))) {
    return { error: "employeeId must reference a valid employee." };
  }
  if (body.employeeId !== undefined) value.employeeId = body.employeeId;
  if (body.type !== undefined && !LETTER_TYPES.includes(body.type)) return { error: "Select a supported disciplinary letter type." };
  if (!partial && !LETTER_TYPES.includes(body.type)) return { error: "Select a supported disciplinary letter type." };
  if (body.type !== undefined) value.type = body.type;
  for (const field of ["incidentDate", "reviewDate", "suspensionStartDate", "suspensionEndDate", "returnDate", "effectiveDate", "responseDueDate"]) {
    if (!(field in body)) continue;
    if (body[field] !== "" && body[field] !== null && !isValidDate(body[field])) return { error: `${field} must be a valid YYYY-MM-DD date.` };
    value[field] = body[field] || undefined;
  }
  if (body.suspensionPayStatus !== undefined) {
    if (!["Paid", "Unpaid", "Not specified"].includes(body.suspensionPayStatus)) return { error: "suspensionPayStatus is invalid." };
    value.suspensionPayStatus = body.suspensionPayStatus;
  }
  if (body.responseRequired !== undefined) {
    if (typeof body.responseRequired !== "boolean") return { error: "responseRequired must be true or false." };
    value.responseRequired = body.responseRequired;
  }
  if (body.assignedApprovers !== undefined) {
    const reviewers = body.assignedApprovers;
    if (!reviewers || typeof reviewers !== "object" || Array.isArray(reviewers)
      || Object.keys(reviewers).some((key) => !["humanResource", "generalManager", "superAdmin"].includes(key))
      || ["humanResource", "generalManager", "superAdmin"].some((key) => !mongoose.isValidObjectId(reviewers[key]))) {
      return { error: "Assign active HR, General Manager, and Super Admin accounts as approvers." };
    }
    if (new Set(Object.values(reviewers).map(String)).size !== 3) {
      return { error: "Assign three different accounts for the HR, General Manager, and Super Admin approval stages." };
    }
    value.assignedApprovers = reviewers;
  }
  if (!partial) {
    if (!value.assignedApprovers) {
      return { error: "Assign active HR, General Manager, and Super Admin accounts as approvers." };
    }
    for (const field of ["employeeId", "type", "incidentDate", "allegation", "reason", "signatory", "assignedApprovers"]) {
      if (!(field in value)) return { error: `${field} is required.` };
    }
  }
  const type = value.type || body.type;
  if (type === "Written warning" && (value.expectations ?? body.expectations)?.length > 3000) return { error: "expectations is too long." };
  if (type === "Suspension") {
    const start = value.suspensionStartDate ?? body.suspensionStartDate;
    const end = value.suspensionEndDate ?? body.suspensionEndDate;
    if (!isValidDate(start) || !isValidDate(end) || start > end) return { error: "Suspension requires a valid start and end date." };
    const returnDate = value.returnDate ?? body.returnDate;
    if (returnDate && returnDate < end) return { error: "Return date cannot be before the suspension ends." };
  }
  if (type === "Termination" && !isValidDate(value.effectiveDate ?? body.effectiveDate)) {
    return { error: "Termination requires a valid effective date." };
  }
  return { value };
}

function currentApprovalStage(status) {
  if (status === "Pending Human Resource approval") return "Human Resource";
  if (status === "Pending General Manager approval") return "General Manager";
  if (status === "Pending Super Admin approval") return "Super Admin";
  return null;
}

function assignedReviewer(caseRecord, stage) {
  if (stage === "Human Resource") return caseRecord.assignedApprovers.humanResource;
  if (stage === "General Manager") return caseRecord.assignedApprovers.generalManager;
  if (stage === "Super Admin") return caseRecord.assignedApprovers.superAdmin;
  return null;
}

function serializeCase(caseRecord, employeeView = false) {
  const value = caseRecord?.toObject ? caseRecord.toObject() : { ...caseRecord };
  value.id = String(value._id || value.id);
  delete value._id;
  delete value.__v;
  value.employeeId = String(value.employeeId?._id || value.employeeId);
  value.assignedApprovers = Object.fromEntries(Object.entries(value.assignedApprovers || {}).map(([key, id]) => [key, String(id?._id || id)]));
  value.approvals = (value.approvals || []).map((approval) => ({
    ...approval,
    id: String(approval._id),
    actorId: String(approval.actorId),
  }));
  value.evidence = (value.evidence || []).map((item) => {
    const evidence = { ...item, id: String(item._id), uploadedBy: String(item.uploadedBy) };
    delete evidence._id;
    delete evidence.url;
    delete evidence.publicId;
    return evidence;
  });
  value.appeals = (value.appeals || []).map((appeal) => ({ ...appeal, id: String(appeal._id) }));
  value.acknowledgements = (value.acknowledgements || []).map((ack) => ({ ...ack, id: String(ack._id) }));
  if (employeeView) {
    const limited = {
      id: value.id,
      reference: value.reference,
      type: value.type,
      status: value.status,
      employeeName: value.employeeName,
      employeeNumber: value.employeeNumber,
      allegation: value.allegation,
      responseNotice: value.responseNotice,
      responseRequired: value.responseRequired,
      responseDueDate: value.responseDueDate,
      response: value.response,
      noResponseRecordedAt: value.noResponseRecordedAt,
      issuedAt: value.issuedAt,
      issuedLetterVersion: value.issuedLetterVersion,
      incidentDate: value.incidentDate,
      reason: value.status === "Issued" || value.status === "Closed" || value.status === "Rescinded" ? value.reason : undefined,
      expectations: value.status === "Issued" || value.status === "Closed" || value.status === "Rescinded" ? value.expectations : undefined,
      reviewDate: value.reviewDate,
      suspensionStartDate: value.suspensionStartDate,
      suspensionEndDate: value.suspensionEndDate,
      returnDate: value.returnDate,
      suspensionPayStatus: value.suspensionPayStatus,
      conditions: value.conditions,
      effectiveDate: value.effectiveDate,
      noticeDetails: value.noticeDetails,
      handoverDetails: value.handoverDetails,
      signatory: value.signatory,
      acknowledgements: value.acknowledgements,
      appeals: (value.appeals || []).filter((appeal) => String(appeal.submittedBy) === String(value.employeeUserId))
        .map((appeal) => ({ id: appeal.id, text: appeal.text, submittedAt: appeal.submittedAt, resolution: appeal.resolution, resolutionNote: appeal.resolutionNote })),
    };
    return limited;
  }
  delete value.employeeUserId;
  return value;
}

async function recordAuditInTransaction(request, eventType, details, session) {
  await audit.recordAudit({ request, eventType, outcome: "success", details, transaction: session });
}

async function saveCase(request, caseRecord, eventType, details) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await caseRecord.save({ session });
      await recordAuditInTransaction(request, eventType, details, session);
    });
  } catch (error) {
    if (error.name === "VersionError") {
      error.statusCode = 409;
      error.message = "This disciplinary case changed while you were working. Refresh and try again.";
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

async function deny(request, response, reason, resource) {
  await audit.recordAudit({
    request,
    eventType: "security.authorization_denied",
    outcome: "denied",
    reason,
    details: { resource },
  });
  return response.status(403).json({ error: "You do not have permission to access this disciplinary case." });
}

async function getPolicy() {
  return policyValue(await DisciplinaryPolicy.findById("global").lean());
}

async function getAssignedApprovers(value, creatorId, employeeUserId = null) {
  const fields = [
    ["humanResource", "Human Resource"],
    ["generalManager", "General Manager"],
    ["superAdmin", "Super Admin"],
  ];
  const ids = fields.map(([field]) => String(value[field]));
  if (new Set(ids).size !== ids.length
    || ids.includes(String(creatorId))
    || employeeUserId && ids.includes(String(employeeUserId))) {
    return { error: "Assign three different approvers; neither the case creator nor the employee can approve their own case." };
  }
  for (const [field, role] of fields) {
    const user = await User.findOne({ _id: value[field], status: "Active", roles: role }).select("_id");
    if (!user) return { error: `The assigned ${role} approver must be an active account with that role.` };
  }
  return { value };
}

async function listApproverCandidates(request, response) {
  if (!isHr(request.authUser)) return deny(request, response, "disciplinary_hr_required", "disciplinary.approvers");
  const users = await User.find({
    status: "Active",
    roles: { $in: APPROVAL_STAGES },
  }).select("_id name roles").sort({ name: 1 }).lean();
  const candidates = Object.fromEntries(APPROVAL_STAGES.map((role) => [
    role,
    users.filter((user) => user.roles.includes(role)).map((user) => ({
      id: String(user._id),
      name: user.name,
      role,
    })),
  ]));
  return response.json({ candidates });
}

function computeIndicator(caseRecord, today) {
  if (caseRecord.status !== "Issued" || caseRecord.rescindedAt) return null;
  if (caseRecord.type === "Written warning"
    && (!caseRecord.reviewDate || caseRecord.reviewDate >= today)) {
    return { type: caseRecord.type, label: "Active written warning", icon: "flag-outline", reference: caseRecord.reference };
  }
  if (caseRecord.type === "Suspension"
    && caseRecord.suspensionStartDate <= today && caseRecord.suspensionEndDate >= today) {
    return { type: caseRecord.type, label: "Currently suspended", icon: "flag-filled", reference: caseRecord.reference };
  }
  if (caseRecord.type === "Termination" && caseRecord.effectiveDate <= today) {
    return { type: caseRecord.type, label: "Termination effective", icon: "user-x", reference: caseRecord.reference };
  }
  return null;
}

async function listCases(request, response) {
  if (!hasDisciplinaryRole(request.authUser)) return deny(request, response, "disciplinary_read_role_required", "disciplinary.cases");
  const filter = {};
  if (request.query.employeeId !== undefined) {
    if (!mongoose.isValidObjectId(request.query.employeeId)) return response.status(400).json({ error: "employeeId is invalid." });
    filter.employeeId = request.query.employeeId;
  }
  if (request.query.status !== undefined) {
    if (!ALLOWED_CASE_STATUSES.includes(request.query.status)) return response.status(400).json({ error: "status is invalid." });
    filter.status = request.query.status;
  }
  if (request.query.type !== undefined) {
    if (!LETTER_TYPES.includes(request.query.type)) return response.status(400).json({ error: "type is invalid." });
    filter.type = request.query.type;
  }
  if (!isHr(request.authUser) && !request.authUser.roles.includes("Admin")) {
    filter.$or = [
      { "assignedApprovers.humanResource": request.authUser._id },
      { "assignedApprovers.generalManager": request.authUser._id },
      { "assignedApprovers.superAdmin": request.authUser._id },
    ];
  }
  const cases = await DisciplinaryCase.find(filter).sort({ updatedAt: -1, _id: -1 }).limit(200).lean();
  return response.json({ cases: cases.map((item) => serializeCase(item)) });
}

async function getCase(request, response) {
  if (!mongoose.isValidObjectId(request.params.caseId)) return response.status(400).json({ error: "Case ID is invalid." });
  if (!hasDisciplinaryRole(request.authUser)) return deny(request, response, "disciplinary_read_role_required", "disciplinary.cases");
  const filter = { _id: request.params.caseId };
  if (!isHr(request.authUser) && !request.authUser.roles.includes("Admin")) {
    filter.$or = [
      { "assignedApprovers.humanResource": request.authUser._id },
      { "assignedApprovers.generalManager": request.authUser._id },
      { "assignedApprovers.superAdmin": request.authUser._id },
    ];
  }
  const caseRecord = await DisciplinaryCase.findOne(filter);
  if (!caseRecord) return response.status(404).json({ error: "Disciplinary case not found." });
  return response.json({ case: serializeCase(caseRecord) });
}

async function listEmployeeCases(request, response) {
  const employee = await Employee.findOne({ userId: request.authUser._id }).select("_id");
  if (!employee) return response.json({ cases: [] });
  const cases = await DisciplinaryCase.find({
    employeeId: employee._id,
    status: { $in: ["Awaiting employee response", "Under investigation", "Pending Human Resource approval", "Pending General Manager approval", "Pending Super Admin approval", "Approved", "Issued", "Closed", "Rescinded"] },
  }).sort({ updatedAt: -1 }).limit(100).lean();
  return response.json({ cases: cases.map((item) => serializeCase(item, true)) });
}

async function getEmployeeCase(request, response) {
  if (!mongoose.isValidObjectId(request.params.caseId)) return response.status(400).json({ error: "Case ID is invalid." });
  const employee = await Employee.findOne({ userId: request.authUser._id }).select("_id");
  if (!employee) return response.status(404).json({ error: "Disciplinary case not found." });
  const caseRecord = await DisciplinaryCase.findOne({ _id: request.params.caseId, employeeId: employee._id });
  if (!caseRecord || ["Draft", "Changes requested"].includes(caseRecord.status)) return response.status(404).json({ error: "Disciplinary case not found." });
  return response.json({ case: serializeCase(caseRecord, true) });
}

async function createCase(request, response) {
  if (!isHr(request.authUser)) return deny(request, response, "disciplinary_hr_required", "disciplinary.cases");
  const { value, error } = validateCaseFields(request.body);
  if (error) return response.status(400).json({ error });
  const employee = await Employee.findOne({ _id: value.employeeId, status: "Active" });
  if (!employee) return response.status(404).json({ error: "Active employee not found." });
  const assigned = await getAssignedApprovers(value.assignedApprovers, request.authUser._id, employee.userId);
  if (assigned.error) return response.status(400).json({ error: assigned.error });
  const policy = await getPolicy();
  const rule = policy.responseRules[value.type];
  const responseRequired = value.responseRequired ?? rule.required;
  const responseDueDate = value.responseDueDate || addCalendarDays(companyDate(), rule.responseWindowDays);
  const today = companyDate();
  if (responseRequired && (!isValidDate(responseDueDate)
    || responseDueDate <= today
    || responseDueDate > addCalendarDays(today, 60))) {
    return response.status(400).json({ error: "The required responseDueDate must be 1 to 60 calendar days from today." });
  }
  const name = [employee.firstName, employee.secondName, employee.otherNames].filter(Boolean).join(" ") || employee.name;
  const caseRecord = new DisciplinaryCase({
    ...value,
    employeeId: employee._id,
    employeeUserId: employee.userId || null,
    employeeName: name,
    employeeNumber: employee.number,
    department: employee.department,
    role: employee.role,
    responseRequired,
    responseDueDate,
    createdBy: request.authUser._id,
    updatedBy: request.authUser._id,
    reference: `DC-${new Date().getUTCFullYear()}-${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
  });
  await saveCase(request, caseRecord, "disciplinary.case_created", {
    caseId: String(caseRecord._id),
    employeeId: String(employee._id),
    type: caseRecord.type,
  });
  return response.status(201).json({ case: serializeCase(caseRecord) });
}

async function updateCase(request, response) {
  if (!mongoose.isValidObjectId(request.params.caseId)) return response.status(400).json({ error: "Case ID is invalid." });
  if (!isHr(request.authUser)) return deny(request, response, "disciplinary_hr_required", "disciplinary.cases");
  const { value, error } = validateCaseFields(request.body, true);
  if (error) return response.status(400).json({ error });
  if (!Object.keys(value).length) return response.status(400).json({ error: "Provide at least one case field to update." });
  const caseRecord = await DisciplinaryCase.findById(request.params.caseId);
  if (!caseRecord) return response.status(404).json({ error: "Disciplinary case not found." });
  if (!["Draft", "Changes requested", "Under investigation"].includes(caseRecord.status)) {
    return response.status(409).json({ error: "Only a draft or changes-requested case can be edited." });
  }
  if (value.employeeId && String(value.employeeId) !== String(caseRecord.employeeId)) {
    return response.status(400).json({ error: "The employee cannot be changed after case creation." });
  }
  const next = { ...caseRecord.toObject(), ...value };
  const validated = validateCaseFields({
    employeeId: String(caseRecord.employeeId),
    type: next.type,
    incidentDate: next.incidentDate,
    allegation: next.allegation,
    reason: next.reason,
    expectations: next.expectations,
    reviewDate: next.reviewDate,
    suspensionStartDate: next.suspensionStartDate,
    suspensionEndDate: next.suspensionEndDate,
    returnDate: next.returnDate,
    suspensionPayStatus: next.suspensionPayStatus,
    conditions: next.conditions,
    effectiveDate: next.effectiveDate,
    noticeDetails: next.noticeDetails,
    handoverDetails: next.handoverDetails,
    signatory: next.signatory,
    responseRequired: next.responseRequired,
    responseDueDate: next.responseDueDate,
    responseNotice: next.responseNotice,
    assignedApprovers: next.assignedApprovers,
  });
  if (validated.error) return response.status(400).json({ error: validated.error });
  if (value.assignedApprovers) {
    const assigned = await getAssignedApprovers(value.assignedApprovers, caseRecord.createdBy, caseRecord.employeeUserId);
    if (assigned.error) return response.status(400).json({ error: assigned.error });
  }
  const responseResetFields = ["type", "incidentDate", "allegation", "reason"];
  const responseReset = caseRecord.responseRequired
    && Boolean(caseRecord.response?.text || caseRecord.noResponseRecordedAt)
    && responseResetFields.some((field) => value[field] !== undefined && value[field] !== caseRecord[field]);
  Object.assign(caseRecord, value);
  caseRecord.updatedBy = request.authUser._id;
  caseRecord.letterVersion += 1;
  if (responseReset) {
    caseRecord.response = undefined;
    caseRecord.noResponseRecordedAt = undefined;
    caseRecord.noResponseRecordedBy = undefined;
    caseRecord.noResponseNote = "";
    caseRecord.responseNotice = "";
    caseRecord.status = "Draft";
    const policy = await getPolicy();
    caseRecord.responseDueDate = addCalendarDays(
      companyDate(),
      policy.responseRules[caseRecord.type].responseWindowDays,
    );
  }
  if (caseRecord.responseRequired && !caseRecord.responseDueDate) {
    const policy = await getPolicy();
    caseRecord.responseDueDate = addCalendarDays(companyDate(), policy.responseRules[caseRecord.type].responseWindowDays);
  }
  await saveCase(request, caseRecord, "disciplinary.case_updated", {
    caseId: String(caseRecord._id),
    changedFields: Object.keys(value).filter((key) => key !== "reason" && key !== "allegation"),
    letterVersion: caseRecord.letterVersion,
  });
  return response.json({ case: serializeCase(caseRecord) });
}

async function requestEmployeeResponse(request, response) {
  if (!mongoose.isValidObjectId(request.params.caseId)) return response.status(400).json({ error: "Case ID is invalid." });
  if (!isHr(request.authUser)) return deny(request, response, "disciplinary_hr_required", "disciplinary.cases.response");
  const { responseNotice, responseDueDate } = request.body || {};
  if (typeof responseNotice !== "string" || !responseNotice.trim() || responseNotice.trim().length > 3000
    || !isValidDate(responseDueDate) || responseDueDate <= companyDate()
    || responseDueDate > addCalendarDays(companyDate(), 60)) {
    return response.status(400).json({ error: "Provide a response notice and a due date 1 to 60 calendar days from today." });
  }
  const caseRecord = await DisciplinaryCase.findById(request.params.caseId);
  if (!caseRecord) return response.status(404).json({ error: "Disciplinary case not found." });
  if (!caseRecord.responseRequired || !["Draft", "Under investigation", "Changes requested"].includes(caseRecord.status)) {
    return response.status(409).json({ error: "An employee response cannot be requested in this case state." });
  }
  caseRecord.responseNotice = responseNotice.trim();
  caseRecord.responseDueDate = responseDueDate;
  caseRecord.status = "Awaiting employee response";
  caseRecord.updatedBy = request.authUser._id;
  await saveCase(request, caseRecord, "disciplinary.response_requested", {
    caseId: String(caseRecord._id),
    employeeId: String(caseRecord.employeeId),
    dueDate: responseDueDate,
  });
  return response.json({ case: serializeCase(caseRecord) });
}

async function addEmployeeResponse(caseRecord, user, text, source = "Employee portal") {
  const now = new Date();
  const entry = { text: text.trim(), submittedAt: now, submittedBy: user._id, source };
  caseRecord.responseHistory.push(entry);
  caseRecord.response = entry;
  caseRecord.noResponseRecordedAt = undefined;
  caseRecord.noResponseRecordedBy = undefined;
  caseRecord.noResponseNote = "";
  caseRecord.status = "Under investigation";
  caseRecord.updatedBy = user._id;
}

async function submitEmployeeResponse(request, response) {
  if (!mongoose.isValidObjectId(request.params.caseId)) return response.status(400).json({ error: "Case ID is invalid." });
  const text = request.body?.text;
  if (typeof text !== "string" || !text.trim() || text.trim().length > 5000) {
    return response.status(400).json({ error: "A response of 5,000 characters or fewer is required." });
  }
  const employee = await Employee.findOne({ userId: request.authUser._id }).select("_id");
  const caseRecord = employee
    ? await DisciplinaryCase.findOne({ _id: request.params.caseId, employeeId: employee._id })
    : null;
  if (!caseRecord || caseRecord.status !== "Awaiting employee response") return response.status(404).json({ error: "Response window not found." });
  if (caseRecord.responseDueDate < companyDate()) return response.status(409).json({ error: "The response deadline has passed. Contact Human Resource to record an offline response or confirm the deadline outcome." });
  await addEmployeeResponse(caseRecord, request.authUser, text);
  await saveCase(request, caseRecord, "disciplinary.response_submitted", {
    caseId: String(caseRecord._id),
    employeeId: String(employee._id),
    source: "Employee portal",
  });
  return response.json({ case: serializeCase(caseRecord, true) });
}

async function recordOfflineResponse(request, response) {
  if (!mongoose.isValidObjectId(request.params.caseId)) return response.status(400).json({ error: "Case ID is invalid." });
  if (!isHr(request.authUser)) return deny(request, response, "disciplinary_hr_required", "disciplinary.cases.response");
  const { text, source } = request.body || {};
  if (typeof text !== "string" || !text.trim() || text.trim().length > 5000
    || !["In person", "Written externally"].includes(source)) {
    return response.status(400).json({ error: "Provide the employee response and a supported source." });
  }
  const caseRecord = await DisciplinaryCase.findById(request.params.caseId);
  if (!caseRecord || caseRecord.status !== "Awaiting employee response") return response.status(404).json({ error: "Response window not found." });
  await addEmployeeResponse(caseRecord, request.authUser, text, source);
  await saveCase(request, caseRecord, "disciplinary.response_submitted", {
    caseId: String(caseRecord._id),
    employeeId: String(caseRecord.employeeId),
    source,
  });
  return response.json({ case: serializeCase(caseRecord) });
}

async function recordNoResponse(request, response) {
  if (!mongoose.isValidObjectId(request.params.caseId)) return response.status(400).json({ error: "Case ID is invalid." });
  if (!isHr(request.authUser)) return deny(request, response, "disciplinary_hr_required", "disciplinary.cases.response");
  const note = request.body?.note;
  if (typeof note !== "string" || !note.trim() || note.trim().length > 1000) {
    return response.status(400).json({ error: "A factual note is required to record an expired response window." });
  }
  const caseRecord = await DisciplinaryCase.findById(request.params.caseId);
  if (!caseRecord || caseRecord.status !== "Awaiting employee response") return response.status(404).json({ error: "Response window not found." });
  if (!caseRecord.responseDueDate || caseRecord.responseDueDate >= companyDate()) {
    return response.status(409).json({ error: "The response deadline has not passed." });
  }
  caseRecord.noResponseRecordedAt = new Date();
  caseRecord.noResponseRecordedBy = request.authUser._id;
  caseRecord.noResponseNote = note.trim();
  caseRecord.status = "Under investigation";
  caseRecord.updatedBy = request.authUser._id;
  await saveCase(request, caseRecord, "disciplinary.no_response_recorded", {
    caseId: String(caseRecord._id),
    employeeId: String(caseRecord.employeeId),
    dueDate: caseRecord.responseDueDate,
  });
  return response.json({ case: serializeCase(caseRecord) });
}

async function submitForApproval(request, response) {
  if (!mongoose.isValidObjectId(request.params.caseId)) return response.status(400).json({ error: "Case ID is invalid." });
  if (!isHr(request.authUser)) return deny(request, response, "disciplinary_hr_required", "disciplinary.cases.submit");
  const caseRecord = await DisciplinaryCase.findById(request.params.caseId);
  if (!caseRecord) return response.status(404).json({ error: "Disciplinary case not found." });
  if (!["Draft", "Under investigation", "Changes requested"].includes(caseRecord.status)) {
    return response.status(409).json({ error: "This case cannot be submitted for approval in its current state." });
  }
  if (caseRecord.responseRequired && !caseRecord.response?.text && !caseRecord.noResponseRecordedAt) {
    return response.status(409).json({ error: "Record the employee response or wait until the response deadline and document non-response before approval." });
  }
  const assigned = await getAssignedApprovers(caseRecord.assignedApprovers, caseRecord.createdBy, caseRecord.employeeUserId);
  if (assigned.error) return response.status(409).json({ error: assigned.error });
  caseRecord.approvalRound += 1;
  caseRecord.status = "Pending Human Resource approval";
  caseRecord.updatedBy = request.authUser._id;
  await saveCase(request, caseRecord, "disciplinary.case_updated", {
    caseId: String(caseRecord._id),
    action: "submitted_for_approval",
    approvalRound: caseRecord.approvalRound,
  });
  return response.json({ case: serializeCase(caseRecord) });
}

async function decideApproval(request, response) {
  if (!mongoose.isValidObjectId(request.params.caseId)) return response.status(400).json({ error: "Case ID is invalid." });
  const { decision, note = "" } = request.body || {};
  if (!["Approved", "Rejected"].includes(decision) || typeof note !== "string" || note.trim().length > 1000
    || decision === "Rejected" && !note.trim()) {
    return response.status(400).json({ error: "Provide an Approved or Rejected decision and a note for rejection." });
  }
  const caseRecord = await DisciplinaryCase.findById(request.params.caseId);
  if (!caseRecord) return response.status(404).json({ error: "Disciplinary case not found." });
  const stage = currentApprovalStage(caseRecord.status);
  if (!stage) return response.status(409).json({ error: "This case is not awaiting approval." });
  const isSuperAdmin = request.authUser.roles.includes("Super Admin");
  if ((!hasAnyDepartmentRole(request.authUser, [stage]) || !isSuperAdmin && String(assignedReviewer(caseRecord, stage)) !== String(request.authUser._id))) {
    return deny(request, response, "disciplinary_assigned_approver_required", "disciplinary.cases.approvals");
  }
  if (String(caseRecord.createdBy) === String(request.authUser._id)) {
    return response.status(403).json({ error: "The case creator cannot approve their own case." });
  }
  const approvalsThisRound = caseRecord.approvals.filter((item) => item.round === caseRecord.approvalRound);
  if (approvalsThisRound.some((item) => String(item.actorId) === String(request.authUser._id))) {
    return response.status(409).json({ error: "A different account must complete each approval stage." });
  }
  const stageIndex = APPROVAL_STAGES.indexOf(stage);
  if (approvalsThisRound.length !== stageIndex) return response.status(409).json({ error: "Approvals must be completed in order." });
  caseRecord.approvals.push({
    round: caseRecord.approvalRound,
    stage,
    decision,
    actorId: request.authUser._id,
    actorName: request.authUser.name,
    note: note.trim(),
  });
  caseRecord.status = decision === "Rejected"
    ? "Changes requested"
    : stage === "Human Resource"
      ? "Pending General Manager approval"
      : stage === "General Manager"
        ? "Pending Super Admin approval"
        : "Approved";
  caseRecord.updatedBy = request.authUser._id;
  const eventType = decision === "Rejected" ? "disciplinary.rejected" : "disciplinary.approved";
  await saveCase(request, caseRecord, eventType, {
    caseId: String(caseRecord._id),
    employeeId: String(caseRecord.employeeId),
    stage,
    decision,
    approvalRound: caseRecord.approvalRound,
  });
  return response.json({ case: serializeCase(caseRecord) });
}

async function issueCase(request, response) {
  if (!mongoose.isValidObjectId(request.params.caseId)) return response.status(400).json({ error: "Case ID is invalid." });
  if (!isHr(request.authUser)) return deny(request, response, "disciplinary_hr_required", "disciplinary.cases.issue");
  const caseRecord = await DisciplinaryCase.findById(request.params.caseId);
  if (!caseRecord) return response.status(404).json({ error: "Disciplinary case not found." });
  const finalApprovals = caseRecord.approvals.filter((item) => item.round === caseRecord.approvalRound);
  if (caseRecord.status !== "Approved"
    || finalApprovals.length !== APPROVAL_STAGES.length
    || finalApprovals.some((item) => item.decision !== "Approved")
    || finalApprovals.some((item, index) => item.stage !== APPROVAL_STAGES[index])
    || finalApprovals.some((item) => String(item.actorId) !== String(assignedReviewer(caseRecord, item.stage)))
    || new Set(finalApprovals.map((item) => item.stage)).size !== APPROVAL_STAGES.length
    || new Set(finalApprovals.map((item) => String(item.actorId))).size !== APPROVAL_STAGES.length) {
    return response.status(409).json({ error: "All three approval stages must approve the current letter version before issue." });
  }
  caseRecord.status = "Issued";
  caseRecord.issuedAt = new Date();
  caseRecord.issuedBy = request.authUser._id;
  caseRecord.issuedLetterVersion = caseRecord.letterVersion;
  caseRecord.updatedBy = request.authUser._id;
  await saveCase(request, caseRecord, "disciplinary.issued", {
    caseId: String(caseRecord._id),
    employeeId: String(caseRecord.employeeId),
    type: caseRecord.type,
    letterVersion: caseRecord.letterVersion,
  });
  return response.json({ case: serializeCase(caseRecord) });
}

async function acknowledgeLetter(request, response) {
  if (!mongoose.isValidObjectId(request.params.caseId)) return response.status(400).json({ error: "Case ID is invalid." });
  const { status, note = "" } = request.body || {};
  if (!["Received", "Declined", "Disputed"].includes(status) || typeof note !== "string" || note.trim().length > 1000) {
    return response.status(400).json({ error: "Provide a supported acknowledgement status and optional note." });
  }
  const employee = await Employee.findOne({ userId: request.authUser._id }).select("_id");
  const caseRecord = employee
    ? await DisciplinaryCase.findOne({ _id: request.params.caseId, employeeId: employee._id, status: "Issued" })
    : null;
  if (!caseRecord) return response.status(404).json({ error: "Issued letter not found." });
  caseRecord.acknowledgements.push({ status, note: note.trim(), actorId: request.authUser._id });
  caseRecord.updatedBy = request.authUser._id;
  await saveCase(request, caseRecord, "disciplinary.acknowledged", {
    caseId: String(caseRecord._id),
    employeeId: String(employee._id),
    status,
  });
  return response.json({ case: serializeCase(caseRecord, true) });
}

async function submitAppeal(request, response) {
  if (!mongoose.isValidObjectId(request.params.caseId)) return response.status(400).json({ error: "Case ID is invalid." });
  const text = request.body?.text;
  if (typeof text !== "string" || !text.trim() || text.trim().length > 5000) {
    return response.status(400).json({ error: "An appeal statement of 5,000 characters or fewer is required." });
  }
  const employee = await Employee.findOne({ userId: request.authUser._id }).select("_id");
  const caseRecord = employee
    ? await DisciplinaryCase.findOne({ _id: request.params.caseId, employeeId: employee._id, status: { $in: ["Issued", "Closed"] } })
    : null;
  if (!caseRecord) return response.status(404).json({ error: "Appealable letter not found." });
  caseRecord.appeals.push({ text: text.trim(), submittedBy: request.authUser._id });
  caseRecord.updatedBy = request.authUser._id;
  await saveCase(request, caseRecord, "disciplinary.appealed", {
    caseId: String(caseRecord._id),
    employeeId: String(employee._id),
  });
  return response.json({ case: serializeCase(caseRecord, true) });
}

async function resolveAppeal(request, response) {
  if (!mongoose.isValidObjectId(request.params.caseId) || !mongoose.isValidObjectId(request.params.appealId)) {
    return response.status(400).json({ error: "Case or appeal ID is invalid." });
  }
  if (!isHr(request.authUser) && !request.authUser.roles.includes("Super Admin")) {
    return deny(request, response, "disciplinary_appeal_reviewer_required", "disciplinary.cases.appeals");
  }
  const { resolution, note } = request.body || {};
  if (!["Upheld", "Varied", "Overturned"].includes(resolution)
    || typeof note !== "string" || !note.trim() || note.trim().length > 2000) {
    return response.status(400).json({ error: "Provide an appeal resolution and reason." });
  }
  const caseRecord = await DisciplinaryCase.findById(request.params.caseId);
  const appeal = caseRecord?.appeals.id(request.params.appealId);
  if (!appeal) return response.status(404).json({ error: "Appeal not found." });
  if (appeal.resolution) return response.status(409).json({ error: "This appeal has already been resolved." });
  appeal.resolution = resolution;
  appeal.resolvedBy = request.authUser._id;
  appeal.resolvedAt = new Date();
  appeal.resolutionNote = note.trim();
  if (resolution === "Overturned") {
    caseRecord.status = "Rescinded";
    caseRecord.rescindedAt = new Date();
    caseRecord.rescindedBy = request.authUser._id;
    caseRecord.rescindReason = note.trim();
  }
  caseRecord.updatedBy = request.authUser._id;
  await saveCase(request, caseRecord, "disciplinary.appeal_resolved", {
    caseId: String(caseRecord._id),
    appealId: String(appeal._id),
    resolution,
  });
  return response.json({ case: serializeCase(caseRecord) });
}

async function rescindCase(request, response) {
  if (!mongoose.isValidObjectId(request.params.caseId)) return response.status(400).json({ error: "Case ID is invalid." });
  if (!request.authUser.roles.includes("Super Admin")) return deny(request, response, "disciplinary_super_admin_required", "disciplinary.cases.rescind");
  const reason = request.body?.reason;
  if (typeof reason !== "string" || !reason.trim() || reason.trim().length > 1000) {
    return response.status(400).json({ error: "A rescission reason is required." });
  }
  const caseRecord = await DisciplinaryCase.findById(request.params.caseId);
  if (!caseRecord || caseRecord.status !== "Issued") return response.status(404).json({ error: "Issued disciplinary letter not found." });
  caseRecord.status = "Rescinded";
  caseRecord.rescindedAt = new Date();
  caseRecord.rescindedBy = request.authUser._id;
  caseRecord.rescindReason = reason.trim();
  caseRecord.updatedBy = request.authUser._id;
  await saveCase(request, caseRecord, "disciplinary.rescinded", {
    caseId: String(caseRecord._id),
    employeeId: String(caseRecord.employeeId),
    type: caseRecord.type,
  });
  return response.json({ case: serializeCase(caseRecord) });
}

async function listEmployeeIndicators(request, response) {
  if (!hasDisciplinaryRole(request.authUser)) return deny(request, response, "disciplinary_read_role_required", "disciplinary.employee_indicators");
  const today = companyDate();
  const filter = {
    status: "Issued",
    rescindedAt: null,
  };
  if (!isHr(request.authUser) && !request.authUser.roles.includes("Admin")) {
    filter.$or = [
      { "assignedApprovers.humanResource": request.authUser._id },
      { "assignedApprovers.generalManager": request.authUser._id },
      { "assignedApprovers.superAdmin": request.authUser._id },
    ];
  }
  const cases = await DisciplinaryCase.find(filter)
    .select("employeeId reference type status reviewDate suspensionStartDate suspensionEndDate effectiveDate rescindedAt")
    .lean();
  const indicators = {};
  for (const caseRecord of cases) {
    const indicator = computeIndicator(caseRecord, today);
    if (!indicator) continue;
    const employeeId = String(caseRecord.employeeId);
    if (!indicators[employeeId]) indicators[employeeId] = [];
    indicators[employeeId].push(indicator);
  }
  return response.json({ indicators });
}

async function getDisciplinaryPolicy(_request, response) {
  return response.json({ policy: await getPolicy() });
}

async function updateDisciplinaryPolicy(request, response) {
  if (!request.authUser.roles.includes("Super Admin")) return deny(request, response, "disciplinary_super_admin_required", "disciplinary.policy");
  const { value, error } = validatePolicy(request.body);
  if (error) return response.status(400).json({ error });
  const session = await mongoose.startSession();
  let policy;
  try {
    await session.withTransaction(async () => {
      policy = await DisciplinaryPolicy.findByIdAndUpdate("global", {
        $set: { responseRules: value.responseRules, updatedBy: request.authUser._id },
      }, { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true, session });
      await audit.recordAudit({
        request,
        eventType: "disciplinary.policy_updated",
        outcome: "success",
        details: { letterTypes: Object.keys(value.responseRules) },
        transaction: session,
      });
    });
  } finally {
    await session.endSession();
  }
  return response.json({ policy: policyValue(policy) });
}

function supportedEvidence(file) {
  if (!file || !Buffer.isBuffer(file.buffer)) return null;
  if (file.buffer.length >= 5 && file.buffer.toString("ascii", 0, 5) === "%PDF-") return { mediaType: "application/pdf" };
  return null;
}

async function addEvidence(request, response) {
  if (!mongoose.isValidObjectId(request.params.caseId)) return response.status(400).json({ error: "Case ID is invalid." });
  if (!isHr(request.authUser)) return deny(request, response, "disciplinary_hr_required", "disciplinary.cases.evidence");
  const file = request.file;
  if (!supportedEvidence(file)) return response.status(400).json({ error: "Only a valid PDF evidence file is accepted." });
  const caseRecord = await DisciplinaryCase.findById(request.params.caseId);
  if (!caseRecord) return response.status(404).json({ error: "Disciplinary case not found." });
  if (!["Draft", "Under investigation", "Awaiting employee response", "Changes requested"].includes(caseRecord.status)) {
    return response.status(409).json({ error: "Evidence can only be added before the case is approved." });
  }
  if (caseRecord.evidence.length >= 10) return response.status(400).json({ error: "A case can have no more than 10 evidence files." });
  const publicId = `disciplinary-${caseRecord._id}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const asset = await uploadPdf(file.buffer, { folder: "anli/disciplinary-cases", publicId });
  const evidenceName = String(file.originalname || "evidence.pdf")
    .replace(/[\\/\u0000-\u001f\u007f]/g, "_")
    .slice(0, 180) || "evidence.pdf";
  caseRecord.evidence.push({
    name: evidenceName,
    url: asset.url,
    publicId: asset.publicId,
    resourceType: "raw",
    mediaType: "application/pdf",
    sizeBytes: file.size,
    uploadedBy: request.authUser._id,
  });
  caseRecord.updatedBy = request.authUser._id;
  try {
    await saveCase(request, caseRecord, "disciplinary.evidence_uploaded", {
      caseId: String(caseRecord._id),
      evidenceId: String(caseRecord.evidence.at(-1)._id),
      sizeBytes: file.size,
    });
  } catch (error) {
    try {
      await deleteAsset(asset.publicId, "raw", "authenticated");
    } catch (cleanupError) {
      console.error("Unable to clean up unlinked disciplinary evidence:", cleanupError);
    }
    throw error;
  }
  return response.status(201).json({ case: serializeCase(caseRecord) });
}

async function removeEvidence(request, response) {
  if (!mongoose.isValidObjectId(request.params.caseId) || !mongoose.isValidObjectId(request.params.evidenceId)) {
    return response.status(400).json({ error: "Case or evidence ID is invalid." });
  }
  if (!isHr(request.authUser)) return deny(request, response, "disciplinary_hr_required", "disciplinary.cases.evidence");
  const caseRecord = await DisciplinaryCase.findById(request.params.caseId);
  if (!caseRecord) return response.status(404).json({ error: "Disciplinary case not found." });
  if (!["Draft", "Under investigation", "Awaiting employee response", "Changes requested"].includes(caseRecord.status)) {
    return response.status(409).json({ error: "Evidence cannot be removed after approval." });
  }
  const evidence = caseRecord.evidence.id(request.params.evidenceId);
  if (!evidence) return response.status(404).json({ error: "Evidence file not found." });
  const asset = { publicId: evidence.publicId, resourceType: evidence.resourceType };
  const evidenceId = String(evidence._id);
  evidence.deleteOne();
  caseRecord.updatedBy = request.authUser._id;
  await saveCase(request, caseRecord, "disciplinary.evidence_removed", { caseId: String(caseRecord._id), evidenceId });
  try {
    await deleteAsset(asset.publicId, asset.resourceType, "authenticated");
  } catch (error) {
    console.error("Unable to remove disciplinary evidence asset from Cloudinary:", error);
  }
  return response.json({ case: serializeCase(caseRecord) });
}

async function downloadEvidence(request, response) {
  if (!mongoose.isValidObjectId(request.params.caseId) || !mongoose.isValidObjectId(request.params.evidenceId)) {
    return response.status(400).json({ error: "Case or evidence ID is invalid." });
  }
  if (!hasDisciplinaryRole(request.authUser)) return deny(request, response, "disciplinary_read_role_required", "disciplinary.cases.evidence");
  const filter = { _id: request.params.caseId };
  if (!isHr(request.authUser) && !request.authUser.roles.includes("Admin")) {
    filter.$or = [
      { "assignedApprovers.humanResource": request.authUser._id },
      { "assignedApprovers.generalManager": request.authUser._id },
      { "assignedApprovers.superAdmin": request.authUser._id },
    ];
  }
  const caseRecord = await DisciplinaryCase.findOne(filter);
  const evidence = caseRecord?.evidence.id(request.params.evidenceId);
  if (!evidence) return response.status(404).json({ error: "Evidence file not found." });
  const url = cloudinary.utils.private_download_url(evidence.publicId, "pdf", {
    resource_type: "raw",
    type: "authenticated",
    attachment: evidence.name,
    expires_at: Math.floor(Date.now() / 1000) + 120,
  });
  return response.json({ url, expiresInSeconds: 120 });
}

module.exports = {
  ALLOWED_CASE_STATUSES,
  APPROVAL_STAGES,
  DEFAULT_RESPONSE_RULES,
  LETTER_TYPES,
  addCalendarDays,
  computeIndicator,
  createCase,
  decideApproval,
  downloadEvidence,
  getCase,
  getDisciplinaryPolicy,
  getEmployeeCase,
  isValidDate,
  issueCase,
  listCases,
  listEmployeeCases,
  listEmployeeIndicators,
  listApproverCandidates,
  addEvidence,
  acknowledgeLetter,
  recordNoResponse,
  recordOfflineResponse,
  removeEvidence,
  requestEmployeeResponse,
  resolveAppeal,
  rescindCase,
  submitAppeal,
  submitEmployeeResponse,
  submitForApproval,
  updateCase,
  updateDisciplinaryPolicy,
  validateCaseFields,
  validatePolicy,
};
