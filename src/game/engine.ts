import * as THREE from 'three';
import { createActor, type Actor } from 'xstate';
import type { JevClient } from '@xstate/jev';
import { AWP_DMG, MAG, RELOAD_MS, RIFLE_BODY, RIFLE_HEAD, ROUND_SECONDS, awpHitChance, playerSpread } from './combat';
import { PEEK_MS, createEnemyMachine } from './enemyMachine';
import { BOXES, ENEMY_HOLD, ENEMY_PEEK, EYE, PLAYER_SPAWN, blocked, collide } from './map';

export interface DecisionRow { at: number; choice: string; confidence: number; ms: number; reason: string; cached: boolean }
export interface Debug {
  fps: number; px: number; pz: number; speed: number; et: number;
  losToEnemy: boolean; distance: number; requests: number; lastKey: string | null;
}
export interface Hud {
  hp: number; ammo: number; reloading: boolean; enemyHp: number; enemyState: string;
  jev: string; jevError: string | null; decisions: DecisionRow[];
  over: null | 'win' | 'lose' | 'time'; locked: boolean;
  hit: number; damaged: number; live: boolean; time: number; debug: Debug | null;
}

/** Player movement, CS-ish: quick to full speed, and stoppable in ~0.15s by counter-strafing. */
const MAX_SPEED = 5.5; // m/s
const WALK = 0.42; // shift
const ACCEL = 9; // 1/s, applied against the wish speed
const FRICTION = 7; // 1/s
const STOP_SPEED = 1.2; // m/s floor on friction, so slow drift still stops

/** Running this close is audible through a wall. About half the lane, so the cue still means "close". */
const FOOTSTEP_RANGE = 12;
const FOOTSTEP_SPEED = 2.5;

export class Game {
  readonly hud: Hud = {
    hp: 100, ammo: MAG, reloading: false, enemyHp: 100, enemyState: 'holding',
    jev: 'watching', jevError: null, decisions: [], over: null, locked: false,
    hit: 0, damaged: 0, live: false, time: ROUND_SECONDS, debug: null,
  };
  private listeners = new Set<() => void>();
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(75, 1, 0.05, 100);
  private walls = new THREE.Group();
  private enemy = new THREE.Group();
  private enemyParts: THREE.Mesh[] = [];
  private tracers: { line: THREE.Line; ttl: number }[] = [];
  private keys = new Set<string>();
  private yaw = 0; private pitch = 0;
  private px = PLAYER_SPAWN.x; private pz = PLAYER_SPAWN.z;
  private vx = 0; private vz = 0; private speed = 0;
  private et = 0; // 0 behind the pillar .. 1 fully out in the lane
  private etTarget = 0;
  private actor!: Actor<ReturnType<typeof createEnemyMachine>>;
  private lastShots = 0; private lastSync = 0; private lastFire = 0; private lastCtx = '';
  private raf = 0; private last = performance.now(); private disposed = false;
  private seenDecisions = 0;
  private enemyDown = false;
  private lastSeenAt: number | null = null;
  private visibleSince: number | null = null;
  private elapsed = 0; // round seconds, only while the player is actually playing
  private reloadAt = 0;
  private lastEmit = 0;
  private fps = 60;
  private debug: boolean;

  constructor(private el: HTMLElement, private client: JevClient, live: boolean) {
    this.hud.live = live;
    this.debug = new URLSearchParams(location.search).has('debug');
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    el.appendChild(this.renderer.domElement);
    this.buildScene();
    this.resize();
    addEventListener('resize', this.resize);
    addEventListener('keydown', this.onKey);
    addEventListener('keyup', this.onKey);
    addEventListener('blur', this.onBlur);
    document.addEventListener('mousemove', this.onMouse);
    document.addEventListener('pointerlockchange', this.onLock);
    this.renderer.domElement.addEventListener('mousedown', this.onDown);
    this.reset();
    this.raf = requestAnimationFrame(this.loop);
  }

  subscribe(fn: () => void) { this.listeners.add(fn); return () => void this.listeners.delete(fn); }
  private emit() { for (const l of this.listeners) l(); }

