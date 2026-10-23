const crypto = require("node:crypto");
const mongoose = require("mongoose");
const Expense = require("../models/expense");
const ExpenseEvent = require("../models/expenseEvent");
const PayrollRun = require("../models/payrollRun");
const { cloudinary, uploadImage, deleteAsset } = require("../configs/cloudinary");
const audit = require("../lib/audit");

const CATEGORIES = [
  "Rent and premises", "Utilities", "Production consumables", "Packaging",
  "Repairs and maintenance", "Fuel", "Transport and delivery",
  "Travel and accommodation", "Office supplies and printing",
  "Telephone and internet", "IT and software", "Professional services",
  "Marketing and advertising", "Insurance", "Licenses and compliance fees",
  "Bank and transaction charges", "Staff welfare and training",
  "Cleaning and security", "Tax", "Other",
];
const TAX_TYPES = [
  "Value Added Tax (VAT) - non-recoverable input tax", "Corporation tax",
  "Presumptive tax", "Pay As You Earn (PAYE)", "Withholding tax",
  "Excise duty", "Import / customs duty", "Stamp duty", "Local Service Tax (LST)",
  "Property rates", "Tax penalty or interest", "Other tax",
];
const EXPENSE_TYPES = ["Supplier bill", "Employee reimbursement", "Petty cash / other"];
const PAYMENT_METHODS = ["Cash", "Bank transfer", "Mobile Money", "Cheque"];
const MAX_LIMIT = 200;
const MAX_IMPORT = 500;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function strictObject(body, allowed, label) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return `${label} must be a JSON object.`;
  const extra = Object.keys(body).find((key) => !allowed.includes(key));
  return extra ? `Unsupported ${label.toLowerCase()} field: ${extra}.` : "";
}

function validateExpense(body, { legacy = false } = {}) {
  const error = strictObject(
    body,
    ["category", "taxType", "expenseType", "date", "payee", "description", "department", "amount"],
    "Expense",
  );
  if (error) return { error };
  if (!CATEGORIES.includes(body.category) && !(legacy && body.category === "Payroll")) return { error: "category is invalid." };
  if (!legacy && body.category === "Payroll") return { error: "Salary, wages, and feeding expenses are sourced from approved payroll runs and cannot be entered manually." };
  if (body.category === "Tax") {
    if (!TAX_TYPES.includes(body.taxType)) return { error: "A valid taxType is required for Tax expenses." };
  } else if (body.taxType !== undefined && body.taxType !== null && body.taxType !== "") {
    return { error: "taxType is only allowed for Tax expenses." };
  }
  if (body.expenseType !== undefined && !EXPENSE_TYPES.includes(body.expenseType)) {
    return { error: "expenseType is invalid." };
  }
  if (!validDate(body.date)) return { error: "date must be a valid YYYY-MM-DD date." };
  for (const [field, max] of [["payee", 180], ["description", 2000], ["department", 100]]) {
    if (typeof body[field] !== "string" || !body[field].trim() || body[field].trim().length > max) {
      return { error: `${field} is required and must be ${max} characters or fewer.` };
    }
  }
  if (!Number.isSafeInteger(body.amount) || body.amount < 1 || body.amount > 1_000_000_000_000) {
    return { error: "amount must be a positive whole number of UGX." };
  }
  return {
    value: {
      category: body.category,
      taxType: body.category === "Tax" ? body.taxType : null,
      expenseType: body.expenseType || "Supplier bill",
      date: body.date,
      payee: body.payee.trim(),
      description: body.description.trim(),
      department: body.department.trim(),
      amount: body.amount,
    },
  };
}

