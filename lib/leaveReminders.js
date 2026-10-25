const LeavePolicy = require("../models/leavePolicy");
const LeaveRequest = require("../models/leaveRequest");
const { DEFAULT_POLICY, addDays, getReminderCandidates } = require("./leavePolicy");
const { enqueueNotificationEvent } = require("./notificationEvents");

function todayInKampala(now) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Africa/Kampala" }).format(now);
}

async function generateLeaveReminders(now = new Date()) {
  const storedPolicy = await LeavePolicy.findById("global").lean();
  const policy = {
    ...DEFAULT_POLICY,
    ...(storedPolicy || {}),
    reminderThresholds: {
      ...DEFAULT_POLICY.reminderThresholds,
      ...(storedPolicy?.reminderThresholds || {}),
    },
  };
  const requests = await LeaveRequest.find({ status: { $in: ["Pending", "Approved"] } }).lean();
  const requestById = new Map(requests.map((request) => [String(request._id), request]));
  const today = todayInKampala(now);
  const candidates = getReminderCandidates(requests, policy).filter((candidate) => candidate.dueDate <= today);
  let queued = 0;
  for (const candidate of candidates) {
    const reminderText = {
      pending_approval: ["Leave request needs review", "A leave request has reached its configured review reminder date."],
      leave_start: ["Upcoming leave", "An approved leave period is approaching or starts today."],
      return_follow_up: ["Return confirmation due", "An employee's expected return date has arrived; confirm their return."],
    }[candidate.type];
    const request = requestById.get(candidate.requestId);
    if (!reminderText || !request || !/^[a-f\d]{24}$/i.test(candidate.requestId)) continue;
    const recipientIds = candidate.type === "pending_approval"
      ? [request.approverUserId]
      : candidate.type === "return_follow_up"
        ? [request.employeeUserId || request.createdBy, request.approverUserId]
        : [request.employeeUserId || request.approverUserId];
    const uniqueRecipientIds = [...new Set(recipientIds.filter(Boolean).map(String))];
    if (!uniqueRecipientIds.length) continue;
    const inserted = await enqueueNotificationEvent({
      eventKey: `leave-reminder:${candidate.key}`,
      type: `leave.${candidate.type}`,
      category: "leave",
      severity: candidate.type === "pending_approval" || candidate.type === "return_follow_up" ? "action_required" : "info",
      title: reminderText[0],
      message: reminderText[1],
      resource: { type: "leave_request", id: candidate.requestId },
      recipientIds: uniqueRecipientIds,
      occurredAt: now,
      expiresAt: new Date(`${addDays(candidate.dueDate, 30)}T23:59:59.999Z`),
    });
    if (inserted) queued += uniqueRecipientIds.length;
  }
  return { evaluated: requests.length, queued };
}

module.exports = { generateLeaveReminders, todayInKampala };
