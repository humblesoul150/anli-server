const mongoose = require("mongoose");

const attendancePeriodSchema = new mongoose.Schema(
  {
    periodStart: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    periodEnd: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    status: { type: String, enum: ["Closed", "Reopened"], default: "Closed", index: true },
    closedAt: { type: Date, required: true },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    closedByName: { type: String, required: true, maxlength: 120 },
    reopenedAt: { type: Date, default: null },
    reopenedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reopenReason: { type: String, trim: true, maxlength: 1000, default: "" },
  },
  { timestamps: true },
);

attendancePeriodSchema.index({ periodStart: 1, periodEnd: 1 }, { unique: true });

module.exports =
  mongoose.models.AttendancePeriod ||
  mongoose.model("AttendancePeriod", attendancePeriodSchema);
