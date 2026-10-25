const mongoose = require("mongoose");

const notificationOutboxSchema = new mongoose.Schema(
  {
    eventKey: { type: String, required: true, unique: true, trim: true, maxlength: 240 },
    type: { type: String, required: true, trim: true, maxlength: 100 },
    category: {
      type: String,
      enum: ["approval", "leave", "payroll", "salary_advance", "expense", "inventory", "sales", "security", "general"],
      required: true,
    },
    severity: { type: String, enum: ["info", "action_required", "urgent"], default: "info", required: true },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    message: { type: String, required: true, trim: true, maxlength: 500 },
    resource: {
      type: { type: String, required: true, trim: true, maxlength: 60 },
      id: { type: String, required: true, trim: true, maxlength: 80 },
      reference: { type: String, trim: true, maxlength: 100 },
    },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    recipientIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    recipientRoles: [{ type: String, trim: true, maxlength: 80 }],
    excludeRecipientIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    occurredAt: { type: Date, required: true, default: Date.now },
    expiresAt: { type: Date, default: null },
    status: { type: String, enum: ["pending", "processing", "delivered", "failed"], default: "pending", required: true },
    attempts: { type: Number, min: 0, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    leaseUntil: { type: Date, default: null },
    processedAt: { type: Date, default: null },
    lastError: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true },
);

notificationOutboxSchema.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1 });

module.exports = mongoose.models.NotificationOutbox ||
  mongoose.model("NotificationOutbox", notificationOutboxSchema);
