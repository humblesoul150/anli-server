const assert = require("node:assert/strict");
const { test } = require("node:test");
const CreditReminderSettings = require("../models/creditReminderSettings");
const NotificationOutbox = require("../models/notificationOutbox");
const Sale = require("../models/sale");
const User = require("../models/user");
const { addCalendarDays, companyDate, dayDifference, generateCreditReminders, reminderThreshold } = require("../lib/creditReminders");

const defaults = {
  daysBeforeDue: [7, 1, 0],
  daysAfterDue: [1, 3, 7],
  repeatOverdueEveryDays: 7,
  escalateAfterDays: 7,
};

test("credit reminders use Kampala dates and calculate calendar-day thresholds", () => {
  assert.equal(companyDate(new Date("2026-10-23T21:30:00.000Z")), "2026-10-24");
  assert.equal(addCalendarDays("2026-10-24", 7), "2026-10-31");
  assert.equal(dayDifference("2026-10-24", "2026-10-31"), 7);
});

test("credit reminder thresholds alert before due, on due date, and repeat overdue weekly", () => {
  assert.equal(reminderThreshold(7, defaults), "before-7");
  assert.equal(reminderThreshold(1, defaults), "before-1");
  assert.equal(reminderThreshold(0, defaults), "before-0");
  assert.equal(reminderThreshold(-1, defaults), "overdue-1");
  assert.equal(reminderThreshold(-3, defaults), "overdue-3");
  assert.equal(reminderThreshold(-7, defaults), "overdue-7");
  assert.equal(reminderThreshold(-14, defaults), "overdue-repeat-14");
  assert.equal(reminderThreshold(-4, defaults), "overdue-3");
  assert.equal(reminderThreshold(-16, defaults), "overdue-repeat-14");
  assert.equal(reminderThreshold(-8, defaults), "overdue-7");
  assert.equal(reminderThreshold(8, defaults), null);
});

test("credit reminder settings validate bounded non-negative thresholds", () => {
  assert.equal(new CreditReminderSettings({ daysBeforeDue: [14, 2, 0] }).validateSync(), undefined);
  const invalid = new CreditReminderSettings({ daysBeforeDue: [-1] }).validateSync();
  assert.ok(invalid);
});

test("credit reminders create per-recipient threshold alerts idempotently and escalate overdue balances", async () => {
  const originalSettingsFind = CreditReminderSettings.findById;
  const originalSaleFind = Sale.find;
  const originalUserFind = User.find;
  const originalOutboxCreate = NotificationOutbox.create;
  const events = new Map();
  let saleFilter;
  CreditReminderSettings.findById = () => ({ lean: async () => defaults });
  Sale.find = (filter) => {
    saleFilter = filter;
    return { lean: async () => [{
      _id: "507f1f77bcf86cd799439099",
      receiptNumber: "SAL-2026-000099",
      customerId: "C-100",
      customer: { name: "Saved customer" },
      paymentTerms: "Credit",
      dueDate: "2026-10-23",
      total: 1000,
      paidAmount: 200,
      assignedTo: "507f1f77bcf86cd799439011",
      voidedAt: null,
    }] };
  };
  User.find = () => ({
    select: () => ({ lean: async () => [
      { _id: "507f1f77bcf86cd799439011", roles: ["Sales Manager"] },
      { _id: "507f1f77bcf86cd799439012", roles: ["General Manager"] },
      { _id: "507f1f77bcf86cd799439013", roles: ["Super Admin"] },
    ] }),
  });
  NotificationOutbox.create = async (event) => {
    if (events.has(event.eventKey)) {
      const error = new Error("Duplicate event");
      error.code = 11000;
      throw error;
    }
    events.set(event.eventKey, event);
  };
  try {
    const now = new Date("2026-10-30T12:00:00.000Z");
    assert.deepEqual(await generateCreditReminders(now), { evaluated: 1, created: 3 });
    assert.deepEqual(await generateCreditReminders(now), { evaluated: 1, created: 0 });
    assert.equal(events.size, 1);
    assert.equal(events.values().next().value.type, "credit_overdue");
    assert.equal(events.values().next().value.recipientIds.length, 3);
    assert.equal(events.values().next().value.resource.type, "sale");
    assert.deepEqual(saleFilter.paymentTerms, "Credit");
    assert.deepEqual(saleFilter.voidedAt, null);
  } finally {
    CreditReminderSettings.findById = originalSettingsFind;
    Sale.find = originalSaleFind;
    User.find = originalUserFind;
    NotificationOutbox.create = originalOutboxCreate;
  }
});
