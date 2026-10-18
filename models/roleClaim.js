const mongoose = require("mongoose");

const roleClaimSchema = new mongoose.Schema(
  {
    _id: { type: String },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { versionKey: false },
);

module.exports =
  mongoose.models.RoleClaim || mongoose.model("RoleClaim", roleClaimSchema);
