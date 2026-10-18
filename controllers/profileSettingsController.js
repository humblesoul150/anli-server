const mongoose = require("mongoose");
const { randomUUID } = require("node:crypto");
const ProfileSettings = require("../models/profileSettings");
const { uploadImage, deleteImage } = require("../configs/cloudinary");
const audit = require("../lib/audit");

const PROFILE_ID = "global";
const PROFILE_FIELDS = [
  "legalName",
  "tradingName",
  "email",
  "phone",
  "website",
  "addressLine1",
  "addressLine2",
  "city",
  "region",
  "postalCode",
  "country",
  "tin",
  "registrationNumber",
  "registrationAuthority",
];
const FIELD_LIMITS = {
  legalName: 160,
  tradingName: 160,
  email: 254,
  phone: 40,
  website: 200,
  addressLine1: 160,
  addressLine2: 160,
  city: 100,
  region: 100,
  postalCode: 30,
  country: 100,
  tin: 60,
  registrationNumber: 80,
  registrationAuthority: 120,
};
const EMPTY_PROFILE = {
  ...Object.fromEntries(PROFILE_FIELDS.map((field) => [field, ""])),
  logo: { url: "", publicId: "" },
};

async function saveWithAudit(request, details, save) {
  const transaction = await mongoose.startSession();
  let result;
  try {
    await transaction.withTransaction(async () => {
      result = await save(transaction);
      if (result === null || result === undefined) return;
      await audit.recordAudit({
        request,
        eventType: "company.profile_updated",
        outcome: "success",
        details,
        transaction,
      });
    });
  } finally {
    await transaction.endSession();
  }
  return result;
}

function serializeProfile(profile) {
  if (!profile) return { ...EMPTY_PROFILE, logo: { ...EMPTY_PROFILE.logo } };
  return {
    ...Object.fromEntries(PROFILE_FIELDS.map((field) => [
      field,
      typeof profile[field] === "string" ? profile[field] : "",
    ])),
    logo: {
      url: typeof profile.logo?.url === "string" ? profile.logo.url : "",
      publicId: typeof profile.logo?.publicId === "string" ? profile.logo.publicId : "",
    },
  };
}

function validateProfileInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Provide the company profile as a JSON object." };
  }
  const unknown = Object.keys(body).filter((key) => !PROFILE_FIELDS.includes(key));
  if (unknown.length) return { error: `Unsupported profile field: ${unknown[0]}.` };

  const update = {};
  for (const [field, value] of Object.entries(body)) {
    if (typeof value !== "string") return { error: `${field} must be text.` };
    const trimmed = value.trim();
    if (trimmed.length > FIELD_LIMITS[field]) {
      return { error: `${field} must be ${FIELD_LIMITS[field]} characters or fewer.` };
    }
    update[field] = trimmed;
  }
  if (Object.prototype.hasOwnProperty.call(update, "legalName") && !update.legalName) {
    return { error: "Company legal name is required." };
  }
  if (update.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(update.email)) {
    return { error: "Enter a valid company email address." };
  }
  if (update.website) {
    try {
      const website = new URL(update.website);
      if (!["http:", "https:"].includes(website.protocol)) throw new Error("invalid");
    } catch {
      return { error: "Website must be a valid HTTP or HTTPS URL." };
    }
  }
  return { update };
}

async function readProfile() {
  const profile = await ProfileSettings.findById(PROFILE_ID).lean();
  return serializeProfile(profile);
}

async function getProfile(_request, response) {
  return response.json({ profile: await readProfile() });
}

async function getPublicBrand(_request, response) {
  const profile = await readProfile();
  return response.json({
    companyName: profile.tradingName || profile.legalName || "Lumina ERP",
    logoUrl: profile.logo.url || "",
  });
}

async function updateProfile(request, response) {
  const { update, error } = validateProfileInput(request.body);
  if (error) return response.status(400).json({ error });
  if (!Object.keys(update).length) {
    return response.status(400).json({ error: "Provide at least one profile field to update." });
  }
  if (!update.legalName) {
    const current = await ProfileSettings.findById(PROFILE_ID).lean();
    if (!current?.legalName) {
      return response.status(400).json({ error: "Company legal name is required." });
    }
  }

  const profile = await saveWithAudit(
    request,
    { changedFields: Object.keys(update), logoChanged: false },
    (transaction) => ProfileSettings.findByIdAndUpdate(
      PROFILE_ID,
      { $set: update },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
        runValidators: true,
        session: transaction,
      },
    ),
  );
  return response.json({ profile: serializeProfile(profile.toObject()) });
}

function detectImageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

async function uploadCompanyLogo(request, response) {
  const file = request.file;
  if (!file) return response.status(400).json({ error: "Choose a PNG, JPEG, or WebP logo image." });
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.mimetype) || detectImageType(file.buffer) !== file.mimetype) {
    return response.status(400).json({ error: "The uploaded file is not a valid PNG, JPEG, or WebP image." });
  }

  const newLogo = await uploadImage(file.buffer, {
    folder: "anli/company-profile",
    publicId: `logo-${randomUUID()}`,
    transformation: [{ width: 500, height: 500, crop: "limit", quality: "auto", fetch_format: "auto" }],
  });
  let replacedPublicId;
  let profile;
  try {
    profile = await saveWithAudit(
      request,
      { changedFields: [], logoChanged: true },
      async (transaction) => {
        const document = await ProfileSettings.findById(PROFILE_ID).session(transaction)
          || new ProfileSettings({ _id: PROFILE_ID });
        replacedPublicId = document.logo?.publicId;
        document.logo = newLogo;
        return document.save({ session: transaction });
      },
    );
  } catch (error) {
    try {
      await deleteImage(newLogo.publicId);
    } catch (cleanupError) {
      console.error("Unable to clean up an unreferenced company logo:", cleanupError);
    }
    throw error;
  }

  if (replacedPublicId && replacedPublicId !== newLogo.publicId) {
    try {
      await deleteImage(replacedPublicId);
    } catch (error) {
      console.error("Unable to remove the replaced company logo from Cloudinary:", error);
    }
  }

  return response.json({ logo: newLogo });
}

async function removeCompanyLogo(request, response) {
  let previousPublicId;
  const profile = await saveWithAudit(
    request,
    { changedFields: [], logoChanged: true, logoRemoved: true },
    async (transaction) => {
      const document = await ProfileSettings.findById(PROFILE_ID).session(transaction);
      if (!document?.logo?.publicId) return null;
      previousPublicId = document.logo.publicId;
      document.logo = { url: "", publicId: "" };
      return document.save({ session: transaction });
    },
  );
  if (!profile || !previousPublicId) {
    return response.json({ logo: { url: "", publicId: "" } });
  }
  try {
    await deleteImage(previousPublicId);
  } catch (error) {
    console.error("Unable to remove the deleted company logo from Cloudinary:", error);
  }
  return response.json({ logo: { url: "", publicId: "" } });
}

module.exports = {
  detectImageType,
  getProfile,
  getPublicBrand,
  removeCompanyLogo,
  updateProfile,
  uploadCompanyLogo,
  validateProfileInput,
};
