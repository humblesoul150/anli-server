# Anli Server

## Run locally

1. Use Node.js and a MongoDB replica set or sharded cluster. Account creation and role changes use MongoDB transactions; a standalone MongoDB server is not supported.
2. Copy `.env.example` to `.env`, set `DB_URL`, replace the example bootstrap secret with a distinct random value, and set `ALLOWED_ORIGINS` to include the exact client origin. In production, `BOOTSTRAP_SECRET` must be at least 32 characters.
3. Start the API with `npm start` (or `npm run dev` during development). The health endpoint is `GET http://localhost:5000/health`.
4. Configure the client `NEXT_PUBLIC_API_URL` to the API base URL, including `/api`.
5. Set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` on the server to enable company-logo, employee-media, and expense-receipt uploads. Never expose these values to the client.

For a local MongoDB installation, configure and start a replica set before running the API. For example, start `mongod` with `--replSet rs0`, then run `rs.initiate()` once in `mongosh`. Use a replica-set connection string such as `mongodb://127.0.0.1:27017/anli?replicaSet=rs0` for `DB_URL`.

## Create the first Super Admin

Set `BOOTSTRAP_SECRET` in the server environment, then call `POST /api/auth/bootstrap-super-admin` once with the matching `X-Bootstrap-Secret` header and a JSON body containing `name`, `email`, and an initial `password` (at least 8 characters and no more than 72 UTF-8 bytes). For example, from PowerShell after setting `$env:BOOTSTRAP_SECRET`:

```powershell
$body = @{
  name = "Workspace Administrator"
  email = "admin@example.com"
  password = "replace-with-a-temporary-password"
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:5000/api/auth/bootstrap-super-admin" `
  -Headers @{ "X-Bootstrap-Secret" = $env:BOOTSTRAP_SECRET } `
  -ContentType "application/json" `
  -Body $body
