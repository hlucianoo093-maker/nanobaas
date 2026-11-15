import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import fastifyStatic from "@fastify/static";
import argon2 from "argon2";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileTypeFromBuffer } from "file-type";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { createDatabase, type DatabaseConnection } from "./db/index.js";
import { createEmailSender, type EmailSender } from "./email.js";
import { LocalObjectStorage, type ObjectStorage } from "./storage/object-storage.js";
import { encryptWebhookSecret } from "./webhooks/crypto.js";
import { enqueueWebhookEvent } from "./webhooks/queue.js";
import { validateWebhookUrl } from "./webhooks/transport.js";
import { deliverWebhook } from "./webhooks/transport.js";
import { WebhookDeliveryWorker, type WebhookTransport } from "./webhooks/worker.js";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; email: string; sid: string };
    user: { sub: string; email: string; sid: string };
  }
}

type AppOptions = {
  config: AppConfig;
  database?: DatabaseConnection;
  emailSender?: EmailSender;
  storage?: ObjectStorage;
  webhookTransport?: WebhookTransport;
};

const registerSchema = z.object({
  email: z.string().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(12).max(128)
}).strict();
const loginSchema = registerSchema;
const refreshSchema = z.object({ refreshToken: z.string().min(32).max(256) }).strict();
const projectCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
}).strict();
const projectUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  settings: z.record(z.string(), z.unknown()).optional()
}).strict().refine((value) => Object.keys(value).length > 0);
const documentSchema = z.record(z.string(), z.unknown());
const dataFilterSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/),
  z.union([z.string().max(256), z.number().finite(), z.boolean(), z.null()])
).superRefine((filters, context) => {
  if (Object.keys(filters).length > 10) {
    context.addIssue({ code: "custom", message: "At most 10 fields may be filtered" });
  }
});
const dataSortSchema = z.string().max(256).refine((value) => {
  const fields = value.split(",").map((field) => field.startsWith("-") ? field.slice(1) : field);
  return fields.length > 0 && fields.length <= 3
    && fields.every((field) => /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(field))
    && new Set(fields).size === fields.length;
}, "Sort must contain up to three unique top-level field names");
const collectionParamsSchema = z.object({
  projectId: z.string().uuid(),
  collection: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/)
});
const apiKeyCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  permissions: z.array(z.enum(["data:read", "data:write", "files:read", "files:write"])).min(1).max(4),
  expiresAt: z.string().datetime().optional()
}).strict().refine((value) => new Set(value.permissions).size === value.permissions.length);
const memberCreateSchema = z.object({
  email: z.string().email().max(254).transform((value) => value.toLowerCase())
}).strict();
const roleNameSchema = z.string().trim().min(2).max(50).regex(/^[a-z][a-z0-9_-]*$/)
  .refine((name) => name !== "owner" && name !== "member");
const roleCreateSchema = z.object({
  name: roleNameSchema,
  description: z.string().trim().max(500).default(""),
  permissions: z.array(z.string().min(1).max(100)).max(32)
}).strict().refine((value) => new Set(value.permissions).size === value.permissions.length);
const roleUpdateSchema = z.object({
  name: roleNameSchema.optional(),
  description: z.string().trim().max(500).optional(),
  permissions: z.array(z.string().min(1).max(100)).max(32).optional()
}).strict().refine((value) => Object.keys(value).length > 0)
  .refine((value) => !value.permissions || new Set(value.permissions).size === value.permissions.length);
const userRoleAssignSchema = z.object({
  roleIds: z.array(z.string().uuid()).max(32)
}).strict().refine((value) => new Set(value.roleIds).size === value.roleIds.length);
const emailSchema = z.object({
  email: z.string().email().max(254).transform((value) => value.toLowerCase())
}).strict();
const authTokenSchema = z.object({
  token: z.string().min(32).max(256)
}).strict();
const passwordResetSchema = authTokenSchema.extend({
  password: z.string().min(12).max(128)
}).strict();
const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(12).max(128)
}).strict().refine((value) => value.currentPassword !== value.newPassword);
const webhookEvents = ["data.created", "data.updated", "data.deleted", "file.uploaded", "file.deleted"] as const;
const webhookCreateSchema = z.object({
  url: z.string().url().max(2048),
  events: z.array(z.enum(webhookEvents)).min(1).max(webhookEvents.length)
}).strict().refine((value) => new Set(value.events).size === value.events.length);
const webhookUpdateSchema = z.object({
  url: z.string().url().max(2048).optional(),
  events: z.array(z.enum(webhookEvents)).min(1).max(webhookEvents.length).optional(),
  isActive: z.boolean().optional()
}).strict().refine((value) => Object.keys(value).length > 0)
  .refine((value) => !value.events || new Set(value.events).size === value.events.length);

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newRefreshToken(sessionId: string): string {
  return `${sessionId}.${randomBytes(32).toString("base64url")}`;
}

function getSessionId(token: string): string | null {
  const [sessionId, secret, ...extra] = token.split(".");
  if (!sessionId || !secret || extra.length || !/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  return sessionId;
}

function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const details = parsed.error.issues.map(({ code, path, message }) => ({ code, path, message }));
    throw Object.assign(new Error("Request validation failed"), { statusCode: 400, code: "VALIDATION_ERROR", details });
  }
  return parsed.data;
}

function parseDataFilters(value: string | undefined): Record<string, string | number | boolean | null> {
  if (value === undefined) return {};
  let filters: unknown;
  try {
    filters = JSON.parse(value);
  } catch {
    throw Object.assign(new Error("Filter must be a JSON object"), { statusCode: 400, code: "VALIDATION_ERROR" });
  }
  return parseBody(dataFilterSchema, filters);
}

function parseDataSort(value: string | undefined): { field: string; direction: "ASC" | "DESC" }[] {
  if (value === undefined) return [];
  const sort = parseBody(dataSortSchema, value);
  return sort.split(",").map((term) => ({
    field: term.startsWith("-") ? term.slice(1) : term,
    direction: term.startsWith("-") ? "DESC" : "ASC"
  }));
}

