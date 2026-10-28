const mongoose = require("mongoose");

const receiptPackagingSchema = new mongoose.Schema(
  {
    packageQuantity: { type: Number, required: true, min: 0.000001 },
    packageUnit: { type: String, required: true, trim: true, maxlength: 40 },
    baseUnitsPerPackage: { type: Number, required: true, min: 0.000001 },
    packagePrice: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const rawMaterialMovementSchema = new mongoose.Schema(
  {
    materialId: { type: mongoose.Schema.Types.ObjectId, ref: "RawMaterial", required: true, index: true },
    type: { type: String, enum: ["Opening balance", "Receipt", "Stock in", "Stock out", "Production use", "Production use correction", "Transfer", "Adjustment increase", "Adjustment decrease"], required: true },
    direction: { type: String, enum: ["in", "out", "transfer"], required: true },
    quantity: { type: Number, required: true, min: 0.000001 },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    reference: { type: String, required: true, trim: true, maxlength: 80 },
    receiptReference: { type: String, trim: true, maxlength: 80 },
    sourceType: { type: String, enum: ["receipt", "adjustment", "transfer", "production", "production-usage", "production-usage-correction", "opening", "migration"], required: true },
    sourceId: { type: mongoose.Schema.Types.ObjectId, default: null },
    idempotencyKey: { type: String, trim: true, maxlength: 120 },
    reason: { type: String, trim: true, maxlength: 300, default: "" },
    fromLocation: { type: String, trim: true, maxlength: 100 },
    toLocation: { type: String, trim: true, maxlength: 100 },
    supplier: { type: String, trim: true, maxlength: 160 },
    sourceReference: { type: String, trim: true, maxlength: 120 },
    unitCost: { type: Number, min: 0 },
    receiptPackaging: { type: receiptPackagingSchema },
    materialName: { type: String, required: true, trim: true, maxlength: 160 },
    unit: { type: String, required: true, trim: true, maxlength: 24 },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
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

rawMaterialMovementSchema.index({ materialId: 1, date: -1, createdAt: -1 });
rawMaterialMovementSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
rawMaterialMovementSchema.index({ sourceType: 1, sourceId: 1 });

module.exports = mongoose.models.RawMaterialMovement ||
  mongoose.model("RawMaterialMovement", rawMaterialMovementSchema);
