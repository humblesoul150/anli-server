const assert = require("node:assert/strict");
const { test } = require("node:test");
const mongoose = require("mongoose");
const SalePayment = require("../models/salePayment");
const ReceiptManagementState = require("../models/receiptManagementState");
const CreditPaymentReceiptSequence = require("../models/creditPaymentReceiptSequence");
const auditModel = require("../models/auditEvent");
const receiptController = require("../controllers/receiptManagementController");
const audit = require("../lib/audit");
const { allocateCreditPaymentReceiptNumber } = require("../lib/creditPaymentReceipt");

test("credit payment receipts have a distinct unique optional number and annual sequence", async () => {
  const numberPath = SalePayment.schema.path("paymentReceiptNumber");
  assert.equal(numberPath.options.unique, true);
  assert.equal(numberPath.options.sparse, true);
  assert.equal(CreditPaymentReceiptSequence.schema.path("sequence").options.default, 0);

  const originalFindOneAndUpdate = CreditPaymentReceiptSequence.findOneAndUpdate;
  let captured;
  CreditPaymentReceiptSequence.findOneAndUpdate = async (...args) => {
    captured = args;
    return { sequence: 7 };
  };
  try {
    const session = { transaction: true };
    assert.equal(await allocateCreditPaymentReceiptNumber("2026-10-24", session), "CPR-2026-000007");
    assert.deepEqual(captured[0], { _id: 2026 });
    assert.equal(captured[2].session, session);
    await assert.rejects(
      allocateCreditPaymentReceiptNumber("not-a-date", session),
      /valid year/,
    );
  } finally {
    CreditPaymentReceiptSequence.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("receipt list validates pagination and searches credit-payment and sale snapshots", async () => {
  const originals = { saleAggregate: require("../models/sale").aggregate, paymentAggregate: SalePayment.aggregate };
  const Sale = require("../models/sale");
  const pipelines = [];
  Sale.aggregate = async (pipeline) => { pipelines.push(pipeline); return []; };
  SalePayment.aggregate = async (pipeline) => { pipelines.push(pipeline); return []; };
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  try {
    await receiptController.listReceipts({
      params: { kind: "credit-payments" },
      query: { limit: "50", search: "CPR-2026" },
      authUser: { _id: new mongoose.Types.ObjectId() },
    }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.stats.count, 0);
    assert.ok(pipelines[0].some((stage) => stage.$lookup?.from === "sales"));
    assert.ok(pipelines[0].some((stage) =>
      stage.$match?.$or?.some((condition) => condition.paymentReceiptNumber?.$regex === "CPR-2026")));

    response.statusCode = 200;
    await receiptController.listReceipts({
      params: { kind: "sales" },
      query: { limit: "101" },
      authUser: { _id: new mongoose.Types.ObjectId() },
    }, response);
    assert.equal(response.statusCode, 400);
  } finally {
    Sale.aggregate = originals.saleAggregate;
    SalePayment.aggregate = originals.paymentAggregate;
  }
});

test("receipt state schema enforces one shared archive record per receipt and audit events are registered", () => {
  assert.ok(ReceiptManagementState.schema.indexes().some(([keys, options]) =>
    keys.sourceType === 1 && keys.sourceId === 1 && options.unique));
  for (const event of ["receipt.favorite_updated", "receipt.archived", "receipt.restored", "receipt.bulk_exported"]) {
    assert.ok(auditModel.AUDIT_EVENT_TYPES.includes(event));
  }
});

test("bulk export audit records filter metadata but never receipt content", async () => {
  const originalRecordAudit = audit.recordAudit;
  let captured;
  audit.recordAudit = async (event) => { captured = event; };
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    end() { this.ended = true; return this; },
  };
  try {
    await receiptController.recordBulkExport({
      body: {
        kind: "sales",
        action: "download",
        count: 25,
        filters: { from: "2026-10-01", search: "customer", favorite: true },
      },
    }, response);
    assert.equal(response.statusCode, 204);
    assert.equal(response.ended, true);
    assert.equal(captured.eventType, "receipt.bulk_exported");
    assert.deepEqual(captured.details.filters, {
      from: "2026-10-01",
      to: "",
      search: "customer",
      favorite: true,
      archived: false,
    });
    assert.equal(Object.hasOwn(captured.details, "receipts"), false);
  } finally {
    audit.recordAudit = originalRecordAudit;
  }
});
