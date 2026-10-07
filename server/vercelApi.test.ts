import { describe, expect, it, vi } from 'vitest';

const systemOne = vi.fn(async () => ({ answers: { action: { type: 'choice', choice: 'x' } } }));
vi.mock('@typesafe-ai/sdk', () => ({ TypeSafeClient: class { systemOne = systemOne; } }));

const body = { state: {}, questions: { action: { type: 'choice', criteria: { a: 'a', b: 'b' } } } };
const post = (ip: string, b: unknown = body) =>
  new Request('http://x/api/jev', { method: 'POST', headers: { 'x-forwarded-for': ip }, body: typeof b === 'string' ? b : JSON.stringify(b) });

async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const k of ['TYPESAFE_API_KEY', 'JEV_IP_PER_MIN', 'JEV_DAILY_CAP']) delete process.env[k];
  Object.assign(process.env, env);
  return import('../api/jev');
}

describe('api/jev', () => {
  it('mock only without a key', async () => {
    const { POST, GET } = await load({});
    expect((await (await GET()).json()).live).toBe(false);
    expect((await POST(post('1.1.1.1'))).status).toBe(200);
    expect(systemOne).not.toHaveBeenCalled();
  });

  it('rejects bad bodies', async () => {
    const { POST } = await load({ TYPESAFE_API_KEY: 'k' });
    expect((await POST(post('1.1.1.2', 'nope'))).status).toBe(400);
    expect((await POST(post('1.1.1.2', { state: {} }))).status).toBe(400);
    expect((await POST(post('1.1.1.2', 'x'.repeat(40_000)))).status).toBe(413);
  });

  it('falls back to mock past the per-IP limit', async () => {
    const { POST } = await load({ TYPESAFE_API_KEY: 'k', JEV_IP_PER_MIN: '2' });
    systemOne.mockClear();
    for (let i = 0; i < 4; i++) await POST(post('2.2.2.2'));
    expect(systemOne).toHaveBeenCalledTimes(2);
  });

  it('falls back to mock past the daily cap', async () => {
    const { POST, GET } = await load({ TYPESAFE_API_KEY: 'k', JEV_DAILY_CAP: '1' });
    systemOne.mockClear();
    await POST(post('3.3.3.3'));
    await POST(post('4.4.4.4'));
    expect(systemOne).toHaveBeenCalledTimes(1);
    expect((await (await GET()).json()).live).toBe(false);
  });
});
