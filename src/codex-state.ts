import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export interface CodexThreadRecord {
  id: string;
  title: string;
  cwd: string;
  model: string | null;
  createdAt: Date;
  updatedAt: Date;
  firstUserMessage: string;
}

export interface CodexModelRecord {
  slug: string;
  displayName: string;
}

export interface CodexHistoryMessage {
  role: "user" | "assistant";
  text: string;
  timestamp?: Date;
}

export interface CodexChildThreadRecord extends CodexThreadRecord {
  parentThreadId: string;
  spawnStatus: string;
}

export interface CodexParentThreadRecord extends CodexThreadRecord {
  childThreadId: string;
  spawnStatus: string;
}

export const FALLBACK_MODELS: CodexModelRecord[] = [
  { slug: "gpt-5.4", displayName: "GPT-5.4" },
  { slug: "gpt-5.4-mini", displayName: "GPT-5.4-Mini" },
  { slug: "gpt-5", displayName: "GPT-5" },
  { slug: "o4-mini", displayName: "o4-mini" },
  { slug: "o3", displayName: "o3" },
  { slug: "o3-mini", displayName: "o3-mini" },
  { slug: "gpt-4o", displayName: "GPT-4o" },
];

type DatabaseCtor = new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => {
  prepare(sql: string): {
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
  };
  close(): void;
};
type DatabaseInstance = InstanceType<DatabaseCtor>;
type ThreadRow = {
  id: unknown;
  title: unknown;
  cwd: unknown;
  model: unknown;
  created_at: unknown;
  updated_at: unknown;
  first_user_message: unknown;
};

type WorkspaceRow = {
  cwd: unknown;
};

type ChildThreadRow = ThreadRow & {
  parent_thread_id: unknown;
  spawn_status: unknown;
};

type ParentThreadRow = ThreadRow & {
  child_thread_id: unknown;
  spawn_status: unknown;
};

type SessionFileCacheEntry = {
  modifiedAtMs: number;
  size: number;
  thread: CodexThreadRecord | null;
};

const betterSqlite3Module = await import("better-sqlite3").catch(() => null);
const BetterSqlite3 = (
  (betterSqlite3Module as { default?: DatabaseCtor } | null)?.default ??
  (betterSqlite3Module as DatabaseCtor | null)
) as DatabaseCtor | null;
const sessionFileCache = new Map<string, SessionFileCacheEntry>();

export function findLatestDatabase(): string | null {
  const codexDir = getCodexDir();
  if (!codexDir || !existsSync(codexDir)) {
    return null;
  }

  try {
    const candidates = readdirSync(codexDir)
      .filter((file) => /^state_.*\.sqlite$/i.test(file))
      .map((file) => {
        const fullPath = path.join(codexDir, file);
        return {
          path: fullPath,
          modifiedAtMs: statSync(fullPath).mtimeMs,
        };
      })
      .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);

    return candidates[0]?.path ?? null;
  } catch {
    return null;
  }
}

export function listThreads(limit = 20): CodexThreadRecord[] {
  const databaseThreads = withDatabase((db) => {
    const query = db.prepare(`
      SELECT id, title, cwd, model, created_at, updated_at, first_user_message
      FROM threads
      WHERE (archived = 0 OR archived IS NULL)
      ORDER BY updated_at DESC
      LIMIT ?
    `);

    const rows = query.all(limit) as ThreadRow[];
    return rows.map(mapThreadRow);
  }) ?? [];

  return mergeThreadRecords(databaseThreads, listSessionFileThreads()).slice(0, Math.max(1, limit));
}

export function getThread(id: string): CodexThreadRecord | null {
  const databaseThread = (
    withDatabase((db) => {
      const query = db.prepare(`
        SELECT id, title, cwd, model, created_at, updated_at, first_user_message
        FROM threads
        WHERE archived = 0 AND id = ?
        LIMIT 1
      `);

      const row = query.get(id) as ThreadRow | undefined;
      return row ? mapThreadRow(row) : null;
    }) ?? null
  );
  return databaseThread ?? listSessionFileThreads().find((thread) => thread.id === id) ?? null;
}

