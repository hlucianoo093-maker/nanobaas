export interface Project {
  id: string;
  name: string;
  slug: string;
  settings: string;
  created_at: string;
  updated_at?: string;
  member_role?: string;
}

export interface ProjectOverview extends Project {
  member_count: number;
  record_count: number;
  active_api_key_count: number;
  file_count: number;
  storage_bytes: number;
  role_count: number;
  active_webhook_count: number;
}

export interface Member {
  id: string;
  email: string;
  role: string;
  created_at: string;
  assignedRoles: { id: string; name: string }[];
}

export interface Permission {
  name: string;
  description: string;
}

export interface ProjectRole {
  id: string;
  name: string;
  description: string;
  created_at: string;
  permissions: string[];
}

export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  permissions: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface StoredFile {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  actor_user_id: string | null;
  actor_email: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  ip_address: string | null;
  metadata: string;
  created_at: string;
}

export interface PlatformUser {
  id: string;
  email: string;
  email_verified_at: string | null;
  is_active: number;
  is_platform_admin_configured: boolean;
  is_platform_admin: boolean;
  created_at: string;
  updated_at: string;
  project_count: number;
  active_session_count: number;
}

export interface PlatformOverview {
  user_count: number;
  active_user_count: number;
  project_count: number;
  active_session_count: number;
  file_count: number;
  storage_bytes: number;
}

export interface PlatformSettings {
  apiVersion: string;
  environment: string;
  nodeVersion: string;
  maxFileBytes: number;
  emailDeliveryEnabled: boolean;
  webhookDeliveryEnabled: boolean;
  configuredPlatformAdminCount: number;
}

export interface PlatformAuditEntry {
  id: string;
  actor_user_id: string | null;
  actor_email: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  ip_address: string | null;
  metadata: string;
  created_at: string;
}
