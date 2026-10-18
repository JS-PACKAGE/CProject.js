export class SyncError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "SyncError";
  }
}

export function serverOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.username || url.password || url.search || url.hash ||
    (url.pathname !== "/" && url.pathname !== "") ||
    (url.protocol !== "https:" && !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    ))
  ) throw new Error("Use an HTTPS server origin (HTTP is only allowed on localhost).");
  return url.origin;
}

export class SyncTransport {
  constructor(
    readonly origin: string,
    private onError: (error: SyncError) => void = () => {},
  ) {}

  async request<T>(path: string, body?: unknown): Promise<T> {
    try {
      const response = await fetch(`${this.origin}/api/${path}`, {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data: unknown = await response.json();
      if (!response.ok) {
        const failure = data as { error?: string; code?: string };
        throw new SyncError(
          failure.error ?? `Server returned ${response.status}`,
          response.status,
          failure.code ?? "server_error",
        );
      }
      return data as T;
    } catch (cause) {
      const error = cause instanceof SyncError ? cause : new SyncError(
        "Cannot reach the sync server. Changes were not confirmed; reconnect and refresh before editing.",
        0,
        "network_error",
      );
      this.onError(error);
      throw error;
    }
  }
}
