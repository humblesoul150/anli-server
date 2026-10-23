const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    recipientId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, enum: ["credit_due", "credit_overdue"], required: true },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    message: { type: String, required: true, trim: true, maxlength: 500 },
    saleId: { type: mongoose.Schema.Types.ObjectId, ref: "Sale", required: true },
    receiptNumber: { type: String, required: true, trim: true, maxlength: 40 },
    dueDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    balance: { type: Number, required: true, min: 0, validate: Number.isInteger },
    thresholdKey: { type: String, required: true, trim: true, maxlength: 160 },
    readAt: { type: Date, default: null },
  },
  { timestamps: true },
);

notificationSchema.index({ recipientId: 1, createdAt: -1 });
notificationSchema.index({ recipientId: 1, readAt: 1, createdAt: -1 });
notificationSchema.index({ recipientId: 1, thresholdKey: 1 }, { unique: true });

notificationSchema.set("toJSON", {
  transform(_document, value) {
    value.id = String(value._id);
    value.saleId = String(value.saleId);
    delete value._id;
    delete value.__v;
    return value;
  },
});

module.exports = mongoose.models.Notification || mongoose.model("Notification", notificationSchema);
