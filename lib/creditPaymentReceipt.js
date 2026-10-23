const CreditPaymentReceiptSequence = require("../models/creditPaymentReceiptSequence");

async function allocateCreditPaymentReceiptNumber(date, session) {
  const year = Number(String(date).slice(0, 4));
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new Error("Credit payment receipt date must contain a valid year.");
  }
  const counter = await CreditPaymentReceiptSequence.findOneAndUpdate(
    { _id: year },
    { $inc: { sequence: 1 }, $setOnInsert: { _id: year } },
    { new: true, upsert: true, session, setDefaultsOnInsert: true },
  );
  return `CPR-${year}-${String(counter.sequence).padStart(6, "0")}`;
}

module.exports = { allocateCreditPaymentReceiptNumber };
