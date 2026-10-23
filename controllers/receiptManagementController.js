const mongoose = require("mongoose");
const Sale = require("../models/sale");
const SalePayment = require("../models/salePayment");
const ReceiptManagementState = require("../models/receiptManagementState");
const audit = require("../lib/audit");

const RECEIPT_KINDS = new Set(["sales", "credit-payments"]);
const MAX_PAGE_SIZE = 100;

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function baseMatch(kind, query) {
  const match = kind === "sales"
    ? { voidedAt: null }
    : { paymentReceiptNumber: { $exists: true } };
  if (query.from || query.to) {
    if ((query.from && !validDate(query.from)) || (query.to && !validDate(query.to))) {
      return { error: "Receipt date filters must be valid YYYY-MM-DD dates." };
    }
    match.date = {};
    if (query.from) match.date.$gte = query.from;
    if (query.to) match.date.$lte = query.to;
  }
  if (query.search !== undefined) {
    if (typeof query.search !== "string" || query.search.length > 100) {
      return { error: "Receipt search must be 100 characters or fewer." };
    }
    const search = query.search.trim();
    if (search && kind === "sales") {
      const escaped = escapeRegex(search);
      match.$or = [
        { receiptNumber: { $regex: escaped, $options: "i" } },
        { "customer.name": { $regex: escaped, $options: "i" } },
        { "lines.productName": { $regex: escaped, $options: "i" } },
      ];
    }
  }
  return { match };
}

function receiptPipeline(kind, match, userId, query, cursor) {
  const payment = kind === "credit-payments";
  const pipeline = [{ $match: match }];
  if (cursor) pipeline.push({ $match: { _id: { $lt: new mongoose.Types.ObjectId(cursor) } } });
  if (payment) {
    pipeline.push(
      { $lookup: { from: "sales", localField: "saleId", foreignField: "_id", as: "sale" } },
      { $unwind: "$sale" },
      { $match: { "sale.paymentTerms": "Credit", "sale.voidedAt": null } },
    );
    if (query.search?.trim()) {
      const search = escapeRegex(query.search.trim());
      pipeline.push({
        $match: {
          $or: [
            { paymentReceiptNumber: { $regex: search, $options: "i" } },
            { txnID: { $regex: search, $options: "i" } },
            { "sale.receiptNumber": { $regex: search, $options: "i" } },
            { "sale.customer.name": { $regex: search, $options: "i" } },
          ],
        },
      });
    }
  } else {
    pipeline.push({
      $lookup: {
        from: "salepayments",
        localField: "_id",
        foreignField: "saleId",
        as: "receiptPayments",
      },
    });
  }
  pipeline.push(
    {
      $lookup: {
        from: "receiptmanagementstates",
        let: { sourceId: "$_id" },
        pipeline: [{
          $match: {
            $expr: {
              $and: [
                { $eq: ["$sourceType", payment ? "credit-payment" : "sale"] },
                { $eq: ["$sourceId", "$$sourceId"] },
              ],
            },
          },
        }],
        as: "managementState",
      },
    },
    { $unwind: { path: "$managementState", preserveNullAndEmptyArrays: true } },
    {
      $addFields: {
        isFavorite: { $in: [userId, { $ifNull: ["$managementState.favoriteUserIds", []] }] },
        isArchived: { $ne: [{ $ifNull: ["$managementState.archivedAt", null] }, null] },
      },
    },
  );
  if (query.favorite === "true") pipeline.push({ $match: { isFavorite: true } });
  if (query.archived === "true") pipeline.push({ $match: { isArchived: true } });
  else pipeline.push({ $match: { isArchived: false } });
  pipeline.push({ $sort: { _id: -1 } });
  return pipeline;
}

function serializeReceipt(row, kind) {
  const payment = kind === "credit-payments";
  const sale = payment ? row.sale : row;
  return {
    id: String(row._id),
    kind: payment ? "credit-payment" : "sale",
    receiptNumber: payment ? row.paymentReceiptNumber : row.receiptNumber,
    date: row.date,
    amount: payment ? row.amount : sale.total,
    customer: sale.customer,
    company: sale.company,
    lines: payment ? [] : sale.lines,
    payments: payment ? undefined : (row.receiptPayments || []).map((item) => ({
      receiptNumber: item.paymentReceiptNumber || "",
      date: item.date,
      amount: item.amount,
      method: item.method,
      txnID: item.txnID || "",
    })),
    saleReceiptNumber: payment ? sale.receiptNumber : undefined,
    saleId: String(sale._id),
    payment: payment ? {
      amount: row.amount,
      method: row.method,
      txnID: row.txnID,
      note: row.note,
    } : undefined,
    total: payment ? undefined : sale.total,
    paidAmount: payment ? undefined : sale.paidAmount,
    balance: payment ? undefined : Math.max(0, sale.total - sale.paidAmount),
    isFavorite: Boolean(row.isFavorite),
    isArchived: Boolean(row.isArchived),
    archivedAt: row.managementState?.archivedAt || null,
  };
}

