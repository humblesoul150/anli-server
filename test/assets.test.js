const assert = require("node:assert/strict");
const { test } = require("node:test");
const mongoose = require("mongoose");
const CompanyAsset = require("../models/companyAsset");
const CompanyAssetEvent = require("../models/companyAssetEvent");
const AuditEvent = require("../models/auditEvent");
const audit = require("../lib/audit");
const cloudinary = require("../configs/cloudinary");
const controller = require("../controllers/companyAssetController");
const assetRouter = require("../routes/assets");

const userId = "507f1f77bcf86cd799439011";
const assetId = "507f1f77bcf86cd799439012";

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function requiredAsset(overrides = {}) {
  return {
    assetTag: " AST-001 ",
    name: "Generator",
    category: "Machinery",
    ...overrides,
  };
}

test("asset schema validates fields and enforces normalized unique tags", () => {
  const asset = new CompanyAsset({
    ...requiredAsset({ assetTag: "AST-001" }),
    assetTagNormalized: "AST-001",
  });
  assert.equal(asset.validateSync(), undefined);
  const indexes = CompanyAsset.schema.indexes();
  assert.ok(indexes.some(([keys, options]) => keys.assetTagNormalized === 1 && options.unique));
  assert.equal(CompanyAsset.schema.path("condition").enumValues.includes("Needs repair"), true);
  assert.equal(CompanyAssetEvent.schema.path("eventType").enumValues.includes("Maintenance completed"), true);
});

test("asset profile validation enforces the closed field allowlist and field boundaries", () => {
  const valid = controller.validateAssetFields(requiredAsset({ acquisitionCost: 0 }));
  assert.equal(valid.error, undefined);
  assert.equal(valid.value.assetTag, "AST-001");
  assert.match(controller.validateAssetFields({ ...requiredAsset(), isAdmin: true }).error, /Unsupported/);
  assert.match(controller.validateAssetFields(requiredAsset({ condition: "Broken" })).error, /condition is invalid/);
  assert.match(controller.validateAssetFields(requiredAsset({ mileage: -1 })).error, /non-negative/);
  assert.match(controller.validateAssetFields(requiredAsset({ name: " " })).error, /name is required/);
  assert.match(controller.validateAssetFields({ assetTag: "A", name: "B", category: "Machinery", photos: [] }).error, /Unsupported/);
});

test("asset event validation accepts actions and rejects invalid or extra fields", () => {
  assert.equal(controller.validateEventPayload({ action: "inspection", condition: "Good" }).value.eventType, "Inspection");
  assert.equal(controller.validateEventPayload({ action: "maintenance-completed", work: "Repair completed" }).value.eventType, "Maintenance completed");
  assert.match(controller.validateEventPayload({ action: "transfer" }).error, /location is required/);
  assert.match(controller.validateEventPayload({ action: "dispose", unexpected: true }).error, /Unsupported/);
  assert.match(controller.validateEventPayload({ action: "inspection", condition: "Broken" }).error, /condition is invalid/);
  const clientPayload = controller.validateEventPayload({
    type: "Transfer",
    date: "2026-04-03",
    fromLocation: "Store",
    toLocation: "Workshop",
    assignee: "Mechanic",
    department: "Engineering",
    reason: "Scheduled move",
    note: "Handle carefully",
  });
  assert.equal(clientPayload.error, undefined);
  assert.equal(clientPayload.value.action, "transfer");
  assert.equal(clientPayload.value.toLocation, "Workshop");
  assert.match(controller.validateEventPayload({
    type: "Maintenance", work: "Repair", provider: "Vendor", cost: -1,
  }).error, /non-negative/);
  assert.equal(controller.validateEventPayload({ type: "Maintenance", work: "Repair" }).error, undefined);
  assert.equal(controller.validateEventPayload({
    type: "Maintenance", work: "Repair", provider: "Vendor",
  }).error, undefined);
  assert.match(controller.validateEventPayload({
    type: "Inspection", condition: "Needs repair",
  }).error, /reason is required/);
  assert.equal(controller.validateEventPayload({
    type: "Inspection", condition: "Unserviceable", reason: "Unsafe",
  }).error, undefined);
  assert.match(controller.validateEventPayload({
    type: "Status change", status: "Under maintenance",
  }).error, /reason is required/);
  assert.equal(controller.validateEventPayload({
    type: "Status change", status: "Under maintenance", reason: "Scheduled",
  }).error, undefined);
  assert.match(controller.validateEventPayload({ type: "Disposed" }).error, /reason is required/);
});