  /** Pointer lock has to come from a user gesture, and the splash is what the user clicks. */
  lock() {
    const request = this.renderer.domElement.requestPointerLock() as unknown;
    if (request && typeof (request as Promise<void>).catch === 'function') (request as Promise<void>).catch(() => {});
  }

  reset() {
    this.actor?.stop();
    this.px = PLAYER_SPAWN.x; this.pz = PLAYER_SPAWN.z; this.yaw = 0; this.pitch = 0;
    this.vx = 0; this.vz = 0; this.speed = 0;
    this.et = 0; this.etTarget = 0;
    this.keys.clear();
    Object.assign(this.hud, {
      hp: 100, ammo: MAG, reloading: false, enemyHp: 100, over: null, decisions: [],
      jev: 'watching', jevError: null, enemyState: 'holding', hit: 0, damaged: 0, time: ROUND_SECONDS,
    });
    this.lastShots = 0; this.lastCtx = ''; this.seenDecisions = 0;
    this.lastSeenAt = null; this.visibleSince = null; this.elapsed = 0; this.reloadAt = 0;
    this.clearTracers();
    this.enemyDown = false;
    this.enemy.visible = true;
    this.enemy.rotation.set(0, 0, 0);
    this.placeEnemy();
    this.actor = createActor(createEnemyMachine(this.client));
    this.actor.subscribe((s) => this.onEnemy(s));
    this.actor.start();
    this.emit();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.actor.stop();
    removeEventListener('resize', this.resize);
    removeEventListener('keydown', this.onKey);
    removeEventListener('keyup', this.onKey);
    removeEventListener('blur', this.onBlur);
    document.removeEventListener('mousemove', this.onMouse);
    document.removeEventListener('pointerlockchange', this.onLock);
    if (document.pointerLockElement) document.exitPointerLock();
    this.clearTracers();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // --- scene ---
  private buildScene() {
    const s = this.scene;
    s.background = new THREE.Color(0xcfe2f3);
    // Starts past the far end of the lane: the duel is fought at ~23m, and a
    // player who cannot see the AWPer killing them is not in a duel.
    s.fog = new THREE.Fog(0xcfe2f3, 30, 80);
    s.add(new THREE.HemisphereLight(0xffffff, 0x8a7a5a, 1.1));
    const sun = new THREE.DirectionalLight(0xfff2d0, 1.6);
    sun.position.set(-20, 40, 10);
    s.add(sun);
    // Sized off the walls, so the floor cannot drift out from under them.
    const x0 = Math.min(...BOXES.map((b) => b.x0)), x1 = Math.max(...BOXES.map((b) => b.x1));
    const z0 = Math.min(...BOXES.map((b) => b.z0)), z1 = Math.max(...BOXES.map((b) => b.z1));
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), new THREE.MeshStandardMaterial({ color: 0xc9b58a, roughness: 1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
    s.add(floor);
    for (const b of BOXES) {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(b.x1 - b.x0, b.h, b.z1 - b.z0),
        new THREE.MeshStandardMaterial({ color: b.color, roughness: 0.95 }),
      );
      m.position.set((b.x0 + b.x1) / 2, b.h / 2, (b.z0 + b.z1) / 2);
      this.walls.add(m);
    }
    s.add(this.walls);

    const body = new THREE.MeshStandardMaterial({ color: 0x3a4a6a });
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.9, 0.35), body);
    torso.position.y = 1.15; torso.userData.part = 'body';
    const legs = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.3), new THREE.MeshStandardMaterial({ color: 0x2a3550 }));
    legs.position.y = 0.35; legs.userData.part = 'body';
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 12), new THREE.MeshStandardMaterial({ color: 0xd9a77a }));
    head.position.y = 1.72; head.userData.part = 'head';
    const awp = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 1.3), new THREE.MeshStandardMaterial({ color: 0x1d1d1d }));
    awp.position.set(0.25, 1.25, 0.5); awp.userData.part = 'body';
    this.enemyParts = [torso, legs, head, awp];
    this.enemy.add(...this.enemyParts);
    this.enemy.rotation.y = 0; // faces +z (toward the player)
    this.scene.add(this.enemy);
    this.placeEnemy();
  }

  private placeEnemy() {
    const x = ENEMY_HOLD.x + (ENEMY_PEEK.x - ENEMY_HOLD.x) * this.et;
    this.enemy.position.set(x, 0, ENEMY_HOLD.z);
  }

  private resize = () => {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  // --- input ---
  private onKey = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (e.type === 'keydown') {
      this.keys.add(k);
      if (k === 'r') this.reset();
    } else this.keys.delete(k);
  };
  private onBlur = () => { this.keys.clear(); };
  private onMouse = (e: MouseEvent) => {
    if (!this.hud.locked) return;
    this.yaw -= e.movementX * 0.0022;
    this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch - e.movementY * 0.0022));
  };
  private onLock = () => {
    this.hud.locked = document.pointerLockElement === this.renderer.domElement;
    if (!this.hud.locked) this.keys.clear();
    this.emit();
  };
  private onDown = () => {
    if (!this.hud.locked) { this.lock(); return; }
    this.fire();
  };

  // --- player combat ---
  private fire() {
    const now = performance.now();
    if (this.hud.over || this.hud.reloading || this.hud.ammo <= 0 || now - this.lastFire < 100) return;
    this.lastFire = now;
    this.hud.ammo--;
    if (this.hud.ammo === 0) { this.hud.reloading = true; this.reloadAt = now + RELOAD_MS; }

    // Accuracy is the player's movement, same rule the bot plays by.
    const spread = playerSpread(this.speed);
    const rc = new THREE.Raycaster();
    const dir = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    dir.x += (Math.random() - 0.5) * spread * 2; dir.y += (Math.random() - 0.5) * spread * 2;
    dir.normalize();
    rc.set(this.camera.position, dir);
    // The enemy moved this frame; its parts need world matrices before a raycast.
    this.enemy.updateMatrixWorld(true);
    const wall = rc.intersectObjects(this.walls.children, false)[0];
    const hit = this.enemyDown ? undefined : rc.intersectObjects(this.enemyParts, false)[0];
    const end = this.camera.position.clone().addScaledVector(dir, wall ? wall.distance : 40);
    if (hit && (!wall || hit.distance < wall.distance)) {
      const dmg = hit.object.userData.part === 'head' ? RIFLE_HEAD : RIFLE_BODY;
      this.hud.enemyHp = Math.max(0, this.hud.enemyHp - dmg);
      this.hud.hit = now;
      if (this.hud.enemyHp <= 0) this.killEnemy();
      else this.actor.send({ type: 'world.sync', hp: this.hud.enemyHp });
    }
    const from = this.camera.position.clone().add(new THREE.Vector3(0.2, -0.2, 0).applyEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ')));
    this.tracer(from, end, 0xffe066);
    this.pitch += 0.008;
    this.emit();
  }

  private killEnemy() {
    this.hud.enemyHp = 0;
    this.hud.over = 'win';
    this.enemyDown = true;
    this.actor.send({ type: 'world.enemyDead' });
    this.enemy.rotation.z = Math.PI / 2;
    this.enemy.position.y = 0.3;
  }

  private tracer(a: THREE.Vector3, b: THREE.Vector3, color: number) {
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color }));
    this.scene.add(line);
    this.tracers.push({ line, ttl: 0.12 });
  }

  private clearTracers() {
    for (const tr of this.tracers) {
      this.scene.remove(tr.line);
      tr.line.geometry.dispose();
      (tr.line.material as THREE.Material).dispose();
    }
    this.tracers = [];
  }

  // --- enemy bot ---
  private onEnemy(s: ReturnType<Actor<ReturnType<typeof createEnemyMachine>>['getSnapshot']>) {
    const value = String(s.value);
    const was = this.hud.enemyState;
    this.hud.enemyState = value;
    // The machine owns where the bot is going; `peeking` is the only state it moves in.
    if (value !== was) {
      if (value === 'holding') this.etTarget = 0;
      else if (value === 'peeking') this.etTarget = 1;
      // counterStrafe lands here part way out: stop dead where the body is.
      else if (was === 'peeking') this.etTarget = this.et;
    }
    const jev = (s as any).children?.jev?.getSnapshot?.();
    if (jev) {
      this.hud.jev = String(jev.value);
      this.hud.jevError = jev.context.error;
      const ds = jev.context.decisions as any[];
      if (ds.length !== this.seenDecisions || ds[0]?.at !== this.hud.decisions[0]?.at) {
        this.seenDecisions = ds.length;
        this.hud.decisions = ds.slice(0, 6).map((d) => ({
          at: d.at, choice: d.event?.type ?? (d.reason === 'noop' ? 'wait' : d.reason), confidence: d.confidence, ms: d.latencyMs, reason: d.reason, cached: d.cached,
        }));
        if (this.debug && ds[0]) console.debug('[jev]', ds[0].reason, ds[0].event?.type ?? '—', `${ds[0].latencyMs}ms`, ds[0].cached ? '(cached)' : '', ds[0].probabilities);
      }
    }
    const shots = s.context.shots;
    if (shots > this.lastShots) { this.lastShots = shots; this.enemyShoots(); }
    this.emit();
  }

  private enemyEye() { return { x: this.enemy.position.x, z: ENEMY_HOLD.z }; }
  /** Line of sight is mutual: if the bot can see the player, the player can see the bot. */
  private visible() { const e = this.enemyEye(); return !this.enemyDown && !blocked(e.x, e.z, this.px, this.pz); }
  private enemyMoving() { return Math.abs(this.et - this.etTarget) > 0.01; }

  private enemyShoots() {
    if (this.hud.over) return;
    const e = this.enemyEye();
    const from = new THREE.Vector3(e.x, EYE, e.z);
    const to = new THREE.Vector3(this.px, EYE - 0.2, this.pz);
    const vis = this.visible();
    // `scoped` means standing still, so this agrees with the state Jev decided in.
    const chance = awpHitChance({
      enemyMoving: this.enemyMoving(),
      playerSpeed: this.speed,
      onTarget: this.visibleSince === null ? 0 : (performance.now() - this.visibleSince) / 1000,
    });
    const hit = vis && Math.random() < chance;
    const dir = to.clone().sub(from).normalize();
    if (!hit) dir.x += (Math.random() - 0.5) * 0.04;
    this.tracer(from, vis ? from.clone().addScaledVector(dir, from.distanceTo(to) + (hit ? 0 : 2)) : from.clone().addScaledVector(dir, 10), 0xff4040);
    if (hit) {
      this.hud.hp = Math.max(0, this.hud.hp - AWP_DMG);
      this.hud.damaged = performance.now();
      if (this.hud.hp <= 0) { this.hud.over = 'lose'; this.actor.send({ type: 'world.playerDead' }); }
    }
  }

  private syncEnemy(now: number) {
    if (now - this.lastSync < 200 || this.hud.over) return;
    this.lastSync = now;
    const dist = Math.hypot(this.px - this.enemy.position.x, this.pz - ENEMY_HOLD.z);
    const vis = this.visible();
    if (vis) this.lastSeenAt = now;
    const patch = {
      playerVisible: vis,
      playerMoving: this.speed > 1,
      playerDistance: Math.round(dist),
      playerHp: this.hud.hp,
      heardFootsteps: this.speed > FOOTSTEP_SPEED && dist < FOOTSTEP_RANGE,
      sinceSeen: this.lastSeenAt === null ? -1 : (now - this.lastSeenAt) / 1000,
      roundLeft: this.hud.time,
    };
    // Only resend when something Jev actually reads has changed, at its own
    // resolution. The distance divisor tracks `metres()` in enemyMachine.ts.
    const key = JSON.stringify({
      ...patch,
      playerDistance: Math.round(dist / 2),
      sinceSeen: Math.round(patch.sinceSeen / 2),
      roundLeft: Math.round(patch.roundLeft / 5),
    });
    if (key !== this.lastCtx) { this.lastCtx = key; this.actor.send({ type: 'world.sync', ...patch }); }
  }

  // --- loop ---
  private loop = (t: number) => {
    if (this.disposed) return;
    // Floored as well as capped: two frames in the same millisecond must not divide by zero.
    const dt = Math.min(0.05, Math.max(1e-4, (t - this.last) / 1000));
    this.last = t;
    this.update(dt, t);
    this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame(this.loop);
  };

  private update(dt: number, now: number) {
    const alive = this.hud.over === null;
    if (alive) this.movePlayer(dt);
    else { this.vx = 0; this.vz = 0; this.speed = 0; }

    this.camera.position.set(this.px, this.hud.over === 'lose' ? 0.5 : EYE, this.pz);
    this.camera.rotation.set(this.pitch, this.yaw, this.hud.over === 'lose' ? 0.6 : 0, 'YXZ');

    if (this.hud.reloading && now >= this.reloadAt) { this.hud.reloading = false; this.hud.ammo = MAG; }

    if (alive && this.hud.locked) {
      this.elapsed += dt;
      const left = Math.max(0, ROUND_SECONDS - this.elapsed);
      if (Math.ceil(left) !== this.hud.time) this.hud.time = Math.ceil(left);
      if (left === 0) { this.hud.over = 'time'; this.actor.send({ type: 'world.roundOver' }); }
    }

    // Enemy slides between cover and the lane; the machine says which way.
    if (!this.enemyDown) {
      const step = dt / (PEEK_MS / 1000);
      this.et = this.et < this.etTarget ? Math.min(this.etTarget, this.et + step) : Math.max(this.etTarget, this.et - step);
      this.placeEnemy();
    }
    // Time on target, tracked at frame rate: breaking line of sight resets the
    // bot's aim, which is what makes jiggling and re-peeking worth anything.
    if (this.visible()) this.visibleSince ??= now;
    else this.visibleSince = null;
    this.syncEnemy(now);

    for (const tr of this.tracers) tr.ttl -= dt;
    this.tracers = this.tracers.filter((tr) => {
      if (tr.ttl > 0) return true;
      this.scene.remove(tr.line); tr.line.geometry.dispose(); (tr.line.material as THREE.Material).dispose();
      return false;
    });

    this.fps += ((dt > 0 ? 1 / dt : 60) - this.fps) * 0.1;
    if (now - this.lastEmit > 100) {
      this.lastEmit = now;
      if (this.debug) this.hud.debug = {
        fps: Math.round(this.fps), px: this.px, pz: this.pz, speed: this.speed, et: this.et,
        losToEnemy: this.visible(), distance: Math.hypot(this.px - this.enemy.position.x, this.pz - ENEMY_HOLD.z),
        requests: this.seenDecisions, lastKey: this.lastCtx || null,
      };
      this.emit();
    }
  }

  /** Quake-style ground movement: accelerate toward the wish direction, friction otherwise. Counter-strafing works. */
  private movePlayer(dt: number) {
    const f = (this.keys.has('w') ? 1 : 0) - (this.keys.has('s') ? 1 : 0);
    const r = (this.keys.has('d') ? 1 : 0) - (this.keys.has('a') ? 1 : 0);
    const wishSpeed = MAX_SPEED * (this.keys.has('shift') ? WALK : 1);

    const sp = Math.hypot(this.vx, this.vz);
    if (sp > 0) {
      const drop = Math.max(sp, STOP_SPEED) * FRICTION * dt;
      const k = Math.max(0, sp - drop) / sp;
      this.vx *= k; this.vz *= k;
    }

    if (f || r) {
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      let wx = -sin * f + cos * r, wz = -cos * f - sin * r;
      const n = Math.hypot(wx, wz) || 1;
      wx /= n; wz /= n;
      const add = wishSpeed - (this.vx * wx + this.vz * wz);
      if (add > 0) {
        const a = Math.min(ACCEL * wishSpeed * dt, add);
        this.vx += wx * a; this.vz += wz * a;
      }
    }

    const over = Math.hypot(this.vx, this.vz) / MAX_SPEED;
    if (over > 1) { this.vx /= over; this.vz /= over; }

    const c = collide(this.px + this.vx * dt, this.pz + this.vz * dt, 0.4);
    // Walking into a wall really does stop you: take velocity from the move that happened.
    this.vx = (c.x - this.px) / dt; this.vz = (c.z - this.pz) / dt;
    this.px = c.x; this.pz = c.z;
    this.speed = Math.hypot(this.vx, this.vz);
  }
}
