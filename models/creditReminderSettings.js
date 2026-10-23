const mongoose = require("mongoose");

const creditReminderSettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "global" },
    daysBeforeDue: {
      type: [Number],
      default: [7, 1, 0],
      validate: (values) => values.length > 0 && values.length <= 10 &&
        new Set(values).size === values.length &&
        values.every((value) => Number.isInteger(value) && value >= 0 && value <= 90),
    },
    daysAfterDue: {
      type: [Number],
      default: [1, 3, 7],
      validate: (values) => values.length > 0 && values.length <= 10 &&
        new Set(values).size === values.length &&
        values.every((value) => Number.isInteger(value) && value >= 1 && value <= 365),
    },
    repeatOverdueEveryDays: { type: Number, default: 7, min: 1, max: 90, validate: Number.isInteger },
    escalateAfterDays: { type: Number, default: 7, min: 1, max: 365, validate: Number.isInteger },
    timeZone: { type: String, default: "Africa/Kampala", enum: ["Africa/Kampala"] },
  },
  { timestamps: true },
);

module.exports = mongoose.models.CreditReminderSettings ||
  mongoose.model("CreditReminderSettings", creditReminderSettingsSchema);
