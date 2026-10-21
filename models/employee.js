const mongoose = require("mongoose");

const employeeParentSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, maxlength: 120, default: "" },
    phone: { type: String, trim: true, maxlength: 40, default: "" },
    address: { type: String, trim: true, maxlength: 300, default: "" },
    status: { type: String, enum: ["Alive", "Deceased", ""], default: "" },
  },
  { _id: false },
);

const employeeImageSchema = new mongoose.Schema(
  {
    url: { type: String, default: "" },
    publicId: { type: String, default: "" },
  },
  { _id: false },
);

const employeeDocumentSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 80 },
    url: { type: String, required: true },
    publicId: { type: String, required: true },
    resourceType: { type: String, enum: ["raw"], default: "raw" },
    fileName: { type: String, required: true, trim: true, maxlength: 180 },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    uploadedAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

const employeeSchema = new mongoose.Schema(
  {
    number: {
      type: String,
      required: true,
      trim: true,
      immutable: true,
      unique: true,
      maxlength: 40,
    },
    migrationKey: { type: String, select: false, unique: true, sparse: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    supervisorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    leaveRequestVersion: { type: Number, default: 0, select: false },
    name: { type: String, required: true, trim: true, maxlength: 180 },
    firstName: { type: String, trim: true, maxlength: 80, default: "" },
    secondName: { type: String, trim: true, maxlength: 80, default: "" },
    otherNames: { type: String, trim: true, maxlength: 120, default: "" },
    dateOfBirth: { type: Date, default: null },
    gender: { type: String, trim: true, maxlength: 30, default: "" },
    maritalStatus: { type: String, trim: true, maxlength: 30, default: "" },
    spouseName: { type: String, trim: true, maxlength: 120, default: "" },
    spousePhone: { type: String, trim: true, maxlength: 40, default: "" },
    childrenCount: { type: Number, min: 0, default: 0 },
    educationLevel: { type: String, trim: true, maxlength: 80, default: "" },
    profession: { type: String, trim: true, maxlength: 120, default: "" },
    phone: { type: String, trim: true, maxlength: 40, default: "" },
    email: { type: String, lowercase: true, trim: true, maxlength: 254, default: "" },
    currentAddress: { type: String, trim: true, maxlength: 300, default: "" },
    placeOfOrigin: { type: String, trim: true, maxlength: 200, default: "" },
    nextOfKinName: { type: String, trim: true, maxlength: 120, default: "" },
    nextOfKinRelationship: { type: String, trim: true, maxlength: 80, default: "" },
    nextOfKinPhone: { type: String, trim: true, maxlength: 40, default: "" },
    nextOfKinAddress: { type: String, trim: true, maxlength: 300, default: "" },
    mother: { type: employeeParentSchema, default: () => ({}) },
    father: { type: employeeParentSchema, default: () => ({}) },
    category: {
      type: String,
      enum: ["Staff employee", "Casual worker", "Other", "Staff", "Casual"],
      required: true,
    },
    department: { type: String, required: true, trim: true, maxlength: 100 },
    role: { type: String, required: true, trim: true, maxlength: 100 },
    status: { type: String, enum: ["Active", "Inactive"], default: "Active", index: true },
    deactivatedAt: { type: Date, default: null },
    deactivatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    salary: { type: Number, required: true, min: 0 },
    compensationType: { type: String, enum: ["Salary earner", "Wage earner", ""], default: "" },
    paymentFrequency: { type: String, enum: ["Monthly", "Weekly", ""], default: "" },
    nssfNumber: { type: String, trim: true, maxlength: 80, default: "" },
    tinNumber: { type: String, trim: true, maxlength: 80, default: "" },
    nssfApplies: { type: Boolean, default: false },
    taxApplies: { type: Boolean, default: false },
    image: { type: employeeImageSchema, default: () => ({}) },
    documents: { type: [employeeDocumentSchema], default: [] },
    notes: { type: String, trim: true, maxlength: 2000, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_document, value) {
        value.id = String(value._id);
        delete value._id;
        delete value.__v;
        delete value.migrationKey;
        return value;
      },
    },
    toObject: {
      transform(_document, value) {
        value.id = String(value._id);
        delete value._id;
        delete value.__v;
        delete value.migrationKey;
        return value;
      },
    },
  },
);

employeeSchema.index({ department: 1, status: 1 });
employeeSchema.index({ name: 1 });
employeeSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { userId: { $type: "objectId" } } },
);

module.exports =
  mongoose.models.Employee || mongoose.model("Employee", employeeSchema);
