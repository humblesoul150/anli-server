require("dotenv").config();
const mongoose = require("mongoose");
const ProductionMaterialUsage = require("../models/productionMaterialUsage");

async function migrate(apply) {
  const indexes = await ProductionMaterialUsage.collection.indexes();
  const runIndex = indexes.find((index) =>
    index.key?.productionRunId === 1 && Object.keys(index.key).length === 1,
  );
  const desired = runIndex?.unique === true && runIndex?.sparse === true;
  if (desired) return { mode: apply ? "applied" : "dry-run", changed: false };
  if (!apply) {
    return {
      mode: "dry-run",
      changed: true,
      existingIndex: runIndex?.name ?? null,
      requiredIndex: { productionRunId: 1, unique: true, sparse: true },
    };
  }
  if (runIndex) await ProductionMaterialUsage.collection.dropIndex(runIndex.name);
  await ProductionMaterialUsage.collection.createIndex(
    { productionRunId: 1 },
    { unique: true, sparse: true },
  );
  return { mode: "applied", changed: true };
}

async function main() {
  if (!process.env.DB_URL) throw new Error("DB_URL is required.");
  await mongoose.connect(process.env.DB_URL);
  try {
    console.log(JSON.stringify(await migrate(process.argv.includes("--apply")), null, 2));
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

module.exports = { migrate };
