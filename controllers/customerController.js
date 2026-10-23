const crypto = require("node:crypto");
const Customer = require("../models/customer");
const audit = require("../lib/audit");

const MAX_IMPORT = 200;
const CUSTOMER_FIELDS = [
  "name", "type", "contact", "phone", "email", "region", "district",
  "tin", "country", "referredBy", "notes", "status", "archivedAt",
];
const FIELD_LIMITS = {
  name: 180,
  type: 80,
  contact: 120,
  phone: 40,
  email: 254,
  region: 100,
  district: 100,
  tin: 80,
  country: 100,
  referredBy: 120,
  notes: 2000,
};
const STATUSES = ["Active", "Inactive", "Suspended"];

function strictObject(body, allowed, label) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return `${label} must be a JSON object.`;
  const extra = Object.keys(body).find((key) => !allowed.includes(key));
  return extra ? `Unsupported ${label.toLowerCase()} field: ${extra}.` : "";
}

function customerNameKey(name) {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function validateCustomer(body, { importing = false, partial = false } = {}) {
  const allowed = importing ? ["id", ...CUSTOMER_FIELDS, "createdAt", "purchases"] : CUSTOMER_FIELDS;
  const objectError = strictObject(body, allowed, "Customer");
  if (objectError) return { error: objectError };
  const value = {};

  if (importing) {
    if (typeof body.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(body.id)) {
      return { error: "id must be a valid customer identifier." };
    }
    value.id = body.id;
  }

  for (const field of ["name", "type", "phone"]) {
    if (partial && body[field] === undefined) continue;
    if (typeof body[field] !== "string" || !body[field].trim() || body[field].trim().length > FIELD_LIMITS[field]) {
      return { error: `${field} is required and must be ${FIELD_LIMITS[field]} characters or fewer.` };
    }
    value[field] = body[field].trim();
  }

  for (const [field, max] of Object.entries(FIELD_LIMITS)) {
    if (["name", "type", "phone"].includes(field) || body[field] === undefined) continue;
    if (typeof body[field] !== "string" || body[field].trim().length > max) {
      return { error: `${field} must be text of at most ${max} characters.` };
    }
    value[field] = body[field].trim();
  }

  if (value.email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) return { error: "email must be a valid email address." };
    value.email = value.email.toLocaleLowerCase("en-US");
  }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) return { error: "status is invalid." };
    value.status = body.status;
  } else if (!partial) {
    value.status = "Active";
  }
  if (body.archivedAt !== undefined) {
    if (body.archivedAt !== null && (typeof body.archivedAt !== "string" || Number.isNaN(Date.parse(body.archivedAt)))) {
      return { error: "archivedAt must be a valid date or null." };
    }
    value.archivedAt = body.archivedAt ? new Date(body.archivedAt) : null;
  }
  if (body.createdAt !== undefined && importing) {
    if (typeof body.createdAt !== "string" || Number.isNaN(Date.parse(body.createdAt))) {
      return { error: "createdAt must be a valid date." };
    }
    value.createdAt = new Date(body.createdAt);
  }
  if (body.purchases !== undefined && importing) {
    if (!Number.isSafeInteger(body.purchases) || body.purchases < 0) {
      return { error: "purchases must be a non-negative whole number." };
    }
    value.purchases = body.purchases;
  }
  if (partial && Object.keys(value).length === 0) return { error: "At least one customer field is required." };
  return { value };
}