export function getThreadByPrefix(idPrefix: string): CodexThreadRecord | null {
  const normalized = idPrefix.trim();
  if (!normalized) {
    return null;
  }

  const databaseMatches = withDatabase((db) => {
      const query = db.prepare(`
        SELECT id, title, cwd, model, created_at, updated_at, first_user_message
        FROM threads
        WHERE (archived = 0 OR archived IS NULL) AND id LIKE ?
        ORDER BY updated_at DESC
        LIMIT 2
      `);

      const rows = query.all(`${normalized}%`) as ThreadRow[];
      return rows.map(mapThreadRow);
    }) ?? [];
  const matches = mergeThreadRecords(
    databaseMatches,
    listSessionFileThreads().filter((thread) => thread.id.startsWith(normalized)),
  );
  return matches.length === 1 ? matches[0]! : null;
}

export function listChildThreads(parentThreadId: string): CodexChildThreadRecord[] {
  const normalized = parentThreadId.trim();
  if (!normalized) {
    return [];
  }

  return (
    withDatabase((db) => {
      const query = db.prepare(`
        SELECT e.parent_thread_id, e.status AS spawn_status,
               t.id, t.title, t.cwd, t.model, t.created_at, t.updated_at, t.first_user_message
        FROM thread_spawn_edges e
        JOIN threads t ON t.id = e.child_thread_id
        WHERE e.parent_thread_id = ? AND (t.archived = 0 OR t.archived IS NULL)
        ORDER BY t.created_at DESC
      `);

      const rows = query.all(normalized) as ChildThreadRow[];
      return rows.map((row) => ({
        ...mapThreadRow(row),
        parentThreadId: typeof row.parent_thread_id === "string" ? row.parent_thread_id : String(row.parent_thread_id ?? ""),
        spawnStatus: typeof row.spawn_status === "string" ? row.spawn_status : String(row.spawn_status ?? ""),
      }));
    }) ?? []
  );
}

export function getParentThread(childThreadId: string): CodexParentThreadRecord | null {
  const normalized = childThreadId.trim();
  if (!normalized) {
    return null;
  }

  return (
    withDatabase((db) => {
      const query = db.prepare(`
        SELECT e.child_thread_id, e.status AS spawn_status,
               t.id, t.title, t.cwd, t.model, t.created_at, t.updated_at, t.first_user_message
        FROM thread_spawn_edges e
        JOIN threads t ON t.id = e.parent_thread_id
        WHERE e.child_thread_id = ? AND (t.archived = 0 OR t.archived IS NULL)
        LIMIT 1
      `);

      const row = query.get(normalized) as ParentThreadRow | undefined;
      if (!row) {
        return null;
      }

      return {
        ...mapThreadRow(row),
        childThreadId: typeof row.child_thread_id === "string" ? row.child_thread_id : String(row.child_thread_id ?? ""),
        spawnStatus: typeof row.spawn_status === "string" ? row.spawn_status : String(row.spawn_status ?? ""),
      };
    }) ?? null
  );
}

export function readThreadHistory(threadId: string, limit = 10): CodexHistoryMessage[] {
  const sessionPath = findThreadSessionFile(threadId);
  if (!sessionPath) {
    return [];
  }

  const messages: CodexHistoryMessage[] = [];
  try {
    const lines = readFileSync(sessionPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      const parsed = JSON.parse(line) as {
        timestamp?: unknown;
        type?: unknown;
        payload?: unknown;
      };
      const message = extractHistoryMessage(parsed);
      if (message) {
        messages.push(message);
      }
    }
  } catch {
    return [];
  }

  return messages.slice(-Math.max(1, limit));
}

export function listWorkspaces(): string[] {
  const databaseWorkspaces = (
    withDatabase((db) => {
      const query = db.prepare(`
        SELECT DISTINCT cwd
        FROM threads
        WHERE (archived = 0 OR archived IS NULL) AND cwd IS NOT NULL AND cwd != ''
        ORDER BY cwd ASC
      `);

      const rows = query.all() as WorkspaceRow[];
      return rows
        .map((row) => (typeof row.cwd === "string" ? row.cwd : ""))
        .filter(Boolean);
    }) ?? []
  );
  return [...new Set([
    ...databaseWorkspaces,
    ...listSessionFileThreads().map((thread) => thread.cwd).filter(Boolean),
  ])].sort();
}

