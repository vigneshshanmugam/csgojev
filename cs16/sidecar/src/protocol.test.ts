import { describe, expect, it } from 'vitest';
import { decode, encode, inboundSchema, intentSchema } from './protocol';

const obs = {
  t: 'obs', bot: 1, hp: 100, visible: true, moving: false, dist: 42.5, enemyHp: 100,
  footsteps: false, sinceSeen: 3.2, roundLeft: 80, weaponReady: true, atWaypoint: 'peek',
  onTarget: 0.42,
};

describe('wire protocol', () => {
  it('frames packets one per line', () => {
    expect(encode(obs).toString()).toBe(`${JSON.stringify(obs)}\n`);
  });

  it('reads several packets out of one datagram', () => {
    const datagram = Buffer.concat([encode(obs), encode({ t: 'round_start', bot: 1 }), encode({ t: 'bot_died', bot: 1 })]);
    const packets = decode(inboundSchema, datagram);
    expect(packets.map((p) => p.t)).toEqual(['obs', 'round_start', 'bot_died']);
  });

  it('drops malformed and off-protocol lines rather than throwing', () => {
    const datagram = `not json\n${JSON.stringify({ t: 'obs', bot: 1 })}\n${JSON.stringify({ t: 'nope' })}\n`;
    expect(decode(inboundSchema, datagram)).toEqual([]);
  });

  it('accepts the spec packets exactly as written', () => {
    expect(inboundSchema.safeParse(obs).success).toBe(true);
    expect(inboundSchema.safeParse({ ...obs, atWaypoint: null }).success).toBe(true);
    // A plugin build without the aim field still parses; the bot just never shoots.
    const { onTarget: _omitted, ...noAim } = obs;
    expect(inboundSchema.safeParse(noAim).success).toBe(true);
    expect(inboundSchema.safeParse({ ...obs, onTarget: 'soon' }).success).toBe(false);
    expect(inboundSchema.safeParse({ t: 'round_end', bot: 1, result: 'win' }).success).toBe(true);
    expect(inboundSchema.safeParse({ t: 'round_end', bot: 1, result: 'nope' }).success).toBe(false);
    expect(intentSchema.safeParse({ t: 'intent', bot: 1, state: 'peeking', fire: false, seq: 12 }).success).toBe(true);
    expect(intentSchema.safeParse({ t: 'intent', bot: 1, state: 'walking', fire: false, seq: 12 }).success).toBe(false);
  });
});
