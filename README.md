# NanoBaaS

NanoBaaS is a lightweight multi-project backend built on Fastify 5, SQLite, better-sqlite3 and Drizzle ORM. This repository is being implemented in security-focused phases; the current version is an API foundation, not a claim that every module in the product vision is finished.

## Current implementation

- SQLite WAL, foreign-key enforcement, checksummed transactional SQL migrations, normalized schemas and Drizzle table definitions.
- Environment validation, Fastify security headers, CORS allow-list, request-size cap, global and auth-specific rate limits, and centralized JSON errors.
- Argon2id registration/login; short-lived JWT access tokens; hashed opaque refresh tokens with rotation, expiry, logout and reuse-triggered session revocation.
- One-time password reset and email verification tokens, password change, session listing/revocation, and SMTP-based delivery when configured.
- Project creation/list/read/update/delete with membership scoping and owner checks.
- Hashed, one-time API key issuance/revocation with expiry, last-used tracking and project-scoped read/write permissions.
- Project member management, custom roles, permission assignment, and permission checks on project data and management routes.
- Project-isolated JSON collection CRUD with bounded pagination; no SQL is exposed to clients.
- Project-scoped file uploads/downloads/deletion through a local storage adapter, with bounded multipart size and MIME signature checks.
- Project-scoped webhook CRUD and one-time signing secrets; AES-256-GCM encrypted secret storage, HMAC-signed events, and transactional durable delivery queues with bounded retries.
- HTTPS-only webhook delivery with public-IP DNS checks, pinned destinations, redirect rejection, bounded timeouts, and queue backpressure.
- OpenAPI UI at `/documentation`.
- Responsive React administration dashboard at `/admin/`, served from the API origin and backed only by authenticated REST endpoints. It supports guided project setup with optional one-time API key issuance, project-scoped management, and instance-level user administration, safe runtime settings, and platform audit logs for configured administrators. Runtime settings exclude secrets and infrastructure paths.
- Vitest integration tests and a non-root Docker deployment configuration.

Advanced query operators/indexing and scheduled off-host backup retention remain operational follow-ups.

## Requirements

- Node.js 22 LTS (or newer supported even-numbered LTS)
- npm
- Docker and Docker Compose for container deployment

## Local development

For local installation instructions on WSL2/Ubuntu, Windows, and macOS, see [docs/installation.md](./docs/installation.md). Native desktop installers are not yet available.

```powershell
Copy-Item .env.example .env
# Replace JWT_SECRET with a unique random value of at least 32 characters.
npm ci
npm run db:migrate
npm run dev
```

The API listens on `http://localhost:3000`; interactive OpenAPI documentation is available at `http://localhost:3000/documentation`.
`GET /health` is an unauthenticated liveness endpoint.
Set `SMTP_HOST` and `SMTP_FROM` (and both `SMTP_USER`/`SMTP_PASSWORD` if authentication is required) in `.env` to enable password reset and verification emails. Without SMTP, those send/request endpoints return an explicit `503`.
Set `WEBHOOK_ENCRYPTION_KEY` to a cryptographically random 32-byte value encoded as 64 hexadecimal characters to enable webhook creation and delivery. Keep this key private and stable across restarts and database restores; losing it makes stored webhook secrets unusable.
Set `PLATFORM_ADMIN_EMAILS` to a comma-separated allowlist of administrator email addresses. Matching accounts must complete email verification before receiving instance-wide access; configure SMTP to deliver verification messages. Project ownership does not grant platform administration. Allowlisted accounts cannot be deactivated through the admin API; deactivation revokes other accounts' active sessions and pending authentication tokens.

Useful commands:

```powershell
npm run typecheck
npm test
npm run build
npm run admin:dev
npm run db:migrate
npm run db:backup -- .\backups\nanobaas.sqlite
```

Run `npm run admin:dev` in a second terminal alongside `npm run dev` for dashboard development; Vite proxies REST requests to the API. In production, the API serves the built dashboard at `/admin/` from the same origin. The database directory is created automatically. For production, set `NODE_ENV=production`, use a long random `JWT_SECRET`, set `CORS_ORIGINS` to exact trusted origins, and place the service behind TLS termination. Do not expose SQLite files or the API port directly to untrusted networks.

## Docker deployment

Set a production `.env` first. The Compose service binds to loopback by default; route traffic through a TLS reverse proxy. Persistent SQLite data is stored in the `nanobaas-data` named volume.

```powershell
docker compose up --build -d
docker compose logs -f nanobaas
```

The image runs as an unprivileged user with a read-only root filesystem and drops Linux capabilities. The SQLite volume remains writable for the service.

## Backup and restore

Build the CLI tools, then create a consistent online SQLite snapshot. Backup files are verified for SQLite integrity, foreign-key consistency, required tables, and migration checksums before being published. The destination must be new; the command will not overwrite an existing backup.

```powershell
New-Item -ItemType Directory -Force .\backups
npm run build
npm run db:backup -- .\backups\nanobaas-20261115T2200Z.sqlite
npm run db:verify -- .\backups\nanobaas-20261115T2200Z.sqlite
```

