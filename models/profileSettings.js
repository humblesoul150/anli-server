const mongoose = require("mongoose");

const profileSettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "global" },
    legalName: { type: String, default: "" },
    tradingName: { type: String, default: "" },
    email: { type: String, default: "" },
    phone: { type: String, default: "" },
    website: { type: String, default: "" },
    addressLine1: { type: String, default: "" },
    addressLine2: { type: String, default: "" },
    city: { type: String, default: "" },
    region: { type: String, default: "" },
    postalCode: { type: String, default: "" },
    country: { type: String, default: "" },
    tin: { type: String, default: "" },
    registrationNumber: { type: String, default: "" },
    registrationAuthority: { type: String, default: "" },
    logo: {
      url: { type: String, default: "" },
      publicId: { type: String, default: "" },
    },
  },
  { timestamps: true },
);

const ProfileSettings =
  mongoose.models.ProfileSettings ||
  mongoose.model("ProfileSettings", profileSettingsSchema);

module.exports = ProfileSettings;