test("asset and event serializers expose client contract fields and date-only values", () => {
  const asset = controller.serializeAsset({
    _id: new mongoose.Types.ObjectId(assetId),
    assetTag: "AST-001",
    assetTagNormalized: "AST-001",
    acquisitionDate: new Date("2026-03-04T00:00:00.000Z"),
    warrantyEnd: null,
    nextInspectionDate: new Date("2026-05-06T00:00:00.000Z"),
    nextServiceDate: null,
    insuranceDueDate: null,
  });
  assert.equal(asset.acquisitionDate, "2026-03-04");
  assert.equal(asset.nextInspectionDate, "2026-05-06");
  const event = controller.serializeEvent({
    _id: new mongoose.Types.ObjectId(),
    assetId: new mongoose.Types.ObjectId(assetId),
    assetTag: "AST-001",
    eventType: "Transfer",
    eventDate: new Date("2026-03-04T16:00:00.000Z"),
    createdAt: new Date("2026-03-04T17:00:00.000Z"),
    actorName: "Inventory Manager",
    fromLocation: "Store",
    toLocation: "Workshop",
    reason: "Relocation",
    note: "Moved safely",
    details: {
      before: { location: "Store", status: "Active" },
      after: { location: "Workshop", status: "Active" },
    },
    work: "",
    provider: "",
    cost: null,
    status: "Active",
    condition: "Good",
  });
  assert.equal(event.type, "Transfer");
  assert.equal(event.date, "2026-03-04");
  assert.equal(event.actor, "Inventory Manager");
  assert.equal(event.recordedAt, "2026-03-04T17:00:00.000Z");
  assert.equal(event.fromLocation, "Store");
  assert.equal(event.toLocation, "Workshop");
  assert.equal(event.reason, "Relocation");
  assert.equal(event.note, "Moved safely");
  assert.deepEqual(event.before, { location: "Store", status: "Active" });
  assert.deepEqual(event.after, { location: "Workshop", status: "Active" });
  assert.equal(event.previousStatus, "Active");
  assert.equal(event.newStatus, "Active");
  assert.equal(event.fromAssignee, "");
  assert.equal(event.toAssignee, "");
  assert.equal("eventType" in event, false);
});

test("asset list pagination and filters are bounded and cursor-safe", async () => {
  const originalFind = CompanyAsset.find;
  let filter;
  CompanyAsset.find = (value) => {
    filter = value;
    return {
      sort() { return this; },
      limit(value) { assert.equal(value, 2); return this; },
      lean: async () => [
        { _id: new mongoose.Types.ObjectId("507f1f77bcf86cd799439021"), assetTag: "A", assetTagNormalized: "A" },
        { _id: new mongoose.Types.ObjectId("507f1f77bcf86cd799439022"), assetTag: "B", assetTagNormalized: "B" },
      ],
    };
  };
  try {
    const res = response();
    await controller.listAssets({ query: { limit: "1", status: "Active", search: "pump" } }, res);
    assert.equal(res.body.assets.length, 1);
    assert.ok(res.body.nextCursor);
    assert.equal(filter.status, "Active");
    assert.ok(filter.$or.length);
    const badLimit = response();
    await controller.listAssets({ query: { limit: "201" } }, badLimit);
    assert.equal(badLimit.statusCode, 400);
    const badCursor = response();
    await controller.listAssets({ query: { cursor: "invalid" } }, badCursor);
    assert.equal(badCursor.statusCode, 400);
  } finally {
    CompanyAsset.find = originalFind;
  }
});

