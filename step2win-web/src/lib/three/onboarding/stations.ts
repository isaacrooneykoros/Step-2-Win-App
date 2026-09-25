import { animate, type JSAnimation } from 'animejs';
import { Color, Group, Mesh, MeshBasicMaterial, PlaneGeometry, Vector3 } from 'three';
import type { StairPath } from './path';
import { Person, type Look, type PeopleLibrary } from './people';
import { Flag, Footfalls, Pool, StepCounter, WeekSteps, buildMonument, buildPlaza, makeBlob, makeYouRing, type CardColors } from './props';
import type { TierSettings } from './quality';

/**
 * The four stations of the onboarding world. Each one owns its people and props, runs its own
 * clock (reset when its page is entered) and exposes a camera pose for that moment, so the
 * world can fly between two live poses.
 */

export interface CameraPose {
  position: Vector3;
  target: Vector3;
}

export interface Palette {
  dark: boolean;
  brand: Color;
  brandCss: string;
  reward: Color;
  rewardCss: string;
  fgCss: string;
  inkCss: string;
  card: CardColors;
  /** Muted colour for idle day letters. */
  idle: Color;
}

export interface StationContext {
  path: StairPath;
  lib: PeopleLibrary;
  tier: TierSettings;
  palette: Palette;
  /** Called by stations that just spawned people (to precompile / reveal). */
  onSpawn: () => void;
}

