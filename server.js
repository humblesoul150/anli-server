const http = require("node:http");
const { connectDb } = require("./configs/connectDb");
const { loadConfig } = require("./configs/env");
const { createApp } = require("./app");
const { generateCreditReminders } = require("./lib/creditReminders");
const { generateLeaveReminders } = require("./lib/leaveReminders");
const { processNotificationOutbox } = require("./lib/notificationEvents");
const { initializeNotificationSockets } = require("./lib/notificationSockets");

async function startServer() {
  const config = loadConfig();
  await connectDb(config.dbUrl);
  await generateCreditReminders();
  await generateLeaveReminders();
  await processNotificationOutbox();
  const app = createApp(config);
  const server = http.createServer(app);
  initializeNotificationSockets(server, config);
  server.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
  });
  const reminderTimer = setInterval(async () => {
    try {
      await Promise.all([generateCreditReminders(), generateLeaveReminders()]);
    } catch (error) {
      console.error("Scheduled notification generation failed:", error);
    }
  }, 24 * 60 * 60 * 1000);
  reminderTimer.unref();
  const outboxTimer = setInterval(() => {
    processNotificationOutbox().catch((error) => {
      console.error("Notification outbox processing failed:", error);
    });
  }, 2_000);
  outboxTimer.unref();
  return server;
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("Failed to start server:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { startServer };