function serializeCustomer(customer) {
  const value = customer?.toObject ? customer.toObject() : customer;
  return {
    id: String(value.id),
    name: value.name,
    type: value.type,
    contact: value.contact || "",
    phone: value.phone,
    email: value.email || "",
    region: value.region || "",
    district: value.district || "",
    tin: value.tin || "",
    country: value.country || "",
    referredBy: value.referredBy || "",
    createdAt: value.createdAt ? new Date(value.createdAt).toISOString() : undefined,
    notes: value.notes || "",
    archivedAt: value.archivedAt ? new Date(value.archivedAt).toISOString() : undefined,
    status: value.status,
    purchases: value.purchases || 0,
  };
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isDuplicateKey(error) {
  return error?.code === 11000;
}

async function listCustomers(request, response) {
  const allowed = new Set(["limit", "cursor", "search", "status", "archived"]);
  if (Object.keys(request.query).some((key) => !allowed.has(key))) {
    return response.status(400).json({ error: "Unsupported customer filter." });
  }
  if (Object.values(request.query).some((value) => typeof value !== "string")) {
    return response.status(400).json({ error: "Customer filters must be single values." });
  }
  const limit = request.query.limit === undefined ? 200 : Number(request.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return response.status(400).json({ error: "limit must be between 1 and 200." });
  }
  if (request.query.search && (!request.query.search.trim() || request.query.search.length > 100)) {
    return response.status(400).json({ error: "search must contain 1–100 characters." });
  }
  if (request.query.status && !STATUSES.includes(request.query.status)) {
    return response.status(400).json({ error: "status is invalid." });
  }
  if (request.query.archived && !["true", "false"].includes(request.query.archived)) {
    return response.status(400).json({ error: "archived must be true or false." });
  }

  let offset = 0;
  if (request.query.cursor) {
    const decoded = Buffer.from(request.query.cursor, "base64url").toString("utf8");
    offset = Number(decoded);
    if (!Number.isSafeInteger(offset) || offset < 0 || String(offset) !== decoded) {
      return response.status(400).json({ error: "cursor is invalid." });
    }
  }
  const filter = {};
  if (request.query.status) filter.status = request.query.status;
  if (request.query.archived === "true") filter.archivedAt = { $ne: null };
  if (request.query.archived === "false") filter.archivedAt = null;
  if (request.query.search) {
    const escaped = request.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { name: { $regex: escaped, $options: "i" } },
      { id: { $regex: escaped, $options: "i" } },
      { phone: { $regex: escaped, $options: "i" } },
      { email: { $regex: escaped, $options: "i" } },
      { region: { $regex: escaped, $options: "i" } },
      { district: { $regex: escaped, $options: "i" } },
      { tin: { $regex: escaped, $options: "i" } },
    ];
  }

  const records = await Customer.find(filter).sort({ createdAt: -1, _id: -1 }).skip(offset).limit(limit + 1).lean();
  const hasMore = records.length > limit;
  return response.json({
    customers: records.slice(0, limit).map(serializeCustomer),
    nextCursor: hasMore ? Buffer.from(String(offset + limit)).toString("base64url") : null,
  });
}

async function getCustomer(request, response) {
  const customer = await Customer.findOne({ id: request.params.id }).lean();
  if (!customer) return response.status(404).json({ error: "Customer was not found." });
  return response.json({ customer: serializeCustomer(customer) });
}

