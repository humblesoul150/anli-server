const mongoose = require("mongoose");
const { createHash, randomUUID } = require("node:crypto");
const CompanyAsset = require("../models/companyAsset");
const CompanyAssetEvent = require("../models/companyAssetEvent");
const { uploadImage, deleteImage } = require("../configs/cloudinary");
const audit = require("../lib/audit");

const CATEGORIES = ["Office assets", "Vehicles", "Production assets", "Store", "Machinery", "Others"];
const CONDITIONS = ["Good", "Fair", "Needs repair", "Unserviceable"];
const STATUSES = ["Active", "Under maintenance", "Disposed"];
const MAX_LIMIT = 200;
const MAX_IMPORT_ASSETS = 500;
const MAX_IMPORT_EVENTS = 2000;
const MAX_PHOTOS = 10;
const PROFILE_FIELDS = [
  "assetTag", "name", "category", "assetType", "makeModel", "serialNumber",
  "registration", "vin", "mileage", "capacity", "productionLine",
  "serviceInterval", "acquisitionDate", "acquisitionCost", "supplier",
  "warrantyEnd", "location", "assignee", "department", "condition", "status",
  "conditionNotes", "nextInspectionDate", "nextServiceDate", "insuranceDueDate", "notes",
];
const STRING_LIMITS = {
  assetTag: 80, name: 160, category: 40, assetType: 100, makeModel: 160,
  serialNumber: 120, registration: 80, vin: 100, capacity: 100,
  productionLine: 120, serviceInterval: 100, supplier: 160, location: 160,
  assignee: 160, department: 120, conditionNotes: 1000, notes: 2000,
};
const DATE_FIELDS = [
  "acquisitionDate", "warrantyEnd", "nextInspectionDate", "nextServiceDate", "insuranceDueDate",
];
const EVENT_ACTIONS = {
  inspection: "Inspection",
  transfer: "Transfer",
  assignment: "Assignment",
  maintenance: "Maintenance",
  "maintenance-completed": "Maintenance completed",
  "status-change": "Status change",
  dispose: "Disposed",
};
const EVENT_FIELDS = new Set([
  "action", "type", "eventType", "eventDate", "date", "title", "description", "work",
  "provider", "reason", "note", "condition",
  "status", "location", "assignee", "department", "cost", "nextInspectionDate",
  "nextServiceDate", "notes", "fromLocation", "toLocation",
]);

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeTag(value) {
  return value.trim().normalize("NFKC").toLocaleUpperCase("en-US");
}

function parseDate(value, field) {
  if (value === null || value === "") return { value: null };
  if (typeof value !== "string" && !(value instanceof Date)) return { error: `${field} must be a valid date or null.` };
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return { error: `${field} must be a valid date or null.` };
  return { value: date };
}

function validateAssetFields(body, { partial = false } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Provide asset fields as a JSON object." };
  const unknown = Object.keys(body).find((key) => !PROFILE_FIELDS.includes(key));
  if (unknown) return { error: `Unsupported asset field: ${unknown}.` };
  if (partial && Object.keys(body).length === 0) return { error: "Provide at least one asset field to update." };
  const result = {};
  for (const [field, value] of Object.entries(body)) {
    if (DATE_FIELDS.includes(field)) {
      const parsed = parseDate(value, field);
      if (parsed.error) return parsed;
      result[field] = parsed.value;
    } else if (field === "mileage" || field === "acquisitionCost") {
      if (value === null || value === "") {
        result[field] = null;
      } else if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        return { error: `${field} must be a non-negative number or null.` };
      } else {
        result[field] = value;
      }
    } else if (["category", "condition", "status"].includes(field)) {
      const options = field === "category" ? CATEGORIES : field === "condition" ? CONDITIONS : STATUSES;
      if (typeof value !== "string" || !options.includes(value)) return { error: `${field} is invalid.` };
      result[field] = value;
    } else {
      if (typeof value !== "string") return { error: `${field} must be text.` };
      const trimmed = value.trim();
      if (trimmed.length > STRING_LIMITS[field]) return { error: `${field} must be ${STRING_LIMITS[field]} characters or fewer.` };
      result[field] = trimmed;
    }
  }
  if (!partial) {
    if (!result.assetTag?.trim()) return { error: "assetTag is required." };
    if (!result.name?.trim()) return { error: "name is required." };
    if (!result.category) return { error: "category is required." };
  }
  if (Object.hasOwn(result, "assetTag") && !result.assetTag) return { error: "assetTag cannot be empty." };
  if (Object.hasOwn(result, "name") && !result.name) return { error: "name cannot be empty." };
  return { value: result };
}

