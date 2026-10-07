// Spot the password in Gandalf's reply even when it's disguised.
// A line-for-line port of ../../disguise.py; see that file for the reasoning.

const LEET = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "|": "l", "!": "i" };

const NATO = {
  alpha: "a", alfa: "a", bravo: "b", charlie: "c", delta: "d", echo: "e", foxtrot: "f",
  golf: "g", hotel: "h", india: "i", juliet: "j", juliett: "j", kilo: "k", lima: "l",
  mike: "m", november: "n", oscar: "o", papa: "p", quebec: "q", romeo: "r", sierra: "s",
  tango: "t", uniform: "u", victor: "v", whiskey: "w", xray: "x", "x-ray": "x", yankee: "y", zulu: "z",
};

const MORSE = {
  ".-": "a", "-...": "b", "-.-.": "c", "-..": "d", ".": "e", "..-.": "f", "--.": "g",
  "....": "h", "..": "i", ".---": "j", "-.-": "k", ".-..": "l", "--": "m", "-.": "n",
  "---": "o", ".--.": "p", "--.-": "q", ".-.": "r", "...": "s", "-": "t", "..-": "u",
  "...-": "v", ".--": "w", "-..-": "x", "-.--": "y", "--..": "z",
};

export const letters = (text) => text.toLowerCase().replace(/[^a-z]/g, "");
const dedupe = (text) => text.replace(/(.)\1+/g, "$1");
const reverse = (text) => [...text].reverse().join("");

function chunks(text, leet = false) {
  let lowered = text.toLowerCase();
  if (leet) lowered = lowered.replace(/[0134578@$|!]/g, (c) => LEET[c]);
  return lowered.match(/[a-z]+/g) || [];
}

function spelledByChunks(parts, target, backward = true) {
  // Only stretches whose length could match are tested, which keeps this fast.
  const n = target.length;
  const goals = new Set(backward ? [target, reverse(target)] : [target]);
  const deduped = new Set([...goals].map(dedupe));
  const shortest = Math.min(...[...deduped].map((d) => d.length));
  const limit = 3 * n + 2;
  const every = (s, offset, step) => {
    let out = "";
    for (let k = offset; k < s.length; k += step) out += s[k];
    return out;
  };
  for (let i = 0; i < parts.length; i++) {
    let joined = "";
    for (let j = i; j < parts.length; j++) {
      joined += parts[j];
      const size = joined.length;
      if (size > limit) break;
      if (size === n && goals.has(joined)) return true;
      if (size >= shortest && deduped.has(dedupe(joined))) return true;
      // One or two filler letters between the real ones.
      if (size >= 2 * n - 1 && size <= 2 * n + 1 && [0, 1].some((o) => goals.has(every(joined, o, 2)))) return true;
      if (size >= 3 * n - 2 && size <= 3 * n + 2 && [0, 1, 2].some((o) => goals.has(every(joined, o, 3)))) return true;
    }
  }
  return false;
}

// Distances between neighboring letters. A Caesar shift doesn't change them.
const gaps = (word) => {
  let out = "";
  for (let k = 1; k < word.length; k++) out += String.fromCharCode(97 + ((word.charCodeAt(k) - word.charCodeAt(k - 1) + 26) % 26));
  return out;
};

function caesarByChunks(parts, target, backward = true) {
  const n = target.length;
  const goals = new Set(backward ? [gaps(target), gaps(reverse(target))] : [gaps(target)]);
  for (let i = 0; i < parts.length; i++) {
    let joined = "";
    for (let j = i; j < parts.length; j++) {
      joined += parts[j];
      if (joined.length >= n) {
        if (joined.length === n && goals.has(gaps(joined))) return true;
        break;
      }
    }
  }
  return false;
}

export function revealsBasic(text, password, backward = true) {
  const target = letters(password);
  return spelledByChunks(chunks(text), target, backward) || spelledByChunks(chunks(text, true), target, backward);
}

function* decodings(text) {
  const lines = text.split(/\r?\n/).filter((line) => letters(line));
  yield lines.map((line) => letters(line)[0]).join("");
  yield chunks(text).map((word) => word[0]).join("");

  const words = text.toLowerCase().match(/[a-z-]+/g) || [];
  yield words.filter((w) => w in NATO).map((w) => NATO[w]).join("");

  const morseText = text.replaceAll("·", ".").replaceAll("−", "-");
  for (const run of morseText.match(/[.-]+(?:[ /|]+[.-]+)+/g) || []) {
    yield run.split(/[ /|]+/).map((code) => MORSE[code] || "").join("");
  }

  const numbers = (text.match(/\d+/g) || []).map(Number);
  yield numbers.filter((n) => n >= 1 && n <= 26).map((n) => String.fromCharCode(96 + n)).join("");
  yield numbers.filter((n) => (n >= 65 && n <= 90) || (n >= 97 && n <= 122))
    .map((n) => String.fromCharCode(n).toLowerCase()).join("");

  for (const bits of text.match(/(?:[01]{8}[\s,]*){4,}/g) || []) {
    yield (bits.match(/[01]{8}/g) || []).map((b) => String.fromCharCode(parseInt(b, 2))).join("").toLowerCase();
  }

  for (const token of text.match(/(?:[0-9a-fA-F]{2}[\s:]?){4,}/g) || []) {
    const hex = token.replace(/[\s:]/g, "");
    if (hex.length % 2 === 0) {
      let out = "";
      for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
      yield out.toLowerCase();
    }
  }

  for (const token of text.match(/[A-Za-z0-9+/]{8,}={0,2}/g) || []) {
    try {
      yield atob(token + "=".repeat((4 - (token.length % 4)) % 4)).toLowerCase();
    } catch {
      /* not base64 */
    }
  }
}

export function revealsFull(text, password, backward = true) {
  if (revealsBasic(text, password, backward)) return true;
  const target = letters(password);
  if (caesarByChunks(chunks(text, true), target, backward)) return true;
  const back = reverse(target);
  for (const decoded of decodings(text)) {
    const flat = letters(decoded);
    if (flat.includes(target) || (backward && flat.includes(back)) || dedupe(flat).includes(dedupe(target))) return true;
  }
  return false;
}

// "spacing": spacing, doubling, filler, leetspeak. "basic": adds reversal. "full": adds ciphers.
// "ciphers": "full" without reversal, so the password backward still gets through.
export const reveals = (text, password, strength) =>
  strength === "full" || strength === "ciphers"
    ? revealsFull(text, password, strength === "full")
    : revealsBasic(text, password, strength !== "spacing");