export function listSessionFileThreads(): CodexThreadRecord[] {
  const codexDir = getCodexDir();
  if (!codexDir) {
    return [];
  }

  const roots = [
    path.join(codexDir, "sessions"),
    path.join(codexDir, "archived_sessions"),
  ].filter((directory) => existsSync(directory));
  const seenFiles = new Set<string>();
  const threads: CodexThreadRecord[] = [];

  for (const root of roots) {
    try {
      for (const sessionPath of walkFiles(root).filter((file) => file.endsWith(".jsonl"))) {
        seenFiles.add(sessionPath);
        try {
          const stats = statSync(sessionPath);
          const cached = sessionFileCache.get(sessionPath);
          let thread = cached?.modifiedAtMs === stats.mtimeMs && cached.size === stats.size
            ? cached.thread
            : undefined;
          if (thread === undefined) {
            thread = parseSessionFileThread(
              sessionPath,
              readFileSync(sessionPath, "utf8"),
              stats.mtimeMs,
            );
            sessionFileCache.set(sessionPath, {
              modifiedAtMs: stats.mtimeMs,
              size: stats.size,
              thread,
            });
          }
          if (thread) {
            threads.push(thread);
          }
        } catch {
          // A single partially-written or inaccessible transcript must not hide other sessions.
        }
      }
    } catch {
      // Ignore a missing or unreadable archive root.
    }
  }

  for (const cachedPath of sessionFileCache.keys()) {
    if (!seenFiles.has(cachedPath)) {
      sessionFileCache.delete(cachedPath);
    }
  }

  return mergeThreadRecords([], threads);
}

export function parseSessionFileThread(
  sessionPath: string,
  contents: string,
  modifiedAtMs = 0,
): CodexThreadRecord | null {
  let id = sessionIdFromFilename(sessionPath);
  let cwd = "";
  let model: string | null = null;
  let firstUserMessage = "";
  let createdAtMs = Number.POSITIVE_INFINITY;
  let updatedAtMs = modifiedAtMs;

  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    try {
      const entry = JSON.parse(line) as {
        timestamp?: unknown;
        type?: unknown;
        payload?: unknown;
      };
      const timestampMs = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
      if (Number.isFinite(timestampMs)) {
        createdAtMs = Math.min(createdAtMs, timestampMs);
        updatedAtMs = Math.max(updatedAtMs, timestampMs);
      }
      if (!entry.payload || typeof entry.payload !== "object") {
        continue;
      }

      const payload = entry.payload as Record<string, unknown>;
      if (entry.type === "session_meta") {
        id = stringValue(payload.id) || stringValue(payload.session_id) || id;
        cwd = stringValue(payload.cwd) || cwd;
        const sessionTimestampMs = Date.parse(stringValue(payload.timestamp));
        if (Number.isFinite(sessionTimestampMs)) {
          createdAtMs = Math.min(createdAtMs, sessionTimestampMs);
        }
      } else if (entry.type === "turn_context") {
        cwd = stringValue(payload.cwd) || cwd;
        model = stringValue(payload.model) || model;
      } else if (
        entry.type === "event_msg" &&
        payload.type === "user_message" &&
        !firstUserMessage
      ) {
        firstUserMessage = stringValue(payload.message).trim();
      }
    } catch {
      // Ignore an incomplete trailing JSONL line while Codex is still writing.
    }
  }

  if (!id) {
    return null;
  }
  if (!Number.isFinite(createdAtMs)) {
    createdAtMs = modifiedAtMs;
  }
  if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0) {
    updatedAtMs = createdAtMs;
  }

  return {
    id,
    title: "",
    cwd,
    model,
    createdAt: new Date(Math.max(0, createdAtMs)),
    updatedAt: new Date(Math.max(0, updatedAtMs)),
    firstUserMessage,
  };
}

export function listModels(): CodexModelRecord[] {
  const modelsPath = getModelsCachePath();
  if (!modelsPath || !existsSync(modelsPath)) {
    return FALLBACK_MODELS;
  }

  try {
    const payload = JSON.parse(readFileSync(modelsPath, "utf8")) as {
      models?: Array<{ slug?: unknown; display_name?: unknown; visibility?: unknown }>;
    };

    const models = (payload.models ?? [])
      .filter((model) => model && typeof model === "object")
      .filter((model) => model.visibility !== "hidden")
      .map((model) => ({
        slug: typeof model.slug === "string" ? model.slug : "",
        displayName: typeof model.display_name === "string" ? model.display_name : "",
      }))
      .filter((model) => model.slug && model.displayName);

    return models.length > 0 ? models : FALLBACK_MODELS;
  } catch {
    return FALLBACK_MODELS;
  }
}

