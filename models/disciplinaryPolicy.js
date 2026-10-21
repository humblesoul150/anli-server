const mongoose = require("mongoose");

const responseRuleSchema = new mongoose.Schema(
  {
    required: { type: Boolean, default: true },
    responseWindowDays: { type: Number, min: 1, max: 60, default: 5 },
  },
  { _id: false },
);

const disciplinaryPolicySchema = new mongoose.Schema(
  {
    _id: { type: String, default: "global" },
    responseRules: {
      type: Map,
      of: responseRuleSchema,
      default: () => new Map(),
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true, versionKey: false },
);

module.exports = mongoose.models.DisciplinaryPolicy
  || mongoose.model("DisciplinaryPolicy", disciplinaryPolicySchema);
