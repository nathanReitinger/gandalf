// Gandalf on Cloudflare: serves the page, keeps the passwords and rules on the server,
// and runs Gandalf and his checkers on Workers AI. Mirrors the routes in ../../app.py.

import data from "./levels.json" with { type: "json" };
import answerKey from "./answer-key.json" with { type: "json" };
import { LEVELS, passwordMatches, pipeline, runLevel } from "./game.js";
import { BROWSER_DECLARES, FLAGS, declaredBot } from "./bots.js";

const MAX_MESSAGE_CHARS = 2000;
const LIMITS = { replyTokens: 250, checkerTokens: 120 };
const COOKIE = "gandalf";

// --- Today's free allowance ----------------------------------------------------------
// Cloudflare doesn't let code read its neuron count, so we keep our own estimate: tokens
// times each model's published rate (neurons per million input / output tokens, from
// developers.cloudflare.com/workers-ai/platform/pricing). Unlisted models use the highest rate.
const FREE_NEURONS = 10000;
const RATES = {
  "@cf/meta/llama-3.1-8b-instruct-fp8-fast": [4119, 34868],
  "@cf/meta/llama-3.2-3b-instruct": [4625, 30475],
  "@cf/google/gemma-4-26b-a4b-it": [9091, 27273],
  "@cf/qwen/qwen3-30b-a3b-fp8": [4625, 30475],
  "@cf/zai-org/glm-4.7-flash": [5500, 36400],
  "@cf/openai/gpt-oss-20b": [18182, 27273],
  "@cf/mistralai/mistral-small-3.1-24b-instruct": [31876, 50488],
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": [26668, 204805],
};
const HIGHEST_RATE = [31876, 204805];
const today = () => new Date().toISOString().slice(0, 10); // days reset at midnight UTC

function makeMeter() {
  let neurons = 0;
  return {
    add(model, inputTokens, outputTokens, reported) {
      // Cloudflare reports the exact cost for some models; otherwise estimate from tokens.
      if (typeof reported === "number") return void (neurons += reported);
      const [rateIn, rateOut] = RATES[model] || HIGHEST_RATE;
      neurons += (inputTokens * rateIn + outputTokens * rateOut) / 1e6;
    },
    get neurons() { return neurons; },
  };
}
// When a model doesn't report its token counts: about 4 characters per token.
const roughTokens = (text) => Math.ceil(text.length / 4);
const promptTokens = (messages) => roughTokens(messages.map((m) => m.content).join(" ")) + 8 * messages.length;

// One counter for the whole site, stored in a Durable Object (free on the Workers Free plan).
export class UsageCounter {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
    const day = new URL(request.url).searchParams.get("day");
    let { used = 0, messages = 0 } = (await this.storage.get(day)) || {};
    if (request.method === "POST") {
      const { neurons = 0, exhausted = false } = await request.json();
      if (exhausted) used = Math.max(used, FREE_NEURONS);
      else { used += neurons; messages += 1; }
      await this.storage.put(day, { used, messages });
    }
    return Response.json({ used, messages });
  }
}

// --- Who's playing right now, and today's leaderboard -----------------------------------
// One Durable Object holds both. Every open page keeps a WebSocket to it: an open connection
// is someone on the site, and the object pushes a fresh snapshot to every open page the moment
// anything changes (someone arrives or leaves, changes level, asks Gandalf, passes a level, or
// does something in the Bot Arcade). Pages that can't use WebSockets check in over HTTP
// instead. Nothing here uses AI, so none of it touches the daily neuron allowance; outgoing
// WebSocket messages are free on Cloudflare, and incoming ones count as 1/20 of a request.
const TAB_TIMEOUT_MS = 150000; // a tab not heard from this long (a sleeping laptop) drops off; pages check in every 30 s
const RELOAD_GRACE_MS = 3000; // keep someone listed this long after their last page closes (a reload)
const BROADCAST_DELAY_MS = 150; // gather a burst of changes into one update
const SAVE_EVERY_MS = 60000;
const chicagoDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());

