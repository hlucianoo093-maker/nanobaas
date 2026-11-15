import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDatabase, type DatabaseConnection } from "../src/db/index.js";
import type { FastifyInstance } from "fastify";
import type { EmailSender } from "../src/email.js";
import { LocalObjectStorage } from "../src/storage/object-storage.js";
import { signWebhookPayload, verifyWebhookSignature } from "../src/webhooks/crypto.js";
import { WebhookDeliveryError, deliverWebhook, validateWebhookUrl } from "../src/webhooks/transport.js";
import { WebhookDeliveryWorker, type WebhookTransport } from "../src/webhooks/worker.js";

const config = loadConfig({
  NODE_ENV: "test",
  JWT_SECRET: "test-secret-value-that-is-at-least-32-characters-long",
  WEBHOOK_ENCRYPTION_KEY: "a".repeat(64),
  PLATFORM_ADMIN_EMAILS: "platform@example.test,second-platform@example.test"
});

describe("NanoBaaS API", () => {
  let app: FastifyInstance | undefined;
  let database: DatabaseConnection | undefined;
  let temporaryDirectory: string | undefined;

  afterEach(async () => {
    if (app) await app.close();
    database?.close();
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
    app = undefined;
    database = undefined;
    temporaryDirectory = undefined;
  });

  async function setup(emailSender?: EmailSender, webhookTransport?: WebhookTransport) {
    database = createDatabase(":memory:");
    temporaryDirectory = mkdtempSync(join(tmpdir(), "nanobaas-test-"));
    app = await createApp({
      config,
      database,
      storage: new LocalObjectStorage(join(temporaryDirectory, "storage")),
      ...(emailSender ? { emailSender } : {}),
      ...(webhookTransport ? { webhookTransport } : {})
    });
    return app;
  }

  function createTestEmailSender() {
    const messages: { to: string; subject: string; text: string }[] = [];
    const emailSender: EmailSender = {
      async send(to, subject, text) {
        messages.push({ to, subject, text });
      }
    };
    return { emailSender, messages };
  }

  async function register(server: FastifyInstance, email: string) {
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email, password: "correct-horse-battery-staple" }
    });
    expect(response.statusCode).toBe(201);
    return response.json().data as { user: { id: string }; accessToken: string; refreshToken: string };
  }

  it("migrates the SQLite schema with foreign keys and WAL enabled", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "nanobaas-test-"));
    database = createDatabase(join(temporaryDirectory, "test.sqlite"));
    expect(database?.client.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database?.client.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(database?.client.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get()).toBeTruthy();
    expect(database?.client.prepare("SELECT name FROM _nanobaas_migrations").all()).toHaveLength(5);
  });

  it("accepts blank optional SMTP settings and rejects incomplete SMTP configuration", () => {
    const configWithBlankMail = loadConfig({
      NODE_ENV: "test",
      JWT_SECRET: "test-secret-value-that-is-at-least-32-characters-long",
      SMTP_HOST: "",
      SMTP_PORT: "",
      SMTP_USER: "",
      SMTP_PASSWORD: "",
      SMTP_FROM: ""
    });
    expect(configWithBlankMail.SMTP_HOST).toBeUndefined();
    expect(() => loadConfig({
      NODE_ENV: "test",
      JWT_SECRET: "test-secret-value-that-is-at-least-32-characters-long",
      SMTP_HOST: "smtp.example.test"
    })).toThrow("SMTP_HOST and SMTP_FROM are required");
  });

  it("normalizes and validates the configured platform administrator allowlist", () => {
    const adminConfig = loadConfig({
      NODE_ENV: "test",
      JWT_SECRET: "test-secret-value-that-is-at-least-32-characters-long",
      PLATFORM_ADMIN_EMAILS: " Admin@example.test,admin@example.test "
    });
    expect(adminConfig.platformAdminEmails).toEqual(["admin@example.test"]);
    expect(() => loadConfig({
      NODE_ENV: "test",
      JWT_SECRET: "test-secret-value-that-is-at-least-32-characters-long",
      PLATFORM_ADMIN_EMAILS: "not-an-email"
    })).toThrow("Invalid environment configuration");
  });

  it("restricts platform administration to verified allowlisted accounts and revokes deactivated users", async () => {
    const server = await setup();
    const platformAdmin = await register(server, "platform@example.test");
    const secondAdmin = await register(server, "second-platform@example.test");
    const target = await register(server, "target@example.test");
    const headers = { authorization: `Bearer ${platformAdmin.accessToken}` };

    const beforeVerification = await server.inject({
      method: "GET",
      url: "/api/v1/admin/overview",
      headers
    });
    expect(beforeVerification.statusCode).toBe(403);

    database?.client.prepare("UPDATE users SET email_verified_at = ? WHERE id = ?")
      .run(new Date().toISOString(), platformAdmin.user.id);
    database?.client.prepare("UPDATE users SET email_verified_at = ? WHERE id = ?")
      .run(new Date().toISOString(), secondAdmin.user.id);
    const profile = await server.inject({ method: "GET", url: "/api/v1/auth/me", headers });
    expect(profile.json().data.isPlatformAdmin).toBe(true);

    const overview = await server.inject({ method: "GET", url: "/api/v1/admin/overview", headers });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().data.user_count).toBe(3);

    const directory = await server.inject({
      method: "GET",
      url: "/api/v1/admin/users?q=target%40example.test",
      headers
    });
    expect(directory.statusCode).toBe(200);
    expect(directory.json().data).toHaveLength(1);
    expect(directory.json().data[0]).toMatchObject({
      id: target.user.id,
      email: "target@example.test",
      is_active: 1,
      is_platform_admin: false,
      is_platform_admin_configured: false
    });
    expect(directory.json().pagination.total).toBe(1);
    expect(directory.body).not.toContain("password_hash");
    expect(directory.body).not.toContain("refresh_token_hash");

    const unsafeSettings = await server.inject({ method: "GET", url: "/api/v1/admin/settings", headers });
    expect(unsafeSettings.statusCode).toBe(200);
    expect(unsafeSettings.body).not.toContain(config.JWT_SECRET);
    expect(unsafeSettings.body).not.toContain(config.WEBHOOK_ENCRYPTION_KEY);

    const selfDeactivation = await server.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${platformAdmin.user.id}`,
      headers,
      payload: { isActive: false }
    });
    expect(selfDeactivation.statusCode).toBe(409);

    const protectedAdminDeactivation = await server.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${secondAdmin.user.id}`,
      headers,
      payload: { isActive: false }
    });
    expect(protectedAdminDeactivation.statusCode).toBe(409);

    const deactivate = await server.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${target.user.id}`,
      headers,
      payload: { isActive: false }
    });
    expect(deactivate.statusCode).toBe(200);
    expect(deactivate.json().data.is_active).toBe(0);
    const revokedSession = await server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${target.accessToken}` }
    });
    expect(revokedSession.statusCode).toBe(401);

    const audit = await server.inject({ method: "GET", url: "/api/v1/admin/audit-logs", headers });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().data.some((entry: { action: string }) => entry.action === "admin.user.deactivated")).toBe(true);
  });

  it("does not grant platform administration to project owners", async () => {
    const server = await setup();
    const owner = await register(server, "project-owner@example.test");
    const projectResponse = await server.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Regular project", slug: "regular-project" }
    });
    expect(projectResponse.statusCode).toBe(201);
    const denied = await server.inject({
      method: "GET",
      url: "/api/v1/admin/users",
      headers: { authorization: `Bearer ${owner.accessToken}` }
    });
    expect(denied.statusCode).toBe(403);
  });

  it("publishes OpenAPI documentation with both supported auth schemes", async () => {
    const server = await setup();
    const response = await server.inject({ method: "GET", url: "/documentation/json" });
    expect(response.statusCode).toBe(200);
    const document = response.json();
    expect(document.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
    expect(document.components.securitySchemes.apiKeyAuth.name).toBe("x-api-key");
    expect(document.paths["/api/v1/admin/users"].get.security).toEqual([{ bearerAuth: [] }]);
    const listData = document.paths["/api/v1/projects/{projectId}/data/{collection}"].get;
    expect(listData.parameters.map((parameter: { name: string }) => parameter.name))
      .toEqual(expect.arrayContaining(["limit", "offset", "filter", "sort"]));
  });

  it("does not echo invalid password values in validation errors", async () => {
    const server = await setup();
    const password = "short";
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "validation@example.test", password }
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(password);
  });

  it("rotates refresh tokens and revokes sessions on token reuse", async () => {
    const server = await setup();
    const credentials = await register(server, "owner@example.test");
    const rotated = await server.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: credentials.refreshToken }
    });
    expect(rotated.statusCode).toBe(200);
    const nextRefreshToken = rotated.json().data.refreshToken as string;

    const reuse = await server.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: credentials.refreshToken }
    });
    expect(reuse.statusCode).toBe(401);
    const revoked = await server.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: nextRefreshToken }
    });
    expect(revoked.statusCode).toBe(401);
  });

  it("prevents access to projects and records belonging to another user", async () => {
    const server = await setup();
    const owner = await register(server, "owner@example.test");
    const outsider = await register(server, "outsider@example.test");
    const projectResponse = await server.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Private project", slug: "private-project" }
    });
    expect(projectResponse.statusCode).toBe(201);
    const projectId = projectResponse.json().data.id as string;

    const hiddenProject = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}`,
      headers: { authorization: `Bearer ${outsider.accessToken}` }
    });
    expect(hiddenProject.statusCode).toBe(404);

    const hiddenData = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/data/notes`,
      headers: { authorization: `Bearer ${outsider.accessToken}` }
    });
    expect(hiddenData.statusCode).toBe(404);

    const created = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/data/notes`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { title: "Scoped record" }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data.document.title).toBe("Scoped record");
  });

  it("filters and sorts only validated top-level JSON fields before applying pagination", async () => {
    const server = await setup();
    const user = await register(server, "query@example.test");
    const projectResponse = await server.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { name: "Query project", slug: "query-project" }
    });
    const projectId = projectResponse.json().data.id as string;
    const headers = { authorization: `Bearer ${user.accessToken}` };
    const records = [
      { status: "published", score: 10, title: "Beta", enabled: true },
      { status: "draft", score: 30, title: "Alpha", enabled: false },
      { status: "published", score: 20, title: "Alpha", enabled: true },
      { status: null, score: 15, title: "Gamma" },
      { score: 40, title: "Missing status" }
    ];
    for (const document of records) {
      const response = await server.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/data/articles`,
        headers,
        payload: document
      });
      expect(response.statusCode).toBe(201);
    }

    const filter = encodeURIComponent(JSON.stringify({ status: "published" }));
    const sortedPage = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/data/articles?filter=${filter}&sort=-score%2Ctitle&limit=1&offset=1`,
      headers
    });
    expect(sortedPage.statusCode).toBe(200);
    expect(sortedPage.json().data).toHaveLength(1);
    expect(sortedPage.json().data[0].document.score).toBe(10);
    expect(sortedPage.json().pagination).toEqual({ limit: 1, offset: 1 });

    const booleanFilter = encodeURIComponent(JSON.stringify({ enabled: true }));
    const enabled = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/data/articles?filter=${booleanFilter}`,
      headers
    });
    expect(enabled.json().data).toHaveLength(2);
    const nullFilter = encodeURIComponent(JSON.stringify({ status: null }));
    const explicitNull = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/data/articles?filter=${nullFilter}`,
      headers
    });
    expect(explicitNull.json().data).toHaveLength(1);
    const sortedMissing = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/data/articles?sort=enabled`,
      headers
    });
    expect(sortedMissing.json().data.slice(0, 3).map((row: { document: { enabled: boolean } }) => row.document.enabled))
      .toEqual([false, true, true]);
    expect(sortedMissing.json().data.slice(3).every((row: { document: Record<string, unknown> }) => !("enabled" in row.document)))
      .toBe(true);

    for (const query of [
      "?filter=%7Bbroken",
      `?filter=${encodeURIComponent(JSON.stringify({ "score); DROP TABLE collection_records": 1 }))}`,
      "?sort=score%20DESC",
      "?sort=-score,-score"
    ]) {
      const invalid = await server.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}/data/articles${query}`,
        headers
      });
      expect(invalid.statusCode).toBe(400);
    }
    const stillThere = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/data/articles`,
      headers
    });
    expect(stillThere.json().data).toHaveLength(records.length);
  });

  it("provides project-scoped overview and audit data only to project managers", async () => {
    const server = await setup();
    const owner = await register(server, "overview-owner@example.test");
    const member = await register(server, "overview-member@example.test");
    const projectResponse = await server.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Overview project", slug: "overview-project" }
    });
    const projectId = projectResponse.json().data.id as string;
    const ownerHeaders = { authorization: `Bearer ${owner.accessToken}` };
    await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/data/notes`,
      headers: ownerHeaders,
      payload: { title: "Counted record" }
    });
    await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/api-keys`,
      headers: ownerHeaders,
      payload: { name: "Dashboard key", permissions: ["data:read"] }
    });
    const added = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/members`,
      headers: ownerHeaders,
      payload: { email: "overview-member@example.test" }
    });
    expect(added.statusCode).toBe(201);

    const overview = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/overview`,
      headers: ownerHeaders
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().data).toMatchObject({
      id: projectId,
      member_count: 2,
      record_count: 1,
      active_api_key_count: 1,
      file_count: 0,
      role_count: 0,
      active_webhook_count: 0
    });
    const auditLogs = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/audit-logs?limit=10`,
      headers: ownerHeaders
    });
    expect(auditLogs.statusCode).toBe(200);
    expect(auditLogs.json().data.some((entry: { action: string }) => entry.action === "project.created")).toBe(true);

    for (const endpoint of ["overview", "audit-logs"]) {
      const forbidden = await server.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}/${endpoint}`,
        headers: { authorization: `Bearer ${member.accessToken}` }
      });
      expect(forbidden.statusCode).toBe(403);
    }
  });

  it("rejects malformed project data and untrusted input fields", async () => {
    const server = await setup();
    const user = await register(server, "validation@example.test");
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { name: "Bad project", slug: "../other", projectId: "attacker-controlled" }
    });
    expect(response.statusCode).toBe(400);
  });

  it("issues project-scoped API keys, enforces permissions, and revokes them", async () => {
    const server = await setup();
    const user = await register(server, "keys@example.test");
    const projectResponse = await server.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { name: "Key project", slug: "key-project" }
    });
    const projectId = projectResponse.json().data.id as string;
    const keyResponse = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/api-keys`,
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { name: "Reader", permissions: ["data:read"] }
    });
    expect(keyResponse.statusCode).toBe(201);
    const key = keyResponse.json().data.key as string;
    expect(key).toMatch(/^nbk_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    const storedHash = database?.client.prepare("SELECT key_hash FROM api_keys").get() as { key_hash: string };
    expect(storedHash.key_hash).not.toBe(key);

    const read = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/data/notes`,
      headers: { "x-api-key": key }
    });
    expect(read.statusCode).toBe(200);
    const write = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/data/notes`,
      headers: { "x-api-key": key },
      payload: { title: "Not allowed" }
    });
    expect(write.statusCode).toBe(403);

    const list = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/api-keys`,
      headers: { authorization: `Bearer ${user.accessToken}` }
    });
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).not.toContain(key);

    const revoke = await server.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/api-keys/${keyResponse.json().data.id}`,
      headers: { authorization: `Bearer ${user.accessToken}` }
    });
    expect(revoke.statusCode).toBe(204);
    const deniedAfterRevoke = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/data/notes`,
      headers: { "x-api-key": key }
    });
    expect(deniedAfterRevoke.statusCode).toBe(401);
  });

  it("enforces project role permissions and prevents cross-project role assignment", async () => {
    const server = await setup();
    const owner = await register(server, "rbac-owner@example.test");
    const member = await register(server, "rbac-member@example.test");
    const firstProject = await server.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "First", slug: "first" }
    });
    const firstProjectId = firstProject.json().data.id as string;
    const secondProject = await server.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Second", slug: "second" }
    });
    const secondProjectId = secondProject.json().data.id as string;

    const addMember = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${firstProjectId}/members`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { email: "rbac-member@example.test" }
    });
    expect(addMember.statusCode).toBe(201);
    const roleA = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${firstProjectId}/roles`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "reader", permissions: ["data:read"] }
    });
    expect(roleA.statusCode).toBe(201);
    const roleB = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${secondProjectId}/roles`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "other-project-role", permissions: ["data:write"] }
    });
    expect(roleB.statusCode).toBe(201);

    const crossProjectAssignment = await server.inject({
      method: "PUT",
      url: `/api/v1/projects/${firstProjectId}/members/${member.user.id}/roles`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { roleIds: [roleB.json().data.id] }
    });
    expect(crossProjectAssignment.statusCode).toBe(400);

    const assignment = await server.inject({
      method: "PUT",
      url: `/api/v1/projects/${firstProjectId}/members/${member.user.id}/roles`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { roleIds: [roleA.json().data.id] }
    });
    expect(assignment.statusCode).toBe(200);
    const read = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${firstProjectId}/data/records`,
      headers: { authorization: `Bearer ${member.accessToken}` }
    });
    expect(read.statusCode).toBe(200);
    const write = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${firstProjectId}/data/records`,
      headers: { authorization: `Bearer ${member.accessToken}` },
      payload: { value: "denied" }
    });
    expect(write.statusCode).toBe(403);

    const updateRole = await server.inject({
      method: "PATCH",
      url: `/api/v1/projects/${firstProjectId}/roles/${roleA.json().data.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { permissions: ["data:read", "data:write"] }
    });
    expect(updateRole.statusCode).toBe(200);
    const writeAfterGrant = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${firstProjectId}/data/records`,
      headers: { authorization: `Bearer ${member.accessToken}` },
      payload: { value: "permitted" }
    });
    expect(writeAfterGrant.statusCode).toBe(201);

    const removeMember = await server.inject({
      method: "DELETE",
      url: `/api/v1/projects/${firstProjectId}/members/${member.user.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` }
    });
    expect(removeMember.statusCode).toBe(204);
    const noLongerMember = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${firstProjectId}/data/records`,
      headers: { authorization: `Bearer ${member.accessToken}` }
    });
    expect(noLongerMember.statusCode).toBe(404);
  });

  it("sends one-time password reset tokens and invalidates prior sessions", async () => {
    const mail = createTestEmailSender();
    const server = await setup(mail.emailSender);
    const credentials = await register(server, "reset@example.test");
    const unknownEmail = await server.inject({
      method: "POST",
      url: "/api/v1/auth/password/forgot",
      payload: { email: "unknown@example.test" }
    });
    expect(unknownEmail.statusCode).toBe(202);
    expect(mail.messages).toHaveLength(0);

    const forgot = await server.inject({
      method: "POST",
      url: "/api/v1/auth/password/forgot",
      payload: { email: "reset@example.test" }
    });
    expect(forgot.statusCode).toBe(202);
    const resetToken = /Reset token: ([A-Za-z0-9_-]+)/.exec(mail.messages[0]?.text ?? "")?.[1];
    expect(resetToken).toBeTruthy();

    const reset = await server.inject({
      method: "POST",
      url: "/api/v1/auth/password/reset",
      payload: { token: resetToken, password: "a-different-secure-password" }
    });
    expect(reset.statusCode).toBe(200);
    const replay = await server.inject({
      method: "POST",
      url: "/api/v1/auth/password/reset",
      payload: { token: resetToken, password: "another-secure-password" }
    });
    expect(replay.statusCode).toBe(400);

    const oldSession = await server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${credentials.accessToken}` }
    });
    expect(oldSession.statusCode).toBe(401);
    const oldPasswordLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "reset@example.test", password: "correct-horse-battery-staple" }
    });
    expect(oldPasswordLogin.statusCode).toBe(401);
    const newPasswordLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "reset@example.test", password: "a-different-secure-password" }
    });
    expect(newPasswordLogin.statusCode).toBe(200);
  });

  it("verifies email using hashed, single-use verification tokens", async () => {
    const mail = createTestEmailSender();
    const server = await setup(mail.emailSender);
    const credentials = await register(server, "verify@example.test");
    const requestVerification = await server.inject({
      method: "POST",
      url: "/api/v1/auth/email/verification/request",
      headers: { authorization: `Bearer ${credentials.accessToken}` }
    });
    expect(requestVerification.statusCode).toBe(202);
    const token = /token: ([A-Za-z0-9_-]+)/.exec(mail.messages[0]?.text ?? "")?.[1];
    expect(token).toBeTruthy();

    const verify = await server.inject({
      method: "POST",
      url: "/api/v1/auth/email/verify",
      payload: { token }
    });
    expect(verify.statusCode).toBe(200);
    const profile = await server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${credentials.accessToken}` }
    });
    expect(profile.json().data.email_verified_at).toBeTruthy();
    const replay = await server.inject({
      method: "POST",
      url: "/api/v1/auth/email/verify",
      payload: { token }
    });
    expect(replay.statusCode).toBe(400);
  });

  it("supports session revocation and password changes with reauthentication", async () => {
    const server = await setup();
    const initial = await register(server, "sessions@example.test");
    const secondLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "sessions@example.test", password: "correct-horse-battery-staple" }
    });
    const secondSessionRefresh = secondLogin.json().data.refreshToken as string;
    const sessions = await server.inject({
      method: "GET",
      url: "/api/v1/auth/sessions",
      headers: { authorization: `Bearer ${initial.accessToken}` }
    });
    const secondSessionId = secondSessionRefresh.split(".")[0];
    expect(sessions.json().data).toHaveLength(2);
    expect(sessions.body).not.toContain("refresh_token_hash");

    const revokeSession = await server.inject({
      method: "DELETE",
      url: `/api/v1/auth/sessions/${secondSessionId}`,
      headers: { authorization: `Bearer ${initial.accessToken}` }
    });
    expect(revokeSession.statusCode).toBe(204);
    const revokedRefresh = await server.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: secondSessionRefresh }
    });
    expect(revokedRefresh.statusCode).toBe(401);

    const changePassword = await server.inject({
      method: "POST",
      url: "/api/v1/auth/password/change",
      headers: { authorization: `Bearer ${initial.accessToken}` },
      payload: { currentPassword: "correct-horse-battery-staple", newPassword: "brand-new-secure-password" }
    });
    expect(changePassword.statusCode).toBe(200);
    const oldAccessToken = await server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${initial.accessToken}` }
    });
    expect(oldAccessToken.statusCode).toBe(401);
    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "sessions@example.test", password: "brand-new-secure-password" }
    });
    expect(login.statusCode).toBe(200);
  });

  it("stores validated files per project and protects download and deletion", async () => {
    const server = await setup();
    const owner = await register(server, "files-owner@example.test");
    const outsider = await register(server, "files-outsider@example.test");
    const projectResponse = await server.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "File project", slug: "file-project" }
    });
    const projectId = projectResponse.json().data.id as string;
    const boundary = "nanobaas-test-boundary";
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Yl8AAAAASUVORK5CYII=",
      "base64"
    );
    const multipartBody = (mimeType: string, fileData = png) => Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="../../pixel.png"\r\nContent-Type: ${mimeType}\r\n\r\n`),
      fileData,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    const upload = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/storage/files`,
      headers: {
        authorization: `Bearer ${owner.accessToken}`,
        "content-type": `multipart/form-data; boundary=${boundary}`
      },
      payload: multipartBody("image/png")
    });
    expect(upload.statusCode).toBe(201);
    const file = upload.json().data as { id: string; name: string; mimeType: string; sizeBytes: number };
    expect(file.name).toBe("pixel.png");
    expect(file.mimeType).toBe("image/png");
    expect(file.sizeBytes).toBe(png.length);

    const mismatch = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/storage/files`,
      headers: {
        authorization: `Bearer ${owner.accessToken}`,
        "content-type": `multipart/form-data; boundary=${boundary}`
      },
      payload: multipartBody("application/pdf")
    });
    expect(mismatch.statusCode).toBe(415);

    const oversizedData = Buffer.concat([png, Buffer.alloc(config.MAX_FILE_BYTES)]);
    const oversized = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/storage/files`,
      headers: {
        authorization: `Bearer ${owner.accessToken}`,
        "content-type": `multipart/form-data; boundary=${boundary}`
      },
      payload: multipartBody("image/png", oversizedData)
    });
    expect(oversized.statusCode).toBe(413);

    const denied = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/storage/files/${file.id}/content`,
      headers: { authorization: `Bearer ${outsider.accessToken}` }
    });
    expect(denied.statusCode).toBe(404);

    const download = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/storage/files/${file.id}/content`,
      headers: { authorization: `Bearer ${owner.accessToken}` }
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe("image/png");
    expect(download.rawPayload.equals(png)).toBe(true);

    const fileKeyResponse = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/api-keys`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "file reader", permissions: ["files:read"] }
    });
    const fileKey = fileKeyResponse.json().data.key as string;
    const keyDownload = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/storage/files/${file.id}/content`,
      headers: { "x-api-key": fileKey }
    });
    expect(keyDownload.statusCode).toBe(200);
    const keyCannotReadData = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/data/records`,
      headers: { "x-api-key": fileKey }
    });
    expect(keyCannotReadData.statusCode).toBe(403);

    const remove = await server.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/storage/files/${file.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` }
    });
    expect(remove.statusCode).toBe(204);
    const missing = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/storage/files/${file.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` }
    });
    expect(missing.statusCode).toBe(404);
  });

  it("isolates webhook management and signs durable project-scoped event deliveries", async () => {
    const sent: { target: string; secret: string; event: string; body: string }[] = [];
    const transport: WebhookTransport = async (target, secret, _eventId, event, body) => {
      sent.push({ target, secret, event, body });
    };
    const server = await setup(undefined, transport);
    const owner = await register(server, "webhook-owner@example.test");
    const outsider = await register(server, "webhook-outsider@example.test");
    const projectResponse = await server.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Webhook project", slug: "webhook-project" }
    });
    const projectId = projectResponse.json().data.id as string;
    const ownerHeaders = { authorization: `Bearer ${owner.accessToken}` };
    const addedMember = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/members`,
      headers: ownerHeaders,
      payload: { email: "webhook-outsider@example.test" }
    });
    expect(addedMember.statusCode).toBe(201);
    const forbidden = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/webhooks`,
      headers: { authorization: `Bearer ${outsider.accessToken}` },
      payload: { url: "https://hooks.example.test/receive", events: ["data.created"] }
    });
    expect(forbidden.statusCode).toBe(403);
    const hidden = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/webhooks`,
      headers: { authorization: `Bearer ${outsider.accessToken}` }
    });
    expect(hidden.statusCode).toBe(403);

    const insecureUrl = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/webhooks`,
      headers: ownerHeaders,
      payload: { url: "http://hooks.example.test/receive", events: ["data.created"] }
    });
    expect(insecureUrl.statusCode).toBe(400);

    const created = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/webhooks`,
      headers: ownerHeaders,
      payload: { url: "https://hooks.example.test/receive", events: ["data.created", "data.deleted"] }
    });
    expect(created.statusCode).toBe(201);
    const webhook = created.json().data as { id: string; secret: string };
    expect(webhook.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const stored = database?.client.prepare("SELECT secret_hash, secret_ciphertext FROM webhooks WHERE id = ?")
      .get(webhook.id) as { secret_hash: string; secret_ciphertext: string };
    expect(stored.secret_hash).not.toBe(webhook.secret);
    expect(stored.secret_ciphertext).not.toContain(webhook.secret);
    const listed = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/webhooks`,
      headers: ownerHeaders
    });
    expect(listed.statusCode).toBe(200);
    expect(JSON.stringify(listed.json())).not.toContain(webhook.secret);
    expect(JSON.stringify(listed.json())).not.toContain(stored.secret_ciphertext);

    const record = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/data/notes`,
      headers: ownerHeaders,
      payload: { privateContent: "not copied into delivery payload" }
    });
    expect(record.statusCode).toBe(201);
    const queued = database?.client.prepare("SELECT event, payload, status FROM webhook_deliveries").get() as {
      event: string; payload: string; status: string
    };
    expect(queued.event).toBe("data.created");
    expect(queued.status).toBe("pending");
    expect(queued.payload).not.toContain("privateContent");

    const worker = new WebhookDeliveryWorker(
      database!.client,
      Buffer.from(config.WEBHOOK_ENCRYPTION_KEY!, "hex"),
      transport
    );
    expect(await worker.runOnce()).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.target).toBe("https://hooks.example.test/receive");
    expect(sent[0]?.secret).toBe(webhook.secret);
    expect(sent[0]?.event).toBe("data.created");
    const deliveryBody = sent[0]?.body ?? "";
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signWebhookPayload(webhook.secret, timestamp, deliveryBody);
    expect(verifyWebhookSignature(signature, webhook.secret, deliveryBody, timestamp)).toBe(true);
    expect(verifyWebhookSignature(signature, webhook.secret, `${deliveryBody} `, timestamp)).toBe(false);
    expect(verifyWebhookSignature(signature, webhook.secret, deliveryBody, timestamp + 301)).toBe(false);

    const rotated = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/webhooks/${webhook.id}/rotate-secret`,
      headers: ownerHeaders
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().data.secret).not.toBe(webhook.secret);
    await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/data/notes`,
      headers: ownerHeaders,
      payload: { title: "Cancel when disabled" }
    });
    const disabled = await server.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/webhooks/${webhook.id}`,
      headers: ownerHeaders,
      payload: { isActive: false }
    });
    expect(disabled.statusCode).toBe(200);
    expect(database?.client.prepare("SELECT status FROM webhook_deliveries ORDER BY created_at DESC LIMIT 1").get())
      .toEqual({ status: "cancelled" });
  });

  it("retries webhook failures with a finite attempt limit and rejects private destinations", async () => {
    const server = await setup();
    const owner = await register(server, "webhook-retry@example.test");
    const projectResponse = await server.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Retry project", slug: "retry-project" }
    });
    const projectId = projectResponse.json().data.id as string;
    const headers = { authorization: `Bearer ${owner.accessToken}` };
    const created = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/webhooks`,
      headers,
      payload: { url: "https://hooks.example.test/retry", events: ["data.created"] }
    });
    expect(created.statusCode).toBe(201);
    await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/data/notes`,
      headers,
      payload: { title: "Retry me" }
    });
    const worker = new WebhookDeliveryWorker(
      database!.client,
      Buffer.from(config.WEBHOOK_ENCRYPTION_KEY!, "hex"),
      async () => { throw new WebhookDeliveryError("network_error"); }
    );
    const now = new Date();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      database?.client.prepare("UPDATE webhook_deliveries SET next_attempt_at = ? WHERE status = 'pending'")
        .run(new Date(now.getTime() - 1000).toISOString());
      expect(await worker.runOnce(now)).toBe(true);
    }
    const delivery = database?.client.prepare("SELECT status, attempts, last_error FROM webhook_deliveries").get() as {
      status: string; attempts: number; last_error: string
    };
    expect(delivery).toEqual({ status: "failed", attempts: 5, last_error: "network_error" });
    await expect(deliverWebhook("https://127.0.0.1/", "secret", "event-id", "data.created", "{}"))
      .rejects.toMatchObject({ code: "non_public_destination" });
    await expect(deliverWebhook("https://169.254.169.254/latest/meta-data/", "secret", "event-id", "data.created", "{}"))
      .rejects.toMatchObject({ code: "non_public_destination" });
    expect(validateWebhookUrl("https://localhost/receive")).toBeNull();
    expect(validateWebhookUrl("https://user:pass@hooks.example.test/")).toBeNull();
    expect(validateWebhookUrl("https://hooks.example.test/receive?token=secret")).toBeNull();
  });

  it("rolls back data mutations rather than dropping events when the bounded queue is full", async () => {
    const server = await setup();
    const owner = await register(server, "webhook-queue@example.test");
    const projectResponse = await server.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Queue project", slug: "queue-project" }
    });
    const projectId = projectResponse.json().data.id as string;
    const created = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/webhooks`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { url: "https://hooks.example.test/queue", events: ["data.created"] }
    });
    expect(created.statusCode).toBe(201);
    const webhookId = created.json().data.id as string;
    const insertDelivery = database?.client.prepare(`
      INSERT INTO webhook_deliveries
        (id, webhook_id, project_id, event, payload, status, attempts, next_attempt_at, created_at)
      VALUES (?, ?, ?, 'data.created', '{}', 'pending', 0, ?, ?)
    `);
    const now = new Date().toISOString();
    for (let index = 0; index < 100; index += 1) {
      insertDelivery?.run(randomUUID(), webhookId, projectId, now, now);
    }

    const rejectedMutation = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/data/notes`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { title: "Must not be committed without an event" }
    });
    expect(rejectedMutation.statusCode).toBe(503);
    expect(rejectedMutation.json().error.code).toBe("WEBHOOK_QUEUE_FULL");
    expect(database?.client.prepare("SELECT COUNT(*) AS count FROM collection_records WHERE project_id = ?")
      .get(projectId)).toEqual({ count: 0 });
    expect(database?.client.prepare("SELECT COUNT(*) AS count FROM webhook_deliveries WHERE webhook_id = ?")
      .get(webhookId)).toEqual({ count: 100 });
  });

  it("reports unavailable mail delivery instead of returning unusable reset responses", async () => {
    const server = await setup();
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/password/forgot",
      payload: { email: "nobody@example.test" }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("EMAIL_DELIVERY_UNAVAILABLE");
  });
});
