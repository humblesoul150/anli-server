const mongoose = require("mongoose");

const productionLineSchema = new mongoose.Schema(
  {
    materialId: { type: mongoose.Schema.Types.ObjectId, ref: "RawMaterial", required: true },
    materialName: { type: String, required: true, trim: true, maxlength: 160 },
    unit: { type: String, required: true, trim: true, maxlength: 24 },
    quantityPerPiece: { type: Number, required: true, min: 0.000001 },
    totalQuantity: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const productionRunSchema = new mongoose.Schema(
  {
    reference: { type: String, required: true, unique: true, trim: true, maxlength: 80 },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "FinishedProduct", required: true },
    productName: { type: String, required: true, trim: true, maxlength: 160 },
    productUnit: { type: String, required: true, trim: true, maxlength: 16 },
    recipeId: { type: mongoose.Schema.Types.ObjectId, ref: "ProductionRecipe", default: null },
    recipeVersion: { type: Number, default: null },
    productionDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    inventoryUnit: { type: String, enum: ["piece_legacy", "pack"], default: "piece_legacy" },
    packTypeSnapshot: { type: String, enum: ["Box", "Carton"] },
    piecesPerPackSnapshot: { type: Number, min: 1, validate: Number.isInteger },
    openingStockPacks: { type: Number, min: 0, validate: Number.isInteger },
    salesQuantityPacks: { type: Number, min: 0, validate: Number.isInteger },
    damagedQuantityPacks: { type: Number, min: 0, validate: Number.isInteger },
    closingStockPacks: { type: Number, min: 0, validate: Number.isInteger },
    producedQuantityPacks: { type: Number, min: 0, validate: Number.isInteger },
    openingStockPieces: { type: Number, required: true, min: 0, validate: Number.isInteger },
    salesQuantityPieces: { type: Number, required: true, min: 0, validate: Number.isInteger },
    damagedQuantityPieces: { type: Number, required: true, min: 0, validate: Number.isInteger },
    closingStockPieces: { type: Number, required: true, min: 0, validate: Number.isInteger },
    producedQuantityPieces: { type: Number, required: true, min: 0, validate: Number.isInteger },
    damageReason: { type: String, trim: true, maxlength: 300, default: "" },
    lines: { type: [productionLineSchema], default: [] },
    idempotencyKey: { type: String, trim: true, maxlength: 120 },
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

productionRunSchema.index({ productId: 1, productionDate: 1 }, { unique: true });
productionRunSchema.index({ productionDate: -1, createdAt: -1 });
productionRunSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

module.exports = mongoose.models.ProductionRun ||
  mongoose.model("ProductionRun", productionRunSchema);