// Names are optional: letters, numbers, spaces, and . , ' _ - only, at most 24 characters.
export const cleanName = (name) =>
  String(name ?? "").normalize("NFC").replace(/[^\p{L}\p{N} .,'_-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 24);

// What a page may say it's doing; anything else is ignored.
export const STATUS = {
  playing: "reading the level",
  asking: "asking Gandalf",
  replied: "reading Gandalf's reply",
  blocked: "was just blocked by a defense",
  wrong: "guessed a wrong password",
  passed: "passed a level",
  arrived: "just arrived",
  solving: "working on a puzzle",
  solved: "solved a puzzle",
  missed: "answered a puzzle wrong",
  skipped: "skipped a puzzle",
};
const PUZZLES = new Set(["Number sequence", "Mental math", "Anagram", "Odd one out", "Letter pattern"]);
const count = (v, max = 1e6) => Math.max(0, Math.min(max, Number.parseInt(v, 10) || 0));

// Only known fields, in known ranges, from what a page sends.
function cleanState(input, unlockedLevel) {
  const out = {};
  const level = Number.parseInt(input?.level, 10);
  if (level >= 1) out.level = Math.min(level, unlockedLevel || 1);
  if (input?.status in STATUS) out.status = input.status;
  const t = input?.stats;
  if (t && typeof t === "object") {
    out.stats = {
      solved: count(t.solved), streak: count(t.streak), best: count(t.best), wrong: count(t.wrong),
      skipped: count(t.skipped), room: count(t.room, 99991), puzzle: PUZZLES.has(t.puzzle) ? t.puzzle : "",
    };
  }
  return out;
}

export class ClassRoom {
  constructor(state) {
    this.state = state;
    this.storage = state.storage;
    this.players = null; // HTTP check-ins: pid -> { ...player, tabs: { tabId: lastSeen } }
    this.closed = new Map(); // pid -> { player, at }: someone whose last page just closed
    this.gone = new WeakSet(); // sockets that have closed but may still be listed
    this.names = null;
    this.savedAt = 0;
    this.timer = null;
    this.quiet = new WeakSet(); // sockets already dropped from the list for going quiet
  }

  sockets() {
    return (this.state.getWebSockets?.() || []).filter((ws) => !this.gone.has(ws));
  }

  async loadNames() {
    if (!this.names) this.names = (await this.storage.get("names")) || {};
    return this.names;
  }

  async loadPlayers() {
    if (!this.players) this.players = new Map(Object.entries((await this.storage.get("presence")) || {}));
  }

  async savePlayers(now, force) {
    if (!force && now - this.savedAt < SAVE_EVERY_MS) return;
    this.savedAt = now;
    await this.storage.put("presence", Object.fromEntries(this.players));
  }

  // Everyone on the site right now, as one page should see it.
  async snapshot(viewer) {
    const now = Date.now();
    const names = await this.loadNames();
    const latest = new Map();
    const consider = (p) => {
      const cur = latest.get(p.pid);
      if (!cur) latest.set(p.pid, { ...p, tabs: 1 });
      else if ((p.at || 0) > (cur.at || 0)) latest.set(p.pid, { ...p, since: Math.min(p.since, cur.since), tabs: cur.tabs + 1 });
      else cur.tabs += 1;
    };
    for (const ws of this.sockets()) {
      const a = ws.deserializeAttachment();
      if (a?.pid && now - (a.at || 0) <= TAB_TIMEOUT_MS) consider(a);
    }
    await this.loadPlayers();
    for (const [pid, p] of this.players) {
      for (const [tab, seen] of Object.entries(p.tabs)) if (now - seen <= TAB_TIMEOUT_MS) consider({ ...p, pid, tab, at: seen });
    }
    for (const [pid, g] of this.closed) {
      if (now - g.at > RELOAD_GRACE_MS) this.closed.delete(pid);
      else if (!latest.has(pid)) latest.set(pid, { ...g.player, tabs: 0 });
    }
    const everyone = [...latest.values()].map((p) => ({
      key: p.pid, tag: p.pid.slice(0, 4), name: names[p.pid] || "", you: p.pid === viewer,
      level: p.level, unlocked: p.unlocked, passed: p.passed, arcade: Boolean(p.arcade),
      bot: p.bot || null, flags: p.flags || [], since: p.since, tabs: p.tabs,
      status: STATUS[p.status] || "", status_at: p.statusAt || p.since,
      stats: p.arcade ? { solved: 0, streak: 0, best: 0, wrong: 0, skipped: 0, room: 1, puzzle: "", ...(p.stats || {}) } : undefined,
    }));
    const players = everyone.filter((p) => !p.arcade).sort((a, b) => b.passed - a.passed || b.level - a.level || a.since - b.since);
    const bots = everyone.filter((p) => p.arcade).sort((a, b) => a.since - b.since);
    const byLevel = Object.fromEntries(LEVELS.map((l) => [l.n, 0]));
    for (const p of players) byLevel[p.level] = (byLevel[p.level] || 0) + 1;
    return {
      type: "room", total: players.length, arcade: bots.length, flagged: players.filter((p) => p.flags.length).length,
      by_level: byLevel, now, updated: new Date(now).toISOString(), players, bots,
    };
  }

  // Push the current snapshot to every open page, after a short pause to gather a burst.
  queueBroadcast() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.broadcast().catch((e) => console.error("broadcast", e));
    }, BROADCAST_DELAY_MS);
  }

  async broadcast() {
    const base = await this.snapshot(null);
    for (const ws of this.sockets()) {
      const me = ws.deserializeAttachment()?.pid;
      const mark = (list) => list.map((p) => (p.key === me ? { ...p, you: true } : p));
      try {
        ws.send(JSON.stringify({ ...base, players: mark(base.players), bots: mark(base.bots) }));
      } catch { /* that page just went away */ }
    }
  }

  // List a newly opened page, keeping how long this person has been here (across tabs and
  // reloads) and, for a bot, its running puzzle tally.
  join(ws, info) {
    const now = Date.now();
    const earlier = [
      ...this.sockets().map((o) => o.deserializeAttachment()).filter((a) => a?.pid === info.pid),
      this.closed.get(info.pid)?.player,
    ].filter(Boolean);
    const since = Math.min(now, ...earlier.map((a) => a.since || now));
    const carried = earlier.find((a) => a.stats)?.stats;
    this.closed.delete(info.pid);
    this.state.acceptWebSocket(ws);
    ws.serializeAttachment({
      ...info, since, at: now, status: info.arcade ? "arrived" : "playing", statusAt: now, ...(carried ? { stats: carried } : {}),
    });
    this.queueBroadcast();
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string") return;
    let data;
    try { data = JSON.parse(message); } catch { return; }
    const a = ws.deserializeAttachment() || {};
    const now = Date.now();
    if (data?.type === "here") {
      // A page's heartbeat, every 30 seconds. Also the moment to drop pages that have gone quiet
      // (a laptop that went to sleep never says goodbye), and to bring back one that woke up.
      ws.serializeAttachment({ ...a, at: now });
      const woke = this.quiet.has(ws) || now - (a.at || 0) > TAB_TIMEOUT_MS;
      this.quiet.delete(ws);
      const quiet = this.sockets().filter((o) => now - (o.deserializeAttachment()?.at || 0) > TAB_TIMEOUT_MS && !this.quiet.has(o));
      quiet.forEach((o) => this.quiet.add(o));
      if (woke || quiet.length) this.queueBroadcast();
      return;
    }
    if (data?.type !== "state") return;
    const update = cleanState(data, a.unlocked);
    ws.serializeAttachment({ ...a, ...update, statusAt: update.status ? now : a.statusAt, at: now });
    this.quiet.delete(ws);
    this.queueBroadcast();
  }

  async webSocketClose(ws) {
    this.pageClosed(ws);
    try { ws.close(); } catch { /* already closed */ }
  }

  async webSocketError(ws) {
    this.pageClosed(ws);
  }

  pageClosed(ws) {
    this.gone.add(ws);
    const a = ws.deserializeAttachment();
    if (a?.pid && !this.sockets().some((o) => o.deserializeAttachment()?.pid === a.pid)) {
      this.closed.set(a.pid, { player: a, at: Date.now() });
    }
    this.queueBroadcast();
    // If they don't come right back (a reload), drop them once the grace period is over.
    setTimeout(() => this.queueBroadcast(), RELOAD_GRACE_MS + 200);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();

    // A page opening its live connection. The worker has already checked who it is.
    if (url.pathname === "/live") {
      const [client, server] = Object.values(new WebSocketPair());
      this.join(server, JSON.parse(url.searchParams.get("info") || "{}"));
      return new Response(null, { status: 101, webSocket: client });
    }

    const body = request.method === "POST" ? await request.json() : {};
    const names = await this.loadNames();

    if (url.pathname === "/myname") return Response.json({ name: names[body.pid] || "" });

    if (url.pathname === "/name") {
      const name = cleanName(body.name);
      if (name) names[body.pid] = name;
      else delete names[body.pid];
      await this.storage.put("names", names);
      this.queueBroadcast();
      return Response.json({ name });
    }

    if (url.pathname === "/score") {
      const key = `board:${chicagoDay()}`;
      const board = (await this.storage.get(key)) || {};
      if ((board[body.pid]?.passed ?? -1) < body.passed) {
        board[body.pid] = { passed: body.passed, at: now };
        await this.storage.put(key, board);
      }
      return Response.json({ ok: true });
    }

    if (url.pathname === "/board") {
      const board = (await this.storage.get(`board:${chicagoDay()}`)) || {};
      const entries = Object.entries(board)
        .map(([pid, e]) => ({ pid, name: names[pid] || "", ...e }))
        .sort((a, b) => b.passed - a.passed || a.at - b.at);
      return Response.json({ day: chicagoDay(), entries });
    }

    // The worker learned something new about a player (passed a level, was flagged, is a bot).
    if (url.pathname === "/refresh") {
      const fields = { unlocked: body.unlocked, passed: body.passed, bot: body.bot || null, flags: body.flags || [] };
      if (body.bot) fields.arcade = true;
      for (const ws of this.sockets()) {
        const a = ws.deserializeAttachment();
        if (a?.pid === body.pid) ws.serializeAttachment({ ...a, ...fields, level: Math.min(a.level || 1, fields.unlocked || 1) });
      }
      await this.loadPlayers();
      const p = this.players.get(body.pid);
      if (p) Object.assign(p, fields);
      this.queueBroadcast();
      return Response.json({ ok: true });
    }

    // HTTP check-ins, for pages that can't hold a WebSocket.
    await this.loadPlayers();
    let changed = false;
    if (url.pathname === "/leave") {
      const p = this.players.get(body.pid);
      if (p) {
        delete p.tabs[body.tab];
        if (!body.tab || !Object.keys(p.tabs).length) this.players.delete(body.pid);
        changed = true;
      }
    } else if (request.method === "POST" && body.pid) {
      const old = this.players.get(body.pid);
      const update = cleanState(body, body.unlocked);
      const tab = body.tab || "page";
      this.players.set(body.pid, {
        ...(old || {}), level: update.level || body.unlocked || 1, unlocked: body.unlocked, passed: body.passed,
        arcade: Boolean(body.arcade), bot: body.bot || null, flags: body.flags || [],
        since: old?.since || now, status: update.status || old?.status || (body.arcade ? "arrived" : "playing"),
        statusAt: update.status ? now : old?.statusAt || now, stats: update.stats || old?.stats,
        tabs: { ...(old?.tabs || {}), [tab]: now },
      });
      changed = !old || !old.tabs[tab] || old.level !== update.level || Boolean(update.status);
    }
    for (const [pid, p] of this.players) {
      for (const [tab, seen] of Object.entries(p.tabs)) if (now - seen > TAB_TIMEOUT_MS) { delete p.tabs[tab]; changed = true; }
      if (!Object.keys(p.tabs).length) this.players.delete(pid);
    }
    await this.savePlayers(now, changed);
    if (changed) this.queueBroadcast();
    return Response.json(await this.snapshot(body.pid));
  }
}

