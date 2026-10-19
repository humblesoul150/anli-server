const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PassThrough } = require("node:stream");
const Employee = require("../models/employee");
const cloudinaryConfig = require("../configs/cloudinary");
const audit = require("../lib/audit");
const { uploadPdf } = cloudinaryConfig;
const {
  detectImageType,
  detectPdf,
  isGeneralManager,
  removeEmployeeDocument,
  removeEmployeeImage,
  serializeEmployee,
  uploadEmployeeImage,
  validateDraft,
  validateEmployeeInput,
} = require("../controllers/employeeController");

test("employee schema keeps HR data separate from account credentials and stores image metadata", () => {
  const employee = new Employee({
    number: "EMP-TEST-1",
    name: "Example Employee",
    category: "Staff employee",
    department: "HR",
    role: "Officer",
    salary: 2500000,
    createdBy: "507f1f77bcf86cd799439011",
    updatedBy: "507f1f77bcf86cd799439011",
    image: { url: "https://cdn.example/profile.png", publicId: "employee/profile" },
  });
  assert.equal(employee.image.url, "https://cdn.example/profile.png");
  assert.equal(employee.image.publicId, "employee/profile");
  assert.equal(employee.userId, undefined);
  assert.equal(employee.password, undefined);
  assert.equal(employee.documents.length, 0);
  assert.equal(Employee.schema.path("number").options.immutable, true);
});

