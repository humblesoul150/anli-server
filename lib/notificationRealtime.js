let io;

function attachNotificationRealtime(socketServer) {
  io = socketServer;
}

function emitToUser(userId, eventName, payload) {
  io?.to(String(userId)).emit(eventName, payload);
}

module.exports = { attachNotificationRealtime, emitToUser };
