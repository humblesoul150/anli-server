const mongoose = require("mongoose");

const sessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    tokenHash: { type: String, required: true, unique: true, select: false },
    userAgent: { type: String, trim: true, maxlength: 300, default: "Unknown device" },
    createdAt: { type: Date, required: true, default: Date.now },
    lastActivityAt: { type: Date, required: true, default: Date.now },
    absoluteExpiresAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    sessionVersion: { type: Number, required: true },
  },
  { versionKey: false },
);

sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
sessionSchema.index({ userId: 1, revokedAt: 1, absoluteExpiresAt: 1 });

module.exports =
  mongoose.models.Session || mongoose.model("Session", sessionSchema);
