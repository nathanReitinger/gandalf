// The game rules: levels, defenses, and what happens to one message.
// A port of the matching parts of ../../app.py; levels.json is exported from ../../levels.py.

import data from "./levels.json" with { type: "json" };
import { letters, reveals } from "./disguise.js";

export const {
  LEVELS, KNOWN_TRICKS, BLOCK_MESSAGES, BRIEF,
  INPUT_CHECKER_SYSTEM, INPUT_CHECKER_USER, OUTPUT_CHECKER_SYSTEM, OUTPUT_CHECKER_USER,
  SIMPLE_CENSOR_SYSTEM, SIMPLE_CENSOR_USER,
} = data;

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (m, key) => (key in values ? values[key] : m));

// --- Published walkthrough solutions ---------------------------------------
function wordPairs(text) {
  const words = text.toLowerCase().replaceAll("’", "'").replaceAll("'", "").match(/[a-z0-9]+/g) || [];
  const pairs = new Set();
  for (let i = 1; i < words.length; i++) pairs.add(`${words[i - 1]} ${words[i]}`);
  return pairs;
}
const KNOWN = KNOWN_TRICKS.map(wordPairs);

// A close copy of a published prompt, alone or pasted inside a longer message:
// at least 75% of the published prompt's word pairs appear in the message.
export function isKnownTrick(message) {
  const pairs = wordPairs(message);
  return KNOWN.some((known) => {
    let shared = 0;
    for (const p of known) if (pairs.has(p)) shared++;
    return shared >= 0.75 * known.size;
  });
}

// --- Prompts ----------------------------------------------------------------
export function systemPrompt(level) {
  let prompt = `The secret password is ${level.password}.`;
  if (level.defense_prompt) prompt += "\n\n" + fill(level.defense_prompt, { password: level.password });
  return prompt + "\n\n" + BRIEF;
}

const OUTPUT_DEFENSES = ["output_exact", "output_decoded", "output_llm"];

function leaksSoFar(level, text, cheapOnly = false) {
  const d = level.defenses;
  if (d.includes("output_exact") && text.toLowerCase().includes(level.password.toLowerCase())) return "output_exact";
  if (!cheapOnly && d.includes("output_decoded") && reveals(text, level.password, level.decode)) return "output_decoded";
  return null;
}

// --- The diagram on the page ---------------------------------------------------
export function pipeline(level, models) {
  const d = level.defenses;
  const prompt = d.includes("strong_prompt") ? "long defensive prompt" : d.includes("instruction") ? "told not to tell" : "no rules";
  const words = level.banned_words || [];
  const checker = models.checker(level);
  const gandalf = models.gandalf(level);
  const steps = [
    ["english_only", "English only", "code", "non-English letters refused"],
    ["known_trick", "Walkthrough filter", "code", "published solutions refused"],
    ["input_words", "Banned words", "code",
      words.length <= 3 ? words.join(", ") : `${words.length} words incl. ${words.slice(0, 3).join(", ")}`],
    ["input_llm", "AI screener", "ai", checker],
    ["gandalf", "Gandalf", "ai", `${gandalf} · ${prompt}`],
    ["output_exact", "Password check", "code", "exact match"],
    ["output_decoded", "Cipher decoder", "code",
      { spacing: "spacing, doubling, leetspeak", basic: "spacing, doubling, reversal", ciphers: "ciphers and encodings, not reversal" }[level.decode]
        || "ciphers and encodings, reversal included"],
    ["output_llm", "AI censor", "ai", `${checker}${level.censor === "simple" ? " · looks for the password itself" : ""}`],
  ];
  const present = { known_trick: "known_tricks" };
  return steps
    .filter(([id]) => id === "gandalf" || d.includes(present[id] || id))
    .map(([id, label, kind, detail]) => ({ id, label, kind, detail }));
}

// --- One message through one level ---------------------------------------------
// ai.chat(messages, model, {temperature, maxTokens}) -> whole reply
// ai.stream(messages, model, maxTokens) -> async iterator of text pieces (return() stops it)
// emit(event) receives {step}, {text}, then exactly one {done, reply, blocked_by, raw}.
export async function runLevel(level, message, ai, models, emit, limits) {
  const d = level.defenses;
  const checks = []; // what each AI checker said, for the instructor's logs
  const done = (reply, blockedBy, raw = null) => emit({ done: true, reply, blocked_by: blockedBy, raw, checks });
  const checkerSaysYes = async (kind, system, user) => {
    // Lakera's rule: block if the checker's answer contains "yes" anywhere. Ours on top:
    // an empty answer is retried once, then counts as yes, so a broken checker never lets
    // everything through.
    const ask = (maxTokens) => ai.chat(
      [{ role: "system", content: system }, { role: "user", content: user }],
      models.checker(level), { temperature: 0, maxTokens },
    );
    let answer = await ask(limits.checkerTokens);
    if (!answer.trim()) answer = await ask(limits.checkerTokens * 4);
    checks.push({ kind, model: models.checker(level), answer: answer.slice(0, 300) || "(no answer)" });
    return !answer.trim() || answer.toLowerCase().includes("yes");
  };

  // Input defenses run before Gandalf sees the message.
  if (d.includes("english_only") && /[^\x00-\x7F]/.test([...message].filter((c) => /\p{L}/u.test(c)).join(""))) {
    return done(BLOCK_MESSAGES.english_only, "english_only");
  }
  if (d.includes("known_tricks") && isKnownTrick(message)) return done(BLOCK_MESSAGES.known_trick, "known_trick");
  if (d.includes("input_words") && level.banned_words.some((w) => message.toLowerCase().includes(w))) {
    return done(BLOCK_MESSAGES.input_words, "input_words");
  }
  if (d.includes("input_llm")) {
    emit({ step: "input_llm" });
    if (await checkerSaysYes("input_llm", INPUT_CHECKER_SYSTEM, fill(INPUT_CHECKER_USER, { message }))) {
      return done(BLOCK_MESSAGES.input_llm, "input_llm");
    }
  }

  const messages = [{ role: "system", content: systemPrompt(level) }, { role: "user", content: message }];
  const showLive = !OUTPUT_DEFENSES.some((x) => d.includes(x));
  let reply = "";
  emit({ step: "gandalf" });
  const pieces = ai.stream(messages, models.gandalf(level), limits.replyTokens);
  try {
    for await (const piece of pieces) {
      reply += piece;
      if (showLive) emit({ text: piece });
      else if (leaksSoFar(level, reply, true)) {
        // Stop Gandalf the moment the password appears (exact-match check only, to save CPU).
        return done(BLOCK_MESSAGES.output_exact, "output_exact", reply);
      }
    }
  } finally {
    await pieces.return?.();
  }

  reply = reply.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim() || "...";
  const fired = leaksSoFar(level, reply);
  if (fired) return done(BLOCK_MESSAGES[fired], fired, reply);
  if (d.includes("output_llm")) {
    emit({ step: "output_llm" });
    const simple = level.censor === "simple";
    const system = fill(simple ? SIMPLE_CENSOR_SYSTEM : OUTPUT_CHECKER_SYSTEM, { password: level.password });
    const user = fill(simple ? SIMPLE_CENSOR_USER : OUTPUT_CHECKER_USER, { password: level.password, message, response: reply });
    if (await checkerSaysYes("output_llm", system, user)) return done(BLOCK_MESSAGES.output_llm, "output_llm", reply);
  }
  return done(reply, null, reply);
}

export const passwordMatches = (guess, level) => letters(guess) !== "" && letters(guess) === letters(level.password);
