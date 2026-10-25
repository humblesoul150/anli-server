const Sale = require("../models/sale");
const SalePayment = require("../models/salePayment");
const Order = require("../models/order");
const ProductionRun = require("../models/productionRun");
const RawMaterialAlert = require("../models/rawMaterialAlert");
const Expense = require("../models/expense");
const AttendanceRecord = require("../models/attendanceRecord");
const LeaveRequest = require("../models/leaveRequest");
const CompanyAsset = require("../models/companyAsset");
const { createDashboardSummary, resolveRange, TIME_ZONE } = require("../lib/dashboardSummary");

const loadSummary = createDashboardSummary({
  Sale,
  SalePayment,
  Order,
  ProductionRun,
  RawMaterialAlert,
  Expense,
  AttendanceRecord,
  LeaveRequest,
  CompanyAsset,
});

async function getDashboardSummary(request, response, next) {
  try {
    const range = resolveRange(request.query.from, request.query.to);
    const { sections } = await loadSummary({
      roles: request.authUser.roles,
      ...range,
    });
    return response.json({
      version: 1,
      range: { ...range, timeZone: TIME_ZONE },
      generatedAt: new Date().toISOString(),
      sections,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = { getDashboardSummary };
