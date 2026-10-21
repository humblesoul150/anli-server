const { randomUUID } = require("node:crypto");
const mongoose = require("mongoose");
const Employee = require("../models/employee");
const EmployeeDraft = require("../models/employeeDraft");
const { cloudinary, uploadImage, uploadPdf, deleteAsset } = require("../configs/cloudinary");
const audit = require("../lib/audit");

const STRING_LIMITS = {
  name: 180,
  firstName: 80,
  secondName: 80,
  otherNames: 120,
  gender: 30,
  maritalStatus: 30,
  spouseName: 120,
  spousePhone: 40,
  educationLevel: 80,
  profession: 120,
  phone: 40,
  email: 254,
  currentAddress: 300,
  placeOfOrigin: 200,
  nextOfKinName: 120,
  nextOfKinRelationship: 80,
  nextOfKinPhone: 40,
  nextOfKinAddress: 300,
  category: 40,
  department: 100,
  role: 100,
  status: 20,
  compensationType: 30,
  paymentFrequency: 20,
  nssfNumber: 80,
  tinNumber: 80,
  notes: 2000,
};
const PROFILE_FIELDS = new Set([
  ...Object.keys(STRING_LIMITS),
  "userId",
  "supervisorUserId",
  "dateOfBirth",
  "childrenCount",
  "salary",
  "nssfApplies",
  "taxApplies",
  "mother",
  "father",
]);
const ENUMS = {
  category: ["Staff employee", "Casual worker", "Other", "Staff", "Casual"],
  status: ["Active", "Inactive"],
  compensationType: ["Salary earner", "Wage earner", ""],
  paymentFrequency: ["Monthly", "Weekly", ""],
};
const MANAGER_HIDDEN_FIELDS = [
  "salary",
  "compensationType",
  "paymentFrequency",
  "nssfNumber",
  "tinNumber",
  "nssfApplies",
  "taxApplies",
  "spouseName",
  "spousePhone",
  "childrenCount",
  "mother",
  "father",
  "nextOfKinName",
  "nextOfKinRelationship",
  "nextOfKinPhone",
  "nextOfKinAddress",
  "userId",
  "supervisorUserId",
  "documents",
];

function isGeneralManager(request) {
  return request.authUser.roles.includes("General Manager")
    && !request.authUser.roles.some((role) => ["Super Admin", "Admin", "Human Resource"].includes(role));
}

function validateParent(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: `${field} must be an object.` };
  }
  const allowed = new Set(["name", "phone", "address", "status"]);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key)) return { error: `Unsupported ${field} field: ${key}.` };
    if (typeof item !== "string") return { error: `${field}.${key} must be text.` };
    const max = key === "address" ? 300 : key === "status" ? 20 : key === "phone" ? 40 : 120;
    const trimmed = item.trim();
    if (trimmed.length > max) return { error: `${field}.${key} is too long.` };
    if (key === "status" && !["", "Alive", "Deceased"].includes(trimmed)) {
      return { error: `${field}.status is invalid.` };
    }
    result[key] = trimmed;
  }
  return { value: result };
}

function validateEmployeeInput(body, { partial = false, allowNumber = false } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Provide employee data as a JSON object." };
  }
  const allowed = new Set(PROFILE_FIELDS);
  if (allowNumber) allowed.add("number");
  const unknown = Object.keys(body).find((key) => !allowed.has(key));
  if (unknown) return { error: `Unsupported employee field: ${unknown}.` };

  const value = {};
  for (const [field, item] of Object.entries(body)) {
    if (field === "userId" || field === "supervisorUserId") {
      if (item === null || item === "") {
        value[field] = null;
      } else if (typeof item !== "string" || !mongoose.isValidObjectId(item)) {
        return { error: `${field} must be a valid user ID or null.` };
      } else {
        value[field] = new mongoose.Types.ObjectId(item);
      }
      continue;
    }
    if (field === "mother" || field === "father") {
      const parent = validateParent(item, field);
      if (parent.error) return parent;
      value[field] = parent.value;
      continue;
    }
    if (field === "dateOfBirth") {
      if (item === "" || item === null) {
        value[field] = null;
      } else {
        const date = new Date(item);
        if (typeof item !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== item) {
          return { error: "dateOfBirth must be a valid YYYY-MM-DD date." };
        }
        value[field] = date;
      }
      continue;
    }
    if (field === "salary" || field === "childrenCount") {
      if (typeof item !== "number" || !Number.isFinite(item) || item < 0 || (field === "childrenCount" && !Number.isInteger(item))) {
        return { error: `${field} must be a non-negative ${field === "childrenCount" ? "whole number" : "number"}.` };
      }
      value[field] = item;
      continue;
    }
    if (field === "nssfApplies" || field === "taxApplies") {
      if (typeof item !== "boolean") return { error: `${field} must be true or false.` };
      value[field] = item;
      continue;
    }
    if (field === "number") {
      if (typeof item !== "string" || !item.trim() || item.trim().length > 40) {
        return { error: "number must be non-empty text of 40 characters or fewer." };
      }
      value[field] = item.trim();
      continue;
    }
    if (typeof item !== "string") return { error: `${field} must be text.` };
    const trimmed = item.trim();
    if (trimmed.length > STRING_LIMITS[field]) {
      return { error: `${field} must be ${STRING_LIMITS[field]} characters or fewer.` };
    }
    if (ENUMS[field] && !ENUMS[field].includes(trimmed)) {
      return { error: `${field} is not an allowed value.` };
    }
    value[field] = field === "email" ? trimmed.toLowerCase() : trimmed;
  }

  if (!partial) {
    for (const field of ["name", "category", "department", "role", "salary"]) {
      if (value[field] === undefined || value[field] === "") {
        return { error: `${field} is required.` };
      }
    }
  }
  if (value.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) {
    return { error: "Enter a valid employee email address." };
  }
  return { value };
}

