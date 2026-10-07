/**
 * Optional 1Hz trace of what the plugin reports about the zBot, for finding out
 * why it stops where it does: `OBS_TRACE=file` appends one JSON line per second
 * per round with the distance to the AWPer, whether the zBot is moving, and
 * whether it is in sight. Off unless the variable is set.
 */
import { appendFileSync } from 'node:fs';
import type { Inbound } from './protocol';

export function openObsTrace(path: string, now: () => number = Date.now) {
  let round = 0;
  let startedAt = now();
  let lastSecond = -1;
  return (packet: Inbound) => {
    if (packet.t === 'round_start') {
      round += 1;
      startedAt = now();
      lastSecond = -1;
      appendFileSync(path, `${JSON.stringify({ round, event: 'start', route: packet.route ?? null })}\n`);
    } else if (packet.t === 'obs') {
      const second = Math.floor((now() - startedAt) / 1000);
      if (second === lastSecond) return;
      lastSecond = second;
      appendFileSync(
        path,
        `${JSON.stringify({ round, s: second, dist: packet.dist, moving: packet.moving, visible: packet.visible, steps: packet.footsteps, from: packet.footstepsFrom ?? null, hp: packet.hp, enemyHp: packet.enemyHp })}\n`,
      );
    } else if (packet.t === 'round_end') {
      appendFileSync(path, `${JSON.stringify({ round, event: 'end', result: packet.result })}\n`);
    }
  };
}
