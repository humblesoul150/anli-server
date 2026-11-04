const mongoose = require("mongoose");

const packageEntrySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 40 },
    quantity: { type: Number, required: true, min: 0 },
    baseUnitsPerPackage: { type: Number, required: true, min: 0.000001 },
  },
  { _id: false },
);

const rawMaterialCountSchema = new mongoose.Schema(
  {
    materialId: { type: mongoose.Schema.Types.ObjectId, ref: "RawMaterial", required: true, index: true },
    materialName: { type: String, required: true, trim: true, maxlength: 160 },
    unit: { type: String, required: true, trim: true, maxlength: 24 },
    location: { type: String, required: true, trim: true, maxlength: 100 },
    countDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    status: { type: String, enum: ["draft", "submitted"], default: "draft", index: true },
    packageEntries: { type: [packageEntrySchema], default: [] },
    packagingSnapshot: { type: [packageEntrySchema], default: [] },
    expectedQuantity: { type: Number, required: true, min: 0 },
    countedQuantity: { type: Number, required: true, min: 0 },
    variance: { type: Number, required: true },
    adjustmentMovementId: { type: mongoose.Schema.Types.ObjectId, ref: "RawMaterialMovement", default: null },
    idempotencyKey: { type: String, trim: true, maxlength: 120 },
    submittedAt: { type: Date, default: null },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

rawMaterialCountSchema.index({ materialId: 1, location: 1, countDate: 1 }, { unique: true });
rawMaterialCountSchema.index({ countDate: 1, location: 1, status: 1 });
rawMaterialCountSchema.index({ idempotencyKey: 1 }, { sparse: true });

module.exports = mongoose.model("RawMaterialCount", rawMaterialCountSchema);
