// procura/guard.ts -- keeps a human in the loop between "preview" and "save".
//
// A preview stores the exact payload. Saving needs the preview id, the same session, an
// unexpired and unused preview, and at least one user message that arrived after the
// preview was made. The agent cannot preview and save in one run, whatever it decides.

export const PREVIEW_TTL_MS = 30 * 60 * 1000;

export interface StoredPreview<T> {
  id: string;
  kind: string;
  sessionId: string;
  createdAt: number;
  used: boolean;
  data: T;
}

export type TakeResult<T> = { ok: true; preview: StoredPreview<T> } | { ok: false; reason: string };

/** True when the session contains a user message newer than `sinceMs`. */
export function humanTurnSince(entries: unknown[], sinceMs: number): boolean {
  for (const entry of entries) {
    const e = entry as { type?: string; timestamp?: string; message?: { role?: string } };
    if (e?.type !== "message" || e.message?.role !== "user") continue;
    const at = Date.parse(e.timestamp ?? "");
    if (Number.isFinite(at) && at > sinceMs) return true;
  }
  return false;
}

export class PreviewStore<T> {
  #items = new Map<string, StoredPreview<T>>();
  #now: () => number;
  #ttl: number;

  constructor(now: () => number = Date.now, ttlMs: number = PREVIEW_TTL_MS) {
    this.#now = now;
    this.#ttl = ttlMs;
  }

  create(kind: string, sessionId: string, data: T): StoredPreview<T> {
    for (const [id, item] of this.#items) if (this.#now() - item.createdAt > this.#ttl) this.#items.delete(id);
    const id = `pv-${Math.random().toString(16).slice(2, 10)}`;
    const preview = { id, kind, sessionId, createdAt: this.#now(), used: false, data };
    this.#items.set(id, preview);
    return preview;
  }

  /** Validates a preview for saving. Does not mark it used; call markUsed once the save is attempted. */
  take(id: string, kind: string, sessionId: string, entries: unknown[]): TakeResult<T> {
    const preview = this.#items.get(id);
    if (!preview) return { ok: false, reason: "No such preview (it may have expired or the service restarted). Preview again." };
    if (preview.kind !== kind) return { ok: false, reason: `That preview is for ${preview.kind}, not ${kind}.` };
    if (preview.sessionId !== sessionId) return { ok: false, reason: "That preview belongs to a different session. Preview again." };
    if (preview.used) return { ok: false, reason: "That preview was already used. Preview again to save another." };
    if (this.#now() - preview.createdAt > this.#ttl) return { ok: false, reason: "That preview expired (30 minutes). Preview again." };
    if (!humanTurnSince(entries, preview.createdAt)) {
      return { ok: false, reason: "Not saved: show the preview to the user and wait for their reply first. A message from the user must arrive after the preview." };
    }
    return { ok: true, preview };
  }

  markUsed(id: string): void {
    const preview = this.#items.get(id);
    if (preview) preview.used = true;
  }
}
