const mongoose = require("mongoose");

const customerSchema = new mongoose.Schema(
  {
    id: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      trim: true,
      maxlength: 80,
      match: /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    },
    name: { type: String, required: true, trim: true, maxlength: 180 },
    nameKey: { type: String, required: true, unique: true, maxlength: 180 },
    type: { type: String, required: true, trim: true, maxlength: 80 },
    contact: { type: String, trim: true, maxlength: 120, default: "" },
    phone: { type: String, required: true, trim: true, maxlength: 40 },
    email: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
    region: { type: String, trim: true, maxlength: 100, default: "" },
    district: { type: String, trim: true, maxlength: 100, default: "" },
    tin: { type: String, trim: true, maxlength: 80, default: "" },
    country: { type: String, trim: true, maxlength: 100, default: "" },
    referredBy: { type: String, trim: true, maxlength: 120, default: "" },
    notes: { type: String, trim: true, maxlength: 2000, default: "" },
    status: { type: String, enum: ["Active", "Inactive", "Suspended"], default: "Active", required: true },
    archivedAt: { type: Date, default: null },
    purchases: { type: Number, min: 0, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true, versionKey: false },
);

customerSchema.index({ createdAt: -1, _id: -1 });

module.exports = mongoose.models.Customer || mongoose.model("Customer", customerSchema);
