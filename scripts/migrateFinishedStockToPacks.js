require("dotenv").config();
const mongoose = require("mongoose");
const FinishedProduct = require("../models/finishedProduct");
const FinishedStockBalance = require("../models/finishedStockBalance");
const FinishedStockMovement = require("../models/finishedStockMovement");
const FinishedStockMigration = require("../models/finishedStockMigration");

const kampalaDate = (date) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Kampala",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(date);

function nextKampalaDate(date = new Date()) {
  const current = kampalaDate(date);
  const next = new Date(`${current}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

async function buildMigrationPlan() {
  const products = await FinishedProduct.find().sort({ name: 1 }).lean();
  const balances = await FinishedStockBalance.find().lean();
  const balanceMap = new Map(balances.map((balance) => [String(balance.productId), balance]));
  const plan = [];
  for (const product of products) {
    const balance = balanceMap.get(String(product._id));
    if (balance?.inventoryUnit === "pack" && Number.isInteger(balance.quantityPacks)) {
      plan.push({ product, balance, status: "already_migrated" });
      continue;
    }
    const quantityPieces = Number(balance?.quantityPieces ?? 0);
    const reservedPieces = Number(balance?.reservedPieces ?? 0);
    const hasMovements = await FinishedStockMovement.exists({ productId: product._id });
    const blockers = [];
    if (!["Box", "Carton"].includes(product.packType) ||
      !Number.isInteger(product.piecesPerPack) ||
      product.piecesPerPack < 1 ||
      !Number.isFinite(product.packWeightKg) ||
      product.packWeightKg <= 0) {
      blockers.push("product needs a configured box or carton, pieces per pack, and pack weight");
    }
    if (!balance && hasMovements) blockers.push("stock movements exist but no piece balance was found");
    if (!Number.isInteger(quantityPieces) || quantityPieces < 0) blockers.push("piece balance is invalid");
    if (!Number.isInteger(reservedPieces) || reservedPieces < 0 || reservedPieces > quantityPieces) blockers.push("reserved piece balance is invalid");
    if (product.piecesPerPack && reservedPieces % product.piecesPerPack !== 0) blockers.push("reserved pieces are not a whole number of current packs");
    if (blockers.length) {
      plan.push({ product, balance, status: "blocked", blockers });
      continue;
    }
    const piecesPerPack = product.piecesPerPack || 1;
    const quantityPacks = Math.floor(quantityPieces / piecesPerPack);
    plan.push({
      product,
      balance,
      status: "ready",
      piecesPerPack,
      quantityPieces,
      reservedPieces,
      quantityPacks,
      reservedPacks: reservedPieces / piecesPerPack,
      loosePieces: quantityPieces % piecesPerPack,
    });
  }
  return plan;
}

async function migrate(apply) {
  const plan = await buildMigrationPlan();
  const blocked = plan.filter((item) => item.status === "blocked");
  const savedMigration = await FinishedStockMigration.findById("finished-stock-packs-v1").lean();
  let effectiveDate = savedMigration?.effectiveDate ?? nextKampalaDate();
  if (!apply) {
    return {
      mode: "dry-run",
      effectiveDate,
      productCount: plan.length,
      alreadyMigrated: plan.filter((item) => item.status === "already_migrated").length,
      ready: plan.filter((item) => item.status === "ready").map(({ product, quantityPieces, quantityPacks, reservedPacks, loosePieces }) => ({
        productId: String(product._id),
        productName: product.name,
        piecesPerPack: product.piecesPerPack || 1,
        quantityPieces,
        quantityPacks,
        reservedPacks,
        loosePieces,
      })),
      blocked: blocked.map(({ product, blockers }) => ({ productId: String(product._id), productName: product.name, blockers })),
    };
  }
  if (blocked.length) {
    const error = new Error("Migration was not applied because one or more products need reconciliation.");
    error.report = blocked.map(({ product, blockers }) => ({ productId: String(product._id), productName: product.name, blockers }));
    throw error;
  }

  const migration = await FinishedStockMigration.findOneAndUpdate(
    { _id: "finished-stock-packs-v1" },
    { $setOnInsert: { effectiveDate } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  effectiveDate = migration.effectiveDate;
  const collection = FinishedStockBalance.collection;
  for (const item of plan.filter((entry) => entry.status === "ready")) {
    const values = {
      inventoryUnit: "pack",
      quantityPacks: item.quantityPacks,
      reservedPacks: item.reservedPacks,
      loosePieces: item.loosePieces,
      openingQuantityPacks: item.quantityPacks,
      inventoryEffectiveDate: effectiveDate,
      legacyQuantityPieces: item.quantityPieces,
      legacyReservedPieces: item.reservedPieces,
    };
    if (item.balance) {
      const result = await collection.updateOne(
        { _id: item.balance._id, inventoryUnit: { $ne: "pack" } },
        { $set: values, $unset: { quantityPieces: "", reservedPieces: "" } },
      );
      if (!result.modifiedCount) throw new Error(`Stock balance changed during migration for ${item.product.name}.`);
    } else {
      try {
        await collection.insertOne({
          productId: item.product._id,
          ...values,
          updatedBy: item.product.updatedBy || item.product.createdBy,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      } catch (error) {
        if (error?.code !== 11000) throw error;
        throw new Error(`Stock balance appeared during migration for ${item.product.name}.`);
      }
    }
  }
  return {
    mode: "applied",
    effectiveDate,
    migratedProducts: plan.filter((item) => item.status === "ready").length,
    alreadyMigrated: plan.filter((item) => item.status === "already_migrated").length,
    loosePieces: plan.filter((item) => item.status === "ready").reduce((total, item) => total + item.loosePieces, 0),
  };
}

async function main() {
  if (!process.env.DB_URL) throw new Error("DB_URL is required.");
  await mongoose.connect(process.env.DB_URL);
  try {
    const report = await migrate(process.argv.includes("--apply"));
    console.log(JSON.stringify(report, null, 2));
    if (report.blocked?.length) process.exitCode = 2;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    if (error.report) console.error(JSON.stringify(error.report, null, 2));
    process.exitCode = 1;
  });
}

module.exports = { buildMigrationPlan, migrate, nextKampalaDate };
