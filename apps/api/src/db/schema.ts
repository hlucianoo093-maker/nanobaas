import { sqliteTable, text, integer, primaryKey, uniqueIndex, index, foreignKey } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  settings: text("settings").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  emailVerifiedAt: text("email_verified_at"),
  isActive: integer("is_active").notNull(),
  metadata: text("metadata").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [uniqueIndex("users_email_idx").on(table.email)]);

export const projectMembers = sqliteTable("project_members", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [primaryKey({ columns: [table.projectId, table.userId] }), index("project_members_user_idx").on(table.userId)]);

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  refreshTokenHash: text("refresh_token_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at")
}, (table) => [uniqueIndex("sessions_refresh_hash_idx").on(table.refreshTokenHash), index("sessions_user_idx").on(table.userId)]);

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  keyHash: text("key_hash").notNull(),
  permissions: text("permissions").notNull(),
  expiresAt: text("expires_at"),
  lastUsedAt: text("last_used_at"),
  revokedAt: text("revoked_at"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: text("created_at").notNull()
}, (table) => [uniqueIndex("api_keys_hash_idx").on(table.keyHash), index("api_keys_project_idx").on(table.projectId)]);

export const roles = sqliteTable("roles", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [
  uniqueIndex("roles_project_name_idx").on(table.projectId, table.name),
  uniqueIndex("roles_id_project_idx").on(table.id, table.projectId)
]);

export const permissions = sqliteTable("permissions", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description").notNull()
});

export const rolePermissions = sqliteTable("role_permissions", {
  roleId: text("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
  permissionId: text("permission_id").notNull().references(() => permissions.id, { onDelete: "cascade" })
}, (table) => [primaryKey({ columns: [table.roleId, table.permissionId] })]);

export const userRoles = sqliteTable("user_roles", {
  projectId: text("project_id").notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  roleId: text("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull()
}, (table) => [
  primaryKey({ columns: [table.projectId, table.userId, table.roleId] }),
  foreignKey({
    name: "user_roles_member_fk",
    columns: [table.projectId, table.userId],
    foreignColumns: [projectMembers.projectId, projectMembers.userId]
  }).onDelete("cascade"),
  foreignKey({
    name: "user_roles_role_fk",
    columns: [table.roleId, table.projectId],
    foreignColumns: [roles.id, roles.projectId]
  }).onDelete("cascade")
]);

export const files = sqliteTable("files", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  storageKey: text("storage_key").notNull().unique(),
  originalName: text("original_name").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  metadata: text("metadata").notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: text("created_at").notNull()
}, (table) => [index("files_project_idx").on(table.projectId)]);

export const webhooks = sqliteTable("webhooks", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  secretHash: text("secret_hash").notNull(),
  secretCiphertext: text("secret_ciphertext"),
  events: text("events").notNull(),
  isActive: integer("is_active").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [
  index("webhooks_project_idx").on(table.projectId),
  uniqueIndex("webhooks_id_project_idx").on(table.id, table.projectId)
]);

export const webhookDeliveries = sqliteTable("webhook_deliveries", {
  id: text("id").primaryKey(),
  webhookId: text("webhook_id").notNull(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  event: text("event").notNull(),
  payload: text("payload").notNull(),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull(),
  nextAttemptAt: text("next_attempt_at").notNull(),
  leaseUntil: text("lease_until"),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  deliveredAt: text("delivered_at")
}, (table) => [
  foreignKey({
    name: "webhook_deliveries_hook_project_fk",
    columns: [table.webhookId, table.projectId],
    foreignColumns: [webhooks.id, webhooks.projectId]
  }).onDelete("cascade"),
  index("webhook_deliveries_due_idx").on(table.status, table.nextAttemptAt, table.createdAt),
  index("webhook_deliveries_project_idx").on(table.projectId, table.createdAt),
  index("webhook_deliveries_hook_status_idx").on(table.webhookId, table.status)
]);

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id"),
  ipAddress: text("ip_address"),
  metadata: text("metadata").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [index("audit_logs_project_created_idx").on(table.projectId, table.createdAt)]);

export const collectionRecords = sqliteTable("collection_records", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  collection: text("collection").notNull(),
  document: text("document").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [uniqueIndex("collection_records_scope_idx").on(table.projectId, table.collection, table.id)]);
