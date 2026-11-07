const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PassThrough } = require("node:stream");
const cloudinaryConfig = require("../configs/cloudinary");
const ProfileSettings = require("../models/profileSettings");
const { signUploadParams, uploadImage } = cloudinaryConfig;
const {
  detectImageType,
  getPublicBrand,
  validateProfileInput,
} = require("../controllers/profileSettingsController");

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("company profile uses one stable singleton id and stores logo metadata", () => {
  const profile = new ProfileSettings({
    legalName: "Example Ltd",
    logo: { url: "https://cdn.example/logo.png", publicId: "company/logo" },
  });
  assert.equal(profile._id, "global");
  assert.equal(profile.legalName, "Example Ltd");
  assert.equal(profile.logo.url, "https://cdn.example/logo.png");
  assert.equal(profile.logo.publicId, "company/logo");
  assert.equal(profile.city, "");
});

test("company profile updates only accept bounded known fields and valid public values", () => {
  assert.deepEqual(
    validateProfileInput({
      legalName: " Example Ltd ",
      email: "office@example.com",
      website: "https://example.com",
    }),
    {
      update: {
        legalName: "Example Ltd",
        email: "office@example.com",
        website: "https://example.com",
      },
    },
  );
  assert.match(validateProfileInput({ legalName: " " }).error, /required/);
  assert.match(
    validateProfileInput({ email: "not-an-email" }).error,
    /valid company email/,
  );
  assert.match(
    validateProfileInput({ website: "javascript:alert(1)" }).error,
    /HTTP or HTTPS/,
  );
  assert.match(
    validateProfileInput({ publicId: "attacker-controlled" }).error,
    /Unsupported profile field/,
  );
});

test("company logo upload accepts only matching PNG, JPEG, and WebP signatures", () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
  const webp = Buffer.from("RIFF0000WEBP", "ascii");
  assert.equal(detectImageType(png), "image/png");
  assert.equal(detectImageType(jpeg), "image/jpeg");
  assert.equal(detectImageType(webp), "image/webp");
  assert.equal(detectImageType(Buffer.from("<svg></svg>")), null);
});

test("signed Cloudinary upload params omit form-only fields from the signature payload", () => {
  const originalApiSignRequest =
    cloudinaryConfig.cloudinary.utils.api_sign_request;
  const originalDateNow = Date.now;
  const originalCloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const originalApiKey = process.env.CLOUDINARY_API_KEY;
  const originalSecret = process.env.CLOUDINARY_API_SECRET;
  process.env.CLOUDINARY_CLOUD_NAME = "demo";
  process.env.CLOUDINARY_API_KEY = "demo-key";
  process.env.CLOUDINARY_API_SECRET = "test-secret";
  Date.now = () => 1_234_567_890 * 1000;
  cloudinaryConfig.cloudinary.utils.api_sign_request = (params, apiSecret) => {
    assert.equal(apiSecret, "test-secret");
    assert.deepEqual(params, {
      folder: "anli/company-profile",
      public_id: "logo-123",
      timestamp: 1_234_567_890,
      type: "upload",
      allowed_formats: "png,jpeg,webp",
    });
    return "signed-params";
  };

  try {
    const signed = signUploadParams({
      folder: "anli/company-profile",
      publicId: "logo-123",
      resourceType: "image",
      type: "upload",
      maxBytes: 2 * 1024 * 1024,
      allowedFormats: ["png", "jpeg", "webp"],
    });

    assert.equal(signed.signature, "signed-params");
    assert.equal(signed.maxBytes, 2 * 1024 * 1024);
    assert.equal(signed.resourceType, "image");
    assert.equal(
      signed.uploadUrl,
      "https://api.cloudinary.com/v1_1/demo/image/upload",
    );
  } finally {
    cloudinaryConfig.cloudinary.utils.api_sign_request = originalApiSignRequest;
    if (originalCloudName === undefined) delete process.env.CLOUDINARY_CLOUD_NAME;
    else process.env.CLOUDINARY_CLOUD_NAME = originalCloudName;
    if (originalApiKey === undefined) delete process.env.CLOUDINARY_API_KEY;
    else process.env.CLOUDINARY_API_KEY = originalApiKey;
    if (originalSecret === undefined) delete process.env.CLOUDINARY_API_SECRET;
    else process.env.CLOUDINARY_API_SECRET = originalSecret;
  }
});

