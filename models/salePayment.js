const mongoose = require("mongoose");

const METHODS = ["Cash", "Mobile Money", "Bank Transfer", "Check", "Card"];

const salePaymentSchema = new mongoose.Schema(
  {
    saleId: { type: mongoose.Schema.Types.ObjectId, ref: "Sale", required: true, index: true },
    paymentReceiptNumber: { type: String, trim: true, maxlength: 40, sparse: true, unique: true },
    amount: { type: Number, required: true, min: 1, validate: Number.isInteger },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    method: { type: String, enum: [...METHODS, "Legacy"], required: true },
    txnID: { type: String, trim: true, maxlength: 120, default: "" },
    note: { type: String, trim: true, maxlength: 500, default: "" },
    legacyId: { type: String, trim: true, maxlength: 140, sparse: true, unique: true },
    orderPaymentId: { type: mongoose.Schema.Types.ObjectId, ref: "OrderPayment", unique: true, sparse: true },
    idempotencyKey: { type: String, trim: true, maxlength: 120, sparse: true, unique: true },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_document, value) {
        value.id = String(value._id);
        value.saleId = String(value.saleId);
        delete value._id;
        delete value.__v;
        return value;
      },
    },
  },
);

salePaymentSchema.index({ saleId: 1, date: -1, _id: -1 });

module.exports = mongoose.models.SalePayment || mongoose.model("SalePayment", salePaymentSchema);
module.exports.METHODS = METHODS;