function mapThreadRow(row: ThreadRow): CodexThreadRecord {
  return {
    id: typeof row.id === "string" ? row.id : String(row.id ?? ""),
    title: typeof row.title === "string" ? row.title : "",
    cwd: typeof row.cwd === "string" ? row.cwd : "",
    model: typeof row.model === "string" ? row.model : null,
    createdAt: fromUnixSeconds(row.created_at),
    updatedAt: fromUnixSeconds(row.updated_at),
    firstUserMessage: typeof row.first_user_message === "string" ? row.first_user_message : "",
  };
}

function mergeThreadRecords(
  databaseThreads: CodexThreadRecord[],
  sessionFileThreads: CodexThreadRecord[],
): CodexThreadRecord[] {
  const byId = new Map<string, CodexThreadRecord>();
  for (const thread of sessionFileThreads) {
    byId.set(thread.id, thread);
  }
  for (const thread of databaseThreads) {
    const fallback = byId.get(thread.id);
    byId.set(thread.id, {
      ...thread,
      title: thread.title || fallback?.title || "",
      cwd: thread.cwd || fallback?.cwd || "",
      model: thread.model || fallback?.model || null,
      firstUserMessage: thread.firstUserMessage || fallback?.firstUserMessage || "",
      createdAt: earlierDate(thread.createdAt, fallback?.createdAt),
      updatedAt: laterDate(thread.updatedAt, fallback?.updatedAt),
    });
  }
  return [...byId.values()].sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
}

function earlierDate(primary: Date, fallback?: Date): Date {
  if (!fallback || !Number.isFinite(fallback.getTime())) {
    return primary;
  }
  if (!Number.isFinite(primary.getTime())) {
    return fallback;
  }
  return primary.getTime() <= fallback.getTime() ? primary : fallback;
}

function laterDate(primary: Date, fallback?: Date): Date {
  if (!fallback || !Number.isFinite(fallback.getTime())) {
    return primary;
  }
  if (!Number.isFinite(primary.getTime())) {
    return fallback;
  }
  return primary.getTime() >= fallback.getTime() ? primary : fallback;
}

function sessionIdFromFilename(sessionPath: string): string {
  return path.basename(sessionPath).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$/i,
  )?.[1] ?? "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function fromUnixSeconds(value: unknown): Date {
  return typeof value === "number" ? new Date(value * 1000) : new Date(0);
}

function withDatabase<T>(fn: (db: DatabaseInstance) => T): T | null {
  if (!BetterSqlite3) {
    return null;
  }

  const databasePath = findLatestDatabase();
  if (!databasePath) {
    return null;
  }

  let db: DatabaseInstance | null = null;
  try {
    db = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
    return fn(db);
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close failures.
    }
  }
}

function getCodexDir(): string | null {
  const home = process.env.HOME?.trim();
  return home ? path.join(home, ".codex") : null;
}

function getModelsCachePath(): string | null {
  const codexDir = getCodexDir();
  return codexDir ? path.join(codexDir, "models_cache.json") : null;
}

function findThreadSessionFile(threadId: string): string | null {
  const codexDir = getCodexDir();
  if (!codexDir) {
    return null;
  }

  const sessionsDir = path.join(codexDir, "sessions");
  if (!existsSync(sessionsDir)) {
    return null;
  }

  try {
    const files = walkFiles(sessionsDir)
      .filter((file) => file.endsWith(".jsonl") && path.basename(file).includes(threadId))
      .map((file) => ({ file, modifiedAtMs: statSync(file).mtimeMs }))
      .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
    return files[0]?.file ?? null;
  } catch {
    return null;
  }
}

function walkFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function extractHistoryMessage(entry: {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
}): CodexHistoryMessage | null {
  if (entry.type !== "response_item" || !entry.payload || typeof entry.payload !== "object") {
    return null;
  }

  const payload = entry.payload as {
    type?: unknown;
    role?: unknown;
    content?: unknown;
  };
  if (payload.type !== "message") {
    return null;
  }
  if (payload.role !== "user" && payload.role !== "assistant") {
    return null;
  }

  const text = extractContentText(payload.content).trim();
  if (!text) {
    return null;
  }

  return {
    role: payload.role,
    text,
    timestamp: typeof entry.timestamp === "string" ? new Date(entry.timestamp) : undefined,
  };
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const record = item as { text?: unknown; input_text?: unknown };
      if (typeof record.text === "string") {
        return record.text;
      }
      if (typeof record.input_text === "string") {
        return record.input_text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}