function serializeEmployee(employee, limited = false) {
  const value = employee?.toObject ? employee.toObject() : { ...employee };
  if (!value) return null;
  value.id = String(value._id || value.id);
  delete value._id;
  delete value.__v;
  delete value.migrationKey;
  value.image = {
    url: typeof value.image?.url === "string" ? value.image.url : "",
    publicId: typeof value.image?.publicId === "string" ? value.image.publicId : "",
  };
  value.documents = (value.documents || []).map((document) => {
    const id = String(document._id || document.id);
    const downloadUrl = `/api/employees/${value.id}/documents/${id}/download`;
    return {
      id,
      title: document.title,
      url: downloadUrl,
      download_Url: downloadUrl,
      fileName: document.fileName,
      uploadedAt: document.uploadedAt,
    };
  });
  if (limited) {
    for (const field of MANAGER_HIDDEN_FIELDS) delete value[field];
    delete value.createdBy;
    delete value.updatedBy;
    delete value.deactivatedBy;
  }
  return value;
}

function validObjectId(value) {
  return mongoose.isValidObjectId(value);
}

async function listEmployees(request, response) {
  const filter = {};
  if (request.query.status && ["Active", "Inactive"].includes(request.query.status)) {
    filter.status = request.query.status;
  }
  if (request.query.department) filter.department = String(request.query.department).slice(0, 100);
  if (request.query.category && ENUMS.category.includes(request.query.category)) {
    filter.category = request.query.category;
  }
  if (request.query.frequency && ["Monthly", "Weekly"].includes(request.query.frequency)) {
    filter.paymentFrequency = request.query.frequency;
  }
  const search = typeof request.query.q === "string" ? request.query.q.trim().slice(0, 120) : "";
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { name: { $regex: escaped, $options: "i" } },
      { number: { $regex: escaped, $options: "i" } },
      { department: { $regex: escaped, $options: "i" } },
      { role: { $regex: escaped, $options: "i" } },
      { category: { $regex: escaped, $options: "i" } },
    ];
  }
  const employees = await Employee.find(filter).sort({ name: 1, _id: 1 }).limit(500);
  return response.json({
    employees: employees.map((employee) => serializeEmployee(employee, isGeneralManager(request))),
    limited: isGeneralManager(request),
  });
}

async function getEmployee(request, response) {
  if (!validObjectId(request.params.id)) return response.status(400).json({ error: "Invalid employee ID." });
  const employee = await Employee.findById(request.params.id);
  if (!employee) return response.status(404).json({ error: "Employee not found." });
  return response.json({
    employee: serializeEmployee(employee, isGeneralManager(request)),
    limited: isGeneralManager(request),
  });
}

async function validateEmployeeUserLinks(value, employeeId) {
  const User = require("../models/user");
  for (const field of ["userId", "supervisorUserId"]) {
    if (!(field in value) || value[field] === null) continue;
    const user = await User.findById(value[field]).select("_id status");
    if (!user || user.status !== "Active") {
      return `${field} must reference an active user account.`;
    }
    if (field === "userId") {
      const filter = { userId: value[field] };
      if (employeeId) filter._id = { $ne: employeeId };
      const existing = await Employee.findOne(filter).select("_id");
      if (existing) return "A login account can be linked to only one employee profile.";
    }
  }
  return "";
}

