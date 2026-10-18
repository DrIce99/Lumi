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
  DirectionalLight,
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
import type { AvatarConfig, FaceContrast, FaceGesture, FaceLayout, FaceState, GazeCommand } from "../../shared/types";
import { Blinker } from "../face/blink";
import { effectiveExpression } from "../face/face";
import { GazeController, MAX_OFFSET_X, MAX_OFFSET_Y } from "../face/gaze";
import type { FaceView } from "../faceView";
import { loadClip } from "./clipFiles";
import { bustSpan } from "./framing";
import { avatarExpression, VISEMES, visemes, VRM_EMOTIONS, type AvatarExpression } from "./expressions3d";
import { clipWeight, GESTURES, HANDED, idlePose, mirrorGesture, sampleGesture, type BonePose, type Euler, type GestureDef } from "./pose";

/** Eyes turn up to this far (degrees) at the gaze's full offset; the head takes a share of it. */
const GAZE_YAW = 28;
const GAZE_PITCH = 18;
const HEAD_SHARE = 0.4;
/** Expression weights ease with this time constant (ms). */
const FACE_TAU = 110;
const TRANSIT_OUT_MS = 1100;
const TRANSIT_IN_MS = 1200;

interface Play {
  name: string;
  start: number;
  /** Built-in keyframes, or a user clip. */
  def?: GestureDef;
  clip?: { duration: number; tracks: { bone: VRMHumanBoneName; kind: "q" | "p"; interpolant: Interpolant }[] };
}

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
    // The eyes are driven by yaw and pitch, not by a target object
    if (vrm.lookAt) vrm.lookAt.autoUpdate = false;
    this.nodeBone = new Map();
    for (const name of Object.keys(vrm.humanoid.humanBones) as VRMHumanBoneName[]) {
      const node = vrm.humanoid.getNormalizedBoneNode(name);
      if (node) this.nodeBone.set(node.name, name);
    }
    this.restHips.copy(vrm.humanoid.getNormalizedBoneNode("hips")?.position ?? new Vector3());
    vrm.scene.updateMatrixWorld(true);
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
    // The same gesture restarts; at most two play at once (the old one fades under the new)
    this.plays = [...this.plays.filter((p) => p.name !== play.name).slice(-1), play];
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
      cached = (async () => {
        await this.loading;
        const vrm = this.vrm;
        if (!vrm || !url) return null;
        try {
          const clip: AnimationClip = await loadClip(url, vrm);
          const tracks: NonNullable<Play["clip"]>["tracks"] = [];
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
          console.warn(`Gesture clip ${name} failed to load: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      })();
      this.clips.set(name, cached);
    }
    return cached;
  }

  // ---------------- frame ----------------

  private frame = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const now = performance.now();
    // 60 fps when something moves fast, 30 otherwise
    const busy = this.talking || this.state.speaking || this.plays.length > 0 || this.transitPlay !== null || Math.abs(this.motion.vx) + Math.abs(this.motion.vy) > 0.01;
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
      this.pose(vrm, now);
      this.expressions(vrm, now);
      vrm.update(dt / 1000);
    }
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

  private pose(vrm: VRM, now: number): void {
    const humanoid = vrm.humanoid;
    const frozen = now < this.frozenUntil;
    const look = this.gaze.output(now);
    const gx = Math.max(-1, Math.min(1, look.x / MAX_OFFSET_X));
    const gy = Math.max(-1, Math.min(1, look.y / MAX_OFFSET_Y));
    const glare = now < this.glareUntil ? Math.sin(((this.glareUntil - now) / 1600) * Math.PI) : 0;
    const p = this.posture;
    const idle = idlePose({
      t: frozen ? this.frozenUntil : now,
      energy: p.energy,
      head: [p.head[0], p.head[1] - this.glareSide * 18 * glare, p.head[2]],
      lean: p.lean,
      shoulders: p.shoulders + (frozen ? 8 : 0),
      talk: this.level,
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

    // Gestures over it, oldest first
    this.plays = this.plays.filter((play) => {
      const ms = now - play.start;
      if (play.def) {
        const s = sampleGesture(play.def, ms);
        if (!s) return false;
        this.blend(result, s.pose, s.weight);
        if (s.pose.hipsY !== undefined) hipsY += s.pose.hipsY * s.weight;
        return true;
      }
      const clip = play.clip!;
      const w = clipWeight(clip.duration, ms);
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

    // The gaze: part on the neck and head, the rest to the eyes
    const yaw = gx * GAZE_YAW;
    const pitch = -gy * GAZE_PITCH;
    const head = result.get("head");
    const neck = result.get("neck");
    if (head) head.multiply(quat([-pitch * HEAD_SHARE * 0.6, yaw * HEAD_SHARE * 0.6, 0], tmpQ));
    if (neck) neck.multiply(quat([-pitch * HEAD_SHARE * 0.4, yaw * HEAD_SHARE * 0.4, 0], tmpQ));
    if (vrm.lookAt) {
      vrm.lookAt.yaw = yaw * (1 - HEAD_SHARE);
      vrm.lookAt.pitch = pitch * (1 - HEAD_SHARE);
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
  }

  /** Slerps the bones a pose names toward it, by `weight`. */
  private blend(result: Map<VRMHumanBoneName, Quaternion>, pose: BonePose, weight: number): void {
    if (weight <= 0) return;
    for (const [name, e] of Object.entries(pose.bones)) {
      const cur = result.get(name as VRMHumanBoneName);
      if (cur && e) cur.slerp(quat(e, tmpQ), weight);
    }
  }

  private expressions(vrm: VRM, now: number): void {
    const em = vrm.expressionManager;
    if (!em) return;
    for (const name of VRM_EMOTIONS) em.setValue(name, this.faces.get(name) ?? 0);
    const glare = now < this.glareUntil ? Math.sin(((this.glareUntil - now) / 1600) * Math.PI) : 0;
    // A happy face already narrows the eyes: the blink adds less on top of it
    const happy = this.faces.get("happy") ?? 0;
    const blink = Math.max(this.blinker.closure(now), this.posture.lid, glare * 0.7);
    em.setValue("blink", Math.min(1, blink * (1 - 0.5 * happy)));
    const mouth = visemes(this.level, this.bright, now);
    // Emotions with their own mouth (a wide smile) leave less room to the vowels
    const room = 1 - 0.4 * Math.max(happy, this.faces.get("surprised") ?? 0);
    for (const v of VISEMES) em.setValue(v, mouth[v] * room);
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
    this.camera.aspect = f.width / f.height;
    this.camera.position.set(0, center, distance);
    this.camera.lookAt(0, center, 0);
    this.camera.setViewOffset(f.width, f.height, -f.x, -f.y, this.layout.windowWidth, this.layout.windowHeight);
    this.camera.updateProjectionMatrix();
    const bottom = f.y + f.height;
    const fade = Math.round(f.height * 0.14);
    const mask = `linear-gradient(to bottom, #000 ${bottom - fade}px, transparent ${bottom}px)`;
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

/** Registered for the face window, which loads this bundle only in 3D mode. */
export interface AvatarModule {
  Avatar: typeof Avatar;
}
