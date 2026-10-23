const mongoose = require("mongoose");

const feedingOverrideSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true },
    dailyRate: { type: Number, required: true, min: 0 },
    effectiveFrom: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    effectiveTo: { type: String, default: "", match: /^\d{4}-\d{2}-\d{2}$/ },
  },
  { _id: false },
);

const statutoryBandSchema = new mongoose.Schema(
  {
    upTo: { type: Number, min: 0, default: null },
    ratePercent: { type: Number, required: true, min: 0, max: 100 },
  },
  { _id: false },
);

const statutoryRuleSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, maxlength: 40 },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    appliesTo: { type: String, enum: ["Employee deduction", "Employer contribution"], required: true },
    runTypes: {
      type: [{ type: String, enum: ["Monthly", "Weekly wages", "Weekly feeding"] }],
      default: ["Monthly", "Weekly wages"],
    },
    employeeFlag: { type: String, enum: ["taxApplies", "nssfApplies", "all"], default: "all" },
    method: { type: String, enum: ["Percentage", "Progressive"], required: true },
    ratePercent: { type: Number, min: 0, max: 100, default: 0 },
    bands: { type: [statutoryBandSchema], default: [] },
    ceiling: { type: Number, min: 0, default: null },
    effectiveFrom: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    effectiveTo: { type: String, default: "", match: /^\d{4}-\d{2}-\d{2}$/ },
  },
  { _id: false },
);

const payrollPolicySchema = new mongoose.Schema(
  {
    _id: { type: String, default: "global" },
    weekStartDay: { type: Number, min: 0, max: 6, default: 1 },
    attendanceCutoffDelayDays: { type: Number, min: 0, max: 14, default: 1 },
    feedingAllowance: {
      defaultDailyRate: { type: Number, min: 0, default: 0 },
      eligibleEmployeeIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Employee" }],
      employeeOverrides: { type: [feedingOverrideSchema], default: [] },
    },
    statutoryRules: { type: [statutoryRuleSchema], default: [] },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updatedByName: { type: String, trim: true, maxlength: 120, default: "" },
  },
  { timestamps: true },
);

module.exports =
  mongoose.models.PayrollPolicy ||
  mongoose.model("PayrollPolicy", payrollPolicySchema);
