// procura/client.ts -- logs in to Procura as the ASSISTANT service account and calls its HTTP API.
//
// The server is the security boundary: this account can only create POs/RFQs and make the
// permitted item edits. The client never retries a write whose outcome is unknown.

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ServiceCredentials {
  base_url: string;
  email: string;
  pin: string;
}

export interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

export interface ProcuraApi {
  post(path: string, body: unknown): Promise<ApiResult>;
}

/** The request may or may not have reached Procura (timeout, connection reset). Check before retrying. */
export class AmbiguousOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousOutcomeError";
  }
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.PROCURA_SERVICE_FILE || join(homedir(), ".procura", "service.json");
}

export async function loadCredentials(path: string = credentialsPath()): Promise<ServiceCredentials> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new Error(`Assistant account is not configured: ${path} is missing.`);
  }
  if ((info.mode & 0o077) !== 0) throw new Error(`${path} must be readable only by its owner (chmod 600).`);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(`${path} is not valid JSON.`);
  }
  const email = typeof raw.email === "string" ? raw.email.trim() : "";
  const pin = typeof raw.pin === "string" ? raw.pin : "";
  if (!email || !pin) throw new Error(`${path} needs "email" and "pin".`);
  const base = typeof raw.base_url === "string" && raw.base_url ? raw.base_url : "http://127.0.0.1:8082";
  return { base_url: base.replace(/\/+$/, ""), email, pin };
}

const TOKEN_LIFETIME_MS = 14 * 60 * 1000; // Procura tokens last 15 minutes and do not slide
const REQUEST_TIMEOUT_MS = 20_000;

function tokenFromCookies(headers: Headers): string {
  for (const cookie of headers.getSetCookie()) {
    const match = /^token=([^;]+)/.exec(cookie);
    if (match) return match[1] ?? "";
  }
  return "";
}

export class ProcuraClient implements ProcuraApi {
  #credentials: ServiceCredentials;
  #token = "";
  #expires = 0;

  constructor(credentials: ServiceCredentials) {
    this.#credentials = credentials;
  }

  async #login(): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.#credentials.base_url}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: this.#credentials.email, pin: this.#credentials.pin }),
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error("Could not reach Procura to log in.");
    }
    if (response.status !== 200) throw new Error(`Procura login failed (HTTP ${response.status}). The assistant account may be locked or its PIN changed.`);
    const token = tokenFromCookies(response.headers);
    if (!token) throw new Error("Procura login returned no session token.");
    this.#token = token;
    this.#expires = Date.now() + TOKEN_LIFETIME_MS;
  }

  async #send(path: string, body: unknown): Promise<Response> {
    if (!this.#token || Date.now() >= this.#expires) await this.#login();
    try {
      return await fetch(`${this.#credentials.base_url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.#token}` },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new AmbiguousOutcomeError(`The request to ${path} did not complete; Procura may or may not have saved it.`);
    }
  }

  async post(path: string, body: unknown): Promise<ApiResult> {
    let response = await this.#send(path, body);
    // A rejected session answers with a redirect or 401 before any handler runs, so one retry is safe.
    if (response.status === 303 || response.status === 401) {
      this.#token = "";
      response = await this.#send(path, body);
    }
    let parsed: Record<string, unknown> = {};
    try {
      parsed = (await response.json()) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    return { status: response.status, body: parsed };
  }
}
