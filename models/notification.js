const mongoose = require("mongoose");

const resourceSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, trim: true, maxlength: 60 },
    id: { type: String, required: true, trim: true, maxlength: 80 },
    reference: { type: String, trim: true, maxlength: 100 },
  },
  { _id: false },
);

const notificationSchema = new mongoose.Schema(
  {
    recipientId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, required: true, trim: true, maxlength: 100 },
    category: {
      type: String,
      enum: ["approval", "leave", "payroll", "salary_advance", "expense", "inventory", "sales", "security", "general"],
      required: true,
    },
    severity: { type: String, enum: ["info", "action_required", "urgent"], default: "info", required: true },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    message: { type: String, required: true, trim: true, maxlength: 500 },
    resource: { type: resourceSchema, required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    eventId: { type: String, trim: true, maxlength: 120 },
    dedupeKey: { type: String, required: true, trim: true, maxlength: 240 },
    occurredAt: { type: Date, required: true, default: Date.now },
    readAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

notificationSchema.index({ recipientId: 1, createdAt: -1 });
notificationSchema.index({ recipientId: 1, readAt: 1, createdAt: -1 });
notificationSchema.index(
  { recipientId: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } },
);

notificationSchema.set("toJSON", {
  transform(_document, value) {
    value.id = String(value._id);
    if (value.resource) {
      value.resource.id = String(value.resource.id);
    } else if (value.saleId) {
      value.resource = { type: "sale", id: String(value.saleId), reference: value.receiptNumber };
    }
    delete value._id;
    delete value.__v;
    delete value.saleId;
    delete value.receiptNumber;
    delete value.balance;
    delete value.thresholdKey;
    return value;
  },
});

module.exports = mongoose.models.Notification || mongoose.model("Notification", notificationSchema);
