require("dotenv").config();
const mongoose = require("mongoose");
const Sale = require("../models/sale");
const SalePayment = require("../models/salePayment");
const { allocateCreditPaymentReceiptNumber } = require("../lib/creditPaymentReceipt");

async function backfill(apply) {
  const payments = SalePayment.aggregate([
    { $match: { $or: [{ paymentReceiptNumber: { $exists: false } }, { paymentReceiptNumber: null }] } },
    { $lookup: { from: Sale.collection.name, localField: "saleId", foreignField: "_id", as: "sale" } },
    { $unwind: "$sale" },
    { $match: { "sale.paymentTerms": "Credit" } },
    { $sort: { date: 1, _id: 1 } },
    { $project: { _id: 1, date: 1 } },
  ]).cursor({ batchSize: 100 });
  let migrated = 0;
  let pending = 0;
  for await (const payment of payments) {
    pending += 1;
    if (!apply) continue;
    await mongoose.connection.transaction(async (session) => {
      const current = await SalePayment.findOne({
        _id: payment._id,
        $or: [{ paymentReceiptNumber: { $exists: false } }, { paymentReceiptNumber: null }],
      }).session(session);
      if (!current) return;
      current.paymentReceiptNumber = await allocateCreditPaymentReceiptNumber(current.date, session);
      await current.save({ session });
    });
    migrated += 1;
  }
  return apply ? { mode: "applied", migrated } : { mode: "dry-run", pending };
}

async function main() {
  if (!process.env.DB_URL) throw new Error("DB_URL is required.");
  await mongoose.connect(process.env.DB_URL);
  try {
    const report = await backfill(process.argv.includes("--apply"));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { backfill };
