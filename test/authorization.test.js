const assert = require("node:assert/strict");
const { test } = require("node:test");
const { hasAnyDepartmentRole } = require("../lib/authorization");

test("Super Admin is authorized for every department role", () => {
  for (const role of ["Accountant", "Human Resource", "Inventory Manager", "General Manager"]) {
    assert.equal(hasAnyDepartmentRole({ roles: ["Super Admin"] }, [role]), true);
  }
});

test("department role checks remain restricted for non-Super Admin accounts", () => {
  assert.equal(hasAnyDepartmentRole({ roles: ["Accountant"] }, ["Human Resource"]), false);
  assert.equal(hasAnyDepartmentRole({ roles: ["Accountant"] }, ["Accountant"]), true);
  assert.equal(hasAnyDepartmentRole(null, ["Accountant"]), false);
});
