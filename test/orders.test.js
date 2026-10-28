const assert = require("node:assert/strict");
const { test } = require("node:test");
const Order = require("../models/order");
const OrderPayment = require("../models/orderPayment");
const OrderSequence = require("../models/orderSequence");
const { validateOrderFields } = require("../controllers/ordersController");

const productId = "507f1f77bcf86cd799439013";
const workDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Kampala",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

function validOrder(overrides = {}) {
  return {
    customerId: "C-100",
    items: [{ productId, packs: 2 }],
    requestedDate: workDate,
    fulfilmentMethod: "Delivery",
    paymentTerms: "Same-day",
    priority: "Normal",
    idempotencyKey: "order-request-1",
    ...overrides,
  };
}

test("order validation accepts catalog lines and rejects malformed values", () => {
  const result = validateOrderFields(validOrder());
  assert.equal(result.error, undefined);
  assert.equal(result.value.items[0].packs, 2);
  assert.equal(validateOrderFields(validOrder({
    items: [{ productId, packs: 2, pricePerPack: 24000, overrideReason: "Approved price" }],
  })).error, undefined);
  assert.match(validateOrderFields(validOrder({ customerId: "" })).error, /active saved customer/);
  assert.match(validateOrderFields(validOrder({ items: [{ productId, packs: 1.5 }] })).error, /positive whole number/);
  assert.match(validateOrderFields(validOrder({
    items: [{ productId, packs: 2, pricePerPack: 24000 }],
  })).error, /reason/);
  assert.match(validateOrderFields(validOrder({ priority: "High" })).error, /reason is required/);
  assert.match(validateOrderFields(validOrder({ paymentTerms: "Credit", dueDate: undefined })).error, /due date/);
  assert.match(validateOrderFields(validOrder({ unexpected: true })).error, /supported request shape/);
  assert.match(validateOrderFields(validOrder({ requestedDate: "2026-02-30" })).error, /valid YYYY-MM-DD/);
});

test("order API mutation inputs can be partial only when editing an order", () => {
  assert.equal(validateOrderFields({ notes: "Customer requested call" }, true).error, undefined);
  assert.match(validateOrderFields({ notes: "Customer requested call" }).error, /required/);
  assert.match(validateOrderFields({ requestedDate: "2000-01-01" }, true).error, /cannot be in the past/);
});

test("order schemas enforce unique references, sale links, and payment idempotency", () => {
  assert.ok(Order.schema.indexes().some(([keys, options]) => keys.orderNumber === 1 && options.unique));
  assert.ok(Order.schema.indexes().some(([keys, options]) => keys.orderYear === 1 && keys.orderSequence === 1 && options.unique));
  assert.ok(Order.schema.indexes().some(([keys, options]) => keys.saleId === 1 && options.unique));
  assert.ok(OrderPayment.schema.indexes().some(([keys, options]) => keys.idempotencyKey === 1 && options.unique));
  assert.equal(OrderSequence.schema.path("_id").instance, "Number");
  assert.equal(Order.schema.path("saleId").defaultValue, undefined);
});
