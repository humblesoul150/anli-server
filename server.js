const { connectDb } = require("./configs/connectDb");
const { loadConfig } = require("./configs/env");
const { createApp } = require("./app");
const { generateCreditReminders } = require("./lib/creditReminders");

async function startServer() {
  const config = loadConfig();
  await connectDb(config.dbUrl);
  await generateCreditReminders();
  const reminderTimer = setInterval(() => {
    generateCreditReminders().catch((error) => {
      console.error("Credit reminder generation failed:", error);
    });
  }, 24 * 60 * 60 * 1000);
  reminderTimer.unref();
  const app = createApp(config);
  const server = app.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
  });
  return server;
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("Failed to start server:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { startServer };
