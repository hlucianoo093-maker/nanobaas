import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

const MAX_PENDING_DELIVERIES_PER_WEBHOOK = 100;
const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;

export class WebhookQueueFullError extends Error {
  readonly statusCode = 503;
  readonly code = "WEBHOOK_QUEUE_FULL";

  constructor() {
    super("Webhook delivery queue is full");
    this.name = "WebhookQueueFullError";
  }
}

export function enqueueWebhookEvent(
  database: Database.Database,
  projectId: string,
  event: string,
  data: Record<string, unknown>,
  occurredAt: string
): void {
  const eventId = randomUUID();
  const payload = JSON.stringify({ id: eventId, projectId, event, occurredAt, data });
  if (Buffer.byteLength(payload) > MAX_EVENT_PAYLOAD_BYTES) {
    throw new Error("Webhook event payload exceeds the configured limit");
  }

  const hooks = database.prepare(`
    SELECT id, events FROM webhooks WHERE project_id = ? AND is_active = 1
  `).all(projectId) as { id: string; events: string }[];
  const countPending = database.prepare(`
    SELECT COUNT(*) AS count FROM webhook_deliveries
    WHERE webhook_id = ? AND status IN ('pending', 'processing')
  `);
  const insert = database.prepare(`
    INSERT INTO webhook_deliveries
      (id, webhook_id, project_id, event, payload, status, attempts, next_attempt_at, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)
  `);
  for (const hook of hooks) {
    if (!(JSON.parse(hook.events) as string[]).includes(event)) continue;
    const pending = countPending.get(hook.id) as { count: number };
    if (pending.count >= MAX_PENDING_DELIVERIES_PER_WEBHOOK) throw new WebhookQueueFullError();
    insert.run(randomUUID(), hook.id, projectId, event, payload, occurredAt, occurredAt);
  }
}
