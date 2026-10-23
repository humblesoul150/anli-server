const mongoose = require("mongoose");
const { createHash } = require("node:crypto");
const Customer = require("../models/customer");
const FinishedProduct = require("../models/finishedProduct");
const FinishedStockBalance = require("../models/finishedStockBalance");
const ProfileSettings = require("../models/profileSettings");
const Sale = require("../models/sale");
const SalePayment = require("../models/salePayment");
const Order = require("../models/order");
const OrderPayment = require("../models/orderPayment");
const OrderSequence = require("../models/orderSequence");
const ReceiptSequence = require("../models/receiptSequence");
const { allocateCreditPaymentReceiptNumber } = require("../lib/creditPaymentReceipt");
const audit = require("../lib/audit");
const { recordFinishedStockMovement } = require("../lib/productionInventory");

const ORDER_ROLES = ["Sales Manager", "General Manager", "Super Admin"];
const MAX_PAGE_SIZE = 200;
const ORDER_FIELDS = [
  "customerId", "items", "requestedDate", "fulfilmentMethod", "destination",
  "paymentTerms", "dueDate", "priority", "priorityReason", "notes", "idempotencyKey",
];

const validDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const objectId = (value) => typeof value === "string" && mongoose.isValidObjectId(value);
const actorId = (request) => request.authUser._id;
const today = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Kampala",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const invalid = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const serialize = (document) => {
  if (!document) return document;
  if (document.toJSON) return document.toJSON();
  const result = { ...document, id: String(document._id) };
  delete result._id;
  delete result.__v;
  return result;
};

function validateOrderFields(body, partial = false) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
    Object.keys(body).some((key) => !ORDER_FIELDS.includes(key))) {
    return { error: "Provide order fields in the supported request shape." };
  }
  const required = ["customerId", "items", "requestedDate", "fulfilmentMethod", "paymentTerms"];
  if (!partial && required.some((key) => body[key] === undefined)) {
    return { error: "Customer, items, requested date, fulfilment method, and payment terms are required." };
  }
  if (body.customerId !== undefined &&
    (typeof body.customerId !== "string" || !body.customerId.trim() || body.customerId.length > 80)) {
    return { error: "Choose an active saved customer." };
  }
  if (body.items !== undefined && (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100)) {
    return { error: "An order must contain between 1 and 100 product lines." };
  }
  const items = [];
  for (const item of body.items ?? []) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
      Object.keys(item).some((key) => !["productId", "packs", "pricePerPack", "overrideReason"].includes(key))) {
      return { error: "Each order line must contain a product, whole-pack quantity, and optional price override." };
    }
    if (!objectId(item.productId)) return { error: "Choose a valid finished product for every line." };
    const packs = Number(item.packs);
    if (!Number.isInteger(packs) || packs < 1) return { error: "Pack quantity must be a positive whole number." };
    const line = { productId: String(new mongoose.Types.ObjectId(item.productId)), packs };
    if (item.pricePerPack !== undefined) {
      const pricePerPack = Number(item.pricePerPack);
      if (!Number.isInteger(pricePerPack) || pricePerPack < 1) return { error: "Price overrides must be positive whole UGX per pack." };
      if (typeof item.overrideReason !== "string" || !item.overrideReason.trim() || item.overrideReason.length > 500) {
        return { error: "A reason of 500 characters or fewer is required for each price override." };
      }
      line.pricePerPack = pricePerPack;
      line.overrideReason = item.overrideReason.trim();
    } else if (item.overrideReason !== undefined) {
      return { error: "A price override reason requires an overridden price." };
    }
    items.push(line);
  }
  if (body.requestedDate !== undefined && !validDate(body.requestedDate)) return { error: "Requested date must be a valid YYYY-MM-DD date." };
  if (body.requestedDate !== undefined && body.requestedDate < today()) return { error: "Requested date cannot be in the past." };
  if (body.fulfilmentMethod !== undefined && !["Delivery", "Pickup"].includes(body.fulfilmentMethod)) return { error: "Choose Delivery or Pickup." };
  if (body.paymentTerms !== undefined && !["Paid now", "Same-day", "Credit"].includes(body.paymentTerms)) return { error: "Choose valid payment terms." };
  if (body.paymentTerms === "Credit" && !validDate(body.dueDate)) return { error: "Credit orders require a valid due date." };
  if (body.paymentTerms && body.paymentTerms !== "Credit" && body.dueDate !== undefined) return { error: "A due date is only valid for credit terms." };
  if (body.priority !== undefined && !["Normal", "High"].includes(body.priority)) return { error: "Choose Normal or High priority." };
  if (body.priority === "High" && (typeof body.priorityReason !== "string" || !body.priorityReason.trim())) return { error: "A reason is required for high-priority orders." };
  for (const [field, max] of [["destination", 500], ["priorityReason", 500], ["notes", 2000]]) {
    if (body[field] !== undefined && (typeof body[field] !== "string" || body[field].length > max)) {
      return { error: `${field} must be text of ${max} characters or fewer.` };
    }
  }
  if (body.idempotencyKey !== undefined &&
    (typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim() || body.idempotencyKey.length > 120)) {
    return { error: "A valid idempotencyKey is required." };
  }
  return { value: { ...body, items: body.items === undefined ? undefined : items } };
}