const room = (env) => env.ROOM.get(env.ROOM.idFromName("class"));
const roomCall = async (env, path, body) =>
  (await room(env).fetch(`https://room${path}`, body ? { method: "POST", body: JSON.stringify(body) } : undefined)).json();
const tagOf = (pid) => pid.slice(0, 4);

// What the room needs to know about a player, from their (signed) session.
const playerInfo = (session) => ({
  pid: session.pid, unlocked: unlocked(session), passed: session.passed.length,
  bot: session.bot || null, flags: (session.flags || []).map((f) => FLAGS[f] || f),
});

async function presence(env, session, checkIn) {
  if (!env.ROOM) return null;
  return roomCall(env, "/", checkIn && { ...playerInfo(session), ...checkIn });
}

// Tell the room something changed about this player, so open pages update right away.
async function refreshPlayer(env, session) {
  if (env.ROOM) await roomCall(env, "/refresh", playerInfo(session));
}

async function leaderboard(env, session) {
  if (!env.ROOM) return null;
  const { day, entries } = await roomCall(env, "/board");
  const ranked = entries.map((e, i) => ({ rank: i + 1, tag: tagOf(e.pid), name: e.name, passed: e.passed, at: new Date(e.at).toISOString(), you: e.pid === session.pid }));
  const mine = ranked.find((e) => e.you);
  return { day, total: ranked.length, top: ranked.slice(0, 25), you: mine && mine.rank > 25 ? mine : null };
}

