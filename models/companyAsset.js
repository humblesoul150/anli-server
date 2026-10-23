const mongoose = require("mongoose");

const photoSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, maxlength: 80 },
    url: { type: String, required: true, maxlength: 1000 },
    publicId: { type: String, required: true, maxlength: 300 },
    uploadedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const companyAssetSchema = new mongoose.Schema(
  {
    assetTag: { type: String, required: true, trim: true, maxlength: 80 },
    assetTagNormalized: { type: String, required: true, trim: true, maxlength: 80 },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    category: {
      type: String,
      required: true,
      enum: ["Office assets", "Vehicles", "Production assets", "Store", "Machinery", "Others"],
    },
    assetType: { type: String, trim: true, maxlength: 100, default: "" },
    makeModel: { type: String, trim: true, maxlength: 160, default: "" },
    serialNumber: { type: String, trim: true, maxlength: 120, default: "" },
    registration: { type: String, trim: true, maxlength: 80, default: "" },
    vin: { type: String, trim: true, maxlength: 100, default: "" },
    mileage: { type: Number, min: 0, default: null },
    capacity: { type: String, trim: true, maxlength: 100, default: "" },
    productionLine: { type: String, trim: true, maxlength: 120, default: "" },
    serviceInterval: { type: String, trim: true, maxlength: 100, default: "" },
    acquisitionDate: { type: Date, default: null },
    acquisitionCost: { type: Number, min: 0, default: null },
    supplier: { type: String, trim: true, maxlength: 160, default: "" },
    warrantyEnd: { type: Date, default: null },
    location: { type: String, trim: true, maxlength: 160, default: "" },
    assignee: { type: String, trim: true, maxlength: 160, default: "" },
    department: { type: String, trim: true, maxlength: 120, default: "" },
    condition: {
      type: String,
      enum: ["Good", "Fair", "Needs repair", "Unserviceable"],
      default: "Good",
    },
    status: {
      type: String,
      enum: ["Active", "Under maintenance", "Disposed"],
      default: "Active",
    },
    conditionNotes: { type: String, trim: true, maxlength: 1000, default: "" },
    nextInspectionDate: { type: Date, default: null },
    nextServiceDate: { type: Date, default: null },
    insuranceDueDate: { type: Date, default: null },
    notes: { type: String, trim: true, maxlength: 2000, default: "" },
    photos: { type: [photoSchema], default: [] },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_document, value) {
        value.id = String(value._id);
        delete value._id;
        delete value.__v;
        delete value.assetTagNormalized;
        return value;
      },
    },
  },
);

companyAssetSchema.index({ assetTagNormalized: 1 }, { unique: true });
companyAssetSchema.index({ _id: -1 });
companyAssetSchema.index({ category: 1, _id: -1 });
companyAssetSchema.index({ status: 1, _id: -1 });

module.exports = mongoose.models.CompanyAsset ||
  mongoose.model("CompanyAsset", companyAssetSchema);
