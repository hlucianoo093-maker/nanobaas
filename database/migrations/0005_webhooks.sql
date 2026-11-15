ALTER TABLE webhooks ADD COLUMN secret_ciphertext TEXT;
CREATE UNIQUE INDEX webhooks_id_project_idx ON webhooks(id, project_id);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  webhook_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT NOT NULL,
  lease_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  FOREIGN KEY (webhook_id, project_id) REFERENCES webhooks(id, project_id) ON DELETE CASCADE
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries(status, next_attempt_at, created_at);
CREATE INDEX webhook_deliveries_project_idx ON webhook_deliveries(project_id, created_at);
CREATE INDEX webhook_deliveries_hook_status_idx ON webhook_deliveries(webhook_id, status);

INSERT INTO permissions (id, name, description)
VALUES ('00000000-0000-4000-8000-00000000000b', 'webhooks:manage', 'Create and manage project webhooks');
