// The 3D mode: arm poses from directions, gestures (keyframes, fades,
// mirroring), the avatar's expressions and lip sync, the gesture names in
// say calls and clip files, the face box per mode, the app:// mounts for the
// user's model and clips, and the prompt's body section.
import assert from "node:assert/strict";
import { join, normalize } from "node:path";
import test from "node:test";
import { liveSayFrom } from "../src/main/brain/providers/text";
import { buildSystemPrompt } from "../src/main/brain/prompt";
import { parseToolCall } from "../src/main/brain/tools";
import { clampAnchor, computeLayout } from "../src/main/layout";
import { muteConsole } from "../src/main/log";
import { resolveAppPath } from "../src/main/protocol";
import { sanitizeSettings } from "../src/main/settings";
import { VoiceSpeech, type VoiceOutput } from "../src/main/voice/speechOut";
import { avatarExpression, visemes } from "../src/renderer/avatar/expressions3d";
import { bustSpan } from "../src/renderer/avatar/framing";
import { arm, fromEuler, fromUnitVectors, GESTURES, idlePose, mirrorPose, qmul, rotate, sampleGesture, toEuler, type Euler } from "../src/renderer/avatar/pose";
import { BODY_GESTURES, clipName, EYE_GESTURE, gestureId, GESTURE_HINT } from "../src/shared/gestures";
import { DEFAULT_SETTINGS, FACE_BOX } from "../src/shared/types";

muteConsole();

const close = (a: number[], b: number[], eps = 1e-3) => a.every((x, i) => Math.abs(x - b[i]) < eps);
const unit = (v: [number, number, number]): [number, number, number] => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};

test("quaternions: Euler XYZ round trip and the shortest rotation between two directions", () => {
  for (const e of [[10, 20, 30], [-45, 5, 80], [0, -60, 0], [90, 0, -30]] as Euler[]) assert.ok(close(toEuler(fromEuler(e)), e, 1e-6), String(e));
  const q = fromUnitVectors([1, 0, 0], [0, -1, 0]);
  assert.ok(close(rotate(q, [1, 0, 0]), [0, -1, 0]));
  // Opposite vectors still give a valid half turn
  assert.ok(close(rotate(fromUnitVectors([1, 0, 0], [-1, 0, 0]), [1, 0, 0]), [-1, 0, 0]));
});

test("an arm posed by directions points its upper arm and forearm where asked", () => {
  const upper: [number, number, number] = [-0.12, -0.72, 0.68];
  const lower: [number, number, number] = [0.42, 0.86, 0.28];
  const bones = arm("right", upper, lower);
  const qu = fromEuler(bones.rightUpperArm!);
  const ql = fromEuler(bones.rightLowerArm!);
  assert.ok(close(rotate(qu, [-1, 0, 0]), unit(upper)), "upper arm");
  // The forearm's rotation is local to the upper arm: compose to get its world direction
  assert.ok(close(rotate(qmul(qu, ql), [-1, 0, 0]), unit(lower)), "forearm");
  const left = arm("left", [0.3, -0.9, 0.1], [0.1, -0.9, 0.4]);
  assert.ok(close(rotate(fromEuler(left.leftUpperArm!), [1, 0, 0]), unit([0.3, -0.9, 0.1])));
});

test("the resting pose breathes and keeps the arms down; flying leans the body", () => {
  const input = { t: 0, energy: 1, head: [0, 0, 0] as Euler, lean: 0, shoulders: 0, talk: 0, tremble: 0, travel: { vx: 0, vy: 0 }, seed: 3 };
  const a = idlePose(input);
  const b = idlePose({ ...input, t: 1050 });
  assert.notDeepEqual(a.bones.chest, b.bones.chest, "the chest moves with the breath");
  const upper = rotate(fromEuler(a.bones.rightUpperArm!), [-1, 0, 0]);
  assert.ok(upper[1] < -0.85, `the right arm hangs down: ${upper}`);
  const flying = idlePose({ ...input, travel: { vx: 1, vy: 0 } });
  assert.ok(flying.bones.spine![2] < a.bones.spine![2] - 4, "leans along the flight");
  const sad = idlePose({ ...input, head: [11, 0, 0] });
  assert.ok(sad.bones.head![0] > a.bones.head![0] + 6, "the expression's posture lowers the head");
});

