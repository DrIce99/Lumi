// The 3D face: a VRM avatar standing in the face box, drawn with three.js on
// a transparent canvas that covers the window. It gets the same input as the
// two eyes (FaceView) and adds body gestures. Every frame composes, in order:
// - the resting pose (pose.ts: breathing, weight shift, the expression's
//   posture) on the normalized humanoid bones;
// - the gestures playing (built-in keyframes or the user's clips), each
//   blended over it with its fade weight (slerp per bone);
// - the gaze: the eyes through VRMLookAt, part of it on the head and neck;
// - expressions (eased weights), the blink and the lip sync from the voice;
// then vrm.update() runs the spring bones and the frame is drawn. The loop
// runs at 30 fps at rest and 60 while talking, gesturing or flying.
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMHumanBoneName } from "@pixiv/three-vrm";
import {
  AnimationClip,
  BoxGeometry,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  AmbientLight,
  Euler as ThreeEuler,
  PerspectiveCamera,
  Quaternion,
  QuaternionKeyframeTrack,
  Scene,
  SRGBColorSpace,
  Vector3,
  VectorKeyframeTrack,
  WebGLRenderer,
  Box3,
  type Interpolant,
  type Object3D,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { Expression } from "../../shared/emotions";
import type { AvatarConfig, FaceContrast, FaceGesture, FaceLayout, FaceState, GazeCommand, IdleCommand, IdleRoutine } from "../../shared/types";
import { Blinker } from "../face/blink";
import { effectiveExpression } from "../face/face";
import { GazeController, MAX_OFFSET_X, MAX_OFFSET_Y } from "../face/gaze";
import type { FaceView } from "../faceView";
import { loadClip } from "./clipFiles";
import { bodyFraming, bustSpan, CLOSEUP, closeupBlend, deskFraming, routineFace, type CameraParams } from "./framing";
import { avatarExpression, VISEMES, visemes, VRM_EMOTIONS, type AvatarExpression } from "./expressions3d";
import { clipWeight, GESTURES, HANDED, headFollow, idlePose, replacedWeight, mirrorGesture, sampleGesture, type BonePose, type Euler, type GestureDef } from "./pose";

/** Eyes turn up to this far (degrees) at the gaze's full offset; the head takes a share of it. */
/** The head turns up to this far (degrees) at the gaze's full offset, times its share (headFollow); the eyes use their own full range. */
const HEAD_YAW = 28;
const HEAD_PITCH = 22;
/** The head catches up with where the eyes look with this time constant (ms): the eyes jump, the head turns. */
const HEAD_TAU = 320;
/** Expression weights ease with this time constant (ms). */
const FACE_TAU = 110;
const TRANSIT_OUT_MS = 1100;
const TRANSIT_IN_MS = 1200;

interface Play {
  name: string;
  start: number;
  /** Replaced by a newer gesture at this time: it fades out (replacedWeight). */
  endAt?: number;
  /** Built-in keyframes, or a user clip. */
  def?: GestureDef;
  clip?: { duration: number; tracks: { bone: VRMHumanBoneName; kind: "q" | "p"; interpolant: Interpolant }[] };
}

type ClipData = NonNullable<Play["clip"]>;

/** An idle routine playing: enter, loop (repeated), exit; each part a clip, joined where they were cut. */
interface RoutinePlay {
  routine: IdleRoutine;
  clips: { enter: ClipData; loop: ClipData; exit: ClipData } | null;
  loopMs: number;
  dir: 1 | -1;
  /** When the enter started (once the clips are loaded). */
  start: number;
  phase: "enter" | "loop" | "exit" | "done";
  phaseStart: number;
  /** A natural end waits for the loop to come round to its first pose (= the exit's): no blend needed. */
  stopAt: number | null;
  /** An interruption: the pose it was in, frozen, blends into the exit. */
  cut: { clip: ClipData; time: number; at: number; ms: number } | null;
  doneAt: number | null;
  startled: boolean;
  walkSent: boolean;
}

/** Idle routines fade in and out over this long (ms). */
const ROUTINE_FADE_MS = 450;
/** The bones whose positions frame the whole body (lying, sitting, walking). */
const BODY_BONES: VRMHumanBoneName[] = ["head", "neck", "hips", "chest", "leftUpperArm", "rightUpperArm", "leftLowerArm", "rightLowerArm", "leftHand", "rightHand", "leftUpperLeg", "rightUpperLeg", "leftLowerLeg", "rightLowerLeg", "leftFoot", "rightFoot", "leftToes", "rightToes"];
const DESK_BONES: VRMHumanBoneName[] = ["leftLowerArm", "rightLowerArm", "leftHand", "rightHand"];

const DEG = Math.PI / 180;
const tmpQ = new Quaternion();
const tmpE = new ThreeEuler(0, 0, 0, "XYZ");

function quat(e: Euler, out = new Quaternion()): Quaternion {
  return out.setFromEuler(tmpE.set(e[0] * DEG, e[1] * DEG, e[2] * DEG, "XYZ"));
}

export class Avatar implements FaceView {
  private layout: FaceLayout;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(18, 0.5, 0.1, 20);
  private vrm: VRM | null = null;
  private modelUrl = "";
  private loading: Promise<void> | null = null;
  private clipUrls: Record<string, string> = {};
  private readonly clips = new Map<string, Promise<Play["clip"] | null>>();
  private nodeBone = new Map<string, VRMHumanBoneName>();
  /** The bust's vertical span (m): from the waist to just above the hair. */
  private bust = { bottom: 0.9, top: 1.6 };
  private restHips = new Vector3();

  private state: FaceState = { expression: "neutra", intensity: 0.6, listening: false, thinking: false, speaking: false, drowsy: false };
  private target: AvatarExpression = avatarExpression("neutra", 0.6);
  private readonly faces = new Map<string, number>();
  private posture = { head: [0, 0, 0] as Euler, lean: 0, shoulders: 0, lid: 0, energy: 1, tremble: 0 };
  private readonly blinker: Blinker;
  private readonly gaze: GazeController;
  private lastGazeDx = 0;
  private gazeKind: GazeCommand["kind"] = "idle";
  /** The gaze the head follows (-1..1 each), eased toward the eyes'. */
  private readonly headLook = { x: 0, y: 0 };
  private readonly follow = { yaw: 0.28, pitch: 0.28 };
  /** The speech level the head nods with: much slower than the mouth's. */
  private headTalk = 0;
  /** ms of resting motion so far (paused by a shock). */
  private idleClock = 0;
  /** VRoid's separate brow/eye/mouth morphs per emotion, when the model has them. */
  private split: SplitFaces | null = null;
  /** 0..1: how much Lumi is talking now (eased): the emotion's own mouth gives way to the vowels. */
  private speech = 0;
  private plays: Play[] = [];
  private level = 0;
  private bright = 0.4;
  private levelSource: (() => number) | null = null;
  private brightSource: (() => number) | null = null;
  private talking = false;
  private motion = { vx: 0, vy: 0 };
  private dip = Number.NEGATIVE_INFINITY;
  private glareUntil = 0;
  private glareSide = 0;
  private frozenUntil = 0;
  private transitPlay: { kind: "out" | "in"; start: number; target: { x: number; y: number } } | null = null;
  private raf = 0;
  private lastFrame = 0;
  private lastDraw = 0;
  private disposed = false;
  private readonly seed = Math.random() * 1000;
  private dpr = 1;
  /** Idle routines from the config, the one playing, and their clips (by URL). */
  private idleRoutines: Record<string, IdleRoutine> = {};
  private routine: RoutinePlay | null = null;
  private routineWeight = 0;
  private readonly clipCache = new Map<string, Promise<ClipData | null>>();
  /** A walk turns her in profile: the body's yaw (degrees), eased. */
  private turnYaw = 0;
  private sceneYaw = 0;
  /** The model's hips height at rest (m), to turn a walk's pace into pixels. */
  private hipsHeight = 0.9;
  /** The camera: the bust shot, and where a routine takes it (eased). */
  private baseCam: CameraParams = { x: 0, y: 1.25, d: 3, fov: 18 };
  private readonly cam = { w: 0, close: 0, box: null as { minX: number; maxX: number; minY: number; maxY: number } | null, deskY: null as number | null };
  private masked = true;
  private book: Group | null = null;
  private bookShow = 0;
  /** An idle walk's loop started: how fast the window must follow (DIP per second). */
  onWalkSpeed: ((pxPerSecond: number) => void) | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    layout: FaceLayout,
    private readonly onError: (err: unknown) => void = (err) => console.error("Avatar failed", err),
  ) {
    this.layout = layout;
    this.renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true, premultipliedAlpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = SRGBColorSpace;
    const light = new DirectionalLight(0xffffff, Math.PI * 0.9);
    light.position.set(0.6, 1.2, 1.5);
    this.scene.add(light, new AmbientLight(0xffffff, 0.6));
    const now = performance.now();
    this.blinker = new Blinker(now);
    this.gaze = new GazeController(now);
    this.gaze.onLargeSaccade = (t) => {
      if (Math.random() < 0.75) this.blinker.trigger(t);
    };
    canvas.hidden = false;
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Loads the model (again only when it changed) and remembers the user's clips. */
  setConfig(config: AvatarConfig): Promise<void> {
    this.clipUrls = config.clips;
    this.clips.clear();
    this.idleRoutines = config.idles ?? {};
    this.clipCache.clear();
    if (config.model === this.modelUrl && this.loading) return this.loading;
    this.modelUrl = config.model;
    this.loading = this.load(config.model).catch((err: unknown) => {
      this.onError(err);
      throw err;
    });
    return this.loading;
  }

  private async load(url: string): Promise<void> {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    if (this.disposed) return;
    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) throw new Error("not a VRM file");
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(vrm);
    vrm.scene.traverse((o: Object3D) => {
      o.frustumCulled = false;
    });
    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
    }
    this.vrm = vrm;
    this.scene.add(vrm.scene);
    this.sceneYaw = vrm.scene.rotation.y;
    // The eyes are driven by yaw and pitch, not by a target object
    if (vrm.lookAt) vrm.lookAt.autoUpdate = false;
    this.split = splitFaces(vrm.scene);
    this.nodeBone = new Map();
    for (const name of Object.keys(vrm.humanoid.humanBones) as VRMHumanBoneName[]) {
      const node = vrm.humanoid.getNormalizedBoneNode(name);
      if (node) this.nodeBone.set(node.name, name);
    }
    this.restHips.copy(vrm.humanoid.getNormalizedBoneNode("hips")?.position ?? new Vector3());
    vrm.scene.updateMatrixWorld(true);
    this.hipsHeight = Math.max(0.3, vrm.humanoid.getNormalizedBoneNode("hips")?.getWorldPosition(new Vector3()).y ?? 0.9);
    const box = new Box3().setFromObject(vrm.scene);
    const height = Math.max(0.5, box.max.y - Math.min(0, box.min.y));
    this.bust = bustSpan(height, vrm.humanoid.getNormalizedBoneNode("hips")?.getWorldPosition(new Vector3()).y ?? null);
    this.frameCamera();
    console.info(`Avatar loaded: ${height.toFixed(2)} m, bust ${this.bust.bottom.toFixed(2)}-${this.bust.top.toFixed(2)} m`);
  }

  // ---------------- FaceView ----------------

  setLayout(layout: FaceLayout): void {
    this.layout = layout;
    this.resize();
  }

  setState(state: FaceState): void {
    this.state = state;
    const expr: Expression = effectiveExpression(state);
    this.target = avatarExpression(expr, state.intensity);
    this.blinker.setRate((expr === "apatia" ? 0.5 : 1) * (state.speaking ? 1.35 : 1), performance.now());
    this.blinker.setSlowness(state.drowsy || expr === "sonno" ? 2.5 : 1);
  }

  setGaze(command: GazeCommand): void {
    if (command.target) this.lastGazeDx = command.target.dx;
    this.gazeKind = command.kind;
    this.gaze.setCommand(command, performance.now());
  }

  setContrast(_contrast: FaceContrast): void {
    // The avatar has its own shading: the eyes' adaptive outline doesn't apply
  }

  /** Eye gestures from main (backchannel nods, shocks...), done with the head and body. */
  gesture(kind: FaceGesture): void {
    const now = performance.now();
    if (kind === "nod") this.play("nod_small", now);
    else if (kind === "shake") this.play("shake_small", now);
    else if (kind === "bounce") this.play("hop", now);
    else if (kind === "land") this.dip = now;
    else if (kind === "freeze") {
      this.frozenUntil = now + 500;
      this.blinker.pause(now + 500);
    }
  }

  /** A body gesture chosen by the brain. */
  act(name: string): void {
    this.play(name, performance.now());
  }

  glare(lightDx: number): void {
    const now = performance.now();
    this.glareUntil = now + 1600;
    this.glareSide = Math.sign(lightDx) || 1;
  }

  travel(vx: number, vy: number, landed: boolean): void {
    this.motion = { vx: Math.max(-1, Math.min(1, vx)), vy: Math.max(-1, Math.min(1, vy)) };
    if (landed) {
      this.dip = performance.now();
      this.blinker.trigger(performance.now() + 120);
    }
  }

  transit(kind: "out" | "in", target: { x: number; y: number }, alreadyMs = 0): number {
    this.transitPlay = { kind, start: performance.now() - alreadyMs, target };
    return kind === "out" ? TRANSIT_OUT_MS : TRANSIT_IN_MS;
  }

  resetTransit(): void {
    this.transitPlay = null;
    this.canvas.style.transform = "";
    this.canvas.style.opacity = "";
  }

  sentenceStart(): void {
    // A sentence starts: a small lift of the head comes from the talk level
  }

  sentenceEnd(): void {
    if (Math.random() < 0.5) this.blinker.trigger(performance.now());
  }

  setLevelSource(source: (() => number) | null): void {
    this.levelSource = source;
  }

  /** Where the lip sync reads how bright the voice is (0..1), for the vowel shapes. */
  setBrightSource(source: (() => number) | null): void {
    this.brightSource = source;
  }

  setTalking(talking: boolean): void {
    this.talking = talking;
  }

  /** On the avatar's pixels (alpha read back from the last frame), with a margin. */
  hitTest(x: number, y: number, margin = 4): boolean {
    if (!this.vrm || this.transitPlay) return false;
    const gl = this.renderer.getContext();
    const d = this.dpr;
    const m = Math.max(1, Math.round(margin * d));
    const cx = Math.round(x * d);
    const cy = Math.round(this.canvas.height - y * d);
    const x0 = Math.max(0, cx - m);
    const y0 = Math.max(0, cy - m);
    const w = Math.min(this.canvas.width - x0, 2 * m + 1);
    const h = Math.min(this.canvas.height - y0, 2 * m + 1);
    if (w <= 0 || h <= 0) return false;
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 40) return true;
    return false;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    if (this.book) {
      this.scene.remove(this.book);
      this.book.traverse((o) => {
        const mesh = o as Mesh;
        if (mesh.isMesh) {
          mesh.geometry.dispose();
          (mesh.material as MeshStandardMaterial).dispose();
        }
      });
      this.book = null;
    }
    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
      this.vrm = null;
    }
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.hidden = true;
    this.canvas.style.transform = "";
    this.canvas.style.opacity = "";
  }

  // ---------------- gestures ----------------

  private play(name: string, now: number): void {
    const builtin = BUILTIN[name];
    if (this.clipUrls[name]) {
      void this.userClip(name).then((clip) => {
        if (clip) this.start({ name, start: performance.now(), clip });
        else if (builtin) this.start({ name, start: performance.now(), def: this.handed(name, builtin) });
      });
      return;
    }
    if (!builtin) {
      console.warn(`Unknown gesture: ${name}`);
      return;
    }
    this.start({ name, start: now, def: this.handed(name, builtin) });
  }

  private start(play: Play): void {
    // A gesture that restarts, or the oldest of three, fades out under the new one: dropping it would snap the pose
    const now = performance.now();
    const live = this.plays.filter((p) => p.endAt === undefined);
    for (const p of live) if (p.name === play.name) p.endAt = now;
    const still = live.filter((p) => p.endAt === undefined);
    if (still.length >= 2) still[0].endAt = now;
    this.plays = [...this.plays.filter((p) => replacedWeight(p.endAt, now) > 0), play];
  }

  /** One-handed gestures use the hand on the side of the screen's center (where Lumi looks, roughly). */
  private handed(name: string, def: GestureDef): GestureDef {
    if (!HANDED.has(name)) return def;
    // Right-handed by default (the viewer's left); mirror when the target is to the viewer's right
    return this.lastGazeDx > 0 ? mirrorGesture(def) : def;
  }

  private userClip(name: string): Promise<Play["clip"] | null> {
    let cached = this.clips.get(name);
    if (!cached) {
      const url = this.clipUrls[name];
      cached = url ? this.clipData(url, `Gesture clip ${name}`) : Promise.resolve(null);
      this.clips.set(name, cached);
    }
    return cached;
  }

  /** A clip file as tracks on this model's bones (cached by URL). */
  private clipData(url: string, label: string): Promise<ClipData | null> {
    let cached = this.clipCache.get(url);
    if (!cached) {
      cached = (async () => {
        await this.loading;
        const vrm = this.vrm;
        if (!vrm) return null;
        try {
          const clip: AnimationClip = await loadClip(url, vrm);
          const tracks: ClipData["tracks"] = [];
          for (const track of clip.tracks) {
            const [node, property] = track.name.split(".");
            const bone = this.nodeBone.get(node);
            if (!bone) continue;
            // createInterpolant is set on every track by setInterpolation(), but three's types don't list it
            const interpolant = (track as unknown as { createInterpolant(): Interpolant }).createInterpolant();
            if (track instanceof QuaternionKeyframeTrack && property === "quaternion") tracks.push({ bone, kind: "q", interpolant });
            else if (track instanceof VectorKeyframeTrack && property === "position" && bone === "hips") tracks.push({ bone, kind: "p", interpolant });
          }
          return { duration: clip.duration * 1000, tracks };
        } catch (err) {
          console.warn(`${label} failed to load: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      })();
      this.clipCache.set(url, cached);
    }
    return cached;
  }

  // ---------------- idle routines ----------------

  /** Starts a routine (once its three clips are loaded) or ends the one playing. */
  idle(command: IdleCommand): void {
    const now = performance.now();
    if ("stop" in command) {
      this.stopRoutine(now, command.startled);
      return;
    }
    const routine = this.idleRoutines[command.name];
    if (!routine || !this.vrm) return;
    const play: RoutinePlay = { routine, clips: null, loopMs: command.loopMs, dir: command.dir, start: 0, phase: "enter", phaseStart: 0, stopAt: null, cut: null, doneAt: null, startled: false, walkSent: false };
    this.routine = play;
    const label = `Idle routine ${routine.name}`;
    void Promise.all([this.clipData(routine.enter, label), this.clipData(routine.loop, label), this.clipData(routine.exit, label)]).then(([enter, loop, exit]) => {
      if (this.routine !== play) return;
      if (!enter || !loop || !exit) {
        this.routine = null;
        return;
      }
      play.clips = { enter, loop, exit };
      play.start = play.phaseStart = performance.now();
    });
  }

  private stopRoutine(now: number, startled: boolean): void {
    const r = this.routine;
    if (!r) return;
    if (!r.clips) {
      this.routine = null;
      return;
    }
    if (r.phase === "exit" || r.phase === "done") return;
    r.startled = startled;
    if (!startled && r.phase === "loop" && !r.routine.walkSpeed) {
      // A calm end: once the loop is back to its first pose, which is where the exit starts
      const d = r.clips.loop.duration;
      r.stopAt = r.phaseStart + Math.ceil((now - r.phaseStart) / d) * d;
      return;
    }
    // Interrupted (or a walk that arrived): from the pose it is in, blended into the exit
    const from = r.phase === "enter" ? r.clips.enter : r.clips.loop;
    r.cut = { clip: from, time: this.partTime(r, now), at: now, ms: startled ? 220 : 420 };
    r.phase = "exit";
    r.phaseStart = now;
  }

  /** Seconds into the part playing now. */
  private partTime(r: RoutinePlay, now: number): number {
    const c = r.clips!;
    const ms = now - r.phaseStart;
    if (r.phase === "enter") return Math.min(c.enter.duration, ms) / 1000;
    if (r.phase === "loop") return (((ms % c.loop.duration) + c.loop.duration) % c.loop.duration) / 1000;
    return Math.min(c.exit.duration, Math.max(0, ms)) / 1000;
  }

  /** Moves the routine along its parts; its weight (0..1), or 0 when none plays. */
  private advanceRoutine(now: number): number {
    const r = this.routine;
    if (!r?.clips) return 0;
    const c = r.clips;
    if (r.phase === "enter" && now - r.phaseStart >= c.enter.duration) {
      r.phaseStart += c.enter.duration;
      r.phase = "loop";
    }
    if (r.phase === "loop") {
      if (r.routine.walkSpeed && !r.walkSent) {
        r.walkSent = true;
        this.onWalkSpeed?.(r.routine.walkSpeed * this.hipsHeight * this.pxPerMeter());
      }
      // Its own end too, in case main's stop never comes
      if (r.stopAt === null && now - r.phaseStart >= r.loopMs) this.stopRoutine(now, false);
      if (r.phase === "loop" && r.stopAt !== null && now >= r.stopAt) {
        r.phase = "exit";
        r.phaseStart = r.stopAt;
      }
    }
    if (r.phase === "exit" && now - r.phaseStart >= c.exit.duration) {
      r.phase = "done";
      r.doneAt = r.phaseStart + c.exit.duration;
    }
    const fadeIn = Math.min(1, (now - r.start) / ROUTINE_FADE_MS);
    const fadeOut = r.doneAt === null ? 1 : 1 - (now - r.doneAt) / ROUTINE_FADE_MS;
    if (fadeOut <= 0) {
      this.routine = null;
      return 0;
    }
    return Math.max(0, Math.min(fadeIn, fadeOut));
  }

  /** The routine's pose now, slerped over `result` by its weight; returns its hips position (or null). */
  private applyRoutine(result: Map<VRMHumanBoneName, Quaternion>, now: number, weight: number): Vector3 | null {
    const r = this.routine;
    if (!r?.clips || weight <= 0) return null;
    const c = r.clips;
    const pose = new Map<VRMHumanBoneName, Quaternion>();
    const part = r.phase === "enter" ? c.enter : r.phase === "loop" ? c.loop : c.exit;
    let hips = this.sampleInto(part, r.phase === "done" ? c.exit.duration / 1000 : this.partTime(r, now), pose);
    if (r.cut && r.phase === "exit" && now - r.cut.at < r.cut.ms) {
      const from = new Map<VRMHumanBoneName, Quaternion>();
      const fromHips = this.sampleInto(r.cut.clip, r.cut.time, from);
      const u = (now - r.cut.at) / r.cut.ms;
      const k = u * u * (3 - 2 * u);
      for (const [bone, q] of from) {
        const to = pose.get(bone);
        if (to) pose.set(bone, q.clone().slerp(to, k));
      }
      if (fromHips && hips) hips = fromHips.lerp(hips, k);
    }
    for (const [bone, q] of pose) result.get(bone)?.slerp(q, weight);
    return hips ? this.restHips.clone().lerp(hips, weight) : null;
  }

  private sampleInto(clip: ClipData, time: number, out: Map<VRMHumanBoneName, Quaternion>): Vector3 | null {
    let hips: Vector3 | null = null;
    for (const track of clip.tracks) {
      const v = track.interpolant.evaluate(Math.min(clip.duration / 1000, Math.max(0, time)));
      if (track.kind === "q") out.set(track.bone, new Quaternion(v[0], v[1], v[2], v[3]));
      else hips = new Vector3(v[0], v[1], v[2]);
    }
    return hips;
  }

  /** Pixels per meter at the body's depth with the camera as it is now. */
  private pxPerMeter(): number {
    const f = this.layout.face;
    return f.height / (2 * Math.max(0.05, this.camera.position.z) * Math.tan((this.camera.fov * DEG) / 2));
  }

  /** The camera: the bust shot, or where the routine wants it (the whole body, the eyes up close, the desk). */
  private updateCamera(dt: number): void {
    const r = this.routine;
    const mode = r?.clips ? r.routine.camera : "bust";
    const ease = (tau: number) => 1 - Math.exp(-dt / tau);
    const humanoid = this.vrm?.humanoid;
    const world = (bone: VRMHumanBoneName) => humanoid?.getRawBoneNode(bone)?.getWorldPosition(new Vector3()) ?? null;
    const f = this.layout.face;
    const W = this.layout.windowWidth;
    const H = this.layout.windowHeight;
    const bustScale = f.height / (this.bust.top - this.bust.bottom);
    let target = this.baseCam;
    if (mode === "body" && humanoid) {
      const pts = BODY_BONES.map(world).filter((p): p is Vector3 => p !== null);
      if (pts.length) {
        // Margins for what the bones don't reach: the hair (long, past the head), the feet, the hands
        const m = 0.22;
        const box = { minX: Math.min(...pts.map((p) => p.x)) - m, maxX: Math.max(...pts.map((p) => p.x)) + m, minY: Math.min(...pts.map((p) => p.y)) - 0.05, maxY: Math.max(...pts.map((p) => p.y)) + 0.22 };
        const b = (this.cam.box ??= box);
        const k = ease(350);
        b.minX += (box.minX - b.minX) * k;
        b.maxX += (box.maxX - b.maxX) * k;
        b.minY += (box.minY - b.minY) * k;
        b.maxY += (box.maxY - b.maxY) * k;
        const region = this.layout.overlay === "above" ? { left: 10, right: W - 10, top: 10, bottom: f.y + f.height } : { left: 10, right: W - 10, top: f.y, bottom: H - 10 };
        target = bodyFraming(b, region, f, bustScale, this.baseCam.fov);
      }
    } else if (mode === "desk" && humanoid) {
      const pts = DESK_BONES.map(world).filter((p): p is Vector3 => p !== null);
      const head = world("head");
      if (pts.length && head) {
        const y = pts.reduce((a, p) => a + p.y, 0) / pts.length;
        this.cam.deskY = this.cam.deskY === null ? y : this.cam.deskY + (y - this.cam.deskY) * ease(500);
        target = deskFraming(this.cam.deskY, head.x, H - 3, f, bustScale, this.baseCam.fov);
      }
    }
    if (mode !== "body") this.cam.box = null;
    if (mode !== "desk") this.cam.deskY = null;
    const wanted = mode === "bust" || mode === "closeup" ? 0 : this.routineWeight;
    this.cam.w += (wanted - this.cam.w) * ease(600);
    const w = this.cam.w;
    const b = this.baseCam;
    const params: CameraParams = { x: b.x + (target.x - b.x) * w, y: b.y + (target.y - b.y) * w, d: b.d + (target.d - b.d) * w, fov: b.fov + (target.fov - b.fov) * w };
    // The close-up: in during the loop, out as soon as it ends
    const close = mode === "closeup" && r?.phase === "loop" && r.stopAt === null ? this.routineWeight : 0;
    this.cam.close += (close - this.cam.close) * ease(close > this.cam.close ? 900 : 350);
    const shot = closeupBlend(params, this.eyesPoint(), this.cam.close, this.faceForward());
    this.camera.position.set(shot.position[0], shot.position[1], shot.position[2]);
    this.camera.lookAt(shot.look[0], shot.look[1], shot.look[2]);
    this.camera.fov = shot.fov;
    // Up close the near plane cuts the fringe hanging between the lens and the eye
    this.camera.near = this.cam.close > 0.02 ? Math.max(0.005, CLOSEUP.near * this.cam.close ** 2) : 0.1;
    this.camera.updateProjectionMatrix();
    // The bust's fade at the bottom only for the bust shot: lying, at the screen's edge or up close it would cut her
    const masked = w < 0.05 && this.cam.close < 0.05;
    if (masked !== this.masked) {
      this.masked = masked;
      this.applyMask();
    }
  }

  /** Where the face looks (world): the head's normalized +Z. */
  private faceForward(): [number, number, number] {
    const head = this.vrm?.humanoid.getNormalizedBoneNode("head");
    if (!head) return [0, 0, 1];
    const v = new Vector3(0, 0, 1).applyQuaternion(head.getWorldQuaternion(new Quaternion()));
    return [v.x, v.y, v.z];
  }

  /** The eye the close-up goes to (world); null without a model. */
  private eyesPoint(): [number, number, number] | null {
    const humanoid = this.vrm?.humanoid;
    if (!humanoid) return null;
    // One eye (hers left, on the viewer's right): in the meme one eye fills the lens
    const eye = humanoid.getRawBoneNode("leftEye")?.getWorldPosition(new Vector3()) ?? humanoid.getRawBoneNode("rightEye")?.getWorldPosition(new Vector3());
    if (eye) return [eye.x, eye.y, eye.z];
    const head = humanoid.getRawBoneNode("head")?.getWorldPosition(new Vector3());
    return head ? [head.x, head.y + 0.06, head.z + 0.08] : null;
  }

  /** A book between her hands, its pages toward her face (the reading routine). */
  private updateBook(dt: number): void {
    const r = this.routine;
    const want = r?.clips && r.routine.prop === "book" && r.phase === "loop" ? 1 : 0;
    this.bookShow += (want - this.bookShow) * (1 - Math.exp(-dt / 250));
    const humanoid = this.vrm?.humanoid;
    if (this.bookShow < 0.02 || !humanoid) {
      if (this.book) this.book.visible = false;
      return;
    }
    const book = (this.book ??= makeBook());
    if (!book.parent) this.scene.add(book);
    const l = humanoid.getRawBoneNode("leftHand")?.getWorldPosition(new Vector3());
    const rh = humanoid.getRawBoneNode("rightHand")?.getWorldPosition(new Vector3());
    const head = humanoid.getRawBoneNode("head")?.getWorldPosition(new Vector3());
    if (!l || !rh || !head) return;
    const mid = l.clone().add(rh).multiplyScalar(0.5);
    const n = head.clone().sub(mid).normalize();
    const across = rh.clone().sub(l);
    across.sub(n.clone().multiplyScalar(across.dot(n)));
    if (across.lengthSq() < 1e-6) across.set(1, 0, 0);
    across.normalize();
    const up = new Vector3().crossVectors(n, across);
    book.matrixAutoUpdate = false;
    book.matrix.makeBasis(across, up, n).setPosition(mid.addScaledVector(n, 0.03));
    book.matrix.scale(new Vector3(this.bookShow, this.bookShow, this.bookShow));
    book.matrixWorldNeedsUpdate = true;
    book.visible = true;
  }

  // ---------------- frame ----------------

  private frame = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const now = performance.now();
    // 60 fps when something moves fast, 30 otherwise
    const busy = this.talking || this.state.speaking || this.plays.length > 0 || this.routine !== null || this.transitPlay !== null || Math.abs(this.motion.vx) + Math.abs(this.motion.vy) > 0.01;
    if (now - this.lastDraw < (busy ? 15 : 31)) return;
    this.lastDraw = now;
    const dt = this.lastFrame ? Math.min(100, now - this.lastFrame) : 16;
    this.lastFrame = now;
    try {
      this.update(now, dt);
    } catch (err) {
      console.error("Avatar frame failed", err);
    }
  };

  private update(now: number, dt: number): void {
    this.blinker.update(now);
    this.gaze.update(now);
    this.updateLevel(dt);
    this.ease(dt);
    const vrm = this.vrm;
    if (vrm) {
      this.routineWeight = this.advanceRoutine(now);
      this.pose(vrm, now, dt);
      this.expressions(vrm, now, dt);
      // A long frame (the PC stalled) in one step makes the spring bones (hair, clothes) jump: split it
      const steps = Math.ceil(dt / 34);
      for (let i = 0; i < steps; i++) vrm.update(dt / steps / 1000);
      this.splitFaces();
      this.updateBook(dt);
    }
    this.updateCamera(dt);
    this.updateTransit(now);
    this.renderer.render(this.scene, this.camera);
  }

  private updateLevel(dt: number): void {
    const speaking = this.talking || this.state.speaking;
    const raw = speaking && this.levelSource ? Math.min(1, this.levelSource() / 0.12) : 0;
    const tau = raw > this.level ? 25 : 70;
    this.level += (raw - this.level) * (1 - Math.exp(-dt / tau));
    if (speaking && this.brightSource) this.bright += (this.brightSource() - this.bright) * (1 - Math.exp(-dt / 60));
  }

  /** Posture and face weights ease toward the expression's targets. */
  private ease(dt: number): void {
    const a = 1 - Math.exp(-dt / FACE_TAU);
    const b = 1 - Math.exp(-dt / 260);
    const t = this.target;
    const p = this.posture;
    for (let i = 0; i < 3; i++) p.head[i] += (t.head[i] - p.head[i]) * b;
    p.lean += (t.lean - p.lean) * b;
    p.shoulders += (t.shoulders - p.shoulders) * b;
    p.lid += (t.lid - p.lid) * a;
    p.energy += (t.energy - p.energy) * b;
    p.tremble += ((t.tremble ?? 0) - p.tremble) * b;
    for (const name of VRM_EMOTIONS) {
      const cur = this.faces.get(name) ?? 0;
      this.faces.set(name, cur + ((t.faces[name] ?? 0) - cur) * a);
    }
  }

  private pose(vrm: VRM, now: number, dt: number): void {
    const humanoid = vrm.humanoid;
    const frozen = now < this.frozenUntil;
    // The resting motion has its own clock: a shock pauses it, and it resumes where it stopped
    if (!frozen) this.idleClock += dt;
    this.headTalk += (this.level - this.headTalk) * (1 - Math.exp(-dt / 220));
    const look = this.gaze.output(now);
    const gx = Math.max(-1, Math.min(1, look.x / MAX_OFFSET_X));
    const gy = Math.max(-1, Math.min(1, look.y / MAX_OFFSET_Y));
    const glare = now < this.glareUntil ? Math.sin(((this.glareUntil - now) / 1600) * Math.PI) : 0;
    const p = this.posture;
    const idle = idlePose({
      t: this.idleClock,
      energy: p.energy,
      head: [p.head[0], p.head[1] - this.glareSide * 18 * glare, p.head[2]],
      lean: p.lean,
      shoulders: p.shoulders + (frozen ? 8 : 0),
      talk: this.headTalk,
      tremble: p.tremble,
      travel: this.motion,
      seed: this.seed,
    });

    // Every bone back to the resting pose (or its rest) first: clips may have moved any of them
    const result = new Map<VRMHumanBoneName, Quaternion>();
    for (const name of Object.keys(humanoid.humanBones) as VRMHumanBoneName[]) {
      const e = idle.bones[name];
      result.set(name, e ? quat(e) : new Quaternion());
    }
    let hipsY = idle.hipsY ?? 0;
    let hipsPos: Vector3 | null = null;
    // An idle routine replaces the resting pose (its bones; the fingers it leaves out keep living)
    const routineHips = this.applyRoutine(result, now, this.routineWeight);
    if (routineHips) hipsPos = routineHips;

    // Gestures over it, oldest first
    this.plays = this.plays.filter((play) => {
      const ms = now - play.start;
      const left = replacedWeight(play.endAt, now);
      if (left <= 0) return false;
      if (play.def) {
        const s = sampleGesture(play.def, ms);
        if (!s) return false;
        this.blend(result, s.pose, s.weight * left);
        if (s.pose.hipsY !== undefined) hipsY += s.pose.hipsY * s.weight * left;
        return true;
      }
      const clip = play.clip!;
      const w = clipWeight(clip.duration, ms) * left;
      if (ms > clip.duration) return false;
      const time = Math.min(clip.duration, ms) / 1000;
      for (const track of clip.tracks) {
        const v = track.interpolant.evaluate(time);
        if (track.kind === "q") {
          const cur = result.get(track.bone);
          if (cur) cur.slerp(tmpQ.set(v[0], v[1], v[2], v[3]), w);
        } else {
          hipsPos = (hipsPos ?? this.restHips.clone()).lerp(new Vector3(v[0], v[1], v[2]), w);
        }
      }
      return true;
    });

    // The gaze: the eyes go there at once and all the way (VRMLookAt maps its input range, 90 degrees
    // on VRoid models, onto the eyes' few degrees); the head follows part of it, more slowly, and more
    // when the target is up (headFollow). Its pitch + = up.
    const ease = 1 - Math.exp(-dt / HEAD_TAU);
    this.headLook.x += (gx - this.headLook.x) * ease;
    this.headLook.y += (gy - this.headLook.y) * ease;
    const reading = this.gazeKind === "reading" || this.gazeKind === "caret" || this.gazeKind === "text";
    // The head's share changes smoothly too (reading -> mouse used to snap the head by a few degrees)
    const target = headFollow(this.headLook.y, reading);
    this.follow.yaw += (target.yaw - this.follow.yaw) * ease;
    this.follow.pitch += (target.pitch - this.follow.pitch) * ease;
    const follow = this.follow;
    const still = 1 - 0.85 * this.routineWeight;
    const yaw = this.headLook.x * HEAD_YAW * follow.yaw * still;
    const pitch = -this.headLook.y * HEAD_PITCH * follow.pitch * still;
    const head = result.get("head");
    const neck = result.get("neck");
    if (head) head.multiply(quat([-pitch * 0.6, yaw * 0.6, 0], tmpQ));
    if (neck) neck.multiply(quat([-pitch * 0.4, yaw * 0.4, 0], tmpQ));
    // Up close she looks into the lens (the clip peers down at something: her fringe would cover the eye)
    if (this.cam.close > 0.01) this.faceTheLens(vrm, result, this.cam.close);
    if (vrm.lookAt) {
      const range = eyeRange(vrm);
      vrm.lookAt.yaw = gx * range.yaw;
      // VRMLookAt's pitch grows downward on the eyes (checked on the model): gaze y is + down too
      // (a head raised toward a high target leaves the eyes less to do)
      vrm.lookAt.pitch = gy * range.pitch * (gy < 0 ? 1 - 0.35 * Math.min(1, -this.headLook.y) : 1);
    }

    for (const [name, q] of result) humanoid.getNormalizedBoneNode(name)?.quaternion.copy(q);
    const hips = humanoid.getNormalizedBoneNode("hips");
    if (hips) {
      // Landing after a flight: a quick dip of the knees
      const sinceDip = now - this.dip;
      const dip = sinceDip >= 0 && sinceDip < 360 ? -0.03 * Math.sin((sinceDip / 360) * Math.PI) : 0;
      hips.position.copy(hipsPos ?? this.restHips);
      hips.position.y += hipsY + dip;
    }
    const r = this.routine;
    const turnTo = r?.clips && r.routine.walkSpeed && r.phase !== "done" ? r.dir * 90 : 0;
    this.turnYaw += (turnTo - this.turnYaw) * (1 - Math.exp(-dt / 280));
    vrm.scene.rotation.y = this.sceneYaw + this.turnYaw * DEG;
  }

  /**
   * Turns the neck (half) and the head (the rest) so the face looks along +Z,
   * at the camera, by `k`. Works on the normalized local rotations: with
   * identity rest poses a bone's world rotation is the product down its chain.
   */
  private faceTheLens(vrm: VRM, result: Map<VRMHumanBoneName, Quaternion>, k: number): void {
    const chain = (["hips", "spine", "chest", "upperChest", "neck", "head"] as VRMHumanBoneName[]).filter((b) => result.has(b));
    const worldOf = (upTo: VRMHumanBoneName, inclusive: boolean) => {
      const q = vrm.scene.quaternion.clone();
      for (const b of chain) {
        if (b === upTo && !inclusive) break;
        q.multiply(result.get(b)!);
        if (b === upTo) break;
      }
      return q;
    };
    const lens = new Vector3(0, 0, 1);
    for (const [bone, share] of [["neck", 0.5], ["head", 1]] as const) {
      const local = result.get(bone);
      if (!local) continue;
      const forward = new Vector3(0, 0, 1).applyQuaternion(worldOf(bone, true));
      const turn = new Quaternion().slerp(new Quaternion().setFromUnitVectors(forward, lens), share * Math.min(1, k));
      const parent = worldOf(bone, false);
      // In the parent's frame: local' = parent^-1 * turn * parent * local
      local.copy(parent.clone().invert().multiply(turn).multiply(parent).multiply(local));
    }
  }

  /** Slerps the bones a pose names toward it, by `weight`. */
  private blend(result: Map<VRMHumanBoneName, Quaternion>, pose: BonePose, weight: number): void {
    if (weight <= 0) return;
    for (const [name, e] of Object.entries(pose.bones)) {
      const cur = result.get(name as VRMHumanBoneName);
      if (cur && e) cur.slerp(quat(e, tmpQ), weight);
    }
  }

  private expressions(vrm: VRM, now: number, dt: number): void {
    const em = vrm.expressionManager;
    if (!em) return;
    const talking = this.talking || this.state.speaking ? 1 : 0;
    this.speech += (talking - this.speech) * (1 - Math.exp(-dt / 150));
    if (this.split) {
      // Brows and eyes carry the emotion (splitFaces, after vrm.update): the presets stay off
      for (const name of VRM_EMOTIONS) em.setValue(name, 0);
    } else {
      // A whole-face preset also opens the mouth: it fades while talking
      for (const name of VRM_EMOTIONS) em.setValue(name, (this.faces.get(name) ?? 0) * (1 - 0.7 * this.speech));
    }
    const glare = now < this.glareUntil ? Math.sin(((this.glareUntil - now) / 1600) * Math.PI) : 0;
    // A happy face already narrows the eyes: the blink adds less on top of it
    const happy = this.faces.get("happy") ?? 0;
    const r = this.routine;
    const own = r?.clips ? routineFace(r.phase, now - r.phaseStart, r.startled) * this.routineWeight : 0;
    const shut = r && own > 0 ? (r.routine.face.eyes === "closed" ? own : r.routine.face.eyes === "sleepy" ? 0.6 * own : 0) : 0;
    const blink = Math.max(this.blinker.closure(now), this.posture.lid, glare * 0.7, shut);
    em.setValue("blink", Math.min(1, blink * (1 - 0.5 * happy * (1 - shut))));
    const mouth = visemes(this.level, this.bright, now);
    if (r && own > 0) mouth.aa = Math.max(mouth.aa, r.routine.face.mouth * own);
    // Emotions with their own mouth (a wide smile) leave less room to the vowels
    for (const v of VISEMES) em.setValue(v, mouth[v]);
  }

  /** The split emotion morphs, written after vrm.update() (no VRM expression binds them). Their mouth shows only at rest, softer. */
  private splitFaces(): void {
    const split = this.split;
    if (!split) return;
    const mouthShare = 0.5 * (1 - this.speech);
    for (const name of VRM_EMOTIONS) {
      const w = this.faces.get(name) ?? 0;
      for (const t of split[name].upper) t.mesh.morphTargetInfluences![t.index] = w;
      for (const t of split[name].mouth) t.mesh.morphTargetInfluences![t.index] = w * mouthShare;
    }
  }

  private updateTransit(now: number): void {
    const play = this.transitPlay;
    if (!play) return;
    const ms = now - play.start;
    const total = play.kind === "out" ? TRANSIT_OUT_MS : TRANSIT_IN_MS;
    const u = Math.min(1, ms / total);
    // Shrinks into the point (out) or grows from it (in)
    const k = play.kind === "out" ? 1 - u * u : 1 - (1 - u) * (1 - u);
    this.canvas.style.transformOrigin = `${play.target.x}px ${play.target.y}px`;
    this.canvas.style.transform = `scale(${Math.max(0.001, k)})`;
    this.canvas.style.opacity = String(Math.min(1, k * 1.5));
    if (u >= 1 && play.kind === "in") this.resetTransit();
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    const { windowWidth, windowHeight } = this.layout;
    this.canvas.style.width = `${windowWidth}px`;
    this.canvas.style.height = `${windowHeight}px`;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(windowWidth, windowHeight, false);
    this.frameCamera();
  }

  /**
   * A half-length shot: the bust fills the face box. The camera's view is
   * offset so the box sits where the layout puts it; the canvas covers the
   * window, so a raised arm still shows above and beside the box, while
   * below it the body fades out (a CSS mask: below the box there may be
   * the bubble's room).
   */
  private frameCamera(): void {
    const f = this.layout.face;
    const h = this.bust.top - this.bust.bottom;
    const center = (this.bust.top + this.bust.bottom) / 2;
    const fov = this.camera.fov * DEG;
    const distance = h / (2 * Math.tan(fov / 2));
    this.baseCam = { x: 0, y: center, d: distance, fov: this.baseCam.fov };
    this.camera.aspect = f.width / f.height;
    this.camera.position.set(0, center, distance);
    this.camera.lookAt(0, center, 0);
    this.camera.setViewOffset(f.width, f.height, -f.x, -f.y, this.layout.windowWidth, this.layout.windowHeight);
    this.camera.updateProjectionMatrix();
    this.applyMask();
  }

  /** The bust shot fades out below the face box (the bubble may sit there); other shots show everything. */
  private applyMask(): void {
    const f = this.layout.face;
    const bottom = f.y + f.height;
    const fade = Math.round(f.height * 0.14);
    const mask = this.masked ? `linear-gradient(to bottom, #000 ${bottom - fade}px, transparent ${bottom}px)` : "none";
    this.canvas.style.maskImage = mask;
    this.canvas.style.setProperty("-webkit-mask-image", mask);
  }
}

/** The brain's gestures plus the small head moves for the eyes' own gestures. */
const BUILTIN: Record<string, GestureDef> = {
  ...GESTURES,
  nod_small: { ...GESTURES.nod, ms: 600, keys: GESTURES.nod.keys.map((key) => ({ t: key.t, pose: { bones: Object.fromEntries(Object.entries(key.pose.bones).map(([n, e]) => [n, e!.map((x) => x * 0.5) as Euler])) } })) },
  shake_small: { ...GESTURES.shake_head, ms: 700, keys: GESTURES.shake_head.keys.map((key) => ({ t: key.t, pose: { bones: Object.fromEntries(Object.entries(key.pose.bones).map(([n, e]) => [n, e!.map((x) => x * 0.5) as Euler])) } })) },
};

type MorphRef = { mesh: Mesh; index: number };
type SplitFaces = Record<(typeof VRM_EMOTIONS)[number], { upper: MorphRef[]; mouth: MorphRef[] }>;

/** VRoid's morph names per emotion: Fcl_BRW_Joy, Fcl_EYE_Joy... */
const VROID_NAMES: Record<(typeof VRM_EMOTIONS)[number], string> = { happy: "Joy", angry: "Angry", sad: "Sorrow", relaxed: "Fun", surprised: "Surprised" };
/** ...and the mouth: a happy face smiles with the mouth closed ("Joy" opens it wide). */
const VROID_MOUTH: Record<(typeof VRM_EMOTIONS)[number], string> = { ...VROID_NAMES, happy: "Fun" };

/**
 * The emotions split into brows+eyes and mouth, when the model has VRoid's
 * separate morphs: its VRM presets use Fcl_ALL_*, which open the mouth too
 * (a smile with the mouth open while talking). Null for other models.
 */
function splitFaces(root: Object3D): SplitFaces | null {
  const out = Object.fromEntries(VRM_EMOTIONS.map((e) => [e, { upper: [] as MorphRef[], mouth: [] as MorphRef[] }])) as SplitFaces;
  let found = 0;
  root.traverse((o) => {
    const mesh = o as Mesh;
    const dict = mesh.isMesh ? mesh.morphTargetDictionary : undefined;
    if (!dict || !mesh.morphTargetInfluences) return;
    for (const e of VRM_EMOTIONS) {
      const n = VROID_NAMES[e];
      for (const part of ["BRW", "EYE"]) {
        const index = dict[`Fcl_${part}_${n}`];
        if (index !== undefined) {
          out[e].upper.push({ mesh, index });
          found++;
        }
      }
      const mouth = dict[`Fcl_MTH_${VROID_MOUTH[e]}`];
      if (mouth !== undefined) out[e].mouth.push({ mesh, index: mouth });
    }
  });
  return found >= 5 ? out : null;
}

/** The input angles that move the eyes to the end of their range (VRMLookAt's range maps), default 90. */
function eyeRange(vrm: VRM): { yaw: number; pitch: number } {
  const applier = vrm.lookAt?.applier as unknown as { rangeMapHorizontalOuter?: { inputMaxValue: number }; rangeMapVerticalUp?: { inputMaxValue: number } } | undefined;
  return { yaw: applier?.rangeMapHorizontalOuter?.inputMaxValue ?? 90, pitch: applier?.rangeMapVerticalUp?.inputMaxValue ?? 90 };
}

/** Registered for the face window, which loads this bundle only in 3D mode. */
export interface AvatarModule {
  Avatar: typeof Avatar;
}

/** A closed-looking book: a dark cover and a block of pages on the side toward +Z (the reader). */
function makeBook(): Group {
  const group = new Group();
  const cover = new Mesh(new BoxGeometry(0.17, 0.23, 0.02), new MeshStandardMaterial({ color: 0x7a2e3a, roughness: 0.75 }));
  const pages = new Mesh(new BoxGeometry(0.155, 0.215, 0.022), new MeshStandardMaterial({ color: 0xf1e9d6, roughness: 0.95 }));
  pages.position.z = 0.012;
  group.add(cover, pages);
  group.visible = false;
  return group;
}
