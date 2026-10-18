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

## Tests

Run `npm test` from this directory.
