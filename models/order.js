const mongoose = require("mongoose");

const orderLineSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "FinishedProduct", default: null },
    productCode: { type: String, trim: true, maxlength: 40, default: "" },
    productName: { type: String, required: true, trim: true, maxlength: 160 },
    packType: { type: String, enum: ["Box", "Carton"], default: null },
    piecesPerPack: { type: Number, min: 1, validate: Number.isInteger, default: null },
    packs: { type: Number, required: true, min: 1, validate: Number.isInteger },
    quantityPieces: { type: Number, min: 1, validate: Number.isInteger, default: null },
    catalogPricePerPack: { type: Number, min: 1, validate: Number.isInteger, default: null },
    pricePerPack: { type: Number, required: true, min: 1, validate: Number.isInteger },
    overrideReason: { type: String, trim: true, maxlength: 500, default: "" },
    lineTotal: { type: Number, required: true, min: 1, validate: Number.isInteger },
  },
  { _id: false },
);

const customerSnapshotSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 180 },
    contact: { type: String, trim: true, maxlength: 120, default: "" },
    phone: { type: String, trim: true, maxlength: 40, default: "" },
    email: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
    address: { type: String, trim: true, maxlength: 500, default: "" },
    tin: { type: String, trim: true, maxlength: 80, default: "" },
  },
  { _id: false },
);

const eventSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, trim: true, maxlength: 40 },
    fromStatus: { type: String, trim: true, default: "" },
    toStatus: { type: String, trim: true, default: "" },
    at: { type: Date, required: true, default: Date.now },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    reason: { type: String, trim: true, maxlength: 500, default: "" },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true, unique: true, trim: true, maxlength: 40 },
    orderYear: { type: Number, required: true, min: 2000, max: 9999 },
    orderSequence: { type: Number, required: true, min: 1, validate: Number.isInteger },
    customerId: { type: String, required: true, trim: true, maxlength: 80 },
    customer: { type: customerSnapshotSchema, required: true },
    items: { type: [orderLineSchema], required: true, validate: { validator: (items) => items.length > 0, message: "An order must contain at least one line." } },
    total: { type: Number, required: true, min: 1, validate: Number.isInteger },
    paidAmount: { type: Number, required: true, min: 0, validate: Number.isInteger, default: 0 },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    requestedDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    fulfilmentMethod: { type: String, enum: ["Delivery", "Pickup"], required: true },
    destination: { type: String, trim: true, maxlength: 500, default: "" },
    paymentTerms: { type: String, enum: ["Paid now", "Same-day", "Credit"], required: true },
    dueDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    status: { type: String, enum: ["Pending", "Confirmed", "In progress", "Ready", "Completed", "Cancelled"], required: true, default: "Pending" },
    statusHistory: { type: [eventSchema], default: [] },
    completedAt: { type: Date, default: null },
    archivedAt: { type: Date, default: null },
    priority: { type: String, enum: ["Normal", "High"], required: true, default: "Normal" },
    priorityReason: { type: String, trim: true, maxlength: 500, default: "" },
    notes: { type: String, trim: true, maxlength: 2000, default: "" },
    reserved: { type: Boolean, required: true, default: false },
    saleId: { type: mongoose.Schema.Types.ObjectId, ref: "Sale" },
    idempotencyKey: { type: String, trim: true, maxlength: 120, unique: true, sparse: true },
    requestHash: { type: String, trim: true, maxlength: 64 },
    legacyId: { type: String, trim: true, maxlength: 100, unique: true, sparse: true },
    legacyImported: { type: Boolean, default: false },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

orderSchema.index({ orderYear: 1, orderSequence: 1 }, { unique: true });
orderSchema.index({ customerId: 1, date: -1, _id: -1 });
orderSchema.index({ status: 1, archivedAt: 1, requestedDate: 1 });
orderSchema.index({ saleId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.models.Order || mongoose.model("Order", orderSchema);
