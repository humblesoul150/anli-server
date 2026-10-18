const mongoose = require("mongoose");

const bootstrapStateSchema = new mongoose.Schema(
  {
    _id: { type: String },
    ownerToken: { type: String },
    claimedAt: { type: Date },
    consumed: { type: Boolean, default: false },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { versionKey: false },
);

module.exports =
  mongoose.models.BootstrapState ||
  mongoose.model("BootstrapState", bootstrapStateSchema);
