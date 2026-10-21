const DEFAULT_POLICY = Object.freeze({
  workingDays: [1, 2, 3, 4, 5, 6],
  holidays: [],
  leaveYearStart: "01-01",
  entitlements: {},
  carryoverEnabled: false,
  carryoverLimit: 0,
  reminderThresholds: {
    pendingApprovalBusinessDays: 2,
    beforeStartDays: [7, 1],
    onStartDate: true,
    returnFollowUp: true,
  },
});

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function addDays(value, amount) {
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function calculateWorkingDays(startDate, endDate, policy = DEFAULT_POLICY) {
  if (!isValidDate(startDate) || !isValidDate(endDate) || startDate > endDate) return 0;
  const workingDays = new Set(policy.workingDays);
  const holidays = new Set(policy.holidays);
  let cursor = startDate;
  let count = 0;
  while (cursor <= endDate) {
    const weekday = new Date(`${cursor}T12:00:00.000Z`).getUTCDay();
    if (workingDays.has(weekday) && !holidays.has(cursor)) count += 1;
    cursor = addDays(cursor, 1);
  }
  return count;
}

function addBusinessDays(value, amount, policy = DEFAULT_POLICY) {
  let cursor = value;
  let remaining = amount;
  while (remaining > 0) {
    cursor = addDays(cursor, 1);
    const weekday = new Date(`${cursor}T12:00:00.000Z`).getUTCDay();
    if (policy.workingDays.includes(weekday) && !policy.holidays.includes(cursor)) remaining -= 1;
  }
  return cursor;
}

function expectedReturnDate(endDate, policy = DEFAULT_POLICY) {
  let cursor = addDays(endDate, 1);
  while (!policy.workingDays.includes(new Date(`${cursor}T12:00:00.000Z`).getUTCDay()) || policy.holidays.includes(cursor)) {
    cursor = addDays(cursor, 1);
  }
  return cursor;
}

function leaveYearBounds(date, leaveYearStart = "01-01") {
  const [month, day] = leaveYearStart.split("-").map(Number);
  const year = Number(date.slice(0, 4));
  const anniversaryDay = Math.min(day, new Date(Date.UTC(year, month, 0)).getUTCDate());
  const anniversary = `${year}-${String(month).padStart(2, "0")}-${String(anniversaryDay).padStart(2, "0")}`;
  const startYear = date >= anniversary ? year : year - 1;
  const startDay = Math.min(day, new Date(Date.UTC(startYear, month, 0)).getUTCDate());
  const nextDay = Math.min(day, new Date(Date.UTC(startYear + 1, month, 0)).getUTCDate());
  const start = `${startYear}-${String(month).padStart(2, "0")}-${String(startDay).padStart(2, "0")}`;
  const next = `${startYear + 1}-${String(month).padStart(2, "0")}-${String(nextDay).padStart(2, "0")}`;
  return { start, end: addDays(next, -1) };
}

function getReminderCandidates(requests, policy = DEFAULT_POLICY) {
  const candidates = [];
  for (const request of requests) {
    const requestId = String(request._id || request.id);
    if (request.status === "Pending") {
      const timestamp = request.createdAt || request.requestedAt;
      const submittedDate = new Date(timestamp).toISOString().slice(0, 10);
      const dueDate = addBusinessDays(submittedDate, policy.reminderThresholds.pendingApprovalBusinessDays, policy);
      candidates.push({
        key: `leave:${requestId}:pending:${dueDate}`,
        type: "pending_approval",
        dueDate,
        requestId,
        recipientUserId: String(request.approverUserId),
      });
    }
    if (request.status !== "Approved" || request.returnConfirmation?.actualDate) continue;
    for (const days of policy.reminderThresholds.beforeStartDays) {
      const dueDate = addDays(request.startDate, -days);
      candidates.push({
        key: `leave:${requestId}:start-minus-${days}:${request.startDate}`,
        type: "leave_start",
        dueDate,
        requestId,
        recipientUserId: String(request.approverUserId),
      });
    }
    if (policy.reminderThresholds.onStartDate) {
      candidates.push({
        key: `leave:${requestId}:start:${request.startDate}`,
        type: "leave_start",
        dueDate: request.startDate,
        requestId,
        recipientUserId: String(request.approverUserId),
      });
    }
    if (policy.reminderThresholds.returnFollowUp && !request.returnConfirmation?.actualDate) {
      candidates.push({
        key: `leave:${requestId}:return:${expectedReturnDate(request.endDate, policy)}`,
        type: "return_follow_up",
        dueDate: expectedReturnDate(request.endDate, policy),
        requestId,
        recipientUserId: String(request.approverUserId),
      });
    }
  }
  return candidates.sort((left, right) => left.dueDate.localeCompare(right.dueDate) || left.key.localeCompare(right.key));
}

module.exports = {
  DEFAULT_POLICY,
  addBusinessDays,
  addDays,
  calculateWorkingDays,
  expectedReturnDate,
  getReminderCandidates,
  isValidDate,
  leaveYearBounds,
};
