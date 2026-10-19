const mongoose = require("mongoose");

const attachmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 180 },
    url: { type: String, required: true },
    publicId: { type: String, required: true },
    resourceType: { type: String, enum: ["image", "raw"], required: true },
    mediaType: { type: String, required: true, maxlength: 100 },
    sizeBytes: { type: Number, required: true, min: 1 },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    uploadedAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

const decisionSchema = new mongoose.Schema(
  {
    decision: { type: String, enum: ["Approved", "Rejected"], required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    actorName: { type: String, required: true, maxlength: 120 },
    role: { type: String, enum: ["Human Resource", "General Manager"], required: true },
    note: { type: String, trim: true, maxlength: 1000, default: "" },
    amount: { type: Number, min: 1 },
    frequency: { type: String, enum: ["Weekly", "Monthly"] },
    installmentAmount: { type: Number, min: 1 },
    decidedAt: { type: Date, default: Date.now },
    legacy: { type: Boolean, default: false },
  },
  { _id: false },
);

const scheduleEntrySchema = new mongoose.Schema(
  {
    dueDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    plannedAmount: { type: Number, required: true, min: 1 },
  },
  { _id: true },
);

const repaymentSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    amount: { type: Number, required: true, min: 1 },
    method: { type: String, enum: ["Cash", "Mobile Money", "Bank Transfer", "Payroll"], required: true },
    reference: { type: String, trim: true, maxlength: 160 },
    note: { type: String, trim: true, maxlength: 1000 },
    recordedAt: { type: Date, default: Date.now },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    payrollRunId: { type: String, maxlength: 120 },
    payslipId: { type: String, maxlength: 120 },
    scheduleEntryIds: [{ type: mongoose.Schema.Types.ObjectId }],
    idempotencyKey: { type: String, maxlength: 240 },
    legacy: { type: Boolean, default: false },
  },
  { _id: true },
);

const activitySchema = new mongoose.Schema(
  {
    action: { type: String, required: true, maxlength: 120 },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    actorName: { type: String, maxlength: 120, default: "" },
    note: { type: String, trim: true, maxlength: 1000, default: "" },
    at: { type: Date, default: Date.now },
  },
  { _id: true },
);

const salaryAdvanceSchema = new mongoose.Schema(
  {
    reference: { type: String, required: true, unique: true, immutable: true, maxlength: 40 },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: function requiredEmployeeId() { return !this.legacyUnverified; }, index: true },
    employeeNumber: { type: String, required: true, maxlength: 40 },
    employeeName: { type: String, required: true, maxlength: 180 },
    department: { type: String, required: true, maxlength: 100 },
    role: { type: String, required: true, maxlength: 100 },
    category: { type: String, required: true, maxlength: 80 },
    paymentFrequency: { type: String, enum: ["Weekly", "Monthly", ""], default: "" },
    requestedAmount: { type: Number, required: true, min: 1 },
    reason: { type: String, required: true, trim: true, maxlength: 2000 },
    dateTaken: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    requestedAt: { type: Date, required: true, default: Date.now },
    proposedFrequency: { type: String, enum: ["Weekly", "Monthly"], required: true },
    proposedInstallmentAmount: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: ["Pending HR review", "Pending GM review", "Approved", "Rejected", "Active", "Settled", "Legacy archive"],
      default: "Pending HR review",
      index: true,
    },
    hrDecision: { type: decisionSchema, default: null },
    gmDecision: { type: decisionSchema, default: null },
    approvedAmount: { type: Number, min: 1 },
    approvedFrequency: { type: String, enum: ["Weekly", "Monthly"] },
    approvedInstallmentAmount: { type: Number, min: 1 },
    dateApproved: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    disbursement: {
      amount: { type: Number, min: 1 },
      date: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
      method: { type: String, enum: ["Cash", "Mobile Money", "Bank Transfer"] },
      reference: { type: String, trim: true, maxlength: 160 },
      recordedAt: { type: Date },
      recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    },
    schedule: { type: [scheduleEntrySchema], default: [] },
    repayments: { type: [repaymentSchema], default: [] },
    attachments: { type: [attachmentSchema], default: [] },
    activity: { type: [activitySchema], default: [] },
    rejectionReason: { type: String, trim: true, maxlength: 1000 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    legacyImportKey: { type: String, select: false, sparse: true, unique: true },
    legacyUnverified: { type: Boolean, default: false },
    legacyStatus: { type: String, maxlength: 40 },
    legacyReference: { type: String, maxlength: 40 },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_document, value) {
        value.id = String(value._id);
        delete value._id;
        delete value.__v;
        delete value.legacyImportKey;
        for (const item of value.attachments || []) item.id = String(item._id);
        for (const item of value.schedule || []) item.id = String(item._id);
        for (const item of value.repayments || []) item.id = String(item._id);
        for (const item of value.activity || []) item.id = String(item._id);
        return value;
      },
    },
  },
);

salaryAdvanceSchema.index({ employeeId: 1, status: 1, createdAt: -1 });
salaryAdvanceSchema.index({ status: 1, createdAt: -1 });
salaryAdvanceSchema.index(
  { "repayments.idempotencyKey": 1 },
  { unique: true, sparse: true },
);

module.exports =
  mongoose.models.SalaryAdvance ||
  mongoose.model("SalaryAdvance", salaryAdvanceSchema);
