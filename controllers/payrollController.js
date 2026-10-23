const crypto = require("node:crypto");
const mongoose = require("mongoose");
const AttendancePeriod = require("../models/attendancePeriod");
const AttendanceRecord = require("../models/attendanceRecord");
const Employee = require("../models/employee");
const PayrollPolicy = require("../models/payrollPolicy");
const PayrollRun = require("../models/payrollRun");
const SalaryAdvance = require("../models/salaryAdvance");
const audit = require("../lib/audit");

const RUN_TYPES = ["Monthly", "Weekly wages", "Weekly feeding"];
const MAX_RUN_EMPLOYEES = 5000;
const MAX_ATTENDANCE_RECORDS = 200000;

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dateAfter(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function todayKampala() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Kampala",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function strictObject(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${label} must be an object.`;
  if (Object.keys(value).some((key) => !allowed.includes(key))) return `${label} contains unsupported fields.`;
  return "";
}

function validatePolicy(body) {
  const error = strictObject(
    body,
    ["weekStartDay", "attendanceCutoffDelayDays", "feedingAllowance", "statutoryRules"],
    "Payroll policy",
  );
  if (error) return { error };
  if (!Number.isInteger(body.weekStartDay) || body.weekStartDay < 0 || body.weekStartDay > 6) {
    return { error: "weekStartDay must be an integer from 0 (Sunday) to 6 (Saturday)." };
  }
  if (!Number.isInteger(body.attendanceCutoffDelayDays) || body.attendanceCutoffDelayDays < 0 || body.attendanceCutoffDelayDays > 14) {
    return { error: "attendanceCutoffDelayDays must be an integer from 0 to 14." };
  }
  const feeding = body.feedingAllowance;
  const feedingError = strictObject(feeding, ["defaultDailyRate", "eligibleEmployeeIds", "employeeOverrides"], "feedingAllowance");
  if (feedingError) return { error: feedingError };
  if (!Number.isFinite(feeding.defaultDailyRate) || feeding.defaultDailyRate < 0) {
    return { error: "The default feeding daily rate must be a non-negative number." };
  }
  if (!Array.isArray(feeding.eligibleEmployeeIds) || feeding.eligibleEmployeeIds.length > MAX_RUN_EMPLOYEES
    || feeding.eligibleEmployeeIds.some((id) => !mongoose.isValidObjectId(id))) {
    return { error: "eligibleEmployeeIds must contain valid employee IDs." };
  }
  if (!Array.isArray(feeding.employeeOverrides) || feeding.employeeOverrides.length > MAX_RUN_EMPLOYEES) {
    return { error: "employeeOverrides must be an array of at most 5000 employees." };
  }
  const overrideIds = new Set();
  for (const override of feeding.employeeOverrides) {
    const itemError = strictObject(override, ["employeeId", "dailyRate", "effectiveFrom", "effectiveTo"], "Feeding-rate override");
    if (itemError) return { error: itemError };
    if (!mongoose.isValidObjectId(override.employeeId) || overrideIds.has(String(override.employeeId))) {
      return { error: "Each feeding-rate override must have a unique valid employeeId." };
    }
    overrideIds.add(String(override.employeeId));
    if (!Number.isFinite(override.dailyRate) || override.dailyRate < 0
      || !validDate(override.effectiveFrom)
      || (override.effectiveTo && (!validDate(override.effectiveTo) || override.effectiveTo < override.effectiveFrom))) {
      return { error: "Feeding-rate overrides require a non-negative rate and valid effective dates." };
    }
  }
  if (!Array.isArray(body.statutoryRules) || body.statutoryRules.length > 100) {
    return { error: "statutoryRules must contain at most 100 rules." };
  }
  const codes = new Set();
  for (const rule of body.statutoryRules) {
    const ruleError = strictObject(rule, [
      "code", "name", "appliesTo", "runTypes", "employeeFlag", "method",
      "ratePercent", "bands", "ceiling", "effectiveFrom", "effectiveTo",
    ], "Statutory rule");
    if (ruleError) return { error: ruleError };
    if (typeof rule.code !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(rule.code)
      || codes.has(rule.code.toLowerCase())) return { error: "Statutory rule codes must be unique identifiers." };
    codes.add(rule.code.toLowerCase());
    if (typeof rule.name !== "string" || !rule.name.trim() || rule.name.trim().length > 100) {
      return { error: "Each statutory rule requires a name of at most 100 characters." };
    }
    if (!["Employee deduction", "Employer contribution"].includes(rule.appliesTo)
      || !["Percentage", "Progressive"].includes(rule.method)
      || !["taxApplies", "nssfApplies", "all"].includes(rule.employeeFlag)
      || !Array.isArray(rule.runTypes) || !rule.runTypes.length
      || rule.runTypes.some((type) => !RUN_TYPES.includes(type))
      || !validDate(rule.effectiveFrom)
      || (rule.effectiveTo && (!validDate(rule.effectiveTo) || rule.effectiveTo < rule.effectiveFrom))) {
      return { error: `Statutory rule ${rule.code} has invalid applicability or effective dates.` };
    }
    if (rule.method === "Percentage"
      && (!Number.isFinite(rule.ratePercent) || rule.ratePercent < 0 || rule.ratePercent > 100)) {
      return { error: `Statutory rule ${rule.code} ratePercent must be between 0 and 100.` };
    }
    if (rule.method === "Progressive") {
      if (!Array.isArray(rule.bands) || !rule.bands.length || rule.bands.length > 20) {
        return { error: `Statutory rule ${rule.code} requires progressive bands.` };
      }
      let previousLimit = 0;
      for (const band of rule.bands) {
        if (!band || (band.upTo !== null && (!Number.isFinite(band.upTo) || band.upTo <= previousLimit))
          || !Number.isFinite(band.ratePercent) || band.ratePercent < 0 || band.ratePercent > 100) {
          return { error: `Statutory rule ${rule.code} has invalid progressive bands.` };
        }
        if (band.upTo !== null) previousLimit = band.upTo;
      }
      if (rule.bands.at(-1).upTo !== null) return { error: `The final band for ${rule.code} must have no upper limit.` };
    }
    if (rule.ceiling !== undefined && rule.ceiling !== null && (!Number.isFinite(rule.ceiling) || rule.ceiling < 0)) {
      return { error: `Statutory rule ${rule.code} ceiling must be non-negative.` };
    }
  }
  return {
    value: {
      weekStartDay: body.weekStartDay,
      attendanceCutoffDelayDays: body.attendanceCutoffDelayDays,
      feedingAllowance: {
        defaultDailyRate: body.feedingAllowance.defaultDailyRate,
        eligibleEmployeeIds: [...new Set(body.feedingAllowance.eligibleEmployeeIds.map(String))],
        employeeOverrides: body.feedingAllowance.employeeOverrides.map((item) => ({
          employeeId: String(item.employeeId),
          dailyRate: item.dailyRate,
          effectiveFrom: item.effectiveFrom,
          effectiveTo: item.effectiveTo || "",
        })),
      },
      statutoryRules: body.statutoryRules.map((rule) => ({
        ...rule,
        code: rule.code.trim(),
        name: rule.name.trim(),
        effectiveTo: rule.effectiveTo || "",
        ceiling: rule.ceiling ?? null,
        bands: rule.bands || [],
      })),
    },
  };
}

