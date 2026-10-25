const mongoose = require("mongoose");
const CreditReminderSettings = require("../models/creditReminderSettings");
const Sale = require("../models/sale");
const User = require("../models/user");
const { enqueueNotificationEvent } = require("./notificationEvents");

const SALES_ROLES = ["Sales Manager", "General Manager", "Super Admin"];

function companyDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Kampala",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function dayDifference(left, right) {
  return Math.round((Date.parse(`${right}T00:00:00.000Z`) - Date.parse(`${left}T00:00:00.000Z`)) / 86400000);
}

function addCalendarDays(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function reminderThreshold(daysUntilDue, settings) {
  if (daysUntilDue >= 0) {
    return settings.daysBeforeDue.includes(daysUntilDue) ? `before-${daysUntilDue}` : null;
  }
  const overdueDays = -daysUntilDue;
  if (settings.daysAfterDue.includes(overdueDays)) return `overdue-${overdueDays}`;
  if (overdueDays > settings.escalateAfterDays) {
    const repeatIndex = Math.floor((overdueDays - settings.escalateAfterDays) / settings.repeatOverdueEveryDays);
    if (repeatIndex > 0) {
      return `overdue-repeat-${settings.escalateAfterDays + repeatIndex * settings.repeatOverdueEveryDays}`;
    }
  }
  const missedThreshold = settings.daysAfterDue
    .filter((days) => days <= overdueDays)
    .sort((left, right) => right - left)[0];
  return missedThreshold === undefined ? null : `overdue-${missedThreshold}`;
}

async function generateCreditReminders(now = new Date()) {
  const today = companyDate(now);
  const settings = await CreditReminderSettings.findById("global").lean() || {
    daysBeforeDue: [7, 1, 0],
    daysAfterDue: [1, 3, 7],
    repeatOverdueEveryDays: 7,
    escalateAfterDays: 7,
  };
  const latestDueDate = addCalendarDays(today, Math.max(...settings.daysBeforeDue, 0));
  const sales = await Sale.find({
    paymentTerms: "Credit",
    dueDate: { $exists: true, $lte: latestDueDate },
    voidedAt: null,
    $expr: { $gt: ["$total", "$paidAmount"] },
  }).lean();
  const recipients = await User.find({ status: "Active", roles: { $in: SALES_ROLES } }).select("_id roles").lean();
  const salesRecipients = new Map();
  for (const user of recipients) {
    for (const role of user.roles) {
      if (!salesRecipients.has(role)) salesRecipients.set(role, []);
      salesRecipients.get(role).push(String(user._id));
    }
  }

  let created = 0;
  for (const sale of sales) {
    const daysUntilDue = dayDifference(today, sale.dueDate);
    const threshold = reminderThreshold(daysUntilDue, settings);
    if (!threshold) continue;
    const overdueDays = Math.max(0, -daysUntilDue);
    const recipientIds = new Set(salesRecipients.get("Sales Manager") || []);
    if (sale.assignedTo) recipientIds.add(String(sale.assignedTo));
    if (overdueDays >= settings.escalateAfterDays) {
      for (const role of ["General Manager", "Super Admin"]) {
        for (const id of salesRecipients.get(role) || []) recipientIds.add(id);
      }
    }
    const dueToday = daysUntilDue === 0;
    const overdue = daysUntilDue < 0;
    const title = overdue
      ? `Credit sale overdue by ${overdueDays} day${overdueDays === 1 ? "" : "s"}`
      : dueToday ? "Credit sale is due today" : `Credit sale due in ${daysUntilDue} days`;
    const queued = await enqueueNotificationEvent({
      eventKey: `credit:${sale._id}:${sale.dueDate}:${threshold}`,
      type: overdue ? "credit_overdue" : "credit_due",
      category: "sales",
      severity: overdueDays >= settings.escalateAfterDays ? "urgent" : "action_required",
      title,
      message: `${sale.receiptNumber} for ${sale.customer.name} has an outstanding credit balance.`,
      resource: { type: "sale", id: String(sale._id), reference: sale.receiptNumber },
      recipientIds: [...recipientIds],
      occurredAt: now,
    });
    if (queued) created += recipientIds.size;
  }
  return { evaluated: sales.length, created };
}

module.exports = { addCalendarDays, companyDate, dayDifference, generateCreditReminders, reminderThreshold };
