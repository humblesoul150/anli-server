const SecuritySettings = require("../models/securitySettings");

const SETTINGS_ID = "global";
const SETTINGS_CACHE_MS = 30_000;
let cachedSettings;
let cacheExpiresAt = 0;

async function getSecuritySettings({ refresh = false } = {}) {
  if (!refresh && cachedSettings && Date.now() < cacheExpiresAt) {
    return cachedSettings;
  }

  let settings = await SecuritySettings.findById(SETTINGS_ID).lean();
  if (!settings) {
    settings = await SecuritySettings.findByIdAndUpdate(
      SETTINGS_ID,
      { $setOnInsert: {} },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
  }

  cachedSettings = settings;
  cacheExpiresAt = Date.now() + SETTINGS_CACHE_MS;
  return settings;
}

function cacheSecuritySettings(settings) {
  cachedSettings = settings;
  cacheExpiresAt = Date.now() + SETTINGS_CACHE_MS;
}

module.exports = { SETTINGS_ID, cacheSecuritySettings, getSecuritySettings };