async function resolveOrderData(input, request, session) {
  const customer = await Customer.findOne({
    id: input.customerId,
    status: "Active",
    archivedAt: null,
  }).session(session).lean();
  if (!customer) throw invalid("The selected customer is missing, inactive, or archived.", 409);
  if (input.paymentTerms === "Credit" && !input.dueDate) throw invalid("Credit orders require a due date.");
  const productMap = new Map();
  for (const item of input.items) {
    if (!productMap.has(item.productId)) {
      const product = await FinishedProduct.findOne({ _id: item.productId, active: true }).session(session).lean();
      if (!product) throw invalid("A selected product is missing or inactive.", 409);
      if (!product.packType || !Number.isInteger(product.piecesPerPack) || product.piecesPerPack < 1 ||
        !Number.isInteger(product.price) || product.price < 1) {
        throw invalid(`${product.name} needs valid pack details and a catalog price before it can be ordered.`, 409);
      }
      productMap.set(item.productId, product);
    }
    if (item.pricePerPack !== undefined && !ORDER_ROLES.some((role) => request.authUser.roles?.includes(role))) {
      throw invalid("You do not have permission to override catalog prices.", 403);
    }
  }
  const lines = input.items.map((item) => {
    const product = productMap.get(item.productId);
    const pricePerPack = item.pricePerPack ?? product.price;
    const quantityPieces = item.packs * product.piecesPerPack;
    const lineTotal = item.packs * pricePerPack;
    if (!Number.isSafeInteger(quantityPieces) || !Number.isSafeInteger(lineTotal) || lineTotal < 1) {
      throw invalid("Order quantities or totals exceed supported values.");
    }
    return {
      productId: product._id,
      productCode: product.code,
      productName: product.name,
      packType: product.packType,
      piecesPerPack: product.piecesPerPack,
      packs: item.packs,
      quantityPieces,
      catalogPricePerPack: product.price,
      pricePerPack,
      overrideReason: item.overrideReason ?? "",
      lineTotal,
    };
  });
  const total = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  if (!Number.isSafeInteger(total) || total < 1) throw invalid("Order total exceeds supported values.");
  return {
    customer: {
      name: customer.name,
      contact: customer.contact || "",
      phone: customer.phone || "",
      email: customer.email || "",
      address: [customer.district, customer.region, customer.country].filter(Boolean).join(", "),
      tin: customer.tin || "",
    },
    lines,
    total,
  };
}

async function ensureStockBalance(productId, userId, session) {
  await FinishedStockBalance.findOneAndUpdate(
    { productId },
    { $setOnInsert: { quantityPieces: 0, reservedPieces: 0, updatedBy: userId } },
    { upsert: true, new: true, session, setDefaultsOnInsert: true },
  );
}

