const mongoose = require("mongoose");

const receiptManagementStateSchema = new mongoose.Schema(
  {
    sourceType: { type: String, enum: ["sale", "credit-payment"], required: true },
    sourceId: { type: mongoose.Schema.Types.ObjectId, required: true },
    favoriteUserIds: { type: [mongoose.Schema.Types.ObjectId], ref: "User", default: [] },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    restoredAt: { type: Date, default: null },
    restoredBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

receiptManagementStateSchema.index({ sourceType: 1, sourceId: 1 }, { unique: true });
receiptManagementStateSchema.index({ sourceType: 1, archivedAt: 1, updatedAt: -1 });
receiptManagementStateSchema.index({ favoriteUserIds: 1, sourceType: 1 });

module.exports = mongoose.models.ReceiptManagementState ||
  mongoose.model("ReceiptManagementState", receiptManagementStateSchema);