function validatePayment(body) {
  const error = strictObject(body, ["amount", "date", "method", "reference", "note"], "Payment");
  if (error) return { error };
  if (!Number.isSafeInteger(body.amount) || body.amount < 1) return { error: "amount must be a positive whole number of UGX." };
  if (!validDate(body.date)) return { error: "date must be a valid YYYY-MM-DD date." };
  if (!PAYMENT_METHODS.includes(body.method)) return { error: "method is invalid." };
  for (const [field, max] of [["reference", 160], ["note", 500]]) {
    if (body[field] !== undefined && (typeof body[field] !== "string" || body[field].trim().length > max)) {
      return { error: `${field} must be text of at most ${max} characters.` };
    }
  }
  return { value: { amount: body.amount, date: body.date, method: body.method, reference: (body.reference || "").trim(), note: (body.note || "").trim() } };
}

function serializeExpense(expense) {
  const value = expense?.toObject ? expense.toObject() : { ...expense };
  const payments = value.payments || [];
  const paidAmount = payments.reduce((sum, item) => sum + item.amount, 0);
  return {
    id: String(value._id || value.id),
    source: "Manual",
    reference: value.reference,
    category: value.category,
    taxType: value.taxType || undefined,
    expenseType: value.expenseType,
    date: value.date,
    payee: value.payee,
    description: value.description,
    department: value.department,
    amount: value.amount,
    status: value.status,
    requestedBy: value.createdByName || "",
    createdAt: value.createdAt ? new Date(value.createdAt).toISOString() : null,
    decidedAt: value.decisions?.at(-1)?.at ? new Date(value.decisions.at(-1).at).toISOString() : null,
    decision: value.decisions?.at(-1) || null,
    decisions: (value.decisions || []).map((decision) => ({
      id: String(decision._id || decision.actorId),
      decision: decision.decision,
      actor: decision.actorName,
      at: new Date(decision.at).toISOString(),
      note: decision.note || "",
    })),
    paidAmount,
    remainingAmount: Math.max(0, value.amount - paidAmount),
    payments: payments.map((payment) => ({
      id: payment.paymentId,
      amount: payment.amount,
      date: payment.date,
      method: payment.method,
      reference: payment.reference || "",
      note: payment.note || "",
      recordedBy: payment.recordedByName,
      recordedAt: new Date(payment.recordedAt).toISOString(),
    })),
    attachments: (value.attachments || []).map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      mediaType: attachment.mediaType,
      sizeBytes: attachment.sizeBytes,
      uploadedAt: attachment.uploadedAt,
    })),
    legacyStatus: value.legacyStatus || undefined,
    legacyAttachments: value.legacyAttachments || [],
  };
}

function payrollExpense(run) {
  const payrollSubtype = run.runType === "Monthly" ? "Salary"
    : run.runType === "Weekly wages" ? "Wages" : "Feeding allowance";
  const amount = (run.payslips || []).reduce(
    (total, payslip) => total + Number(payslip.grossPay || 0) + Number(payslip.employerContributionTotal || 0),
    0,
  );
  return {
    id: `payroll-${run._id}`,
    source: "Payroll",
    sourceRunId: String(run._id),
    reference: run.reference,
    category: "Payroll",
    payrollSubtype,
    date: run.periodEnd,
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
    payee: `Payroll run ${run.reference}`,
    description: `${payrollSubtype} for ${run.periodStart} to ${run.periodEnd}`,
    department: "Multiple",
    amount,
    status: run.status === "Paid" ? "Paid" : "Approved",
    requestedBy: run.createdByName || "",
    createdAt: run.updatedAt ? new Date(run.updatedAt).toISOString() : null,
    decidedAt: run.approvals?.at(-1)?.decidedAt ? new Date(run.approvals.at(-1).decidedAt).toISOString() : null,
    paidAt: run.paidAt || null,
    paidAmount: run.payment?.amount || 0,
    remainingAmount: Math.max(0, amount - (run.payment?.amount || 0)),
    payments: run.payment ? [{
      id: String(run._id),
      amount: run.payment.amount,
      date: run.payment.date,
      method: run.payment.method,
      reference: run.payment.reference || "",
      note: run.payment.note || "",
      recordedBy: run.payment.recordedByName || "",
      recordedAt: run.paidAt ? new Date(run.paidAt).toISOString() : null,
    }] : [],
    attachments: [],
    readOnly: true,
  };
}

