const dotenv = require("dotenv");

dotenv.config();

const isProduction = process.env.NODE_ENV === "production";

function parseOrigins(value) {
  return String(value || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function requireValue(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function loadConfig() {
  const dbUrl = requireValue("DB_URL");
  const bootstrapSecret = String(process.env.BOOTSTRAP_SECRET || "").trim();
  const allowedOrigins = parseOrigins(process.env.ALLOWED_ORIGINS);
  const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);

  if (
    !Number.isInteger(trustProxyHops) ||
    trustProxyHops < 0 ||
    trustProxyHops > 10
  ) {
    throw new Error("TRUST_PROXY_HOPS must be a whole number from 0 to 10");
  }

  if (isProduction && allowedOrigins.length === 0) {
    throw new Error(
      "ALLOWED_ORIGINS must contain at least one origin in production",
    );
  }

  if (isProduction && bootstrapSecret.length < 32) {
    throw new Error(
      "BOOTSTRAP_SECRET must be at least 32 characters in production",
    );
  }

  return {
    dbUrl,
    bootstrapSecret,
    allowedOrigins:
      allowedOrigins.length > 0
        ? allowedOrigins
        : ["http://localhost:3000", "http://localhost:3001"],
    isProduction,
    trustProxyHops,
    port: Number(process.env.PORT || 5000),
  };
}

module.exports = { loadConfig };