const ease = {
  inOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  out: (t: number) => 1 - Math.pow(1 - t, 3),
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// ---------------------------------------------------------------------------------------------
// Cast
// ---------------------------------------------------------------------------------------------

type CastId = 'you' | 'baraka' | 'wanjiru' | 'otieno' | 'akinyi';

function looks(p: Palette): Record<CastId, Look> {
  const brandHex = `#${p.brand.getHexString(undefined)}`;
  return {
    // "You": brand-coloured tee, charcoal leggings, white trainers, afro puffs.
    you: {
      body: 'F',
      skin: '#6a432e',
      hair: 'Hair_Buns',
      hairColor: '#191311',
      top: brandHex,
      bottom: '#1f2428',
      shoe: '#2b3035',
      trim: '#f4f4f0',
      sleeve: 0.46,
      bottomLen: 1.92,
      hem: 0.16,
    },
    // Baraka, late 20s: off-white tee, navy running shorts.
    baraka: {
      body: 'M',
      skin: '#4b2e1f',
      hair: 'Hair_Buzzed',
      hairColor: '#15100e',
      top: '#e7e3da',
      bottom: '#27384a',
      shoe: '#30343a',
      trim: '#1f6f55',
      sleeve: 0.5,
      bottomLen: 0.56,
      hem: 0.14,
    },
    // Wanjiru, 30s: terracotta tank, capri leggings, long curls.
    wanjiru: {
      body: 'F',
      skin: '#8a5a3d',
      hair: 'Hair_Long',
      hairColor: '#1d1512',
      top: '#c2603b',
      bottom: '#262a2f',
      shoe: '#e9e5dc',
      trim: '#f2e3d3',
      sleeve: 0.02,
      bottomLen: 1.62,
      hem: 0.18,
    },
    // Otieno, 40s: greying beard, dark polo, khaki shorts.
    otieno: {
      body: 'M',
      skin: '#5b3a29',
      hair: 'Hair_Buzzed',
      hairColor: '#2a2623',
      beard: true,
      beardColor: '#77716a',
      top: '#34443d',
      bottom: '#8d846f',
      shoe: '#3b3e42',
      trim: '#c9c3b5',
      sleeve: 0.58,
      bottomLen: 0.72,
      hem: 0.12,
      scale: 1.02,
    },
    // Akinyi, 20s: slate-blue long sleeve, full leggings, short natural hair.
    akinyi: {
      body: 'F',
      skin: '#3f281b',
      hair: 'Hair_BuzzedFemale',
      hairColor: '#120d0b',
      top: '#56698a',
      bottom: '#2a2d31',
      shoe: '#eeeae3',
      trim: '#dfe5ef',
      sleeve: 1.85,
      bottomLen: 1.92,
      hem: 0.16,
      scale: 0.97,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------------------------

interface Actor {
  id: CastId;
  person: Person | null;
  blob: Mesh;
  ring?: Mesh;
  /** Arc length along the path and lateral offset (for walkers). */
  s: number;
  lateral: number;
  yaw: number;
  reveal: JSAnimation | null;
}

export abstract class Station {
  readonly group = new Group();
  /** Seconds since the page was entered (negative while the entrance is delayed). */
  t = 0;
  protected actors: Actor[] = [];
  protected anims: JSAnimation[] = [];
  /** Background mode: shown in the final reveal, updated at a low rate. */
  background = false;

  constructor(protected ctx: StationContext) {}

  abstract cast(): Array<{ id: CastId; s: number; lateral: number }>;
  abstract cameraPose(out: CameraPose): void;
  /** Reset to the start of this page's story. */
  protected abstract restart(): void;
  /** Per-frame story. Returns true while something scripted (not just idle loops) is moving. */
  protected abstract step(dt: number): boolean;
  /** Jump to the end state (for the final reveal). */
  abstract settle(): void;

  get people(): Person[] {
    return this.actors.map((a) => a.person).filter((p): p is Person => !!p);
  }

  /** Creates any people whose body has loaded. New arrivals dissolve in. */
  spawn(): boolean {
    let spawned = false;
    const L = looks(this.ctx.palette);
    if (!this.actors.length) {
      for (const c of this.cast()) {
        const blob = makeBlob(this.ctx.tier.shadowMapSize ? 0.26 : 0.42);
        this.group.add(blob);
        this.actors.push({ id: c.id, person: null, blob, s: c.s, lateral: c.lateral, yaw: 0, reveal: null });
      }
    }
    for (const a of this.actors) {
      if (a.person) continue;
      const look = L[a.id];
      if (!this.ctx.lib.has(look.body)) continue;
      const person = new Person(this.ctx.lib, look);
      if (!this.ctx.lib.body(look.body).speeds.size) person.calibrate();
      a.person = person;
      this.group.add(person.object);
      if (a.id === 'you') {
        a.ring = makeYouRing(this.ctx.palette.brand);
        this.group.add(a.ring);
      }
      this.onSpawn(a);
      spawned = true;
    }
    if (spawned) this.ctx.onSpawn();
    return spawned;
  }

  /** Hook: place / pose a newly created person consistently with the current story time. */
  protected onSpawn(actor: Actor) {
    actor.person?.setReveal(0);
    actor.reveal = animate(actor.person!.materials.uniforms.uReveal, { value: [0, 1], duration: 700, ease: 'inOutQuad' });
  }

  enter(delayMs: number) {
    this.anims.forEach((a) => a.pause());
    this.anims = [];
    this.t = -delayMs / 1000;
    this.background = false;
    this.restart();
  }

  update(dt: number): boolean {
    this.t += dt;
    const busy = this.step(dt);
    for (const a of this.actors) {
      const p = a.person;
      if (!p) continue;
      p.update(dt, this.ctx.path.ground, this.ctx.tier.footIk && !this.background);
      const o = p.object.position;
      const g = this.ctx.path.ground(o.x, o.z);
      a.blob.position.set(o.x, g + 0.012, o.z);
      a.blob.rotation.y = p.object.rotation.y;
      if (a.ring) a.ring.position.set(o.x, g + 0.018, o.z);
    }
    return busy;
  }

  setPeopleVisible(v: boolean) {
    this.actors.forEach((a) => {
      if (a.person) a.person.object.visible = v;
      a.blob.visible = v && !!a.person;
      if (a.ring) a.ring.visible = v && !!a.person;
    });
  }

  applyPalette(p: Palette) {
    const L = looks(p);
    this.actors.forEach((a) => {
      if (a.id === 'you' && a.person) {
        a.person.setTop(L.you.top);
      }
      if (a.ring) ((a.ring.material as MeshBasicMaterial).color as Color).copy(p.brand);
    });
  }

  /** Walk an actor along the path: advance by its ground speed, face the tangent. */
  protected walk(a: Actor, dt: number, lateralDrift = 0) {
    const p = a.person;
    if (!p) return;
    a.s += p.groundSpeed() * dt;
    this.place(a, lateralDrift);
  }

  protected place(a: Actor, lateralDrift = 0, faceYaw?: number) {
    const p = a.person;
    if (!p) return;
    const f = this.ctx.path.frame(a.s);
    const x = f.point.x + f.right.x * (a.lateral + lateralDrift);
    const z = f.point.z + f.right.z * (a.lateral + lateralDrift);
    p.object.position.x = x;
    p.object.position.z = z;
    if (p.object.position.y === 0) p.object.position.y = f.point.y;
    const yaw = faceYaw ?? Math.atan2(f.tangent.x, f.tangent.z);
    a.yaw = yaw;
    p.object.rotation.y = yaw;
  }

  protected turnTowards(a: Actor, yaw: number, dt: number, rate = 3) {
    if (!a.person) return;
    let d = yaw - a.person.object.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    a.person.object.rotation.y += d * (1 - Math.exp(-dt * rate));
  }

  protected actor(id: CastId) {
    return this.actors.find((a) => a.id === id) ?? null;
  }

  /** Focus point for the shadow camera. */
  focus(out: Vector3) {
    const pose = { position: new Vector3(), target: out };
    this.cameraPose(pose);
    return out;
  }

  dispose() {
    this.anims.forEach((a) => a.pause());
    this.actors.forEach((a) => {
      a.reveal?.pause();
      a.person?.dispose();
      a.blob.geometry.dispose();
      (a.blob.material as MeshBasicMaterial).dispose();
      if (a.ring) {
        a.ring.geometry.dispose();
        (a.ring.material as MeshBasicMaterial).dispose();
      }
    });
    this.actors = [];
  }
}

// ---------------------------------------------------------------------------------------------
// 1. Every step counts — a runner at dawn climbing the stair-path, footfalls glowing, a verified
//    step count ticking beside her; Nairobi's skyline behind.
// ---------------------------------------------------------------------------------------------

/** World direction from the runner towards the page-1 camera (the city lies the other way). */
export const MOVE_VIEW = new Vector3(0.35, 0, -0.94).normalize();

export class MoveStation extends Station {
  private footfalls: Footfalls;
  private counter: StepCounter;
  private count = 8412;
  private phase: 'jog' | 'walk' | 'idle' = 'jog';
  private camS = 0;
  private cardPos = new Vector3();
  private readonly start = 9;
  private readonly walkAt = 40.5;
  private readonly stopAt = 50.5;

  constructor(ctx: StationContext) {
    super(ctx);
    this.footfalls = new Footfalls(ctx.palette.brand);
    this.counter = new StepCounter(ctx.palette.card);
    this.counter.set(this.count);
    this.group.add(this.footfalls.mesh, this.counter.sprite);
  }

  cast() {
    return [{ id: 'you' as const, s: this.start, lateral: 0.15 }];
  }

  protected onSpawn(a: Actor) {
    super.onSpawn(a);
    const p = a.person!;
    p.onFootPlant = (pos, foot) => {
      if (this.phase === 'idle') return;
      this.footfalls.add(pos, p.object.rotation.y, foot);
      this.count += 1;
      this.counter.set(this.count);
    };
    this.restart();
  }

  protected restart() {
    const a = this.actors[0];
    this.phase = 'jog';
    this.count = 8412;
    this.counter.set(this.count);
    this.footfalls.clear();
    if (!a?.person) return;
    a.s = this.start;
    a.person.lookTarget = null;
    a.person.pose('Jog_Fwd_Loop', 0.2, 0.78);
    a.person.object.position.y = 0;
    a.person.resetGround();
    this.place(a);
    this.camS = a.s;
    this.cardPos.set(0, 0, 0);
  }

  settle() {
    const a = this.actors[0];
    if (!a?.person) return;
    this.phase = 'idle';
    a.s = this.stopAt;
    a.person.pose('Idle_Loop', 0.3);
    a.person.resetGround();
    this.place(a);
    this.camS = a.s;
    this.footfalls.clear();
  }

  protected step(dt: number): boolean {
    const a = this.actors[0];
    const busyMarks = this.footfalls.update(dt);
    if (!a?.person) return busyMarks;
    const p = a.person;
    if (this.phase !== 'idle') this.walk(a, dt);
    if (this.phase === 'jog' && a.s > this.walkAt) {
      this.phase = 'walk';
      p.play('Walk_Loop', { fade: 0.9, warp: true, timeScale: 1 });
    } else if (this.phase === 'walk' && a.s > this.stopAt) {
      this.phase = 'idle';
      p.play('Idle_Loop', { fade: 0.6 });
    }
    // Card floats beside her head, lagging a touch like a camera operator's overlay.
    const head = p.object.position.clone();
    head.y += 2.02;
    head.addScaledVector(MOVE_VIEW, 0.2);
    if (this.cardPos.lengthSq() === 0) this.cardPos.copy(head);
    this.cardPos.lerp(head, 1 - Math.exp(-dt * 6));
    this.counter.sprite.position.copy(this.cardPos);
    this.camS += (a.s - this.camS) * (1 - Math.exp(-dt * 3));
    return this.phase !== 'idle' || busyMarks;
  }

  cameraPose(out: CameraPose) {
    const a = this.actors[0];
    const s = a?.person ? this.camS : this.start + Math.max(0, this.t) * 3.8;
    const f = this.ctx.path.frame(Math.min(s, this.stopAt));
    const base = f.point.clone();
    base.y = this.ctx.path.smoothHeightAt(s);
    out.target.copy(base).add(new Vector3(0, 1.3, 0)).addScaledVector(f.tangent, 0.5);
    out.position.copy(out.target).addScaledVector(MOVE_VIEW, 6.9).add(new Vector3(0, 0.05, 0));
  }

  applyPalette(p: Palette) {
    super.applyPalette(p);
    this.footfalls.setColor(p.brand);
    this.counter.setColors(p.card);
  }

  dispose() {
    super.dispose();
    this.footfalls.dispose();
    this.counter.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// 2. Walk together — four friends climbing a shared staircase, chatting, towards a milestone flag.
// ---------------------------------------------------------------------------------------------

export class TogetherStation extends Station {
  private flag: Flag;
  private line: Mesh;
  private stopped = false;
  private chatTimer = 0;
  private chatRound = 0;
  private readonly start = 58.2;
  private readonly stopAt = 81.6;
  private centroid = new Vector3();
  private orbit0: number;

  constructor(ctx: StationContext) {
    super(ctx);
    const p = ctx.palette;
    this.flag = new Flag({ brand: p.brandCss, fg: p.fgCss, reward: p.rewardCss });
    const flagPos = ctx.path.pointAt(83.2, 2.15);
    this.flag.group.position.copy(flagPos);
    this.flag.group.rotation.y = Math.atan2(ctx.path.frame(83.2).tangent.x, ctx.path.frame(83.2).tangent.z) + Math.PI / 2;
    // Milestone line across the top step.
    this.line = new Mesh(
      new PlaneGeometry(5.0, 0.16).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ color: p.brand.clone(), toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2 }),
    );
    const f = ctx.path.frame(80.3);
    this.line.position.copy(f.point).setY(ctx.path.heightAt(80.3) + 0.006);
    this.line.rotation.y = Math.atan2(f.tangent.x, f.tangent.z);
    this.group.add(this.flag.group, this.line);
    const t = ctx.path.frame(this.start + 6).tangent;
    this.orbit0 = Math.atan2(t.z, t.x) + 0.62;
  }

  cast() {
    return [
      { id: 'you' as const, s: this.start, lateral: 0.55 },
      { id: 'baraka' as const, s: this.start + 0.4, lateral: -0.75 },
      { id: 'wanjiru' as const, s: this.start - 1.1, lateral: 1.65 },
      { id: 'otieno' as const, s: this.start - 1.35, lateral: -1.75 },
    ];
  }

  protected onSpawn(a: Actor) {
    super.onSpawn(a);
    this.startActor(a, true);
  }

  private startActor(a: Actor, keepProgress: boolean) {
    const p = a.person;
    if (!p) return;
    const lead = this.actors[0];
    const cast = this.cast().find((c) => c.id === a.id)!;
    const offset = cast.s - this.start;
    a.s = keepProgress && lead !== a && lead.person ? lead.s + offset : cast.s;
    p.resetGround();
    p.object.position.y = 0;
    if (this.stopped) {
      p.pose(a.id === 'wanjiru' || a.id === 'you' ? 'Idle_Talking_Loop' : 'Idle_Loop', Math.random());
    } else {
      p.pose('Walk_Loop', (Math.abs(offset) * 0.37) % 1, this.walkScale(p));
    }
    this.place(a);
  }

  private walkScale(p: Person) {
    // Everyone walks at the group's pace: each clip is sped up or slowed to match.
    const body = p.look.body;
    const v = this.ctx.lib.body(body).speeds.get('Walk_Loop') ?? 1;
    return 1.02 / (v * (p.look.scale ?? 1));
  }

  protected restart() {
    this.stopped = false;
    this.chatTimer = 0;
    this.chatRound = 0;
    this.flag.setRaise(1);
    this.actors.forEach((a) => this.startActor(a, false));
  }

  settle() {
    this.stopped = true;
    this.actors.forEach((a) => {
      const cast = this.cast().find((c) => c.id === a.id)!;
      a.s = this.stopAt + (cast.s - this.start);
      if (!a.person) return;
      a.person.pose(a.id === 'wanjiru' || a.id === 'you' ? 'Idle_Talking_Loop' : 'Idle_Loop', Math.random());
      a.person.resetGround();
      this.place(a);
    });
  }

  protected step(dt: number): boolean {
    this.flag.update(dt);
    const lead = this.actors[0];
    if (!this.stopped) {
      this.actors.forEach((a) => {
        if (!a.person) return;
        const speed = a.person.groundSpeed();
        a.s += speed * dt;
        this.place(a);
      });
      if (lead?.person && lead.s >= this.stopAt) {
        this.stopped = true;
        this.actors.forEach((a, i) => {
          a.person?.play(i % 2 === 0 ? 'Idle_Talking_Loop' : 'Idle_Loop', { fade: 0.7 });
        });
      }
    } else {
      // Gather: everyone turns a little towards the middle of the group.
      const c = this.groupCentroid(new Vector3());
      this.actors.forEach((a) => {
        if (!a.person) return;
        const o = a.person.object.position;
        this.turnTowards(a, Math.atan2(c.x - o.x, c.z - o.z), dt, 1.6);
      });
    }
    // Conversation: glance at a neighbour, switch every couple of seconds.
    this.chatTimer -= dt;
    if (this.chatTimer <= 0) {
      this.chatTimer = 1.8 + Math.random() * 1.4;
      this.chatRound += 1;
      const pairs: Array<[number, number]> = this.chatRound % 2 ? [[0, 1], [2, 3]] : [[0, 2], [1, 3]];
      pairs.forEach(([i, j]) => {
        const a = this.actors[i]?.person;
        const b = this.actors[j]?.person;
        if (a && b) {
          a.lookTarget = b.bonePosition('Head');
          b.lookTarget = this.chatRound % 3 ? a.bonePosition('Head') : null;
        }
      });
    }
    this.actors.forEach((a) => {
      const p = a.person;
      if (p?.lookTarget) {
        // Keep the glance target following the friend's head.
        const other = this.actors.find((b) => b.person && b !== a && b.person.object.position.distanceTo(p.lookTarget!) < 1.2);
        if (other?.person) other.person.bonePosition('Head', p.lookTarget);
      }
    });
    this.groupCentroid(this.centroid);
    return !this.stopped;
  }

  private groupCentroid(out: Vector3) {
    out.set(0, 0, 0);
    let n = 0;
    this.actors.forEach((a) => {
      if (!a.person) return;
      out.add(a.person.object.position);
      n++;
    });
    if (!n) return out.copy(this.ctx.path.pointAt(this.start + Math.max(0, this.t)));
    return out.multiplyScalar(1 / n);
  }

  cameraPose(out: CameraPose) {
    const c = this.actors.some((a) => a.person) ? this.centroid.clone() : this.ctx.path.pointAt(this.start + Math.max(0, this.t));
    if (c.lengthSq() === 0) c.copy(this.ctx.path.pointAt(this.start));
    const s = this.ctx.path.project(c.x, c.z).s;
    c.y = this.ctx.path.smoothHeightAt(s);
    const theta = this.orbit0 - Math.max(0, this.t) * 0.045;
    out.target.copy(c).add(new Vector3(0, 1.05, 0));
    out.position.copy(out.target).add(new Vector3(Math.cos(theta) * 8.6, 1.9, Math.sin(theta) * 8.6));
  }

  applyPalette(p: Palette) {
    super.applyPalette(p);
    (this.line.material as MeshBasicMaterial).color.copy(p.brand);
  }

  dispose() {
    super.dispose();
    this.flag.dispose();
    this.line.geometry.dispose();
    (this.line.material as MeshBasicMaterial).dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// 3. Qualify to share the pool — at the milestone plaza those who qualified celebrate while KSh
//    coins arc from the pool to them; those still walking come up the stairs below, quieter.
// ---------------------------------------------------------------------------------------------

export class PoolStation extends Station {
  private pool: Pool;
  private plaza: Group;
  private center: Vector3;
  private fwd: Vector3;
  private right: Vector3;
  private rate = 0;
  private targets: Vector3[] = [];

  constructor(ctx: StationContext) {
    super(ctx);
    const { center, radius } = ctx.path.plaza();
    this.center = center;
    const f = ctx.path.frame(104);
    this.fwd = f.tangent.clone();
    this.right = f.right.clone();
    this.plaza = buildPlaza(radius);
    this.plaza.position.copy(center);
    this.pool = new Pool({ reward: ctx.palette.rewardCss, ink: ctx.palette.inkCss });
    this.pool.group.position.copy(center);
    this.group.add(this.plaza, this.pool.group);
  }

  /** Celebrants stand on the stair-head side of the pool, facing it (and the camera). */
  private spot(i: number) {
    // Nobody stands directly behind the pool from the camera: the coin fountain stays clear of faces.
    const angles = [0.22, -0.62, 0.98];
    const r = [2.15, 2.25, 2.3][i];
    const a = angles[i];
    const dir = this.fwd.clone().multiplyScalar(-Math.cos(a)).addScaledVector(this.right, Math.sin(a));
    return this.center.clone().addScaledVector(dir, r);
  }

  cast() {
    return [
      { id: 'you' as const, s: 0, lateral: 0 },
      { id: 'baraka' as const, s: 0, lateral: 0 },
      { id: 'wanjiru' as const, s: 0, lateral: 0 },
      { id: 'otieno' as const, s: 86.6, lateral: -0.7 },
      { id: 'akinyi' as const, s: 85.4, lateral: 0.75 },
    ];
  }

  private isWalker(a: Actor) {
    return a.id === 'otieno' || a.id === 'akinyi';
  }

  protected onSpawn(a: Actor) {
    super.onSpawn(a);
    this.startActor(a);
  }

  /**
   * Celebrations: "you" jumps for joy (jump clips + arms thrown up), Baraka pumps his fist,
   * Wanjiru dances with both arms up. The arm layer is procedural on top of the clips.
   */
  private celebrate(a: Actor, i: number) {
    const p = a.person!;
    if (i === 0) {
      const jump = () => {
        if (!p.play('Jump_Start', { fade: 0.18, once: true, timeScale: 1.1 })) p.play('Dance_Loop', { fade: 0.4 });
      };
      p.onClipFinished = (clip) => {
        if (clip === 'Jump_Start') p.play('Jump_Land', { fade: 0.12, once: true, timeScale: 1.15 });
        else if (clip === 'Jump_Land') {
          p.play('Idle_Talking_Loop', { fade: 0.3 });
          this.anims.push(animate({ v: 0 }, { v: 1, duration: 900, onComplete: () => this.celebrating && jump() }));
        }
      };
      jump();
    } else if (i === 1) {
      p.play('Idle_Talking_Loop', { fade: 0.4 });
    } else {
      if (!p.play('Dance_Loop', { fade: 0.4, timeScale: 0.95 })) p.play('Idle_Talking_Loop', { fade: 0.4 });
    }
  }

  private celebrating = false;

  /** Arm layer per celebrant, from the station clock. */
  private updateArms() {
    const t = this.t;
    this.actors.forEach((a) => {
      const p = a.person;
      if (!p || this.isWalker(a)) return;
      const i = ['you', 'baraka', 'wanjiru'].indexOf(a.id);
      const start = 0.55 + i * 0.28;
      const k = Math.min(1, Math.max(0, (t - start) / 0.35));
      if (i === 0) {
        // Arms up while airborne, down when landing.
        const clip = p.currentClip;
        const want = clip === 'Jump_Start' ? 1 : clip === 'Jump_Land' ? 0.55 : 0.1;
        p.armsUp.l += (want * k - p.armsUp.l) * 0.25;
        p.armsUp.r += (want * k - p.armsUp.r) * 0.25;
      } else if (i === 1) {
        // Three quick pumps, a breath, repeat.
        const c = (t - start) % 1.9;
        const pump = c < 1.2 ? 0.55 + 0.45 * Math.abs(Math.sin((c / 1.2) * Math.PI * 3)) : 0.35;
        p.armsUp.r = pump * k;
        p.armsUp.l = 0;
      } else {
        const sway = 0.8 + 0.15 * Math.sin(t * 4.2);
        p.armsUp.l = sway * k;
        p.armsUp.r = (0.8 + 0.15 * Math.sin(t * 4.2 + 1.4)) * k;
      }
    });
  }

  private startActor(a: Actor) {
    const p = a.person;
    if (!p) return;
    p.resetGround();
    p.object.position.y = 0;
    if (this.isWalker(a)) {
      const cast = this.cast().find((c) => c.id === a.id)!;
      a.s = cast.s;
      p.setDesaturate(this.ctx.palette.dark ? 0.55 : 0.62);
      const v = this.ctx.lib.body(p.look.body).speeds.get('Walk_Loop') ?? 1;
      p.pose('Walk_Loop', a.id === 'akinyi' ? 0.5 : 0, 0.8 / (v * (p.look.scale ?? 1)));
      this.place(a);
      return;
    }
    const i = ['you', 'baraka', 'wanjiru'].indexOf(a.id);
    const pos = this.spot(i);
    p.object.position.set(pos.x, this.center.y, pos.z);
    p.object.rotation.y = Math.atan2(this.center.x - pos.x, this.center.z - pos.z);
    p.onClipFinished = null;
    p.armsUp.l = 0;
    p.armsUp.r = 0;
    p.pose('Idle_Loop', i * 0.3);
    // Celebrations start in a staggered wave as the camera arrives.
    this.anims.push(
      animate({ v: 0 }, {
        v: 1,
        duration: 1,
        delay: Math.max(0, -this.t * 1000) + 280 + i * 260,
        onComplete: () => a.person && this.celebrate(a, i),
      }),
    );
  }

  protected restart() {
    this.celebrating = true;
    this.rate = 0;
    this.pool.resetStream();
    this.actors.forEach((a) => this.startActor(a));
  }

  settle() {
    this.rate = 0;
    this.pool.resetStream();
    this.actors.forEach((a, i) => {
      if (!a.person) return;
      if (this.isWalker(a)) {
        a.s = 92.5 + i * 0.3;
        a.person.pose('Walk_Loop', i * 0.4);
        a.person.resetGround();
        this.place(a);
      } else {
        a.person.pose(a.person.look.body === 'F' ? 'Dance_Loop' : 'Idle_Talking_Loop', i * 0.2);
        if (!a.person.currentClip) a.person.pose('Idle_Loop');
      }
    });
  }

  protected step(dt: number): boolean {
    // Coins flow for ~8 s after arrival: ramp up, steady stream, taper off.
    const t = this.t;
    this.rate = t < 0.5 ? 0 : t < 1.4 ? (4.5 * (t - 0.5)) / 0.9 : t < 7.2 ? 4.5 : t < 9 ? 4.5 * (1 - (t - 7.2) / 1.8) : 0;
    this.updateArms();
    this.targets.length = 0;
    this.actors.forEach((a) => {
      const p = a.person;
      if (!p) return;
      if (this.isWalker(a)) {
        // Still on their way: they stop at the plaza edge if the page is left open for long.
        if (a.s < 95.2) this.walk(a, dt);
        else if (p.currentClip === 'Walk_Loop') p.play('Idle_Loop', { fade: 0.6 });
        return;
      }
      // Coins land on raised hands, or just above the head.
      const head = p.bonePosition('Head', new Vector3());
      const l = p.bonePosition('hand_l', new Vector3());
      const r = p.bonePosition('hand_r', new Vector3());
      const top = l.y > r.y ? l : r;
      this.targets.push(top.y > head.y + 0.12 ? top.add(new Vector3(0, 0.08, 0)) : head.add(new Vector3(0, 0.42, 0)));
    });
    const flying = this.pool.update(dt, this.targets, this.rate);
    return flying || this.rate > 0;
  }

  cameraPose(out: CameraPose) {
    const drift = Math.min(1, Math.max(0, this.t) / 9);
    out.target.copy(this.center).addScaledVector(this.fwd, -1.8).addScaledVector(this.right, 0.2).add(new Vector3(0, 1.75, 0));
    out.position
      .copy(this.center)
      .addScaledVector(this.fwd, 6.9 - drift * 0.5)
      .addScaledVector(this.right, 0.5 - drift * 0.3)
      .add(new Vector3(0, 2.5, 0));
  }

  applyPalette(p: Palette) {
    super.applyPalette(p);
    this.pool.setColors(p.rewardCss);
    this.actors.forEach((a) => {
      if (this.isWalker(a)) a.person?.setDesaturate(p.dark ? 0.55 : 0.62);
    });
  }

  dispose() {
    super.dispose();
    this.pool.dispose();
    this.plaza.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as MeshBasicMaterial).dispose();
      }
    });
  }
}

// ---------------------------------------------------------------------------------------------
// 4. Make it a habit — seven steps, one per day, light up under her as she climbs; at the top a
//    confident pose while the camera pulls back to reveal the whole climb.
// ---------------------------------------------------------------------------------------------

export class HabitStation extends Station {
  private week: WeekSteps;
  private monument: ReturnType<typeof buildMonument>;
  private phase: 'walk' | 'top' = 'walk';
  private litCount = 0;
  private readonly start = 116.4;
  private readonly stopAt = 126.6;
  private stepsS: number[] = [];
  private camS = 0;
  private reveal = { u: 0 };
  private revealAnim: JSAnimation | null = null;

  constructor(ctx: StationContext) {
    super(ctx);
    const path = ctx.path;
    const sec = path.section('week');
    const steps: Array<{ position: Vector3; yaw: number; width: number; tread: number; riser: number }> = [];
    for (let k = 0; k < 7; k++) {
      const sMid = sec.from + (k + 0.5) * sec.tread!;
      const f = path.frame(sMid);
      this.stepsS.push(sec.from + k * sec.tread!);
      steps.push({ position: f.point.clone().setY(path.heightAt(sMid)), yaw: Math.atan2(f.tangent.x, f.tangent.z), width: sec.width, tread: sec.tread!, riser: sec.riser! });
    }
    this.week = new WeekSteps(steps, ctx.palette.brand, ctx.palette.idle);
    this.monument = buildMonument(ctx.palette.brand, ctx.palette.reward);
    const fm = path.frame(131.2);
    this.monument.group.position.copy(fm.point).addScaledVector(fm.right, -1.3);
    this.monument.group.rotation.y = Math.atan2(fm.tangent.x, fm.tangent.z) + Math.PI / 2 + 0.35;
    this.group.add(this.week.group, this.monument.group);
  }

  cast() {
    return [{ id: 'you' as const, s: this.start, lateral: 0.1 }];
  }

  protected onSpawn(a: Actor) {
    super.onSpawn(a);
    this.restart();
  }

  private walkScale(p: Person) {
    const v = this.ctx.lib.body(p.look.body).speeds.get('Walk_Loop') ?? 1;
    return 1.42 / v;
  }

  protected restart() {
    this.phase = 'walk';
    this.litCount = 0;
    for (let i = 0; i < 7; i++) this.week.setLit(i, 0);
    this.revealAnim?.pause();
    this.reveal.u = 0;
    const a = this.actors[0];
    if (!a?.person) return;
    a.s = this.start;
    a.person.lookTarget = null;
    a.person.armsUp.l = 0;
    a.person.armsUp.r = 0;
    a.person.pose('Walk_Loop', 0, this.walkScale(a.person));
    a.person.object.position.y = 0;
    a.person.resetGround();
    this.place(a);
    this.camS = a.s;
    // The flight lands on the overview of the whole climb; then the camera pushes in to the week.
    this.reveal.u = 1;
    this.revealAnim = animate(this.reveal, { u: [1, 0], duration: 4200, delay: Math.max(0, -this.t * 1000) + 650, ease: 'inOutSine' });
    this.anims.push(this.revealAnim);
  }

  settle() {
    for (let i = 0; i < 7; i++) this.week.setLit(i, 1);
  }

  protected step(dt: number): boolean {
    const a = this.actors[0];
    const p = a?.person;
    if (!p) return this.reveal.u < 1;
    if (this.phase === 'walk') {
      this.walk(a, dt);
      while (this.litCount < 7 && a.s >= this.stepsS[this.litCount] + 0.35) {
        const i = this.litCount++;
        const o = { v: 0 };
        this.anims.push(
          animate(o, {
            v: [0, 1.35, 1],
            duration: 620,
            ease: 'outQuad',
            onUpdate: () => this.week.setLit(i, o.v),
          }),
        );
      }
      if (a.s >= this.stopAt) {
        this.phase = 'top';
        // Arrival: both arms up for a beat, then a confident folded-arms stance.
        p.play('Idle_Loop', { fade: 0.4 });
        const arms = p.armsUp;
        this.anims.push(
          animate(arms, {
            l: [{ to: 1, duration: 380, ease: 'outQuad' }, { to: 1, duration: 700 }, { to: 0, duration: 420, ease: 'inOutQuad' }],
            r: [{ to: 1, duration: 340, ease: 'outQuad' }, { to: 1, duration: 740 }, { to: 0, duration: 420, ease: 'inOutQuad' }],
            onComplete: () => {
              if (this.phase === 'top') p.play('Idle_FoldArms_Loop', { fade: 0.6 }) ?? p.play('Idle_Loop', { fade: 0.6 });
            },
          }),
        );
      }
    } else {
      // Turn to face back down the climb (and the camera).
      const cam = this.heroPosition;
      const o = p.object.position;
      this.turnTowards(a, Math.atan2(cam.x - o.x, cam.z - o.z) - 0.25, dt, 1.6);
    }
    this.camS += (a.s - this.camS) * (1 - Math.exp(-dt * 3));
    return this.phase === 'walk' || this.reveal.u > 0;
  }

  cameraPose(out: CameraPose) {
    const path = this.ctx.path;
    // Rest frame: the seven-day staircase, centred, seen from the foot of the flight, with the
    // summit (and her confident pose) at the top.
    const heroT = this.heroTarget;
    const heroP = this.heroPosition;
    const nearT = heroT;
    const nearP = heroP;
    void path;
    // Arrival: a high crane shot over the pool plaza looking up the climb to the summit; it
    // then cranes down (same heading, no flip) into the staircase hero frame.
    const back = new Vector3().subVectors(heroT, heroP).setY(0).normalize();
    const farP = heroP.clone().addScaledVector(back, -13).add(new Vector3(0, 11, 0));
    const farT = heroT.clone().addScaledVector(back, 6).add(new Vector3(0, 1.5, 0));
    const u = ease.inOut(clamp01(this.reveal.u));
    out.target.copy(nearT).lerp(farT, u);
    out.position.copy(nearP).lerp(farP, u);
    out.position.y += Math.sin(u * Math.PI) * 3;
  }

  /** True while the camera is out wide enough that the other stations should come alive. */
  get revealing() {
    return this.reveal.u > 0.35;
  }

  private get heroTarget() {
    const path = this.ctx.path;
    const t = path.pointAt(122.6);
    t.y = path.smoothHeightAt(122.6) + 0.45;
    return t;
  }

  private get heroPosition() {
    const path = this.ctx.path;
    const f = path.frame(111.4);
    const p = f.point.clone().addScaledVector(f.right, 2.1);
    p.y = path.smoothHeightAt(111.4) + 3.5;
    return p;
  }

  applyPalette(p: Palette) {
    super.applyPalette(p);
    this.week.setColors(p.brand, p.idle);
    this.monument.setColors(p.brand, p.reward);
  }

  dispose() {
    super.dispose();
    this.revealAnim?.pause();
    this.week.dispose();
    this.monument.dispose();
  }
}
