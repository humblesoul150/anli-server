const mongoose = require("mongoose");

const ASSET_EVENT_TYPES = [
  "Acquired",
  "Inspection",
  "Transfer",
  "Assignment",
  "Maintenance",
  "Status change",
  "Disposed",
  "Profile correction",
  "Maintenance completed",
];

const companyAssetEventSchema = new mongoose.Schema(
  {
    assetId: { type: mongoose.Schema.Types.ObjectId, ref: "CompanyAsset", required: true, index: true },
    assetTag: { type: String, required: true, trim: true, maxlength: 80 },
    eventType: { type: String, required: true, enum: ASSET_EVENT_TYPES },
    eventDate: { type: Date, required: true, default: Date.now },
    title: { type: String, trim: true, maxlength: 160, default: "" },
    description: { type: String, trim: true, maxlength: 1000, default: "" },
    work: { type: String, trim: true, maxlength: 1000, default: "" },
    provider: { type: String, trim: true, maxlength: 160, default: "" },
    reason: { type: String, trim: true, maxlength: 500, default: "" },
    note: { type: String, trim: true, maxlength: 1000, default: "" },
    fromLocation: { type: String, trim: true, maxlength: 160, default: "" },
    toLocation: { type: String, trim: true, maxlength: 160, default: "" },
    condition: { type: String, enum: ["Good", "Fair", "Needs repair", "Unserviceable"], default: null },
    status: { type: String, enum: ["Active", "Under maintenance", "Disposed"], default: null },
    location: { type: String, trim: true, maxlength: 160, default: "" },
    assignee: { type: String, trim: true, maxlength: 160, default: "" },
    department: { type: String, trim: true, maxlength: 120, default: "" },
    cost: { type: Number, min: 0, default: null },
    nextInspectionDate: { type: Date, default: null },
    nextServiceDate: { type: Date, default: null },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    actorName: { type: String, required: true, trim: true, maxlength: 120 },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    importKey: { type: String, maxlength: 64 },
  },
  { timestamps: true, versionKey: false },
);

companyAssetEventSchema.index({ assetId:  1, eventDate: -1, _id: -1 });
companyAssetEventSchema.index({ importKey: 1 }, { unique: true, sparse: true });

module.exports = mongoose.models.CompanyAssetEvent ||
  mongoose.model("CompanyAssetEvent", companyAssetEventSchema);
module.exports.ASSET_EVENT_TYPES = ASSET_EVENT_TYPES;
