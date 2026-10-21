# Anli Server

## Run locally

1. Use Node.js and a MongoDB replica set or sharded cluster. Account creation and role changes use MongoDB transactions; a standalone MongoDB server is not supported.
2. Copy `.env.example` to `.env`, set `DB_URL`, replace the example bootstrap secret with a distinct random value, and set `ALLOWED_ORIGINS` to include the exact client origin. In production, `BOOTSTRAP_SECRET` must be at least 32 characters.
3. Start the API with `npm start` (or `npm run dev` during development). The health endpoint is `GET http://localhost:5000/health`.
4. Configure the client `NEXT_PUBLIC_API_URL` to the API base URL, including `/api`.
5. Set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` on the server to enable company-logo uploads. Never expose these values to the client.

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

## Account security audit

Security and account-management events are stored in the append-only `AuditEvent` collection. Events include successful and failed sign-ins, password changes and administrator resets, account creation/profile/role/status changes, session logout/revocation/expiry, session-policy changes, and authorization denials. Records identify the actor and affected account separately when known. Unknown-account sign-in attempts are recorded without storing the submitted email address.

Super Admins can query `GET /api/audit` for a global event feed and `GET /api/audit/users/:userId` for an account's history. Both support `eventType`, `outcome`, `actorId`, `from`, `to`, `limit` (1–100), and `cursor` filters; the account route fixes the target user and ignores a caller-supplied target filter. Responses use stable descending timestamp/ID cursor pagination. These endpoints do not expose event mutation or deletion.

Audit metadata is allowlisted and excludes passwords, temporary passwords, raw session tokens/cookies, and request bodies. IP addresses and user-agent labels are retained to support security review and access is restricted to Super Admins. No automatic retention deletion is currently configured; set a retention period only after operational and legal requirements have been established. Activity heartbeats are deliberately excluded; current/recent presence is derived from active sessions instead.

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

Leave requests, review decisions, amendments, cancellations, return confirmation, balances, policy, and reminder candidates are stored or computed by the API. Notifications are not delivered; reminder endpoints return candidates for a later notification workflow. All leave routes require authentication and completion of a required password change.

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

## Tests

Run `npm test` from this directory.
