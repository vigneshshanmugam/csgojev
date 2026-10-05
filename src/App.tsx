import { useEffect, useReducer, useRef, useState } from 'react';
import { browserJevClient, jevLive } from './client';
import { Game, type Hud } from './game/engine';

export function App() {
  const mount = useRef<HTMLDivElement>(null);
  const [game, setGame] = useState<Game | null>(null);

  useEffect(() => {
    let g: Game | null = null;
    let cancelled = false;
    jevLive().then((live) => {
      if (cancelled || !mount.current) return;
      g = new Game(mount.current, browserJevClient, live);
      setGame(g);
    });
    return () => { cancelled = true; g?.dispose(); setGame(null); };
  }, []);

  return (
    <>
      <div ref={mount} className="viewport" />
      {game && <Overlay game={game} />}
    </>
  );
}

const OVER_TEXT = {
  win: 'Counter-Terrorists win',
  lose: 'Terrorists win. You were AWPed',
  time: 'Round draw. Time ran out',
} as const;

function Overlay({ game }: { game: Game }) {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => game.subscribe(tick), [game]);
  const h: Hud = game.hud;
  const now = performance.now();
  const clock = `${Math.floor(h.time / 60)}:${String(h.time % 60).padStart(2, '0')}`;
  return (
    <div className="hud">
      <div className="crosshair" style={{ ['--gap' as string]: `${h.gap}px` }}>
        <i className="l" /><i className="r" /><i className="t" /><i className="b" />
      </div>
      {now - h.hit < 150 && <div className="hitmarker">✕</div>}
      {now - h.damaged < 400 && <div className="damage" />}
      <div className="clock">{clock}</div>
      <div className="cs-hp"><span className="cross">+</span> <b>{h.hp}</b></div>
      <div className="cs-ammo">
        {h.reloading && <small>RELOADING</small>}
        <b>{h.ammo}</b> <span>/ {h.reserve}</span>
      </div>
      <div className="jev">
        <div className="title">Enemy AWPer, driven by Jev {h.live ? '' : '(MOCK, no API key)'}</div>
        <div>HP {h.enemyHp} · state <b>{h.enemyState}</b> · jev <b>{h.jev}</b></div>
        {h.jevError && <div className="err">{h.jevError}</div>}
        <ul>
          {h.decisions.map((d) => (
            <li key={d.at}>
              <b>{d.choice}</b> <span>{Math.round(d.confidence * 100)}% · {d.cached ? 'cached' : `${d.ms}ms`}</span>
            </li>
          ))}
        </ul>
      </div>
      {h.debug && (
        <div className="debug">
          <div>fps {h.debug.fps}</div>
          <div>pos {h.debug.px.toFixed(1)}, {h.debug.pz.toFixed(1)} · {h.debug.speed.toFixed(1)} m/s</div>
          <div>enemy et {h.debug.et.toFixed(2)} · {h.debug.distance.toFixed(0)} m</div>
          <div>LOS {h.debug.losToEnemy ? 'clear' : 'blocked'}</div>
          <div>jev requests {h.debug.requests}</div>
        </div>
      )}
      {!h.locked && !h.over && (
        <div className="splash" onClick={() => game.lock()}>
          Click to play
          <br /><small>WASD move · Shift walk · Click fire (AK-47) · R restart</small>
        </div>
      )}
      {h.over && (
        <div className="splash">
          {OVER_TEXT[h.over]}
          <br /><small>Press R to restart</small>
          <br /><button onClick={() => game.reset()}>Restart</button>
        </div>
      )}
    </div>
  );
}
