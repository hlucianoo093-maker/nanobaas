# Architecture and security notes

The API is a single Node.js process. Fastify owns HTTP concerns, Zod validates request values, services/routes enforce authorization before database access, and SQLite operations are parameterized. Drizzle schema definitions document the relational model; the ordered SQL migrations are the schema source applied at startup.

SQLite is configured for WAL, foreign keys, a five-second busy timeout and `synchronous=NORMAL`. `collection_records` keys each document by project and collection. Every collection query includes the project ID; no client-supplied SQL or table names are executed.

Collection list filters and sort expressions support only validated top-level field names. Filters are URL-encoded JSON objects with at most ten scalar equality conditions; sorting supports up to three fields and explicit ascending/descending order. Field names are constrained and JSON paths, filter values, pagination values, and project/collection scope are bound as SQL parameters. The API does not expose SQL, arbitrary JSON paths, nested field expressions, or operator syntax. Missing values sort last and record ID provides a stable tie-break.

Refresh tokens are random, opaque, session-ID-prefixed values. Only their SHA-256 digests are persisted. Rotation uses a conditional update; presenting an old token revokes the user's active sessions. Access JWTs expire after 15 minutes and are checked against the session and active account on each authenticated request so logout/reuse revocation takes effect immediately.

Project API keys are random 256-bit secrets, stored only as SHA-256 digests, and scoped to one project plus explicit data/file read/write permissions. Keys are expiry-checked and revocable; the last-used timestamp is updated on valid use. Project data and storage handlers accept API keys only after matching the requested project ID and required scope.

Project members are added by an existing account's email and default to no data permissions. Roles and permission assignments are project-scoped; composite foreign keys prevent assigning a role from another project. Owners retain administrative access. Other members must have the specific permission for collection operations or management endpoints. Removing a member cascades role assignments and immediately removes their project access.

Password-reset and email-verification tokens are cryptographically random, single-use, time-limited, and stored only as SHA-256 digests. Token consumption, password/email changes, session revocation, and audit entries are transactional. Resetting/changing a password revokes active sessions. SMTP credentials are optional environment settings; token delivery endpoints fail explicitly with `503` when mail is not configured.

Uploads are size-capped by the multipart parser, identified by file signatures, and restricted to PNG, JPEG, GIF, WebP, and PDF. Caller-provided file names are sanitized and never used as storage paths. Local objects are written to random UUID-based keys using an atomic temporary-file rename; downloads are authenticated, sent as attachments, and marked `nosniff` and `no-store`.

Webhook management requires the project-level `webhooks:manage` permission. Signing secrets are generated from cryptographic randomness, stored as SHA-256 digests for comparison and AES-256-GCM ciphertext for delivery, and revealed only on create/rotation. Configure `WEBHOOK_ENCRYPTION_KEY` as 32 random bytes represented by 64 hex characters; preserve it with database backups. Losing or changing the key prevents decryption of existing secrets.

Collection and file mutations enqueue matching webhook events in the same SQLite transaction as their state change. Event bodies contain resource identifiers and bounded metadata, not arbitrary collection documents. Each subscription is limited to 100 pending/in-flight deliveries; queue saturation rolls back the triggering mutation and returns `503`. The single-process worker claims deliveries with SQLite leases, sends HTTPS requests signed over the exact JSON body and timestamp, retries with exponential backoff up to five total attempts, and prunes completed history after 30 days.

Webhook destinations must use HTTPS on port 443, without URL credentials, query strings, or fragments; receiver authentication should use the signed request header. Before each delivery, all DNS answers are checked and any non-public result rejects the destination; the request is pinned to a validated IP address with the original host used for TLS verification. Redirects are not followed, and requests have bounded timeouts. This prevents private-address access and DNS-rebinding between validation and connection.

Project IDs in URLs are not proof of access: each project operation checks membership or a matching project API key, then enforces the required permission. Unknown project IDs return 404 rather than revealing whether another user's project exists.

The React admin dashboard is built as static assets and served by the API under `/admin/`. It uses same-origin REST requests, keeps access and refresh tokens only in memory, and rotates refresh tokens through the existing auth endpoint. Project overview and audit-log APIs require the project-management permission; member, key, role, storage, and webhook APIs continue to enforce their individual project scopes. No dashboard business rules or direct database access are added to the frontend.

Instance administrators are selected by the `PLATFORM_ADMIN_EMAILS` environment allowlist, not by project roles or client-supplied identity. The email must be verified and the account active on each protected request; an unverified registration matching an allowlisted address receives no administrative access. The platform API exposes only bounded user listings, safe runtime settings, aggregate counts, and platform-scope audit events. User deactivation preserves project data but atomically disables the account, revokes its sessions, consumes outstanding auth tokens, and writes an audit event. Self-deactivation and deactivation of configured administrator accounts are rejected. Secrets, credentials, database paths, and editable environment configuration are never returned by the settings endpoint.

Database backup uses SQLite's online backup API to snapshot a live WAL database into a new file, then verifies integrity, foreign keys, required tables, and the migration-checksum prefix before atomically publishing it without overwriting an existing file. Restore requires explicit confirmation that the API is stopped; it stages and verifies the replacement first, then moves the old database and WAL/SHM sidecars to a uniquely named rollback directory before installing the snapshot. Backup verification does not run migrations or modify the source database. Scheduling, off-host replication, and retention are delegated to deployment tooling rather than an in-process job system.

## Migration policy

Migrations are applied in lexical order, each in a SQLite transaction. Applied migration checksums are stored in `_nanobaas_migrations`; editing an applied migration is treated as a startup error. Add a new numbered SQL migration for schema changes.

## Known scope limits

The current release is an initial backend foundation. It does not yet include advanced collection query operators/indexing or automated off-host backup retention. These should be completed in separate phases before exposing a general-purpose production BaaS.