test("asset endpoint role matrix explicitly restricts every read and write", async () => {
  const originalAudit = audit.recordAudit;
  const denied = [];
  audit.recordAudit = async (entry) => denied.push(entry);
  const roles = [
    ["Inventory Manager", true, true],
    ["General Manager", true, false],
    ["Super Admin", true, true],
    ["Admin", true, false],
    ["Production Manager", false, false],
  ];
  try {
    for (const [role, canRead, canWrite] of roles) {
      const request = { authUser: { _id: userId, name: role, roles: [role] }, baseUrl: "/api/assets" };
      let reached = false;
      const readResponse = response();
      await assetRouter.requireAssetAccess(request, readResponse, () => { reached = true; });
      assert.equal(reached, canRead, `${role} read access`);
      if (!canRead) assert.equal(readResponse.statusCode, 403);
      reached = false;
      const writeResponse = response();
      await assetRouter.requireAssetWriter(request, writeResponse, () => { reached = true; });
      assert.equal(reached, canWrite, `${role} write access`);
      if (!canWrite) assert.equal(writeResponse.statusCode, 403);
    }
    assert.ok(denied.every((entry) => entry.eventType === "security.authorization_denied"));
  } finally {
    audit.recordAudit = originalAudit;
  }
});

test("duplicate normalized asset tags return 409 without persisting", async () => {
  const originalStartSession = mongoose.startSession;
  const originalSave = CompanyAsset.prototype.save;
  mongoose.startSession = async () => ({
    withTransaction: async (callback) => callback(),
    endSession: async () => {},
  });
  CompanyAsset.prototype.save = async () => {
    const error = new Error("duplicate");
    error.code = 11000;
    throw error;
  };
  try {
    const res = response();
    await controller.createAsset({
      body: requiredAsset(), authUser: { _id: userId, name: "Inventory", roles: ["Inventory Manager"] },
    }, res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /already exists/);
  } finally {
    mongoose.startSession = originalStartSession;
    CompanyAsset.prototype.save = originalSave;
  }
});

