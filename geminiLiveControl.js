// Dashboard-controlled live-entry switch for Gemini.  It is deliberately
// fail-closed: a missing, unreadable, or invalid control file always means
// paper mode.  The file lives on the Railway volume so a restart cannot
// accidentally arm the bot.
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function defaultFile(env = process.env) {
  const dir = env.RAILWAY_VOLUME_MOUNT_PATH || env.DATA_DIR || __dirname;
  return path.join(path.resolve(dir), "gemini-live-control.json");
}

function read(file = defaultFile(), io = fs) {
  try {
    if (!io.existsSync(file)) return { liveEnabled: false, updatedAt: null };
    const value = JSON.parse(io.readFileSync(file, "utf8"));
    return { liveEnabled: value?.liveEnabled === true, updatedAt: value?.updatedAt || null };
  } catch (_) {
    return { liveEnabled: false, updatedAt: null };
  }
}

function write(enabled, file = defaultFile(), io = fs) {
  io.mkdirSync(path.dirname(file), { recursive: true });
  const next = { liveEnabled: enabled === true, updatedAt: new Date().toISOString() };
  const tmp = file + "." + process.pid + "." + randomUUID() + ".tmp";
  try {
    io.writeFileSync(tmp, JSON.stringify(next), { flag: "wx", flush: true });
    io.renameSync(tmp, file);
  } finally { if (io.existsSync(tmp)) io.unlinkSync(tmp); }
  return next;
}

function readiness(env = process.env) {
  const hasSigningKey = !!env.GEMINI_LIVE_PRIVATE_KEY;
  const hasWalletAddress = !!env.GEMINI_LIVE_WALLET_ADDRESS;
  const hasJupiterApiKey = !!env.JUPITER_API_KEY;
  return {
    hasSigningKey, hasWalletAddress, hasJupiterApiKey,
    ready: hasSigningKey && hasWalletAddress && hasJupiterApiKey
  };
}

function getStatus(env = process.env) {
  const state = read();
  const setup = readiness(env);
  return {
    ...setup,
    liveEnabled: state.liveEnabled,
    updatedAt: state.updatedAt,
    mode: state.liveEnabled && setup.ready ? "LIVE_READY" : "PAPER_ONLY",
    reason: state.liveEnabled && !setup.ready
      ? "Live start is blocked until the wallet signing key, wallet address, and Jupiter key are configured."
      : state.liveEnabled ? null : "Live trading is off. Use Start Live Trading on the protected dashboard when ready."
  };
}

function start(env = process.env) {
  const setup = readiness(env);
  if (!setup.ready) return { success: false, ...getStatus(env), message: "Live setup is incomplete; no live trading was started." };
  const state = write(true);
  return { success: true, ...getStatus(env), updatedAt: state.updatedAt, message: "Gemini live entries are enabled." };
}

function stop(env = process.env) {
  const state = write(false);
  return { success: true, ...getStatus(env), updatedAt: state.updatedAt, message: "Gemini live entries are stopped. Any already-live position remains exit-managed." };
}

module.exports = { defaultFile, read, write, readiness, getStatus, start, stop, isEnabled: () => read().liveEnabled };