async function reserveOrderStock(order, userId, session) {
  const quantities = new Map();
  for (const item of order.items) {
    if (!item.productId || !item.quantityPieces) throw invalid("Legacy order lines must be reviewed and replaced before stock can be reserved.", 409);
    const key = String(item.productId);
    quantities.set(key, (quantities.get(key) ?? 0) + item.quantityPieces);
  }
  for (const [productId, quantityPieces] of quantities) {
    await ensureStockBalance(productId, userId, session);
    const result = await FinishedStockBalance.updateOne({
      productId,
      $expr: { $gte: [{ $subtract: ["$quantityPieces", { $ifNull: ["$reservedPieces", 0] }] }, quantityPieces] },
    }, { $inc: { reservedPieces: quantityPieces }, $set: { updatedBy: userId } }, { session });
    if (!result.modifiedCount) throw invalid("There is not enough unreserved finished stock to confirm this order.", 409);
  }
}

async function releaseOrderReservation(order, userId, session) {
  if (!order.reserved) return;
  const quantities = new Map();
  for (const item of order.items) {
    const key = String(item.productId);
    quantities.set(key, (quantities.get(key) ?? 0) + item.quantityPieces);
  }
  for (const [productId, quantityPieces] of quantities) {
    const result = await FinishedStockBalance.updateOne({
      productId,
      reservedPieces: { $gte: quantityPieces },
    }, { $inc: { reservedPieces: -quantityPieces }, $set: { updatedBy: userId } }, { session });
    if (!result.modifiedCount) throw invalid("The order stock reservation is inconsistent; contact an administrator.", 409);
  }
  order.reserved = false;
}

async function listOrders(request, response) {
  const page = Math.max(1, Number.parseInt(request.query.page, 10) || 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(request.query.limit, 10) || 50));
  const filter = {};
  if (request.query.status) filter.status = request.query.status;
  if (request.query.customerId) filter.customerId = request.query.customerId;
  if (request.query.archived === "true") filter.archivedAt = { $ne: null };
  else if (request.query.archived === "false") filter.archivedAt = null;
  const [orders, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Order.countDocuments(filter),
  ]);
  return response.json({ orders: orders.map(serialize), page, limit, total });
}

async function getOrder(request, response) {
  if (!objectId(request.params.id)) return response.status(400).json({ error: "Order ID is invalid." });
  const order = await Order.findById(request.params.id).lean();
  if (!order) return response.status(404).json({ error: "Order not found." });
  const payments = await OrderPayment.find({ orderId: order._id }).sort({ date: 1, _id: 1 }).lean();
  return response.json({ order: serialize(order), payments: payments.map(serialize) });
}

async function createOrder(request, response) {
  const { value, error } = validateOrderFields(request.body);
  if (error) return response.status(400).json({ error });
  if (!value.idempotencyKey) return response.status(400).json({ error: "A valid idempotencyKey is required." });
  try {
    const result = await mongoose.connection.transaction(async (session) => {
      const requestHash = createHash("sha256").update(JSON.stringify(value)).digest("hex");
      const replay = await Order.findOne({ idempotencyKey: value.idempotencyKey }).session(session);
      if (replay) {
        if (replay.requestHash !== requestHash) throw invalid("This retry key was already used with different order details.", 409);
        return { order: serialize(replay), replayed: true };
      }
      const resolved = await resolveOrderData(value, request, session);
      const date = today();
      const year = Number(date.slice(0, 4));
      const counter = await OrderSequence.findOneAndUpdate(
        { _id: year },
        { $inc: { sequence: 1 }, $setOnInsert: { _id: year } },
        { new: true, upsert: true, session, setDefaultsOnInsert: true },
      );
      const orderNumber = `ORD-${year}-${String(counter.sequence).padStart(6, "0")}`;
      const [order] = await Order.create([{
        orderNumber,
        orderYear: year,
        orderSequence: counter.sequence,
        customerId: value.customerId,
        customer: resolved.customer,
        items: resolved.lines,
        total: resolved.total,
        date,
        requestedDate: value.requestedDate,
        fulfilmentMethod: value.fulfilmentMethod,
        destination: value.destination?.trim() || "",
        paymentTerms: value.paymentTerms,
        dueDate: value.dueDate,
        priority: value.priority || "Normal",
        priorityReason: value.priorityReason?.trim() || "",
        notes: value.notes?.trim() || "",
        statusHistory: [{ type: "created", toStatus: "Pending", at: new Date(), actor: actorId(request) }],
        actor: actorId(request),
        updatedBy: actorId(request),
        idempotencyKey: value.idempotencyKey,
        requestHash,
      }], { session });
      await audit.recordAudit({
        request,
        eventType: "order.created",
        outcome: "success",
        details: { orderId: String(order._id), orderNumber, customerId: order.customerId, total: order.total },
        transaction: session,
      });
      return { order: serialize(order), replayed: false };
    });
    return response.status(result.replayed ? 200 : 201).json(result);
  } catch (error) {
    return nextError(error, response);
  }
}

