const mongoose = require("mongoose");
const SalesBonusSettings = require("../models/salesBonusSettings");
const audit = require("../lib/audit");
const {
  DEFAULT_SALES_BONUS_SETTINGS,
  normalizeSettings,
} = require("../lib/salesBonus");

const SETTINGS_ID = "global";
const positiveInteger = (value) => Number.isInteger(value) && value >= 1;

function serialize(settings, version = 1) {
  const normalized = normalizeSettings(settings);
  return {
    ...normalized,
    version,
    updatedAt: settings?.updatedAt ?? null,
  };
}

async function readSettings() {
  const settings = await SalesBonusSettings.findById(SETTINGS_ID).lean();
  return settings || { ...DEFAULT_SALES_BONUS_SETTINGS, version: 1, _id: SETTINGS_ID };
}

function validateSettings(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Provide sales bonus settings as an object." };
  }
  if (typeof body.enabled !== "boolean") return { error: "Sales bonus enabled must be true or false." };
  if (!body.standard || !body.volume) return { error: "Both bonus tiers are required." };

  const tiers = [body.standard, body.volume];
  if (tiers.some((tier) => !tier || Object.values(tier).some((value) => !positiveInteger(value)))) {
    return { error: "Bonus quantities and thresholds must be positive whole numbers." };
  }
  if (body.standard.minimumQuantity < 1 || body.standard.maximumQuantity < body.standard.minimumQuantity ||
    body.volume.minimumQuantity <= body.standard.maximumQuantity ||
    body.volume.minimumQuantity !== 1000) {
    return { error: "Standard and volume tiers must remain ordered, with volume bonuses starting at 1,000 boxes." };
  }
  return { value: normalizeSettings(body) };
}

async function getSettings(_request, response) {
  const settings = await readSettings();
  return response.json({ salesBonus: serialize(settings, settings.version ?? 1) });
}

async function updateSettings(request, response) {
  const { value, error } = validateSettings(request.body);
  if (error) return response.status(400).json({ error });
  const session = await mongoose.startSession();
  let settings;
  try {
    await session.withTransaction(async () => {
      const current = await SalesBonusSettings.findById(SETTINGS_ID).session(session).lean();
      const nextVersion = Number(current?.version ?? 0) + 1;
      settings = await SalesBonusSettings.findByIdAndUpdate(
        SETTINGS_ID,
        {
          $set: {
            ...value,
            version: nextVersion,
            updatedBy: request.authUser._id,
          },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true, session },
      );
      await audit.recordAudit({
        request,
        eventType: "sales_bonus.settings_updated",
        outcome: "success",
        details: { version: nextVersion, enabled: settings.enabled },
        transaction: session,
      });
    });
  } finally {
    await session.endSession();
  }
  return response.json({ salesBonus: serialize(settings, settings.version) });
}

module.exports = { getSettings, updateSettings, readSettings };
