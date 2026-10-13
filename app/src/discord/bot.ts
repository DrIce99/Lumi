// Lumi's voice in Discord: a bot that follows the user into voice channels
// and speaks there. Runs in its own Electron utility process: the gateway,
// Opus encoding and DAVE encryption never touch the main thread (where the
// click-through mouse hook lives).
//
// From the main process: { type: "start", token, userId }, { type: "begin",
// id, volume }, { type: "audio", id, pcm, rate }, { type: "end", id },
// { type: "cut" } (barge-in), { type: "stop" }. To it: { type: "status",
// state, detail } and { type: "log", level, message }.
//
// The bot joins deafened: it only speaks, it doesn't receive anybody's audio.
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  type AudioResource,
  type VoiceConnection,
} from "@discordjs/voice";
import { Client, Events, GatewayIntentBits, type VoiceBasedChannel } from "discord.js";
import { PassThrough } from "node:stream";
import { samples, Upsampler } from "./pcm";

type Incoming =
  | { type: "start"; token: string; userId: string }
  | { type: "stop" }
  | { type: "begin"; id: number; volume: number }
  | { type: "audio"; id: number; pcm: Uint8Array; rate: number }
  | { type: "end"; id: number }
  | { type: "cut" };

export type BotState = "off" | "connecting" | "online" | "in-channel" | "error";

const port = process.parentPort;

function send(message: unknown): void {
  port.postMessage(message);
}

function log(level: "info" | "warn", message: string): void {
  send({ type: "log", level, message });
}

function status(state: BotState, detail = ""): void {
  send({ type: "status", state, detail });
}

interface Utterance {
  id: number;
  stream: PassThrough;
  resource: AudioResource;
  upsampler: Upsampler | null;
  volume: number;
}

let client: Client | null = null;
let userId = "";
let connection: VoiceConnection | null = null;
let channelId: string | null = null;
const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
/** Sentences in order: the first plays, the others fill up meanwhile. */
const queue: Utterance[] = [];

player.on(AudioPlayerStatus.Idle, () => {
  queue.shift();
  playNext();
});
player.on("error", (err) => {
  log("warn", `Discord audio error: ${err.message}`);
  queue.shift();
  playNext();
});

function playNext(): void {
  const next = queue[0];
  if (next && player.state.status === AudioPlayerStatus.Idle) player.play(next.resource);
}

function begin(id: number, volume: number): void {
  const stream = new PassThrough();
  const resource = createAudioResource(stream, { inputType: StreamType.Raw });
  queue.push({ id, stream, resource, upsampler: null, volume });
  playNext();
}

function audio(id: number, pcm: Uint8Array, rate: number): void {
  const u = queue.find((x) => x.id === id);
  if (!u) return;
  u.upsampler ??= new Upsampler(rate, u.volume);
  u.stream.write(u.upsampler.push(samples(pcm)));
}

function end(id: number): void {
  queue.find((x) => x.id === id)?.stream.end();
}

function cut(): void {
  for (const u of queue.splice(0)) u.stream.destroy();
  player.stop(true);
}

async function join(channel: VoiceBasedChannel): Promise<void> {
  if (channelId === channel.id && connection) return;
  leave();
  channelId = channel.id;
  status("connecting", channel.name);
  const conn = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });
  connection = conn;
  conn.subscribe(player);
  conn.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      // Moved or reconnecting: give it a moment
      await Promise.race([entersState(conn, VoiceConnectionStatus.Signalling, 5000), entersState(conn, VoiceConnectionStatus.Connecting, 5000)]);
    } catch {
      if (connection === conn) leave();
      status("online");
    }
  });
  try {
    await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
    if (connection === conn) {
      status("in-channel", `${channel.name} (${channel.guild.name})`);
      log("info", `Joined voice channel ${channel.guild.name} / ${channel.name}`);
    }
  } catch (err) {
    if (connection === conn) {
      leave();
      status("error", `non riesco a entrare in ${channel.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function leave(): void {
  cut();
  connection?.destroy();
  connection = null;
  channelId = null;
}

/** Whether a member is the user: by id, or by username / display name (voice states carry the member). */
function isUser(member: { id: string; user?: { username: string; tag?: string; globalName?: string | null } } | null | undefined): boolean {
  if (!member) return false;
  if (member.id === userId) return true;
  if (/^\d+$/.test(userId) || !member.user) return false;
  const names = [member.user.username, member.user.tag, member.user.globalName].filter(Boolean).map((n) => n!.toLowerCase());
  return names.includes(userId);
}

/** The channel the user is in, in any server the bot shares with them. */
function userChannel(c: Client): VoiceBasedChannel | null {
  for (const guild of c.guilds.cache.values()) {
    for (const state of guild.voiceStates.cache.values()) {
      if (state.channel && isUser(state.member)) return state.channel;
    }
  }
  return null;
}

async function start(token: string, user: string): Promise<void> {
  await stop();
  userId = user;
  status("connecting");
  const c = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  client = c;
  c.once(Events.ClientReady, async (ready) => {
    log("info", `Discord bot online as ${ready.user.tag} in ${ready.guilds.cache.size} server(s)`);
    if (!ready.guilds.cache.size) {
      status("error", "il bot non è in nessun server: invitalo nel tuo server");
      return;
    }
    status("online");
    const channel = userChannel(ready);
    if (channel) await join(channel);
  });
  c.on(Events.VoiceStateUpdate, async (_old, now) => {
    if (!isUser(now.member) && now.id !== userId) return;
    if (now.channel) await join(now.channel);
    else if (channelId) {
      leave();
      status("online");
    }
  });
  c.on(Events.Error, (err) => log("warn", `Discord error: ${err.message}`));
  try {
    await c.login(token);
  } catch (err) {
    client = null;
    const message = err instanceof Error ? err.message : String(err);
    status("error", /token/i.test(message) ? "il token del bot non è valido" : message);
  }
}

async function stop(): Promise<void> {
  leave();
  const c = client;
  client = null;
  if (c) await c.destroy();
  status("off");
}

port.on("message", (event: { data: Incoming }) => {
  const m = event.data;
  switch (m.type) {
    case "start":
      void start(m.token, m.userId);
      break;
    case "stop":
      void stop();
      break;
    case "begin":
      begin(m.id, m.volume);
      break;
    case "audio":
      audio(m.id, m.pcm, m.rate);
      break;
    case "end":
      end(m.id);
      break;
    case "cut":
      cut();
      break;
  }
});
