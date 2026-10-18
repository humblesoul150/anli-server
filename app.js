const express = require("express");
const cors = require("cors");
const compression = require("compression");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const authRoutes = require("./routes/auth");
const sessionRoutes = require("./routes/sessions");
const securitySettingsRoutes = require("./routes/securitySettings");
const userRoutes = require("./routes/users");
const auditRoutes = require("./routes/audit");
const profileSettingsRoutes = require("./routes/profileSettings");

function createApp(config) {
  const app = express();
  app.locals.config = config;

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || config.allowedOrigins.includes(origin)) {
          return callback(null, true);
        }
        const error = new Error("Origin is not allowed by CORS.");
        error.statusCode = 403;
        return callback(error);
      },
      credentials: true,
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Bootstrap-Secret"],
    }),
  );
  app.use(helmet());
  app.use(compression());
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  app.get("/health", (_request, response) => {
    response
      .status(200)
      .json({ status: "OK", timestamp: new Date().toISOString() });
  });

  const authRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many sign-in attempts. Try again later." },
  });
  app.use("/api/auth/login", authRateLimit);
  app.use("/api/auth/bootstrap-super-admin", authRateLimit);
  app.use("/api/auth", authRoutes);
  app.use("/api/sessions", sessionRoutes);
  app.use("/api/security-settings", securitySettingsRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/audit", auditRoutes);
  app.use("/api/profile-settings", profileSettingsRoutes);

  app.use((error, _request, response, _next) => {
    if (response.headersSent) return;
    const statusCode = Number.isInteger(error.statusCode)
      ? error.statusCode
      : 500;
    if (statusCode >= 500) {
      console.error("Request failed:", error);
    }
    return response.status(statusCode).json({
      error:
        statusCode >= 500 && config.isProduction
          ? "An unexpected server error occurred."
          : error.message || "An unexpected server error occurred.",
    });
  });

  return app;
}

module.exports = { createApp };
