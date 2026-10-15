// The microphone and voice activity detection (Silero VAD in WebAssembly).
// The microphone runs with Chromium's echo cancellation, noise suppression
// and gain control, in the same renderer that plays Lumi's voice. Only
// speech is sent to the main process: from each detected speech start
// (with a short pre-roll, so the first syllable isn't lost) to its end, or
// every frame while push-to-talk is held.
import { MicVAD } from "@ricky0123/vad-web";
import type { MicControl, MicEvent } from "../../shared/types";
import { floatToPcm16 } from "./rms";

/** Frames kept before a speech start (32 ms each with the v5 model). */
const PREROLL_FRAMES = 10;

const NORMAL = { positiveSpeechThreshold: 0.5, negativeSpeechThreshold: 0.35, minSpeechMs: 250 };
/** While Lumi talks, only clear and sustained speech counts (barge-in), so its own echo doesn't. */
const STRICT = { positiveSpeechThreshold: 0.8, negativeSpeechThreshold: 0.6, minSpeechMs: 300 };

export class Listener {
  private vad: MicVAD | null = null;
  private starting: Promise<void> | null = null;
  private control: MicControl = { enabled: false, forceStream: false, autoStream: false, strict: false, deviceId: "", redemptionMs: 300 };
  private streaming = false;
  private preroll: Float32Array[] = [];
  private speechStartedAt = 0;
  private deviceId = "";

  /**
   * `source`: where the audio comes from instead of the microphone (the
   * phone's track in the phone bridge), with the assets' path relative to
   * the page. That stream's tracks are never stopped on pause.
   */
  constructor(
    private readonly send: (event: MicEvent) => void,
    private readonly source: { stream: () => Promise<MediaStream>; assets: string } | null = null,
  ) {}

  async apply(control: MicControl): Promise<void> {
    const deviceChanged = control.deviceId !== this.deviceId;
    this.control = control;
    if (!control.forceStream && !control.autoStream) this.streaming = false;
    if (control.forceStream) this.flushPreroll();
    if (!control.enabled) {
      this.streaming = false;
      this.preroll = [];
      await this.vad?.pause();
      return;
    }
    if (this.vad && deviceChanged) {
      await this.vad.destroy();
      this.vad = null;
    }
    if (!this.vad) await this.create();
    this.vad?.setOptions({ ...(control.strict ? STRICT : NORMAL), redemptionMs: control.redemptionMs });
    if (this.vad && !this.vad.listening) await this.vad.start();
  }

  private create(): Promise<void> {
    if (this.starting) return this.starting;
    this.deviceId = this.control.deviceId;
    const deviceId = this.deviceId;
    const source = this.source;
    const getStream = source
      ? source.stream
      : () =>
      navigator.mediaDevices.getUserMedia({
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    this.starting = MicVAD.new({
      model: "v5",
      baseAssetPath: source?.assets ?? "./vad/",
      onnxWASMBasePath: source?.assets ?? "./vad/",
      ...NORMAL,
      redemptionMs: this.control.redemptionMs,
      preSpeechPadMs: 300,
      startOnLoad: false,
      getStream,
      resumeStream: getStream,
      // Stopping the tracks turns off the microphone (and Windows' indicator) while not listening
      pauseStream: async (stream) => {
        if (!source) stream.getTracks().forEach((t) => t.stop());
      },
      ortConfig: (ort) => {
        ort.env.logLevel = "error";
        ort.env.wasm.numThreads = 1;
      },
      onFrameProcessed: (probabilities, frame) => this.onFrame(probabilities.isSpeech, frame),
      onSpeechStart: () => this.onSpeechStart(),
      onSpeechRealStart: () => this.send({ type: "speech-confirmed" }),
      onSpeechEnd: () => this.onSpeechEnd(),
      onVADMisfire: () => {
        if (!this.control.forceStream) this.streaming = false;
        this.send({ type: "misfire" });
      },
    })
      .then((vad) => {
        this.vad = vad;
        this.send({ type: "ready" });
      })
      .catch((err: unknown) => {
        this.send({ type: "error", message: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  private onFrame(speech: number, frame: Float32Array): void {
    if (this.control.forceStream || this.streaming) {
      this.send({ type: "frame", pcm: floatToPcm16(frame).buffer as ArrayBuffer, speech });
      return;
    }
    this.preroll.push(frame.slice());
    if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
  }

  private onSpeechStart(): void {
    this.speechStartedAt = performance.now();
    if (this.control.autoStream && !this.control.forceStream) {
      this.streaming = true;
      this.flushPreroll();
    }
    this.send({ type: "speech-start" });
  }

  private onSpeechEnd(): void {
    if (!this.control.forceStream) this.streaming = false;
    this.send({ type: "speech-end", durationMs: Math.round(performance.now() - this.speechStartedAt) });
  }

  /** Sends the frames heard just before the speech start (they were not sent yet). */
  private flushPreroll(): void {
    for (const frame of this.preroll.splice(0)) this.send({ type: "frame", pcm: floatToPcm16(frame).buffer as ArrayBuffer, speech: 0 });
  }
}
