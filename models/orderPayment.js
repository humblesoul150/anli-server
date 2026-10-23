const mongoose = require("mongoose");

const orderPaymentSchema = new mongoose.Schema(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
    amount: { type: Number, required: true, min: 1, validate: Number.isInteger },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    method: { type: String, enum: ["Cash", "Mobile Money", "Bank Transfer", "Check", "Card"], required: true },
    txnID: { type: String, trim: true, maxlength: 120, default: "" },
    note: { type: String, trim: true, maxlength: 500, default: "" },
    idempotencyKey: { type: String, required: true, trim: true, maxlength: 120, unique: true },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    salePaymentId: { type: mongoose.Schema.Types.ObjectId, ref: "SalePayment", default: null },
  },
  { timestamps: true },
);

orderPaymentSchema.index({ orderId: 1, date: 1, _id: 1 });

module.exports = mongoose.models.OrderPayment || mongoose.model("OrderPayment", orderPaymentSchema);
