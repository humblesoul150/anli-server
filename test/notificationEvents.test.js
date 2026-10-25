const assert = require("node:assert/strict");
const { test } = require("node:test");
const Notification = require("../models/notification");
const NotificationOutbox = require("../models/notificationOutbox");
const User = require("../models/user");
const { serializeNotification, processNotificationOutbox } = require("../lib/notificationEvents");

test("notification serialization normalizes legacy credit reminders", () => {
  const value = serializeNotification({
    _id: "507f1f77bcf86cd799439021",
    type: "credit_due",
    title: "Credit sale due today",
    message: "A sale is due.",
    saleId: "507f1f77bcf86cd799439022",
    receiptNumber: "SAL-2026-1",
    thresholdKey: "sale:due",
    readAt: null,
    createdAt: new Date("2026-10-24T00:00:00.000Z"),
  });
  assert.equal(value.category, "sales");
  assert.equal(value.severity, "action_required");
  assert.deepEqual(value.resource, { type: "sale", id: "507f1f77bcf86cd799439022", reference: "SAL-2026-1" });
});

test("outbox delivery creates one notification per active recipient and marks event delivered", async () => {
  const originals = {
    findOneAndUpdate: NotificationOutbox.findOneAndUpdate,
    updateOne: NotificationOutbox.updateOne,
    userFind: User.find,
    notificationCreate: Notification.create,
    countDocuments: Notification.countDocuments,
  };
  const delivered = [];
  const event = {
    _id: "507f1f77bcf86cd799439031",
    eventKey: "expense:123:approved",
    type: "expense.approved",
    category: "expense",
    severity: "info",
    title: "Expense approved",
    message: "Your expense was approved.",
    resource: { type: "expense", id: "507f1f77bcf86cd799439032", reference: "EXP-1" },
    recipientIds: ["507f1f77bcf86cd799439033"],
    recipientRoles: [],
    excludeRecipientIds: [],
    attempts: 1,
    occurredAt: new Date("2026-10-24T00:00:00.000Z"),
  };
  let claimed = false;
  NotificationOutbox.findOneAndUpdate = () => ({
    lean: async () => {
      if (claimed) return null;
      claimed = true;
      return event;
    },
  });
  NotificationOutbox.updateOne = async (_filter, update) => {
    delivered.push(update.$set.status);
  };
  User.find = () => ({
    select: () => ({ lean: async () => [{ _id: "507f1f77bcf86cd799439033" }] }),
  });
  Notification.create = async (record) => ({
    toObject: () => ({ ...record, _id: "507f1f77bcf86cd799439034", createdAt: event.occurredAt }),
  });
  Notification.countDocuments = async () => 1;
  try {
    assert.deepEqual(await processNotificationOutbox({ now: event.occurredAt }), { processed: 1 });
    assert.deepEqual(delivered, ["delivered"]);
  } finally {
    NotificationOutbox.findOneAndUpdate = originals.findOneAndUpdate;
    NotificationOutbox.updateOne = originals.updateOne;
    User.find = originals.userFind;
    Notification.create = originals.notificationCreate;
    Notification.countDocuments = originals.countDocuments;
  }
});
