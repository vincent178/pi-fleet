import { usageError } from "./errors.js";

export function splitCommandLine(source) {
  const tokens = [];
  let token = "";
  let quote;
  let escaped = false;
  let started = false;
  for (const character of source) {
    if (escaped) {
      token += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) tokens.push(token);
      token = "";
      started = false;
      continue;
    }
    token += character;
    started = true;
  }
  if (escaped) throw usageError("The command ends with an incomplete escape.");
  if (quote) throw usageError("The command contains an unclosed quote.");
  if (started) tokens.push(token);
  return tokens;
}

export function extractGlobalOptions(argv) {
  let root;
  let json = false;
  let index = 0;
  while (index < argv.length) {
    const argument = argv[index];
    if (argument === "--root") {
      root = argv[index + 1];
      if (!root) throw usageError("--root requires a path.");
      index += 2;
      continue;
    }
    if (argument === "--json") {
      json = true;
      index += 1;
      continue;
    }
    break;
  }
  return { root, json, rest: argv.slice(index) };
}

export function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw usageError(`${label} must be a positive integer.`);
  }
  return parsed;
}
