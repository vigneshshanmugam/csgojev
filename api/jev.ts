import type { JevRequest } from '@xstate/jev';
import { mockAnswers } from './_mock.js';
import { TypeSafeClient } from '@typesafe-ai/sdk';

/**
 * Vercel twin of server/jevApi.ts. Public endpoint in front of a paid key, so:
 * body size cap, shape check, per-IP rate limit, global daily cap. Anything
 * over a limit or failing the limiter answers with the mock, never the key.
 *
 * Env: TYPESAFE_API_KEY (unset => mock only), JEV_IP_PER_MIN (default 120),
 * JEV_DAILY_CAP (default 5000), UPSTASH_REDIS_REST_URL/_TOKEN (shared counters;
 * without them counters are per-instance and best-effort).
 */
const MAX_BODY_BYTES = 32_000;
const MAX_QUESTIONS = 64;
const ipPerMin = Number(process.env.JEV_IP_PER_MIN ?? 120);
const dailyCap = Number(process.env.JEV_DAILY_CAP ?? 5000);
const key = process.env.TYPESAFE_API_KEY;

let client: TypeSafeClient | null = null;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const memory = new Map<string, { n: number; expires: number }>();

/** Increments a fixed-window counter; resolves to the new count. */
async function bump(name: string, ttlS: number): Promise<number> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    const res = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify([['INCR', name], ['EXPIRE', name, ttlS, 'NX']]),
    });
    if (!res.ok) throw new Error(`limiter ${res.status}`);
    const [incr] = (await res.json()) as { result: number }[];
    return incr.result;
  }
  const now = Date.now();
  const hit = memory.get(name);
  if (!hit || hit.expires < now) {
    if (memory.size > 5000) memory.clear();
    memory.set(name, { n: 1, expires: now + ttlS * 1000 });
    return 1;
  }
  return ++hit.n;
}

async function peek(name: string): Promise<number> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    const res = await fetch(`${url}/get/${name}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`limiter ${res.status}`);
    return Number((await res.json() as { result: string | null }).result ?? 0);
  }
  return memory.get(name)?.n ?? 0;
}

const day = () => new Date().toISOString().slice(0, 10);

function valid(body: unknown): body is JevRequest {
  if (!body || typeof body !== 'object') return false;
  const { questions } = body as { questions?: unknown };
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) return false;
  const qs = Object.values(questions);
  return qs.length > 0 && qs.length <= MAX_QUESTIONS && qs.every((q) => q && typeof q === 'object' && 'type' in q);
}

export async function GET(): Promise<Response> {
  if (!key) return json({ live: false });
  try {
    return json({ live: (await peek(`jev:day:${day()}`)) < dailyCap });
  } catch {
    return json({ live: false });
  }
}

export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: 'request too large' }, 413);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return json({ error: 'invalid json' }, 400); }
  if (!valid(body)) return json({ error: 'invalid request' }, 400);

  const mock = () => json(mockAnswers(body));
  if (!key) return mock();

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  try {
    const perIp = await bump(`jev:ip:${ip}:${Math.floor(Date.now() / 60_000)}`, 70);
    if (perIp > ipPerMin) return mock();
    const total = await bump(`jev:day:${day()}`, 90_000);
    if (total > dailyCap) return mock();
  } catch {
    return mock();
  }

  try {
    client ??= new TypeSafeClient({ apiKey: key, timeout: 30_000 });
    const result = await client.systemOne({ state: body.state as never, questions: body.questions as never });
    return json({ answers: result.answers });
  } catch {
    return json({ error: 'upstream error' }, 502);
  }
}