function parseCursor(cursor) {
  if (typeof cursor !== "string" || cursor.length > 100) return null;
  try {
    const id = Buffer.from(cursor, "base64url").toString("utf8");
    return mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(id) : null;
  } catch {
    return null;
  }
}

function encodeCursor(id) {
  return Buffer.from(String(id)).toString("base64url");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function serializeAsset(asset) {
  const value = typeof asset?.toJSON === "function" ? asset.toJSON() : (() => {
    const value = { ...asset, id: String(asset._id) };
    delete value._id;
    delete value.__v;
    delete value.assetTagNormalized;
    return value;
  })();
  for (const field of DATE_FIELDS) {
    const date = value[field];
    value[field] = date ? new Date(date).toISOString().slice(0, 10) : null;
  }
  return value;
}

function dateOnly(value) {
  return value ? new Date(value).toISOString().slice(0, 10) : null;
}

function serializeEvent(event) {
  const value = typeof event?.toObject === "function" ? event.toObject() : { ...event };
  return {
    id: String(value._id),
    assetId: String(value.assetId),
    assetTag: value.assetTag,
    type: value.eventType,
    date: dateOnly(value.eventDate),
    recordedAt: value.createdAt ? new Date(value.createdAt).toISOString() : null,
    actor: value.actorName || "",
    reference: value.details?.reference || "",
    reason: value.reason || "",
    note: value.note || "",
    work: value.work || "",
    provider: value.provider || "",
    cost: value.cost ?? null,
    fromLocation: value.fromLocation || "",
    toLocation: value.toLocation || value.location || "",
    location: value.toLocation || value.location || "",
    assignee: value.assignee || "",
    department: value.department || "",
    status: value.status || null,
    condition: value.condition || null,
    previousCondition: value.details?.before?.condition ?? null,
    newCondition: value.details?.after?.condition ?? value.condition ?? null,
    previousStatus: value.details?.before?.status ?? null,
    newStatus: value.details?.after?.status ?? value.status ?? null,
    fromAssignee: value.details?.before?.assignee ?? "",
    toAssignee: value.details?.after?.assignee ?? value.assignee ?? "",
    nextInspectionDate: dateOnly(value.nextInspectionDate),
    nextServiceDate: dateOnly(value.nextServiceDate),
    before: value.details?.before || null,
    after: value.details?.after || null,
    title: value.title || "",
    description: value.description || "",
  };
}

async function inTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

function createEvent(asset, { eventType, request, session, ...fields }) {
  const actor = request.authUser;
  return CompanyAssetEvent.create([{
    assetId: asset._id,
    assetTag: asset.assetTag,
    eventType,
    eventDate: fields.eventDate || new Date(),
    title: fields.title || "",
    description: fields.description || "",
    work: fields.work || "",
    provider: fields.provider || "",
    reason: fields.reason || "",
    note: fields.note || "",
    fromLocation: fields.fromLocation || "",
    toLocation: fields.toLocation || fields.location || "",
    condition: fields.condition || null,
    status: fields.status || null,
    location: fields.location || "",
    assignee: fields.assignee || "",
    department: fields.department || "",
    cost: fields.cost ?? null,
    nextInspectionDate: fields.nextInspectionDate || null,
    nextServiceDate: fields.nextServiceDate || null,
    actorId: actor._id,
    actorName: actor.name || actor.email || "Unknown",
    details: fields.details || {},
    ...(fields.importKey ? { importKey: fields.importKey } : {}),
  }], { session }).then((events) => events[0]);
}

async function recordAssetAudit(request, eventType, details, session) {
  await audit.recordAudit({ request, eventType, outcome: "success", details, transaction: session });
}

async function listAssets(request, response) {
  const query = request.query || {};
  const allowedQuery = new Set(["limit", "cursor", "category", "condition", "status", "location", "assignee", "search"]);
  const unknown = Object.keys(query).find((key) => !allowedQuery.has(key));
  if (unknown) return response.status(400).json({ error: `Unsupported asset filter: ${unknown}.` });
  const nonScalar = Object.keys(query).find((key) => typeof query[key] !== "string");
  if (nonScalar) return response.status(400).json({ error: `${nonScalar} must be a single value.` });
  const limit = query.limit === undefined ? 100 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return response.status(400).json({ error: `limit must be an integer between 1 and ${MAX_LIMIT}.` });
  }
  const filter = {};
  if (query.category !== undefined) {
    if (!CATEGORIES.includes(query.category)) return response.status(400).json({ error: "category is invalid." });
    filter.category = query.category;
  }
  if (query.condition !== undefined) {
    if (!CONDITIONS.includes(query.condition)) return response.status(400).json({ error: "condition is invalid." });
    filter.condition = query.condition;
  }
  if (query.status !== undefined) {
    if (!STATUSES.includes(query.status)) return response.status(400).json({ error: "status is invalid." });
    filter.status = query.status;
  }
  for (const field of ["location", "assignee"]) {
    if (query[field] !== undefined) {
      if (typeof query[field] !== "string" || query[field].trim().length > 120) {
        return response.status(400).json({ error: `${field} must be 120 characters or fewer.` });
      }
      filter[field] = query[field].trim();
    }
  }
  if (query.search !== undefined) {
    if (typeof query.search !== "string" || query.search.trim().length < 1 || query.search.trim().length > 100) {
      return response.status(400).json({ error: "search must contain 1–100 characters." });
    }
    const regex = new RegExp(escapeRegex(query.search.trim()), "i");
    filter.$or = ["assetTag", "name", "serialNumber", "registration", "vin"].map((field) => ({ [field]: regex }));
  }
  if (query.cursor !== undefined) {
    const cursor = parseCursor(query.cursor);
    if (!cursor) return response.status(400).json({ error: "cursor is invalid." });
    filter._id = { $lt: cursor };
  }
  const results = await CompanyAsset.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const hasMore = results.length > limit;
  const assets = results.slice(0, limit).map(serializeAsset);
  return response.json({ assets, nextCursor: hasMore ? encodeCursor(results[limit - 1]._id) : null });
}

