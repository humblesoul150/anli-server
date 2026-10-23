const mongoose = require("mongoose");

const receiptSequenceSchema = new mongoose.Schema(
  {
    _id: { type: Number, min: 2000, max: 9999 },
    sequence: { type: Number, required: true, min: 0, validate: Number.isInteger, default: 0 },
  },
  { versionKey: false },
);

module.exports =
  mongoose.models.ReceiptSequence ||
  mongoose.model("ReceiptSequence", receiptSequenceSchema);
