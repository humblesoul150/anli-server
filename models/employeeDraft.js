const mongoose = require("mongoose");

const employeeDraftSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true, maxlength: 80 },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    employee: { type: mongoose.Schema.Types.Mixed, required: true, default: {} },
    currentStep: { type: Number, min: 0, max: 5, default: 0 },
  },
  { timestamps: true, versionKey: false },
);

employeeDraftSchema.index({ ownerId: 1, updatedAt: -1 });

module.exports =
  mongoose.models.EmployeeDraft ||
  mongoose.model("EmployeeDraft", employeeDraftSchema);
