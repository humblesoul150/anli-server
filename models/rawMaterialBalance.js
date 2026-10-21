const mongoose = require("mongoose");

const rawMaterialBalanceSchema = new mongoose.Schema(
  {
    materialId: { type: mongoose.Schema.Types.ObjectId, ref: "RawMaterial", required: true },
    location: { type: String, required: true, trim: true, maxlength: 100, default: "Main Warehouse" },
    quantity: { type: Number, required: true, min: 0, default: 0 },
    reorderThreshold: { type: Number, required: true, min: 0, default: 0 },
    responsibleUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

rawMaterialBalanceSchema.index({ materialId: 1, location: 1 }, { unique: true });

module.exports =
  mongoose.models.RawMaterialBalance ||
  mongoose.model("RawMaterialBalance", rawMaterialBalanceSchema);
