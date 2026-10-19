const mongoose = require("mongoose");

const attendanceRecordSchema = new mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },
    workDate: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    status: {
      type: String,
      enum: ["Present", "Absent", "On leave"],
      required: true,
    },
    halfDay: { type: Boolean, default: false },
    late: { type: Boolean, default: false },
    note: { type: String, trim: true, maxlength: 300, default: "" },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true },
);

attendanceRecordSchema.index({ employeeId: 1, workDate: 1 }, { unique: true });
attendanceRecordSchema.index({ workDate: 1, employeeId: 1 });

module.exports =
  mongoose.models.AttendanceRecord ||
  mongoose.model("AttendanceRecord", attendanceRecordSchema);