async function getAsset(request, response) {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(400).json({ error: "Asset ID is invalid." });
  const asset = await CompanyAsset.findById(request.params.id).lean();
  if (!asset) return response.status(404).json({ error: "Asset was not found." });
  const events = await CompanyAssetEvent.find({ assetId: asset._id }).sort({ eventDate: -1, _id: -1 }).limit(1000).lean();
  return response.json({ asset: serializeAsset(asset), events: events.map(serializeEvent) });
}

async function createAsset(request, response) {
  const validation = validateAssetFields(request.body);
  if (validation.error) return response.status(400).json({ error: validation.error });
  const values = validation.value;
  const tagNormalized = normalizeTag(values.assetTag);
  try {
    const result = await inTransaction(async (session) => {
      const asset = new CompanyAsset({ ...values, assetTag: values.assetTag.trim(), assetTagNormalized: tagNormalized });
      await asset.save({ session });
      const event = await createEvent(asset, {
        request, session, eventType: "Acquired", eventDate: asset.acquisitionDate || new Date(),
        title: "Asset acquired", description: asset.notes,
      });
      await recordAssetAudit(request, "asset.created", { assetId: String(asset._id), assetTag: asset.assetTag }, session);
      return { asset, event };
    });
    return response.status(201).json({ asset: serializeAsset(result.asset) });
  } catch (error) {
    if (error.code === 11000) return response.status(409).json({ error: "An asset with this assetTag already exists." });
    throw error;
  }
}

async function updateAsset(request, response) {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(400).json({ error: "Asset ID is invalid." });
  const validation = validateAssetFields(request.body, { partial: true });
  if (validation.error) return response.status(400).json({ error: validation.error });
  try {
    const result = await inTransaction(async (session) => {
      const asset = await CompanyAsset.findById(request.params.id).session(session);
      if (!asset) return null;
      Object.assign(asset, validation.value);
      if (Object.hasOwn(validation.value, "assetTag")) {
        asset.assetTag = validation.value.assetTag.trim();
        asset.assetTagNormalized = normalizeTag(asset.assetTag);
      }
      await asset.save({ session });
      const event = await createEvent(asset, {
        request, session, eventType: "Profile correction", title: "Asset profile corrected",
        description: `Updated: ${Object.keys(validation.value).join(", ")}`,
        details: { changedFields: Object.keys(validation.value) },
      });
      await recordAssetAudit(request, "asset.profile_updated", { assetId: String(asset._id), changedFields: Object.keys(validation.value) }, session);
      return { asset, event };
    });
    if (!result) return response.status(404).json({ error: "Asset was not found." });
    return response.json({ asset: serializeAsset(result.asset), event: serializeEvent(result.event) });
  } catch (error) {
    if (error.code === 11000) return response.status(409).json({ error: "An asset with this assetTag already exists." });
    throw error;
  }
}

function validateEventPayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Provide an asset event as a JSON object." };
  const extra = Object.keys(body).find((key) => !EVENT_FIELDS.has(key));
  if (extra) return { error: `Unsupported asset event field: ${extra}.` };
  const requestedType = body.action || body.type || body.eventType;
  const typeToAction = {
    Inspection: "inspection",
    Transfer: "transfer",
    Assignment: "assignment",
    Maintenance: "maintenance",
    "Maintenance completed": "maintenance-completed",
    "Status change": "status-change",
    Disposed: "dispose",
  };
  const action = typeToAction[requestedType] || requestedType;
  if (typeof action !== "string" || !EVENT_ACTIONS[action]) return { error: "action must be a supported asset event action." };
  const value = { action, eventType: EVENT_ACTIONS[action] };
  const date = body.eventDate ?? body.date;
  if (date !== undefined) {
    const parsed = parseDate(date, "eventDate");
    if (parsed.error || !parsed.value) return { error: parsed.error || "eventDate cannot be empty." };
    value.eventDate = parsed.value;
  }
  for (const field of [
    "title", "description", "notes", "work", "provider", "reason", "note",
    "location", "assignee", "department", "fromLocation", "toLocation",
  ]) {
    if (body[field] !== undefined) {
      const maxLength = ["description", "notes", "note", "work"].includes(field)
        ? 1000
        : field === "reason" ? 500 : 160;
      if (typeof body[field] !== "string" || body[field].trim().length > maxLength) {
        return { error: `${field} must be text within its allowed length.` };
      }
      value[field] = body[field].trim();
    }
  }
  if (body.condition !== undefined) {
    if (!CONDITIONS.includes(body.condition)) return { error: "condition is invalid." };
    value.condition = body.condition;
  }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) return { error: "status is invalid." };
    value.status = body.status;
  }
  if (body.cost !== undefined && (typeof body.cost !== "number" || !Number.isFinite(body.cost) || body.cost < 0)) {
    return { error: "cost must be a non-negative number." };
  }
  if (body.cost !== undefined) value.cost = body.cost;
  for (const field of ["nextInspectionDate", "nextServiceDate"]) {
    if (body[field] !== undefined) {
      const parsed = parseDate(body[field], field);
      if (parsed.error) return parsed;
      value[field] = parsed.value;
    }
  }
  if (action === "transfer") {
    value.toLocation = value.toLocation || value.location;
    if (!value.toLocation) return { error: "toLocation or location is required for a transfer." };
  }
  if (action === "assignment" && !value.assignee) return { error: "assignee is required for an assignment." };
  if (action === "status-change" && !value.status) return { error: "status is required for a status change." };
  if (action === "status-change" && !value.reason) return { error: "reason is required for a status change." };
  if (action === "inspection" && !value.condition) return { error: "condition is required for an inspection." };
  if (action === "inspection" &&
      ["Needs repair", "Unserviceable"].includes(value.condition) && !value.reason) {
    return { error: "reason is required for an inspection that identifies an asset needing repair." };
  }
  if (action === "maintenance" && !value.work) {
    return { error: "work is required for maintenance." };
  }
  if (action === "maintenance-completed" && !value.work) {
    return { error: "work is required for maintenance completion." };
  }
  if (action === "dispose" && !value.reason) return { error: "reason is required for disposal." };
  return { value };
}

