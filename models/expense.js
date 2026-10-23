const mongoose = require("mongoose");

const expenseAttachmentSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, maxlength: 80 },
    name: { type: String, required: true, trim: true, maxlength: 180 },
    url: { type: String, required: true, maxlength: 1000 },
    publicId: { type: String, required: true, maxlength: 300 },
    mediaType: { type: String, enum: ["image/jpeg", "image/png", "image/webp"], required: true },
    sizeBytes: { type: Number, required: true, min: 1, max: 5 * 1024 * 1024 },
    uploadedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const paymentSchema = new mongoose.Schema(
  {
    paymentId: { type: String, required: true, maxlength: 80 },
    amount: { type: Number, required: true, min: 1 },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    method: { type: String, enum: ["Cash", "Bank transfer", "Mobile Money", "Cheque"], required: true },
    reference: { type: String, trim: true, maxlength: 160, default: "" },
    note: { type: String, trim: true, maxlength: 500, default: "" },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    recordedByName: { type: String, required: true, maxlength: 120 },
    recordedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const decisionSchema = new mongoose.Schema(
  {
    decision: { type: String, enum: ["Approved", "Rejected"], required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    actorName: { type: String, required: true, maxlength: 120 },
    at: { type: Date, required: true, default: Date.now },
    note: { type: String, trim: true, maxlength: 1000, default: "" },
  },
  { _id: false },
);

const expenseSchema = new mongoose.Schema(
  {
    reference: { type: String, required: true, unique: true, immutable: true, maxlength: 50 },
    category: {
      type: String,
      required: true,
      enum: [
        "Rent and premises", "Utilities", "Production consumables", "Packaging",
        "Repairs and maintenance", "Fuel", "Transport and delivery",
        "Travel and accommodation", "Office supplies and printing",
        "Telephone and internet", "IT and software", "Professional services",
        "Marketing and advertising", "Insurance", "Licenses and compliance fees",
        "Bank and transaction charges", "Staff welfare and training",
        "Cleaning and security", "Tax", "Payroll", "Other",
      ],
      index: true,
    },
    taxType: {
      type: String,
      enum: [
        "Value Added Tax (VAT) - non-recoverable input tax", "Corporation tax",
        "Presumptive tax", "Pay As You Earn (PAYE)", "Withholding tax",
        "Excise duty", "Import / customs duty", "Stamp duty",
        "Local Service Tax (LST)", "Property rates", "Tax penalty or interest",
        "Other tax",
      ],
      default: null,
    },
    expenseType: {
      type: String,
      enum: ["Supplier bill", "Employee reimbursement", "Petty cash / other"],
      default: "Supplier bill",
    },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, index: true },
    payee: { type: String, required: true, trim: true, maxlength: 180 },
    description: { type: String, required: true, trim: true, maxlength: 2000 },
    department: { type: String, required: true, trim: true, maxlength: 100, index: true },
    amount: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: ["Pending approval", "Approved", "Rejected", "Partially paid", "Paid", "Legacy unverified"],
      required: true,
      default: "Pending approval",
      index: true,
    },
    attachments: { type: [expenseAttachmentSchema], default: [] },
    decisions: { type: [decisionSchema], default: [] },
    payments: { type: [paymentSchema], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    createdByName: { type: String, required: true, maxlength: 120 },
    importKey: { type: String, maxlength: 100 },
    legacyStatus: { type: String, maxlength: 60, default: "" },
    legacyDecisions: { type: [mongoose.Schema.Types.Mixed], default: [] },
    legacyAttachments: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  { timestamps: true },
);

expenseSchema.index({ importKey: 1 }, { unique: true, sparse: true });
expenseSchema.index({ createdAt: -1, _id: -1 });
expenseSchema.index({ status: 1, date: -1, _id: -1 });

module.exports = mongoose.models.Expense || mongoose.model("Expense", expenseSchema);