async function updateOrder(request, response) {
  if (!objectId(request.params.id)) return response.status(400).json({ error: "Order ID is invalid." });
  const { value, error } = validateOrderFields(request.body, true);
  if (error) return response.status(400).json({ error });
  try {
    const result = await mongoose.connection.transaction(async (session) => {
      const order = await Order.findById(request.params.id).session(session);
      if (!order) throw invalid("Order not found.", 404);
      if (order.status !== "Pending" || order.reserved || order.legacyImported) throw invalid("Only pending, unreserved orders can be edited.", 409);
      const merged = { ...order.toObject(), ...value };
      const resolved = await resolveOrderData(merged, request, session);
      if (order.paidAmount > resolved.total) throw invalid("The updated order total cannot be lower than payments already recorded.", 409);
      const previousStatus = order.status;
      Object.assign(order, {
        customerId: merged.customerId,
        customer: resolved.customer,
        items: resolved.lines,
        total: resolved.total,
        requestedDate: merged.requestedDate,
        fulfilmentMethod: merged.fulfilmentMethod,
        destination: merged.destination?.trim() || "",
        paymentTerms: merged.paymentTerms,
        dueDate: merged.paymentTerms === "Credit" ? merged.dueDate : undefined,
        priority: merged.priority || "Normal",
        priorityReason: merged.priorityReason?.trim() || "",
        notes: merged.notes?.trim() || "",
        updatedBy: actorId(request),
      });
      order.statusHistory.push({ type: "updated", fromStatus: previousStatus, toStatus: previousStatus, at: new Date(), actor: actorId(request) });
      await order.save({ session });
      await audit.recordAudit({ request, eventType: "order.updated", outcome: "success", details: { orderId: String(order._id), orderNumber: order.orderNumber }, transaction: session });
      return serialize(order);
    });
    return response.json({ order: result });
  } catch (error) {
    return nextError(error, response);
  }
}

async function confirmOrder(request, response) {
  if (!objectId(request.params.id)) return response.status(400).json({ error: "Order ID is invalid." });
  try {
    const order = await mongoose.connection.transaction(async (session) => {
      const current = await Order.findById(request.params.id).session(session);
      if (!current) throw invalid("Order not found.", 404);
      if (current.status !== "Pending" || current.legacyImported) throw invalid("Only a new pending order can be confirmed.", 409);
      await reserveOrderStock(current, actorId(request), session);
      current.status = "Confirmed";
      current.reserved = true;
      current.updatedBy = actorId(request);
      current.statusHistory.push({ type: "confirmed", fromStatus: "Pending", toStatus: "Confirmed", at: new Date(), actor: actorId(request) });
      await current.save({ session });
      await audit.recordAudit({ request, eventType: "order.confirmed", outcome: "success", details: { orderId: String(current._id), orderNumber: current.orderNumber, reservationCreated: true }, transaction: session });
      return serialize(current);
    });
    return response.json({ order });
  } catch (error) {
    return nextError(error, response);
  }
}

