const { Server } = require("socket.io");
const Session = require("../models/session");
const User = require("../models/user");
const { getSecuritySettings } = require("./securitySettings");
const { idleTimeoutMs } = require("./sessionPolicy");
const { hashSessionToken } = require("./sessionTokens");
const { getSessionToken } = require("../middleware/authentication");
const { attachNotificationRealtime } = require("./notificationRealtime");

async function authenticatedSession(token) {
  if (typeof token !== "string" || !token) return null;
  const now = new Date();
  const session = await Session.findOne({ tokenHash: hashSessionToken(token) });
  if (!session || session.revokedAt || session.absoluteExpiresAt <= now) return null;
  const user = await User.findById(session.userId);
  if (!user || user.status !== "Active" || user.mustChangePassword ||
      session.sessionVersion !== user.sessionVersion) return null;
  const settings = await getSecuritySettings();
  if (now.getTime() - session.lastActivityAt.getTime() >= idleTimeoutMs(user, settings)) return null;
  return { session, user };
}

async function stillAuthorized(socket) {
  const session = await Session.findById(socket.data.sessionId);
  if (!session || session.revokedAt || session.absoluteExpiresAt <= new Date()) return false;
  const user = await User.findById(session.userId);
  if (!user || user.status !== "Active" || user.mustChangePassword ||
      session.sessionVersion !== user.sessionVersion) return false;
  const settings = await getSecuritySettings();
  return new Date().getTime() - session.lastActivityAt.getTime() < idleTimeoutMs(user, settings);
}

function initializeNotificationSockets(httpServer, config) {
  const io = new Server(httpServer, {
    cors: {
      origin: config.allowedOrigins,
      credentials: true,
      methods: ["GET", "POST"],
    },
    allowRequest(request, callback) {
      const origin = request.headers.origin;
      callback(null, !origin || config.allowedOrigins.includes(origin));
    },
  });

  io.use(async (socket, next) => {
    try {
      const token = getSessionToken({
        headers: socket.request.headers,
        get(name) { return socket.request.headers[name.toLowerCase()]; },
      });
      if (!token) return next(new Error("Authentication required."));
      const authenticated = await authenticatedSession(token);
      if (!authenticated) return next(new Error("Session is no longer active."));
      socket.data.userId = String(authenticated.user._id);
      socket.data.sessionId = String(authenticated.session._id);
      return next();
    } catch (error) {
      console.error("Notification socket authentication failed:", error);
      return next(new Error("Unable to authenticate notification connection."));
    }
  });

  io.on("connection", (socket) => {
    socket.join(socket.data.userId);
    const sessionCheck = setInterval(async () => {
      try {
        if (!await stillAuthorized(socket)) socket.disconnect(true);
      } catch (error) {
        console.error("Notification socket session check failed:", error);
        socket.disconnect(true);
      }
    }, 30_000);
    sessionCheck.unref();
    socket.on("disconnect", () => clearInterval(sessionCheck));
  });

  attachNotificationRealtime(io);
  return io;
}

module.exports = { authenticatedSession, initializeNotificationSockets };
