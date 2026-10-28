const mongoose = require("mongoose");

const finishedStockBalanceSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "FinishedProduct", required: true },
    inventoryUnit: { type: String, enum: ["pack"], default: "pack", required: true },
    quantityPacks: { type: Number, required: true, min: 0, validate: Number.isInteger, default: 0 },
    reservedPacks: { type: Number, required: true, min: 0, validate: Number.isInteger, default: 0 },
    loosePieces: { type: Number, required: true, min: 0, validate: Number.isInteger, default: 0 },
    openingQuantityPacks: { type: Number, required: true, min: 0, validate: Number.isInteger, default: 0 },
    inventoryEffectiveDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    legacyQuantityPieces: { type: Number, min: 0, validate: Number.isInteger },
    legacyReservedPieces: { type: Number, min: 0, validate: Number.isInteger },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

finishedStockBalanceSchema.index({ productId: 1 }, { unique: true });

module.exports =
  mongoose.models.FinishedStockBalance ||
  mongoose.model("FinishedStockBalance", finishedStockBalanceSchema);