async function changeOrderStatus(request, response) {
  if (!objectId(request.params.id)) return response.status(400).json({ error: "Order ID is invalid." });
  const { status, reason = "" } = request.body ?? {};
  if (!["In progress", "Ready", "Cancelled"].includes(status) ||
    typeof reason !== "string" || reason.length > 500) {
    return response.status(400).json({ error: "Provide a supported status and a reason of 500 characters or fewer." });
  }
  try {
    const order = await mongoose.connection.transaction(async (session) => {
      const current = await Order.findById(request.params.id).session(session);
      if (!current) throw invalid("Order not found.", 404);
      if (current.legacyImported) throw invalid("Legacy orders are read-only.", 409);
      const allowed = current.status === "Confirmed" && status === "In progress"
        || current.status === "In progress" && status === "Ready"
        || ["Pending", "Confirmed", "In progress", "Ready"].includes(current.status) && status === "Cancelled";
      if (!allowed || current.status === "Ready" && status === "Cancelled" && !reason.trim()) {
        throw invalid("This order cannot transition to the requested status.", 409);
      }
      if (status === "Cancelled" && current.reserved) await releaseOrderReservation(current, actorId(request), session);
      const previous = current.status;
      current.status = status;
      current.updatedBy = actorId(request);
      current.statusHistory.push({ type: status === "Cancelled" ? "cancelled" : "status_changed", fromStatus: previous, toStatus: status, at: new Date(), actor: actorId(request), reason: reason.trim() });
      await current.save({ session });
      const eventType = status === "Cancelled" ? "order.cancelled" : "order.status_changed";
      await audit.recordAudit({ request, eventType, outcome: "success", details: { orderId: String(current._id), orderNumber: current.orderNumber, fromStatus: previous, toStatus: status, reservationReleased: status === "Cancelled" }, transaction: session });
      return serialize(current);
    });
    return response.json({ order });
  } catch (error) {
    return nextError(error, response);
  }
}

async function recordOrderPayment(request, response) {
  if (!objectId(request.params.id)) return response.status(400).json({ error: "Order ID is invalid." });
  const body = request.body;
  const allowed = ["amount", "date", "method", "txnID", "note", "idempotencyKey"];
  if (!body || typeof body !== "object" || Array.isArray(body) ||
    Object.keys(body).some((key) => !allowed.includes(key)) ||
    !Number.isSafeInteger(Number(body.amount)) || Number(body.amount) <= 0 ||
    !validDate(body.date) || !SalePayment.METHODS.includes(body.method) ||
    typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim() || body.idempotencyKey.length > 120 ||
    (body.txnID !== undefined && (typeof body.txnID !== "string" || body.txnID.length > 120)) ||
    (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 500))) {
    return response.status(400).json({ error: "Provide a valid positive whole-UGX payment, date, method, and idempotency key." });
  }
  try {
    const result = await mongoose.connection.transaction(async (session) => {
      const replay = await OrderPayment.findOne({ idempotencyKey: body.idempotencyKey.trim() }).session(session);
      if (replay) {
        if (String(replay.orderId) !== request.params.id) throw invalid("This idempotency key belongs to another order.", 409);
        const payments = await OrderPayment.find({ orderId: replay.orderId }).sort({ date: 1, _id: 1 }).session(session).lean();
        return { payment: serialize(replay), payments: payments.map(serialize), replayed: true };
      }
      const order = await Order.findById(request.params.id).session(session);
      if (!order) throw invalid("Order not found.", 404);
      if (["Cancelled", "Completed"].includes(order.status)) throw invalid("Payments cannot be added to cancelled or fulfilled orders.", 409);
      if (order.legacyImported) throw invalid("Legacy orders are read-only.", 409);
      if (Number(body.amount) > order.total - order.paidAmount) throw invalid("Payment cannot exceed the remaining order balance.", 409);
      order.paidAmount += Number(body.amount);
      order.updatedBy = actorId(request);
      order.statusHistory.push({ type: "payment_recorded", fromStatus: order.status, toStatus: order.status, at: new Date(), actor: actorId(request), details: { amount: Number(body.amount) } });
      const [payment] = await OrderPayment.create([{
        orderId: order._id,
        amount: Number(body.amount),
        date: body.date,
        method: body.method,
        txnID: body.txnID?.trim() || "",
        note: body.note?.trim() || "",
        idempotencyKey: body.idempotencyKey.trim(),
        actor: actorId(request),
      }], { session });
      await order.save({ session });
      await audit.recordAudit({ request, eventType: "order.payment_recorded", outcome: "success", details: { orderId: String(order._id), orderNumber: order.orderNumber, paymentId: String(payment._id), amount: payment.amount }, transaction: session });
      const payments = await OrderPayment.find({ orderId: order._id }).sort({ date: 1, _id: 1 }).session(session).lean();
      return { payment: serialize(payment), payments: payments.map(serialize), replayed: false };
    });
    return response.status(result.replayed ? 200 : 201).json(result);
  } catch (error) {
    return nextError(error, response);
  }
}

