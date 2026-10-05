import * as THREE from 'three';
import { createActor, type Actor } from 'xstate';
import type { JevClient } from '@xstate/jev';
import {
  ACQUIRE_SECONDS, AWP_DMG, FIRE_INTERVAL_MS, MAG, MIN_AIM_SECONDS, RELOAD_MS, RESERVE, RIFLE_BODY, RIFLE_HEAD,
  ROUND_SECONDS, aimBucket, awpHitChance, playerSpread,
} from './combat';
import { BOLT_MS, PEEK_MS, createEnemyMachine } from './enemyMachine';
import { BOXES, ENEMY_HOLD, ENEMY_PEEK, EYE, PLAYER_SPAWN, blocked, collide } from './map';
import { SKY, ak47, crate, ctBot, dirt, sandstone, tiled } from './look';

export interface DecisionRow { at: number; choice: string; confidence: number; ms: number; reason: string; cached: boolean }
export interface Debug {
  fps: number; px: number; pz: number; speed: number; et: number;
  losToEnemy: boolean; distance: number; requests: number; lastKey: string | null;
}
export interface Hud {
  hp: number; ammo: number; reserve: number; reloading: boolean; enemyHp: number; enemyState: string;
  jev: string; jevError: string | null; decisions: DecisionRow[];
  over: null | 'win' | 'lose' | 'time'; locked: boolean;
  hit: number; damaged: number; live: boolean; time: number; debug: Debug | null;
  /** Crosshair gap in px: widens with movement, like the CS 1.6 dynamic crosshair. */
  gap: number;
}

/**
 * GoldSrc ground movement with the stock cvars, converted at 39.37 units/m:
 * AK-47 maxspeed 221 u/s, shift is 0.52 of it, sv_accelerate 5, sv_friction 4,
 * sv_stopspeed 75. Same rules the real bot's opponent plays by.
 */
const UPM = 39.37;
const MAX_SPEED = 221 / UPM; // m/s
const WALK = 0.52; // shift
const ACCEL = 5; // sv_accelerate, applied against the wish speed
const FRICTION = 4; // sv_friction
const STOP_SPEED = 75 / UPM; // sv_stopspeed: floor on friction, so slow drift still stops
/** CS 1.6 default: fov 90 is horizontal. Three.js wants vertical, derived on resize. */
const HFOV = 90;
/** m_yaw 0.022 deg per count at the stock sensitivity of 3. `?sens=` overrides it. */
const DEG = Math.PI / 180;
/**
 * The bot's own safety nets. Against a real engine these only fire if the
 * plugin goes quiet; here the renderer reports arrival and the bolt itself.
 */
const PEEK_SAFETY_MS = 2000;
const BOLT_SAFETY_MS = 2500;

/** Running this close is audible through a wall. About half the lane, so the cue still means "close". */
const FOOTSTEP_RANGE = 12;
const FOOTSTEP_SPEED = 2.5;

