const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/+$/, "") ?? "";

type ApiEnvelope<T> = {
  data?: T;
  error?: { code?: string; message?: string };
  pagination?: { limit: number; offset: number; total: number };
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class ApiClient {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private refreshRequest: Promise<boolean> | null = null;
  private sessionExpired: (() => void) | null = null;

  setSession(accessToken: string, refreshToken: string): void {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
  }

  clearSession(): void {
    this.accessToken = null;
    this.refreshToken = null;
  }

  onSessionExpired(callback: () => void): void {
    this.sessionExpired = callback;
  }

  async logout(): Promise<void> {
    const refreshToken = this.refreshToken;
    if (refreshToken) {
      await this.request<void>("/api/v1/auth/logout", {
        method: "POST",
        body: JSON.stringify({ refreshToken })
      });
    }
    this.clearSession();
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchAuthorized(path, init);
    const body = await this.readBody<T>(response);
    if (!response.ok) {
      throw new ApiError(body.error?.message ?? "The request failed", response.status, body.error?.code ?? "REQUEST_FAILED");
    }
    return body.data as T;
  }

  async requestPage<T>(path: string): Promise<{ data: T; pagination: { limit: number; offset: number; total: number } }> {
    const response = await this.fetchAuthorized(path, {});
    const body = await this.readBody<T>(response);
    if (!response.ok) {
      throw new ApiError(body.error?.message ?? "The request failed", response.status, body.error?.code ?? "REQUEST_FAILED");
    }
    if (!body.data || !body.pagination) {
      throw new ApiError("The server returned an invalid paginated response", response.status, "INVALID_RESPONSE");
    }
    return { data: body.data, pagination: body.pagination };
  }

  async download(path: string): Promise<Blob> {
    const response = await this.fetchAuthorized(path, {});
    if (!response.ok) {
      const body = await this.readBody<never>(response);
      throw new ApiError(body.error?.message ?? "The download failed", response.status, body.error?.code ?? "REQUEST_FAILED");
    }
    return response.blob();
  }

  private async fetchAuthorized(path: string, init: RequestInit): Promise<Response> {
    let response = await this.fetch(path, init);
    if (response.status === 401 && this.refreshToken && path !== "/api/v1/auth/refresh") {
      if (await this.refreshSession()) response = await this.fetch(path, init);
    }
    if (response.status === 401) {
      this.clearSession();
      this.sessionExpired?.();
    }
    return response;
  }

  private async fetch(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (this.accessToken) headers.set("authorization", `Bearer ${this.accessToken}`);
    if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return fetch(`${apiBase}${path}`, { ...init, headers });
  }

  private async refreshSession(): Promise<boolean> {
    if (this.refreshRequest) return this.refreshRequest;
    const refreshToken = this.refreshToken;
    if (!refreshToken) return false;
    this.refreshRequest = (async () => {
      try {
        const response = await fetch(`${apiBase}/api/v1/auth/refresh`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ refreshToken })
        });
        if (!response.ok) {
          this.clearSession();
          this.sessionExpired?.();
          return false;
        }
        const body = await response.json() as ApiEnvelope<{ accessToken: string; refreshToken: string }>;
        if (!body.data) {
          this.clearSession();
          this.sessionExpired?.();
          return false;
        }
        this.setSession(body.data.accessToken, body.data.refreshToken);
        return true;
      } catch (error) {
        this.clearSession();
        this.sessionExpired?.();
        throw error;
      } finally {
        this.refreshRequest = null;
      }
    })();
    return this.refreshRequest;
  }

  private async readBody<T>(response: Response): Promise<ApiEnvelope<T>> {
    if (response.status === 204) return {};
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as ApiEnvelope<T>;
    } catch {
      throw new ApiError("The server returned an invalid response", response.status, "INVALID_RESPONSE");
    }
  }
}

export const api = new ApiClient();

export function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}
