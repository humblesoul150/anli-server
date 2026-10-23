const mongoose = require("mongoose");

const expenseEventSchema = new mongoose.Schema(
  {
    expenseId: { type: mongoose.Schema.Types.ObjectId, ref: "Expense", required: true, index: true },
    reference: { type: String, required: true, maxlength: 50 },
    eventType: {
      type: String,
      enum: ["Created", "Approved", "Rejected", "Payment recorded", "Attachment uploaded", "Attachment removed", "Legacy imported"],
      required: true,
    },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    actorName: { type: String, required: true, maxlength: 120 },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, versionKey: false },
);

expenseEventSchema.index({ expenseId: 1, createdAt: -1, _id: -1 });

module.exports = mongoose.models.ExpenseEvent || mongoose.model("ExpenseEvent", expenseEventSchema);
