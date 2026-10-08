import { useEffect, useReducer, useRef, useState } from 'react';
import { browserJevClient, jevLive } from './client';
import { Game, type Hud } from './game/engine';
import { applyOutcome, EMPTY_SCORE, loadScore, MATCH_ROUNDS, matchResult, roundsPlayed, saveScore, type Score } from './game/score';

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

const MATCH_TEXT = {
  human: 'MATCH WON. Humans beat Jev',
  jev: 'MATCH LOST. Jev wins',
  tie: 'MATCH TIED',
} as const;

function Overlay({ game }: { game: Game }) {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => game.subscribe(tick), [game]);
  const h: Hud = game.hud;
  const [score, setScore] = useState<Score>(loadScore);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key.toLowerCase() === 'r' && !e.repeat) resetScore(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!h.over) {
      // Next round after a finished match starts a fresh match.
      if (matchResult(score)) { saveScore(EMPTY_SCORE); setScore({ ...EMPTY_SCORE }); }
      return;
    }
    const over = h.over;
    setScore((s) => { const n = applyOutcome(s, over); saveScore(n); return n; });
  }, [h.over]);
  const now = performance.now();
  const result = matchResult(score);
  const resetScore = () => { saveScore(EMPTY_SCORE); setScore({ ...EMPTY_SCORE }); };
  const clock = `${Math.floor(h.time / 60)}:${String(h.time % 60).padStart(2, '0')}`;
  return (
    <div className="hud">
      <div className="crosshair" style={{ ['--gap' as string]: `${h.gap}px` }}>
        <i className="l" /><i className="r" /><i className="t" /><i className="b" />
      </div>
      {now - h.hit < 150 && <div className="hitmarker">✕</div>}
      {now - h.damaged < 400 && <div className="damage" />}
      <div className="clock">{clock}</div>
      <div className="scoreboard">
        <span className="human">Human <b>{score.human}</b></span>
        <span className="sep">–</span>
        <span className="jevscore"><b>{score.jev}</b> Jev</span>
        <small>
          Round {Math.min(roundsPlayed(score) + 1, MATCH_ROUNDS)}/{MATCH_ROUNDS}
          {score.draws > 0 && ` · ${score.draws} draw${score.draws > 1 ? 's' : ''}`}
          {score.streak > 1 && ` · streak ${score.streak}`}
        </small>
      </div>
      <div className="cs-hp"><small>HEALTH</small><span className="cross">+</span> <b>{h.hp}</b></div>
      <div className="cs-ammo">
        <small className="lbl">AMMO</small>
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
          <br /><small>WASD move · Shift walk · Click fire (AK-47) · R reset score</small>
          <br /><small>Best of {MATCH_ROUNDS} · Human {score.human} – {score.jev} Jev</small>
        </div>
      )}
      {h.over && (
        <div className="splash">
          {OVER_TEXT[h.over]}
          <br /><small>Human {score.human} – {score.jev} Jev{score.draws > 0 ? ` · ${score.draws} draw${score.draws > 1 ? 's' : ''}` : ''}</small>
          <br /><small>Press N for {result ? 'a new match' : 'the next round'} · R to reset score</small>
          {result && <><br /><b>{MATCH_TEXT[result]}</b></>}
        </div>
      )}
    </div>
  );
}
