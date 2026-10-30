const mongoose = require("mongoose");

const saleLineSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "FinishedProduct", required: true },
    productCode: { type: String, required: true, trim: true, maxlength: 40 },
    productName: { type: String, required: true, trim: true, maxlength: 160 },
    packType: { type: String, enum: ["Box", "Carton"], required: true },
    piecesPerPack: { type: Number, required: true, min: 1, validate: Number.isInteger },
    packs: { type: Number, required: true, min: 1, validate: Number.isInteger },
    bonusPacks: { type: Number, required: true, min: 0, default: 0, validate: Number.isInteger },
    totalStockPacks: { type: Number, min: 0, default: 0, validate: Number.isInteger },
    quantityPieces: { type: Number, required: true, min: 1, validate: Number.isInteger },
    catalogPricePerPack: { type: Number, required: true, min: 1, validate: Number.isInteger },
    pricePerPack: { type: Number, required: true, min: 1, validate: Number.isInteger },
    overrideReason: { type: String, trim: true, maxlength: 500, default: "" },
    lineTotal: { type: Number, required: true, min: 1, validate: Number.isInteger },
  },
  { _id: false },
);

const partySnapshotSchema = new mongoose.Schema(
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

const companySnapshotSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, maxlength: 160, default: "" },
    email: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
    phone: { type: String, trim: true, maxlength: 40, default: "" },
    address: { type: String, trim: true, maxlength: 500, default: "" },
    logoUrl: { type: String, trim: true, maxlength: 1000, default: "" },
  },
  { _id: false },
);

const saleSchema = new mongoose.Schema(
  {
    receiptNumber: { type: String, required: true, unique: true, trim: true, maxlength: 40 },
    receiptYear: { type: Number, required: true, min: 2000, max: 9999 },
    receiptSequence: { type: Number, required: true, min: 1, validate: Number.isInteger },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", unique: true, sparse: true },
    legacyId: { type: String, trim: true, maxlength: 100, sparse: true, unique: true },
    customerId: { type: String, trim: true, maxlength: 80, default: null },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    createdByName: { type: String, trim: true, maxlength: 120, default: "" },
    customer: { type: partySnapshotSchema, required: true },
    company: { type: companySnapshotSchema, required: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    lines: { type: [saleLineSchema], required: true, validate: function (lines) { return this.legacyImported || lines.length > 0; } },
    total: { type: Number, required: true, min: 1, validate: Number.isInteger },
    paidAmount: { type: Number, required: true, min: 0, validate: Number.isInteger, default: 0 },
    paymentTerms: { type: String, enum: ["Paid now", "Same-day", "Credit"], required: true },
    dueDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    legacyImported: { type: Boolean, default: false },
    legacyProduct: { type: String, trim: true, maxlength: 160 },
    legacyQuantity: { type: Number, min: 1, validate: Number.isInteger },
    legacyMethod: { type: String, trim: true, maxlength: 40, default: "" },
    legacyTxnID: { type: String, trim: true, maxlength: 120, default: "" },
    bonusSnapshot: {
      enabled: { type: Boolean, default: false },
      settingsVersion: { type: Number, min: 1, default: 1 },
      qualifyingBoxes: { type: Number, min: 0, default: 0 },
      bonusBoxes: { type: Number, min: 0, default: 0 },
      tier: { type: String, enum: ["standard", "volume", ""], default: "" },
      calculatedAt: { type: Date, default: null },
    },
    bonusDisabledReason: { type: String, trim: true, maxlength: 500, default: "" },
    voidedAt: { type: Date, default: null },
    voidReason: { type: String, trim: true, maxlength: 500, default: "" },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    idempotencyKey: { type: String, trim: true, maxlength: 120, sparse: true, unique: true },
    requestHash: { type: String, trim: true, maxlength: 64 },
    legacyImportHash: { type: String, trim: true, maxlength: 64 },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_document, value) {
        value.id = String(value._id);
        delete value._id;
        delete value.__v;
        return value;
      },
    },
  },
);

saleSchema.index({ date: -1, _id: -1 });
saleSchema.index({ customerId: 1, date: -1 });
saleSchema.index({ paymentTerms: 1, dueDate: 1, paidAmount: 1 });
saleSchema.index({ assignedTo: 1, dueDate: 1 });
saleSchema.index({ receiptYear: 1, receiptSequence: 1 }, { unique: true });

module.exports = mongoose.models.Sale || mongoose.model("Sale", saleSchema);