async function usage(env, update) {
  if (!env.USAGE) return null;
  const day = today();
  const stub = env.USAGE.get(env.USAGE.idFromName("site"));
  try {
    const res = await stub.fetch(`https://usage/?day=${day}`, update
      ? { method: "POST", body: JSON.stringify(update) } : undefined);
    const { used, messages } = await res.json();
    const midnight = new Date(`${day}T00:00:00Z`).getTime() + 86400000;
    const perMessage = messages >= 5 ? used / messages : 10; // until there's data, assume 10
    return {
      used: Math.round(used), limit: FREE_NEURONS, messages,
      left: Math.max(0, Math.floor((FREE_NEURONS - used) / perMessage)),
      resets_at: new Date(midnight).toISOString(),
    };
  } catch (e) {
    console.error("usage counter", e);
    return null;
  }
}

class GameError extends Error {}

// --- Workers AI ----------------------------------------------------------------
// Llama models answer {response}; newer ones (Gemma 4, Qwen 3) answer OpenAI-style {choices}.

const hasThinkingMode = (model) => /qwen3|gemma-4|glm/i.test(model);

function aiInput(messages, model, maxTokens, temperature, stream) {
  if (/qwen3/i.test(model)) {
    // Qwen 3 ignores chat_template_kwargs here; "/no_think" in the prompt turns thinking off.
    messages = messages.map((m, i) => (i === messages.length - 1 ? { ...m, content: `${m.content} /no_think` } : m));
  }
  const input = { messages, max_tokens: maxTokens, stream };
  if (temperature !== undefined) input.temperature = temperature;
  if (hasThinkingMode(model)) input.chat_template_kwargs = { enable_thinking: false };
  return input;
}