function companySnapshot(profile) {
  return {
    name: profile?.tradingName || profile?.legalName || "",
    email: profile?.email || "",
    phone: profile?.phone || "",
    address: [profile?.addressLine1, profile?.addressLine2, profile?.city, profile?.region, profile?.postalCode, profile?.country].filter(Boolean).join(", "),
    logoUrl: profile?.logo?.url || "",
  };
}

async function fulfillOrder(request, response) {
  if (!objectId(request.params.id)) return response.status(400).json({ error: "Order ID is invalid." });
  try {
    const result = await mongoose.connection.transaction(async (session) => {
      const order = await Order.findById(request.params.id).session(session);
      if (!order) throw invalid("Order not found.", 404);
      if (order.saleId) {
        const sale = await Sale.findById(order.saleId).session(session);
        return { order: serialize(order), sale: serialize(sale), replayed: true };
      }
      if (order.status !== "Ready" || !order.reserved || order.legacyImported) {
        throw invalid("Only a confirmed, reserved order marked Ready can be fulfilled.", 409);
      }
      const payments = await OrderPayment.find({ orderId: order._id }).sort({ date: 1, _id: 1 }).session(session).lean();
      const paidAmount = payments.reduce((sum, payment) => sum + payment.amount, 0);
      if (paidAmount !== order.paidAmount || paidAmount > order.total) throw invalid("Order payment history does not match its recorded balance.", 409);
      if (order.paymentTerms === "Paid now" && paidAmount !== order.total) throw invalid("Paid-now orders must be fully paid before fulfillment.", 409);
      await releaseOrderReservation(order, actorId(request), session);

      const date = today();
      const year = Number(date.slice(0, 4));
      const counter = await ReceiptSequence.findOneAndUpdate(
        { _id: year },
        { $inc: { sequence: 1 }, $setOnInsert: { _id: year } },
        { new: true, upsert: true, session, setDefaultsOnInsert: true },
      );
      const receiptNumber = `SAL-${year}-${String(counter.sequence).padStart(6, "0")}`;
      const profile = await ProfileSettings.findById("global").session(session).lean();
      const saleLines = order.items.map((item) => ({
        productId: item.productId,
        productCode: item.productCode,
        productName: item.productName,
        packType: item.packType,
        piecesPerPack: item.piecesPerPack,
        packs: item.packs,
        quantityPieces: item.quantityPieces,
        catalogPricePerPack: item.catalogPricePerPack,
        pricePerPack: item.pricePerPack,
        overrideReason: item.overrideReason,
        lineTotal: item.lineTotal,
      }));
      const [sale] = await Sale.create([{
        receiptNumber,
        receiptYear: year,
        receiptSequence: counter.sequence,
        orderId: order._id,
        customerId: order.customerId,
        customer: order.customer,
        company: companySnapshot(profile),
        date,
        lines: saleLines,
        total: order.total,
        paidAmount,
        paymentTerms: order.paymentTerms,
        dueDate: order.dueDate,
        actor: actorId(request),
      }], { session });
      for (const [index, item] of saleLines.entries()) {
        await recordFinishedStockMovement({
          productId: item.productId,
          type: "Sales dispatch",
          direction: "out",
          quantityPieces: item.quantityPieces,
          date,
          reference: receiptNumber,
          sourceType: "sale",
          sourceId: sale._id,
          idempotencyKey: `order-sale-${order._id}:${index}`,
          reason: `Fulfilled order ${order.orderNumber}`,
          productName: item.productName,
          actor: actorId(request),
        }, session);
      }
      for (const payment of payments) {
        const [salePayment] = await SalePayment.create([{
          saleId: sale._id,
          orderPaymentId: payment._id,
          paymentReceiptNumber: sale.paymentTerms === "Credit"
            ? await allocateCreditPaymentReceiptNumber(payment.date, session)
            : undefined,
          amount: payment.amount,
          date: payment.date,
          method: payment.method,
          txnID: payment.txnID,
          note: payment.note || `Transferred from order ${order.orderNumber}.`,
          idempotencyKey: `order-payment-${payment._id}`,
          actor: payment.actor,
        }], { session });
        payment.salePaymentId = salePayment._id;
        await OrderPayment.updateOne({ _id: payment._id }, { $set: { salePaymentId: salePayment._id } }, { session });
      }
      order.reserved = false;
      order.status = "Completed";
      order.completedAt = new Date();
      order.saleId = sale._id;
      order.updatedBy = actorId(request);
      order.statusHistory.push({ type: "fulfilled", fromStatus: "Ready", toStatus: "Completed", at: new Date(), actor: actorId(request), details: { saleId: String(sale._id), receiptNumber } });
      await order.save({ session });
      await audit.recordAudit({ request, eventType: "sale.created", outcome: "success", details: { saleId: String(sale._id), receiptNumber, orderId: String(order._id), orderNumber: order.orderNumber, total: order.total, stockDispatchPosted: true }, transaction: session });
      await audit.recordAudit({ request, eventType: "order.fulfilled", outcome: "success", details: { orderId: String(order._id), orderNumber: order.orderNumber, saleId: String(sale._id), receiptNumber }, transaction: session });
      return { order: serialize(order), sale: serialize(sale), replayed: false };
    });
    const payments = result.sale
      ? (await SalePayment.find({ saleId: result.sale.id }).sort({ date: 1, _id: 1 }).lean()).map(serialize)
      : [];
    return response.status(result.replayed ? 200 : 201).json({ ...result, payments });
  } catch (error) {
    return nextError(error, response);
  }
}

