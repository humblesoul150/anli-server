const mongoose = require("mongoose");

const leavePolicySchema = new mongoose.Schema(
  {
    _id: { type: String, default: "global" },
    workingDays: {
      type: [Number],
      default: [1, 2, 3, 4, 5, 6],
      validate: {
        validator: (days) => days.length > 0
          && days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
          && new Set(days).size === days.length,
        message: "Working days must be distinct weekday numbers from 0 to 6.",
      },
    },
    holidays: {
      type: [String],
      default: [],
      validate: {
        validator: (dates) => dates.every((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)),
        message: "Holidays must use YYYY-MM-DD dates.",
      },
    },
    leaveYearStart: {
      type: String,
      default: "01-01",
      match: /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/,
    },
    entitlements: {
      type: Map,
      of: { type: Number, min: 0, max: 366 },
      default: {},
    },
    carryoverEnabled: { type: Boolean, default: false },
    carryoverLimit: { type: Number, min: 0, max: 366, default: 0 },
    reminderThresholds: {
      pendingApprovalBusinessDays: { type: Number, min: 1, max: 60, default: 2 },
      beforeStartDays: { type: [Number], default: [7, 1] },
      onStartDate: { type: Boolean, default: true },
      returnFollowUp: { type: Boolean, default: true },
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

leavePolicySchema.path("reminderThresholds.beforeStartDays").validate(
  (days) => days.length <= 10
    && days.every((day) => Number.isInteger(day) && day >= 1 && day <= 365)
    && new Set(days).size === days.length,
  "Reminder lead times must be distinct whole days from 1 to 365.",
);

module.exports =
  mongoose.models.LeavePolicy || mongoose.model("LeavePolicy", leavePolicySchema);
