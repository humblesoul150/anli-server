const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { createApp } = require("../app");

const app = createApp({
  allowedOrigins: ["http://localhost:3000"],
  bootstrapSecret: "",
  isProduction: false,
  jwtSecret: "test-secret-that-is-long-enough-for-local-test",
});
let server;
let baseUrl;

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("health endpoint remains available", async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "OK");
});

test("user directory rejects unauthenticated requests", async () => {
  const response = await fetch(`${baseUrl}/api/users`);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "Authentication required.");
});

test("password reset rejects unauthenticated requests", async () => {
  const response = await fetch(
    `${baseUrl}/api/users/507f1f77bcf86cd799439011/reset-password`,
    { method: "POST" },
  );
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "Authentication required.");
});

test("session and security-settings APIs reject unauthenticated requests", async () => {
  const requests = [
    ["/api/sessions", "GET"],
    ["/api/sessions/activity", "POST"],
    ["/api/security-settings", "GET"],
    ["/api/security-settings", "PUT"],
    ["/api/audit", "GET"],
    ["/api/audit/users/507f1f77bcf86cd799439011", "GET"],
  ];
  for (const [path, method] of requests) {
    const response = await fetch(`${baseUrl}${path}`, { method });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
});

test("company profile reads and logo writes reject unauthenticated requests", async () => {
  const requests = [
    ["/api/profile-settings", "GET"],
    ["/api/profile-settings", "PUT"],
    ["/api/profile-settings/logo", "POST"],
    ["/api/profile-settings/logo", "DELETE"],
  ];
  for (const [path, method] of requests) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: method === "PUT" ? { "Content-Type": "application/json" } : undefined,
      body: method === "PUT" ? JSON.stringify({ legalName: "Example" }) : undefined,
    });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
});

test("employee profiles, drafts, uploads, and imports reject unauthenticated requests", async () => {
  const requests = [
    ["/api/employees", "GET"],
    ["/api/employees", "POST"],
    ["/api/employees/drafts", "GET"],
    ["/api/employees/import", "POST"],
    ["/api/employees/507f1f77bcf86cd799439011", "PUT"],
    ["/api/employees/507f1f77bcf86cd799439011", "DELETE"],
    ["/api/employees/507f1f77bcf86cd799439011/image", "POST"],
    ["/api/employees/507f1f77bcf86cd799439011/documents", "POST"],
  ];
  for (const [path, method] of requests) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: ["POST", "PUT"].includes(method) ? { "Content-Type": "application/json" } : undefined,
      body: ["POST", "PUT"].includes(method) ? "{}" : undefined,
    });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
});

test("attendance reads and daily saves reject unauthenticated requests", async () => {
  const requests = [
    ["/api/attendance?month=2026-10", "GET"],
    ["/api/attendance/daily/2026-10-19", "PUT"],
  ];
  for (const [path, method] of requests) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: method === "PUT" ? { "Content-Type": "application/json" } : undefined,
      body: method === "PUT" ? JSON.stringify({ entries: [] }) : undefined,
    });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
});

test("salary advance reads and mutations reject unauthenticated requests", async () => {
  const requests = [
    ["/api/salary-advances", "GET"],
    ["/api/salary-advances", "POST"],
    ["/api/salary-advances/legacy-import/preview", "POST"],
    ["/api/salary-advances/legacy-import", "POST"],
    ["/api/salary-advances/507f1f77bcf86cd799439011", "GET"],
    ["/api/salary-advances/507f1f77bcf86cd799439011/hr-decision", "POST"],
    ["/api/salary-advances/507f1f77bcf86cd799439011/gm-decision", "POST"],
    ["/api/salary-advances/507f1f77bcf86cd799439011/disbursement", "POST"],
    ["/api/salary-advances/507f1f77bcf86cd799439011/repayments", "POST"],
    ["/api/salary-advances/payroll-repayments", "POST"],
  ];
  for (const [path, method] of requests) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: ["POST", "PUT"].includes(method) ? { "Content-Type": "application/json" } : undefined,
      body: ["POST", "PUT"].includes(method) ? "{}" : undefined,
    });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
});

test("bootstrap endpoint is unavailable without server-side bootstrap configuration", async () => {
  const response = await fetch(`${baseUrl}/api/auth/bootstrap-super-admin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bootstrap-Secret": "not-set" },
    body: JSON.stringify({ name: "Admin", email: "admin@example.com", password: "initial-password" }),
  });
  assert.equal(response.status, 503);
});

test("credentialed CORS allows configured frontend origin only", async () => {
  const allowed = await fetch(`${baseUrl}/health`, { headers: { Origin: "http://localhost:3000" } });
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:3000");
  assert.equal(allowed.headers.get("access-control-allow-credentials"), "true");
});
