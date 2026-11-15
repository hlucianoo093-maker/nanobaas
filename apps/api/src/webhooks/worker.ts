import type Database from "better-sqlite3";
import { decryptWebhookSecret } from "./crypto.js";
import { WebhookDeliveryError } from "./transport.js";

export type WebhookTransport = (
  target: string,
  secret: string,
  eventId: string,
  event: string,
  body: string
) => Promise<void>;

type ClaimedDelivery = {
  id: string;
  attempts: number;
  payload: string;
  event: string;
  url: string;
  secret_ciphertext: string | null;
};

const MAX_ATTEMPTS = 5;
const LEASE_MILLISECONDS = 30_000;

export class WebhookDeliveryWorker {
  private lastPrunedAt = 0;

  constructor(
    private readonly database: Database.Database,
    private readonly encryptionKey: Buffer,
    private readonly transport: WebhookTransport
  ) {}

  async runOnce(now = new Date()): Promise<boolean> {
    this.pruneOldDeliveries(now);
    const nowIso = now.toISOString();
    const claimed = this.claimDelivery(nowIso);
    if (!claimed) return false;

    try {
      if (!claimed.secret_ciphertext) throw new Error("Webhook secret ciphertext is missing");
      await this.transport(
        claimed.url,
        decryptWebhookSecret(claimed.secret_ciphertext, this.encryptionKey),
        claimed.id,
        claimed.event,
        claimed.payload
      );
      this.database.prepare(`
        UPDATE webhook_deliveries
        SET status = 'succeeded', delivered_at = ?, lease_until = NULL, last_error = NULL
        WHERE id = ? AND status = 'processing'
      `).run(new Date().toISOString(), claimed.id);
    } catch (error) {
      const retryAt = new Date(now.getTime() + Math.min(300, 2 ** claimed.attempts) * 1000).toISOString();
      const terminal = claimed.attempts >= MAX_ATTEMPTS;
      const errorCode = error instanceof WebhookDeliveryError ? error.code : "internal_delivery_error";
      this.database.prepare(`
        UPDATE webhook_deliveries SET status = ?, next_attempt_at = ?, lease_until = NULL, last_error = ?
        WHERE id = ? AND status = 'processing'
      `).run(terminal ? "failed" : "pending", retryAt, errorCode, claimed.id);
      if (!(error instanceof WebhookDeliveryError)) throw error;
    }
    return true;
  }

  private claimDelivery(now: string): ClaimedDelivery | undefined {
    const leaseUntil = new Date(Date.parse(now) + LEASE_MILLISECONDS).toISOString();
    const claim = this.database.transaction(() => {
      this.database.prepare(`
        UPDATE webhook_deliveries
        SET status = 'failed', lease_until = NULL, last_error = 'attempt_limit_reached'
        WHERE status = 'processing' AND lease_until <= ? AND attempts >= ?
      `).run(now, MAX_ATTEMPTS);
      const delivery = this.database.prepare(`
        SELECT d.id, d.attempts, d.payload, d.event, w.url, w.secret_ciphertext
        FROM webhook_deliveries d
        JOIN webhooks w ON w.id = d.webhook_id AND w.project_id = d.project_id
        WHERE w.is_active = 1 AND (
          (d.status = 'pending' AND d.next_attempt_at <= ?)
          OR (d.status = 'processing' AND d.lease_until <= ? AND d.attempts < ?)
        )
        ORDER BY d.next_attempt_at, d.created_at, d.id LIMIT 1
      `).get(now, now, MAX_ATTEMPTS) as ClaimedDelivery | undefined;
      if (!delivery) return undefined;
      const updated = this.database.prepare(`
        UPDATE webhook_deliveries
        SET status = 'processing', attempts = attempts + 1, lease_until = ?
        WHERE id = ? AND (
          (status = 'pending' AND next_attempt_at <= ?)
          OR (status = 'processing' AND lease_until <= ? AND attempts < ?)
        )
      `).run(leaseUntil, delivery.id, now, now, MAX_ATTEMPTS);
      if (updated.changes !== 1) return undefined;
      return { ...delivery, attempts: delivery.attempts + 1 };
    });
    return claim();
  }

  private pruneOldDeliveries(now: Date): void {
    if (now.getTime() - this.lastPrunedAt < 60 * 60 * 1000) return;
    this.lastPrunedAt = now.getTime();
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    this.database.prepare(`
      DELETE FROM webhook_deliveries
      WHERE id IN (
        SELECT id FROM webhook_deliveries
        WHERE status IN ('succeeded', 'failed', 'cancelled') AND created_at < ?
        ORDER BY created_at LIMIT 100
      )
    `).run(cutoff);
  }
}
