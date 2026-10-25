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

test("approval inbox rejects unauthenticated requests", async () => {
  const response = await fetch(`${baseUrl}/api/approvals`);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "Authentication required.");
});

test("dashboard summary rejects unauthenticated requests", async () => {
  const response = await fetch(`${baseUrl}/api/dashboard/summary?from=2026-10-20&to=2026-10-24`);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "Authentication required.");
});

test("order reads and mutations reject unauthenticated requests", async () => {
  const requests = [
    ["/api/orders", "GET"],
    ["/api/orders", "POST"],
    ["/api/orders/507f1f77bcf86cd799439011", "GET"],
    ["/api/orders/507f1f77bcf86cd799439011/confirm", "POST"],
    ["/api/orders/507f1f77bcf86cd799439011/payments", "POST"],
    ["/api/orders/507f1f77bcf86cd799439011/fulfill", "POST"],
    ["/api/orders/legacy-import", "POST"],
  ];
  for (const [path, method] of requests) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
      body: method === "POST" ? "{}" : undefined,
    });

    test("receipt register and management actions reject unauthenticated requests", async () => {
      const requests = [
        ["/api/receipts/sales", "GET"],
        ["/api/receipts/credit-payments", "GET"],
        ["/api/receipts/sales/507f1f77bcf86cd799439011/favorite", "PATCH"],
        ["/api/receipts/credit-payments/507f1f77bcf86cd799439011/archive", "PATCH"],
        ["/api/receipts/bulk-export", "POST"],
      ];
      for (const [path, method] of requests) {
        const response = await fetch(`${baseUrl}${path}`, {
          method,
          headers: ["PATCH", "POST"].includes(method) ? { "Content-Type": "application/json" } : undefined,
          body: ["PATCH", "POST"].includes(method) ? "{}" : undefined,
        });
        assert.equal(response.status, 401, `${method} ${path}`);
      }
    });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
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

test("asset reads and mutations reject unauthenticated requests", async () => {
  const requests = [
    ["/api/assets", "GET"],
    ["/api/assets?limit=1", "GET"],
    ["/api/assets/507f1f77bcf86cd799439011", "GET"],
    ["/api/assets", "POST"],
    ["/api/assets/import", "POST"],
    ["/api/assets/507f1f77bcf86cd799439011", "PATCH"],
    ["/api/assets/507f1f77bcf86cd799439011/events", "POST"],
    ["/api/assets/507f1f77bcf86cd799439011/photos", "POST"],
    ["/api/assets/507f1f77bcf86cd799439011/photos/photo", "DELETE"],
  ];
  for (const [path, method] of requests) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: ["POST", "PATCH"].includes(method) ? { "Content-Type": "application/json" } : undefined,
      body: ["POST", "PATCH"].includes(method) ? "{}" : undefined,
    });

    assert.equal(response.status, 401, `${method} ${path}`);
  }
});

test("expense reads, decisions, payments, receipts, and imports reject unauthenticated requests", async () => {
  const requests = [
    ["/api/expenses", "GET"],
    ["/api/expenses", "POST"],
    ["/api/expenses/legacy-import", "POST"],
    ["/api/expenses/507f1f77bcf86cd799439011", "GET"],
    ["/api/expenses/507f1f77bcf86cd799439011/decision", "POST"],
    ["/api/expenses/507f1f77bcf86cd799439011/payments", "POST"],
    ["/api/expenses/507f1f77bcf86cd799439011/attachments", "POST"],
    ["/api/expenses/507f1f77bcf86cd799439011/attachments/attachment-id", "DELETE"],
  ];
  for (const [path, method] of requests) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: ["POST", "PUT", "PATCH"].includes(method) ? { "Content-Type": "application/json" } : undefined,
      body: ["POST", "PUT", "PATCH"].includes(method) ? "{}" : undefined,
    });

    test("sales, sale details, and sale payments reject unauthenticated requests", async () => {
      const requests = [
        ["/api/sales", "GET"],
        ["/api/sales", "POST"],
        ["/api/sales/507f1f77bcf86cd799439011", "GET"],
        ["/api/sales/507f1f77bcf86cd799439011/payments", "POST"],
        ["/api/sales/507f1f77bcf86cd799439011/credit", "PATCH"],
        ["/api/sales/credit-customers/C-100/statement", "GET"],
        ["/api/notifications", "GET"],
        ["/api/notifications?unread=true", "GET"],
        ["/api/notifications/read-all", "PATCH"],
        ["/api/notifications/507f1f77bcf86cd799439011/read", "PATCH"],
      ];
      for (const [path, method] of requests) {
        const response = await fetch(`${baseUrl}${path}`, {
          method,
          headers: ["POST", "PATCH"].includes(method) ? { "Content-Type": "application/json" } : undefined,
          body: ["POST", "PATCH"].includes(method) ? "{}" : undefined,
        });
        assert.equal(response.status, 401, `${method} ${path}`);
      }
    });

    assert.equal(response.status, 401, `${method} ${path}`);
  }
});

