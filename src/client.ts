import type { JevClient } from '@xstate/jev';

export const browserJevClient: JevClient = async (request) => {
  const res = await fetch('/api/jev', { method: 'POST', body: JSON.stringify(request) });
  if (!res.ok) throw new Error(`jev ${res.status}: ${await res.text()}`);
  return res.json();
};

export async function jevLive(): Promise<boolean> {
  try { return (await (await fetch('/api/jev')).json()).live; } catch { return false; }
}
