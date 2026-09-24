// procura/db.ts — read-only SQLite access layer for the Procura extension.
// Writes are NEVER allowed here: the sqlite3 CLI is always invoked with
// -readonly, and raw SQL is additionally gated to SELECT/WITH statements so
// that any mutation has to go through the Procura app itself (which keeps
// po_audit / movement_edit_audit / item_anchor_audit consistent).

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type Row = Record<string, unknown>;

export interface ProcuraConfig {
  db_path?: string;
}

const defaultDbPath = "/home/procura/data/procura.sqlite";
const SQLITE_TIMEOUT_MS = 10_000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export function resolveDbPath(): Promise<string> {
  return (async () => {
    try {
      const cfgPath = join(homedir(), ".procura", "config.json");
      const raw = await readFile(cfgPath, "utf8");
      const cfg = JSON.parse(raw) as ProcuraConfig;
      return cfg.db_path || defaultDbPath;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.error("[procura] failed to read config, using default db path", error);
      }
      return defaultDbPath;
    }
  })();
}

// Statement-level safety gate. The lexical analysis below is comment- and
// string-aware so that SQL literals containing ";" or write-verbs ("delete",
// "update", ...) are not falsely rejected while genuinely multi-statement or
// mutating SQL is. The sqlite3 -readonly flag remains the hard backstop.
const LITERAL_OR_COMMENT =
  /'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g;
// Word-boundary write verbs outside literals. SQLite has no DML-in-CTE, so
// these cannot appear in a legitimate read-only SELECT/WITH statement as bare
// keywords (they cannot appear unquoted as identifiers either). "end"/"begin"
// are intentionally NOT here — CASE ... END is valid inside SELECT.
const WRITE_VERB = /\b(?:insert|update|delete|replace)\b/i;

function stripLiteralsAndComments(sql: string): string {
  return sql.replace(LITERAL_OR_COMMENT, " ");
}

export function assertReadOnly(sql: string): string {
  const cleaned = sql.trim().replace(/;+\s*$/, "");
  const stripped = stripLiteralsAndComments(cleaned);

  if (stripped.includes(";")) {
    throw new Error("Only a single SQL statement is allowed");
  }
  if (!/^(select|with)\b/i.test(stripped)) {
    throw new Error("Only SELECT or WITH queries are allowed");
  }
  // Defence in depth: block WITH-attached DML (e.g. "WITH x AS (...) DELETE
  // FROM ...") which the leading-keyword check alone would pass. Such a
  // statement would already fail under sqlite3 -readonly, but we refuse it
  // here so it never reaches the CLI at all.
  if (WRITE_VERB.test(stripped)) {
    throw new Error("Data-modifying statements (INSERT/UPDATE/DELETE/REPLACE) are not allowed");
  }
  return cleaned;
}

export function applyRowCap(sql: string, maxRows: number): string {
  // Always wrap as a subquery with an outer LIMIT. The newlines around the
  // inner statement keep a trailing "--" comment from swallowing the closing
  // paren, and the cap cannot be sidestepped by a "limit" keyword mention.
  return `SELECT * FROM (\n${sql}\n) LIMIT ${maxRows}`;
}

export async function queryRows(
  dbPath: string,
  sql: string,
  maxRows: number,
): Promise<Row[]> {
  const guarded = `${maxRows > 0 ? applyRowCap(assertReadOnly(sql), maxRows) : assertReadOnly(sql)};`;
  try {
    const { stdout } = await run("sqlite3", ["-json", "-readonly", dbPath, guarded], {
      timeout: SQLITE_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
    });
    const trimmed = stdout.trim();
    return trimmed ? (JSON.parse(trimmed) as Row[]) : [];
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Procura query failed: ${message}`);
  }
}

export async function queryRowsCapped(
  dbPath: string,
  sql: string,
  maxRows: number,
): Promise<Row[]> {
  const rows = await queryRows(dbPath, sql, maxRows);
  return rows.length > maxRows ? rows.slice(0, maxRows) : rows;
}

// raw_po_json rows use short keys (n/q/c/t/u) while the documented
// purchase_order_items columns are item_name/quantity/cost/total/uom. The PO
// fallback path stores raw JSON — normalize it so callers always see the
// documented shape. Unknown keys pass through untouched.
const RAW_PO_KEY_MAP: Record<string, string> = {
  n: "item_name",
  q: "quantity",
  c: "cost",
  t: "total",
  u: "uom",
};

export function normalizePoLines(raw: unknown): Row[] {
  let arr: unknown = raw;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((r) => {
    if (r && typeof r === "object" && !Array.isArray(r)) {
      const out: Row = {};
      for (const [k, v] of Object.entries(r as Row)) out[RAW_PO_KEY_MAP[k] ?? k] = v;
      return out;
    }
    return { value: r };
  });
}
