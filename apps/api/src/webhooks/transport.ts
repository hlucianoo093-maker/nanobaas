import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import ipaddr from "ipaddr.js";
import { signWebhookPayload } from "./crypto.js";

export class WebhookDeliveryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "WebhookDeliveryError";
  }
}

export function validateWebhookUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.port && url.port !== "443")) {
    return null;
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return null;
  }
  return url.toString();
}

function isPublicAddress(address: string): boolean {
  try {
    let parsed = ipaddr.IPv4.isIPv4(address) ? ipaddr.IPv4.parse(address) : ipaddr.IPv6.parse(address);
    if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) parsed = parsed.toIPv4Address();
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}

async function resolvePublicAddress(hostname: string): Promise<{ address: string; family: number }> {
  let addresses: Awaited<ReturnType<typeof lookup>>[];
  let timeout: NodeJS.Timeout | undefined;
  try {
    addresses = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new WebhookDeliveryError("dns_lookup_timeout")), 3000);
      })
    ]);
  } catch (error) {
    if (error instanceof WebhookDeliveryError) throw error;
    throw new WebhookDeliveryError("dns_lookup_failed");
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new WebhookDeliveryError("non_public_destination");
  }
  const address = addresses[0];
  if (!address) throw new WebhookDeliveryError("dns_lookup_failed");
  return address;
}

export async function deliverWebhook(
  target: string,
  secret: string,
  eventId: string,
  event: string,
  body: string
): Promise<void> {
  const normalized = validateWebhookUrl(target);
  if (!normalized) throw new WebhookDeliveryError("invalid_destination");
  const url = new URL(normalized);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const destination = await resolvePublicAddress(hostname);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signWebhookPayload(secret, timestamp, body);
  const serverName = isIP(hostname) === 0 ? hostname : undefined;

  await new Promise<void>((resolve, reject) => {
    const request = httpsRequest({
      hostname: destination.address,
      family: destination.family,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: {
        host: url.host,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "user-agent": "NanoBaaS/1.0",
        "x-nanobaas-event": event,
        "x-nanobaas-delivery": eventId,
        "x-nanobaas-signature": signature
      },
      rejectUnauthorized: true,
      agent: false,
      ...(serverName ? { servername: serverName } : {})
    }, (response) => {
      response.resume();
      response.once("end", () => {
        clearTimeout(absoluteTimeout);
        const statusCode = response.statusCode ?? 0;
        if (statusCode >= 200 && statusCode < 300) resolve();
        else reject(new WebhookDeliveryError(`http_${statusCode}`));
      });
    });
    request.setTimeout(5000, () => request.destroy(new WebhookDeliveryError("request_timeout")));
    const absoluteTimeout = setTimeout(() => request.destroy(new WebhookDeliveryError("request_timeout")), 10_000);
    absoluteTimeout.unref();
    request.once("error", (error: Error) => {
      clearTimeout(absoluteTimeout);
      reject(error instanceof WebhookDeliveryError ? error : new WebhookDeliveryError("network_error"));
    });
    request.end(body);
  });
}
