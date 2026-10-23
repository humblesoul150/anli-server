const FinishedStockBalance = require("../models/finishedStockBalance");
const FinishedStockMovement = require("../models/finishedStockMovement");
const RawMaterialBalance = require("../models/rawMaterialBalance");
const RawMaterialMovement = require("../models/rawMaterialMovement");
const RawMaterialAlert = require("../models/rawMaterialAlert");
const RawMaterial = require("../models/rawMaterial");

async function getFinishedBalance(productId, session) {
  const query = FinishedStockBalance.findOne({ productId });
  if (session) query.session(session);
  const balance = await query.lean();
  return balance?.quantityPieces ?? 0;
}

async function getRawMaterialBalance(materialId, session, location) {
  const filter = { materialId };
  if (location) filter.location = location;
  const query = RawMaterialBalance.find(filter);
  if (session) query.session(session);
  const balances = await query.lean();
  return balances.reduce((total, balance) => total + balance.quantity, 0);
}

async function ensureFinishedBalance(productId, userId, session) {
  let balance = await FinishedStockBalance.findOne({ productId }).session(session);
  if (!balance) {
    [balance] = await FinishedStockBalance.create([{
      productId,
      quantityPieces: 0,
      updatedBy: userId,
    }], { session });
  }
}

async function ensureRawBalance(materialId, location, userId, session) {
  await RawMaterialBalance.findOneAndUpdate(
    { materialId, location },
    { $setOnInsert: { quantity: 0, reorderThreshold: 0, updatedBy: userId } },
    { upsert: true, new: true, session, setDefaultsOnInsert: true },
  );
}

async function applyFinishedStockDelta(productId, delta, userId, session) {
  await ensureFinishedBalance(productId, userId, session);
  const filter = { productId };
  if (delta < 0) {
    filter.$expr = {
      $gte: [{ $subtract: ["$quantityPieces", { $ifNull: ["$reservedPieces", 0] }] }, -delta],
    };
  }
  const result = await FinishedStockBalance.updateOne(
    filter,
    { $inc: { quantityPieces: delta }, $set: { updatedBy: userId } },
    { session },
  );
  if (!result.modifiedCount) {
    const error = new Error("Insufficient unreserved finished stock.");
    error.statusCode = 409;
    throw error;
  }
}

async function refreshRawMaterialAlert(materialId, location, session) {
  const [balance, material] = await Promise.all([
    RawMaterialBalance.findOne({ materialId, location }).session(session).lean(),
    RawMaterial.findById(materialId).session(session).lean(),
  ]);
  if (!balance || !material) return;
  const belowThreshold = balance.quantity <= balance.reorderThreshold;
  const existing = await RawMaterialAlert.findOne({ materialId, location }).session(session);
  const wasActive = existing?.status === "active";
  const update = {
    recipientUserId: balance.responsibleUserId ?? null,
    reorderThreshold: balance.reorderThreshold,
    currentQuantity: balance.quantity,
    status: belowThreshold ? "active" : "resolved",
    lastTriggeredAt: belowThreshold && !wasActive ? new Date() : existing?.lastTriggeredAt ?? null,
    resolvedAt: belowThreshold ? null : wasActive ? new Date() : existing?.resolvedAt ?? null,
  };
  if (existing) {
    Object.assign(existing, update);
    await existing.save({ session });
  } else {
    await RawMaterialAlert.create([{
      materialId,
      location,
      ...update,
    }], { session });
  }
}

async function applyRawMaterialStockDelta(materialId, delta, userId, session, location = "Main Warehouse") {
  await ensureRawBalance(materialId, location, userId, session);
  const filter = { materialId, location };
  if (delta < 0) filter.quantity = { $gte: -delta };
  const result = await RawMaterialBalance.updateOne(
    filter,
    { $inc: { quantity: delta }, $set: { updatedBy: userId } },
    { session },
  );
  if (!result.modifiedCount && delta !== 0) {
    const error = new Error("Insufficient raw-material stock.");
    error.statusCode = 409;
    throw error;
  }
  await refreshRawMaterialAlert(materialId, location, session);
}

async function recordFinishedStockMovement(input, session) {
  await applyFinishedStockDelta(
    input.productId,
    input.direction === "in" ? input.quantityPieces : -input.quantityPieces,
    input.actor,
    session,
  );
  const [movement] = await FinishedStockMovement.create([input], { session });
  return movement;
}

async function recordRawMaterialMovement(input, session) {
  if (input.direction === "transfer") {
    if (!input.fromLocation || !input.toLocation || input.fromLocation === input.toLocation) {
      const error = new Error("A transfer requires different source and destination locations.");
      error.statusCode = 400;
      throw error;
    }
    await applyRawMaterialStockDelta(input.materialId, -input.quantity, input.actor, session, input.fromLocation);
    await applyRawMaterialStockDelta(input.materialId, input.quantity, input.actor, session, input.toLocation);
  } else {
    const location = input.direction === "in"
      ? input.toLocation || input.location || "Main Warehouse"
      : input.fromLocation || input.location || "Main Warehouse";
    await applyRawMaterialStockDelta(
      input.materialId,
      input.direction === "in" ? input.quantity : -input.quantity,
      input.actor,
      session,
      location,
    );
  }
  const [movement] = await RawMaterialMovement.create([input], { session });
  return movement;
}

module.exports = {
  applyFinishedStockDelta,
  applyRawMaterialStockDelta,
  getFinishedBalance,
  getRawMaterialBalance,
  refreshRawMaterialAlert,
  recordFinishedStockMovement,
  recordRawMaterialMovement,
};