test("gestures: keys interpolated, a fade in and out, nothing after the end; every brain gesture exists", () => {
  for (const g of BODY_GESTURES) {
    assert.ok(GESTURES[g], `built-in clip for ${g}`);
    assert.ok(GESTURE_HINT[g]);
  }
  const nod = GESTURES.nod;
  assert.equal(sampleGesture(nod, -1), null);
  assert.equal(sampleGesture(nod, nod.ms + 1), null);
  const start = sampleGesture(nod, 0)!;
  assert.equal(start.weight, 0, "starts from the resting pose");
  const down = sampleGesture(nod, nod.ms * 0.25)!;
  assert.equal(down.weight, 1);
  assert.ok(Math.abs(down.pose.bones.head![0] - 14) < 1e-9, "the key's value at the key's time");
  const between = sampleGesture(nod, nod.ms * 0.375)!;
  assert.ok(between.pose.bones.head![0] < 14 && between.pose.bones.head![0] > -2);
  assert.ok(sampleGesture(nod, nod.ms - 10)!.weight < 0.2, "fades out at the end");
  const hop = sampleGesture(GESTURES.hop, GESTURES.hop.ms * 0.45)!;
  assert.ok(hop.pose.hipsY! > 0.05, "in the air");
});

test("mirroring swaps left and right and flips Y and Z rotations", () => {
  const m = mirrorPose({ bones: { rightUpperArm: [10, 20, -30], head: [5, 6, 7] }, hipsY: 0.1 });
  assert.deepEqual(m.bones.leftUpperArm, [10, -20, 30]);
  assert.deepEqual(m.bones.head, [5, -6, -7]);
  assert.equal(m.bones.rightUpperArm, undefined);
  assert.equal(m.hipsY, 0.1);
});

test("the avatar's expressions scale with intensity; the lip sync opens with the voice and picks vowels by brightness", () => {
  const strong = avatarExpression("tristezza", 1);
  const mild = avatarExpression("tristezza", 0.2);
  assert.equal(strong.faces.sad, 1);
  assert.ok(mild.faces.sad! < 0.6 && mild.faces.sad! > 0.2);
  assert.ok(strong.head[0] > mild.head[0], "a stronger sadness lowers the head more");
  assert.ok(avatarExpression("tristezza", 1).energy < 1 && avatarExpression("gioia", 1).energy > 1);
  assert.deepEqual(Object.values(visemes(0, 0.5, 100)), [0, 0, 0, 0, 0], "silence: mouth closed");
  const bright = visemes(0.8, 0.9, 100);
  const dark = visemes(0.8, 0.05, 100);
  const mid = visemes(0.8, 0.35, 100);
  assert.ok(bright.ee > bright.oh && bright.ee > bright.ou, "an i/e sound");
  assert.ok(dark.oh + dark.ou > dark.aa + dark.ee, "an o/u sound");
  assert.ok(mid.aa > mid.ee, "an a");
  assert.ok(visemes(0.3, 0.35, 100).aa < mid.aa, "louder = wider");
});

test("gesture names: say calls, clip files, and what the two eyes can show", () => {
  assert.equal(gestureId("Shake head"), "shake_head");
  assert.equal(gestureId("none"), null);
  assert.equal(gestureId("<script>"), null);
  assert.equal(clipName("Wave Hip Hop.fbx"), "wave_hip_hop");
  assert.equal(clipName("dance.VRMA"), "dance");
  assert.equal(clipName("notes.txt"), null);
  assert.equal(EYE_GESTURE.nod, "nod");
  assert.equal(EYE_GESTURE.wave, undefined);
  assert.deepEqual(parseToolCall("say", { emotion: "gioia", text: "Ciao!", gesture: "Wave" }), { name: "say", text: "Ciao!", emotion: "gioia", intensity: 0.6, gesture: "wave" });
  assert.equal((parseToolCall("say", { emotion: "gioia", text: "Ciao!", gesture: "none" }) as { gesture?: string }).gesture, undefined);
  assert.equal(liveSayFrom('{"emotion":"gioia","gesture":"wave","text":"Cia', "text", false)?.gesture, "wave");
  assert.equal(liveSayFrom('{"emotion":"gioia","gesture":"wa', "text", false), null, "no text yet");
});