async function recordAssetEvent(request, response) {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(400).json({ error: "Asset ID is invalid." });
  const validation = validateEventPayload(request.body);
  if (validation.error) return response.status(400).json({ error: validation.error });
  const input = validation.value;
  const result = await inTransaction(async (session) => {
    const asset = await CompanyAsset.findById(request.params.id).session(session);
    if (!asset) return null;
    if (asset.status === "Disposed") {
      throw httpError(409, "A disposed asset cannot receive further events.");
    }
    if (input.action === "maintenance" && asset.status !== "Active") {
      throw httpError(409, "Maintenance can only begin for an active asset.");
    }
    if (input.action === "maintenance-completed" && asset.status !== "Under maintenance") {
      throw httpError(409, "Maintenance can only be completed for an asset under maintenance.");
    }
    if (input.action === "status-change" &&
        asset.status === "Under maintenance" && input.status === "Active") {
      throw httpError(409, "Complete maintenance before changing the asset to Active.");
    }
    if (input.action === "status-change" && input.status === "Disposed") {
      throw httpError(400, "Use the dispose action to dispose an asset.");
    }
    const before = {
      status: asset.status,
      condition: asset.condition,
      location: asset.location,
      assignee: asset.assignee,
      department: asset.department,
    };
    if (input.action === "inspection") {
      asset.condition = input.condition;
      if (input.note !== undefined || input.notes !== undefined) asset.conditionNotes = input.note ?? input.notes;
      if (input.nextInspectionDate !== undefined) asset.nextInspectionDate = input.nextInspectionDate;
    } else if (input.action === "transfer") {
      asset.location = input.toLocation;
      if (input.assignee !== undefined) asset.assignee = input.assignee;
      if (input.department !== undefined) asset.department = input.department;
    } else if (input.action === "assignment") {
      asset.assignee = input.assignee;
      if (input.department !== undefined) asset.department = input.department;
    } else if (input.action === "maintenance") {
      asset.status = "Under maintenance";
      if (input.note !== undefined || input.notes !== undefined) asset.conditionNotes = input.note ?? input.notes;
      if (input.nextServiceDate !== undefined) asset.nextServiceDate = input.nextServiceDate;
    } else if (input.action === "maintenance-completed") {
      asset.status = "Active";
      if (input.condition) asset.condition = input.condition;
      if (input.note !== undefined || input.notes !== undefined) asset.conditionNotes = input.note ?? input.notes;
      if (input.nextServiceDate !== undefined) asset.nextServiceDate = input.nextServiceDate;
    } else if (input.action === "status-change") {
      asset.status = input.status;
    } else if (input.action === "dispose") {
      asset.status = "Disposed";
    }
    await asset.save({ session });
    const event = await createEvent(asset, {
      request, session, eventType: input.eventType, eventDate: input.eventDate,
      title: input.title || input.eventType,
      description: input.description || input.note || input.notes,
      work: input.work, provider: input.provider, reason: input.reason, note: input.note || input.notes,
      condition: input.condition, status: asset.status,
      location: input.toLocation || input.location || asset.location, toLocation: input.toLocation || input.location || asset.location,
      fromLocation: input.fromLocation || before.location,
      assignee: input.assignee || asset.assignee,
      department: input.department || asset.department, cost: input.cost,
      nextInspectionDate: input.nextInspectionDate, nextServiceDate: input.nextServiceDate,
      details: { before, after: {
        status: asset.status, condition: asset.condition, location: asset.location,
        assignee: asset.assignee, department: asset.department,
      } },
    });
    await recordAssetAudit(request, "asset.event_recorded", {
      assetId: String(asset._id), eventType: input.eventType,
    }, session);
    return { asset, event };
  });
  if (!result) return response.status(404).json({ error: "Asset was not found." });
  return response.status(201).json({ asset: serializeAsset(result.asset), event: serializeEvent(result.event) });
}

