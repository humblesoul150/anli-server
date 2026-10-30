const mongoose = require("mongoose");

const salesBonusSettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "global" },
    enabled: { type: Boolean, default: true },
    standard: {
      minimumQuantity: { type: Number, default: 100 },
      maximumQuantity: { type: Number, default: 999 },
      qualifyingQuantity: { type: Number, default: 100 },
      bonusQuantity: { type: Number, default: 1 },
    },
    volume: {
      minimumQuantity: { type: Number, default: 1000 },
      qualifyingQuantity: { type: Number, default: 1000 },
      bonusQuantity: { type: Number, default: 40 },
    },
    version: { type: Number, default: 1, min: 1 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

module.exports =
  mongoose.models.SalesBonusSettings ||
  mongoose.model("SalesBonusSettings", salesBonusSettingsSchema);