async function listReceipts(request, response) {
  const kind = request.params.kind;
  if (!RECEIPT_KINDS.has(kind)) return response.status(400).json({ error: "Receipt type is invalid." });
  if (request.query.favorite !== undefined && !["true", "false"].includes(request.query.favorite)) {
    return response.status(400).json({ error: "Favorite filter is invalid." });
  }
  if (request.query.archived !== undefined && !["true", "false"].includes(request.query.archived)) {
    return response.status(400).json({ error: "Archive filter is invalid." });
  }
  const limitValue = Number(request.query.limit || 50);
  if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > MAX_PAGE_SIZE) {
    return response.status(400).json({ error: `Receipt page size must be between 1 and ${MAX_PAGE_SIZE}.` });
  }
  const { match, error } = baseMatch(kind, request.query);
  if (error) return response.status(400).json({ error });
  const cursor = request.query.cursor;
  if (cursor && !mongoose.isValidObjectId(cursor)) return response.status(400).json({ error: "Receipt cursor is invalid." });
  const model = kind === "sales" ? Sale : SalePayment;
  const pipeline = receiptPipeline(kind, match, request.authUser._id, request.query, cursor);
  const rows = await model.aggregate([...pipeline, { $limit: limitValue + 1 }]);
  const hasMore = rows.length > limitValue;
  const page = rows.slice(0, limitValue);

  const statsPipeline = receiptPipeline(kind, match, request.authUser._id, request.query, null);
  statsPipeline.push({
    $group: {
      _id: null,
      count: { $sum: 1 },
      totalAmount: { $sum: kind === "sales" ? "$total" : "$amount" },
      totalPaid: { $sum: kind === "sales" ? "$paidAmount" : "$amount" },
      outstanding: kind === "sales"
        ? { $sum: { $max: [0, { $subtract: ["$total", "$paidAmount"] }] } }
        : { $sum: 0 },
    },
  });
  const [stats] = await model.aggregate(statsPipeline);
  return response.json({
    receipts: page.map((row) => serializeReceipt(row, kind)),
    nextCursor: hasMore ? String(page[page.length - 1]._id) : null,
    stats: {
      count: stats?.count || 0,
      totalAmount: stats?.totalAmount || 0,
      totalPaid: stats?.totalPaid || 0,
      outstanding: stats?.outstanding || 0,
    },
  });
}

async function setFavorite(request, response) {
  return updateState(request, response, "favorite");
}

async function setArchived(request, response) {
  return updateState(request, response, "archived");
}

async function recordBulkExport(request, response) {
  const { kind, action, count, filters } = request.body || {};
  if (!RECEIPT_KINDS.has(kind) || !["print", "download"].includes(action) ||
      !Number.isSafeInteger(count) || count < 0 || count > 100000 ||
      !filters || typeof filters !== "object" || Array.isArray(filters)) {
    return response.status(400).json({ error: "Bulk receipt export details are invalid." });
  }
  await audit.recordAudit({
    request,
    eventType: "receipt.bulk_exported",
    outcome: "success",
    details: {
      receiptKind: kind === "sales" ? "sale" : "credit-payment",
      action,
      count,
      filters: {
        from: typeof filters.from === "string" ? filters.from.slice(0, 10) : "",
        to: typeof filters.to === "string" ? filters.to.slice(0, 10) : "",
        search: typeof filters.search === "string" ? filters.search.slice(0, 100) : "",
        favorite: filters.favorite === true,
        archived: filters.archived === true,
      },
    },
  });
  return response.status(204).end();
}

async function updateState(request, response, action) {
  const kind = request.params.kind;
  const id = request.params.id;
  const enabled = request.body?.enabled;
  if (!RECEIPT_KINDS.has(kind) || !mongoose.isValidObjectId(id) || typeof enabled !== "boolean") {
    return response.status(400).json({ error: "Provide a valid receipt and boolean enabled value." });
  }
  const payment = kind === "credit-payments";
  let exists;
  if (payment) {
    exists = await SalePayment.exists({ _id: id, paymentReceiptNumber: { $exists: true } });
    if (exists) {
      const record = await SalePayment.findById(id).select("saleId").lean();
      exists = await Sale.exists({ _id: record.saleId, paymentTerms: "Credit", voidedAt: null });
    }
  } else {
    exists = await Sale.exists({ _id: id, voidedAt: null });
  }
  if (!exists) return response.status(404).json({ error: "Receipt not found." });

  const sourceType = payment ? "credit-payment" : "sale";
  const sourceId = new mongoose.Types.ObjectId(id);
  const update = action === "favorite"
    ? enabled ? { $addToSet: { favoriteUserIds: request.authUser._id } } : { $pull: { favoriteUserIds: request.authUser._id } }
    : enabled
      ? { $set: { archivedAt: new Date(), archivedBy: request.authUser._id, restoredAt: null, restoredBy: null } }
      : { $set: { archivedAt: null, archivedBy: null, restoredAt: new Date(), restoredBy: request.authUser._id } };
  const eventType = action === "favorite" ? "receipt.favorite_updated" : enabled ? "receipt.archived" : "receipt.restored";
  const state = await mongoose.connection.transaction(async (session) => {
    const updatedState = await ReceiptManagementState.findOneAndUpdate(
      { sourceType, sourceId },
      { $setOnInsert: { sourceType, sourceId }, ...update },
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true, session },
    );
    await audit.recordAudit({
      request,
      eventType,
      outcome: "success",
      details: { receiptKind: sourceType, sourceId: String(id), enabled },
      transaction: session,
    });
    return updatedState;
  });
  return response.json({
    enabled: action === "favorite"
      ? state.favoriteUserIds.some((userId) => String(userId) === String(request.authUser._id))
      : Boolean(state.archivedAt),
    archivedAt: state.archivedAt,
  });
}

module.exports = { listReceipts, setFavorite, setArchived, recordBulkExport };