function serializePolicy(policy) {
  const value = policy?.toObject ? policy.toObject() : policy || {};
  return {
    weekStartDay: value.weekStartDay ?? 1,
    attendanceCutoffDelayDays: value.attendanceCutoffDelayDays ?? 1,
    feedingAllowance: {
      defaultDailyRate: value.feedingAllowance?.defaultDailyRate ?? 0,
      eligibleEmployeeIds: (value.feedingAllowance?.eligibleEmployeeIds || []).map(String),
      employeeOverrides: (value.feedingAllowance?.employeeOverrides || []).map((item) => ({
        employeeId: String(item.employeeId),
        dailyRate: item.dailyRate,
        effectiveFrom: item.effectiveFrom,
        effectiveTo: item.effectiveTo || "",
      })),
    },
    statutoryRules: (value.statutoryRules || []).map((rule) => ({
      code: rule.code,
      name: rule.name,
      appliesTo: rule.appliesTo,
      runTypes: rule.runTypes,
      employeeFlag: rule.employeeFlag,
      method: rule.method,
      ratePercent: rule.ratePercent,
      bands: rule.bands,
      ceiling: rule.ceiling,
      effectiveFrom: rule.effectiveFrom,
      effectiveTo: rule.effectiveTo || "",
    })),
    updatedAt: value.updatedAt || null,
    updatedByName: value.updatedByName || "",
  };
}

async function getPolicy() {
  return (await PayrollPolicy.findById("global").lean()) || {
    weekStartDay: 1,
    attendanceCutoffDelayDays: 1,
    feedingAllowance: { defaultDailyRate: 0, eligibleEmployeeIds: [], employeeOverrides: [] },
    statutoryRules: [],
    updatedAt: null,
    updatedByName: "",
  };
}

async function saveWithAudit(request, eventType, details, save) {
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      result = await save(session);
      if (result === null || result === undefined) return;
      await audit.recordAudit({
        request,
        eventType,
        outcome: "success",
        actor: request.authUser,
        details,
        transaction: session,
      });
    });
    return result;
  } finally {
    await session.endSession();
  }
}

