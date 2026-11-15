import WebSocket from "ws";

export const MAX_REALTIME_MESSAGE_BYTES = 16 * 1024;
const MAX_CONNECTIONS = 256;
const MAX_CONNECTIONS_PER_PROJECT = 100;
const MAX_CONNECTIONS_PER_USER = 5;
const MAX_CHANNELS_PER_CONNECTION = 10;
const MAX_BUFFERED_BYTES = 256 * 1024;

export interface RealtimeIdentity {
  projectId: string;
  userId: string;
  sessionId: string;
  expiresAt: number;
}

interface RealtimeConnection {
  socket: WebSocket;
  projectId: string;
  identity?: RealtimeIdentity;
  channels: Set<string>;
}

function channelKey(projectId: string, channel: string): string {
  return `${projectId}:${channel}`;
}

export class RealtimeHub {
  private readonly connections = new Map<WebSocket, RealtimeConnection>();
  private readonly subscribers = new Map<string, Set<RealtimeConnection>>();

  connect(socket: WebSocket, projectId: string): boolean {
    if (this.connections.size >= MAX_CONNECTIONS) return false;
    let projectConnections = 0;
    for (const connection of this.connections.values()) {
      if (connection.projectId === projectId) projectConnections += 1;
    }
    if (projectConnections >= MAX_CONNECTIONS_PER_PROJECT) return false;
    this.connections.set(socket, { socket, projectId, channels: new Set() });
    return true;
  }

  authenticate(socket: WebSocket, identity: RealtimeIdentity): boolean {
    const connection = this.connections.get(socket);
    if (!connection || connection.identity || connection.projectId !== identity.projectId) return false;
    let userConnections = 0;
    for (const candidate of this.connections.values()) {
      if (candidate.projectId === identity.projectId && candidate.identity?.userId === identity.userId) {
        userConnections += 1;
      }
    }
    if (userConnections >= MAX_CONNECTIONS_PER_USER) return false;
    connection.identity = identity;
    return true;
  }

  subscribe(socket: WebSocket, channel: string): boolean {
    const connection = this.connections.get(socket);
    if (!connection?.identity) return false;
    if (!connection.channels.has(channel) && connection.channels.size >= MAX_CHANNELS_PER_CONNECTION) return false;
    connection.channels.add(channel);
    const key = channelKey(connection.projectId, channel);
    const channelSubscribers = this.subscribers.get(key) ?? new Set<RealtimeConnection>();
    channelSubscribers.add(connection);
    this.subscribers.set(key, channelSubscribers);
    return true;
  }

  unsubscribe(socket: WebSocket, channel: string): void {
    const connection = this.connections.get(socket);
    if (!connection) return;
    connection.channels.delete(channel);
    const key = channelKey(connection.projectId, channel);
    const channelSubscribers = this.subscribers.get(key);
    channelSubscribers?.delete(connection);
    if (channelSubscribers?.size === 0) this.subscribers.delete(key);
  }

  send(socket: WebSocket, message: unknown): boolean {
    const connection = this.connections.get(socket);
    if (!connection || socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.close(socket, 1013, "Slow connection");
      return false;
    }
    const serialized = JSON.stringify(message);
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_REALTIME_MESSAGE_BYTES) return false;
    socket.send(serialized, (error) => {
      if (error) {
        this.remove(socket);
        socket.terminate();
      }
    });
    return true;
  }

  publish(
    projectId: string,
    channel: string,
    message: unknown,
    isAuthorized: (identity: RealtimeIdentity) => boolean
  ): number {
    const channelSubscribers = this.subscribers.get(channelKey(projectId, channel));
    if (!channelSubscribers) return 0;
    let delivered = 0;
    for (const connection of [...channelSubscribers]) {
      if (!connection.identity || !isAuthorized(connection.identity)) {
        this.close(connection.socket, 1008, "Project access revoked");
        continue;
      }
      if (this.send(connection.socket, message)) delivered += 1;
    }
    return delivered;
  }

  remove(socket: WebSocket): void {
    const connection = this.connections.get(socket);
    if (!connection) return;
    for (const channel of connection.channels) {
      const key = channelKey(connection.projectId, channel);
      const channelSubscribers = this.subscribers.get(key);
      channelSubscribers?.delete(connection);
      if (channelSubscribers?.size === 0) this.subscribers.delete(key);
    }
    this.connections.delete(socket);
  }

  closeAll(): void {
    for (const socket of this.connections.keys()) this.close(socket, 1001, "Server shutting down");
  }

  private close(socket: WebSocket, code: number, reason: string): void {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(code, reason);
    }
    this.remove(socket);
  }
}
