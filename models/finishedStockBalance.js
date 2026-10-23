const mongoose = require("mongoose");

const finishedStockBalanceSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "FinishedProduct", required: true },
    quantityPieces: { type: Number, required: true, min: 0, validate: Number.isInteger, default: 0 },
    reservedPieces: { type: Number, required: true, min: 0, validate: Number.isInteger, default: 0 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

finishedStockBalanceSchema.index({ productId: 1 }, { unique: true });

module.exports =
  mongoose.models.FinishedStockBalance ||
  mongoose.model("FinishedStockBalance", finishedStockBalanceSchema);
