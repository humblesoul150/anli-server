const assert = require("node:assert/strict");
const { test } = require("node:test");
const Order = require("../models/order");
const OrderPayment = require("../models/orderPayment");
const OrderSequence = require("../models/orderSequence");
const {
  serialize,
  validateOrderFields,
} = require("../controllers/ordersController");
const { listOrders } = require("../controllers/ordersController");
const {
  decodeKeysetCursor,
  encodeKeysetCursor,
} = require("../lib/keysetCursor");

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
  assert.equal(
    validateOrderFields(
      validOrder({
        items: [
          {
            productId,
            packs: 2,
            pricePerPack: 24000,
            overrideReason: "Approved price",
          },
        ],
      }),
    ).error,
    undefined,
  );
  assert.match(
    validateOrderFields(validOrder({ customerId: "" })).error,
    /active saved customer/,
  );
  assert.match(
    validateOrderFields(validOrder({ items: [{ productId, packs: 1.5 }] }))
      .error,
    /positive whole number/,
  );
  assert.match(
    validateOrderFields(
      validOrder({
        items: [{ productId, packs: 2, pricePerPack: 24000 }],
      }),
    ).error,
    /reason/,
  );
  assert.match(
    validateOrderFields(validOrder({ priority: "High" })).error,
    /reason is required/,
  );
  assert.match(
    validateOrderFields(
      validOrder({ paymentTerms: "Credit", dueDate: undefined }),
    ).error,
    /due date/,
  );
  assert.match(
    validateOrderFields(validOrder({ unexpected: true })).error,
    /supported request shape/,
  );
  assert.match(
    validateOrderFields(validOrder({ requestedDate: "2026-02-30" })).error,
    /valid YYYY-MM-DD/,
  );
});

test("order serialization always exposes the stable ID for API clients", () => {
  const documentId = "507f1f77bcf86cd799439014";
  const serialized = serialize({
    _id: documentId,
    toJSON: () => ({ _id: documentId, orderNumber: "ORD-2026-000001", __v: 0 }),
  });

  assert.equal(serialized.id, documentId);
  assert.equal(serialized.orderNumber, "ORD-2026-000001");
  assert.equal("_id" in serialized, false);
  assert.equal("__v" in serialized, false);
});

test("keyset cursors round-trip stable dates and reject malformed values", () => {
  const createdAt = new Date("2026-11-05T12:34:56.789Z");
  const cursor = encodeKeysetCursor({
    createdAt,
    _id: "507f1f77bcf86cd799439014",
  });

  assert.deepEqual(decodeKeysetCursor(cursor), {
    createdAt,
    id: "507f1f77bcf86cd799439014",
  });
  assert.equal(decodeKeysetCursor("not-a-cursor"), null);
  assert.equal(
    decodeKeysetCursor(Buffer.from("{}").toString("base64url")),
    null,
  );
});

test("order API mutation inputs can be partial only when editing an order", () => {
  assert.equal(
    validateOrderFields({ notes: "Customer requested call" }, true).error,
    undefined,
  );
  assert.match(
    validateOrderFields({ notes: "Customer requested call" }).error,
    /required/,
  );
  assert.match(
    validateOrderFields({ requestedDate: "2000-01-01" }, true).error,
    /cannot be in the past/,
  );
});

test("order schemas enforce unique references, sale links, and payment idempotency", () => {
  assert.ok(
    Order.schema
      .indexes()
      .some(([keys, options]) => keys.orderNumber === 1 && options.unique),
  );
  assert.ok(
    Order.schema
      .indexes()
      .some(
        ([keys, options]) =>
          keys.orderYear === 1 && keys.orderSequence === 1 && options.unique,
      ),
  );
  assert.ok(
    Order.schema
      .indexes()
      .some(([keys, options]) => keys.saleId === 1 && options.unique),
  );
  assert.ok(
    OrderPayment.schema
      .indexes()
      .some(([keys, options]) => keys.idempotencyKey === 1 && options.unique),
  );
  assert.equal(OrderSequence.schema.path("_id").instance, "Number");
  assert.equal(Order.schema.path("saleId").defaultValue, undefined);
});

test("order cursor pagination seeks by date and ID without counting the full result set", async () => {
  const originalFind = Order.find;
  const originalCountDocuments = Order.countDocuments;
  const cursorDate = new Date("2026-10-25T10:00:00.000Z");
  const firstId = "507f1f77bcf86cd799439011";
  let queryFilter;
  let didCount = false;
  const records = [
    {
      _id: "507f1f77bcf86cd799439012",
      createdAt: new Date("2026-10-26T10:00:00.000Z"),
    },
    {
      _id: "507f1f77bcf86cd799439013",
      createdAt: new Date("2026-10-25T12:00:00.000Z"),
    },
    {
      _id: "507f1f77bcf86cd799439014",
      createdAt: new Date("2026-10-24T10:00:00.000Z"),
    },
  ];
  Order.find = (filter) => {
    queryFilter = filter;
    return {
      sort(value) {
        assert.deepEqual(value, { createdAt: -1, _id: -1 });
        return this;
      },
      limit(value) {
        assert.equal(value, 3);
        return this;
      },
      lean: async () => records,
    };
  };
  Order.countDocuments = async () => {
    didCount = true;
    return records.length;
  };
  try {
    const res = {
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };
    await listOrders(
      {
        query: {
          status: "Pending",
          limit: "2",
          cursor: Buffer.from(
            JSON.stringify({
              createdAt: cursorDate.toISOString(),
              id: firstId,
            }),
          ).toString("base64url"),
        },
      },
      res,
    );

    assert.equal(queryFilter.status, "Pending");
    assert.deepEqual(queryFilter.$or, [
      { createdAt: { $lt: cursorDate } },
      { createdAt: cursorDate, _id: { $lt: firstId } },
    ]);
    assert.equal(res.body.orders.length, 2);
    assert.ok(res.body.nextCursor);
    assert.equal("total" in res.body, false);
    assert.equal(didCount, false);
  } finally {
    Order.find = originalFind;
    Order.countDocuments = originalCountDocuments;
  }
});