async function createEmployee(request, response) {
  const { value, error } = validateEmployeeInput(request.body);
  if (error) return response.status(400).json({ error });
  const linkedUserError = await validateEmployeeUserLinks(value);
  if (linkedUserError) return response.status(400).json({ error: linkedUserError });
  const employeeNumber = `EMP-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
  const employee = new Employee({
    ...value,
    number: employeeNumber,
    createdBy: request.authUser._id,
    updatedBy: request.authUser._id,
  });
  await employee.save();
  await audit.recordAudit({
    request,
    eventType: "employee.created",
    outcome: "success",
    details: { employeeId: String(employee._id), employeeNumber },
  });
  return response.status(201).json({ employee: serializeEmployee(employee) });
}

async function updateEmployee(request, response) {
  if (!validObjectId(request.params.id)) return response.status(400).json({ error: "Invalid employee ID." });
  const { value, error } = validateEmployeeInput(request.body, { partial: true });
  if (error) return response.status(400).json({ error });
  const linkedUserError = await validateEmployeeUserLinks(value, request.params.id);
  if (linkedUserError) return response.status(400).json({ error: linkedUserError });
  if (!Object.keys(value).length) return response.status(400).json({ error: "Provide at least one employee field to update." });
  const employee = await Employee.findById(request.params.id);
  if (!employee) return response.status(404).json({ error: "Employee not found." });
  Object.assign(employee, value, { updatedBy: request.authUser._id });
  if (value.status === "Inactive") {
    employee.deactivatedAt = employee.deactivatedAt || new Date();
    employee.deactivatedBy = employee.deactivatedBy || request.authUser._id;
  } else if (value.status === "Active") {
    employee.deactivatedAt = null;
    employee.deactivatedBy = null;
  }
  await employee.save();
  const deactivated = value.status === "Inactive";
  await audit.recordAudit({
    request,
    eventType: deactivated ? "employee.deactivated" : "employee.updated",
    outcome: "success",
    details: { employeeId: String(employee._id), changedFields: Object.keys(value) },
  });
  return response.json({ employee: serializeEmployee(employee) });
}

async function deactivateEmployee(request, response) {
  if (!validObjectId(request.params.id)) return response.status(400).json({ error: "Invalid employee ID." });
  const employee = await Employee.findById(request.params.id);
  if (!employee) return response.status(404).json({ error: "Employee not found." });
  if (employee.status !== "Inactive") {
    employee.status = "Inactive";
    employee.deactivatedAt = new Date();
    employee.deactivatedBy = request.authUser._id;
    employee.updatedBy = request.authUser._id;
    await employee.save();
    await audit.recordAudit({
      request,
      eventType: "employee.deactivated",
      outcome: "success",
      details: { employeeId: String(employee._id) },
    });
  }
  return response.json({ employee: serializeEmployee(employee) });
}

function detectImageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function detectPdf(buffer) {
  return buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-";
}

async function uploadEmployeeImage(request, response) {
  if (!validObjectId(request.params.id)) return response.status(400).json({ error: "Invalid employee ID." });
  const employee = await Employee.findById(request.params.id);
  if (!employee) return response.status(404).json({ error: "Employee not found." });
  const file = request.file;
  if (!file) return response.status(400).json({ error: "Choose a PNG, JPEG, or WebP profile image." });
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.mimetype) || detectImageType(file.buffer) !== file.mimetype) {
    return response.status(400).json({ error: "The uploaded profile image is not a valid PNG, JPEG, or WebP image." });
  }
  const newImage = await uploadImage(file.buffer, {
    folder: "anli/employee-images",
    publicId: `employee-${employee._id}-${randomUUID()}`,
    transformation: [{ width: 800, height: 800, crop: "limit", quality: "auto", fetch_format: "auto" }],
  });
  const previousPublicId = employee.image?.publicId;
  employee.image = newImage;
  employee.updatedBy = request.authUser._id;
  try {
    await employee.save();
  } catch (error) {
    try {
      await deleteAsset(newImage.publicId, "image", "upload");
    } catch (cleanupError) {
      console.error("Unable to clean up an unreferenced employee image:", cleanupError);
    }
    throw error;
  }
  if (previousPublicId && previousPublicId !== newImage.publicId) {
    try {
      await deleteAsset(previousPublicId, "image", "upload");
    } catch (error) {
      console.error("Unable to remove the replaced employee image from Cloudinary:", error);
    }
  }
  await audit.recordAudit({
    request,
    eventType: "employee.image_uploaded",
    outcome: "success",
    details: { employeeId: String(employee._id), replaced: Boolean(previousPublicId) },
  });
  return response.json({ image: employee.image });
}

async function removeEmployeeImage(request, response) {
  if (!validObjectId(request.params.id)) return response.status(400).json({ error: "Invalid employee ID." });
  const employee = await Employee.findById(request.params.id);
  if (!employee) return response.status(404).json({ error: "Employee not found." });
  const previousPublicId = employee.image?.publicId;
  if (!previousPublicId) return response.json({ image: { url: "", publicId: "" } });
  employee.image = { url: "", publicId: "" };
  employee.updatedBy = request.authUser._id;
  await employee.save();
  try {
    await deleteAsset(previousPublicId, "image", "upload");
  } catch (error) {
    console.error("Unable to remove the deleted employee image from Cloudinary:", error);
  }
  await audit.recordAudit({
    request,
    eventType: "employee.image_removed",
    outcome: "success",
    details: { employeeId: String(employee._id) },
  });
  return response.json({ image: employee.image });
}

async function uploadEmployeeDocument(request, response) {
  if (!validObjectId(request.params.id)) return response.status(400).json({ error: "Invalid employee ID." });
  const employee = await Employee.findById(request.params.id);
  if (!employee) return response.status(404).json({ error: "Employee not found." });
  const file = request.file;
  const title = typeof request.body?.title === "string" ? request.body.title.trim() : "";
  if (!file) return response.status(400).json({ error: "Choose a PDF document." });
  if (!title || title.length > 80) return response.status(400).json({ error: "Enter a document title of 1 to 80 characters." });
  if (file.mimetype !== "application/pdf" || !detectPdf(file.buffer)) {
    return response.status(400).json({ error: "The uploaded document is not a valid PDF." });
  }
  const asset = await uploadPdf(file.buffer, {
    folder: `anli/employee-documents/${employee._id}`,
    publicId: `document-${randomUUID()}`,
  });
  const document = {
    title,
    url: asset.url,
    publicId: asset.publicId,
    resourceType: "raw",
    fileName: String(file.originalname || "document.pdf").replace(/[^\w .()-]/g, "_").slice(0, 180),
    uploadedBy: request.authUser._id,
  };
  employee.documents.push(document);
  employee.updatedBy = request.authUser._id;
  try {
    await employee.save();
  } catch (error) {
    try {
      await deleteAsset(asset.publicId, "raw", "authenticated");
    } catch (cleanupError) {
      console.error("Unable to clean up an unreferenced employee document:", cleanupError);
    }
    throw error;
  }
  const savedDocument = employee.documents[employee.documents.length - 1];
  await audit.recordAudit({
    request,
    eventType: "employee.document_uploaded",
    outcome: "success",
    details: { employeeId: String(employee._id), documentId: String(savedDocument._id) },
  });
  return response.status(201).json({
    document: serializeEmployee(employee).documents.at(-1),
  });
}

async function removeEmployeeDocument(request, response) {
  if (!validObjectId(request.params.id)) return response.status(400).json({ error: "Invalid employee ID." });
  const employee = await Employee.findById(request.params.id);
  if (!employee) return response.status(404).json({ error: "Employee not found." });
  const document = employee.documents.id(request.params.documentId);
  if (!document) return response.status(404).json({ error: "Employee document not found." });
  const { publicId, resourceType } = document;
  document.deleteOne();
  employee.updatedBy = request.authUser._id;
  await employee.save();
  try {
    await deleteAsset(publicId, resourceType || "raw", "authenticated");
  } catch (error) {
    console.error("Unable to remove the deleted employee document from Cloudinary:", error);
  }
  await audit.recordAudit({
    request,
    eventType: "employee.document_removed",
    outcome: "success",
    details: { employeeId: String(employee._id), documentId: request.params.documentId },
  });
  return response.json({ removed: true });
}

async function getEmployeeDocumentDownload(request, response) {
  if (!validObjectId(request.params.id)) return response.status(400).json({ error: "Invalid employee ID." });
  const employee = await Employee.findById(request.params.id);
  if (!employee) return response.status(404).json({ error: "Employee not found." });
  const document = employee.documents.id(request.params.documentId);
  if (!document) return response.status(404).json({ error: "Employee document not found." });
  const url = cloudinary.utils.private_download_url(document.publicId, "pdf", {
    resource_type: "raw",
    type: "authenticated",
    attachment: document.fileName,
    expires_at: Math.floor(Date.now() / 1000) + 120,
  });
  return response.json({ url, expiresInSeconds: 120 });
}

function validateDraft(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Provide draft data as an object." };
  }
  const { employee, currentStep } = body;
  if (Object.keys(body).some((key) => !["employee", "currentStep"].includes(key))) {
    return { error: "Draft contains unsupported fields." };
  }
  if (!Number.isInteger(currentStep) || currentStep < 0 || currentStep > 5) {
    return { error: "currentStep must be between 0 and 5." };
  }
  const result = validateEmployeeInput(employee, { partial: true });
  if (result.error) return result;
  return { value: { employee: result.value, currentStep } };
}

async function listDrafts(request, response) {
  const drafts = await EmployeeDraft.find({ ownerId: request.authUser._id }).sort({ updatedAt: -1 });
  return response.json({
    drafts: drafts.map((draft) => ({
      id: draft._id,
      employee: draft.employee,
      currentStep: draft.currentStep,
      updatedAt: draft.updatedAt,
    })),
  });
}

async function saveDraft(request, response) {
  const id = String(request.params.draftId || "");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return response.status(400).json({ error: "Invalid draft ID." });
  const { value, error } = validateDraft(request.body);
  if (error) return response.status(400).json({ error });
  const existing = await EmployeeDraft.findById(id);
  if (existing && String(existing.ownerId) !== String(request.authUser._id)) {
    return response.status(404).json({ error: "Employee draft not found." });
  }
  const draft = await EmployeeDraft.findOneAndUpdate(
    { _id: id, ownerId: request.authUser._id },
    { $set: { ...value, ownerId: request.authUser._id } },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
  );
  return response.json({
    draft: { id: draft._id, employee: draft.employee, currentStep: draft.currentStep, updatedAt: draft.updatedAt },
  });
}

async function deleteDraft(request, response) {
  const id = String(request.params.draftId || "");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return response.status(400).json({ error: "Invalid draft ID." });
  const result = await EmployeeDraft.deleteOne({ _id: id, ownerId: request.authUser._id });
  if (!result.deletedCount) return response.status(404).json({ error: "Employee draft not found." });
  return response.json({ removed: true });
}

async function importEmployees(request, response) {
  const items = request.body?.employees;
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
    return response.status(400).json({ error: "Provide between 1 and 100 employee records to import." });
  }
  const results = [];
  let imported = 0;
  let alreadyImported = 0;
  let failed = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const migrationKey = typeof item?.migrationKey === "string" ? item.migrationKey.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(migrationKey) || !item?.employee || typeof item.employee !== "object") {
      failed += 1;
      results.push({ index, status: "failed", error: "A valid migration key and employee object are required." });
      continue;
    }
    const prior = await Employee.findOne({ migrationKey }).select("+migrationKey");
    if (prior) {
      alreadyImported += 1;
      results.push({ index, migrationKey, status: "already_imported", employeeId: String(prior._id) });
      continue;
    }
    const { value, error } = validateEmployeeInput(item.employee, { allowNumber: true });
    if (error) {
      failed += 1;
      results.push({ index, migrationKey, status: "failed", error });
      continue;
    }
    const employee = new Employee({
      ...value,
      number: value.number || `EMP-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`,
      migrationKey,
      createdBy: request.authUser._id,
      updatedBy: request.authUser._id,
    });
    try {
      await employee.save();
      imported += 1;
      results.push({ index, migrationKey, status: "imported", employeeId: String(employee._id) });
    } catch (error) {
      if (error?.code === 11000) {
        const duplicate = await Employee.findOne({ migrationKey }).select("+migrationKey");
        if (duplicate) {
          alreadyImported += 1;
          results.push({ index, migrationKey, status: "already_imported", employeeId: String(duplicate._id) });
          continue;
        }
        failed += 1;
        results.push({ index, migrationKey, status: "failed", error: "An employee with this employee number already exists." });
        continue;
      }
      throw error;
    }
  }
  await audit.recordAudit({
    request,
    eventType: "employee.imported",
    outcome: "success",
    details: { imported, alreadyImported, failed },
  });
  return response.status(failed ? 207 : 200).json({ imported, alreadyImported, failed, results });
}

module.exports = {
  createEmployee,
  deactivateEmployee,
  deleteDraft,
  detectImageType,
  detectPdf,
  getEmployee,
  getEmployeeDocumentDownload,
  importEmployees,
  isGeneralManager,
  listDrafts,
  listEmployees,
  removeEmployeeDocument,
  removeEmployeeImage,
  saveDraft,
  serializeEmployee,
  updateEmployee,
  uploadEmployeeDocument,
  uploadEmployeeImage,
  validateDraft,
  validateEmployeeInput,
};