export async function createApp({
  config,
  database,
  emailSender: injectedEmailSender,
  storage: injectedStorage,
  webhookTransport
}: AppOptions): Promise<FastifyInstance> {
  const connection = database ?? createDatabase(config.DATABASE_PATH);
  const emailSender = injectedEmailSender ?? createEmailSender(config);
  const storage = injectedStorage ?? new LocalObjectStorage(config.STORAGE_PATH);
  const webhookEncryptionKey = config.WEBHOOK_ENCRYPTION_KEY
    ? Buffer.from(config.WEBHOOK_ENCRYPTION_KEY, "hex")
    : undefined;
  const webhookWorker = webhookEncryptionKey
    ? new WebhookDeliveryWorker(connection.client, webhookEncryptionKey, webhookTransport ?? deliverWebhook)
    : undefined;
  const app = Fastify({
    logger: config.NODE_ENV === "test" ? false : { level: config.LOG_LEVEL },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024
  });

  await app.register(helmet);
  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
  });
  await app.register(rateLimit, {
    max: config.NODE_ENV === "test" ? 1000 : 120,
    timeWindow: "1 minute"
  });
  await app.register(multipart, {
    limits: { fileSize: config.MAX_FILE_BYTES, files: 1, fields: 10, parts: 11 }
  });
  await app.register(jwt, { secret: config.JWT_SECRET, sign: { expiresIn: "15m" } });
  await app.register(swagger, {
    openapi: {
      info: { title: "NanoBaaS API", version: "0.1.0" },
      servers: [{ url: `http://localhost:${config.PORT}` }],
      tags: [{ name: "system" }, { name: "auth" }, { name: "projects" }, { name: "data" }, { name: "authorization" }, { name: "storage" }, { name: "webhooks" }, { name: "admin" }],
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
          apiKeyAuth: { type: "apiKey", in: "header", name: "x-api-key" }
        }
      }
    }
  });
  await app.register(swaggerUi, { routePrefix: "/documentation" });
  const adminAssetsPath = path.resolve(process.cwd(), "apps", "admin", "dist");
  if (config.NODE_ENV !== "test" && existsSync(adminAssetsPath)) {
    await app.register(fastifyStatic, {
      root: adminAssetsPath,
      prefix: "/admin/",
      maxAge: "0",
      immutable: false
    });
    app.get("/admin", async (_request, reply) => reply.redirect("/admin/"));
  }

  app.setErrorHandler((error, request, reply) => {
    const normalizedError = error instanceof Error ? error : new Error("Unknown request error");
    const candidateStatus = "statusCode" in normalizedError ? normalizedError.statusCode : undefined;
    const statusCode = typeof candidateStatus === "number" && candidateStatus >= 400 && candidateStatus < 600 ? candidateStatus : 500;
    if (statusCode >= 500) request.log.error({ err: error }, "Request failed");
    const code = "code" in normalizedError && typeof normalizedError.code === "string" ? normalizedError.code : "INTERNAL_ERROR";
    const message = statusCode >= 500 ? "Internal server error" : normalizedError.message;
    const details = "details" in normalizedError ? normalizedError.details : undefined;
    reply.status(statusCode).send({ error: { code, message, ...(details ? { details } : {}) } });
  });

  const auth = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Authentication required" } });
    }
    const active = connection.client.prepare(`
      SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.user_id = ? AND s.revoked_at IS NULL
      AND s.expires_at > ? AND u.is_active = 1
    `).get(request.user.sid, request.user.sub, new Date().toISOString());
    if (!active) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Authentication required" } });
  };

  const isConfiguredPlatformAdmin = (email: string): boolean =>
    config.platformAdminEmails.includes(email.toLowerCase());

  const isPlatformAdmin = (userId: string): boolean => {
    const user = connection.client.prepare(
      "SELECT email, email_verified_at, is_active FROM users WHERE id = ?"
    ).get(userId) as { email: string; email_verified_at: string | null; is_active: number } | undefined;
    return Boolean(user?.is_active && user.email_verified_at && isConfiguredPlatformAdmin(user.email));
  };

  const platformAdminAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isPlatformAdmin(request.user.sub)) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Platform administrator access required" } });
    }
  };

  const hasProjectPermission = (projectId: string, userId: string, permission: string): boolean => {
    const membership = connection.client.prepare(
      "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?"
    ).get(projectId, userId) as { role: string } | undefined;
    if (!membership) return false;
    if (membership.role === "owner") return true;
    return Boolean(connection.client.prepare(`
      SELECT 1 FROM user_roles ur
      JOIN role_permissions rp ON rp.role_id = ur.role_id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.project_id = ? AND ur.user_id = ? AND p.name = ? LIMIT 1
    `).get(projectId, userId, permission));
  };

  const projectAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    const projectId = (request.params as { projectId?: string }).projectId;
    if (!projectId || !z.string().uuid().safeParse(projectId).success) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "A valid project ID is required" } });
    }

    if (request.headers.authorization?.startsWith("Bearer ")) {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Authentication required" } });
      }
      const membership = connection.client.prepare(`
        SELECT m.role FROM sessions s JOIN users u ON u.id = s.user_id
        JOIN project_members m ON m.user_id = u.id
        WHERE s.id = ? AND s.user_id = ? AND m.project_id = ?
        AND s.revoked_at IS NULL AND s.expires_at > ? AND u.is_active = 1
      `).get(request.user.sid, request.user.sub, projectId, new Date().toISOString()) as { role: string } | undefined;
      if (!membership) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Project not found" } });
      const isFileRequest = request.url.split("?")[0]?.includes("/storage/") ?? false;
      const permission = isFileRequest
        ? request.method === "GET" ? "files:read" : "files:write"
        : request.method === "GET" ? "data:read" : "data:write";
      if (membership.role !== "owner" && !hasProjectPermission(projectId, request.user.sub, permission)) {
        return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Project permission required" } });
      }
      return;
    }

    const apiKey = request.headers["x-api-key"];
    if (typeof apiKey !== "string") {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Authentication required" } });
    }
    const match = /^nbk_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(apiKey);
    if (!match) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "API key is invalid" } });
    const keyId = match[1];
    if (!keyId) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "API key is invalid" } });
    const row = connection.client.prepare(`
      SELECT id, key_hash, permissions FROM api_keys
      WHERE id = ? AND project_id = ? AND key_prefix = ? AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > ?)
    `).get(keyId, projectId, `nbk_${keyId}`, new Date().toISOString()) as { id: string; key_hash: string; permissions: string } | undefined;
    if (!row) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "API key is invalid" } });
    const storedHash = Buffer.from(row.key_hash, "hex");
    const providedHash = Buffer.from(hashToken(apiKey), "hex");
    if (storedHash.length !== providedHash.length || !timingSafeEqual(storedHash, providedHash)) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "API key is invalid" } });
    }
    const permissions = JSON.parse(row.permissions) as string[];
    const isFileRequest = request.url.split("?")[0]?.includes("/storage/") ?? false;
    const requiredPermission = isFileRequest
      ? request.method === "GET" ? "files:read" : "files:write"
      : request.method === "GET" ? "data:read" : "data:write";
    if (!permissions.includes(requiredPermission)) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "API key lacks the required permission" } });
    }
    connection.client.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?")
      .run(new Date().toISOString(), row.id);
  };

  const resolvePermissionIds = (names: string[]): string[] | null => {
    if (names.length === 0) return [];
    const placeholders = names.map(() => "?").join(", ");
    const found = connection.client.prepare(
      `SELECT id, name FROM permissions WHERE name IN (${placeholders})`
    ).all(...names) as { id: string; name: string }[];
    if (found.length !== names.length) return null;
    return found.map((permission) => permission.id);
  };

  const createOneTimeToken = (userId: string, purpose: "password_reset" | "email_verification") => {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();
    const createToken = connection.client.transaction(() => {
      connection.client.prepare(`
        UPDATE auth_tokens SET consumed_at = ?
        WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL
      `).run(now, userId, purpose);
      connection.client.prepare(`
        INSERT INTO auth_tokens (id, user_id, token_hash, purpose, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, userId, hashToken(token), purpose, expiresAt, now);
    });
    createToken();
    return { token, expiresAt };
  };

  const writeAuthAudit = (
    request: FastifyRequest,
    action: string,
    userId: string | null,
    metadata: Record<string, unknown> = {}
  ) => {
    connection.client.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, resource_type, resource_id, ip_address, metadata, created_at)
      VALUES (?, ?, ?, 'user', ?, ?, ?, ?)
    `).run(randomUUID(), userId, action, userId, request.ip, JSON.stringify(metadata), new Date().toISOString());
  };

  const writePlatformAudit = (
    request: FastifyRequest,
    action: string,
    resourceType: string,
    resourceId: string | null,
    metadata: Record<string, unknown> = {}
  ) => {
    connection.client.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, resource_type, resource_id, ip_address, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), request.user.sub, action, resourceType, resourceId, request.ip, JSON.stringify(metadata), new Date().toISOString());
  };

  app.get("/health", {
    schema: {
      tags: ["system"],
      response: { 200: { type: "object", properties: { status: { type: "string" } }, required: ["status"] } }
    }
  }, async () => ({ status: "ok" }));

  app.get("/api/v1/admin/overview", {
    preHandler: [auth, platformAdminAuth],
    schema: { tags: ["admin"], security: [{ bearerAuth: [] }] }
  }, async () => ({
    data: connection.client.prepare(`
      SELECT
        (SELECT COUNT(*) FROM users) AS user_count,
        (SELECT COUNT(*) FROM users WHERE is_active = 1) AS active_user_count,
        (SELECT COUNT(*) FROM projects) AS project_count,
        (SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL AND expires_at > ?) AS active_session_count,
        (SELECT COUNT(*) FROM files) AS file_count,
        (SELECT COALESCE(SUM(size_bytes), 0) FROM files) AS storage_bytes
    `).get(new Date().toISOString())
  }));

  app.get<{ Querystring: { limit?: string; offset?: string; q?: string } }>("/api/v1/admin/users", {
    preHandler: [auth, platformAdminAuth],
    schema: {
      tags: ["admin"],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          offset: { type: "integer", minimum: 0, default: 0 },
          q: { type: "string", maxLength: 254 }
        },
        additionalProperties: false
      }
    }
  }, async (request) => {
    const { limit, offset, q } = parseBody(z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
      q: z.string().trim().max(254).default("")
    }).strict(), request.query);
    const filter = q.toLowerCase();
    const total = connection.client.prepare(`
      SELECT COUNT(*) AS count FROM users
      WHERE ? = '' OR instr(lower(email), ?) > 0
    `).get(filter, filter) as { count: number };
    const users = connection.client.prepare(`
      SELECT u.id, u.email, u.email_verified_at, u.is_active, u.created_at, u.updated_at,
        (SELECT COUNT(*) FROM project_members m WHERE m.user_id = u.id) AS project_count,
        (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_session_count
      FROM users u
      WHERE ? = '' OR instr(lower(u.email), ?) > 0
      ORDER BY u.created_at DESC, u.id
      LIMIT ? OFFSET ?
    `).all(new Date().toISOString(), filter, filter, limit, offset) as {
      id: string;
      email: string;
      email_verified_at: string | null;
      is_active: number;
      created_at: string;
      updated_at: string;
      project_count: number;
      active_session_count: number;
    }[];
    writePlatformAudit(request, "admin.users.listed", "user", null, { limit, offset });
    return {
      data: users.map((user) => ({
        ...user,
        is_platform_admin_configured: isConfiguredPlatformAdmin(user.email),
        is_platform_admin: Boolean(user.is_active && user.email_verified_at && isConfiguredPlatformAdmin(user.email))
      })),
      pagination: { limit, offset, total: total.count }
    };
  });

  app.patch<{ Params: { userId: string } }>("/api/v1/admin/users/:userId", {
    preHandler: [auth, platformAdminAuth],
    schema: {
      tags: ["admin"],
      security: [{ bearerAuth: [] }],
      params: {
        type: "object",
        properties: { userId: { type: "string", format: "uuid" } },
        required: ["userId"],
        additionalProperties: false
      },
      body: {
        type: "object",
        properties: { isActive: { type: "boolean" } },
        required: ["isActive"],
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const { isActive } = parseBody(z.object({ isActive: z.boolean() }).strict(), request.body);
    const target = connection.client.prepare("SELECT id, email, is_active FROM users WHERE id = ?")
      .get(request.params.userId) as { id: string; email: string; is_active: number } | undefined;
    if (!target) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "User not found" } });
    if (!isActive && target.id === request.user.sub) {
      writePlatformAudit(request, "admin.user.deactivation_denied", "user", target.id, { reason: "self_deactivation" });
      return reply.code(409).send({ error: { code: "SELF_DEACTIVATION_FORBIDDEN", message: "You cannot deactivate your own account" } });
    }
    if (!isActive && isConfiguredPlatformAdmin(target.email)) {
      writePlatformAudit(request, "admin.user.deactivation_denied", "user", target.id, { reason: "configured_platform_admin" });
      return reply.code(409).send({ error: { code: "PLATFORM_ADMIN_PROTECTED", message: "Configured platform administrator accounts cannot be deactivated" } });
    }

    const now = new Date().toISOString();
    const updateUser = connection.client.transaction(() => {
      connection.client.prepare("UPDATE users SET is_active = ?, updated_at = ? WHERE id = ?")
        .run(Number(isActive), now, target.id);
      if (!isActive) {
        connection.client.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
          .run(now, target.id);
        connection.client.prepare("UPDATE auth_tokens SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL")
          .run(now, target.id);
      }
      writePlatformAudit(request, isActive ? "admin.user.activated" : "admin.user.deactivated", "user", target.id, {
        email: target.email
      });
    });
    updateUser();
    return {
      data: connection.client.prepare(`
        SELECT id, email, email_verified_at, is_active, created_at, updated_at
        FROM users WHERE id = ?
      `).get(target.id)
    };
  });

  app.get("/api/v1/admin/settings", {
    preHandler: [auth, platformAdminAuth],
    schema: { tags: ["admin"], security: [{ bearerAuth: [] }] }
  }, async () => ({
    data: {
      apiVersion: "0.1.0",
      environment: config.NODE_ENV,
      nodeVersion: process.version,
      maxFileBytes: config.MAX_FILE_BYTES,
      emailDeliveryEnabled: Boolean(emailSender),
      webhookDeliveryEnabled: Boolean(webhookEncryptionKey),
      configuredPlatformAdminCount: config.platformAdminEmails.length
    }
  }));

  app.get<{ Querystring: { limit?: string; offset?: string } }>("/api/v1/admin/audit-logs", {
    preHandler: [auth, platformAdminAuth],
    schema: {
      tags: ["admin"],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          offset: { type: "integer", minimum: 0, default: 0 }
        },
        additionalProperties: false
      }
    }
  }, async (request) => {
    const { limit, offset } = parseBody(z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0)
    }).strict(), request.query);
    const rows = connection.client.prepare(`
      SELECT a.id, a.actor_user_id, u.email AS actor_email, a.action, a.resource_type, a.resource_id,
        a.ip_address, a.metadata, a.created_at
      FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE a.project_id IS NULL
      ORDER BY a.created_at DESC, a.id
      LIMIT ? OFFSET ?
    `).all(limit, offset);
    const total = connection.client.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE project_id IS NULL")
      .get() as { count: number };
    return { data: rows, pagination: { limit, offset, total: total.count } };
  });

  app.post("/api/v1/auth/register", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    schema: { tags: ["auth"], body: { type: "object" } }
  }, async (request, reply) => {
    const body = parseBody(registerSchema, request.body);
    const userId = randomUUID();
    const now = new Date().toISOString();
    const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });
    const sessionId = randomUUID();
    const refreshToken = newRefreshToken(sessionId);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const createAccount = connection.client.transaction(() => {
      connection.client.prepare(`
        INSERT INTO users (id, email, password_hash, is_active, metadata, created_at, updated_at)
        VALUES (?, ?, ?, 1, '{}', ?, ?)
      `).run(userId, body.email, passwordHash, now, now);
      connection.client.prepare(`
        INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(sessionId, userId, hashToken(refreshToken), expiresAt, now, now);
    });
    try {
      createAccount();
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed: users.email")) {
        return reply.code(409).send({ error: { code: "EMAIL_EXISTS", message: "An account with this email already exists" } });
      }
      throw error;
    }
    writeAuthAudit(request, "auth.registered", userId);
    const accessToken = app.jwt.sign({ sub: userId, email: body.email, sid: sessionId });
    return reply.code(201).send({ data: { user: { id: userId, email: body.email, isPlatformAdmin: isPlatformAdmin(userId) }, accessToken, refreshToken, expiresAt } });
  });

  app.post("/api/v1/auth/login", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    schema: { tags: ["auth"], body: { type: "object" } }
  }, async (request, reply) => {
    const body = parseBody(loginSchema, request.body);
    const user = connection.client.prepare(
      "SELECT id, email, password_hash, is_active FROM users WHERE email = ? COLLATE NOCASE"
    ).get(body.email) as { id: string; email: string; password_hash: string; is_active: number } | undefined;
    if (!user || !user.is_active || !(await argon2.verify(user.password_hash, body.password))) {
      return reply.code(401).send({ error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect" } });
    }
    const sessionId = randomUUID();
    const refreshToken = newRefreshToken(sessionId);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    connection.client.prepare(`
      INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sessionId, user.id, hashToken(refreshToken), expiresAt, now, now);
    writeAuthAudit(request, "auth.login", user.id, { sessionId });
    return {
      data: {
        user: { id: user.id, email: user.email, isPlatformAdmin: isPlatformAdmin(user.id) },
        accessToken: app.jwt.sign({ sub: user.id, email: user.email, sid: sessionId }),
        refreshToken,
        expiresAt
      }
    };
  });

  app.post("/api/v1/auth/refresh", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    schema: { tags: ["auth"], body: { type: "object" } }
  }, async (request, reply) => {
    const { refreshToken } = parseBody(refreshSchema, request.body);
    const sessionId = getSessionId(refreshToken);
    if (!sessionId) return reply.code(401).send({ error: { code: "INVALID_REFRESH_TOKEN", message: "Refresh token is invalid" } });

    const session = connection.client.prepare(`
      SELECT s.id, s.user_id, s.refresh_token_hash, s.expires_at, s.revoked_at, u.email, u.is_active
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?
    `).get(sessionId) as { id: string; user_id: string; refresh_token_hash: string; expires_at: string; revoked_at: string | null; email: string; is_active: number } | undefined;

    if (!session) return reply.code(401).send({ error: { code: "INVALID_REFRESH_TOKEN", message: "Refresh token is invalid" } });
    if (session.refresh_token_hash !== hashToken(refreshToken)) {
      connection.client.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
        .run(new Date().toISOString(), session.user_id);
      return reply.code(401).send({ error: { code: "REFRESH_TOKEN_REUSE", message: "Session revoked after refresh token reuse" } });
    }
    if (session.revoked_at || session.expires_at <= new Date().toISOString() || !session.is_active) {
      return reply.code(401).send({ error: { code: "SESSION_EXPIRED", message: "Session is expired or revoked" } });
    }

    const nextToken = newRefreshToken(session.id);
    const now = new Date().toISOString();
    const rotated = connection.client.prepare(`
      UPDATE sessions SET refresh_token_hash = ?, last_used_at = ?
      WHERE id = ? AND refresh_token_hash = ? AND revoked_at IS NULL
    `).run(hashToken(nextToken), now, session.id, session.refresh_token_hash);
    if (rotated.changes !== 1) return reply.code(401).send({ error: { code: "INVALID_REFRESH_TOKEN", message: "Refresh token is invalid" } });

    return {
      data: {
        accessToken: app.jwt.sign({ sub: session.user_id, email: session.email, sid: session.id }),
        refreshToken: nextToken,
        expiresAt: session.expires_at
      }
    };
  });

  app.post("/api/v1/auth/logout", {
    schema: { tags: ["auth"], body: { type: "object" }, response: { 204: { type: "null" } } }
  }, async (request, reply) => {
    const { refreshToken } = parseBody(refreshSchema, request.body);
    const sessionId = getSessionId(refreshToken);
    if (sessionId) {
      const session = connection.client.prepare("SELECT user_id FROM sessions WHERE id = ?")
        .get(sessionId) as { user_id: string } | undefined;
      const revoked = connection.client.prepare(`
        UPDATE sessions SET revoked_at = ?
        WHERE id = ? AND refresh_token_hash = ? AND revoked_at IS NULL
      `).run(new Date().toISOString(), sessionId, hashToken(refreshToken));
      if (session && revoked.changes === 1) writeAuthAudit(request, "auth.logout", session.user_id, { sessionId });
    }
    return reply.code(204).send();
  });

  app.get("/api/v1/auth/me", { preHandler: auth, schema: { tags: ["auth"], security: [{ bearerAuth: [] }] } }, async (request) => {
    const user = connection.client.prepare("SELECT id, email, email_verified_at, created_at FROM users WHERE id = ?")
      .get(request.user.sub) as { id: string; email: string; email_verified_at: string | null; created_at: string };
    return { data: { ...user, isPlatformAdmin: isPlatformAdmin(request.user.sub) } };
  });

  app.post("/api/v1/auth/password/forgot", {
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    schema: { tags: ["auth"], body: { type: "object" } }
  }, async (request, reply) => {
    const { email } = parseBody(emailSchema, request.body);
    if (!emailSender) {
      return reply.code(503).send({ error: { code: "EMAIL_DELIVERY_UNAVAILABLE", message: "Email delivery is not configured" } });
    }
    const user = connection.client.prepare("SELECT id, email FROM users WHERE email = ? COLLATE NOCASE AND is_active = 1")
      .get(email) as { id: string; email: string } | undefined;
    if (user) {
      const { token, expiresAt } = createOneTimeToken(user.id, "password_reset");
      await emailSender.send(
        user.email,
        "NanoBaaS password reset",
        `A password reset was requested for your account.\n\nReset token: ${token}\nExpires at: ${expiresAt}\n\nSubmit this token to POST /api/v1/auth/password/reset with your new password. If you did not request this, ignore this message.`
      );
      writeAuthAudit(request, "auth.password_reset_requested", user.id);
    }
    return reply.code(202).send({
      data: { message: "If an active account exists for this address, password reset instructions will be sent." }
    });
  });

  app.post("/api/v1/auth/password/reset", {
    config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
    schema: { tags: ["auth"], body: { type: "object" } }
  }, async (request, reply) => {
    const { token, password } = parseBody(passwordResetSchema, request.body);
    const tokenHash = hashToken(token);
    const tokenRow = connection.client.prepare(`
      SELECT t.id, t.user_id FROM auth_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.purpose = 'password_reset' AND t.consumed_at IS NULL
      AND t.expires_at > ? AND u.is_active = 1
    `).get(tokenHash, new Date().toISOString()) as { id: string; user_id: string } | undefined;
    if (!tokenRow) return reply.code(400).send({ error: { code: "INVALID_TOKEN", message: "Reset token is invalid or expired" } });

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const now = new Date().toISOString();
    const resetPassword = connection.client.transaction(() => {
      const consumed = connection.client.prepare(`
        UPDATE auth_tokens SET consumed_at = ?
        WHERE id = ? AND token_hash = ? AND purpose = 'password_reset'
        AND consumed_at IS NULL AND expires_at > ?
        AND EXISTS (SELECT 1 FROM users WHERE id = auth_tokens.user_id AND is_active = 1)
      `).run(now, tokenRow.id, tokenHash, now);
      if (consumed.changes !== 1) return false;
      connection.client.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
        .run(passwordHash, now, tokenRow.user_id);
      connection.client.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
        .run(now, tokenRow.user_id);
      connection.client.prepare("UPDATE auth_tokens SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL")
        .run(now, tokenRow.user_id);
      writeAuthAudit(request, "auth.password_reset_completed", tokenRow.user_id);
      return true;
    });
    if (!resetPassword()) return reply.code(400).send({ error: { code: "INVALID_TOKEN", message: "Reset token is invalid or expired" } });
    return { data: { message: "Password updated. Log in with your new password." } };
  });

  app.post("/api/v1/auth/email/verification/request", {
    preHandler: auth,
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    schema: { tags: ["auth"], security: [{ bearerAuth: [] }] }
  }, async (request, reply) => {
    if (!emailSender) {
      return reply.code(503).send({ error: { code: "EMAIL_DELIVERY_UNAVAILABLE", message: "Email delivery is not configured" } });
    }
    const user = connection.client.prepare("SELECT email, email_verified_at FROM users WHERE id = ? AND is_active = 1")
      .get(request.user.sub) as { email: string; email_verified_at: string | null } | undefined;
    if (!user) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Authentication required" } });
    if (user.email_verified_at) return { data: { message: "Email address is already verified." } };

    const { token, expiresAt } = createOneTimeToken(request.user.sub, "email_verification");
    await emailSender.send(
      user.email,
      "Verify your NanoBaaS email",
      `Verify your email address with this token: ${token}\nExpires at: ${expiresAt}\n\nSubmit it to POST /api/v1/auth/email/verify.`
    );
    writeAuthAudit(request, "auth.email_verification_requested", request.user.sub);
    return reply.code(202).send({ data: { message: "Verification instructions have been sent." } });
  });

  app.post("/api/v1/auth/email/verify", {
    config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
    schema: { tags: ["auth"], body: { type: "object" } }
  }, async (request, reply) => {
    const { token } = parseBody(authTokenSchema, request.body);
    const tokenHash = hashToken(token);
    const now = new Date().toISOString();
    const verifyEmail = connection.client.transaction(() => {
      const tokenRow = connection.client.prepare(`
        SELECT t.id, t.user_id FROM auth_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ? AND t.purpose = 'email_verification'
        AND t.consumed_at IS NULL AND t.expires_at > ? AND u.is_active = 1
      `).get(tokenHash, now) as { id: string; user_id: string } | undefined;
      if (!tokenRow) return null;
      const consumed = connection.client.prepare(`
        UPDATE auth_tokens SET consumed_at = ?
        WHERE id = ? AND consumed_at IS NULL AND expires_at > ?
        AND EXISTS (SELECT 1 FROM users WHERE id = auth_tokens.user_id AND is_active = 1)
      `).run(now, tokenRow.id, now);
      if (consumed.changes !== 1) return null;
      connection.client.prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?")
        .run(now, now, tokenRow.user_id);
      connection.client.prepare("UPDATE auth_tokens SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL")
        .run(now, tokenRow.user_id);
      writeAuthAudit(request, "auth.email_verified", tokenRow.user_id);
      return tokenRow.user_id;
    });
    const userId = verifyEmail();
    if (!userId) return reply.code(400).send({ error: { code: "INVALID_TOKEN", message: "Verification token is invalid or expired" } });
    return { data: { message: "Email address verified." } };
  });

  app.post("/api/v1/auth/password/change", {
    preHandler: auth,
    schema: { tags: ["auth"], security: [{ bearerAuth: [] },] }
  }, async (request, reply) => {
    const { currentPassword, newPassword } = parseBody(passwordChangeSchema, request.body);
    const user = connection.client.prepare("SELECT password_hash FROM users WHERE id = ? AND is_active = 1")
      .get(request.user.sub) as { password_hash: string } | undefined;
    if (!user || !(await argon2.verify(user.password_hash, currentPassword))) {
      return reply.code(401).send({ error: { code: "INVALID_CREDENTIALS", message: "Current password is incorrect" } });
    }
    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
    const now = new Date().toISOString();
    const updatePassword = connection.client.transaction(() => {
      connection.client.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
        .run(passwordHash, now, request.user.sub);
      connection.client.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
        .run(now, request.user.sub);
      connection.client.prepare("UPDATE auth_tokens SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL")
        .run(now, request.user.sub);
      writeAuthAudit(request, "auth.password_changed", request.user.sub);
    });
    updatePassword();
    return { data: { message: "Password changed. All sessions were revoked; log in again." } };
  });

  app.get("/api/v1/auth/sessions", { preHandler: auth, schema: { tags: ["auth"], security: [{ bearerAuth: [] }] } }, async (request) => ({
    data: connection.client.prepare(`
      SELECT id, created_at, last_used_at, expires_at, revoked_at, (id = ?) AS is_current
      FROM sessions WHERE user_id = ? ORDER BY created_at DESC
    `).all(request.user.sid, request.user.sub)
  }));

  app.delete<{ Params: { sessionId: string } }>("/api/v1/auth/sessions/:sessionId", {
    preHandler: auth,
    schema: { tags: ["auth"], security: [{ bearerAuth: [] }] }
  }, async (request, reply) => {
    const now = new Date().toISOString();
    const result = connection.client.prepare(`
      UPDATE sessions SET revoked_at = ?
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL
    `).run(now, request.params.sessionId, request.user.sub);
    if (result.changes === 0) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Session not found" } });
    writeAuthAudit(request, "auth.session_revoked", request.user.sub, { sessionId: request.params.sessionId });
    return reply.code(204).send();
  });

  app.post("/api/v1/projects", { preHandler: auth, schema: { tags: ["projects"], security: [{ bearerAuth: [] }] } }, async (request, reply) => {
    const body = parseBody(projectCreateSchema, request.body);
    const id = randomUUID();
    const now = new Date().toISOString();
    const createProject = connection.client.transaction(() => {
      connection.client.prepare(
        "INSERT INTO projects (id, name, slug, settings, created_at, updated_at) VALUES (?, ?, ?, '{}', ?, ?)"
      ).run(id, body.name, body.slug, now, now);
      connection.client.prepare(
        "INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)"
      ).run(id, request.user.sub, now);
      connection.client.prepare(
        "INSERT INTO audit_logs (id, project_id, actor_user_id, action, resource_type, resource_id, metadata, created_at) VALUES (?, ?, ?, 'project.created', 'project', ?, '{}', ?)"
      ).run(randomUUID(), id, request.user.sub, id, now);
    });
    try {
      createProject();
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed: projects.slug")) {
        return reply.code(409).send({ error: { code: "SLUG_EXISTS", message: "A project with this slug already exists" } });
      }
      throw error;
    }
    const project = connection.client.prepare("SELECT id, name, slug, settings, created_at, updated_at FROM projects WHERE id = ?").get(id);
    return reply.code(201).send({ data: project });
  });

  app.get("/api/v1/projects", { preHandler: auth, schema: { tags: ["projects"], security: [{ bearerAuth: [] }] } }, async (request) => ({
    data: connection.client.prepare(`
      SELECT p.id, p.name, p.slug, p.settings, p.created_at, p.updated_at, m.role AS member_role
      FROM projects p JOIN project_members m ON m.project_id = p.id
      WHERE m.user_id = ? ORDER BY p.created_at DESC
    `).all(request.user.sub)
  }));

  app.get<{ Params: { projectId: string } }>("/api/v1/projects/:projectId", {
    preHandler: auth,
    schema: { tags: ["projects"], security: [{ bearerAuth: [] },] }
  }, async (request, reply) => {
    const project = connection.client.prepare(`
      SELECT p.id, p.name, p.slug, p.settings, p.created_at, p.updated_at, m.role AS member_role
      FROM projects p JOIN project_members m ON m.project_id = p.id
      WHERE p.id = ? AND m.user_id = ?
    `).get(request.params.projectId, request.user.sub);
    if (!project) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Project not found" } });
    return { data: project };
  });

  app.get<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/overview", {
    preHandler: auth,
    schema: { tags: ["projects"], security: [{ bearerAuth: [] }] }
  }, async (request, reply) => {
    const projectId = request.params.projectId;
    const membership = connection.client.prepare(
      "SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?"
    ).get(projectId, request.user.sub);
    if (!membership) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Project not found" } });
    if (!hasProjectPermission(projectId, request.user.sub, "project:manage")) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Project permission required" } });
    }
    const overview = connection.client.prepare(`
      SELECT p.id, p.name, p.slug, p.settings, p.created_at,
        (SELECT COUNT(*) FROM project_members WHERE project_id = p.id) AS member_count,
        (SELECT COUNT(*) FROM collection_records WHERE project_id = p.id) AS record_count,
        (SELECT COUNT(*) FROM api_keys WHERE project_id = p.id AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)) AS active_api_key_count,
        (SELECT COUNT(*) FROM files WHERE project_id = p.id) AS file_count,
        (SELECT COALESCE(SUM(size_bytes), 0) FROM files WHERE project_id = p.id) AS storage_bytes,
        (SELECT COUNT(*) FROM roles WHERE project_id = p.id) AS role_count,
        (SELECT COUNT(*) FROM webhooks WHERE project_id = p.id AND is_active = 1) AS active_webhook_count
      FROM projects p WHERE p.id = ?
    `).get(new Date().toISOString(), projectId);
    return { data: overview };
  });

  app.get<{ Params: { projectId: string }; Querystring: { limit?: string; offset?: string } }>(
    "/api/v1/projects/:projectId/audit-logs",
    {
      preHandler: auth,
      schema: {
        tags: ["projects"],
        security: [{ bearerAuth: [] }],
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
            offset: { type: "integer", minimum: 0, default: 0 }
          },
          additionalProperties: false
        }
      }
    },
    async (request, reply) => {
      const projectId = request.params.projectId;
      const membership = connection.client.prepare(
        "SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?"
      ).get(projectId, request.user.sub);
      if (!membership) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Project not found" } });
      if (!hasProjectPermission(projectId, request.user.sub, "project:manage")) {
        return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Project permission required" } });
      }
      const { limit, offset } = parseBody(z.object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0)
      }).strict(), request.query);
      const rows = connection.client.prepare(`
        SELECT a.id, a.actor_user_id, u.email AS actor_email, a.action, a.resource_type,
          a.resource_id, a.ip_address, a.metadata, a.created_at
        FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.project_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?
      `).all(projectId, limit, offset);
      return { data: rows, pagination: { limit, offset } };
    }
  );

  app.patch<{ Params: { projectId: string } }>("/api/v1/projects/:projectId", { preHandler: auth, schema: { tags: ["projects"], security: [{ bearerAuth: [] }] } }, async (request, reply) => {
    const body = parseBody(projectUpdateSchema, request.body);
    const membership = connection.client.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?")
      .get(request.params.projectId, request.user.sub);
    if (!membership) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Project not found" } });
    if (!hasProjectPermission(request.params.projectId, request.user.sub, "project:manage")) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Project permission required" } });
    }

    const current = connection.client.prepare("SELECT settings FROM projects WHERE id = ?").get(request.params.projectId) as { settings: string };
    const settings = body.settings ? JSON.stringify(body.settings) : current.settings;
    connection.client.prepare("UPDATE projects SET name = COALESCE(?, name), settings = ?, updated_at = ? WHERE id = ?")
      .run(body.name ?? null, settings, new Date().toISOString(), request.params.projectId);
    return { data: connection.client.prepare("SELECT id, name, slug, settings, created_at, updated_at FROM projects WHERE id = ?").get(request.params.projectId) };
  });

  app.delete<{ Params: { projectId: string } }>("/api/v1/projects/:projectId", { preHandler: auth, schema: { tags: ["projects"], security: [{ bearerAuth: [] }] } }, async (request, reply) => {
    const result = connection.client.prepare(`
      DELETE FROM projects WHERE id = ?
      AND EXISTS (SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ? AND role = 'owner')
    `).run(request.params.projectId, request.params.projectId, request.user.sub);
    if (result.changes === 0) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Project not found" } });
    return reply.code(204).send();
  });

  app.get<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/permissions", {
    preHandler: auth,
    schema: { tags: ["authorization"], security: [{ bearerAuth: [] }] }
  }, async (request, reply) => {
    const membership = connection.client.prepare(
      "SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?"
    ).get(request.params.projectId, request.user.sub);
    if (!membership) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Project not found" } });
    const permissions = connection.client.prepare("SELECT name, description FROM permissions ORDER BY name").all();
    return { data: permissions };
  });

  app.get<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/members", {
    preHandler: auth,
    schema: { tags: ["authorization"], security: [{ bearerAuth: [] }] }
  }, async (request, reply) => {
    const member = connection.client.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?")
      .get(request.params.projectId, request.user.sub);
    if (!member) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Project not found" } });
    if (!hasProjectPermission(request.params.projectId, request.user.sub, "users:read")) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Project permission required" } });
    }
    const members = connection.client.prepare(`
      SELECT u.id, u.email, m.role, m.created_at
      FROM project_members m JOIN users u ON u.id = m.user_id
      WHERE m.project_id = ? ORDER BY m.created_at, u.email
    `).all(request.params.projectId) as { id: string; email: string; role: string; created_at: string }[];
    const data = members.map((member) => ({
      ...member,
      assignedRoles: (connection.client.prepare(`
        SELECT r.id, r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.project_id = ? AND ur.user_id = ? ORDER BY r.name
      `).all(request.params.projectId, member.id) as { id: string; name: string }[])
    }));
    return { data };
  });

  app.post<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/members", {
    preHandler: auth,
    schema: { tags: ["authorization"], security: [{ bearerAuth: [] }] }
  }, async (request, reply) => {
    const body = parseBody(memberCreateSchema, request.body);
    const projectId = request.params.projectId;
    const callerMembership = connection.client.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?")
      .get(projectId, request.user.sub);
    if (!callerMembership) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Project not found" } });
    if (!hasProjectPermission(projectId, request.user.sub, "users:write")) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Project permission required" } });
    }
    const user = connection.client.prepare("SELECT id, email FROM users WHERE email = ? COLLATE NOCASE")
      .get(body.email) as { id: string; email: string } | undefined;
    if (!user) return reply.code(404).send({ error: { code: "USER_NOT_FOUND", message: "Registered user not found" } });

    const now = new Date().toISOString();
    const addMember = connection.client.transaction(() => {
      connection.client.prepare(
        "INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)"
      ).run(projectId, user.id, now);
      connection.client.prepare(`
        INSERT INTO audit_logs (id, project_id, actor_user_id, action, resource_type, resource_id, metadata, created_at)
        VALUES (?, ?, ?, 'member.added', 'user', ?, ?, ?)
      `).run(randomUUID(), projectId, request.user.sub, user.id, JSON.stringify({ email: user.email }), now);
    });
    try {
      addMember();
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed: project_members.project_id, project_members.user_id")) {
        return reply.code(409).send({ error: { code: "ALREADY_MEMBER", message: "User is already a project member" } });
      }
      throw error;
    }
    return reply.code(201).send({ data: { id: user.id, email: user.email, role: "member", createdAt: now, assignedRoles: [] } });
  });

  app.delete<{ Params: { projectId: string; userId: string } }>("/api/v1/projects/:projectId/members/:userId", {
    preHandler: auth,
    schema: { tags: ["authorization"], security: [{ bearerAuth: [] }] }
  }, async (request, reply) => {
    const projectId = request.params.projectId;
    const member = connection.client.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?")
      .get(projectId, request.user.sub);
    if (!member) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Project not found" } });
    if (!hasProjectPermission(projectId, request.user.sub, "users:write")) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Project permission required" } });
    }
    if (request.params.userId === request.user.sub) {
      return reply.code(400).send({ error: { code: "OWNER_CANNOT_REMOVE_SELF", message: "Transfer project ownership before leaving the project" } });
    }
    const now = new Date().toISOString();
    const removeMember = connection.client.transaction(() => {
      const result = connection.client.prepare(`
        DELETE FROM project_members WHERE project_id = ? AND user_id = ? AND role = 'member'
      `).run(projectId, request.params.userId);
      if (result.changes === 1) {
        connection.client.prepare(`
          INSERT INTO audit_logs (id, project_id, actor_user_id, action, resource_type, resource_id, metadata, created_at)
          VALUES (?, ?, ?, 'member.removed', 'user', ?, '{}', ?)
        `).run(randomUUID(), projectId, request.user.sub, request.params.userId, now);
      }
      return result.changes;
    });
    if (removeMember() === 0) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Project member not found" } });
    return reply.code(204).send();
  });

  app.get<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/roles", {
    preHandler: auth,
    schema: { tags: ["authorization"], security: [{ bearerAuth: [] }] }
  }, async (request, reply) => {
    const membership = connection.client.prepare(
      "SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?"
    ).get(request.params.projectId, request.user.sub);
    if (!membership) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Project not found" } });
    const roles = connection.client.prepare(
      "SELECT id, name, description, created_at FROM roles WHERE project_id = ? ORDER BY name"
    ).all(request.params.projectId) as { id: string; name: string; description: string; created_at: string }[];
    return {
      data: roles.map((role) => ({
        ...role,
        permissions: (connection.client.prepare(`
          SELECT p.name FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
          WHERE rp.role_id = ? ORDER BY p.name
        `).all(role.id) as { name: string }[]).map((permission) => permission.name)
      }))
    };
  });

  app.post<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/roles", {
    preHandler: auth,
    schema: { tags: ["authorization"], security: [{ bearerAuth: [] }] }
  }, async (request, reply) => {
    const body = parseBody(roleCreateSchema, request.body);
    const projectId = request.params.projectId;
    const member = connection.client.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?")
      .get(projectId, request.user.sub);
    if (!member) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Project not found" } });
    if (!hasProjectPermission(projectId, request.user.sub, "roles:manage")) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Project permission required" } });
    }
    const permissionIds = resolvePermissionIds(body.permissions);
    if (!permissionIds) return reply.code(400).send({ error: { code: "UNKNOWN_PERMISSION", message: "One or more permissions are not defined" } });

    const id = randomUUID();
    const now = new Date().toISOString();
    const createRole = connection.client.transaction(() => {
      connection.client.prepare(
        "INSERT INTO roles (id, project_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run(id, projectId, body.name, body.description, now);
      const insertPermission = connection.client.prepare(
        "INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)"
      );
      for (const permissionId of permissionIds) insertPermission.run(id, permissionId);
      connection.client.prepare(`
        INSERT INTO audit_logs (id, project_id, actor_user_id, action, resource_type, resource_id, metadata, created_at)
        VALUES (?, ?, ?, 'role.created', 'role', ?, ?, ?)
      `).run(randomUUID(), projectId, request.user.sub, id, JSON.stringify({ name: body.name }), now);
    });
    try {
      createRole();
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed: roles.project_id, roles.name")) {
        return reply.code(409).send({ error: { code: "ROLE_EXISTS", message: "A role with this name already exists" } });
      }
      throw error;
    }
    return reply.code(201).send({ data: { id, name: body.name, description: body.description, permissions: body.permissions, createdAt: now } });
  });

  app.patch<{ Params: { projectId: string; roleId: string } }>("/api/v1/projects/:projectId/roles/:roleId", {
    preHandler: auth,
    schema: { tags: ["authorization"], security: [{ bearerAuth: [] }] }
  }, async (request, reply) => {
    const body = parseBody(roleUpdateSchema, request.body);
    const projectId = request.params.projectId;
    const member = connection.client.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?")
      .get(projectId, request.user.sub);
    if (!member) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Project not found" } });
    if (!hasProjectPermission(projectId, request.user.sub, "roles:manage")) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Project permission required" } });
    }
    const role = connection.client.prepare("SELECT id FROM roles WHERE id = ? AND project_id = ?")
      .get(request.params.roleId, projectId);
    if (!role) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Role not found" } });
    const permissionIds = body.permissions === undefined ? undefined : resolvePermissionIds(body.permissions);
    if (permissionIds === null) return reply.code(400).send({ error: { code: "UNKNOWN_PERMISSION", message: "One or more permissions are not defined" } });

    const now = new Date().toISOString();
    const updateRole = connection.client.transaction(() => {
      connection.client.prepare(`
        UPDATE roles SET name = COALESCE(?, name), description = COALESCE(?, description)
        WHERE id = ? AND project_id = ?
      `).run(body.name ?? null, body.description ?? null, request.params.roleId, projectId);
      if (permissionIds !== undefined) {
        connection.client.prepare("DELETE FROM role_permissions WHERE role_id = ?").run(request.params.roleId);
        const insertPermission = connection.client.prepare(
          "INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)"
        );
        for (const permissionId of permissionIds) insertPermission.run(request.params.roleId, permissionId);
      }
      connection.client.prepare(`
        INSERT INTO audit_logs (id, project_id, actor_user_id, action, resource_type, resource_id, metadata, created_at)
        VALUES (?, ?, ?, 'role.updated', 'role', ?, '{}', ?)
      `).run(randomUUID(), projectId, request.user.sub, request.params.roleId, now);
    });
    try {
      updateRole();
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed: roles.project_id, roles.name")) {
        return reply.code(409).send({ error: { code: "ROLE_EXISTS", message: "A role with this name already exists" } });
      }
      throw error;
    }
    return {
      data: connection.client.prepare("SELECT id, name, description, created_at FROM roles WHERE id = ? AND project_id = ?")
        .get(request.params.roleId, projectId)
    };
  });

  app.delete<{ Params: { projectId: string; roleId: string } }>("/api/v1/projects/:projectId/roles/:roleId", {
    preHandler: auth,
    schema: { tags: ["authorization"], security: [{ bearerAuth: [] }] }
  }, async (request, reply) => {
    const member = connection.client.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?")
      .get(request.params.projectId, request.user.sub);
    if (!member) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Project not found" } });
    if (!hasProjectPermission(request.params.projectId, request.user.sub, "roles:manage")) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Project permission required" } });
    }
    const now = new Date().toISOString();
    const result = connection.client.prepare(`
      DELETE FROM roles WHERE id = ? AND project_id = ?
    `).run(request.params.roleId, request.params.projectId);
    if (result.changes === 0) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Role not found" } });
    connection.client.prepare(`
      INSERT INTO audit_logs (id, project_id, actor_user_id, action, resource_type, resource_id, metadata, created_at)
      VALUES (?, ?, ?, 'role.deleted', 'role', ?, '{}', ?)
    `).run(randomUUID(), request.params.projectId, request.user.sub, request.params.roleId, now);
    return reply.code(204).send();
  });

  app.put<{ Params: { projectId: string; userId: string } }>("/api/v1/projects/:projectId/members/:userId/roles", {
    preHandler: auth,
    schema: { tags: ["authorization"], security: [{ bearerAuth: [] }] }
  }, async (request, reply) => {
    const body = parseBody(userRoleAssignSchema, request.body);
    const projectId = request.params.projectId;
    const callerMembership = connection.client.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?")
      .get(projectId, request.user.sub);
    if (!callerMembership) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Project not found" } });
    if (!hasProjectPermission(projectId, request.user.sub, "members:manage")) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Project permission required" } });
    }
    const targetMember = connection.client.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ? AND role = 'member'")
      .get(projectId, request.params.userId);
    if (!targetMember) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Project member not found" } });
    const roleIds = body.roleIds;
    if (roleIds.length > 0) {
      const placeholders = roleIds.map(() => "?").join(", ");
      const roles = connection.client.prepare(
        `SELECT id FROM roles WHERE project_id = ? AND id IN (${placeholders})`
      ).all(projectId, ...roleIds);
      if (roles.length !== roleIds.length) {
        return reply.code(400).send({ error: { code: "INVALID_ROLE", message: "One or more roles do not belong to this project" } });
      }
    }
    const now = new Date().toISOString();
    const assignRoles = connection.client.transaction(() => {
      connection.client.prepare("DELETE FROM user_roles WHERE project_id = ? AND user_id = ?")
        .run(projectId, request.params.userId);
      const insertRole = connection.client.prepare(
        "INSERT INTO user_roles (project_id, user_id, role_id, created_at) VALUES (?, ?, ?, ?)"
      );
      for (const roleId of roleIds) insertRole.run(projectId, request.params.userId, roleId, now);
      connection.client.prepare(`
        INSERT INTO audit_logs (id, project_id, actor_user_id, action, resource_type, resource_id, metadata, created_at)
        VALUES (?, ?, ?, 'member.roles_updated', 'user', ?, ?, ?)
      `).run(randomUUID(), projectId, request.user.sub, request.params.userId, JSON.stringify({ roleIds }), now);
    });
    assignRoles();
    return { data: { userId: request.params.userId, roleIds } };
  });

  app.get<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/webhooks", {
    preHandler: auth,
    schema: { tags: ["webhooks"], security: [{ bearerAuth: [] }] }
  }, async (request, reply) => {
    const projectId = request.params.projectId;
    const member = connection.client.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?")
      .get(projectId, request.user.sub);
    if (!member) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Project not found" } });
    if (!hasProjectPermission(projectId, request.user.sub, "webhooks:manage")) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Project permission required" } });
    }
    const rows = connection.client.prepare(`
      SELECT id, url, events, is_active, created_at, updated_at
      FROM webhooks WHERE project_id = ? ORDER BY created_at DESC, id
    `).all(projectId) as { id: string; url: string; events: string; is_active: number; created_at: string; updated_at: string }[];
    return {
      data: rows.map((row) => ({
        id: row.id,
        url: row.url,
        events: JSON.parse(row.events) as string[],
        isActive: row.is_active === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }))
    };
  });

  app.post<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/webhooks", {
    preHandler: auth,
    schema: { tags: ["webhooks"], security: [{ bearerAuth: [] }] }
  }, async (request, reply) => {
    const body = parseBody(webhookCreateSchema, request.body);
    const projectId = request.params.projectId;
    const member = connection.client.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?")
      .get(projectId, request.user.sub);
    if (!member) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Project not found" } });
    if (!hasProjectPermission(projectId, request.user.sub, "webhooks:manage")) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Project permission required" } });
    }
    if (!webhookEncryptionKey) {
      return reply.code(503).send({ error: { code: "WEBHOOKS_NOT_CONFIGURED", message: "Webhook encryption is not configured" } });
    }
    const url = validateWebhookUrl(body.url);
    if (!url) return reply.code(400).send({ error: { code: "INVALID_WEBHOOK_URL", message: "Webhook URLs must use HTTPS and cannot include credentials, query strings, fragments, or nonstandard ports" } });
    const count = connection.client.prepare("SELECT COUNT(*) AS count FROM webhooks WHERE project_id = ?")
      .get(projectId) as { count: number };
    if (count.count >= 50) {
      return reply.code(409).send({ error: { code: "WEBHOOK_LIMIT_REACHED", message: "A project can have at most 50 webhooks" } });
    }
    const id = randomUUID();
    const secret = `whsec_${randomBytes(32).toString("base64url")}`;
    const now = new Date().toISOString();
    const createWebhook = connection.client.transaction(() => {
      connection.client.prepare(`
        INSERT INTO webhooks (id, project_id, url, secret_hash, secret_ciphertext, events, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(id, projectId, url, hashToken(secret), encryptWebhookSecret(secret, webhookEncryptionKey), JSON.stringify(body.events), now, now);
      connection.client.prepare(`
        INSERT INTO audit_logs (id, project_id, actor_user_id, action, resource_type, resource_id, metadata, created_at)
        VALUES (?, ?, ?, 'webhook.created', 'webhook', ?, ?, ?)
      `).run(randomUUID(), projectId, request.user.sub, id, JSON.stringify({ events: body.events }), now);
    });
    createWebhook();
    return reply.code(201).send({ data: { id, url, events: body.events, isActive: true, secret, createdAt: now } });
  });

  app.patch<{ Params: { projectId: string; webhookId: string } }>("/api/v1/projects/:projectId/webhooks/:webhookId", {
    preHandler: auth,
    schema: { tags: ["webhooks"], security: [{ bearerAuth: [] }] }
  }, async (request, reply) => {
    const body = parseBody(webhookUpdateSchema, request.body);
    const projectId = request.params.projectId;
    const member = connection.client.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?")
      .get(projectId, request.user.sub);
    if (!member) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Project not found" } });
    if (!hasProjectPermission(projectId, request.user.sub, "webhooks:manage")) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Project permission required" } });
    }
    const exists = connection.client.prepare("SELECT 1 FROM webhooks WHERE id = ? AND project_id = ?")
      .get(request.params.webhookId, projectId);
    if (!exists) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Webhook not found" } });
    const url = body.url === undefined ? undefined : validateWebhookUrl(body.url);
    if (body.url !== undefined && !url) {
      return reply.code(400).send({ error: { code: "INVALID_WEBHOOK_URL", message: "Webhook URLs must use HTTPS and cannot include credentials, query strings, fragments, or nonstandard ports" } });
    }
    const now = new Date().toISOString();
    const updateWebhook = connection.client.transaction(() => {
      connection.client.prepare(`
        UPDATE webhooks SET url = COALESCE(?, url), events = COALESCE(?, events),
          is_active = COALESCE(?, is_active), updated_at = ?
        WHERE id = ? AND project_id = ?
      `).run(url ?? null, body.events ? JSON.stringify(body.events) : null,
        body.isActive === undefined ? null : Number(body.isActive), now, request.params.webhookId, projectId);
      if (body.isActive === false) {
        connection.client.prepare(`
          UPDATE webhook_deliveries SET status = 'cancelled', lease_until = NULL, last_error = 'webhook_disabled'
          WHERE webhook_id = ? AND status IN ('pending', 'processing')
        `).run(request.params.webhookId);
      }
      connection.client.prepare(`
        INSERT INTO audit_logs (id, project_id, actor_user_id, action, resource_type, resource_id, metadata, created_at)
        VALUES (?, ?, ?, 'webhook.updated', 'webhook', ?, ?, ?)
      `).run(randomUUID(), projectId, request.user.sub, request.params.webhookId, JSON.stringify(body), now);
    });
    updateWebhook();
    return {
      data: connection.client.prepare(`
        SELECT id, url, events, is_active, created_at, updated_at
        FROM webhooks WHERE id = ? AND project_id = ?
      `).get(request.params.webhookId, projectId)
    };
  });

  app.post<{ Params: { projectId: string; webhookId: string } }>("/api/v1/projects/:projectId/webhooks/:webhookId/rotate-secret", {
    preHandler: auth,
    schema: { tags: ["webhooks"], security: [{ bearerAuth: [] }] }
  }, async (request, reply) => {
    const projectId = request.params.projectId;
    const member = connection.client.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?")
      .get(projectId, request.user.sub);
    if (!member) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Project not found" } });
    if (!hasProjectPermission(projectId, request.user.sub, "webhooks:manage")) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Project permission required" } });
    }
    if (!webhookEncryptionKey) {
      return reply.code(503).send({ error: { code: "WEBHOOKS_NOT_CONFIGURED", message: "Webhook encryption is not configured" } });
    }
    const id = request.params.webhookId;
    const exists = connection.client.prepare("SELECT 1 FROM webhooks WHERE id = ? AND project_id = ?").get(id, projectId);
    if (!exists) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Webhook not found" } });
    const secret = `whsec_${randomBytes(32).toString("base64url")}`;
    const now = new Date().toISOString();
    const rotateSecret = connection.client.transaction(() => {
      connection.client.prepare(`
        UPDATE webhooks SET secret_hash = ?, secret_ciphertext = ?, updated_at = ?
        WHERE id = ? AND project_id = ?
      `).run(hashToken(secret), encryptWebhookSecret(secret, webhookEncryptionKey), now, id, projectId);
      connection.client.prepare(`
        INSERT INTO audit_logs (id, project_id, actor_user_id, action, resource_type, resource_id, metadata, created_at)
        VALUES (?, ?, ?, 'webhook.secret_rotated', 'webhook', ?, '{}', ?)
      `).run(randomUUID(), projectId, request.user.sub, id, now);
    });
    rotateSecret();
    return { data: { id, secret, rotatedAt: now } };
  });

  app.delete<{ Params: { projectId: string; webhookId: string } }>("/api/v1/projects/:projectId/webhooks/:webhookId", {
    preHandler: auth,
    schema: { tags: ["webhooks"], security: [{ bearerAuth: [] }] }
  }, async (request, reply) => {
    const projectId = request.params.projectId;
    const member = connection.client.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?")
      .get(projectId, request.user.sub);
    if (!member) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Project not found" } });
    if (!hasProjectPermission(projectId, request.user.sub, "webhooks:manage")) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Project permission required" } });
    }
    const now = new Date().toISOString();
    const deleteWebhook = connection.client.transaction(() => {
      const result = connection.client.prepare("DELETE FROM webhooks WHERE id = ? AND project_id = ?")
        .run(request.params.webhookId, projectId);
      if (result.changes === 1) {
        connection.client.prepare(`
          INSERT INTO audit_logs (id, project_id, actor_user_id, action, resource_type, resource_id, metadata, created_at)
          VALUES (?, ?, ?, 'webhook.deleted', 'webhook', ?, '{}', ?)
        `).run(randomUUID(), projectId, request.user.sub, request.params.webhookId, now);
      }
      return result.changes;
    });
    if (deleteWebhook() === 0) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Webhook not found" } });
    return reply.code(204).send();
  });

  app.post<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/storage/files", {
    preHandler: projectAuth,
    bodyLimit: config.MAX_FILE_BYTES + 128 * 1024,
    schema: { tags: ["storage"], security: [{ bearerAuth: [] }, { apiKeyAuth: [] }] }
  }, async (request, reply) => {
    const projectId = request.params.projectId;
    const part = await request.file();
    if (!part || part.fieldname !== "file") {
      return reply.code(400).send({ error: { code: "FILE_REQUIRED", message: "Upload one file using the 'file' field" } });
    }

    const data = await part.toBuffer();
    if (part.file.truncated) {
      return reply.code(413).send({ error: { code: "FILE_TOO_LARGE", message: "Uploaded file exceeds the configured size limit" } });
    }
    const detectedType = await fileTypeFromBuffer(data);
    const allowedMimeTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"]);
    if (!detectedType || !allowedMimeTypes.has(detectedType.mime)) {
      return reply.code(415).send({ error: { code: "UNSUPPORTED_FILE_TYPE", message: "Only PNG, JPEG, GIF, WebP, and PDF files are supported" } });
    }
    if (part.mimetype !== detectedType.mime) {
      return reply.code(415).send({ error: { code: "MIME_MISMATCH", message: "Uploaded content does not match its declared MIME type" } });
    }

    const originalName = path.basename(part.filename.replace(/\\/g, "/"))
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f]/g, "_")
      .slice(0, 255) || "upload";
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const actorUserId = request.headers.authorization?.startsWith("Bearer ") ? request.user.sub : null;
    await storage.put(id, data);
    try {
      const saveMetadata = connection.client.transaction(() => {
        connection.client.prepare(`
          INSERT INTO files (id, project_id, storage_key, original_name, mime_type, size_bytes, metadata, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)
        `).run(id, projectId, id, originalName, detectedType.mime, data.length, actorUserId, createdAt);
        connection.client.prepare(`
          INSERT INTO audit_logs (id, project_id, actor_user_id, action, resource_type, resource_id, metadata, created_at)
          VALUES (?, ?, ?, 'file.uploaded', 'file', ?, ?, ?)
        `).run(randomUUID(), projectId, actorUserId, id, JSON.stringify({ mimeType: detectedType.mime, sizeBytes: data.length }), createdAt);
        enqueueWebhookEvent(connection.client, projectId, "file.uploaded", {
          id,
          name: originalName,
          mimeType: detectedType.mime,
          sizeBytes: data.length
        }, createdAt);
      });
      saveMetadata();
    } catch (error) {
      await storage.remove(id);
      throw error;
    }

    return reply.code(201).send({
      data: { id, projectId, name: originalName, mimeType: detectedType.mime, sizeBytes: data.length, createdAt }
    });
  });

  app.get<{ Params: { projectId: string }; Querystring: { limit?: string; offset?: string } }>(
    "/api/v1/projects/:projectId/storage/files",
    { preHandler: projectAuth, schema: { tags: ["storage"], security: [{ bearerAuth: [] }, { apiKeyAuth: [] }] } },
    async (request) => {
      const { limit, offset } = parseBody(z.object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0)
      }).strict(), request.query);
      const rows = connection.client.prepare(`
        SELECT id, original_name, mime_type, size_bytes, metadata, created_at
        FROM files WHERE project_id = ? ORDER BY created_at DESC, id LIMIT ? OFFSET ?
      `).all(request.params.projectId, limit, offset) as {
        id: string; original_name: string; mime_type: string; size_bytes: number; metadata: string; created_at: string
      }[];
      return {
        data: rows.map((row) => ({
          id: row.id,
          name: row.original_name,
          mimeType: row.mime_type,
          sizeBytes: row.size_bytes,
          metadata: JSON.parse(row.metadata),
          createdAt: row.created_at
        })),
        pagination: { limit, offset }
      };
    }
  );

  app.get<{ Params: { projectId: string; fileId: string } }>("/api/v1/projects/:projectId/storage/files/:fileId", {
    preHandler: projectAuth,
    schema: { tags: ["storage"], security: [{ bearerAuth: [] }, { apiKeyAuth: [] }] }
  }, async (request, reply) => {
    const file = connection.client.prepare(`
      SELECT id, original_name, mime_type, size_bytes, metadata, created_at
      FROM files WHERE id = ? AND project_id = ?
    `).get(request.params.fileId, request.params.projectId) as {
      id: string; original_name: string; mime_type: string; size_bytes: number; metadata: string; created_at: string
    } | undefined;
    if (!file) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "File not found" } });
    return {
      data: {
        id: file.id,
        name: file.original_name,
        mimeType: file.mime_type,
        sizeBytes: file.size_bytes,
        metadata: JSON.parse(file.metadata),
        createdAt: file.created_at
      }
    };
  });

  app.get<{ Params: { projectId: string; fileId: string } }>("/api/v1/projects/:projectId/storage/files/:fileId/content", {
    preHandler: projectAuth,
    schema: { tags: ["storage"], security: [{ bearerAuth: [] }, { apiKeyAuth: [] }] }
  }, async (request, reply) => {
    const file = connection.client.prepare(`
      SELECT storage_key, original_name, mime_type FROM files WHERE id = ? AND project_id = ?
    `).get(request.params.fileId, request.params.projectId) as {
      storage_key: string; original_name: string; mime_type: string
    } | undefined;
    if (!file) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "File not found" } });
    const content = await storage.open(file.storage_key);
    reply.header("Content-Type", file.mime_type);
    reply.header("Content-Disposition", `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
    reply.header("Cache-Control", "private, no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.send(content);
  });

  app.delete<{ Params: { projectId: string; fileId: string } }>("/api/v1/projects/:projectId/storage/files/:fileId", {
    preHandler: projectAuth,
    schema: { tags: ["storage"], security: [{ bearerAuth: [] }, { apiKeyAuth: [] }] }
  }, async (request, reply) => {
    const file = connection.client.prepare(`
      SELECT storage_key, original_name, mime_type, size_bytes FROM files WHERE id = ? AND project_id = ?
    `).get(request.params.fileId, request.params.projectId) as {
      storage_key: string; original_name: string; mime_type: string; size_bytes: number
    } | undefined;
    if (!file) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "File not found" } });
    const now = new Date().toISOString();
    const actorUserId = request.headers.authorization?.startsWith("Bearer ") ? request.user.sub : null;
    const deleteMetadata = connection.client.transaction(() => {
      const result = connection.client.prepare("DELETE FROM files WHERE id = ? AND project_id = ?")
        .run(request.params.fileId, request.params.projectId);
      if (result.changes === 1) {
        connection.client.prepare(`
          INSERT INTO audit_logs (id, project_id, actor_user_id, action, resource_type, resource_id, metadata, created_at)
          VALUES (?, ?, ?, 'file.deleted', 'file', ?, '{}', ?)
        `).run(randomUUID(), request.params.projectId, actorUserId, request.params.fileId, now);
        enqueueWebhookEvent(connection.client, request.params.projectId, "file.deleted", {
          id: request.params.fileId,
          name: file.original_name,
          mimeType: file.mime_type,
          sizeBytes: file.size_bytes
        }, now);
      }
      return result.changes;
    });
    if (deleteMetadata() === 0) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "File not found" } });
    await storage.remove(file.storage_key);
    return reply.code(204).send();
  });

  app.post<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/api-keys", {
    preHandler: auth,
    schema: { tags: ["projects"], security: [{ bearerAuth: [] }] }
  }, async (request, reply) => {
    const body = parseBody(apiKeyCreateSchema, request.body);
    const projectId = request.params.projectId;
    const member = connection.client.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?")
      .get(projectId, request.user.sub);
    if (!member) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Project not found" } });
    if (!hasProjectPermission(projectId, request.user.sub, "api_keys:manage")) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Project permission required" } });
    }

    const id = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const key = `nbk_${id}.${secret}`;
    const now = new Date().toISOString();
    const expiresAt = body.expiresAt ? new Date(body.expiresAt).toISOString() : null;
    if (expiresAt && expiresAt <= now) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "API key expiration must be in the future" } });
    }
    connection.client.prepare(`
      INSERT INTO api_keys (id, project_id, name, key_prefix, key_hash, permissions, expires_at, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, body.name, `nbk_${id}`, hashToken(key), JSON.stringify(body.permissions), expiresAt, request.user.sub, now);
    connection.client.prepare(`
      INSERT INTO audit_logs (id, project_id, actor_user_id, action, resource_type, resource_id, metadata, created_at)
      VALUES (?, ?, ?, 'api_key.created', 'api_key', ?, ?, ?)
    `).run(randomUUID(), projectId, request.user.sub, id, JSON.stringify({ name: body.name }), now);
    return reply.code(201).send({
      data: { id, name: body.name, key, keyPrefix: `nbk_${id}`, permissions: body.permissions, expiresAt, createdAt: now }
    });
  });

  app.get<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/api-keys", {
    preHandler: auth,
    schema: { tags: ["projects"], security: [{ bearerAuth: [] }] }
  }, async (request, reply) => {
    const member = connection.client.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?")
      .get(request.params.projectId, request.user.sub);
    if (!member) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Project not found" } });
    if (!hasProjectPermission(request.params.projectId, request.user.sub, "api_keys:manage")) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Project permission required" } });
    }
    const keys = connection.client.prepare(`
      SELECT id, name, key_prefix, permissions, expires_at, last_used_at, revoked_at, created_at
      FROM api_keys WHERE project_id = ? ORDER BY created_at DESC
    `).all(request.params.projectId);
    return { data: keys };
  });

  app.delete<{ Params: { projectId: string; keyId: string } }>("/api/v1/projects/:projectId/api-keys/:keyId", {
    preHandler: auth,
    schema: { tags: ["projects"], security: [{ bearerAuth: [] }] }
  }, async (request, reply) => {
    const member = connection.client.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?")
      .get(request.params.projectId, request.user.sub);
    if (!member) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Project not found" } });
    if (!hasProjectPermission(request.params.projectId, request.user.sub, "api_keys:manage")) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Project permission required" } });
    }
    const now = new Date().toISOString();
    const result = connection.client.prepare(`
      UPDATE api_keys SET revoked_at = ?
      WHERE id = ? AND project_id = ? AND revoked_at IS NULL
    `).run(now, request.params.keyId, request.params.projectId);
    if (result.changes === 0) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "API key not found" } });
    connection.client.prepare(`
      INSERT INTO audit_logs (id, project_id, actor_user_id, action, resource_type, resource_id, metadata, created_at)
      VALUES (?, ?, ?, 'api_key.revoked', 'api_key', ?, '{}', ?)
    `).run(randomUUID(), request.params.projectId, request.user.sub, request.params.keyId, now);
    return reply.code(204).send();
  });

  app.get<{
    Params: { projectId: string; collection: string };
    Querystring: { limit?: string; offset?: string; filter?: string; sort?: string }
  }>(
    "/api/v1/projects/:projectId/data/:collection",
    {
      preHandler: projectAuth,
      schema: {
        tags: ["data"],
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
            offset: { type: "integer", minimum: 0, default: 0 },
            filter: {
              type: "string",
              maxLength: 2048,
              description: "URL-encoded JSON object of up to 10 scalar top-level exact-match filters"
            },
            sort: {
              type: "string",
              maxLength: 256,
              description: "Up to three comma-separated top-level fields; prefix with - for descending"
            }
          },
          additionalProperties: false
        }
      }
    },
    async (request, reply) => {
      const params = parseBody(collectionParamsSchema, { projectId: request.params.projectId, collection: request.params.collection });
      const querySchema = z.object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
        filter: z.string().max(2048).optional(),
        sort: z.string().max(256).optional()
      }).strict();
      const { limit, offset, filter, sort } = parseBody(querySchema, request.query);
      const filters = parseDataFilters(filter);
      const sortTerms = parseDataSort(sort);
      const conditions = ["project_id = ?", "collection = ?"];
      const conditionValues: (string | number | null)[] = [params.projectId, params.collection];
      for (const [field, value] of Object.entries(filters)) {
        const path = `$.${field}`;
        conditions.push("json_type(document, ?) IS NOT NULL AND json_extract(document, ?) IS ?");
        conditionValues.push(path, path, typeof value === "boolean" ? Number(value) : value);
      }
      const orderTerms: string[] = [];
      const orderValues: string[] = [];
      for (const { field, direction } of sortTerms) {
        const path = `$.${field}`;
        orderTerms.push(`CASE WHEN json_type(document, ?) IS NULL THEN 1 ELSE 0 END ASC`);
        orderTerms.push(`json_extract(document, ?) ${direction}`);
        orderValues.push(path, path);
      }
      orderTerms.push("id ASC");
      const whereClause = conditions.join(" AND ");
      const rows = connection.client.prepare(`
        SELECT id, document, created_at, updated_at
        FROM collection_records
        WHERE ${whereClause}
        ORDER BY ${sortTerms.length > 0 ? orderTerms.join(", ") : "created_at DESC, id ASC"}
        LIMIT ? OFFSET ?
      `).all(...conditionValues, ...(sortTerms.length > 0 ? orderValues : []), limit, offset) as {
        id: string; document: string; created_at: string; updated_at: string
      }[];
      return { data: rows.map((row) => ({ id: row.id, document: JSON.parse(row.document), createdAt: row.created_at, updatedAt: row.updated_at })), pagination: { limit, offset } };
    }
  );

  app.post<{ Params: { projectId: string; collection: string } }>(
    "/api/v1/projects/:projectId/data/:collection",
    { preHandler: projectAuth, schema: { tags: ["data"], security: [{ bearerAuth: [] }, { apiKeyAuth: [] }] } },
    async (request, reply) => {
      const params = parseBody(collectionParamsSchema, { projectId: request.params.projectId, collection: request.params.collection });
      const document = parseBody(documentSchema, request.body);
      const id = randomUUID();
      const now = new Date().toISOString();
      const createRecord = connection.client.transaction(() => {
        connection.client.prepare(`
          INSERT INTO collection_records (id, project_id, collection, document, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, params.projectId, params.collection, JSON.stringify(document), now, now);
        enqueueWebhookEvent(connection.client, params.projectId, "data.created", { id, collection: params.collection }, now);
      });
      createRecord();
      return reply.code(201).send({ data: { id, document, createdAt: now, updatedAt: now } });
    }
  );

  app.get<{ Params: { projectId: string; collection: string; recordId: string } }>(
    "/api/v1/projects/:projectId/data/:collection/:recordId",
    { preHandler: projectAuth, schema: { tags: ["data"], security: [{ bearerAuth: [] }, { apiKeyAuth: [] }] } },
    async (request, reply) => {
      const params = parseBody(collectionParamsSchema, { projectId: request.params.projectId, collection: request.params.collection });
      const row = connection.client.prepare(`
        SELECT id, document, created_at, updated_at FROM collection_records
        WHERE project_id = ? AND collection = ? AND id = ?
      `).get(params.projectId, params.collection, request.params.recordId) as { id: string; document: string; created_at: string; updated_at: string } | undefined;
      if (!row) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Record not found" } });
      return { data: { id: row.id, document: JSON.parse(row.document), createdAt: row.created_at, updatedAt: row.updated_at } };
    }
  );

  app.put<{ Params: { projectId: string; collection: string; recordId: string } }>(
    "/api/v1/projects/:projectId/data/:collection/:recordId",
    { preHandler: projectAuth, schema: { tags: ["data"], security: [{ bearerAuth: [] }, { apiKeyAuth: [] }] } },
    async (request, reply) => {
      const params = parseBody(collectionParamsSchema, { projectId: request.params.projectId, collection: request.params.collection });
      const document = parseBody(documentSchema, request.body);
      const now = new Date().toISOString();
      const updateRecord = connection.client.transaction(() => {
        const result = connection.client.prepare(`
          UPDATE collection_records SET document = ?, updated_at = ?
          WHERE project_id = ? AND collection = ? AND id = ?
        `).run(JSON.stringify(document), now, params.projectId, params.collection, request.params.recordId);
        if (result.changes === 1) {
          enqueueWebhookEvent(connection.client, params.projectId, "data.updated", {
            id: request.params.recordId,
            collection: params.collection
          }, now);
        }
        return result.changes;
      });
      if (updateRecord() === 0) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Record not found" } });
      return { data: { id: request.params.recordId, document, updatedAt: now } };
    }
  );

  app.delete<{ Params: { projectId: string; collection: string; recordId: string } }>(
    "/api/v1/projects/:projectId/data/:collection/:recordId",
    { preHandler: projectAuth, schema: { tags: ["data"], security: [{ bearerAuth: [] }, { apiKeyAuth: [] }] } },
    async (request, reply) => {
      const params = parseBody(collectionParamsSchema, { projectId: request.params.projectId, collection: request.params.collection });
      const deleteRecord = connection.client.transaction(() => {
        const result = connection.client.prepare(`
          DELETE FROM collection_records WHERE project_id = ? AND collection = ? AND id = ?
        `).run(params.projectId, params.collection, request.params.recordId);
        if (result.changes === 1) {
          enqueueWebhookEvent(connection.client, params.projectId, "data.deleted", {
            id: request.params.recordId,
            collection: params.collection
          }, new Date().toISOString());
        }
        return result.changes;
      });
      if (deleteRecord() === 0) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Record not found" } });
      return reply.code(204).send();
    }
  );

  let webhookInterval: NodeJS.Timeout | undefined;
  let webhookRun: Promise<void> | undefined;
  if (webhookWorker && config.NODE_ENV !== "test") {
    webhookInterval = setInterval(() => {
      if (webhookRun) return;
      webhookRun = webhookWorker.runOnce()
        .then(() => undefined)
        .catch((error: unknown) => app.log.error({ err: error }, "Webhook delivery worker failed"))
        .finally(() => { webhookRun = undefined; });
    }, 1000);
    webhookInterval.unref();
  }

  app.addHook("onClose", async () => {
    if (webhookInterval) clearInterval(webhookInterval);
    if (webhookRun) await webhookRun;
    if (!database) connection.close();
  });

  return app;
}
