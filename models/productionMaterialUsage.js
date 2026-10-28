const mongoose = require("mongoose");

const usageLineSchema = new mongoose.Schema(
  {
    materialId: { type: mongoose.Schema.Types.ObjectId, ref: "RawMaterial", required: true },
    materialName: { type: String, required: true, trim: true, maxlength: 160 },
    unit: { type: String, required: true, trim: true, maxlength: 24 },
    quantityPerTank: { type: Number, required: true, min: 0.000001 },
    totalQuantity: { type: Number, required: true, min: 0.000001 },
  },
  { _id: false },
);

const productionMaterialUsageSchema = new mongoose.Schema(
  {
    reference: { type: String, required: true, unique: true, trim: true, maxlength: 80 },
    productionRunId: { type: mongoose.Schema.Types.ObjectId, ref: "ProductionRun" },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "FinishedProduct", required: true },
    productName: { type: String, required: true, trim: true, maxlength: 160 },
    productionDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    tanksProduced: { type: Number, required: true, min: 0.000001 },
    tankVolumeLitres: { type: Number, required: true, enum: [1000], default: 1000 },
    location: { type: String, required: true, trim: true, maxlength: 100 },
    recipeId: { type: mongoose.Schema.Types.ObjectId, ref: "ProductionRecipe", required: true },
    recipeVersion: { type: Number, required: true, min: 1 },
    lines: { type: [usageLineSchema], required: true, validate: [(lines) => lines.length > 0, "Production usage requires recipe lines."] },
    idempotencyKey: { type: String, trim: true, maxlength: 120 },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

productionMaterialUsageSchema.index({ productionRunId: 1 }, { unique: true, sparse: true });
productionMaterialUsageSchema.index({ productionDate: -1, createdAt: -1 });
productionMaterialUsageSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

module.exports = mongoose.models.ProductionMaterialUsage ||
  mongoose.model("ProductionMaterialUsage", productionMaterialUsageSchema);
