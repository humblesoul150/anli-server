const TIME_ZONE = "Africa/Kampala";
const MAX_RANGE_DAYS = 366;
const SECTION_ROLES = {
  sales: ["Sales Manager", "General Manager", "Super Admin"],
  orders: ["Sales Manager", "General Manager", "Super Admin"],
  production: ["Super Admin", "Admin", "General Manager", "Production Manager", "Inventory Manager"],
  inventory: ["Super Admin", "Admin", "General Manager", "Production Manager", "Inventory Manager"],
  expenses: ["Accountant", "General Manager", "Super Admin"],
  people: ["Super Admin", "Admin", "Human Resource"],
  assets: ["Inventory Manager", "General Manager", "Super Admin"],
};

function businessDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDate(date, days) {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

function isValidDateString(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function resolveRange(from, to, now = new Date()) {
  const today = businessDate(now);
  const start = from || shiftDate(today, -6);
  const end = to || today;
  if (!isValidDateString(start) || !isValidDateString(end) || start > end) {
    const error = new Error("Use a valid date range with from <= to.");
    error.statusCode = 400;
    throw error;
  }
  const days = Math.floor((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
  if (days > MAX_RANGE_DAYS) {
    const error = new Error(`Date range cannot exceed ${MAX_RANGE_DAYS} days.`);
    error.statusCode = 400;
    throw error;
  }
  return { from: start, to: end };
}

function permittedSections(roles = []) {
  return Object.entries(SECTION_ROLES)
    .filter(([, allowedRoles]) => roles.some((role) => allowedRoles.includes(role)))
    .map(([section]) => section);
}

function sumBy(rows, key) {
  return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
}

function createDashboardSummary(models, logger = console) {
  const { Sale, SalePayment, Order, ProductionRun, RawMaterialAlert, Expense } = models;

  return async function getDashboardSummary({ roles, from, to }) {
    const sections = {};
    const allowed = permittedSections(roles);
    const operations = {
      sales: async () => {
        const match = { date: { $gte: from, $lte: to }, voidedAt: null };
        const [daily, payments, products, balances, overdueReceivables] = await Promise.all([
          Sale.aggregate([
            { $match: match },
            { $group: { _id: "$date", revenue: { $sum: "$total" } } },
            { $sort: { _id: 1 } },
          ]),
          SalePayment.aggregate([
            { $match: { date: { $gte: from, $lte: to } } },
            { $group: { _id: "$date", collected: { $sum: "$amount" } } },
            { $sort: { _id: 1 } },
          ]),
          Sale.aggregate([
            { $match: match },
            { $unwind: "$lines" },
            { $group: { _id: "$lines.productName", revenue: { $sum: "$lines.lineTotal" } } },
            { $sort: { revenue: -1, _id: 1 } },
            { $limit: 6 },
          ]),
          Sale.aggregate([
            { $match: { voidedAt: null } },
            { $group: { _id: null, total: { $sum: "$total" }, paid: { $sum: "$paidAmount" } } },
          ]),
          Sale.countDocuments({
            voidedAt: null,
            dueDate: { $gte: "0001-01-01", $lt: businessDate() },
            $expr: { $lt: ["$paidAmount", "$total"] },
          }),
        ]);
        const revenue = sumBy(daily, "revenue");
        const collected = sumBy(payments, "collected");
        const balance = balances[0] || { total: 0, paid: 0 };
        const trendByDate = new Map();
        for (const row of daily) trendByDate.set(row._id, { date: row._id, revenue: row.revenue, collected: 0 });
        for (const row of payments) {
          const point = trendByDate.get(row._id) || { date: row._id, revenue: 0, collected: 0 };
          point.collected = row.collected;
          trendByDate.set(row._id, point);
        }
        return {
          revenue,
          collected,
          outstanding: Math.max(0, balance.total - balance.paid),
          overdueReceivables,
          trend: [...trendByDate.values()].sort((left, right) => left.date.localeCompare(right.date)),
          products: products.map((row) => ({ name: row._id, revenue: row.revenue })),
        };
      },
      orders: async () => {
        const activeMatch = { archivedAt: null };
        const [byStatus, lateCount, highPriorityCount] = await Promise.all([
          Order.aggregate([
            { $match: activeMatch },
            { $group: { _id: "$status", count: { $sum: 1 } } },
            { $sort: { _id: 1 } },
          ]),
          Order.countDocuments({
            ...activeMatch,
            status: { $nin: ["Completed", "Cancelled"] },
            requestedDate: { $lt: businessDate() },
          }),
          Order.countDocuments({
            ...activeMatch,
            status: { $nin: ["Completed", "Cancelled"] },
            priority: "High",
          }),
        ]);
        const statuses = byStatus.map(({ _id, count }) => ({ status: _id, count }));
        return {
          open: statuses
            .filter(({ status }) => !["Completed", "Cancelled"].includes(status))
            .reduce((total, row) => total + row.count, 0),
          late: lateCount,
          highPriority: highPriorityCount,
          byStatus: statuses,
        };
      },
      production: async () => {
        const trend = await ProductionRun.aggregate([
          { $match: { productionDate: { $gte: from, $lte: to } } },
          {
            $group: {
              _id: "$productionDate",
              produced: { $sum: "$producedQuantityPieces" },
              damaged: { $sum: "$damagedQuantityPieces" },
            },
          },
          { $sort: { _id: 1 } },
        ]);
        return {
          produced: sumBy(trend, "produced"),
          damaged: sumBy(trend, "damaged"),
          trend: trend.map((row) => ({ date: row._id, produced: row.produced, damaged: row.damaged })),
        };
      },
      inventory: async () => ({
        activeLowStock: await RawMaterialAlert.countDocuments({ status: "active" }),
      }),
      expenses: async () => {
        const [trend, pendingApproval] = await Promise.all([
          Expense.aggregate([
            {
              $match: {
                date: { $gte: from, $lte: to },
                status: { $in: ["Approved", "Partially paid", "Paid"] },
              },
            },
            { $group: { _id: "$date", amount: { $sum: "$amount" } } },
            { $sort: { _id: 1 } },
          ]),
          Expense.countDocuments({ status: "Pending approval" }),
        ]);
        return {
          total: sumBy(trend, "amount"),
          pendingApproval,
          trend: trend.map((row) => ({ date: row._id, amount: row.amount })),
        };
      },
      people: async () => {
        const [attendance, pendingLeave] = await Promise.all([
          models.AttendanceRecord.aggregate([
            { $match: { workDate: { $gte: from, $lte: to } } },
            { $group: { _id: "$status", count: { $sum: 1 } } },
            { $sort: { _id: 1 } },
          ]),
          models.LeaveRequest.countDocuments({ status: "Pending" }),
        ]);
        const attendanceByStatus = attendance.map(({ _id, count }) => ({ status: _id, count }));
        return {
          attendanceByStatus,
          pendingLeave,
          recordedAttendance: attendanceByStatus.reduce((total, row) => total + row.count, 0),
        };
      },
      assets: async () => {
        const dueThrough = new Date(Date.now() + 30 * 86400000);
        const dueMaintenance = await models.CompanyAsset.countDocuments({
          status: { $ne: "Disposed" },
          $or: [
            { nextInspectionDate: { $lte: dueThrough } },
            { nextServiceDate: { $lte: dueThrough } },
            { insuranceDueDate: { $lte: dueThrough } },
          ],
        });
        return { dueMaintenance };
      },
    };

    await Promise.all(allowed.map(async (section) => {
      try {
        sections[section] = { status: "available", ...await operations[section]() };
      } catch (error) {
        logger.error(`Dashboard ${section} summary failed:`, error);
        sections[section] = { status: "unavailable", message: "This section is temporarily unavailable." };
      }
    }));
    return { sections };
  };
}

module.exports = {
  MAX_RANGE_DAYS,
  TIME_ZONE,
  businessDate,
  createDashboardSummary,
  isValidDateString,
  permittedSections,
  resolveRange,
};