async function inTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await work(session); });
    return result;
  } finally {
    await session.endSession();
  }
}

async function appendEvent(expense, request, eventType, details, session) {
  await ExpenseEvent.create([{
    expenseId: expense._id,
    reference: expense.reference,
    eventType,
    actorId: request.authUser._id,
    actorName: request.authUser.name,
    details,
  }], { session });
}

async function recordAudit(request, eventType, expense, details, session) {
  await audit.recordAudit({
    request,
    eventType,
    outcome: "success",
    target: { _id: expense._id, name: expense.reference },
    details: { expenseId: String(expense._id), reference: expense.reference, ...details },
    transaction: session,
  });
}

function dateMatches(item, query) {
  return (!query.from || item.date >= query.from) && (!query.to || item.date <= query.to);
}

async function listExpenses(request, response) {
  const allowed = new Set(["limit", "cursor", "status", "category", "taxType", "department", "from", "to", "search", "source"]);
  if (Object.keys(request.query).some((key) => !allowed.has(key))) return response.status(400).json({ error: "Unsupported expense filter." });
  if (Object.values(request.query).some((value) => typeof value !== "string")) return response.status(400).json({ error: "Expense filters must be single values." });
  const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return response.status(400).json({ error: `limit must be between 1 and ${MAX_LIMIT}.` });
  if (request.query.from && !validDate(request.query.from)) return response.status(400).json({ error: "from must be a valid YYYY-MM-DD date." });
  if (request.query.to && !validDate(request.query.to)) return response.status(400).json({ error: "to must be a valid YYYY-MM-DD date." });
  if (request.query.from && request.query.to && request.query.from > request.query.to) return response.status(400).json({ error: "from cannot be after to." });
  if (request.query.category && request.query.category !== "Payroll" && !CATEGORIES.includes(request.query.category)) return response.status(400).json({ error: "category is invalid." });
  if (request.query.taxType && !TAX_TYPES.includes(request.query.taxType)) return response.status(400).json({ error: "taxType is invalid." });
  if (request.query.status && !["Pending approval", "Approved", "Rejected", "Partially paid", "Paid", "Legacy unverified"].includes(request.query.status)) return response.status(400).json({ error: "status is invalid." });
  if (request.query.source && !["Manual", "Payroll"].includes(request.query.source)) return response.status(400).json({ error: "source is invalid." });
  if (request.query.department && request.query.department.length > 100) return response.status(400).json({ error: "department is too long." });
  if (request.query.search && (!request.query.search.trim() || request.query.search.length > 100)) return response.status(400).json({ error: "search must contain 1–100 characters." });
  let offset = 0;
  if (request.query.cursor) {
    try {
      const decoded = Buffer.from(request.query.cursor, "base64url").toString("utf8");
      offset = Number(decoded);
      if (!Number.isSafeInteger(offset) || offset < 0 || String(offset) !== decoded) throw new Error("invalid");
    } catch {
      return response.status(400).json({ error: "cursor is invalid." });
    }
  }

  const manualFilter = {};
  if (request.query.status) manualFilter.status = request.query.status;
  if (request.query.category && request.query.category !== "Payroll") manualFilter.category = request.query.category;
  if (request.query.taxType) manualFilter.taxType = request.query.taxType;
  if (request.query.department) manualFilter.department = request.query.department;
  if (request.query.from || request.query.to) manualFilter.date = {
    ...(request.query.from ? { $gte: request.query.from } : {}),
    ...(request.query.to ? { $lte: request.query.to } : {}),
  };
  const manualEnabled = request.query.source !== "Payroll" && request.query.category !== "Payroll";
  const payrollEnabled = request.query.source !== "Manual"
    && (!request.query.category || request.query.category === "Payroll")
    && !request.query.taxType
    && (!request.query.department || request.query.department === "Multiple");
  const payrollFilter = { status: { $in: ["Approved", "Paid"] } };
  if (request.query.status) payrollFilter.status = request.query.status;
  if (request.query.from || request.query.to) payrollFilter.periodEnd = {
    ...(request.query.from ? { $gte: request.query.from } : {}),
    ...(request.query.to ? { $lte: request.query.to } : {}),
  };
  const batchSize = 250;
  let manualBuffer = [];
  let payrollBuffer = [];
  let manualRead = 0;
  let payrollRead = 0;
  let manualIndex = 0;
  let payrollIndex = 0;
  let manualDone = !manualEnabled;
  let payrollDone = !payrollEnabled;
  const loadManual = async () => {
    manualBuffer = await Expense.find(manualFilter)
      .sort({ date: -1, reference: -1, _id: -1 })
      .skip(manualRead)
      .limit(batchSize)
      .lean();
    manualRead += manualBuffer.length;
    manualIndex = 0;
    if (manualBuffer.length < batchSize) manualDone = true;
  };
  const loadPayroll = async () => {
    payrollBuffer = await PayrollRun.find(payrollFilter)
      .sort({ periodEnd: -1, reference: -1, _id: -1 })
      .skip(payrollRead)
      .limit(batchSize)
      .lean();
    payrollRead += payrollBuffer.length;
    payrollIndex = 0;
    if (payrollBuffer.length < batchSize) payrollDone = true;
  };
  await Promise.all([
    manualEnabled ? loadManual() : Promise.resolve(),
    payrollEnabled ? loadPayroll() : Promise.resolve(),
  ]);
  const needle = request.query.search?.trim().toLocaleLowerCase("en-US");
  const page = [];
  let matchingOffset = 0;
  const compare = (left, right) => right.date.localeCompare(left.date)
    || right.reference.localeCompare(left.reference)
    || left.source.localeCompare(right.source);
  while (page.length < limit + 1) {
    if (manualEnabled && manualIndex >= manualBuffer.length && !manualDone) await loadManual();
    if (payrollEnabled && payrollIndex >= payrollBuffer.length && !payrollDone) await loadPayroll();
    const manualHead = manualBuffer[manualIndex];
    const payrollHead = payrollBuffer[payrollIndex];
    if (!manualHead && !payrollHead) break;
    const takeManual = !payrollHead || (manualHead && compare(serializeExpense(manualHead), payrollExpense(payrollHead)) <= 0);
    const item = takeManual ? serializeExpense(manualHead) : payrollExpense(payrollHead);
    if (takeManual) manualIndex++;
    else payrollIndex++;
    if (needle && !`${item.reference} ${item.payee} ${item.description} ${item.category} ${item.taxType || ""} ${item.payrollSubtype || ""} ${item.department}`.toLocaleLowerCase("en-US").includes(needle)) continue;
    if (matchingOffset < offset) {
      matchingOffset++;
      continue;
    }
    page.push(item);
  }
  const hasMore = page.length > limit;
  return response.json({
    expenses: page.slice(0, limit),
    nextCursor: hasMore ? Buffer.from(String(offset + limit)).toString("base64url") : null,
  });
}

