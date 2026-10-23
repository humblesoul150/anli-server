const mongoose = require("mongoose");

const lineItemSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, maxlength: 60 },
    label: { type: String, required: true, maxlength: 120 },
    amount: { type: Number, required: true, min: 0 },
    source: { type: String, enum: ["Base pay", "Attendance", "Feeding allowance", "Statutory", "Salary advance", "Adjustment"], required: true },
    employerOnly: { type: Boolean, default: false },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

const attendanceSnapshotSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    status: { type: String, enum: ["Present", "Absent", "On leave"], required: true },
    units: { type: Number, required: true, min: 0, max: 1 },
  },
  { _id: false },
);

const payslipSchema = new mongoose.Schema(
  {
    slipId: { type: String, required: true, maxlength: 80 },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true },
    employeeNumber: { type: String, required: true, maxlength: 40 },
    employeeName: { type: String, required: true, maxlength: 180 },
    category: { type: String, required: true, maxlength: 80 },
    department: { type: String, required: true, maxlength: 100 },
    role: { type: String, required: true, maxlength: 100 },
    compensationType: { type: String, enum: ["Salary earner", "Wage earner", "Allowance only"], required: true },
    configuredRate: { type: Number, required: true, min: 0 },
    attendanceUnits: { type: Number, required: true, min: 0 },
    attendance: { type: [attendanceSnapshotSchema], default: [] },
    earnings: { type: [lineItemSchema], default: [] },
    deductions: { type: [lineItemSchema], default: [] },
    employerContributions: { type: [lineItemSchema], default: [] },
    grossPay: { type: Number, required: true, min: 0 },
    deductionTotal: { type: Number, required: true, min: 0 },
    netPay: { type: Number, required: true, min: 0 },
    employerContributionTotal: { type: Number, required: true, min: 0 },
    reviewStatus: { type: String, enum: ["Ready", "Needs review"], default: "Ready" },
    paymentStatus: { type: String, enum: ["Unpaid", "Paid"], default: "Unpaid" },
  },
  { _id: false },
);

const approvalSchema = new mongoose.Schema(
  {
    stage: { type: String, enum: ["General Manager", "Super Admin"], required: true },
    decision: { type: String, enum: ["Approved", "Returned"], required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    actorName: { type: String, required: true, maxlength: 120 },
    note: { type: String, trim: true, maxlength: 1000, default: "" },
    decidedAt: { type: Date, required: true },
  },
  { _id: false },
);

const payrollRunSchema = new mongoose.Schema(
  {
    reference: { type: String, required: true, unique: true, immutable: true, maxlength: 50 },
    runType: { type: String, enum: ["Monthly", "Weekly wages", "Weekly feeding"], required: true, index: true },
    periodStart: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    periodEnd: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    status: { type: String, enum: ["Draft", "In review", "Manager approved", "Approved", "Returned", "Paid"], default: "Draft", index: true },
    policyVersion: { type: Date, required: true },
    calculationSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    attendancePeriodId: { type: mongoose.Schema.Types.ObjectId, ref: "AttendancePeriod", required: true },
    payslips: { type: [payslipSchema], default: [] },
    approvals: { type: [approvalSchema], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    createdByName: { type: String, required: true, maxlength: 120 },
    submittedAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    payment: {
      method: { type: String, enum: ["Cash"], default: null },
      amount: { type: Number, min: 0 },
      date: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
      reference: { type: String, trim: true, maxlength: 160 },
      note: { type: String, trim: true, maxlength: 500 },
      recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      recordedByName: { type: String, maxlength: 120 },
    },
    returnedNote: { type: String, trim: true, maxlength: 1000, default: "" },
    calculationHash: { type: String, required: true, maxlength: 64 },
  },
  { timestamps: true },
);

payrollRunSchema.index(
  { runType: 1, periodStart: 1, periodEnd: 1 },
  { unique: true },
);
payrollRunSchema.index({ createdAt: -1, _id: -1 });
payrollRunSchema.index({ "payslips.employeeId": 1, periodStart: -1 });

module.exports =
  mongoose.models.PayrollRun || mongoose.model("PayrollRun", payrollRunSchema);