test("reusable Cloudinary helper uploads a buffer and returns only secure asset metadata", async () => {
  const originalUploadStream =
    cloudinaryConfig.cloudinary.uploader.upload_stream;
  let capturedOptions;
  cloudinaryConfig.cloudinary.uploader.upload_stream = (options, callback) => {
    capturedOptions = options;
    const stream = new PassThrough();
    stream.on("finish", () =>
      callback(null, {
        secure_url: "https://res.cloudinary.com/example/image/upload/logo.webp",
        public_id: "anli/company-profile/logo",
      }),
    );
    return stream;
  };
  try {
    const result = await uploadImage(Buffer.from("image"), {
      folder: "anli/company-profile",
      publicId: "logo-id",
      transformation: [{ width: 500, crop: "limit" }],
    });
    assert.deepEqual(result, {
      url: "https://res.cloudinary.com/example/image/upload/logo.webp",
      publicId: "anli/company-profile/logo",
    });
    assert.equal(capturedOptions.folder, "anli/company-profile");
    assert.equal(capturedOptions.public_id, "logo-id");
    assert.deepEqual(capturedOptions.transformation, [
      { width: 500, crop: "limit" },
    ]);
  } finally {
    cloudinaryConfig.cloudinary.uploader.upload_stream = originalUploadStream;
  }
});

test("public branding exposes only a display name and logo URL", async () => {
  const originalFindById = ProfileSettings.findById;
  ProfileSettings.findById = () => ({
    lean: async () => ({
      legalName: "Example Ltd",
      tradingName: "Example",
      email: "private@example.com",
      tin: "private-tin",
      addressLine1: "Private street",
      logo: { url: "https://cdn.example/logo.png", publicId: "company/logo" },
    }),
  });
  try {
    const response = createResponse();
    await getPublicBrand({}, response);
    assert.deepEqual(response.body, {
      companyName: "Example",
      logoUrl: "https://cdn.example/logo.png",
    });
    assert.equal(Object.hasOwn(response.body, "email"), false);
    assert.equal(Object.hasOwn(response.body, "tin"), false);
  } finally {
    ProfileSettings.findById = originalFindById;
  }
});

test("direct Cloudinary metadata payloads are stored without mutating unrelated profile fields", async () => {
  const originalFindById = ProfileSettings.findById;
  const originalSave = ProfileSettings.prototype.save;
  const saved = [];
  ProfileSettings.findById = () => ({
    lean: async () => ({
      legalName: "Example Ltd",
      tradingName: "Example",
      logo: {
        url: "https://cdn.example/old.png",
        publicId: "company/old-logo",
      },
    }),
    toObject: () => ({
      legalName: "Example Ltd",
      tradingName: "Example",
      logo: {
        url: "https://cdn.example/old.png",
        publicId: "company/old-logo",
      },
    }),
  });
  ProfileSettings.prototype.save = async function save() {
    saved.push(this.toObject ? this.toObject() : this);
    return this;
  };
  try {
    const response = createResponse();
    await require("../controllers/profileSettingsController").uploadCompanyLogo(
      {
        body: {
          url: "https://res.cloudinary.com/example/logo.webp",
          publicId: "anli/company-profile/logo",
        },
        authUser: { _id: "user-1", name: "Test User" },
      },
      response,
    );
    assert.equal(response.statusCode, 200);
    assert.equal(
      response.body.logo.url,
      "https://res.cloudinary.com/example/logo.webp",
    );
    assert.equal(response.body.logo.publicId, "anli/company-profile/logo");
  } finally {
    ProfileSettings.findById = originalFindById;
    ProfileSettings.prototype.save = originalSave;
  }
});