async function getExpense(request, response) {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(400).json({ error: "Expense ID is invalid." });
  const expense = await Expense.findById(request.params.id).lean();
  if (!expense) return response.status(404).json({ error: "Expense was not found." });
  const events = await ExpenseEvent.find({ expenseId: expense._id }).sort({ createdAt: -1, _id: -1 }).limit(500).lean();
  return response.json({
    expense: serializeExpense(expense),
    events: events.map((event) => ({
      id: String(event._id), type: event.eventType, actor: event.actorName,
      createdAt: event.createdAt, details: event.details,
    })),
  });
}

async function createExpense(request, response) {
  const validation = validateExpense(request.body);
  if (validation.error) return response.status(400).json({ error: validation.error });
  const expense = await inTransaction(async (session) => {
    const document = new Expense({
      ...validation.value,
      reference: `EXP-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
      status: "Pending approval",
      createdBy: request.authUser._id,
      createdByName: request.authUser.name,
    });
    await document.save({ session });
    await appendEvent(document, request, "Created", { category: document.category, amount: document.amount }, session);
    await recordAudit(request, "expense.created", document, { category: document.category, amount: document.amount }, session);
    return document;
  });
  return response.status(201).json({ expense: serializeExpense(expense) });
}

async function decideExpense(request, response) {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(400).json({ error: "Expense ID is invalid." });
  const error = strictObject(request.body, ["decision", "note"], "Decision");
  if (error) return response.status(400).json({ error });
  const { decision, note = "" } = request.body;
  if (!["Approved", "Rejected"].includes(decision)) return response.status(400).json({ error: "decision must be Approved or Rejected." });
  if (typeof note !== "string" || note.trim().length > 1000) return response.status(400).json({ error: "note must be at most 1000 characters." });
  if (decision === "Rejected" && !note.trim()) return response.status(400).json({ error: "A reason is required when rejecting an expense." });
  const result = await inTransaction(async (session) => {
    const expense = await Expense.findById(request.params.id).session(session);
    if (!expense) return { missing: true };
    if (expense.status !== "Pending approval") return { conflict: true };
    expense.status = decision;
    expense.decisions.push({
      decision,
      actorId: request.authUser._id,
      actorName: request.authUser.name,
      at: new Date(),
      note: note.trim(),
    });
    await expense.save({ session });
    const eventType = decision === "Approved" ? "Approved" : "Rejected";
    await appendEvent(expense, request, eventType, { note: note.trim() }, session);
    await recordAudit(request, decision === "Approved" ? "expense.approved" : "expense.rejected", expense, { note: note.trim() }, session);
    return { expense };
  });
  if (result.missing) return response.status(404).json({ error: "Expense was not found." });
  if (result.conflict) return response.status(409).json({ error: "Only an expense awaiting approval can be decided." });
  return response.json({ expense: serializeExpense(result.expense) });
}

async function recordPayment(request, response) {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(400).json({ error: "Expense ID is invalid." });
  const validation = validatePayment(request.body);
  if (validation.error) return response.status(400).json({ error: validation.error });
  const result = await inTransaction(async (session) => {
    const expense = await Expense.findById(request.params.id).session(session);
    if (!expense) return { missing: true };
    if (!["Approved", "Partially paid"].includes(expense.status)) return { conflict: true };
    const paid = expense.payments.reduce((sum, payment) => sum + payment.amount, 0);
    if (validation.value.amount > expense.amount - paid) return { overpayment: true };
    expense.payments.push({
      paymentId: crypto.randomUUID(),
      ...validation.value,
      recordedBy: request.authUser._id,
      recordedByName: request.authUser.name,
      recordedAt: new Date(),
    });
    const newPaid = paid + validation.value.amount;
    expense.status = newPaid === expense.amount ? "Paid" : "Partially paid";
    await expense.save({ session });
    await appendEvent(expense, request, "Payment recorded", { amount: validation.value.amount, paidAmount: newPaid }, session);
    await recordAudit(request, "expense.payment_recorded", expense, { amount: validation.value.amount, paidAmount: newPaid }, session);
    return { expense };
  });
  if (result.missing) return response.status(404).json({ error: "Expense was not found." });
  if (result.conflict) return response.status(409).json({ error: "Only an approved, unpaid expense can receive a payment." });
  if (result.overpayment) return response.status(409).json({ error: "Payment amount exceeds the remaining approved expense balance." });
  return response.status(201).json({ expense: serializeExpense(result.expense) });
}

function detectImageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "";
}

async function uploadAttachment(request, response) {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(400).json({ error: "Expense ID is invalid." });
  const file = request.file;
  if (!file) return response.status(400).json({ error: "Choose a JPG, PNG, or WebP receipt image." });
  const mediaType = detectImageType(file.buffer);
  if (!mediaType || mediaType !== file.mimetype) return response.status(400).json({ error: "The receipt is not a valid JPG, PNG, or WebP image." });
  const exists = await Expense.exists({ _id: request.params.id });
  if (!exists) return response.status(404).json({ error: "Expense was not found." });
  const uploaded = await uploadImage(file.buffer, {
    folder: "anli/expense-receipts",
    publicId: `expense-${request.params.id}-${crypto.randomUUID()}`,
    type: "authenticated",
  });
  try {
    const result = await inTransaction(async (session) => {
      const expense = await Expense.findById(request.params.id).session(session);
      if (!expense) return { missing: true };
      if (expense.status !== "Pending approval") throw httpError(409, "Receipts can only be attached before approval.");
      if (expense.attachments.length >= MAX_ATTACHMENTS) throw httpError(409, `An expense may have at most ${MAX_ATTACHMENTS} receipts.`);
      expense.attachments.push({
        id: crypto.randomUUID(), name: file.originalname.slice(0, 180),
        ...uploaded, mediaType, sizeBytes: file.size, uploadedAt: new Date(),
      });
      await expense.save({ session });
      await appendEvent(expense, request, "Attachment uploaded", { mediaType, sizeBytes: file.size }, session);
      await recordAudit(request, "expense.attachment_uploaded", expense, { mediaType, sizeBytes: file.size }, session);
      return { expense };
    });
    if (result.missing) {
      await deleteAsset(uploaded.publicId, "image", "authenticated");
      return response.status(404).json({ error: "Expense was not found." });
    }
    return response.status(201).json({ expense: serializeExpense(result.expense) });
  } catch (error) {
    try { await deleteAsset(uploaded.publicId, "image", "authenticated"); } catch (cleanupError) {
      console.error("Unable to clean up an unreferenced expense receipt:", cleanupError);
    }
    throw error;
  }
}

async function removeAttachment(request, response) {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(400).json({ error: "Expense ID is invalid." });
  if (typeof request.params.attachmentId !== "string" || request.params.attachmentId.length > 80) return response.status(400).json({ error: "Attachment ID is invalid." });
  const result = await inTransaction(async (session) => {
    const expense = await Expense.findById(request.params.id).session(session);
    if (!expense) return { missing: true };
    if (expense.status !== "Pending approval") return { conflict: true };
    const index = expense.attachments.findIndex((attachment) => attachment.id === request.params.attachmentId);
    if (index < 0) return { missingAttachment: true };
    const [attachment] = expense.attachments.splice(index, 1);
    await expense.save({ session });
    await appendEvent(expense, request, "Attachment removed", { attachmentId: attachment.id }, session);
    await recordAudit(request, "expense.attachment_removed", expense, { attachmentId: attachment.id }, session);
    return { expense, publicId: attachment.publicId };
  });
  if (result.missing) return response.status(404).json({ error: "Expense was not found." });
  if (result.conflict) return response.status(409).json({ error: "Receipts can only be removed before approval." });
  if (result.missingAttachment) return response.status(404).json({ error: "Receipt was not found." });
  try {   await deleteAsset(result.publicId, "image", "authenticated"); } catch (error) {
    console.error("Unable to remove the deleted expense receipt from Cloudinary:", error);
  }
  return response.json({ expense: serializeExpense(result.expense) });
}

async function getAttachmentDownload(request, response) {
  if (!mongoose.isValidObjectId(request.params.id) || typeof request.params.attachmentId !== "string" || request.params.attachmentId.length > 80) {
    return response.status(400).json({ error: "Expense or attachment ID is invalid." });
  }
  const expense = await Expense.findById(request.params.id).lean();
  if (!expense) return response.status(404).json({ error: "Expense was not found." });
  const attachment = (expense.attachments || []).find((item) => item.id === request.params.attachmentId);
  if (!attachment) return response.status(404).json({ error: "Receipt was not found." });
  const extension = attachment.mediaType.split("/")[1];
  const url = cloudinary.utils.private_download_url(attachment.publicId, extension, {
    resource_type: "image",
    type: "authenticated",
    attachment: attachment.name,
    expires_at: Math.floor(Date.now() / 1000) + 120,
  });
  return response.json({ url, expiresInSeconds: 120 });
}

function legacyKey(item) {
  return crypto.createHash("sha256").update(String(item.id || item.reference || `${item.date}:${item.payee}:${item.amount}`)).digest("hex");
}

async function importLegacyExpenses(request, response) {
  const error = strictObject(request.body, ["expenses"], "Legacy import");
  if (error) return response.status(400).json({ error });
  const records = request.body.expenses;
  if (!Array.isArray(records) || records.length > MAX_IMPORT) return response.status(400).json({ error: `expenses must contain at most ${MAX_IMPORT} records.` });
  const imported = [];
  const rejected = [];
  let duplicates = 0;
  await inTransaction(async (session) => {
    for (const [index, item] of records.entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        rejected.push({ index, reason: "Each legacy expense must be an object." });
        continue;
      }
      const validation = validateExpense({
        category: CATEGORIES.includes(item.category) || item.category === "Payroll" ? item.category : "Other",
        taxType: item.category === "Tax" && TAX_TYPES.includes(item.taxType) ? item.taxType : item.category === "Tax" ? undefined : null,
        expenseType: EXPENSE_TYPES.includes(item.expenseType) ? item.expenseType : "Petty cash / other",
        date: item.date,
        payee: item.payee || "Legacy payee not recorded",
        description: item.description || item.reference || "Imported legacy expense",
        department: item.department || "Unassigned",
        amount: item.amount,
      }, { legacy: true });
      if (validation.error) {
        rejected.push({ index, reason: validation.error });
        continue;
      }
      const key = legacyKey(item);
      if (await Expense.exists({ importKey: key }).session(session)) {
        duplicates++;
        continue;
      }
      const document = new Expense({
        ...validation.value,
        reference: typeof item.reference === "string" && item.reference.trim().length <= 42
          ? `LEG-${item.reference.trim()}-${key.slice(0, 6).toUpperCase()}`
          : `LEG-EXP-${key.slice(0, 10).toUpperCase()}`,
        status: "Legacy unverified",
        createdBy: request.authUser._id,
        createdByName: request.authUser.name,
        importKey: key,
        legacyStatus: typeof item.status === "string" ? item.status.slice(0, 60) : "",
        legacyDecisions: Array.isArray(item.decisions) ? item.decisions.slice(0, 20) : [],
        legacyAttachments: Array.isArray(item.attachments)
          ? item.attachments.slice(0, MAX_ATTACHMENTS).map((attachment) => ({
              name: typeof attachment?.name === "string" ? attachment.name.slice(0, 180) : "Legacy receipt",
              mediaType: typeof attachment?.mediaType === "string" ? attachment.mediaType.slice(0, 80) : "",
              sizeBytes: Number.isFinite(attachment?.sizeBytes) ? attachment.sizeBytes : 0,
            }))
          : [],
      });
      await document.save({ session });
      await appendEvent(document, request, "Legacy imported", { legacyStatus: document.legacyStatus }, session);
      imported.push(serializeExpense(document));
    }
    if (imported.length) await audit.recordAudit({
      request,
      eventType: "expense.legacy_imported",
      outcome: "success",
      details: { imported: imported.length, duplicates, rejected: rejected.length },
      transaction: session,
    });
  });
  return response.status(201).json({ imported, duplicates, rejected });
}

module.exports = {
  CATEGORIES,
  EXPENSE_TYPES,
  PAYMENT_METHODS,
  TAX_TYPES,
  createExpense,
  decideExpense,
  getExpense,
  getAttachmentDownload,
  importLegacyExpenses,
  listExpenses,
  payrollExpense,
  recordPayment,
  removeAttachment,
  serializeExpense,
  uploadAttachment,
  validateExpense,
  validatePayment,
};
