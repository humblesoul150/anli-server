const mongoose = require("mongoose");

const rawMaterialAlertSchema = new mongoose.Schema(
  {
    materialId: { type: mongoose.Schema.Types.ObjectId, ref: "RawMaterial", required: true },
    location: { type: String, required: true, trim: true, maxlength: 100 },
    recipientUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reorderThreshold: { type: Number, required: true, min: 0 },
    currentQuantity: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ["active", "resolved"], required: true, default: "resolved" },
    lastTriggeredAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

rawMaterialAlertSchema.index({ materialId: 1, location: 1 }, { unique: true });
rawMaterialAlertSchema.index({ status: 1, recipientUserId: 1, updatedAt: -1 });

module.exports = mongoose.models.RawMaterialAlert ||
  mongoose.model("RawMaterialAlert", rawMaterialAlertSchema);
