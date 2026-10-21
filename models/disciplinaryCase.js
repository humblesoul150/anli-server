const mongoose = require("mongoose");

const approvalSchema = new mongoose.Schema(
  {
    round: { type: Number, required: true, min: 1 },
    stage: { type: String, enum: ["Human Resource", "General Manager", "Super Admin"], required: true },
    decision: { type: String, enum: ["Approved", "Rejected"], required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    actorName: { type: String, required: true, trim: true, maxlength: 120 },
    note: { type: String, trim: true, maxlength: 1000, default: "" },
    decidedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: true },
);

const evidenceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 180 },
    url: { type: String, required: true },
    publicId: { type: String, required: true },
    resourceType: { type: String, enum: ["raw"], default: "raw" },
    mediaType: { type: String, required: true, maxlength: 100 },
    sizeBytes: { type: Number, required: true, min: 1 },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const disciplinaryCaseSchema = new mongoose.Schema(
  {
    reference: { type: String, required: true, unique: true, immutable: true, trim: true, maxlength: 40 },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true, index: true },
    employeeUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    employeeName: { type: String, required: true, trim: true, maxlength: 180 },
    employeeNumber: { type: String, required: true, trim: true, maxlength: 40 },
    department: { type: String, required: true, trim: true, maxlength: 100 },
    role: { type: String, required: true, trim: true, maxlength: 100 },
    type: { type: String, enum: ["Written warning", "Suspension", "Termination"], required: true, index: true },
    status: {
      type: String,
      enum: ["Draft", "Under investigation", "Awaiting employee response", "Pending Human Resource approval", "Pending General Manager approval", "Pending Super Admin approval", "Changes requested", "Approved", "Issued", "Closed", "Rescinded"],
      default: "Draft",
      index: true,
    },
    incidentDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    allegation: { type: String, required: true, trim: true, maxlength: 3000 },
    reason: { type: String, required: true, trim: true, maxlength: 3000 },
    expectations: { type: String, trim: true, maxlength: 3000, default: "" },
    reviewDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    suspensionStartDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    suspensionEndDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    returnDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    suspensionPayStatus: { type: String, enum: ["Paid", "Unpaid", "Not specified"], default: "Not specified" },
    conditions: { type: String, trim: true, maxlength: 3000, default: "" },
    effectiveDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    noticeDetails: { type: String, trim: true, maxlength: 3000, default: "" },
    handoverDetails: { type: String, trim: true, maxlength: 3000, default: "" },
    signatory: { type: String, required: true, trim: true, maxlength: 180 },
    responseRequired: { type: Boolean, required: true, default: true },
    responseDueDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    responseNotice: { type: String, trim: true, maxlength: 3000, default: "" },
    response: {
      text: { type: String, trim: true, maxlength: 5000 },
      submittedAt: { type: Date },
      submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      source: { type: String, enum: ["Employee portal", "In person", "Written externally"] },
    },
    noResponseRecordedAt: { type: Date },
    noResponseRecordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    noResponseNote: { type: String, trim: true, maxlength: 1000, default: "" },
    assignedApprovers: {
      humanResource: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
      generalManager: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
      superAdmin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    },
    approvals: { type: [approvalSchema], default: [] },
    approvalRound: { type: Number, min: 0, default: 0 },
    evidence: { type: [evidenceSchema], default: [] },
    responseHistory: [{
      text: { type: String, trim: true, maxlength: 5000 },
      submittedAt: { type: Date, required: true },
      submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
      source: { type: String, enum: ["Employee portal", "In person", "Written externally"], required: true },
    }],
    acknowledgements: [{
      status: { type: String, enum: ["Received", "Declined", "Disputed"], required: true },
      note: { type: String, trim: true, maxlength: 1000, default: "" },
      actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
      recordedAt: { type: Date, required: true, default: Date.now },
    }],
    appeals: [{
      text: { type: String, required: true, trim: true, maxlength: 5000 },
      submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
      submittedAt: { type: Date, required: true, default: Date.now },
      resolution: { type: String, enum: ["Upheld", "Varied", "Overturned"] },
      resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      resolvedAt: { type: Date },
      resolutionNote: { type: String, trim: true, maxlength: 2000, default: "" },
    }],
    issuedAt: { type: Date },
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    issuedLetterVersion: { type: Number, min: 1 },
    letterVersion: { type: Number, min: 1, default: 1 },
    rescindedAt: { type: Date },
    rescindedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    rescindReason: { type: String, trim: true, maxlength: 1000, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true, optimisticConcurrency: true },
);

disciplinaryCaseSchema.index({ employeeId: 1, status: 1, createdAt: -1 });
disciplinaryCaseSchema.index({ status: 1, type: 1, createdAt: -1 });

module.exports = mongoose.models.DisciplinaryCase
  || mongoose.model("DisciplinaryCase", disciplinaryCaseSchema);