test("asset event action updates state and writes an actor-attributed immutable event and audit", async () => {
  const originalStartSession = mongoose.startSession;
  const originalFindById = CompanyAsset.findById;
  const originalEventCreate = CompanyAssetEvent.create;
  const originalAudit = audit.recordAudit;
  const asset = {
    _id: new mongoose.Types.ObjectId(assetId),
    assetTag: "AST-001",
    status: "Active",
    location: "Main",
    assignee: "",
    department: "",
    photos: [],
    save: async () => asset,
  };
  let createdEvent;
  let recordedAudit;
  mongoose.startSession = async () => ({
    withTransaction: async (callback) => callback(),
    endSession: async () => {},
  });

  CompanyAsset.findById = () => ({ session: async () => asset });
  CompanyAssetEvent.create = async ([event]) => {
    createdEvent = event;
    return [{ ...event, _id: new mongoose.Types.ObjectId() }];
  };
  audit.recordAudit = async (event) => { recordedAudit = event; };
  try {
    const res = response();
    await controller.recordAssetEvent({
      params: { id: assetId },
      body: {
        type: "Transfer", fromLocation: "Main", toLocation: "Workshop",
        assignee: "Mechanic", department: "Engineering", reason: "Move", note: "Relocated",
      },
      authUser: { _id: new mongoose.Types.ObjectId(userId), name: "Inventory Manager" },
    }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(asset.location, "Workshop");
    assert.equal(asset.assignee, "Mechanic");
    assert.equal(asset.department, "Engineering");
    assert.equal(createdEvent.eventType, "Transfer");
    assert.equal(createdEvent.fromLocation, "Main");
    assert.equal(createdEvent.toLocation, "Workshop");
    assert.equal(createdEvent.reason, "Move");
    assert.equal(String(createdEvent.actorId), userId);
    assert.equal(createdEvent.actorName, "Inventory Manager");
    assert.equal(recordedAudit.eventType, "asset.event_recorded");
    assert.equal(res.body.event.type, "Transfer");
  } finally {
    mongoose.startSession = originalStartSession;
    CompanyAsset.findById = originalFindById;
    CompanyAssetEvent.create = originalEventCreate;
    audit.recordAudit = originalAudit;
  }
});

test("asset lifecycle prevents invalid maintenance and disposed transitions", async () => {
  const originalStartSession = mongoose.startSession;
  const originalFindById = CompanyAsset.findById;
  const originalEventCreate = CompanyAssetEvent.create;
  const originalAudit = audit.recordAudit;
  const asset = {
    _id: new mongoose.Types.ObjectId(assetId),
    assetTag: "AST-001",
    status: "Active",
    condition: "Good",
    location: "Main",
    assignee: "",
    department: "",
    photos: [],
    save: async () => asset,
  };
  let createdEvents = 0;
  mongoose.startSession = async () => ({
    withTransaction: async (callback) => callback(),
    endSession: async () => {},
  });
  CompanyAsset.findById = () => ({ session: async () => asset });
  CompanyAssetEvent.create = async ([event]) => {
    createdEvents += 1;
    return [{ ...event, _id: new mongoose.Types.ObjectId() }];
  };
  audit.recordAudit = async () => {};
  try {
    const request = (payload) => ({
      params: { id: assetId },
      body: payload,
      authUser: { _id: new mongoose.Types.ObjectId(userId), name: "Inventory Manager" },
    });
    const badCompletion = response();
    await assert.rejects(
      controller.recordAssetEvent(request({ action: "maintenance-completed", work: "Repair" }), badCompletion),
      (error) => error.statusCode === 409,
    );
    assert.equal(createdEvents, 0);
    asset.status = "Disposed";
    const afterDisposal = response();
    await assert.rejects(
      controller.recordAssetEvent(request({ action: "inspection", condition: "Good" }), afterDisposal),
      (error) => error.statusCode === 409,
    );
    assert.equal(createdEvents, 0);
  } finally {
    mongoose.startSession = originalStartSession;
    CompanyAsset.findById = originalFindById;
    CompanyAssetEvent.create = originalEventCreate;
    audit.recordAudit = originalAudit;
  }
});

test("legacy asset import is idempotent, matches historical events by tag, and reports invalid records", async () => {
  const originalStartSession = mongoose.startSession;
  const originalFind = CompanyAsset.find;
  const originalSave = CompanyAsset.prototype.save;
  const originalEventCreate = CompanyAssetEvent.create;
  const originalEventExists = CompanyAssetEvent.exists;
  const originalAudit = audit.recordAudit;
  const stored = [];
  const events = [];
  let auditDetails;
  mongoose.startSession = async () => ({
    withTransaction: async (callback) => callback(),
    endSession: async () => {},
  });
  CompanyAsset.find = () => ({
    select() { return this; },
    session() { return this; },
    lean: async () => stored.map(({ _id, assetTag, assetTagNormalized }) => ({ _id, assetTag, assetTagNormalized })),
  });
  CompanyAsset.prototype.save = async function save() {
    this._id = this._id || new mongoose.Types.ObjectId();
    stored.push(this);
    return this;
  };
  CompanyAssetEvent.create = async ([event]) => {
    events.push(event);
    return [event];
  };
  CompanyAssetEvent.exists = (filter) => ({
    session: async () => events.some((event) => event.importKey === filter.importKey) ? { _id: true } : null,
  });
  audit.recordAudit = async (entry) => { auditDetails = entry.details; };
  const request = {
    authUser: { _id: new mongoose.Types.ObjectId(userId), name: "Importer" },
    body: {
      assets: [requiredAsset({ assetTag: "Legacy-1" }), requiredAsset({ assetTag: " legacy-1 " }), { assetTag: "bad" }],
      events: [
        { assetTag: "LEGACY-1", eventType: "Inspection", date: "2026-01-01", condition: "Good" },
        { assetTag: "LEGACY-1", eventType: "Inspection", invalidField: true },
      ],
    },
  };
  try {
    const first = response();
    await controller.importAssets(request, first);
    assert.equal(first.body.imported, 1);
    assert.equal(first.body.importedEvents, 1);
    assert.equal(first.body.duplicates, 1);
    assert.equal(first.body.rejected.length, 2);
    assert.match(first.body.rejected[0].reason, /name is required/);
    assert.equal(first.body.rejected[0].assetTag, "bad");
    assert.equal(first.body.rejected[1].assetTag, "LEGACY-1");
    assert.match(first.body.rejected[1].reason, /Unsupported event field: invalidField/);
    assert.equal(auditDetails.imported, 1);
    assert.equal(auditDetails.importedAssets, 1);
    assert.equal(auditDetails.importedEvents, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].assetTag, "Legacy-1");
    const second = response();
    await controller.importAssets(request, second);
    assert.equal(second.body.imported, 0);
    assert.equal(second.body.importedEvents, 0);
    assert.equal(second.body.duplicates, 3);
    assert.equal(second.body.rejected.length, 2);
    assert.equal(stored.length, 1);
    assert.equal(events.length, 1);
  } finally {
    mongoose.startSession = originalStartSession;
    CompanyAsset.find = originalFind;
    CompanyAsset.prototype.save = originalSave;
    CompanyAssetEvent.create = originalEventCreate;
    CompanyAssetEvent.exists = originalEventExists;
    audit.recordAudit = originalAudit;
  }
});