function validateImportedEvent(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const allowed = new Set([
    "assetTag", "assetId", "asset", "id", "_id", "eventType", "type", "eventDate", "date", "title",
    "description", "notes", "condition", "status", "location", "fromLocation",
    "toLocation", "assignee", "department", "cost", "reason", "note", "work",
    "provider", "reference", "actor", "actorId", "actorName", "recordedAt", "fromAssignee",
    "toAssignee", "previousCondition", "newCondition", "previousStatus", "newStatus",
    "nextInspectionDate", "nextServiceDate",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return null;
  const eventTypeAliases = {
    acquisition: "Acquired",
    acquired: "Acquired",
    inspection: "Inspection",
    transfer: "Transfer",
    assignment: "Assignment",
    maintenance: "Maintenance",
    "status-change": "Status change",
    "status change": "Status change",
    disposed: "Disposed",
    disposal: "Disposed",
    "profile correction": "Profile correction",
    "maintenance completed": "Maintenance completed",
    "maintenance-completed": "Maintenance completed",
  };
  const rawType = body.eventType || body.type;
  const eventType = eventTypeAliases[String(rawType || "").toLocaleLowerCase("en-US")] || rawType;
  if (!CompanyAssetEvent.schema.path("eventType").enumValues.includes(eventType)) return null;
  const eventDate = body.eventDate ?? body.date ?? new Date();
  const parsedDate = parseDate(eventDate, "eventDate");
  if (parsedDate.error || !parsedDate.value) return null;
  const description = body.description ?? body.notes ?? "";
  if (typeof description !== "string" || description.length > 1000) return null;
  if (body.title !== undefined && (typeof body.title !== "string" || body.title.length > 160)) return null;
  const textFields = [
    "reason", "note", "work", "provider", "reference", "fromLocation", "toLocation",
    "fromAssignee", "toAssignee", "location", "assignee", "department",
  ];
  const limits = {
    reason: 500, note: 1000, work: 1000, provider: 160, reference: 120,
    fromLocation: 160, toLocation: 160, fromAssignee: 160, toAssignee: 160,
    location: 160, assignee: 160, department: 120,
  };
  if (textFields.some((field) => body[field] !== undefined &&
      (typeof body[field] !== "string" || body[field].trim().length > limits[field]))) return null;
  if (body.condition !== undefined && !CONDITIONS.includes(body.condition)) return null;
  if (body.status !== undefined && !STATUSES.includes(body.status)) return null;
  if (body.previousCondition !== undefined && !CONDITIONS.includes(body.previousCondition)) return null;
  if (body.newCondition !== undefined && !CONDITIONS.includes(body.newCondition)) return null;
  if (body.previousStatus !== undefined && !STATUSES.includes(body.previousStatus)) return null;
  if (body.newStatus !== undefined && !STATUSES.includes(body.newStatus)) return null;
  if (body.cost !== undefined &&
      (typeof body.cost !== "number" || !Number.isFinite(body.cost) || body.cost < 0)) return null;
  const dateOnlyFields = {};
  for (const field of ["nextInspectionDate", "nextServiceDate"]) {
    if (body[field] !== undefined) {
      const parsed = parseDate(body[field], field);
      if (parsed.error) return null;
      dateOnlyFields[field] = parsed.value;
    }
  }
  return {
    eventType,
    eventDate: parsedDate.value,
    title: typeof body.title === "string" ? body.title.slice(0, 160) : eventType,
    description: description.trim(),
    condition: CONDITIONS.includes(body.condition) ? body.condition : null,
    status: STATUSES.includes(body.status) ? body.status : null,
    location: typeof (body.toLocation || body.location) === "string" ? (body.toLocation || body.location).slice(0, 160) : "",
    fromLocation: typeof body.fromLocation === "string" ? body.fromLocation.trim() : "",
    toLocation: typeof (body.toLocation || body.location) === "string" ? (body.toLocation || body.location).trim() : "",
    assignee: body.assignee || "",
    department: body.department || "",
    cost: body.cost ?? null,
    reason: body.reason || "",
    note: body.note || "",
    work: body.work || "",
    provider: body.provider || "",
    reference: body.reference || "",
    fromAssignee: body.fromAssignee || "",
    toAssignee: body.toAssignee || "",
    details: {
      before: {
        ...(body.previousCondition !== undefined ? { condition: body.previousCondition } : {}),
        ...(body.previousStatus !== undefined ? { status: body.previousStatus } : {}),
        ...(body.fromAssignee !== undefined ? { assignee: body.fromAssignee } : {}),
        ...(body.fromLocation !== undefined ? { location: body.fromLocation } : {}),
      },
      after: {
        ...(body.newCondition !== undefined ? { condition: body.newCondition } : {}),
        ...(body.newStatus !== undefined ? { status: body.newStatus } : {}),
        ...(body.toAssignee !== undefined ? { assignee: body.toAssignee } : {}),
        ...((body.toLocation || body.location) !== undefined ? { location: body.toLocation || body.location } : {}),
      },
      ...(body.reference ? { reference: body.reference } : {}),
    },
    ...dateOnlyFields,
  };
}

async function importAssets(request, response) {
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some((key) => !["assets", "events"].includes(key)) ||
      !Array.isArray(body.assets) || !Array.isArray(body.events || [])) {
    return response.status(400).json({ error: "Provide assets and events arrays for import." });
  }
  if (body.assets.length > MAX_IMPORT_ASSETS || (body.events || []).length > MAX_IMPORT_EVENTS) {
    return response.status(400).json({ error: `Import is limited to ${MAX_IMPORT_ASSETS} assets and ${MAX_IMPORT_EVENTS} events.` });
  }
  const report = { imported: 0, duplicates: 0, rejected: [], importedEvents: 0 };
  const rejectRow = (record, reason) => {
    const assetTag = typeof record?.assetTag === "string" && record.assetTag.trim()
      ? record.assetTag.trim().slice(0, 80)
      : undefined;
    report.rejected.push({
      ...(assetTag ? { assetTag } : {}),
      reason: String(reason || "The record is invalid.").slice(0, 300),
    });
  };
  const validAssets = [];
  const legacyAssetRefs = [];
  const seen = new Set();
  for (const input of body.assets) {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some((key) => ![...PROFILE_FIELDS, "id", "_id"].includes(key))) {
      rejectRow(input, "Asset must be an object containing only supported asset fields.");
      continue;
    }
    const { id: legacyId, _id: legacyObjectId, ...profile } = input;
    const checked = validateAssetFields(profile);
    if (checked.error) {
      rejectRow(input, checked.error);
      continue;
    }
    const tagNormalized = normalizeTag(checked.value.assetTag);
    const legacyIds = [legacyId, legacyObjectId]
      .filter((value) => typeof value === "string" && value.trim().length > 0 && value.length <= 120)
      .map((value) => value.trim());
    legacyAssetRefs.push({ tagNormalized, legacyIds });
    if (seen.has(tagNormalized)) {
      report.duplicates += 1;
      continue;
    }
    seen.add(tagNormalized);
    validAssets.push({ values: checked.value, tagNormalized });
  }
  try {
    await inTransaction(async (session) => {
      const eventTags = (body.events || [])
        .filter((event) => typeof event?.assetTag === "string" && event.assetTag.trim().length <= 80)
        .map((event) => normalizeTag(event.assetTag));
      const eventAssetIds = (body.events || [])
        .filter((event) => typeof (event?.assetId || event?.asset) === "string" && mongoose.isValidObjectId(event.assetId || event.asset))
        .map((event) => new mongoose.Types.ObjectId(event.assetId || event.asset));
      const tagFilters = [...new Set([...validAssets.map((item) => item.tagNormalized), ...eventTags])];
      const existing = tagFilters.length || eventAssetIds.length
        ? await CompanyAsset.find({
          $or: [
            ...(tagFilters.length ? [{ assetTagNormalized: { $in: tagFilters } }] : []),
            ...(eventAssetIds.length ? [{ _id: { $in: eventAssetIds } }] : []),
          ],
        }).select("_id assetTag assetTagNormalized").session(session).lean()
        : [];
      const existingTags = new Set(existing.map((asset) => asset.assetTagNormalized));
      const assetByTag = new Map(existing.map((asset) => [asset.assetTagNormalized, asset]));
      const assetById = new Map(existing.map((asset) => [String(asset._id), asset]));
      const assetByLegacyId = new Map();
      const importable = validAssets.filter((item) => {
        if (existingTags.has(item.tagNormalized)) {
          report.duplicates += 1;
          return false;
        }
        return true;
      });
      const importedAssets = [];
      for (const item of importable) {
        const asset = new CompanyAsset({
          ...item.values,
          assetTag: item.values.assetTag.trim(),
          assetTagNormalized: item.tagNormalized,
        });
        await asset.save({ session });
        importedAssets.push(asset);
        assetByTag.set(item.tagNormalized, asset);
      }
      for (const item of legacyAssetRefs) {
        const matchingAsset = assetByTag.get(item.tagNormalized);
        if (matchingAsset) {
          for (const legacyId of item.legacyIds) assetByLegacyId.set(legacyId, matchingAsset);
        }
      }
      let importedEventCount = 0;
      for (const input of body.events || []) {
        const event = validateImportedEvent(input);
        if (!event) {
          const knownFields = new Set([
            "assetTag", "assetId", "asset", "id", "_id", "eventType", "type", "eventDate", "date", "title",
            "description", "notes", "condition", "status", "location", "fromLocation", "toLocation",
            "assignee", "department", "cost", "reason", "note", "work", "provider", "reference",
            "actor", "actorId", "actorName", "recordedAt", "fromAssignee", "toAssignee",
            "previousCondition", "newCondition", "previousStatus", "newStatus",
            "nextInspectionDate", "nextServiceDate",
          ]);
          const unsupported = input && typeof input === "object" && !Array.isArray(input)
            ? Object.keys(input).find((key) => !knownFields.has(key))
            : null;
          rejectRow(input, unsupported
            ? `Unsupported event field: ${unsupported}.`
            : "Event type, date, or field values are invalid.");
          continue;
        }
        const assetReference = input.assetId || input.asset;
        const asset = typeof input.assetTag === "string" && input.assetTag.trim().length <= 80
          ? assetByTag.get(normalizeTag(input.assetTag))
          : typeof assetReference === "string" && assetByLegacyId.has(assetReference.trim())
            ? assetByLegacyId.get(assetReference.trim())
            : typeof assetReference === "string" && mongoose.isValidObjectId(assetReference)
              ? assetById.get(String(new mongoose.Types.ObjectId(assetReference)))
              : null;
        if (!asset) {
          rejectRow(input, "Event does not reference an imported or existing asset.");
          continue;
        }
        const stableEventValue = {
          assetTag: normalizeTag(asset.assetTag),
          sourceId: input.id || input._id || "",
          eventType: event.eventType,
          eventDate: event.eventDate.toISOString(),
          title: event.title,
          description: event.description,
          condition: event.condition,
          status: event.status,
          location: event.location,
          assignee: event.assignee,
          department: event.department,
          cost: event.cost,
          reason: event.reason,
          note: event.note,
          work: event.work,
          provider: event.provider,
          reference: event.reference,
          fromLocation: event.fromLocation,
          toLocation: event.toLocation,
          details: event.details,
        };
        const importKey = createHash("sha256").update(JSON.stringify(stableEventValue)).digest("hex");
        if (await CompanyAssetEvent.exists({ importKey }).session(session)) {
          report.duplicates += 1;
          continue;
        }
        await createEvent(asset, {
          ...event, request, session, importKey,
          details: { ...event.details, imported: true },
        });
        importedEventCount += 1;
      }
      report.imported = importedAssets.length;
      report.importedEvents = importedEventCount;
      if (importedAssets.length || importedEventCount) {
        await recordAssetAudit(request, "asset.imported", {
          imported: report.imported, importedAssets: importedAssets.length,
          importedEvents: importedEventCount,
          duplicates: report.duplicates, rejected: report.rejected.length,
        }, session);
      }
    });
  } catch (error) {
    if (error.code === 11000) return response.status(409).json({ error: "An asset with this assetTag already exists; no import changes were committed." });
    throw error;
  }
  return response.status(200).json(report);
}

function detectImageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

async function uploadAssetPhoto(request, response) {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(400).json({ error: "Asset ID is invalid." });
  const file = request.file;
  if (!file) return response.status(400).json({ error: "Choose a PNG, JPEG, or WebP photo." });
  const signatureType = detectImageType(file.buffer);
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.mimetype) || signatureType !== file.mimetype) {
    return response.status(400).json({ error: "The uploaded file is not a valid PNG, JPEG, or WebP image." });
  }
  const exists = await CompanyAsset.exists({ _id: request.params.id });
  if (!exists) return response.status(404).json({ error: "Asset was not found." });
  const photo = await uploadImage(file.buffer, {
    folder: "anli/company-assets",
    publicId: `asset-${request.params.id}-${randomUUID()}`,
  });
  let updated;
  try {
    updated = await inTransaction(async (session) => {
      const asset = await CompanyAsset.findById(request.params.id).session(session);
      if (!asset) return null;
      if (asset.photos.length >= MAX_PHOTOS) throw httpError(409, `An asset may have at most ${MAX_PHOTOS} photos.`);
      asset.photos.push({ id: randomUUID(), ...photo, uploadedAt: new Date() });
      await asset.save({ session });
      await recordAssetAudit(request, "asset.photo_uploaded", { assetId: String(asset._id), photoCount: asset.photos.length }, session);
      return asset;
    });
  } catch (error) {
    try { await deleteImage(photo.publicId); } catch (cleanupError) {
      console.error("Unable to clean up an unreferenced asset photo:", cleanupError);
    }
    throw error;
  }
  if (!updated) {
    await deleteImage(photo.publicId);
    return response.status(404).json({ error: "Asset was not found." });
  }
  return response.status(201).json({ asset: serializeAsset(updated) });
}