export class Game {
  readonly hud: Hud = {
    hp: 100, ammo: MAG, reserve: RESERVE, reloading: false, enemyHp: 100, enemyState: 'holding',
    jev: 'watching', jevError: null, decisions: [], over: null, locked: false,
    hit: 0, damaged: 0, live: false, time: ROUND_SECONDS, debug: null, gap: 4,
  };
  private listeners = new Set<() => void>();
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(75, 1, 0.05, 100);
  private viewmodel = ak47();
  private kick = 0; private bob = 0;
  private sens: number;
  private arrivalSent = true;
  private boltReadyAt = 0; private bolting = false;
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
    const q = new URLSearchParams(location.search);
    this.debug = q.has('debug');
    this.sens = 0.022 * DEG * (Number(q.get('sens')) || 3);
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
      hp: 100, ammo: MAG, reserve: RESERVE, reloading: false, enemyHp: 100, over: null, decisions: [],
      jev: 'watching', jevError: null, enemyState: 'holding', hit: 0, damaged: 0, time: ROUND_SECONDS,
    });
    this.lastShots = 0; this.lastCtx = ''; this.seenDecisions = 0;
    this.lastSeenAt = null; this.visibleSince = null; this.elapsed = 0; this.reloadAt = 0;
    this.arrivalSent = true; this.bolting = false; this.boltReadyAt = 0; this.kick = 0;
    this.clearTracers();
    this.enemyDown = false;
    this.enemy.visible = true;
    this.enemy.rotation.set(0, 0, 0);
    this.placeEnemy();
    // Same wiring as the CS sidecar: the world reports arrival and the bolt,
    // the aim gate is on, and the machine's timers are only safety nets.
    this.actor = createActor(createEnemyMachine(this.client, {
      peekMs: PEEK_SAFETY_MS, boltMs: BOLT_SAFETY_MS, aimSeconds: MIN_AIM_SECONDS, aimSettledSeconds: ACQUIRE_SECONDS,
    }));
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
    s.background = new THREE.Color(SKY);
    // Starts past the far end of the lane: the duel is fought at ~23m, and a
    // player who cannot see the AWPer killing them is not in a duel.
    s.fog = new THREE.Fog(SKY, 30, 80);
    s.add(new THREE.HemisphereLight(0xfff4dc, 0x8a7a5a, 1.5));
    const sun = new THREE.DirectionalLight(0xfff0c8, 1.8);
    sun.position.set(-20, 40, 10);
    s.add(sun);
    // Sized off the walls, so the floor cannot drift out from under them.
    const x0 = Math.min(...BOXES.map((b) => b.x0)), x1 = Math.max(...BOXES.map((b) => b.x1));
    const z0 = Math.min(...BOXES.map((b) => b.z0)), z1 = Math.max(...BOXES.map((b) => b.z1));
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), tiled(dirt(), x1 - x0, 2, z1 - z0));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
    s.add(floor);
    const stone = sandstone(), wood = crate();
    for (const b of BOXES) {
      const w = b.x1 - b.x0, d = b.z1 - b.z0;
      // Cover that is lower than the walls is crates; the rest is sandstone.
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(w, b.h, d),
        b.h < 3 ? tiled(wood, w, b.h, d) : tiled(stone, w, b.h, d),
      );
      m.position.set((b.x0 + b.x1) / 2, b.h / 2, (b.z0 + b.z1) / 2);
      this.walls.add(m);
    }
    s.add(this.walls);

    const bot = ctBot();
    this.enemyParts = bot.parts;
    this.enemy.add(bot.group);
    this.enemy.rotation.y = 0; // faces +z (toward the player)
    this.scene.add(this.enemy);
    // The viewmodel rides the camera, so the camera has to be in the scene.
    this.scene.add(this.camera);
    this.camera.add(this.viewmodel);
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
    this.camera.fov = 2 * Math.atan(Math.tan((HFOV * DEG) / 2) / this.camera.aspect) / DEG;
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
    this.yaw -= e.movementX * this.sens;
    this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch - e.movementY * this.sens));
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
    if (this.hud.over || this.hud.reloading || this.hud.ammo <= 0 || now - this.lastFire < FIRE_INTERVAL_MS) return;
    this.lastFire = now;
    this.hud.ammo--;
    this.kick = 1;
    if (this.hud.ammo === 0) { this.startReload(now); }

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

  private startReload(now: number) {
    if (this.hud.reserve <= 0) return;
    this.hud.reloading = true; this.reloadAt = now + RELOAD_MS;
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
      else if (value === 'peeking') { this.etTarget = 1; this.arrivalSent = false; }
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
    this.bolting = true; this.boltReadyAt = performance.now() + BOLT_MS;
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
    if (now - this.lastSync < 50 || this.hud.over) return;
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
      onTarget: this.visibleSince === null ? 0 : (now - this.visibleSince) / 1000,
    };
    // Only resend when something Jev actually reads has changed, at its own
    // resolution. The distance divisor tracks `metres()` in enemyMachine.ts.
    const key = JSON.stringify({
      ...patch,
      playerDistance: Math.round(dist / 2),
      sinceSeen: Math.round(patch.sinceSeen / 2),
      roundLeft: Math.round(patch.roundLeft / 5),
      onTarget: aimBucket(patch.onTarget),
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

    this.animateViewmodel(dt);

    if (this.hud.reloading && now >= this.reloadAt) {
      const load = Math.min(MAG, this.hud.reserve);
      this.hud.reserve -= load; this.hud.ammo = load; this.hud.reloading = false;
    }
    // The world reports what a real engine would: the weapon is ready again.
    if (this.bolting && now >= this.boltReadyAt && !this.hud.over) {
      this.bolting = false;
      this.actor.send({ type: 'world.weaponReady' });
    }

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
      if (this.hud.enemyState === 'peeking' && this.et >= this.etTarget && this.etTarget > 0 && !this.arrivalSent) {
        this.arrivalSent = true;
        this.actor.send({ type: 'world.arrived' });
      }
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

  /** Walk bob, fire kick and reload dip on the AK, and the crosshair gap that tracks movement. */
  private animateViewmodel(dt: number) {
    this.bob += this.speed * dt * 2.2;
    this.kick = Math.max(0, this.kick - dt * 9);
    const sway = Math.min(1, this.speed / MAX_SPEED);
    const dip = this.hud.reloading ? 0.16 : 0;
    this.viewmodel.position.set(
      0.2 + Math.sin(this.bob) * 0.012 * sway,
      -0.2 - Math.abs(Math.cos(this.bob)) * 0.014 * sway - dip,
      -0.38 + this.kick * 0.05,
    );
    this.viewmodel.rotation.set(0.02 + this.kick * 0.06 + (this.hud.reloading ? -0.5 : 0), 0.05, 0);
    this.viewmodel.visible = this.hud.over !== 'lose';
    // CS 1.6: the cross opens with the same inaccuracy that spreads the bullets.
    this.hud.gap = Math.round(4 + playerSpread(this.speed) * 900);
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