Restore only after stopping the API. The confirmation flag is mandatory; the CLI cannot detect whether another process is using the database. It validates the source and staged restore before swapping files, and moves any previous database/WAL/SHM files into a unique `.pre-restore-*` directory for rollback.

```powershell
# Stop npm run dev / the production service before restoring.
npm run db:restore -- --confirm-api-stopped .\backups\nanobaas-20261115T2200Z.sqlite
npm run db:verify -- .\data\nanobaas.sqlite
npm run dev
```

For Docker, create a backup directory in the persistent volume and use a unique filename, for example `docker compose exec nanobaas sh -c 'mkdir -p /app/data/backups && npm run db:backup -- /app/data/backups/nanobaas-20261115T2200Z.sqlite'`; copy verified backups off-host on a schedule. To restore, stop the service and run the compiled restore CLI in a one-off container with the backup directory mounted read-only and the same data volume attached, then start the service again. Keep the webhook encryption key alongside the backup policy; the database alone cannot restore access to encrypted webhook secrets if that key is lost.

Automate daily backup invocation and off-host copying with the host's scheduler, and define a retention policy that matches your recovery requirements. Periodically verify backups and perform a restore test; a successful snapshot alone does not prove recoverability.

## API conventions

Authenticated routes use `Authorization: Bearer <accessToken>`. Successful responses are wrapped in `data`; errors use `{ "error": { "code": "...", "message": "..." } }`. Project and collection routes always scope database operations by both the authenticated user/project membership and the requested project ID.

Initial routes:

- `POST /api/v1/auth/register`, `/login`, `/refresh`, `/logout`
- `GET /api/v1/auth/me`
- `POST /api/v1/auth/password/forgot`, `/password/reset`, `/password/change`
- `POST /api/v1/auth/email/verification/request`, `/email/verify`
- `GET /api/v1/auth/sessions`, `DELETE /api/v1/auth/sessions/:sessionId`
- `GET|POST /api/v1/projects`, `GET|PATCH|DELETE /api/v1/projects/:projectId`
- `GET|POST /api/v1/projects/:projectId/data/:collection`
- `GET|PUT|DELETE /api/v1/projects/:projectId/data/:collection/:recordId`
- `GET|POST /api/v1/projects/:projectId/api-keys`, `DELETE /api/v1/projects/:projectId/api-keys/:keyId`
- `GET|POST /api/v1/projects/:projectId/members`, `DELETE /api/v1/projects/:projectId/members/:userId`
- `GET|POST /api/v1/projects/:projectId/roles`, `PATCH|DELETE /api/v1/projects/:projectId/roles/:roleId`
- `PUT /api/v1/projects/:projectId/members/:userId/roles`, `GET /api/v1/projects/:projectId/permissions`
- `GET|POST /api/v1/projects/:projectId/storage/files`
- `GET|DELETE /api/v1/projects/:projectId/storage/files/:fileId`
- `GET /api/v1/projects/:projectId/storage/files/:fileId/content`
- `GET|POST /api/v1/projects/:projectId/webhooks`
- `PATCH|DELETE /api/v1/projects/:projectId/webhooks/:webhookId`, `POST /api/v1/projects/:projectId/webhooks/:webhookId/rotate-secret`
- `GET /api/v1/projects/:projectId/overview`, `/audit-logs` (project managers only)
- `GET /api/v1/admin/overview`, `/users`, `/settings`, `/audit-logs` (verified allowlisted platform administrators only)
- `PATCH /api/v1/admin/users/:userId` (activate or deactivate a user; deactivation revokes sessions and pending auth tokens)

Project data and file endpoints accept either an access token or an `x-api-key` header, with separate data/file read-write scopes. Collection listing accepts `filter` as a URL-encoded JSON object of up to 10 scalar top-level field values for exact matching (for example `?filter=%7B%22status%22%3A%22published%22%7D`) and `sort` as up to three comma-separated top-level field names; prefix a field with `-` for descending order (for example `?sort=-createdAt,title`). Sorting is stable by record ID; absent fields sort last. Uploads use multipart field `file`; detected PNG, JPEG, GIF, WebP, and PDF content types must match the declared MIME type. `MAX_FILE_BYTES` defaults to 5 MiB and is capped at 10 MiB. Project API keys are shown only on creation; their raw value is never persisted or returned by list endpoints.

Webhook subscriptions support `data.created`, `data.updated`, `data.deleted`, `file.uploaded`, and `file.deleted`. A generated signing secret is shown only when the webhook is created or its secret is rotated. Receivers should verify `X-NanoBaaS-Signature` (`t=<unix timestamp>,v1=<hex HMAC-SHA256>`) against the exact raw request body and reject timestamps more than five minutes from their clock. Webhook URLs cannot contain credentials, query strings, or fragments; use the signed header for receiver authentication. Delivery attempts are durable, limited to five per event, and retained for up to 30 days after completion. A subscription may have at most 100 queued/in-flight events; writes that would exceed this bound fail with `503` rather than silently dropping the event. Delivery is paused unless the encryption key is configured.