async function createCustomer(request, response) {
  const validation = validateCustomer(request.body);
  if (validation.error) return response.status(400).json({ error: validation.error });
  const id = `C-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
  try {
    const customer = await Customer.create({
      ...validation.value,
      id,
      nameKey: customerNameKey(validation.value.name),
      createdBy: request.authUser._id,
      updatedBy: request.authUser._id,
    });
    await audit.recordAudit({
      request,
      eventType: "customer.created",
      outcome: "success",
      target: { _id: customer._id, name: customer.name },
      details: { customerId: customer.id, type: customer.type },
    });
    return response.status(201).json({ customer: serializeCustomer(customer) });
  } catch (error) {
    if (isDuplicateKey(error)) return response.status(409).json({ error: "A customer with this ID or normalized name already exists." });
    throw error;
  }
}

async function updateCustomer(request, response) {
  const validation = validateCustomer(request.body, { partial: true });
  if (validation.error) return response.status(400).json({ error: validation.error });
  const update = { ...validation.value, updatedBy: request.authUser._id };
  if (update.name !== undefined) update.nameKey = customerNameKey(update.name);
  let customer;
  try {
    customer = await Customer.findOneAndUpdate(
      { id: request.params.id },
      { $set: update },
      { new: true, runValidators: true },
    );
  } catch (error) {
    if (isDuplicateKey(error)) return response.status(409).json({ error: "A customer with this normalized name already exists." });
    throw error;
  }
  if (!customer) return response.status(404).json({ error: "Customer was not found." });
  await audit.recordAudit({
    request,
    eventType: "customer.updated",
    outcome: "success",
    target: { _id: customer._id, name: customer.name },
    details: { customerId: customer.id, fields: Object.keys(validation.value) },
  });
  return response.json({ customer: serializeCustomer(customer) });
}

async function importLegacyCustomers(request, response) {
  const objectError = strictObject(request.body, ["customers"], "Customer import");
  if (objectError) return response.status(400).json({ error: objectError });
  if (!Array.isArray(request.body.customers) || request.body.customers.length > MAX_IMPORT) {
    return response.status(400).json({ error: `customers must be an array of at most ${MAX_IMPORT} records.` });
  }
  const validated = request.body.customers.map((customer, index) => ({
    index,
    result: validateCustomer(customer, { importing: true }),
  }));
  const invalid = validated.find((item) => item.result.error);
  if (invalid) return response.status(400).json({
    error: `Customer at index ${invalid.index}: ${invalid.result.error}`,
  });

  const imported = [];
  const existing = [];
  const rejected = [];
  for (const { index, result } of validated) {
    const value = result.value;
    if (await Customer.exists({ id: value.id })) {
      existing.push(value.id);
      continue;
    }
    try {
      const customer = await Customer.create({
        ...value,
        nameKey: customerNameKey(value.name),
        createdBy: request.authUser._id,
        updatedBy: request.authUser._id,
      });
      imported.push(serializeCustomer(customer));
    } catch (error) {
      if (isDuplicateKey(error)) {
        rejected.push({ id: value.id, index, reason: "A customer with this normalized name already exists." });
        continue;
      }
      throw error;
    }
  }
  if (imported.length) {
    await audit.recordAudit({
      request,
      eventType: "customer.legacy_imported",
      outcome: "success",
      details: { imported: imported.length, existing: existing.length, rejected: rejected.length },
    });
  }
  return response.status(201).json({ imported, existing, rejected });
}

async function changeCustomerStatus(request, response) {
  const objectError = strictObject(request.body, ["status"], "Customer status");
  if (objectError) return response.status(400).json({ error: objectError });
  if (!STATUSES.includes(request.body?.status)) return response.status(400).json({ error: "status is invalid." });
  const customer = await Customer.findOneAndUpdate(
    { id: request.params.id },
    { $set: { status: request.body.status, updatedBy: request.authUser._id } },
    { new: true, runValidators: true },
  );
  if (!customer) return response.status(404).json({ error: "Customer was not found." });
  await audit.recordAudit({
    request,
    eventType: "customer.status_changed",
    outcome: "success",
    target: { _id: customer._id, name: customer.name },
    details: { customerId: customer.id, status: customer.status },
  });
  return response.json({ customer: serializeCustomer(customer) });
}

async function archiveCustomer(request, response) {
  const objectError = strictObject(request.body, [], "Customer archive");
  if (objectError) return response.status(400).json({ error: objectError });
  const customer = await Customer.findOneAndUpdate(
    { id: request.params.id },
    { $set: { archivedAt: new Date(), updatedBy: request.authUser._id } },
    { new: true },
  );
  if (!customer) return response.status(404).json({ error: "Customer was not found." });
  await audit.recordAudit({
    request,
    eventType: "customer.archived",
    outcome: "success",
    target: { _id: customer._id, name: customer.name },
    details: { customerId: customer.id },
  });
  return response.json({ customer: serializeCustomer(customer) });
}

async function restoreCustomer(request, response) {
  const objectError = strictObject(request.body, [], "Customer restore");
  if (objectError) return response.status(400).json({ error: objectError });
  const customer = await Customer.findOneAndUpdate(
    { id: request.params.id },
    { $set: { archivedAt: null, updatedBy: request.authUser._id } },
    { new: true },
  );
  if (!customer) return response.status(404).json({ error: "Customer was not found." });
  await audit.recordAudit({
    request,
    eventType: "customer.restored",
    outcome: "success",
    target: { _id: customer._id, name: customer.name },
    details: { customerId: customer.id },
  });
  return response.json({ customer: serializeCustomer(customer) });
}

module.exports = {
  archiveCustomer,
  changeCustomerStatus,
  createCustomer,
  customerNameKey,
  getCustomer,
  importLegacyCustomers,
  listCustomers,
  restoreCustomer,
  serializeCustomer,
  updateCustomer,
  validateCustomer,
};