function serializeRun(run) {
  const value = run?.toObject ? run.toObject({ depopulate: true }) : run;
  if (!value) return null;
  return {
    id: String(value._id || value.id),
    reference: value.reference,
    runType: value.runType,
    periodStart: value.periodStart,
    periodEnd: value.periodEnd,
    status: value.status,
    policyVersion: value.policyVersion,
    calculationSnapshot: value.calculationSnapshot,
    payslips: (value.payslips || []).map((slip) => ({
      id: slip.slipId,
      employeeId: String(slip.employeeId),
      employeeNumber: slip.employeeNumber,
      employeeName: slip.employeeName,
      category: slip.category,
      department: slip.department,
      role: slip.role,
      compensationType: slip.compensationType,
      configuredRate: slip.configuredRate,
      attendanceUnits: slip.attendanceUnits,
      attendance: slip.attendance,
      earnings: slip.earnings,
      deductions: slip.deductions,
      employerContributions: slip.employerContributions,
      grossPay: slip.grossPay,
      deductionTotal: slip.deductionTotal,
      netPay: slip.netPay,
      employerContributionTotal: slip.employerContributionTotal,
      reviewStatus: slip.reviewStatus,
      paymentStatus: slip.paymentStatus,
    })),
    approvals: value.approvals || [],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    createdBy: value.createdByName,
    submittedAt: value.submittedAt,
    paidAt: value.paidAt,
    payment: value.payment && {
      method: value.payment.method,
      amount: value.payment.amount,
      date: value.payment.date,
      reference: value.payment.reference,
      note: value.payment.note,
      recordedByName: value.payment.recordedByName,
    },
    returnedNote: value.returnedNote || "",
  };
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function calculateRule(rule, base) {
  let amount = 0;
  if (rule.method === "Percentage") {
    amount = base * rule.ratePercent / 100;
  } else {
    let lower = 0;
    for (const band of rule.bands) {
      const upper = band.upTo === null ? base : Math.min(base, band.upTo);
      if (upper > lower) amount += (upper - lower) * band.ratePercent / 100;
      if (base <= upper || band.upTo === null) break;
      lower = band.upTo;
    }
  }
  if (Number.isFinite(rule.ceiling)) amount = Math.min(amount, rule.ceiling);
  return roundMoney(Math.max(0, amount));
}

function ruleAppliesToEmployee(rule, employee) {
  if (rule.employeeFlag === "all") return true;
  return employee[rule.employeeFlag] === true;
}

function eligibleEmployeeFilter(runType, policy) {
  const filter = { status: "Active" };
  if (runType === "Monthly") Object.assign(filter, { compensationType: "Salary earner", paymentFrequency: "Monthly" });
  if (runType === "Weekly wages") Object.assign(filter, { compensationType: "Wage earner", paymentFrequency: "Weekly" });
  if (runType === "Weekly feeding") filter._id = { $in: policy.feedingAllowance.eligibleEmployeeIds };
  return filter;
}

function activeRule(rule, runType, periodEnd) {
  return rule.runTypes.includes(runType)
    && rule.effectiveFrom <= periodEnd
    && (!rule.effectiveTo || rule.effectiveTo >= periodEnd);
}

function makeLine(code, label, amount, source, details = {}, employerOnly = false) {
  return { code, label, amount: roundMoney(amount), source, details, employerOnly };
}

function attendanceUnits(records) {
  return records.reduce((sum, item) => sum + (item.status === "Present" ? (item.halfDay ? 0.5 : 1) : 0), 0);
}

function isFeedingRateActive(override, date) {
  return override.effectiveFrom <= date && (!override.effectiveTo || override.effectiveTo >= date);
}

async function buildPayslips(runType, periodStart, periodEnd, employees, attendance, policy) {
  const attendanceByEmployee = new Map();
  for (const item of attendance) {
    const id = String(item.employeeId);
    if (!attendanceByEmployee.has(id)) attendanceByEmployee.set(id, []);
    attendanceByEmployee.get(id).push({
      date: item.workDate,
      status: item.status,
      units: item.status === "Present" ? (item.halfDay ? 0.5 : 1) : 0,
    });
  }
  const activeRules = policy.statutoryRules.filter((rule) => activeRule(rule, runType, periodEnd));
  const includeAdvances = runType !== "Weekly feeding";
  const advances = includeAdvances
    ? await SalaryAdvance.find({ employeeId: { $in: employees.map((item) => item._id) }, status: "Active" }).lean()
    : [];
  const byEmployeeAdvance = new Map();
  for (const advance of advances) {
    const employeeId = String(advance.employeeId);
    if (!byEmployeeAdvance.has(employeeId)) byEmployeeAdvance.set(employeeId, []);
    byEmployeeAdvance.get(employeeId).push(advance);
  }
  const slips = [];
  for (const employee of employees) {
    const id = String(employee._id);
    const records = attendanceByEmployee.get(id) || [];
    const units = attendanceUnits(records);
    const earnings = [];
    const deductions = [];
    const employerContributions = [];
    let configuredRate = employee.salary || 0;
    let compensationType = employee.compensationType || "Salary earner";

    if (runType === "Monthly") {
      if (employee.compensationType !== "Salary earner" || employee.paymentFrequency !== "Monthly") continue;
      earnings.push(makeLine("BASE_MONTHLY", "Monthly base salary", employee.salary, "Base pay", { configuredRate: employee.salary }));
    } else if (runType === "Weekly wages") {
      if (employee.compensationType !== "Wage earner" || employee.paymentFrequency !== "Weekly") continue;
      earnings.push(makeLine("WEEKLY_ATTENDANCE_WAGE", "Attendance-based wages", employee.salary * units, "Attendance", {
        configuredDailyRate: employee.salary,
        attendanceUnits: units,
      }));
    } else {
      const eligibleIds = new Set((policy.feedingAllowance.eligibleEmployeeIds || []).map(String));
      if (!eligibleIds.has(id)) continue;
      compensationType = "Allowance only";
      const override = (policy.feedingAllowance.employeeOverrides || [])
        .find((item) => String(item.employeeId) === id && isFeedingRateActive(item, periodEnd));
      configuredRate = override?.dailyRate ?? policy.feedingAllowance.defaultDailyRate;
      if (!configuredRate) {
        const error = new Error(`A feeding allowance rate is not configured for ${employee.name}.`);
        error.statusCode = 409;
        throw error;
      }
      earnings.push(makeLine("WEEKLY_FEEDING", "Weekly feeding allowance", configuredRate * units, "Feeding allowance", {
        dailyRate: configuredRate,
        attendanceUnits: units,
        rateSource: override ? "Employee override" : "Company default",
      }));
    }

    const grossPay = roundMoney(earnings.reduce((sum, item) => sum + item.amount, 0));
    for (const rule of activeRules) {
      if (!ruleAppliesToEmployee(rule, employee)) continue;
      const amount = calculateRule(rule, grossPay);
      if (!amount) continue;
      const line = makeLine(rule.code, rule.name, amount, "Statutory", {
        appliesTo: rule.appliesTo,
        method: rule.method,
        ruleCode: rule.code,
      }, rule.appliesTo === "Employer contribution");
      if (rule.appliesTo === "Employee deduction") deductions.push(line);
      else employerContributions.push(line);
    }
    const employeeAdvanceList = byEmployeeAdvance.get(id) || [];
    for (const advance of employeeAdvanceList) {
      const scheduleFrequency = advance.approvedFrequency || advance.proposedFrequency;
      const runFrequency = runType === "Monthly" ? "Monthly" : "Weekly";
      if (scheduleFrequency !== runFrequency) continue;
      const repaidScheduleIds = new Set((advance.repayments || []).flatMap((item) => (item.scheduleEntryIds || []).map(String)));
      const due = (advance.schedule || []).filter((entry) =>
        entry.dueDate <= periodEnd && !repaidScheduleIds.has(String(entry._id)),
      );
      const outstanding = Math.max(0, (advance.disbursement?.amount || 0)
        - (advance.repayments || []).reduce((sum, item) => sum + item.amount, 0));
      let remaining = Math.min(outstanding, due.reduce((sum, item) => sum + item.plannedAmount, 0));
      for (const entry of due) {
        if (remaining <= 0) break;
        const amount = Math.min(entry.plannedAmount, remaining);
        deductions.push(makeLine(
          `ADV-${advance._id}-${entry._id}`,
          `Salary advance repayment · ${advance.reference}`,
          amount,
          "Salary advance",
          { advanceId: String(advance._id), scheduleEntryId: String(entry._id) },
        ));
        remaining -= amount;
      }
    }
    const deductionTotal = roundMoney(deductions.reduce((sum, item) => sum + item.amount, 0));
    const employerContributionTotal = roundMoney(employerContributions.reduce((sum, item) => sum + item.amount, 0));
    slips.push({
      slipId: crypto.randomUUID(),
      employeeId: employee._id,
      employeeNumber: employee.number,
      employeeName: employee.name,
      category: employee.category,
      department: employee.department,
      role: employee.role,
      compensationType,
      configuredRate,
      attendanceUnits: units,
      attendance: records,
      earnings,
      deductions,
      employerContributions,
      grossPay,
      deductionTotal,
      netPay: roundMoney(Math.max(0, grossPay - deductionTotal)),
      employerContributionTotal,
      reviewStatus: "Ready",
      paymentStatus: "Unpaid",
    });
  }
  return slips;
}

async function listPolicy(_request, response) {
  return response.json({ policy: serializePolicy(await getPolicy()) });
}

async function updatePolicy(request, response) {
  const validated = validatePolicy(request.body);
  if (validated.error) return response.status(400).json({ error: validated.error });
  const policy = await saveWithAudit(request, "payroll.policy_updated", {
    weekStartDay: validated.value.weekStartDay,
    statutoryRuleCount: validated.value.statutoryRules.length,
  }, async (session) => PayrollPolicy.findByIdAndUpdate("global", {
    $set: {
      ...validated.value,
      updatedBy: request.authUser._id,
      updatedByName: request.authUser.name,
    },
    $setOnInsert: { _id: "global" },
  }, { new: true, upsert: true, runValidators: true, session }));
  return response.json({ policy: serializePolicy(policy) });
}

function validateRunRequest(body) {
  const error = strictObject(body, ["runType", "periodStart", "periodEnd"], "Payroll run");
  if (error) return { error };
  if (!RUN_TYPES.includes(body.runType)) return { error: "runType is invalid." };
  if (!validDate(body.periodStart) || !validDate(body.periodEnd) || body.periodStart > body.periodEnd) {
    return { error: "Provide a valid periodStart and periodEnd in YYYY-MM-DD format." };
  }
  if (body.periodStart.length < 10 || body.periodEnd.length < 10) return { error: "Payroll period is invalid." };
  if (body.runType === "Monthly") {
    const first = `${body.periodStart.slice(0, 7)}-01`;
    const [year, month] = body.periodStart.slice(0, 7).split("-").map(Number);
    const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    if (body.periodStart !== first || body.periodEnd !== last) return { error: "Monthly payroll periods must cover a full calendar month." };
  }
  return { value: body };
}

function isWeekAligned(start, end, weekStartDay) {
  const date = new Date(`${start}T00:00:00.000Z`);
  const expected = weekStartDay === 0 ? 0 : weekStartDay;
  const span = Math.round((new Date(`${end}T00:00:00.000Z`) - date) / 86400000);
  return date.getUTCDay() === expected && span === 6;
}

async function createRun(request, response) {
  const validated = validateRunRequest(request.body);
  if (validated.error) return response.status(400).json({ error: validated.error });
  const { runType, periodStart, periodEnd } = validated.value;
  const policy = await getPolicy();
  if (runType !== "Monthly" && !isWeekAligned(periodStart, periodEnd, policy.weekStartDay)) {
    return response.status(400).json({ error: "Weekly runs must match the configured seven-day week boundaries." });
  }
  if (dateAfter(periodEnd, policy.attendanceCutoffDelayDays) > todayKampala()) {
    return response.status(409).json({ error: "The configured attendance cutoff has not passed for this payroll period." });
  }
  const attendancePeriod = await AttendancePeriod.findOne({
    periodStart,
    periodEnd,
    status: "Closed",
  }).lean();
  if (!attendancePeriod) return response.status(409).json({ error: "Attendance must be reviewed and closed for this exact period before payroll can be calculated." });

  const existing = await PayrollRun.findOne({ runType, periodStart, periodEnd });
  if (existing) return response.status(409).json({ error: "A payroll run already exists for this type and period.", run: serializeRun(existing) });

  const employees = await Employee.find(eligibleEmployeeFilter(runType, policy)).sort({ number: 1 }).limit(MAX_RUN_EMPLOYEES + 1).lean();
  if (employees.length > MAX_RUN_EMPLOYEES) return response.status(413).json({ error: "The payroll population exceeds the configured run size limit." });
  if (!employees.length) return response.status(409).json({ error: "There are no active eligible employees configured for this run." });

  const attendance = await AttendanceRecord.find({
    employeeId: { $in: employees.map((employee) => employee._id) },
    workDate: { $gte: periodStart, $lte: periodEnd },
  }).sort({ workDate: 1, employeeId: 1 }).limit(MAX_ATTENDANCE_RECORDS + 1).lean();
  if (attendance.length > MAX_ATTENDANCE_RECORDS) return response.status(413).json({ error: "Attendance records exceed the configured payroll calculation limit." });
  const payslips = await buildPayslips(runType, periodStart, periodEnd, employees, attendance, policy);
  if (!payslips.length) return response.status(409).json({ error: "No eligible employee payslips could be calculated for this run." });
  const missingRules = payslips.find((slip) => {
    const employee = employees.find((item) => String(item._id) === String(slip.employeeId));
    return (employee.taxApplies && !policy.statutoryRules.some((rule) => rule.employeeFlag === "taxApplies" && activeRule(rule, runType, periodEnd)))
      || (employee.nssfApplies && !policy.statutoryRules.some((rule) => rule.employeeFlag === "nssfApplies" && activeRule(rule, runType, periodEnd)));
  });
  if (missingRules) return response.status(409).json({ error: `Statutory payroll rules are missing for ${missingRules.employeeName}. Configure accountant-approved rules before calculating this run.` });

  const calculationSnapshot = {
    currency: "UGX",
    periodStart,
    periodEnd,
    runType,
    weekStartDay: policy.weekStartDay,
    attendanceCutoffDelayDays: policy.attendanceCutoffDelayDays,
    feedingAllowance: runType === "Weekly feeding" ? policy.feedingAllowance : undefined,
    statutoryRules: policy.statutoryRules.filter((rule) => activeRule(rule, runType, periodEnd)),
    attendanceClosedAt: attendancePeriod.closedAt,
    attendanceClosedByName: attendancePeriod.closedByName,
    attendanceRecordCount: attendance.length,
  };
  const calculationHash = crypto.createHash("sha256").update(JSON.stringify({
    calculationSnapshot,
    employees: employees.map((employee) => [String(employee._id), employee.updatedAt, employee.salary, employee.compensationType]),
    attendance: attendance.map((item) => [String(item.employeeId), item.workDate, item.status, item.halfDay]),
    payslips,
  })).digest("hex");
  const now = new Date();
  const reference = `PAY-${runType === "Monthly" ? "M" : runType === "Weekly wages" ? "W" : "F"}-${periodEnd.replaceAll("-", "")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  try {
    const run = await saveWithAudit(request, "payroll.run_created", {
      reference, runType, periodStart, periodEnd, employeeCount: payslips.length,
    }, async (session) => {
      const [created] = await PayrollRun.create([{
        reference,
        runType,
        periodStart,
        periodEnd,
        status: "Draft",
        policyVersion: policy.updatedAt || now,
        calculationSnapshot,
        attendancePeriodId: attendancePeriod._id,
        payslips,
        createdBy: request.authUser._id,
        createdByName: request.authUser.name,
        calculationHash,
      }], { session });
      return created;
    });
    return response.status(201).json({ run: serializeRun(run) });
  } catch (error) {
    if (error.code === 11000) return response.status(409).json({ error: "A payroll run already exists for this type and period." });
    throw error;
  }
}

async function listRuns(request, response) {
  const allowed = new Set(["runType", "status", "periodStart", "periodEnd", "limit"]);
  if (Object.keys(request.query).some((key) => !allowed.has(key))) return response.status(400).json({ error: "Unsupported payroll list filter." });
  const filter = {};
  if (request.query.runType) {
    if (!RUN_TYPES.includes(request.query.runType)) return response.status(400).json({ error: "runType is invalid." });
    filter.runType = request.query.runType;
  }
  if (request.query.status) {
    if (!["Draft", "In review", "Manager approved", "Approved", "Returned", "Paid"].includes(request.query.status)) return response.status(400).json({ error: "status is invalid." });
    filter.status = request.query.status;
  }
  if (request.query.periodStart || request.query.periodEnd) {
    if (!validDate(request.query.periodStart) || !validDate(request.query.periodEnd) || request.query.periodStart > request.query.periodEnd) return response.status(400).json({ error: "A valid periodStart and periodEnd pair is required." });
    filter.periodStart = { $gte: request.query.periodStart };
    filter.periodEnd = { $lte: request.query.periodEnd };
  }
  const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) return response.status(400).json({ error: "limit must be an integer from 1 to 500." });
  const runs = await PayrollRun.find(filter).sort({ periodStart: -1, createdAt: -1 }).limit(limit).lean();
  return response.json({ runs: runs.map(serializeRun) });
}

async function getRun(request, response) {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(400).json({ error: "Payroll run ID is invalid." });
  const run = await PayrollRun.findById(request.params.id).lean();
  if (!run) return response.status(404).json({ error: "Payroll run was not found." });
  return response.json({ run: serializeRun(run) });
}

async function recalculateRun(request, response) {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(400).json({ error: "Payroll run ID is invalid." });
  const run = await PayrollRun.findById(request.params.id).lean();
  if (!run) return response.status(404).json({ error: "Payroll run was not found." });
  if (!["Draft", "Returned"].includes(run.status)) return response.status(409).json({ error: "Only a draft or returned run can be recalculated." });
  const policy = await getPolicy();
  const attendancePeriod = await AttendancePeriod.findOne({
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
    status: "Closed",
  }).lean();
  if (!attendancePeriod) return response.status(409).json({ error: "Attendance must be recertified before recalculating this run." });
  const employees = await Employee.find(eligibleEmployeeFilter(run.runType, policy))
    .sort({ number: 1 })
    .limit(MAX_RUN_EMPLOYEES + 1)
    .lean();
  if (employees.length > MAX_RUN_EMPLOYEES) return response.status(413).json({ error: "The payroll population exceeds the configured run size limit." });
  if (!employees.length) return response.status(409).json({ error: "There are no active eligible employees configured for this run." });
  const attendance = await AttendanceRecord.find({
    employeeId: { $in: employees.map((employee) => employee._id) },
    workDate: { $gte: run.periodStart, $lte: run.periodEnd },
  }).sort({ workDate: 1, employeeId: 1 }).limit(MAX_ATTENDANCE_RECORDS + 1).lean();
  if (attendance.length > MAX_ATTENDANCE_RECORDS) return response.status(413).json({ error: "Attendance records exceed the configured payroll calculation limit." });
  const payslips = await buildPayslips(run.runType, run.periodStart, run.periodEnd, employees, attendance, policy);
  const missingRules = payslips.find((slip) => {
    const employee = employees.find((item) => String(item._id) === String(slip.employeeId));
    return (employee.taxApplies && !policy.statutoryRules.some((rule) => rule.employeeFlag === "taxApplies" && activeRule(rule, run.runType, run.periodEnd)))
      || (employee.nssfApplies && !policy.statutoryRules.some((rule) => rule.employeeFlag === "nssfApplies" && activeRule(rule, run.runType, run.periodEnd)));
  });
  if (missingRules) return response.status(409).json({ error: `Statutory payroll rules are missing for ${missingRules.employeeName}.` });
  if (!payslips.length) return response.status(409).json({ error: "No eligible employee payslips could be calculated for this run." });
  const calculationSnapshot = {
    ...run.calculationSnapshot,
    weekStartDay: policy.weekStartDay,
    attendanceCutoffDelayDays: policy.attendanceCutoffDelayDays,
    feedingAllowance: run.runType === "Weekly feeding" ? policy.feedingAllowance : undefined,
    statutoryRules: policy.statutoryRules.filter((rule) => activeRule(rule, run.runType, run.periodEnd)),
    attendanceClosedAt: attendancePeriod.closedAt,
    attendanceClosedByName: attendancePeriod.closedByName,
    attendanceRecordCount: attendance.length,
  };
  const calculationHash = crypto.createHash("sha256").update(JSON.stringify({
    calculationSnapshot,
    employees: employees.map((employee) => [String(employee._id), employee.updatedAt, employee.salary, employee.compensationType]),
    attendance: attendance.map((item) => [String(item.employeeId), item.workDate, item.status, item.halfDay]),
    payslips,
  })).digest("hex");
  const updated = await saveWithAudit(request, "payroll.run_recalculated", {
    runId: request.params.id, employeeCount: payslips.length,
  }, async (session) => {
    const current = await PayrollRun.findById(request.params.id).session(session);
    if (!current || !["Draft", "Returned"].includes(current.status)) {
      const conflict = new Error("The payroll run changed and can no longer be recalculated.");
      conflict.statusCode = 409;
      throw conflict;
    }
    current.payslips = payslips;
    current.calculationSnapshot = calculationSnapshot;
    current.policyVersion = policy.updatedAt || new Date();
    current.calculationHash = calculationHash;
    current.attendancePeriodId = attendancePeriod._id;
    current.status = "Draft";
    current.approvals = [];
    current.returnedNote = "";
    await current.save({ session });
    return current;
  });
  return response.json({ run: serializeRun(updated) });
}

async function submitRun(request, response) {
  const error = strictObject(request.body, [], "Submission");
  if (error) return response.status(400).json({ error });
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(400).json({ error: "Payroll run ID is invalid." });
  const run = await saveWithAudit(request, "payroll.run_submitted", { runId: request.params.id }, async (session) => {
    const found = await PayrollRun.findById(request.params.id).session(session);
    if (!found) return null;
    if (!["Draft", "Returned"].includes(found.status)) {
      const conflict = new Error("Only a draft or returned payroll run can be submitted.");
      conflict.statusCode = 409;
      throw conflict;
    }
    if (!found.payslips.length || found.payslips.some((slip) => slip.reviewStatus !== "Ready")) {
      const conflict = new Error("All payroll payslips must be ready before submission.");
      conflict.statusCode = 409;
      throw conflict;
    }
    found.status = "In review";
    found.submittedAt = new Date();
    found.returnedNote = "";
    await found.save({ session });
    return found;
  });
  if (!run) return response.status(404).json({ error: "Payroll run was not found." });
  return response.json({ run: serializeRun(run) });
}

function approvalRole(run, userRoles, actorId) {
  if (run.status === "In review" && (userRoles.includes("General Manager") || userRoles.includes("Super Admin"))) return "General Manager";
  if (run.status === "Manager approved" && userRoles.includes("Super Admin")) {
    const managerApproval = run.approvals.find((approval) => approval.stage === "General Manager" && approval.decision === "Approved");
    if (managerApproval && String(managerApproval.actorId) === String(actorId)) return "";
    return "Super Admin";
  }
  return "";
}

async function decideRun(request, response) {
  const error = strictObject(request.body, ["decision", "note"], "Approval decision");
  if (error) return response.status(400).json({ error });
  if (!["Approved", "Returned"].includes(request.body.decision)) return response.status(400).json({ error: "decision must be Approved or Returned." });
  if (typeof request.body.note !== "string" || request.body.note.trim().length > 1000) return response.status(400).json({ error: "An approval note must be text of at most 1000 characters." });
  if (request.body.decision === "Returned" && !request.body.note.trim()) return response.status(400).json({ error: "A reason is required when returning payroll for correction." });
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(400).json({ error: "Payroll run ID is invalid." });
  const run = await saveWithAudit(request, "payroll.run_decided", {
    runId: request.params.id, decision: request.body.decision,
  }, async (session) => {
    const found = await PayrollRun.findById(request.params.id).session(session);
    if (!found) return null;
    const stage = approvalRole(found, request.authUser.roles, request.authUser._id);
    if (!stage) {
      const conflict = new Error("This run is not awaiting an approval assigned to your role.");
      conflict.statusCode = 409;
      throw conflict;
    }
    const decision = {
      stage,
      decision: request.body.decision,
      actorId: request.authUser._id,
      actorName: request.authUser.name,
      note: request.body.note.trim(),
      decidedAt: new Date(),
    };
    found.approvals.push(decision);
    if (request.body.decision === "Returned") {
      found.status = "Returned";
      found.returnedNote = request.body.note.trim();
    } else {
      found.status = stage === "General Manager" ? "Manager approved" : "Approved";
    }
    await found.save({ session });
    return found;
  });
  if (!run) return response.status(404).json({ error: "Payroll run was not found." });
  return response.json({ run: serializeRun(run) });
}

function parsePayment(body) {
  const error = strictObject(body, ["date", "reference", "note"], "Cash payment");
  if (error) return { error };
  if (!validDate(body.date)) return { error: "Payment date must be a valid YYYY-MM-DD date." };
  if (body.reference !== undefined && (typeof body.reference !== "string" || body.reference.trim().length > 160)) return { error: "Payment reference must be text of at most 160 characters." };
  if (body.note !== undefined && (typeof body.note !== "string" || body.note.trim().length > 500)) return { error: "Payment note must be text of at most 500 characters." };
  return { value: { date: body.date, reference: body.reference?.trim() || "", note: body.note?.trim() || "" } };
}

async function settleAdvanceRepayments(request, run, session) {
  const repaymentLines = run.payslips.flatMap((slip) => slip.deductions
    .filter((item) => item.source === "Salary advance")
    .map((item) => ({ slip, item })));
  for (const { slip, item } of repaymentLines) {
    const advance = await SalaryAdvance.findById(item.details.advanceId).session(session);
    if (!advance || advance.status !== "Active") {
      const conflict = new Error("A salary advance in this payroll is no longer active. Recalculate the draft before payment.");
      conflict.statusCode = 409;
      throw conflict;
    }
    const scheduleId = String(item.details.scheduleEntryId);
    const alreadyPaid = advance.repayments.find((repayment) => (repayment.scheduleEntryIds || []).some((id) => String(id) === scheduleId));
    if (alreadyPaid) {
      const conflict = new Error("A salary-advance installment in this payroll was already repaid. This run cannot be paid twice.");
      conflict.statusCode = 409;
      throw conflict;
    }
    const scheduleEntry = advance.schedule.id(scheduleId);
    if (!scheduleEntry || scheduleEntry.plannedAmount < item.amount) {
      const conflict = new Error("A salary-advance installment changed after payroll calculation. Recalculate the draft.");
      conflict.statusCode = 409;
      throw conflict;
    }
    const repayment = {
      amount: item.amount,
      date: run.periodEnd,
      method: "Payroll",
      reference: `${run.reference}/${slip.slipId}`,
      recordedAt: new Date(),
      recordedBy: request.authUser._id,
      payrollRunId: String(run._id),
      payslipId: slip.slipId,
      scheduleEntryIds: [scheduleEntry._id],
      idempotencyKey: `${run._id}:${slip.slipId}:${advance._id}:${scheduleEntry._id}`,
    };
    advance.repayments.push(repayment);
    const totalRepaid = advance.repayments.reduce((sum, entry) => sum + entry.amount, 0);
    advance.status = totalRepaid >= (advance.disbursement?.amount || 0) ? "Settled" : "Active";
    advance.updatedBy = request.authUser._id;
    advance.activity.push({
      action: "Payroll repayment recorded",
      actorId: request.authUser._id,
      actorName: request.authUser.name,
      note: `${run.reference}/${slip.slipId}`,
      at: new Date(),
    });
    await advance.save({ session });
    await audit.recordAudit({
      request,
      eventType: "salary_advance.repaid",
      outcome: "success",
      actor: request.authUser,
      details: {
        method: "Payroll",
        amount: item.amount,
        payrollRunId: String(run._id),
        payslipId: slip.slipId,
      },
      transaction: session,
    });
  }
}

async function recordPayment(request, response) {
  const parsed = parsePayment(request.body);
  if (parsed.error) return response.status(400).json({ error: parsed.error });
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(400).json({ error: "Payroll run ID is invalid." });
  const run = await saveWithAudit(request, "payroll.payment_recorded", {
    runId: request.params.id,
    method: "Cash",
    date: parsed.value.date,
  }, async (session) => {
    const found = await PayrollRun.findById(request.params.id).session(session);
    if (!found) return null;
    if (found.status !== "Approved") {
      const conflict = new Error("Only a fully approved payroll run can be recorded as paid.");
      conflict.statusCode = 409;
      throw conflict;
    }
    await settleAdvanceRepayments(request, found, session);
    const now = new Date();
    found.payment = {
      method: "Cash",
      amount: roundMoney(found.payslips.reduce((sum, slip) => sum + slip.netPay, 0)),
      date: parsed.value.date,
      reference: parsed.value.reference,
      note: parsed.value.note,
      recordedBy: request.authUser._id,
      recordedByName: request.authUser.name,
    };
    found.paidAt = now;
    found.status = "Paid";
    found.payslips.forEach((slip) => { slip.paymentStatus = "Paid"; });
    await found.save({ session });
    return found;
  });
  if (!run) return response.status(404).json({ error: "Payroll run was not found." });
  return response.json({ run: serializeRun(run) });
}

async function closeAttendancePeriod(request, response) {
  const error = strictObject(request.body, ["periodStart", "periodEnd", "confirmedComplete"], "Attendance period");
  if (error) return response.status(400).json({ error });
  const { periodStart, periodEnd, confirmedComplete } = request.body;
  if (!validDate(periodStart) || !validDate(periodEnd) || periodStart > periodEnd || confirmedComplete !== true) {
    return response.status(400).json({ error: "Provide a valid date range and confirm that attendance for the period is complete." });
  }
  if (periodEnd > todayKampala()) return response.status(400).json({ error: "A future attendance period cannot be closed." });
  try {
    const period = await saveWithAudit(request, "attendance.period_closed", {
      periodStart, periodEnd,
    }, async (session) => {
      const existing = await AttendancePeriod.findOne({ periodStart, periodEnd }).session(session);
      if (existing?.status === "Closed") {
        const conflict = new Error("This attendance period is already closed.");
        conflict.statusCode = 409;
        throw conflict;
      }
      const closed = existing || new AttendancePeriod({ periodStart, periodEnd });
      closed.status = "Closed";
      closed.closedAt = new Date();
      closed.closedBy = request.authUser._id;
      closed.closedByName = request.authUser.name;
      closed.reopenedAt = null;
      closed.reopenedBy = null;
      closed.reopenReason = "";
      await closed.save({ session });
      return closed;
    });
    return response.status(201).json({ period });
  } catch (error) {
    if (error.code === 11000) return response.status(409).json({ error: "This attendance period is already closed." });
    throw error;
  }
}

async function getAttendancePeriod(request, response) {
  const { periodStart, periodEnd } = request.params;
  if (!validDate(periodStart) || !validDate(periodEnd)) return response.status(400).json({ error: "Attendance period dates are invalid." });
  const period = await AttendancePeriod.findOne({ periodStart, periodEnd }).lean();
  return response.json({
    period: period && {
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      status: period.status,
      closedAt: period.closedAt,
      closedByName: period.closedByName,
      reopenReason: period.reopenReason,
    },
  });
}

async function reopenAttendancePeriod(request, response) {
  const error = strictObject(request.body, ["reason"], "Attendance period reopen");
  if (error) return response.status(400).json({ error });
  if (typeof request.body.reason !== "string" || !request.body.reason.trim() || request.body.reason.trim().length > 1000) return response.status(400).json({ error: "A correction reason is required to reopen an attendance period." });
  const { periodStart, periodEnd } = request.params;
  if (!validDate(periodStart) || !validDate(periodEnd)) return response.status(400).json({ error: "Attendance period dates are invalid." });
  const period = await saveWithAudit(request, "attendance.period_reopened", {
    periodStart, periodEnd,
  }, async (session) => {
    const found = await AttendancePeriod.findOne({ periodStart, periodEnd }).session(session);
    if (!found || found.status !== "Closed") return null;
    const paidRun = await PayrollRun.exists({ attendancePeriodId: found._id, status: "Paid" }).session(session);
    if (paidRun) {
      const conflict = new Error("Attendance used by a paid payroll run cannot be reopened; record an audited adjustment instead.");
      conflict.statusCode = 409;
      throw conflict;
    }
    const blockedRun = await PayrollRun.exists({
      attendancePeriodId: found._id,
      status: { $in: ["In review", "Manager approved", "Approved"] },
    }).session(session);
    if (blockedRun) {
      const conflict = new Error("Attendance cannot be reopened while payroll is under approval. Return or cancel the payroll run first.");
      conflict.statusCode = 409;
      throw conflict;
    }
    await PayrollRun.updateMany({
      attendancePeriodId: found._id,
      status: "Draft",
    }, { $set: { status: "Returned", returnedNote: request.body.reason.trim() } }, { session });
    found.status = "Reopened";
    found.reopenedAt = new Date();
    found.reopenedBy = request.authUser._id;
    found.reopenReason = request.body.reason.trim();
    await found.save({ session });
    return found;
  });
  if (!period) return response.status(404).json({ error: "Closed attendance period was not found." });
  return response.json({ period });
}

async function listPayslips(request, response) {
  if (!mongoose.isValidObjectId(request.params.employeeId)) return response.status(400).json({ error: "Employee ID is invalid." });
  const employee = await Employee.findById(request.params.employeeId).select("userId").lean();
  if (!employee) return response.status(404).json({ error: "Employee was not found." });
  const manager = request.authUser.roles.some((role) => ["Human Resource", "General Manager", "Super Admin", "Accountant"].includes(role));
  if (!manager && String(employee.userId) !== String(request.authUser._id)) {
    await audit.recordAudit({
      request,
      eventType: "security.authorization_denied",
      outcome: "denied",
      reason: "payroll_payslip_scope_required",
      actor: request.authUser,
      details: { employeeId: request.params.employeeId },
    });
    return response.status(403).json({ error: "You may only view your own payslips." });
  }
  const runFilter = { "payslips.employeeId": employee._id };
  if (!manager) runFilter.status = { $in: ["Approved", "Paid"] };
  const runs = await PayrollRun.find(runFilter).sort({ periodStart: -1 }).limit(100).lean();
  const slips = runs.flatMap((run) => {
    const serializedRun = serializeRun(run);
    const runSummary = {
      id: serializedRun.id,
      reference: serializedRun.reference,
      runType: serializedRun.runType,
      periodStart: serializedRun.periodStart,
      periodEnd: serializedRun.periodEnd,
      status: serializedRun.status,
      payment: serializedRun.payment,
    };
    return serializedRun.payslips
      .filter((slip) => slip.employeeId === String(employee._id))
      .map((payslip) => ({ run: runSummary, payslip }));
  });
  return response.json({ payslips: slips });
}

module.exports = {
  calculateRule,
  closeAttendancePeriod,
  createRun,
  decideRun,
  eligibleEmployeeFilter,
  getPolicy,
  getAttendancePeriod,
  getRun,
  listPolicy,
  listPayslips,
  listRuns,
  parsePayment,
  reopenAttendancePeriod,
  saveWithAudit,
  serializePolicy,
  serializeRun,
  submitRun,
  updatePolicy,
  validatePolicy,
  validateRunRequest,
  approvalRole,
  recordPayment,
  recalculateRun,
};
