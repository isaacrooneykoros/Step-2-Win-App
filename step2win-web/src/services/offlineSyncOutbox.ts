import { Capacitor } from '@capacitor/core';
import { SQLiteConnection, CapacitorSQLite } from '@capacitor-community/sqlite';
import { v4 as uuidv4 } from 'uuid';

export type SyncOutboxKind = 'health' | 'hourly';

export type SyncOutboxPayload = Record<string, any>;

export type SyncOutboxItem = {
  id: string;
  queueKey: string;
  userId: number;
  kind: SyncOutboxKind;
  payload: SyncOutboxPayload;
  idempotencyKey: string;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
};

const SQLITE_DB_NAME = 'step2win_sync_outbox';
const SQLITE_TABLE_NAME = 'sync_outbox';
const FALLBACK_KEY = 'step2win_sync_outbox_fallback_v1';

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ${SQLITE_TABLE_NAME} (
    id TEXT PRIMARY KEY NOT NULL,
    queue_key TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const sqliteConnection = new SQLiteConnection(CapacitorSQLite);
let sqliteReady: Promise<void> | null = null;
let nativeDb: any = null;

async function ensureNativeSqliteReady() {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
    return;
  }

  if (!sqliteReady) {
    sqliteReady = (async () => {
      nativeDb = await sqliteConnection.createConnection(SQLITE_DB_NAME, false, 'no-encryption', 1, false);
      await nativeDb.open();
      await nativeDb.execute(CREATE_TABLE_SQL);
    })().catch((error) => {
      sqliteReady = null;
      nativeDb = null;
      throw error;
    });
  }

  await sqliteReady;
}

function readFallbackQueue(): SyncOutboxItem[] {
  try {
    const raw = localStorage.getItem(FALLBACK_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeFallbackQueue(items: SyncOutboxItem[]) {
  localStorage.setItem(FALLBACK_KEY, JSON.stringify(items.slice(-200)));
}

function buildQueueKey(userId: number, kind: SyncOutboxKind, payload: SyncOutboxPayload) {
  const date = String(payload.date || 'unknown-date');
  return `${userId}:${kind}:${date}`;
}

function nowIso() {
  return new Date().toISOString();
}

export async function upsertOutboxItem(args: {
  userId: number;
  kind: SyncOutboxKind;
  payload: SyncOutboxPayload;
  idempotencyKey?: string;
}): Promise<SyncOutboxItem> {
  const queueKey = buildQueueKey(args.userId, args.kind, args.payload);
  const createdAt = nowIso();
  const payloadText = JSON.stringify(args.payload);

  const existing = await getExistingOutboxItem(queueKey);
  const samePayload = existing !== null && JSON.stringify(existing.payload) === payloadText;

  const item: SyncOutboxItem = {
    id: existing?.id || uuidv4(),
    queueKey,
    userId: args.userId,
    kind: args.kind,
    payload: args.payload,
    idempotencyKey: args.idempotencyKey || existing?.idempotencyKey || uuidv4(),
    retryCount: samePayload ? (existing?.retryCount || 0) : 0,
    createdAt: existing?.createdAt || createdAt,
    updatedAt: createdAt,
  };

  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    try {
      await ensureNativeSqliteReady();
      await nativeDb.run(
        `INSERT INTO ${SQLITE_TABLE_NAME} (id, queue_key, user_id, kind, payload, idempotency_key, retry_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(queue_key) DO UPDATE SET
           id = excluded.id,
           user_id = excluded.user_id,
           kind = excluded.kind,
           payload = excluded.payload,
           idempotency_key = excluded.idempotency_key,
           retry_count = 0,
           updated_at = excluded.updated_at`,
        [
          item.id,
          item.queueKey,
          item.userId,
          item.kind,
          JSON.stringify(item.payload),
          item.idempotencyKey,
          item.retryCount,
          item.createdAt,
          item.updatedAt,
        ],
      );
      return item;
    } catch {
      // Fall back to local storage if the native database is temporarily unavailable.
    }
  }

  const queue = readFallbackQueue();
  const index = queue.findIndex((entry) => entry.queueKey === queueKey);
  if (index >= 0) {
    queue[index] = item;
  } else {
    queue.push(item);
  }
  writeFallbackQueue(queue);
  return item;
}

async function getExistingOutboxItem(queueKey: string): Promise<SyncOutboxItem | null> {
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    try {
      await ensureNativeSqliteReady();
      const result = await nativeDb.query(`SELECT * FROM ${SQLITE_TABLE_NAME} WHERE queue_key = ? LIMIT 1`, [queueKey]);
      const row = result.values?.[0] as Record<string, any> | undefined;
      return row ? mapRowToItem(row) : null;
    } catch {
      // Fallback below.
    }
  }

  const queue = readFallbackQueue();
  return queue.find((item) => item.queueKey === queueKey) || null;
}

export async function listOutboxItems(userId?: number): Promise<SyncOutboxItem[]> {
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    try {
      await ensureNativeSqliteReady();
      const result = await nativeDb.query(
        userId
          ? `SELECT * FROM ${SQLITE_TABLE_NAME} WHERE user_id = ? ORDER BY created_at ASC`
          : `SELECT * FROM ${SQLITE_TABLE_NAME} ORDER BY created_at ASC`,
        userId ? [userId] : [],
      );

      const rows = (result.values || []) as Array<Record<string, any>>;
      return rows.map(mapRowToItem);
    } catch {
      // Fall through to fallback queue.
    }
  }

  const queue = readFallbackQueue();
  return userId ? queue.filter((item) => item.userId === userId) : queue;
}

export async function removeOutboxItem(queueKey: string): Promise<void> {
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    try {
      await ensureNativeSqliteReady();
      await nativeDb.run(`DELETE FROM ${SQLITE_TABLE_NAME} WHERE queue_key = ?`, [queueKey]);
      return;
    } catch {
      // Use fallback path below.
    }
  }

  const remaining = readFallbackQueue().filter((item) => item.queueKey !== queueKey);
  writeFallbackQueue(remaining);
}

export async function touchOutboxRetry(queueKey: string): Promise<void> {
  const updatedAt = nowIso();
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    try {
      await ensureNativeSqliteReady();
      await nativeDb.run(
        `UPDATE ${SQLITE_TABLE_NAME}
         SET retry_count = retry_count + 1,
             updated_at = ?
         WHERE queue_key = ?`,
        [updatedAt, queueKey],
      );
      return;
    } catch {
      // Use fallback path below.
    }
  }

  const queue = readFallbackQueue();
  const index = queue.findIndex((item) => item.queueKey === queueKey);
  if (index >= 0) {
    queue[index] = {
      ...queue[index],
      retryCount: queue[index].retryCount + 1,
      updatedAt,
    };
    writeFallbackQueue(queue);
  }
}

export function buildOutboxQueueKey(userId: number, kind: SyncOutboxKind, payload: SyncOutboxPayload) {
  return buildQueueKey(userId, kind, payload);
}

function mapRowToItem(row: Record<string, any>): SyncOutboxItem {
  return {
    id: String(row.id),
    queueKey: String(row.queue_key),
    userId: Number(row.user_id),
    kind: row.kind as SyncOutboxKind,
    payload: safeParseJson(row.payload),
    idempotencyKey: String(row.idempotency_key),
    retryCount: Number(row.retry_count || 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function safeParseJson(value: any): SyncOutboxPayload {
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return {};
  }
}