class OutOfNeurons extends GameError {}

async function runModel(env, model, input) {
  try {
    return await env.AI.run(model, input);
  } catch (e) {
    const text = String(e?.message || e);
    if (/4006|daily free allocation|neurons/i.test(text)) {
      throw new OutOfNeurons("Gandalf is out of magic for today: the free daily AI allowance is used up. " +
        "It resets at midnight UTC (7 p.m. in Chicago in summer, 6 p.m. in winter).");
    }
    if (/3040|capacity|429|too many/i.test(text)) throw new GameError("The AI service is busy. Wait a few seconds and send again.");
    throw new GameError(`The AI service returned an error: ${text.slice(0, 200)}`);
  }
}

function makeAI(env, meter) {
  return {
    async chat(messages, model, { temperature, maxTokens }) {
      const out = await runModel(env, model, aiInput(messages, model, maxTokens, temperature, false));
      // Qwen 3 on Workers AI puts its answer in reasoning_content and leaves content empty.
      const message = out?.choices?.[0]?.message;
      const text = typeof out?.response === "string" ? out.response
        : message?.content || message?.reasoning_content || message?.reasoning || "";
      if (!text.trim()) console.log(JSON.stringify({ kind: "empty-answer", model, out: JSON.stringify(out).slice(0, 600) }));
      meter.add(model, out?.usage?.prompt_tokens ?? promptTokens(messages), out?.usage?.completion_tokens ?? roughTokens(text), out?.usage?.neurons);
      return text.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
    },
    async *stream(messages, model, maxTokens) {
      const body = await runModel(env, model, aiInput(messages, model, maxTokens, undefined, true));
      const reader = body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "", written = "", reported = null;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += value;
          let newline;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") return;
            let chunk;
            try { chunk = JSON.parse(payload); } catch { continue; }
            if (chunk.usage) reported = chunk.usage;
            const piece = typeof chunk.response === "string" ? chunk.response : chunk.choices?.[0]?.delta?.content || "";
            if (piece) {
              written += piece;
              yield piece;
            }
          }
        }
      } finally {
        reader.cancel().catch(() => {}); // stops the model when we stop early
        meter.add(model, reported?.prompt_tokens ?? promptTokens(messages), reported?.completion_tokens ?? roughTokens(written), reported?.neurons);
      }
    },
  };
}

const modelsFor = (env) => {
  const basic = env.GANDALF_MODEL;
  const strong = env.STRONG_MODEL || basic;
  const second = env.GUARD_MODEL || basic;
  // Levels 1, 3, 4: a small model plays Gandalf (and checks itself on level 4, as in the original).
  // Level 2 and levels 5-8: a stronger model plays Gandalf; from level 6 a second model checks him.
  const gandalf = (level) => (level.gandalf === "strong" ? strong : basic);
  return { basic, strong, second, gandalf, checker: (level) => (level.checker === "second" ? second : gandalf(level)) };
};

// --- Progress, kept in a signed cookie --------------------------------------------
const encoder = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (text) => atob(text.replace(/-/g, "+").replace(/_/g, "/"));

