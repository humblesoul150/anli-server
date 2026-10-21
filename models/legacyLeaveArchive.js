const mongoose = require("mongoose");

const legacyLeaveArchiveSchema = new mongoose.Schema(
  {
    legacyImportKey: { type: String, required: true, unique: true, trim: true, maxlength: 80 },
    legacyId: { type: String, trim: true, maxlength: 120, default: "" },
    reference: { type: String, trim: true, maxlength: 40, default: "" },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
    employeeNumber: { type: String, trim: true, maxlength: 40, default: "" },
    employeeName: { type: String, required: true, trim: true, maxlength: 180 },
    department: { type: String, trim: true, maxlength: 100, default: "" },
    role: { type: String, trim: true, maxlength: 100, default: "" },
    leaveType: { type: String, enum: ["Annual", "Sick", "Maternity/Paternity", "Compassionate", "Other"], required: true },
    otherLeaveType: { type: String, trim: true, maxlength: 80, default: "" },
    reason: { type: String, trim: true, maxlength: 1000, default: "" },
    startDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    endDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    requestedDays: { type: Number, required: true, min: 0, max: 366 },
    handoverName: { type: String, trim: true, maxlength: 180, default: "" },
    handoverContact: { type: String, trim: true, maxlength: 80, default: "" },
    originalStatus: { type: String, enum: ["Pending", "Approved", "Rejected", "Cancelled", "Unknown"], required: true },
    originalRequestedAt: { type: Date },
    importedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

legacyLeaveArchiveSchema.index({ employeeNumber: 1, startDate: -1 });

module.exports = mongoose.models.LegacyLeaveArchive
  || mongoose.model("LegacyLeaveArchive", legacyLeaveArchiveSchema);