async function deleteAssetPhoto(request, response) {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(400).json({ error: "Asset ID is invalid." });
  if (typeof request.params.photoId !== "string" || request.params.photoId.length > 80) {
    return response.status(400).json({ error: "Photo ID is invalid." });
  }
  const result = await inTransaction(async (session) => {
    const asset = await CompanyAsset.findById(request.params.id).session(session);
    if (!asset) return { missingAsset: true };
    const index = asset.photos.findIndex((item) => item.id === request.params.photoId);
    if (index < 0) return { missingPhoto: true };
    const [photo] = asset.photos.splice(index, 1);
    await asset.save({ session });
    await recordAssetAudit(request, "asset.photo_removed", { assetId: String(asset._id), photoId: photo.id }, session);
    return { asset, publicId: photo.publicId };
  });
  if (result.missingAsset) return response.status(404).json({ error: "Asset was not found." });
  if (result.missingPhoto) return response.status(404).json({ error: "Asset photo was not found." });
  try {
    await deleteImage(result.publicId);
  } catch (error) {
    console.error("Unable to remove the deleted asset photo from Cloudinary:", error);
  }
  return response.json({ asset: serializeAsset(result.asset) });
}

module.exports = {
  CATEGORIES,
  CONDITIONS,
  EVENT_ACTIONS,
  MAX_IMPORT_ASSETS,
  MAX_LIMIT,
  MAX_PHOTOS,
  STATUSES,
  createAsset,
  deleteAssetPhoto,
  detectImageType,
  getAsset,
  importAssets,
  listAssets,
  parseCursor,
  recordAssetEvent,
  serializeAsset,
  serializeEvent,
  updateAsset,
  uploadAssetPhoto,
  validateAssetFields,
  validateEventPayload,
};