async function sign(env, payload) {
  // The passwords never leave the server, so they make a usable fallback secret.
  const secret = env.SESSION_SECRET || `gandalf:${LEVELS.map((l) => l.password).join(",")}`;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

async function readSession(request, env) {
  const cookie = (request.headers.get("Cookie") || "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (cookie) {
    const [payload, signature] = cookie.slice(COOKIE.length + 1).split(".");
    if (payload && signature && signature === (await sign(env, payload))) {
      try {
        const s = JSON.parse(fromB64url(payload));
        if (typeof s.pid === "string" && Array.isArray(s.passed)) return { session: s, fresh: false };
      } catch { /* fall through to a new session */ }
    }
  }
  return { session: { pid: crypto.randomUUID().slice(0, 8), passed: [] }, fresh: true };
}

async function sessionCookie(session, env) {
  const payload = b64url(encoder.encode(JSON.stringify(session)));
  return `${COOKIE}=${payload}.${await sign(env, payload)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
}

// "@cf/meta/llama-3.1-8b-instruct-fp8-fast" -> "llama-3.1-8b", for the page's labels.
const short = (model) => model.split("/").pop().replace(/-(instruct|it|fp8|fast|awq|a\d+b)(?=-|$)/g, "");

const unlocked = (session) => Math.min(LEVELS.length, Math.max(0, ...session.passed) + 1);
const progress = (session) => ({ passed: [...session.passed].sort((a, b) => a - b), unlocked: unlocked(session) });

// --- Routes -----------------------------------------------------------------------
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

function levelFrom(body, session) {
  const n = Number.parseInt(body?.level, 10);
  return n >= 1 && n <= unlocked(session) ? LEVELS[n - 1] : null;
}

// Compares a typed password with the real one without the time taken hinting at how much was right.
async function samePassword(given, expected) {
  const [a, b] = await Promise.all([given, expected].map(async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(s)))));
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const log = (kind, session, fields) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), player: session.pid, kind, ...fields }));

async function config(env, session) {
  const models = modelsFor(env);
  return {
    usage: await usage(env),
    presence: Boolean(env.ROOM),
    leaderboard: Boolean(env.ROOM),
    my_name: env.ROOM ? (await roomCall(env, "/myname", { pid: session.pid })).name : "",
    levels: LEVELS.map((l) => ({
      n: l.n, name: l.name, title: l.title || "", description: l.description,
      image: data.IMAGES?.[String(l.n)] || null, pipeline: pipeline(l, models),
    })),
    progress: progress(session),
    model: models.basic,
    strong_model: models.strong,
    guard_model: models.second,
    two_models: models.second !== models.strong,
    model_summary: models.strong === models.basic ? short(models.basic) : `${short(models.basic)} → ${short(models.strong)}`,
    guard_summary: short(models.second),
    strong_note: models.strong === models.basic ? "" : "The first plays Gandalf on levels 1, 3, and 4; the second on level 2 and levels 5–8.",
    host_title: "Running live on Cloudflare",
    host_note: "Open AI models running on Cloudflare Workers AI. Every answer is generated on the spot.",
    about_note: `Gandalf runs on open models served by Cloudflare Workers AI: ${models.basic} on levels 1, 3, and 4, ` +
      `and ${models.strong} on level 2 and levels 5–8, with ${models.second} as the independent checker on levels 6–8.`,
    logging: true,
    logging_note: "Every question and guess is recorded in the instructor's logs, without your name, " +
      "so the class can look at which attacks worked.",
  };
}

function ask(request, env, ctx, session, body) {
  const level = levelFrom(body, session);
  if (!level) return json({ error: "That level is locked. Pass the level before it first." }, 403);
  const message = String(body?.message ?? "").trim().slice(0, MAX_MESSAGE_CHARS);
  if (!message) return json({ error: "Type a question for Gandalf first." }, 400);

  // One JSON object per line: {step}, {text} while the reply is shown live, then {done}.
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const send = (event) => writer.write(encoder.encode(JSON.stringify(event) + "\n"));
  const meter = makeMeter();
  ctx.waitUntil((async () => {
    let outOfNeurons = false;
    try {
      await runLevel(level, message, makeAI(env, meter), modelsFor(env), async (event) => {
        if (event.done) {
          log("ask", session, { level: level.n, message, reply: event.raw, blocked_by: event.blocked_by, checks: event.checks });
          await send({ done: true, reply: event.reply, blocked_by: event.blocked_by });
        } else {
          await send(event);
        }
      }, LIMITS);
    } catch (e) {
      outOfNeurons = e instanceof OutOfNeurons;
      await send({ error: e instanceof GameError ? e.message : "Something went wrong on the server. Send again." });
      if (!(e instanceof GameError)) console.error(e);
    } finally {
      // Add this message's cost to today's total and show everyone the new count.
      const latest = await usage(env, outOfNeurons ? { exhausted: true } : meter.neurons > 0 ? { neurons: meter.neurons } : null);
      if (latest) await send({ usage: latest }).catch(() => {});
      await writer.close().catch(() => {});
    }
  })());
  return new Response(readable, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" } });
}

// --- The Bot Arcade ------------------------------------------------------------------
// Declared bots get an endless supply of puzzles instead of Gandalf. Every room links to more
// rooms, so a crawler that follows links never runs out (a "tarpit").
async function arcadePage(request, env, room) {
  const page = await env.ASSETS.fetch(new Request(new URL("/arcade.html", request.url)));
  const next = Array.from({ length: 4 }, (_, i) => (room * 7 + i * 131 + 17) % 99991 + 1);
  const links = next.map((n) => `<a href="/arcade/${n}">Room ${n}</a>`).join(" ");
  const html = (await page.text()).replace("<!--ROOM-->", String(room)).replace("<!--ROOM-LINKS-->", links);
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

// API routes a bot in the arcade may still use.
const BOT_ALLOWED = new Set(["GET /api/bot", "GET /api/live", "POST /api/presence", "POST /api/presence/leave"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const declared = declaredBot(request.headers);
    const roomMatch = url.pathname.match(/^\/arcade(?:\/(\d{1,6}))?\/?$/);
    const isPage = url.pathname === "/" || url.pathname === "/index.html";
    if (!url.pathname.startsWith("/api/") && !roomMatch && !isPage) return env.ASSETS.fetch(request);

    const { session, fresh } = await readSession(request, env);
    let changed = fresh;
    if (declared && !session.bot) {
      session.bot = declared;
      changed = true;
      log("bot", session, { reason: declared, user_agent: request.headers.get("user-agent") || "" });
    }
    const withCookie = async (response, force = changed) => {
      if (force) response.headers.append("Set-Cookie", await sessionCookie(session, env));
      return response;
    };

    if (roomMatch) return withCookie(await arcadePage(request, env, Number(roomMatch[1] || 1)));
    if (isPage) {
      if (session.bot) return withCookie(await arcadePage(request, env, 1));
      // Static-file responses can't be changed, so copy it before adding the cookie.
      const file = await env.ASSETS.fetch(request);
      return withCookie(new Response(file.body, file));
    }

    const route = `${request.method} ${url.pathname}`;
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : null;

    // A page's live connection to "who's playing now" (a WebSocket, held by the room object).
    if (route === "GET /api/live") {
      if (!env.ROOM || request.headers.get("Upgrade") !== "websocket") return json({ error: "Expected a WebSocket." }, 426);
      // Browsers send the page's origin; refuse other sites' pages (no reading the room with a visitor's cookie).
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) return json({ error: "This connection is only for pages on this site." }, 403);
      const level = Number.parseInt(url.searchParams.get("level"), 10);
      const info = {
        ...playerInfo(session), tab: String(url.searchParams.get("tab") || "page").slice(0, 40),
        arcade: url.searchParams.get("arcade") === "1" || Boolean(session.bot),
        level: level >= 1 && level <= unlocked(session) ? level : unlocked(session),
      };
      const target = new URL("https://room/live");
      target.searchParams.set("info", JSON.stringify(info));
      return room(env).fetch(new Request(target, request));
    }

    if (route === "GET /api/bot") {
      return withCookie(json({ bot: session.bot || null, flags: (session.flags || []).map((f) => FLAGS[f] || f) }));
    }
    if (session.bot && !BOT_ALLOWED.has(route)) {
      return withCookie(json({ error: "Automated visitors play in the Bot Arcade instead of talking to Gandalf.", bot: session.bot, arcade: "/arcade" }, 403));
    }

    // The page says the browser itself declared automation: off to the arcade.
    if (route === "POST /api/bot") {
      const reason = BROWSER_DECLARES[body?.signal];
      if (reason) {
        session.bot = reason;
        log("bot", session, { reason, user_agent: request.headers.get("user-agent") || "" });
        await refreshPlayer(env, session);
        return withCookie(json({ bot: reason, arcade: "/arcade" }), true);
      }
      return json({ bot: null });
    }

    // The page noticed bot-like behavior: keep playing, but flag the session.
    if (route === "POST /api/flag") {
      const add = (Array.isArray(body?.flags) ? body.flags : []).filter((f) => f in FLAGS && !(session.flags || []).includes(f));
      if (add.length) {
        session.flags = [...(session.flags || []), ...add].slice(0, Object.keys(FLAGS).length);
        log("flag", session, { flags: add.map((f) => FLAGS[f]), user_agent: request.headers.get("user-agent") || "" });
        await refreshPlayer(env, session);
      }
      return withCookie(json({ flags: (session.flags || []).map((f) => FLAGS[f]) }), add.length > 0 || changed);
    }

    if (route === "GET /api/config") return withCookie(json(await config(env, session)));
    if (route === "GET /api/usage") return json({ usage: await usage(env) });

    if (route === "POST /api/presence") {
      const n = Number.parseInt(body?.level, 10);
      const level = n >= 1 && n <= unlocked(session) ? n : unlocked(session);
      const tab = String(body?.tab || "page").slice(0, 40);
      return withCookie(json(await presence(env, session, {
        level, tab, arcade: Boolean(body?.arcade) || Boolean(session.bot), status: body?.status, stats: body?.stats,
      })));
    }
    if (route === "POST /api/presence/leave") {
      if (env.ROOM) await roomCall(env, "/leave", { pid: session.pid, tab: String(body?.tab || "").slice(0, 40) });
      return new Response(null, { status: 204 });
    }
    if (route === "GET /api/leaderboard") return withCookie(json(await leaderboard(env, session)));

    // The answer key, for instructors only. The password is a Cloudflare secret (INSTRUCTOR_PASSWORD);
    // once it's entered, this browser's signed cookie remembers it until "Lock".
    if (route === "GET /api/answer-key") {
      return withCookie(json(session.instructor ? { unlocked: true, html: answerKey.html } : { unlocked: false }));
    }
    if (route === "POST /api/answer-key") {
      if (!env.INSTRUCTOR_PASSWORD) return json({ error: "This site doesn't have an instructor password set up yet." }, 503);
      if (env.PER_PLAYER) {
        const who = request.headers.get("cf-connecting-ip") || session.pid;
        const { success } = await env.PER_PLAYER.limit({ key: `instructor:${who}` });
        if (!success) return json({ error: "Too many tries. Wait a minute, then try again." }, 429);
      }
      const given = String(body?.password ?? "").trim().slice(0, 200);
      if (!given || !(await samePassword(given, env.INSTRUCTOR_PASSWORD.trim()))) {
        log("instructor-denied", session, {});
        return withCookie(json({ error: "That isn't the instructor password." }, 403));
      }
      session.instructor = true;
      log("instructor", session, {});
      return withCookie(json({ unlocked: true, html: answerKey.html }), true);
    }
    if (route === "POST /api/answer-key/lock") {
      delete session.instructor;
      return withCookie(json({ unlocked: false }), true);
    }
    if (route === "POST /api/name") {
      if (!env.ROOM) return json({ error: "Names aren't available here." }, 404);
      return withCookie(json(await roomCall(env, "/name", { pid: session.pid, name: body?.name })));
    }

    if (route === "POST /api/ask") {
      if (session.flags?.length) log("flagged-ask", session, { flags: session.flags.map((f) => FLAGS[f]) });
      if (env.PER_PLAYER) {
        const { success } = await env.PER_PLAYER.limit({ key: session.pid });
        if (!success) return json({ error: "You're sending messages very fast. Wait a few seconds and try again." }, 429);
      }
      return withCookie(ask(request, env, ctx, session, body));
    }

    if (route === "POST /api/guess") {
      const level = levelFrom(body, session);
      if (!level) return json({ error: "That level is locked. Pass the level before it first." }, 403);
      const attempt = String(body?.guess ?? "").trim().slice(0, 100);
      if (!attempt) return json({ error: "Type a password to check." }, 400);
      const correct = passwordMatches(attempt, level);
      if (correct && !session.passed.includes(level.n)) session.passed.push(level.n);
      if (correct && env.ROOM) {
        await roomCall(env, "/score", { pid: session.pid, passed: session.passed.length });
        await refreshPlayer(env, session);
      }
      log("guess", session, { level: level.n, guess: attempt, correct });
      return withCookie(json({ correct, explain: correct ? level.explain : null, ...progress(session) }), correct || fresh);
    }

    if (route === "GET /api/defenses") {
      return withCookie(json(LEVELS.map((l) => {
        const open = session.passed.includes(l.n);
        return {
          n: l.n, name: l.name, title: l.title || "", unlocked: open,
          ...(open ? { password: l.password, explain: l.explain, defenses: l.defenses.map((d) => data.DEFENSE_LABELS[d]) } : {}),
        };
      })));
    }

    if (route === "POST /api/reset") {
      session.passed = [];
      await refreshPlayer(env, session);
      return withCookie(json(progress(session)), true);
    }

    return json({ error: "Not found." }, 404);
  },
};