test("employee create/update validation accepts bounded profile data and rejects arbitrary metadata", () => {
  const result = validateEmployeeInput({
    name: " Jane Doe ",
    category: "Staff employee",
    department: "HR",
    role: "Officer",
    salary: 2500000,
    email: " JANE@EXAMPLE.COM ",
    mother: { name: "Parent", status: "Alive" },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.value.name, "Jane Doe");
  assert.equal(result.value.email, "jane@example.com");
  assert.equal(result.value.mother.status, "Alive");
  assert.match(validateEmployeeInput({
    name: "Jane",
    category: "Staff employee",
    department: "HR",
    role: "Officer",
    salary: -1,
  }).error, /non-negative/);
  assert.match(validateEmployeeInput({
    name: "Jane",
    category: "Staff employee",
    department: "HR",
    role: "Officer",
    salary: 1,
    image: { publicId: "attacker/asset" },
  }).error, /Unsupported employee field/);
  assert.match(validateEmployeeInput({ email: "invalid" }, { partial: true }).error, /valid employee email/);
});

test("general manager projection omits sensitive fields and document identifiers", () => {
  const result = serializeEmployee({
    _id: "507f1f77bcf86cd799439011",
    number: "EMP-1",
    name: "Jane Doe",
    salary: 2500000,
    nssfNumber: "private",
    mother: { name: "Parent" },
    documents: [{ _id: "doc-id", title: "CV", publicId: "secret/id", fileName: "cv.pdf" }],
    image: { url: "https://cdn.example/image.png", publicId: "public/image" },
  }, true);
  assert.equal(result.id, "507f1f77bcf86cd799439011");
  assert.equal(result.salary, undefined);
  assert.equal(result.nssfNumber, undefined);
  assert.equal(result.mother, undefined);
  assert.equal(result.documents, undefined);
  assert.equal(result.image.url, "https://cdn.example/image.png");
});

test("only a General Manager without HR/Admin privileges receives the limited projection", () => {
  assert.equal(isGeneralManager({ authUser: { roles: ["General Manager"] } }), true);
  assert.equal(isGeneralManager({ authUser: { roles: ["General Manager", "Human Resource"] } }), false);
  assert.equal(isGeneralManager({ authUser: { roles: ["Admin"] } }), false);
});

test("employee document and image content is signature validated", () => {
  assert.equal(detectImageType(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "image/png");
  assert.equal(detectImageType(Buffer.from("<svg></svg>")), null);
  assert.equal(detectPdf(Buffer.from("%PDF-1.7 document")), true);
  assert.equal(detectPdf(Buffer.from("not a pdf")), false);
});

test("employee onboarding drafts validate step and profile field allowlists", () => {
  assert.equal(validateDraft({ currentStep: 3, employee: { name: "Jane" } }).error, undefined);
  assert.match(validateDraft({ currentStep: 9, employee: {} }).error, /between 0 and 5/);
  assert.match(validateDraft({ currentStep: 0, employee: { image: { url: "bad" } } }).error, /Unsupported employee field/);
});

test("employee image replacement stores the new image and removes the previous Cloudinary asset", async () => {
  const originalFindById = Employee.findById;
  const originalUploadStream = cloudinaryConfig.cloudinary.uploader.upload_stream;
  const originalDestroy = cloudinaryConfig.cloudinary.uploader.destroy;
  const originalAudit = audit.recordAudit;
  const deleted = [];
  const employee = {
    _id: "507f1f77bcf86cd799439011",
    image: { url: "https://cdn.example/old.png", publicId: "employee/old" },
    async save() {},
  };
  Employee.findById = async () => employee;
  cloudinaryConfig.cloudinary.uploader.upload_stream = (_options, callback) => {
    const stream = new PassThrough();
    stream.on("finish", () => callback(null, {
      secure_url: "https://cdn.example/new.png",
      public_id: "employee/new",
    }));
    return stream;
  };
  cloudinaryConfig.cloudinary.uploader.destroy = async (publicId, options) => {
    deleted.push({ publicId, options });
    return { result: "ok" };
  };
  audit.recordAudit = async () => {};
  try {
    const response = {
      status() { return this; },
      json(body) { this.body = body; return this; },
    };
    await uploadEmployeeImage({
      params: { id: employee._id },
      file: { mimetype: "image/png", buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) },
      authUser: { _id: "507f1f77bcf86cd799439012" },
    }, response);
    assert.equal(employee.image.publicId, "employee/new");
    assert.deepEqual(deleted, [{ publicId: "employee/old", options: { resource_type: "image", type: "upload" } }]);
  } finally {
    Employee.findById = originalFindById;
    cloudinaryConfig.cloudinary.uploader.upload_stream = originalUploadStream;
    cloudinaryConfig.cloudinary.uploader.destroy = originalDestroy;
    audit.recordAudit = originalAudit;
  }
});

test("employee media deletion removes database references and Cloudinary assets", async () => {
  const originalFindById = Employee.findById;
  const originalDestroy = cloudinaryConfig.cloudinary.uploader.destroy;
  const originalAudit = audit.recordAudit;
  const deleted = [];
  const document = {
    _id: "507f1f77bcf86cd799439013",
    publicId: "employee/docs/cv",
    resourceType: "raw",
    deleteOne() { this.deleted = true; },
  };
  const employee = {
    _id: "507f1f77bcf86cd799439011",
    image: { url: "https://cdn.example/photo.png", publicId: "employee/photo" },
    documents: { id: (id) => id === String(document._id) ? document : null },
    async save() {},
  };
  Employee.findById = async () => employee;
  cloudinaryConfig.cloudinary.uploader.destroy = async (publicId, options) => {
    deleted.push({ publicId, options });
    return { result: "ok" };
  };
  audit.recordAudit = async () => {};
  try {
    const response = {
      status() { return this; },
      json(body) { this.body = body; return this; },
    };
    await removeEmployeeImage({
      params: { id: employee._id },
      authUser: { _id: "507f1f77bcf86cd799439012" },
    }, response);
    await removeEmployeeDocument({
      params: { id: employee._id, documentId: String(document._id) },
      authUser: { _id: "507f1f77bcf86cd799439012" },
    }, response);
    assert.deepEqual(deleted, [
      { publicId: "employee/photo", options: { resource_type: "image", type: "upload" } },
      { publicId: "employee/docs/cv", options: { resource_type: "raw", type: "authenticated" } },
    ]);
    assert.equal(document.deleted, true);
    assert.equal(employee.image.publicId, "");
  } finally {
    Employee.findById = originalFindById;
    cloudinaryConfig.cloudinary.uploader.destroy = originalDestroy;
    audit.recordAudit = originalAudit;
  }
});

test("failed employee persistence cleans up the new Cloudinary image", async () => {
  const originalFindById = Employee.findById;
  const originalUploadStream = cloudinaryConfig.cloudinary.uploader.upload_stream;
  const originalDestroy = cloudinaryConfig.cloudinary.uploader.destroy;
  const deleted = [];
  Employee.findById = async () => ({
    _id: "507f1f77bcf86cd799439011",
    image: { url: "", publicId: "" },
    async save() { throw new Error("database unavailable"); },
  });

  cloudinaryConfig.cloudinary.uploader.upload_stream = (_options, callback) => {
    const stream = new PassThrough();
    stream.on("finish", () => callback(null, {
      secure_url: "https://cdn.example/new.png",
      public_id: "employee/orphan",
    }));
    return stream;
  };
  cloudinaryConfig.cloudinary.uploader.destroy = async (publicId) => {
    deleted.push(publicId);
    return { result: "ok" };
  };
  try {
    await assert.rejects(uploadEmployeeImage({
      params: { id: "507f1f77bcf86cd799439011" },
      file: { mimetype: "image/png", buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) },
      authUser: { _id: "507f1f77bcf86cd799439012" },
    }, {}), /database unavailable/);
    assert.deepEqual(deleted, ["employee/orphan"]);
  } finally {
    Employee.findById = originalFindById;
    cloudinaryConfig.cloudinary.uploader.upload_stream = originalUploadStream;
    cloudinaryConfig.cloudinary.uploader.destroy = originalDestroy;
  }
});

test("PDF helper uploads authenticated raw assets", async () => {
  const originalUploadStream = cloudinaryConfig.cloudinary.uploader.upload_stream;
  let options;
  cloudinaryConfig.cloudinary.uploader.upload_stream = (uploadOptions, callback) => {
    options = uploadOptions;
    const stream = new PassThrough();
    stream.on("finish", () => callback(null, {
      secure_url: "https://res.cloudinary.com/example/raw/authenticated/doc.pdf",
      public_id: "anli/employee-documents/doc",
    }));
    return stream;
  };
  try {
    const result = await uploadPdf(Buffer.from("%PDF-1.7"), {
      folder: "anli/employee-documents/employee-id",
      publicId: "document-id",
    });
    assert.equal(result.publicId, "anli/employee-documents/doc");
    assert.equal(options.resource_type, "raw");
    assert.equal(options.type, "authenticated");
    assert.equal(options.folder, "anli/employee-documents/employee-id");
  } finally {
    cloudinaryConfig.cloudinary.uploader.upload_stream = originalUploadStream;
  }
});