async function archiveOrder(request, response) {
  return setArchived(request, response, true);
}
async function restoreOrder(request, response) {
  return setArchived(request, response, false);
}
async function setArchived(request, response, archived) {
  if (!objectId(request.params.id)) return response.status(400).json({ error: "Order ID is invalid." });
  try {
    const order = await mongoose.connection.transaction(async (session) => {
      const current = await Order.findById(request.params.id).session(session);
      if (!current) throw invalid("Order not found.", 404);
      if (archived && !["Completed", "Cancelled"].includes(current.status)) throw invalid("Only completed or cancelled orders can be archived.", 409);
      current.archivedAt = archived ? new Date() : null;
      current.updatedBy = actorId(request);
      current.statusHistory.push({ type: archived ? "archived" : "restored", fromStatus: current.status, toStatus: current.status, at: new Date(), actor: actorId(request) });
      await current.save({ session });
      await audit.recordAudit({ request, eventType: archived ? "order.archived" : "order.restored", outcome: "success", details: { orderId: String(current._id), orderNumber: current.orderNumber }, transaction: session });
      return serialize(current);
    });
    return response.json({ order });
  } catch (error) {
    return nextError(error, response);
  }
}

async function importLegacyOrders(request, response) {
  const { orders } = request.body ?? {};
  if (!Array.isArray(orders) || orders.length > 200) return response.status(400).json({ error: "Import between 1 and 200 legacy orders per request." });
  const imported = [];
  const duplicates = [];
  const rejected = [];
  for (const legacy of orders) {
    if (!legacy || typeof legacy !== "object" || typeof legacy.id !== "string" ||
      typeof legacy.reference !== "string" || !validDate(legacy.date) ||
      typeof legacy.customer !== "string" || !Array.isArray(legacy.items) || !legacy.items.length ||
      !Number.isSafeInteger(Number(legacy.total)) || Number(legacy.total) < 1) {
      rejected.push({ id: legacy?.id ?? "", reason: "Legacy order has invalid required fields." });
      continue;
    }
    try {
      const result = await mongoose.connection.transaction(async (session) => {
        const existing = await Order.findOne({ legacyId: legacy.id }).session(session);
        if (existing) return { duplicate: true, order: existing };
        const existingRef = await Order.findOne({ orderNumber: legacy.reference }).session(session);
        if (existingRef) throw invalid("Order reference already belongs to a different record.", 409);
        const customer = typeof legacy.customerId === "string" && legacy.customerId.trim()
          ? await Customer.findOne({ id: legacy.customerId, status: "Active", archivedAt: null }).session(session).lean()
          : null;
        const total = Number(legacy.total);
        const items = legacy.items.map((item, index) => {
          const quantity = Number(item.quantity);
          const lineTotal = Number(item.lineTotal);
          const unitPrice = Number(item.unitPrice);
          if (!Number.isSafeInteger(quantity) || quantity < 1 || !Number.isSafeInteger(lineTotal) || lineTotal < 1 || !Number.isSafeInteger(unitPrice) || unitPrice < 0) {
            throw invalid(`Legacy line ${index + 1} has invalid quantities or totals.`);
          }
          return {
            productId: null,
            productName: String(item.product || "Historic item").slice(0, 160),
            packs: quantity,
            pricePerPack: unitPrice,
            lineTotal,
          };
        });
        const status = ["Pending", "Confirmed", "In progress", "Ready", "Completed", "Cancelled"].includes(legacy.status) ? legacy.status : "Pending";
        const date = legacy.date;
        const year = Number(date.slice(0, 4));
        const counter = await OrderSequence.findOneAndUpdate(
          { _id: year },
          { $inc: { sequence: 1 }, $setOnInsert: { _id: year } },
          { new: true, upsert: true, session, setDefaultsOnInsert: true },
        );
        const [record] = await Order.create([{
          orderNumber: legacy.reference,
          orderYear: year,
          orderSequence: counter.sequence,
          legacyId: legacy.id,
          legacyImported: true,
          customerId: customer?.id || String(legacy.customerId || `LEGACY-${legacy.id}`).slice(0, 80),
          customer: customer ? {
            name: customer.name,
            contact: customer.contact || "",
            phone: customer.phone || "",
            email: customer.email || "",
            address: [customer.district, customer.region, customer.country].filter(Boolean).join(", "),
            tin: customer.tin || "",
          } : { name: legacy.customer.slice(0, 180) },
          items,
          total,
          date,
          requestedDate: validDate(legacy.requestedDate) ? legacy.requestedDate : date,
          fulfilmentMethod: legacy.fulfilmentMethod === "Pickup" ? "Pickup" : "Delivery",
          destination: String(legacy.destination || "").slice(0, 500),
          paymentTerms: ["Paid now", "Same-day", "Credit"].includes(legacy.paymentTerms) ? legacy.paymentTerms : "Same-day",
          status,
          statusHistory: [{ type: "legacy_imported", toStatus: status, at: new Date(), actor: actorId(request) }],
          completedAt: status === "Completed" ? new Date(legacy.completedAt || `${date}T12:00:00.000Z`) : null,
          priority: legacy.priority === "High" ? "High" : "Normal",
          priorityReason: String(legacy.priorityReason || "").slice(0, 500),
          archivedAt: legacy.archivedAt ? new Date(legacy.archivedAt) : null,
          notes: String(legacy.notes || "").slice(0, 2000),
          reserved: false,
          actor: actorId(request),
          updatedBy: actorId(request),
        }], { session });
        await audit.recordAudit({ request, eventType: "order.legacy_imported", outcome: "success", details: { orderId: String(record._id), legacyId: legacy.id, orderNumber: record.orderNumber }, transaction: session });
        return { duplicate: false, order: record };
      });
      (result.duplicate ? duplicates : imported).push(legacy.id);
    } catch (error) {
      rejected.push({ id: legacy.id, reason: error.statusCode ? error.message : "Order could not be imported." });
    }
  }
  return response.status(rejected.length ? 207 : 201).json({ imported, duplicates, rejected });
}

function nextError(error, response) {
  if (error?.statusCode) return response.status(error.statusCode).json({ error: error.message });
  if (error?.code === 11000) return response.status(409).json({ error: "An order reference, receipt, or request key already exists. Retry using the same idempotency key." });
  if (error?.name === "ValidationError" || error?.name === "CastError") return response.status(400).json({ error: error.message });
  throw error;
}

module.exports = {
  archiveOrder,
  changeOrderStatus,
  confirmOrder,
  createOrder,
  fulfillOrder,
  getOrder,
  importLegacyOrders,
  listOrders,
  recordOrderPayment,
  restoreOrder,
  updateOrder,
  validateOrderFields,
};
