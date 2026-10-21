const mongoose = require("mongoose");

const decisionSchema = new mongoose.Schema(
  {
    decision: { type: String, enum: ["Approved", "Rejected", "Cancelled"], required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    actorName: { type: String, required: true, trim: true, maxlength: 120 },
    at: { type: Date, required: true, default: Date.now },
    note: { type: String, trim: true, maxlength: 1000, default: "" },
  },
  { _id: true },
);

const amendmentSchema = new mongoose.Schema(
  {
    startDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    endDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    requestedDays: { type: Number, required: true, min: 1 },
    reason: { type: String, required: true, trim: true, maxlength: 1000 },
    status: { type: String, enum: ["Pending", "Approved", "Rejected"], default: "Pending" },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    requestedAt: { type: Date, default: Date.now },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    decidedAt: { type: Date },
    decisionNote: { type: String, trim: true, maxlength: 1000, default: "" },
  },
  { _id: true },
);

const leaveRequestSchema = new mongoose.Schema(
  {
    reference: { type: String, required: true, unique: true, trim: true, maxlength: 40 },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true, index: true },
    employeeUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    requesterUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    approverUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    leaveType: { type: String, enum: ["Annual", "Sick", "Maternity/Paternity", "Compassionate", "Other"], required: true },
    otherLeaveType: { type: String, trim: true, maxlength: 80, default: "" },
    reason: { type: String, required: true, trim: true, maxlength: 1000 },
    startDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    endDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    requestedDays: { type: Number, required: true, min: 1 },
    handoverEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true },
    handoverUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    handoverName: { type: String, required: true, trim: true, maxlength: 180 },
    handoverContact: { type: String, trim: true, maxlength: 80, default: "" },
    status: { type: String, enum: ["Pending", "Approved", "Rejected", "Cancelled"], default: "Pending", index: true },
    decisions: { type: [decisionSchema], default: [] },
    amendments: { type: [amendmentSchema], default: [] },
    returnConfirmation: {
      expectedDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
      actualDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
      confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      confirmedAt: { type: Date },
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true, optimisticConcurrency: true },
);

leaveRequestSchema.index({ employeeId: 1, startDate: 1, endDate: 1, status: 1 });
leaveRequestSchema.index({ approverUserId: 1, status: 1, createdAt: -1 });

module.exports =
  mongoose.models.LeaveRequest || mongoose.model("LeaveRequest", leaveRequestSchema);