test("a say call's gesture goes with its first sentence only", () => {
  let id = 1;
  const out: VoiceOutput = { speak: () => true, cancel: () => undefined, begin: () => undefined, chunk: () => undefined, end: () => undefined, stop: () => undefined };
  const s = new VoiceSpeech(out, { sentenceStart: () => undefined, speaking: () => undefined, fallback: () => undefined }, () => id++);
  s.final([
    { text: "Ciao! Come stai? Io benissimo.", emotion: "gioia", intensity: 0.8, gesture: "wave" },
    { text: "Senti, una cosa.", emotion: "neutra", intensity: 0.6 },
  ]);
  assert.deepEqual(
    s.sentences.map((x) => x.gesture ?? "-"),
    ["wave", "-", "-", "-"],
  );
});

test("the face box: the eyes are wide, the avatar's bust taller; changing mode keeps everything on screen", () => {
  const work = { x: 0, y: 0, width: 1920, height: 1040 };
  const eyes = computeLayout({ x: 1700, y: 900 }, 1, "#FFFFFF", work);
  assert.equal(eyes.layout.mode, "minimal");
  assert.deepEqual([eyes.layout.face.width, eyes.layout.face.height], [FACE_BOX.minimal.width, FACE_BOX.minimal.height]);
  const body = computeLayout({ x: 1700, y: 700 }, 1.5, "#FFFFFF", work, "3d");
  assert.equal(body.layout.mode, "3d");
  assert.deepEqual([body.layout.face.width, body.layout.face.height], [270, 330]);
  const anchor = clampAnchor({ x: 1800, y: 1000 }, 1, work, "3d");
  assert.ok(anchor.y + FACE_BOX["3d"].height * 0.7 <= 1040, "most of the avatar stays on screen");
});

test("the half-length shot goes from the waist to above the hair", () => {
  const span = bustSpan(1.6, 0.9);
  assert.ok(close([span.bottom, span.top], [0.96, 1.63], 1e-9), JSON.stringify(span));
  const noHips = bustSpan(1.6, null);
  assert.ok(Math.abs(noHips.bottom - 0.928) < 1e-9, "the upper 42% without a hips bone");
  assert.equal(bustSpan(1.6, 0.1).bottom, noHips.bottom, "a hips bone in an odd place is ignored");
});

test("app:// serves the dist folder and the mounts, never anything outside them", () => {
  const root = normalize("C:/app/dist");
  const mounts = new Map([
    ["/user/model.vrm", normalize("D:/models/me.vrm")],
    ["/user/animations/", normalize("C:/data/animations")],
  ]);
  assert.equal(resolveAppPath(root, "/renderer/face.html", mounts), join(root, "renderer/face.html"));
  assert.equal(resolveAppPath(root, "/user/model.vrm", mounts), normalize("D:/models/me.vrm"));
  assert.equal(resolveAppPath(root, "/user/animations/wave%20hello.fbx", mounts), join(normalize("C:/data/animations"), "wave hello.fbx"));
  assert.equal(resolveAppPath(root, "/user/animations/..%2F..%2Fsecrets.bin", mounts), null, "no way out of a mounted folder");
  assert.equal(resolveAppPath(root, "/user/animations/", mounts), null);
  assert.equal(resolveAppPath(root, "/../../Windows/win.ini", mounts), null);
});

test("settings and prompt: the 3D mode, its model file, and the body section only when shown", () => {
  assert.equal(sanitizeSettings({}).face.mode, "minimal");
  assert.equal(sanitizeSettings({ face: { mode: "3d", model: "C:\\m\\lumi.vrm" } }).face.model, "C:\\m\\lumi.vrm");
  assert.equal(sanitizeSettings({ face: { mode: "4d", model: "C:\\virus.exe" } }).face.mode, "minimal");
  assert.equal(sanitizeSettings({ face: { model: "C:\\virus.exe" } }).face.model, "");
  const eyes = buildSystemPrompt(DEFAULT_SETTINGS);
  const body = buildSystemPrompt({ ...DEFAULT_SETTINGS, face: { ...DEFAULT_SETTINGS.face, mode: "3d" } });
  assert.match(eyes, /two vertical glowing eyes/);
  assert.doesNotMatch(eyes, /# Your body/);
  assert.match(body, /# Your body/);
  assert.match(body, /wave \(greeting or goodbye\)/);
  assert.doesNotMatch(body, /two vertical glowing eyes/);
});
