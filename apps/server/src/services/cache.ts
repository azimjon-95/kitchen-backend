import { Redis } from "ioredis";

/**
 * Redis-кэш (необязательный): если REDIS_URL не задан или Redis недоступен —
 * сервер работает напрямую с MongoDB, ничего не ломается.
 */
const url = process.env.REDIS_URL;
const PREFIX = "ck:";
let client: Redis | null = null;
let ready = false;

if (url) {
  client = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2, enableOfflineQueue: true, retryStrategy: (n) => Math.min(n * 500, 5000) });
  client.on("ready", () => { ready = true; console.log("Redis connected"); });
  client.on("end", () => { ready = false; });
  client.on("error", (e) => { if (ready) console.error("Redis error:", e.message); ready = false; });
}

export const redis = client;
export const redisStatus = () => (!url ? "disabled" : ready ? "connected" : "not-connected");

/** Версия данных рецептов — при любом изменении увеличивается, и весь кэш списков становится «старым» */
async function version(): Promise<string> {
  if (!client || !ready) return "0";
  try { return (await client.get(`${PREFIX}recipes:ver`)) ?? "0"; } catch { return "0"; }
}
export async function bumpRecipesVersion(): Promise<void> {
  if (!client || !ready) return;
  try { await client.incr(`${PREFIX}recipes:ver`); } catch { /* кэш не критичен */ }
}

export async function cached<T>(key: string, ttlSec: number, load: () => Promise<T>): Promise<{ value: T; hit: boolean }> {
  if (!client || !ready) return { value: await load(), hit: false };
  const k = `${PREFIX}${key}:v${await version()}`;
  try {
    const raw = await client.get(k);
    if (raw) return { value: JSON.parse(raw) as T, hit: true };
  } catch { /* читаем из БД */ }
  const value = await load();
  try { await client.set(k, JSON.stringify(value), "EX", ttlSec); } catch { /* ignore */ }
  return { value, hit: false };
}
