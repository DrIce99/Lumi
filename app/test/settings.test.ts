// Settings sanitizing, hardware profiles and the face window geometry.
import assert from "node:assert/strict";
import test from "node:test";
import { clampAnchor, computeLayout, OVERLAY_HEIGHT } from "../src/main/layout";
import { sanitizeSettings, SettingsStore } from "../src/main/settings";
import { sidecarConfig } from "../src/main/voice/voice";
import { DEFAULT_VOICE_DESCRIPTION, defaultVoice, TTS_MODELS } from "../src/shared/catalog";
import { applyProfile, suggestProfile } from "../src/shared/profiles";
import { DEFAULT_SETTINGS } from "../src/shared/types";

test("missing or broken settings fall back to the defaults", () => {
  assert.deepEqual(sanitizeSettings({}), DEFAULT_SETTINGS);
  assert.deepEqual(sanitizeSettings(null), DEFAULT_SETTINGS);
  const s = sanitizeSettings({
    profile: "turbo",
    face: { scale: 9, color: "red" },
    tts: { engine: "kokoro", speed: 0.1, seed: -5 },
    listen: { mode: "wake-word", followUpSeconds: 500, wakeWord: "  Ehi LUMI ", pauseMs: 9000 },
    perception: { pauseInApps: ["KeePass", "KeePass", 3, " Bitwarden "], sendScreenshots: "maybe" },
    brain: { chat: { provider: "groq", model: "" }, idle: { provider: "nope", model: "x" }, vision: { provider: "ollama", model: "" } },
  });
  assert.equal(s.profile, "bilanciato");
  assert.equal(s.face.scale, 3);
  assert.equal(s.face.color, DEFAULT_SETTINGS.face.color);
  assert.equal(s.tts.engine, "kokoro");
  assert.equal(s.tts.speed, 0.7);
  assert.equal(s.tts.seed, 0);
  assert.equal(s.listen.mode, "wake-word");
  assert.equal(s.listen.followUpSeconds, 60);
  assert.equal(s.listen.pauseMs, 2500);
  assert.equal(s.listen.wakeWord, "ehi lumi");
  assert.deepEqual(s.perception.pauseInApps, ["KeePass", "Bitwarden"]);
  assert.equal(s.perception.sendScreenshots, "never", "images stay on the PC unless the user allows otherwise");
  assert.equal(s.brain.chat.model, "openai/gpt-oss-120b", "empty model: the service's first suggestion");
  assert.equal(s.brain.idle.provider, DEFAULT_SETTINGS.brain.idle.provider);
  assert.deepEqual(s.brain.vision, { provider: "ollama", model: "" }, "vision may stay empty (= the chat model)");
});

test("updates merge nested groups", () => {
  const store = new SettingsStore(null);
  const changes: string[] = [];
  store.onChange((next, prev) => changes.push(`${prev.listen.mode}->${next.listen.mode}`));
  store.update({ listen: { mode: "continuous" } });
  assert.equal(store.get().listen.mode, "continuous");
  assert.equal(store.get().listen.hotkey, DEFAULT_SETTINGS.listen.hotkey);
  assert.deepEqual(changes, ["push-to-talk->continuous"]);
});

test("profiles follow the GPU", () => {
  assert.equal(suggestProfile(null), "leggero");
  assert.equal(suggestProfile({ name: "GTX 1650", vramTotalMb: 4096 }), "leggero");
  assert.equal(suggestProfile({ name: "RTX 4070", vramTotalMb: 12282 }), "bilanciato");
  assert.equal(suggestProfile({ name: "RTX 4090", vramTotalMb: 24564 }), "locale");
  const light = applyProfile(DEFAULT_SETTINGS, "leggero");
  assert.equal(light.tts.engine, "kokoro");
  assert.equal(light.stt.engine, "groq");
  const local = applyProfile(DEFAULT_SETTINGS, "locale");
  assert.equal(local.brain.chat.provider, "ollama");
  assert.equal(local.brain.vision.model, "qwen2.5vl");
  // The Italian clone (roadmap 17.3): an empty clip is the bundled "italiana" voice
  assert.deepEqual([local.tts.model, local.tts.voice], ["1.7B-Base", ""]);
  assert.equal(DEFAULT_SETTINGS.profile, "bilanciato", "applyProfile doesn't touch its input");
});

test("each TTS model starts from a voice it understands", () => {
  assert.equal(defaultVoice("qwen3", "1.7B-Base"), "");
  assert.equal(defaultVoice("qwen3", "1.7B-CustomVoice"), "ryan");
  assert.equal(defaultVoice("qwen3", "1.7B-VoiceDesign"), DEFAULT_VOICE_DESCRIPTION);
  assert.equal(defaultVoice("kokoro", "v1.0"), "im_nicola");
  assert.equal(defaultVoice("qwen3", "1.7B-Italiano"), "", "the trained model has one voice");
  assert.equal(TTS_MODELS.qwen3[0].id, DEFAULT_SETTINGS.tts.model);
});

test("the window keeps the face in place and the bubble on screen", () => {
  const work = { x: 0, y: 0, width: 1920, height: 1040 };
  const low = computeLayout({ x: 1700, y: 900 }, 1, "#F5F3EE", work);
  assert.equal(low.layout.overlay, "above");
  assert.equal(low.bounds.y, 900 - OVERLAY_HEIGHT);
  assert.ok(low.bounds.x + low.bounds.width <= 1920, "window inside the screen");
  assert.equal(low.bounds.x + low.layout.face.x, 1700, "face where it was put");
  assert.equal(low.bounds.y + low.layout.face.y, 900);
  const high = computeLayout({ x: 100, y: 20 }, 2, "#F5F3EE", work);
  assert.equal(high.layout.overlay, "below");
  assert.equal(high.layout.face.y, 0);
  assert.equal(high.layout.face.width, 320);
  assert.equal(high.bounds.x + high.layout.face.x, 100);
  const clamped = clampAnchor({ x: -5000, y: 99_999 }, 1, work);
  assert.ok(clamped.x >= -160 && clamped.y <= 1040);
});

test("models a service retired are replaced on load", () => {
  const s = sanitizeSettings({
    brain: {
      chat: { provider: "groq", model: "llama-3.3-70b-versatile" },
      idle: { provider: "ollama", model: "llama-3.3-70b-versatile" },
      vision: { provider: "groq", model: "meta-llama/llama-4-scout-17b-16e-instruct" },
    },
  });
  assert.deepEqual(s.brain.chat, { provider: "groq", model: "openai/gpt-oss-120b" });
  assert.equal(s.brain.idle.model, "llama-3.3-70b-versatile", "only that service's models");
  assert.deepEqual(s.brain.vision, { provider: "groq", model: "qwen/qwen3.8-27b" });
});

test("pronunciations keep only 'parola = pronuncia' lines, and reach the sidecar", () => {
  const s = sanitizeSettings({ tts: { pronunciations: ["VS Code = vi es code", "senza uguale", "vuoto =", " Sme.UP=smi ap ", 3] } });
  assert.deepEqual(s.tts.pronunciations, ["VS Code = vi es code", "Sme.UP=smi ap"]);
  assert.deepEqual((sidecarConfig(s, true).tts as { lexicon: string[] }).lexicon, s.tts.pronunciations);
  assert.deepEqual(sanitizeSettings({}).tts.pronunciations, []);
});
