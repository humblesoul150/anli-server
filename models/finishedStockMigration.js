const mongoose = require("mongoose");

const finishedStockMigrationSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    effectiveDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    appliedAt: { type: Date, required: true, default: Date.now },
  },
  { versionKey: false },
);

module.exports = mongoose.models.FinishedStockMigration ||
  mongoose.model("FinishedStockMigration", finishedStockMigrationSchema);
