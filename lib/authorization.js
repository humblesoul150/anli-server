function hasAnyDepartmentRole(user, requiredRoles) {
  return Boolean(
    user?.roles?.includes("Super Admin")
    || user?.roles?.some((role) => requiredRoles.includes(role)),
  );
}

module.exports = { hasAnyDepartmentRole };