test("customer reads, mutations, and legacy imports reject unauthenticated requests", async () => {
  const requests = [
    ["/api/customers", "GET"],
    ["/api/customers", "POST"],
    ["/api/customers/legacy-import", "POST"],
    ["/api/customers/C-001", "GET"],
    ["/api/customers/C-001", "PUT"],
    ["/api/customers/C-001/status", "PATCH"],
    ["/api/customers/C-001/archive", "POST"],
    ["/api/customers/C-001/restore", "POST"],
  ];
  for (const [path, method] of requests) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: ["POST", "PUT", "PATCH"].includes(method) ? { "Content-Type": "application/json" } : undefined,
      body: ["POST", "PUT", "PATCH"].includes(method) ? "{}" : undefined,
    });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
});

test("leave routes reject unauthenticated reads and mutations", async () => {
  const requests = [
    ["/api/leave", "GET"],
    ["/api/leave", "POST"],
    ["/api/leave/policy", "GET"],
    ["/api/leave/policy", "PUT"],
    ["/api/leave/people", "GET"],
    ["/api/leave/people/507f1f77bcf86cd799439011/routing", "PUT"],
    ["/api/leave/legacy-archive", "GET"],
    ["/api/leave/legacy-import/preview", "POST"],
    ["/api/leave/legacy-import", "POST"],
    ["/api/leave/balances", "GET"],
    ["/api/leave/reminder-candidates", "GET"],
    ["/api/leave/507f1f77bcf86cd799439011/decision", "POST"],
    ["/api/leave/507f1f77bcf86cd799439011/cancel", "POST"],
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

test("disciplinary routes reject unauthenticated reads and mutations", async () => {
  const requests = [
    ["/api/disciplinary-cases", "GET"],
    ["/api/disciplinary-cases", "POST"],
    ["/api/disciplinary-cases/policy", "GET"],
    ["/api/disciplinary-cases/policy", "PUT"],
    ["/api/disciplinary-cases/approvers", "GET"],
    ["/api/disciplinary-cases/employee-indicators", "GET"],
    ["/api/disciplinary-cases/my-cases", "GET"],
    ["/api/disciplinary-cases/507f1f77bcf86cd799439011/submit", "POST"],
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

    test("payroll APIs reject unauthenticated requests", async () => {
      const requests = [
        ["/api/payroll/policy", "GET"],
        ["/api/payroll/policy", "PUT"],
        ["/api/payroll/runs", "GET"],
        ["/api/payroll/runs", "POST"],
        ["/api/payroll/runs/507f1f77bcf86cd799439011", "GET"],
        ["/api/payroll/runs/507f1f77bcf86cd799439011/submit", "POST"],
        ["/api/payroll/runs/507f1f77bcf86cd799439011/recalculate", "POST"],
        ["/api/payroll/runs/507f1f77bcf86cd799439011/decision", "POST"],
        ["/api/payroll/runs/507f1f77bcf86cd799439011/payment", "POST"],
        ["/api/payroll/attendance-periods", "POST"],
        ["/api/payroll/attendance-periods/2026-10-01/2026-10-31/reopen", "POST"],
        ["/api/payroll/employees/507f1f77bcf86cd799439011/payslips", "GET"],
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

    assert.equal(response.status, 401, `${method} ${path}`);
  }
});

test("production catalog and stock routes reject unauthenticated requests", async () => {
  const requests = [
    ["/api/production/products", "GET"],
    ["/api/production/products", "POST"],
    ["/api/production/products/507f1f77bcf86cd799439011", "PATCH"],
    ["/api/production/products/507f1f77bcf86cd799439011/recipe", "PUT"],
    ["/api/production/materials", "GET"],
    ["/api/production/materials", "POST"],
    ["/api/production/stock/balances", "GET"],
    ["/api/production/stock/finished/receipts", "POST"],
    ["/api/production/stock/finished/adjustments", "POST"],
    ["/api/production/runs", "GET"],
    ["/api/production/runs", "POST"],
  ];
  for (const [path, method] of requests) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: ["POST", "PUT", "PATCH"].includes(method) ? { "Content-Type": "application/json" } : undefined,
      body: ["POST", "PUT", "PATCH"].includes(method) ? "{}" : undefined,
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
