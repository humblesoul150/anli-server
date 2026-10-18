function toPublicUser(user) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    roles: [...user.roles],
    status: user.status,
    createdAt: user.createdAt?.toISOString(),
    updatedAt: user.updatedAt?.toISOString(),
    lastActive: user.lastActive?.toISOString(),
    suspensionReason: user.suspensionReason || undefined,
    mustChangePassword: Boolean(user.mustChangePassword),
  };
}

module.exports = { toPublicUser };