test("legacy import accepts client AssetEvent shape and never trusts its actor", async () => {
  const originalStartSession = mongoose.startSession;
  const originalFind = CompanyAsset.find;
  const originalSave = CompanyAsset.prototype.save;
  const originalEventCreate = CompanyAssetEvent.create;
  const originalEventExists = CompanyAssetEvent.exists;
  const originalAudit = audit.recordAudit;
  const stored = [];
  let eventCreated;
  mongoose.startSession = async () => ({
    withTransaction: async (callback) => callback(),
    endSession: async () => {},
  });
  CompanyAsset.find = () => ({
    select() { return this; },
    session() { return this; },
    lean: async () => stored.map(({ _id, assetTag, assetTagNormalized }) => ({ _id, assetTag, assetTagNormalized })),
  });
  CompanyAsset.prototype.save = async function save() {
    this._id = this._id || new mongoose.Types.ObjectId();
    stored.push(this);
    return this;
  };
  CompanyAssetEvent.exists = () => ({ session: async () => null });
  CompanyAssetEvent.create = async ([event]) => {
    eventCreated = event;
    return [event];
  };
  audit.recordAudit = async () => {};
  try {
    const res = response();
    await controller.importAssets({
      authUser: { _id: new mongoose.Types.ObjectId(userId), name: "Trusted importer" },
      body: {
        assets: [requiredAsset({ assetTag: "LEGACY-EVENT" })],
        events: [{
          assetTag: "LEGACY-EVENT",
          type: "Transfer",
          date: "2026-04-03",
          actor: "Untrusted legacy actor",
          fromLocation: "Store",
          toLocation: "Workshop",
          reason: "Relocation",
          note: "Moved",
        }],
      },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.imported, 1);
    assert.equal(res.body.importedEvents, 1);
    assert.equal(eventCreated.eventType, "Transfer");
    assert.equal(eventCreated.fromLocation, "Store");
    assert.equal(eventCreated.toLocation, "Workshop");
    assert.equal(eventCreated.reason, "Relocation");
    assert.equal(eventCreated.note, "Moved");
    assert.equal(eventCreated.actorName, "Trusted importer");
  } finally {
    mongoose.startSession = originalStartSession;
    CompanyAsset.find = originalFind;
    CompanyAsset.prototype.save = originalSave;
    CompanyAssetEvent.create = originalEventCreate;
    CompanyAssetEvent.exists = originalEventExists;
    audit.recordAudit = originalAudit;
  }
});

test("frontend legacy asset IDs associate events and repeated imports count duplicates", async () => {
  const originalStartSession = mongoose.startSession;
  const originalFind = CompanyAsset.find;
  const originalSave = CompanyAsset.prototype.save;
  const originalEventCreate = CompanyAssetEvent.create;
  const originalEventExists = CompanyAssetEvent.exists;
  const originalAudit = audit.recordAudit;
  const stored = [];
  const storedEvents = [];
  mongoose.startSession = async () => ({
    withTransaction: async (callback) => callback(),
    endSession: async () => {},
  });
  CompanyAsset.find = () => ({
    select() { return this; },
    session() { return this; },
    lean: async () => stored.map(({ _id, assetTag, assetTagNormalized }) => ({ _id, assetTag, assetTagNormalized })),
  });
  CompanyAsset.prototype.save = async function save() {
    this._id = this._id || new mongoose.Types.ObjectId();
    stored.push(this);
    return this;
  };
  CompanyAssetEvent.exists = (filter) => ({
    session: async () => storedEvents.some((event) => event.importKey === filter.importKey) ? { _id: true } : null,
  });
  CompanyAssetEvent.create = async ([event]) => {
    storedEvents.push(event);
    return [event];
  };
  audit.recordAudit = async () => {};
  const legacy = {
    assets: [{
      id: "ASSET-LEGACY-001",
      assetTag: "LEGACY-001",
      name: "Generator",
      category: "Machinery",
      location: "Workshop",
      condition: "Fair",
      status: "Active",
    }],
    events: [{
      id: "ASSET-EVENT-001",
      assetId: "ASSET-LEGACY-001",
      type: "Transfer",
      date: "2026-05-08",
      actor: "Untrusted legacy actor",
      fromLocation: "Store",
      toLocation: "Workshop",
      fromAssignee: "Previous owner",
      toAssignee: "Current owner",
      previousCondition: "Good",
      newCondition: "Fair",
      previousStatus: "Under maintenance",
      newStatus: "Active",
      reason: "Moved",
      note: "Transfer note",
      reference: "REF-001",
      nextInspectionDate: "2026-06-01",
      nextServiceDate: "2026-06-15",
    }],
  };
  try {
    const request = {
      authUser: { _id: new mongoose.Types.ObjectId(userId), name: "Authenticated Importer" },
      body: legacy,
    };
    const first = response();
    await controller.importAssets(request, first);
    assert.deepEqual(first.body, { imported: 1, duplicates: 0, rejected: [], importedEvents: 1 });
    assert.equal(storedEvents.length, 1);
    assert.equal(storedEvents[0].assetTag, "LEGACY-001");
    assert.equal(storedEvents[0].actorName, "Authenticated Importer");
    assert.equal(storedEvents[0].details.before.condition, "Good");
    assert.equal(storedEvents[0].details.after.condition, "Fair");
    assert.equal(storedEvents[0].details.before.status, "Under maintenance");
    assert.equal(storedEvents[0].details.after.status, "Active");
    assert.equal(storedEvents[0].details.before.assignee, "Previous owner");
    assert.equal(storedEvents[0].details.after.assignee, "Current owner");
    assert.equal(storedEvents[0].details.reference, "REF-001");
    assert.equal(storedEvents[0].nextInspectionDate.toISOString().slice(0, 10), "2026-06-01");
    assert.equal(storedEvents[0].nextServiceDate.toISOString().slice(0, 10), "2026-06-15");
    const serialized = controller.serializeEvent({
      ...storedEvents[0],
      _id: new mongoose.Types.ObjectId(),
      createdAt: new Date("2026-05-08T10:00:00.000Z"),
    });
    assert.equal(serialized.previousCondition, "Good");
    assert.equal(serialized.newCondition, "Fair");
    assert.equal(serialized.previousStatus, "Under maintenance");
    assert.equal(serialized.newStatus, "Active");
    assert.equal(serialized.fromAssignee, "Previous owner");
    assert.equal(serialized.toAssignee, "Current owner");
    assert.equal(serialized.reference, "REF-001");
    assert.equal(serialized.nextInspectionDate, "2026-06-01");
    assert.equal(serialized.nextServiceDate, "2026-06-15");
    const second = response();
    await controller.importAssets(request, second);
    assert.deepEqual(second.body, { imported: 0, duplicates: 2, rejected: [], importedEvents: 0 });
    assert.equal(stored.length, 1);
    assert.equal(storedEvents.length, 1);
  } finally {
    mongoose.startSession = originalStartSession;
    CompanyAsset.find = originalFind;
    CompanyAsset.prototype.save = originalSave;
    CompanyAssetEvent.create = originalEventCreate;
    CompanyAssetEvent.exists = originalEventExists;
    audit.recordAudit = originalAudit;
  }
});

test("asset photos validate PNG/JPEG/WebP signatures and audit events are allowlisted", async () => {
  assert.equal(controller.detectImageType(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "image/png");
  assert.equal(controller.detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0])), "image/jpeg");
  assert.equal(controller.detectImageType(Buffer.from("not an image")), null);
  for (const eventType of ["asset.created", "asset.profile_updated", "asset.event_recorded", "asset.imported", "asset.photo_uploaded", "asset.photo_removed"]) {
    assert.ok(AuditEvent.schema.path("eventType").enumValues.includes(eventType));
  }
  assert.equal(typeof cloudinary.uploadImage, "function");
  assert.equal(controller.MAX_PHOTOS, 10);
  const invalidUpload = response();
  await controller.uploadAssetPhoto({
    params: { id: assetId },
    file: { mimetype: "image/jpeg", buffer: Buffer.from("not a jpeg") },
  }, invalidUpload);
  assert.equal(invalidUpload.statusCode, 400);
});