```

The initial account must change its password at first sign-in. Bootstrap is rejected after a Super Admin exists. Keep the bootstrap secret out of source control and remove it from the server environment after the first account has been created.

## Admin-initiated password recovery

An authenticated Super Admin can reset an existing account with `POST /api/users/:id/reset-password` (send no password in the request body). The server generates a random six-character temporary password using an alphabet that avoids easily confused characters, returns it once, and expires it after 24 hours. The user must change it at the next sign-in; permanent passwords still require at least eight characters. A reset invalidates the user's existing sessions and does not change their account status or assigned roles. Share the temporary password with the user through a secure channel; if it is lost or expires, issue another reset.

## Sessions and device protection

Sign-in creates an opaque, per-device session. The browser receives it in an HttpOnly cookie; MongoDB stores only its SHA-256 token hash. Authenticated requests are rejected after the role-based idle timeout or the fixed eight-hour absolute lifetime. Super Admins and Admins use `privilegedIdle`; other roles use `generalIdle`. Idle expiry is enforced synchronously by the API; the TTL index only cleans up expired session records later.

The client reports activity only in response to foreground user interaction and throttles those reports. It displays a warning using `warningPeriod` and signs out at the deadline without periodic status polling. `GET /api/sessions` lists the current user's active devices. Users can revoke their own sessions; Super Admins can also use `GET /api/sessions/users/:userId` and revoke sessions by ID with `DELETE /api/sessions/:sessionId`. Super Admins read and update the idle policy through `GET` and `PUT /api/security-settings`. MFA remains unavailable until enrollment and challenge verification are implemented.

The move from JWT cookies to opaque server-managed sessions invalidates existing sign-in cookies once the new server version is deployed; users must sign in again.

## Temporary Super Admin department access

Super Admin accounts temporarily inherit department-level access across authenticated operational features, including read and write actions. Authentication, the required password change, administrator-only security settings, data validation, audit records, transaction guarantees, assigned employee self-service scope, and sequential approval/actor-separation rules remain enforced. The client displays a temporary-access indicator for Super Admins.

This override has no automatic expiry and remains active until manually reverted. To revert it, remove the Super Admin bypass from `lib/authorization.js` and `lib/authorization.ts`, then remove module-specific Super Admin approval allowances introduced for payroll and disciplinary approvals.

## Account security audit

Security and business events are stored in the append-only `AuditEvent` collection. Events include successful and failed sign-ins, password changes and administrator resets, account creation/profile/role/status changes, session logout/revocation/expiry, session-policy changes, authorization denials, and meaningful workflow changes across HR, attendance, leave, disciplinary, finance, payroll, salary advances, inventory, production, assets, customers, sales, orders, and receipts. Every authenticated GET/HEAD operation records a bounded `data.read.succeeded`, `data.read.failed`, or `data.read.denied` event; authenticated writes without a more specific business event receive a `data.write.*` fallback. These events contain the route template, resource type/ID when available, and HTTP status, not request/response content. Session activity heartbeats and notification read acknowledgements are excluded. Public and unauthenticated requests are not captured by authenticated activity auditing.

Super Admins can query `GET /api/audit` for a global event feed and `GET /api/audit/users/:userId` for an account's history. Both support `eventType`, `category`, `outcome`, `actorId`, `resourceType`, `from`, `to`, `limit` (1–100), and `cursor` filters; the account route fixes the target user and ignores a caller-supplied target filter. `GET /api/audit/event-types` returns the server event, category, and resource-type catalogs for the client filters. Responses use stable descending timestamp/ID cursor pagination and include actor/target snapshots plus a typed resource reference where available. These endpoints do not expose event mutation or deletion.

Audit metadata is bounded and sanitized; it excludes passwords, temporary passwords, raw session tokens/cookies, request/response bodies, and query/search values. Read events are written after the response finishes and do not delay or roll back reads; a failed write is logged for operator follow-up. Business-change audit records remain in the same MongoDB transaction as the state change when that transaction is used. Notification enqueue failures are logged separately and do not fail audit persistence. IP addresses and user-agent labels are retained to support security review and access is restricted to Super Admins. No automatic retention deletion is configured; establish a retention/archival period only after operational and legal requirements have been reviewed. Activity heartbeats are deliberately excluded; current/recent presence is derived from active sessions instead.

## Company profile and logo

The company profile is stored as a single MongoDB `ProfileSettings` document with the stable ID `global`. Authenticated users who have changed their temporary password can read the organization profile used by company documents. Only Super Admins can update it or manage the logo. `GET /api/profile-settings/public-brand` exposes only the display name and logo URL for signed-out workspace branding.

Update profile fields with `PUT /api/profile-settings`. Upload a logo as multipart form data to `POST /api/profile-settings/logo` using the `logo` field; PNG, JPEG, and WebP files up to 2 MB are accepted after server-side signature validation. The backend uploads the image to Cloudinary and stores only `logo.url` and `logo.publicId` in MongoDB. Remove a logo with `DELETE /api/profile-settings/logo`. Replaced/deleted Cloudinary assets are cleaned up after the database update; cleanup errors are logged for operator follow-up.

Company profile edits are audited as `company.profile_updated`. New documents use the current company identity; existing invoice seller snapshots and issued documents are not rewritten when the profile changes. The company name and logo shown to signed-out users are limited to public branding fields.

## Attendance

Attendance records are stored in MongoDB and belong to an employee and a date-only work date (`YYYY-MM-DD`, presented in Africa/Kampala time). At most one record can exist for each employee/work-date pair. Unmarked employees have no stored record; an `Unmarked` entry in a daily save removes that employee's record, and omitted employees are left unchanged.

After authentication and the required first password change, only Human Resource, Admin, and Super Admin roles can read or manage attendance:

- `GET /api/attendance?month=YYYY-MM&employeeId=<optional>` returns records for one calendar month, optionally filtered to one employee.
- `PUT /api/attendance/daily/YYYY-MM-DD` saves a batch with `{ "entries": [{ "employeeId": "...", "status": "Present|Absent|On leave|Unmarked", "halfDay": false, "late": false, "note": "" }] }`. Batches accept 1–500 distinct employees. Half-day and late are valid only for Present records.

Daily saves and their audit events commit together in a MongoDB transaction. Saves are retry-safe, validate employee references, and allow new entries only for active employees. Existing historical records can still be corrected after an employee is deactivated. Recording, correction, and removal are written to the security audit stream without including attendance notes. Monthly reads are capped at 20,000 records and return an explicit error if exceeded.

Pre-existing browser-local attendance is not imported; the client archives that old snapshot locally and displays only server-backed attendance.

## Leave management

Leave requests, review decisions, amendments, cancellations, return confirmation, balances, policy, and reminder candidates are stored or computed by the API. Due leave reminders are queued as in-app notifications by the scheduled notification worker; `GET /api/leave/reminder-candidates` remains available for reviewing currently due candidates. All leave routes require authentication and completion of a required password change.

- `GET /api/leave` lists leave requests visible to the caller; `POST /api/leave` submits a request for the linked employee account.
- `POST /api/leave/:id/decision` records an approval or rejection. `POST /api/leave/:id/amendments` requests a change to approved dates, followed by `POST /api/leave/:id/amendments/:amendmentId/decision`.
- `POST /api/leave/:id/cancel` cancels a request under HR/Admin authorization; `POST /api/leave/:id/return-confirmation` records the actual return date.
- `GET /api/leave/policy` reads configurable workdays (Monday–Saturday by default), holidays, leave-year start, entitlements, carryover settings, and reminder thresholds. `PUT /api/leave/policy` is Super Admin-only.
- `GET /api/leave/balances` and `GET /api/leave/reminder-candidates` return current computed balances and due reminder candidates; neither sends notifications.
- HR/Admin roles can use `GET /api/leave/people` and `PUT /api/leave/people/:employeeId/routing` to link active employee profiles to login accounts and assign an incharge. HR is the approval fallback when no incharge is assigned.
- HR/Admin roles can preview and import legacy browser requests with `POST /api/leave/legacy-import/preview` and `POST /api/leave/legacy-import`; imported records are retained in a separate read-only archive at `GET /api/leave/legacy-archive`. Legacy decisions are explicitly unverified and never count as approved leave or balances. The local browser snapshot remains intact.

Leave changes are recorded in the audit stream. Handover assignment is recorded on a request; it does not grant the selected employee access to the absent employee's account or role. Temporary delegated business permissions require separate authorization support and must not be treated as active where the underlying business routes do not enforce them.

## Employee profiles

Employee profiles are stored separately from login accounts in the `Employee` collection. The profile contains the fields used by the current employee wizard; employee records do not contain credentials or embedded attendance, leave, payroll, advance, or disciplinary histories. Employee numbers are generated by the server for new profiles and are unique/immutable. `DELETE /api/employees/:id` deactivates a record (it does not physically delete it), preserving historical references. An authorized editor can reactivate a record by updating its `status` to `Active`.

After authentication and the required first password change:

- `GET /api/employees` lists up to 500 profiles and supports `q`, `status`, `department`, `category`, and `frequency` filters.
- `GET /api/employees/:id` reads one profile.
- `POST /api/employees` creates a profile; `PUT /api/employees/:id` updates allowlisted profile fields.
- `DELETE /api/employees/:id` soft-deactivates the profile.
- `POST` and `DELETE /api/employees/:id/image` upload/replace or remove its image. Upload is multipart field `image`, accepts signature-validated PNG/JPEG/WebP up to 5 MB.
- `POST /api/employees/:id/documents` uploads a PDF as multipart field `document` plus a `title` (up to 80 characters); PDFs are limited to 10 MB. `DELETE /api/employees/:id/documents/:documentId` removes a document. The document route `GET /api/employees/:id/documents/:documentId/download` returns a short-lived signed download URL only to HR/Admin roles; signed URLs expire after two minutes.
- `GET /api/employees/drafts`, `PUT /api/employees/drafts/:draftId`, and `DELETE /api/employees/drafts/:draftId` manage onboarding drafts owned by the authenticated HR/Admin account.
- `POST /api/employees/import` accepts 1–100 validated local profiles per request. Each item contains a stable `migrationKey` and `employee` object; a retry with the same key is idempotent and does not overwrite an existing profile. The response reports imported, already-imported, and failed records.

Super Admins, Admins, and Human Resource role holders can create, edit, deactivate/reactivate, upload files, manage drafts, and import profiles. General Managers can read a limited projection only; pay, tax/NSSF, family/next-of-kin details, and documents are excluded from the response. Other roles are denied. The authorization is enforced by the API, not only by client controls.

Images use the existing Cloudinary image helper. PDFs are stored as authenticated raw Cloudinary assets; the API never returns their underlying Cloudinary URL. Replacing/removing media updates MongoDB before attempting to delete the old Cloudinary asset. If saving a newly uploaded asset fails, the API attempts to clean up that orphan. Cleanup failures are logged for operator follow-up. Employee profile actions are recorded in the append-only audit collection without storing sensitive profile values.

The client offers a user-confirmed, one-time import for non-seed employee profiles and unfinished drafts previously stored in browser localStorage. The import is limited to employee profile data; it does not migrate attendance/payroll/leave/advance demo records. Browser-local media references are not copied because the original files are not available to the server; re-upload those files from the employee profile. Original local profiles are retained until the import and draft migration succeed.

## Payroll

Payroll runs, attendance certifications, and payslips are persisted in MongoDB. HR prepares and submits runs; a General Manager approves first, then a different Super Admin (Director) gives final approval. An Accountant records the actual cash payout after approval. The API enforces these roles and transitions; a user cannot approve both stages of one run.

- `GET/PUT /api/payroll/policy` reads or updates the global week boundary, attendance cutoff, feeding allowance rates/eligibility, and effective-dated statutory rules. Updates are restricted to Accountants and Super Admins.
- `GET /api/payroll/runs` lists runs with optional `runType`, `status`, `periodStart`, `periodEnd`, and `limit` filters. HR creates a run with `POST /api/payroll/runs` and may recalculate a draft/returned run at `/runs/:id/recalculate` or submit it at `/runs/:id/submit`.
- `GET /api/payroll/runs/:id` reads a run. Assigned approver roles decide at `/runs/:id/decision`; a return requires a reason. `/runs/:id/payment` records a cash payout date/reference/note and derives the payout amount from approved net payslips.
- HR certifies a complete exact attendance range with `POST /api/payroll/attendance-periods` (`confirmedComplete: true`). `GET /api/payroll/attendance-periods/:periodStart/:periodEnd` reads its status; only Super Admin can reopen a closed period with a correction reason. Attendance writes are blocked while a date is in a closed period.
- `GET /api/payroll/employees/:employeeId/payslips` is available to payroll readers and to an employee for their own profile.

Monthly salary runs include monthly salary earners only. Weekly wage runs multiply the employee's configured daily wage by present attendance units (full day 1, half day 0.5); weekly feeding is a separate run, applies only to configured eligible employees, and uses the effective employee override or company daily rate. Feeding is excluded from monthly salary and weekly wages. Payroll requires a closed exact attendance range and a passed configured cutoff. Employee statutory flags and accountant-entered rules control deductions/contributions; missing configured rules block calculation for flagged employees. Salary-advance schedule installments are snapshotted in the payslip and posted transactionally with payment so retries cannot double-repay an installment. Existing browser-local payroll records remain unverified legacy history and are not imported as backend payroll.

Payroll state changes, attendance certification, cash payment, and linked advance repayments are audited and use MongoDB transactions; the deployment must support transactions (a replica set or sharded cluster).

## Salary advances

Salary advances are persisted in MongoDB and require two distinct approvals in order: Human Resource proposes terms, then a different General Manager may finalize or change them. Neither the requester nor the HR reviewer can act as the General Manager reviewer. Only HR can submit requests, make HR decisions, record disbursements/manual repayments, and manage attachments; only a General Manager can finalize the second approval. Reading is limited to HR, General Manager, Admin, and Super Admin roles. These checks are enforced by the API.

- `GET /api/salary-advances` lists records; optional `employeeId` and comma-separated `status` filters are supported. `GET /api/salary-advances/:id` reads one record.
- `POST /api/salary-advances` creates an HR-submitted request. `POST /api/salary-advances/:id/hr-decision` records HR approval with proposed terms or a rejection reason. `POST /api/salary-advances/:id/gm-decision` records the final decision; only final approval sets the approval date and generates the schedule.
- `POST /api/salary-advances/:id/disbursement` records the payout. `POST /api/salary-advances/:id/repayments` records a manual repayment. A disbursed balance is settled when repayments cover it.
- `POST /api/salary-advances/:id/attachments` uploads up to five signature-validated image/PDF files (10 MB each) to authenticated Cloudinary storage. `DELETE /api/salary-advances/:id/attachments/:attachmentId` removes an attachment and its Cloudinary asset. `GET /api/salary-advances/:id/attachments/:attachmentId/download` returns a short-lived private download URL.
- `POST /api/salary-advances/payroll-repayments` records installments due through a payroll period end. Requests are keyed by payroll run, payslip, advance, and schedule entry so retries do not double-post.
- `POST /api/salary-advances/legacy-import/preview` validates up to 500 locally archived records and reports duplicates and employee matches. `POST /api/salary-advances/legacy-import` imports validated records idempotently. Legacy approvals are stored as unverified archive data—not real decisions—and do not enable disbursement or repayment; local attachment data is not migrated.

Approval, disbursement, repayment, import, and attachment events are written to the audit stream. State changes use MongoDB transactions, so the deployment must support transactions (a replica set or sharded cluster).

## Disciplinary cases

Disciplinary cases are confidential backend records. Only Human Resource can create and edit pre-approval cases. Approvals are sequential and require three distinct active accounts: the assigned Human Resource reviewer, General Manager, and Super Admin (acting as Director). The case creator cannot be an approver. A letter cannot be issued until all three stages approve the current version; issued letter content is immutable.

Employee response requirements and calendar-day response windows are configurable for each letter type and may be overridden per case. A required response (or a factual HR record that the response window expired) must be recorded before approval. Non-response is not treated as an admission. No notification delivery is triggered by these endpoints.

- `GET /api/disciplinary-cases` lists cases for HR; assigned approvers see only cases assigned to their account. Optional `employeeId`, `status`, and `type` filters are supported. `GET /api/disciplinary-cases/:caseId` reads an authorized case.
- `POST /api/disciplinary-cases` creates an HR draft; `PATCH /api/disciplinary-cases/:caseId` edits pre-approval content. Substantive edits after a response reset the response window and require a fresh response.
- `GET /api/disciplinary-cases/approvers` returns minimal active reviewer choices to HR. `GET /api/disciplinary-cases/policy` reads response rules; only Super Admin can update them with `PUT`.
- `POST /api/disciplinary-cases/:caseId/response-request` opens the employee response window. Employees use `GET /api/disciplinary-cases/my-cases`, `POST /api/disciplinary-cases/my-cases/:caseId/responses`, and `POST /api/disciplinary-cases/my-cases/:caseId/acknowledgements` or `/appeals`. HR can record an offline response with `/response-record` or an expired window with `/no-response`.
- HR submits a completed case with `POST /api/disciplinary-cases/:caseId/submit`. The assigned reviewer at the current stage records `Approved` or `Rejected` at `/approvals`; HR can issue an all-approved letter at `/issue`. HR or Super Admin can resolve an appeal; only Super Admin can rescind an issued letter.
- HR can upload PDF evidence to `POST /api/disciplinary-cases/:caseId/evidence` (multipart field `file`, signature-validated, up to 10 MB, at most 10 files per case) and remove it before approval. Authorized assigned readers download through `/evidence/:evidenceId/download`, which returns a two-minute private URL; stored Cloudinary URLs and public IDs are never serialized.
- `GET /api/disciplinary-cases/employee-indicators` returns minimal indicators for authorized disciplinary readers: outlined flag for an active written warning, filled flag during an effective suspension, and user-X for a termination on/after its effective date. These indicators do not change employee status, payroll, or employment records.

Case changes and audit events are committed together in MongoDB transactions. All endpoints require an authenticated session with the temporary-password change completed. Employee case access is scoped to the employee profile linked to the signed-in account; manager access is scoped to their assigned cases. Automatic notification delivery, employment termination actions, and payroll changes are intentionally outside this workflow.

## Central approval inbox

The client reads `GET /api/approvals` for a normalized inbox across formal approval workflows: Leave requests and amendments, Salary Advances, Payroll, Expenses, and Disciplinary cases. The route requires an authenticated session with the temporary-password change completed. Each item includes its workflow and record IDs, reference, requester, summary, status, current stage, `canAct`, and available decision history; the response also includes actionable/in-progress/history counts and `truncatedSources`.

The inbox applies each source workflow's read scope before including records. Leave visibility follows the Leave API; Salary Advance, Payroll, and Expense records follow their reader roles; Disciplinary records are limited to HR or assigned reviewers, with Super Admin inbox visibility limited to cases assigned to that account. Disciplinary list items omit evidence assets and only contain case details for authorized case readers.

The endpoint returns up to the 500 most recent records per readable source. If a source has additional records, its name appears in `truncatedSources` and the client indicates that older records must be located in that source module. The counts cover the returned inbox items, not records omitted by this cap.

The inbox is read-only aggregation, not a replacement approval engine. Decisions must continue through the existing source routes, which enforce each workflow's reviewer, role, stage-order, self-approval, and validation rules: `/api/leave/:id/decision`, `/api/leave/:id/amendments/:amendmentId/decision`, `/api/salary-advances/:id/hr-decision`, `/api/salary-advances/:id/gm-decision`, `/api/payroll/runs/:id/decision`, `/api/expenses/:id/decision`, and `/api/disciplinary-cases/:caseId/approvals`. Orders and attendance close/reopen actions remain in their own operational workflows.

## Production, products, and inventory

Production catalog and inventory records are MongoDB-backed. All routes require an authenticated session with the temporary-password change completed and one of Super Admin, Admin, General Manager, Production Manager, or Inventory Manager. Product and ingredient creation, product edits, receipts, adjustments, and production posting are audited.

Finished-goods inventory is stored as whole sellable pieces. Product profiles define a millilitre sellable unit and may define an outer `Box` or `Carton`, a positive whole `piecesPerPack`, a positive `packWeightKg` for net product weight per outer pack, and a positive whole-UGX `price` per outer pack. Stock APIs accept piece quantities; clients may calculate pack equivalents for display. Product sellable units cannot be changed after stock or production history exists.

Products own versioned recipes, but raw-material catalog items are shared across products. Each recipe contains only the ingredients used by that product; `quantityPerTank` is expressed in the referenced material's base unit for one 1,000-litre tank. Recipe changes create immutable versions. Raw materials are created and stocked only in Raw Material Management; product recipes select from that shared catalog.

- `GET /api/production/products` returns product profiles, active recipes, and current piece balances. Product create/update and recipe endpoints accept ingredient entries referencing shared `materialId` records with `quantityPerTank`; inline material creation is not supported.
- `PUT /api/production/products/:id/recipe` creates a new immutable recipe version. Sending an empty array clears the active recipe without deleting prior versions.
- `GET /api/production/materials` lists the shared catalog and per-location balances. `POST /api/production/materials` creates a zero-stock material. Receipts, adjustments, and transfers are append-only movements. `PUT /api/production/materials/:materialId/locations/:location` configures a location's reorder threshold and responsible user. `GET /api/production/materials/low-stock` returns active alert records; entering or resolving a threshold state also queues deduplicated in-app notifications for the responsible user and inventory roles.
- `GET /api/production/materials/receipts` lists stock-in history. `GET /api/production/materials/movements` reads the movement ledger. `GET /api/production/materials/responsible-users` returns eligible inventory owners.
- `GET /api/production/materials/production-usages` lists daily material-use records. `POST /api/production/materials/production-usages` records use separately against a finished-goods run, deriving the ingredient totals on the server as `quantityPerTank × tanksProduced`. The use record snapshots its recipe and tank count and updates the selected location's inventory in the same transaction.
- `GET /api/production/stock/balances` returns finished-goods and raw-material balances. `GET /api/production/stock/finished/movements` reads the finished-goods movement ledger. `POST /api/production/stock/finished/receipts` records stock receipts; `POST /api/production/stock/finished/adjustments` records reason-coded increases or decreases. Movements are append-only and requests may supply an `idempotencyKey`.
- `GET /api/production/runs` reads production history. `POST /api/production/runs` accepts `productId`, `productionDate`, `openingStockPieces`, `damagedQuantityPieces`, `closingStockPieces`, optional `damageReason`, and optional `idempotencyKey`. Production is calculated as closing + damage − opening. Sales dispatches are posted only by the Sales API; legacy production-run sales quantities remain visible but cannot be entered again. Raw-material consumption is a separate linked posting via the production-usages endpoint, preventing duplicate deductions. No stock can fall below zero; one regular run is permitted per product/date.

Existing production-run sales dispatches are retained as historical ledger movements. Importing old browser sales never reposts their inventory movements, preventing duplicate deductions during migration.

## Sales and receipts

Sales and payments are stored in MongoDB under `/api/sales`. All endpoints require an authenticated session, a completed first password change, and the Sales Manager, General Manager, or Super Admin role (with the existing Super Admin department override). Mutations and denied access are audited.

- `GET /api/sales` returns `{ sales, nextCursor }` and supports `limit` (1–200), `cursor`, `customerId`, `paymentTerms`, `from`, `to`, `search`, and `includeVoided`. `GET /api/sales/:id` returns the sale and its payment history. `GET /api/sales/owners` returns active sales-role users for credit ownership.
- `POST /api/sales` accepts saved-customer or guest details, one or more `{ productId, packs }` lines, payment terms, optional due date, optional initial payment, and a required idempotency key. The server snapshots product name/code/pack size and catalog price, calculates totals, allocates a yearly `SAL-YYYY-000001` receipt number, records any initial payment, and dispatches `packs × piecesPerPack` from finished stock in one transaction. Retries with the same key and payload return the original sale; reusing a key with changed sale details returns a conflict.
- Product prices are whole UGX per outer pack. A price override must include a reason. The server validates that the product remains active, configured with pack details and a positive catalog price, and that sufficient stock is available.
- Guest/walk-in sales do not create Customer Management records and must be paid in full at sale time. Credit terms require an active saved customer. Later payments are recorded through `POST /api/sales/:id/payments`; positive whole-UGX amounts cannot exceed the remaining balance, and payment requests require idempotency keys.
- `POST /api/sales/legacy-import` accepts up to 200 browser-local sales and 1,000 payments per request. It preserves legacy IDs, references, and payment history, reports duplicates/rejections, advances receipt counters past preserved annual receipt references, and deliberately does not post stock movements. Paid legacy records without payment detail retain that status using a clearly labelled `Legacy` payment entry.
- Payments attached to Credit sales, including order payments transferred when an order is fulfilled, receive unique annual `CPR-YYYY-000001` receipt numbers. Run `npm run backfill:credit-payment-receipts` first as a dry run, then with `-- --apply` to assign numbers to historical Credit-sale payments; the operation is idempotent and uses transactions.
- Credit records can be reconciled with `PATCH /api/sales/:id/credit` (saved `customerId`, `dueDate`, and/or active Sales Manager `assignedTo`). `GET /api/sales/credit-customers/:customerId/statement` returns the customer's credit history, payment details, and credit/paid/outstanding/overdue totals.
- Receipt Management uses `/api/receipts` and the same Sales Manager, General Manager, and Super Admin access policy. `GET /api/receipts/sales` and `GET /api/receipts/credit-payments` return cursor-paginated receipt snapshots, server-calculated full-filter totals, and support `from`, `to`, `search`, `favorite=true`, and `archived=true`. Page size is limited to 100. `PATCH /api/receipts/:kind/:id/favorite` and `/archive` accept `{ "enabled": boolean }`; favorites are per user, while archive/restore is shared and does not modify financial records. `POST /api/receipts/bulk-export` records export counts and filter metadata without receipt contents.
- In-app notifications are recipient-specific at `/api/notifications`; `GET` supports `limit`, `cursor`, `unread=true`, and category filters (`action_required` is also supported). Responses include `notifications`, `unreadCount`, and `nextCursor`. `PATCH /api/notifications/:id/read` and `PATCH /api/notifications/read-all` only update the signed-in user's notifications. Notification resource references do not grant access; destination APIs enforce authorization when opened.
- The dashboard notification feed is updated over authenticated Socket.IO (`notification.created` and `notification.unread_count`) and clients should refetch on focus/reconnect as a fallback. Socket connections use the same session cookie, active-user, password-change, absolute-expiry, idle-expiry, and session-version checks as authenticated HTTP sessions; revoked or expired sessions are disconnected.
- Notifications generated by transactional workflow changes are written to a MongoDB outbox in the same transaction as the audited state transition. The worker retries failed delivery with backoff; a unique event key and recipient/dedupe key prevent duplicate notices. Reminder settings are managed by General Managers and Super Admins at `/api/notifications/credit-reminder-settings`. Credit defaults alert 7 days before, 1 day before, and on the due date; overdue reminders fire at 1, 3, and 7 days late, then weekly, with escalation to General Managers and Super Admins from day 7. Leave reminders use the configured leave policy. The server scans reminders on startup and daily. Notifications are in-app only; email/push, order, and security-event notifications are not enabled.
- The client marks legacy import complete only when no records are rejected. Local browser data is retained. Existing production-run dispatches and imported legacy sales are not replayed as stock movements.

Sales receipts are operational records, not tax/URA invoices. Sale creation does not automatically create an invoice. The receipt uses immutable sale-time buyer, product, price, and company snapshots. Receipt Management exposes sales receipts and credit-payment receipts in separate tabs with favorite/archive controls, current-filter bulk print/download, and full-register print/download.

## Company asset management

Assets and their append-only event histories are available under `/api/assets`. Every endpoint requires an authenticated session and a completed temporary-password change. Inventory Managers can read and manage assets; General Managers and Super Admins are read-only; Admins and Production Managers have no access. Denied role checks are written to the security audit stream. Asset state changes, asset history, and audit records commit together in MongoDB transactions.

- `GET /api/assets` accepts `limit` (default 100, 1–200), `cursor`, `category`, `condition`, `status`, `location`, `assignee`, and `search`; it returns `{ assets, nextCursor }`. `GET /api/assets/:id` returns the asset and up to 1,000 newest history entries.
- `POST /api/assets` creates an asset and its initial Acquired event. Asset tags are normalized case-insensitively and duplicates return HTTP 409. `PATCH /api/assets/:id` accepts only the asset profile fields and appends a Profile correction event.
- `POST /api/assets/:id/events` accepts `action` or client `type` values for inspection, transfer, assignment, maintenance, maintenance completion, status change, and disposal. Maintenance requires `work`; `provider` and non-negative `cost` are optional. Inspection of an asset needing repair or marked unserviceable and every status change require a reason. Events are attributed to the authenticated actor and update the corresponding asset fields; lifecycle transitions are checked, and disposed assets cannot be changed. Event responses use client fields including `type`, date-only `date`, `recordedAt`, `actor`, and before/after condition, status, and assignee values.
- `POST /api/assets/import` accepts `{ assets, events }` for a legacy import (up to 500 assets and 2,000 events). It never overwrites existing assets; normalized duplicate tags and previously imported events are counted as duplicates, malformed/unmatched records are rejected, and events are linked by `assetTag`, a legacy client asset ID associated with an imported asset's tag, or a valid existing server `assetId`. The response is `{ imported, importedEvents, duplicates, rejected }`: `imported` counts new assets, `importedEvents` counts new history entries, and `rejected` is a bounded list of `{ assetTag?, reason }` entries (at most one per rejected asset/event). Imported actor values are ignored in favor of the authenticated importer; audit details record both asset and event counts.
- Photos only are accepted at `POST /api/assets/:id/photos` as multipart field `photo`; PNG, JPEG, and WebP signatures are checked, each file is limited to 5 MB, and each asset can have 10 photos. `DELETE /api/assets/:id/photos/:photoId` removes a photo. Cloudinary assets are cleaned up after a successful database change; failed cleanup is logged for operator follow-up. Configure the Cloudinary credentials described above.

Profile and event values are validated against the asset categories, condition, and status choices. No general document attachments are supported.

### Legacy raw-material migration

Use **Export legacy data** in Raw Material Management to download the browser-local catalog, movement history, recipes, and production records for reconciliation. The migration script imports the legacy material catalog and movements, reconciles imported balances to the exported current quantities, converts old recipe ingredient fields to the 1,000-litre `quantityPerTank` basis, and replaces the old material-only balance index with a unique material/location index. Historical production-run snapshots are retained unchanged.

Run the dry-run first; it makes no database changes and reports catalog conflicts, pre-existing backend balances/history, and any opening/closing balancing entries required:

```powershell
npm run migrate:raw-materials -- C:\path\to\legacy-raw-material-migration.json
```

Resolve all catalog conflicts and manually reconcile any non-empty backend inventory before applying. If the dry-run reports balance differences, review the proposed entries and explicitly confirm them with `--accept-reconciliation`. Applying requires an active Super Admin, Admin, or Inventory Manager account ID and a MongoDB replica set/sharded cluster (the migration is transactional):

```powershell
npm run migrate:raw-materials -- C:\path\to\legacy-raw-material-migration.json --apply --actor=<user-id> --accept-reconciliation
```

Omit `--accept-reconciliation` when the dry-run reports no balance differences. The operation is protected against rerunning the same export and writes an audit event. Back up the database and retain the export/report before applying in production.

## Expenses

Expenses are stored in MongoDB at `/api/expenses`. All endpoints require an authenticated session with the required password change completed. Accountants and General Managers can read the register; Super Admins have read-only access. Only Accountants can create and import expenses, attach receipts, and record payments. Only General Managers can approve or reject pending expenses. Role denials are recorded in the security audit stream.

- `GET /api/expenses` returns `{ expenses, nextCursor }`. It supports `limit` (1–200), `cursor`, `status`, `category`, `taxType`, `department`, `from`, `to`, `search`, and `source` filters. Pagination merges date-sorted manual expenses with payroll projections.
- `POST /api/expenses` creates a manual expense in `Pending approval`. The request accepts `category`, `taxType` (required only for the `Tax` category), `expenseType`, `date`, `payee`, `description`, `department`, and whole-UGX `amount`. Payroll cannot be entered manually; payroll processor/vendor fees may be recorded under ordinary categories such as Professional services.
- `POST /api/expenses/:id/decision` accepts `{ decision: "Approved"|"Rejected", note }`. Rejection requires a reason. A decision is allowed only once while the record is pending.
- `POST /api/expenses/:id/payments` accepts a positive whole-UGX amount, date, method, optional reference, and note. Partial payments are supported, overpayment is rejected, and status is derived from total recorded payments.
- `GET /api/expenses/:id` returns a record and its append-only workflow events. State changes and their event/audit records are committed in MongoDB transactions; use a replica set or sharded cluster.
- Receipts can be uploaded to `POST /api/expenses/:id/attachments` as multipart field `receipt` (JPG, PNG, or WebP, signature-validated, at most 5 MB per file and five files per pending expense), removed before approval, and downloaded through `GET /api/expenses/:id/attachments/:attachmentId/download`. Receipt assets use authenticated Cloudinary storage; the API serializes no Cloudinary identifiers and returns only a two-minute private download URL to authorized readers.
- `POST /api/expenses/legacy-import` accepts up to 500 browser-local expense records. It is idempotent, preserves old status and receipt metadata as unverified legacy information, does not trust past approval/payment state, and reports imported, duplicate, and rejected records.

Approved and paid payroll runs are returned as linked, read-only rows rather than copied Expense documents. Monthly runs map to Salary, Weekly wages to Wages, and Weekly feeding to Feeding allowance. Payroll cost is gross earnings plus employer contributions; the separately reported payout is the actual payroll payment (normally net pay). These figures do not necessarily reconcile, and this operational register is not a double-entry ledger or a tax-filing system. Confirm payroll cost treatment and any tax classification with the organization's accountant. In particular, collected VAT and PAYE/withholding deducted from others are generally liabilities rather than company expenses.

## Customer management

Customer profiles are stored in MongoDB at `/api/customers`. All endpoints require an authenticated session and a completed first password change. Sales Managers, General Managers, and Admins can create/update profiles, change status, archive/restore, and import legacy records. Marketing Managers can read profiles. Super Admins retain the existing department-access override. Permission denials and successful profile/import mutations are recorded in the security audit log.

- `GET /api/customers` returns `{ customers, nextCursor }` and supports `limit` (1–200), `cursor`, `search`, `status`, and `archived` filters. `GET /api/customers/:id` reads a profile.
- `POST /api/customers` creates a customer. `PUT /api/customers/:id` updates supplied profile fields. `PATCH /api/customers/:id/status` accepts a valid `Active`, `Inactive`, or `Suspended` status. Archive and restore are soft-state operations at `POST /api/customers/:id/archive` and `/api/customers/:id/restore`; profiles and transaction links are not deleted.
- Customer names are unique after trimming, collapsing repeated whitespace, and case-folding. This prevents accidental duplicates; legacy import reports a same-name/different-ID collision rather than merging customer profiles or transactions.
- `POST /api/customers/legacy-import` accepts up to 200 browser-local profiles and preserves their IDs. It is safe to retry: IDs already stored on the server are reported as existing and are not overwritten. The client marks local import complete only after the server reports no rejected records; it does not delete the browser snapshot.

## Orders

Orders are stored in MongoDB and require an authenticated session, a completed first password change, and a Sales Manager, General Manager, or Super Admin role. Order creation requires an active saved customer and active catalog products with prices and pack details. Walk-in transactions belong in Sales instead.

- `GET /api/orders` returns a paginated order list (`page`, `limit` up to 200) and supports status, customer, and archived filters. `GET /api/orders/:id` also returns its payment history.
- `POST /api/orders` creates a `Pending` order using server-side product/customer snapshots and an idempotency key. `PUT /api/orders/:id` edits pending, unreserved, non-legacy orders.
- `POST /api/orders/:id/confirm` reserves finished stock. Reservations lower available stock without changing on-hand quantity; product and stock-balance responses include `balancePieces`, `reservedPieces`, and `availablePieces`.
- `PATCH /api/orders/:id/status` advances confirmed orders through `In progress` and `Ready`, or cancels them and releases any reservation. `POST /api/orders/:id/payments` records idempotent deposits or payments without allowing overpayment.
- `POST /api/orders/:id/fulfill` accepts only a ready order with a valid reservation. It creates one linked Sale and receipt, transfers existing order payments without duplicating them, dispatches finished stock once, and completes the order in one MongoDB transaction.
- `POST /api/orders/:id/archive` and `/restore` archive completed/cancelled orders without deleting their history. `POST /api/orders/legacy-import` imports browser-local records as read-only history; imported records never reserve stock or create Sales.

Sales and order actions are recorded in the security audit log. Customer history and credit summaries use server-backed sales when the Sales API is available.

## Dashboard summary

`GET /api/dashboard/summary?from=YYYY-MM-DD&to=YYYY-MM-DD` requires an authenticated, active session and a completed first password change. The server derives department access from the signed-in account; callers cannot choose roles or request another user's dashboard. Dates use Kampala business-day strings, are inclusive, and cannot span more than 366 days. The response includes `version`, the requested `range` and timezone, `generatedAt`, and only sections the account is authorized to read.

- Sales Managers, General Managers, and Super Admins receive sales/collections trends, top products, overdue receivables, and order pipeline aggregates.
- Production and inventory roles receive production/damage aggregates, open orders where permitted, and active raw-material threshold alert counts.
- Accountants, General Managers, and Super Admins receive approved expense totals/trends and pending approval counts.
- HR, Admin, and Super Admin receive attendance status counts for the selected date range and pending leave counts. No employee-level details or payroll amounts are returned.
- Inventory Managers, General Managers, and Super Admins receive aggregate asset inspection/service/insurance deadlines due or overdue within the next 30 days.

The endpoint uses bounded MongoDB aggregate/count queries and does not return underlying sale, expense, employee, customer, or asset records. Each authorized section has `status: "available"` with aggregate data or `status: "unavailable"` and a safe message if its source query fails; unavailable data must not be interpreted as zero. The client polls approximately every 60 seconds and refreshes on focus/reconnect. This is periodic refresh, not instant push.

## Tests

Run `npm test` from this directory.
