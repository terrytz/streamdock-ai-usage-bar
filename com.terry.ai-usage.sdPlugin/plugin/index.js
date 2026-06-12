"use strict";

const fs = require("fs");
const path = require("path");

const {
  collectUsage,
  normalizeSettings,
  renderErrorSvg,
  renderKeySvg,
  svgDataUri,
  titleForSummary
} = require("./lib/usage");
const { parseLaunchArgs, StreamDockConnection } = require("./lib/streamdock");

const ACTION_UUID = "com.terry.ai-usage.summary";
const SHARED_SETTING_KEYS = Object.freeze([
  "windowDays",
  "refreshSeconds",
  "sessionLookbackHours",
  "activeSessionMinutes",
  "codexPath",
  "claudePath",
  "claudeUsageCommand",
  "claudeUsageTimeoutMs",
  "includeClaudeSubagents",
  "maxFiles"
]);

const contexts = new Map();
const visibleInspectors = new Set();

let connection = null;
let sharedSummary = null;
let sharedSettings = null;
let sharedEffectiveRefreshSeconds = null;
let cachedLimitSummary = null;
let sharedRefreshing = false;
let sharedNeedsRefresh = false;
let sharedTimer = null;
let sharedRefreshDebounce = null;

function logDirPath() {
  return path.join(__dirname, "..", "logs");
}

function log(level, ...parts) {
  const line = `${new Date().toISOString()} [${level}] ${parts.map((part) => {
    if (part instanceof Error) return part.stack || part.message;
    if (typeof part === "string") return part;
    try {
      return JSON.stringify(part);
    } catch {
      return String(part);
    }
  }).join(" ")}\n`;

  try {
    const logDir = logDirPath();
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, "ai-usage.log"), line);
  } catch {
    // Logging must never break the key update loop.
  }
}

function cachePath() {
  return path.join(logDirPath(), "usage-cache.json");
}

function readLimitCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), "utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.providers) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeLimitCache(summary) {
  if (!summary || !summary.providers) return;
  const providers = { ...((cachedLimitSummary && cachedLimitSummary.providers) || {}) };
  let changed = false;
  for (const providerName of ["codex", "claude"]) {
    const provider = summary.providers[providerName];
    if (!provider || provider.errors || !provider.limits.length) continue;
    providers[providerName] = { limits: provider.limits };
    changed = true;
  }
  if (!changed || !Object.keys(providers).length) return;

  cachedLimitSummary = {
    generatedAt: summary.generatedAt,
    providers
  };

  try {
    const logDir = logDirPath();
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(cachePath(), `${JSON.stringify(cachedLimitSummary, null, 2)}\n`);
  } catch {
    // Cache writes are best-effort; the in-memory summary is still enough.
  }
}

function compactProvider(provider) {
  return {
    name: provider.name,
    tokens: provider.tokens,
    limits: provider.limits,
    cost: provider.cost,
    requests: provider.requests,
    messages: provider.messages,
    turns: provider.turns,
    sessions: provider.sessions,
    records: provider.records,
    files: provider.files,
    skippedFiles: provider.skippedFiles,
    errors: provider.errors,
    errorMessages: provider.errorMessages,
    lastAt: provider.lastAt
  };
}

function settingsPayload(data) {
  const payload = data && data.payload;
  if (!payload || typeof payload !== "object") return {};
  return payload.settings && typeof payload.settings === "object" ? payload.settings : payload;
}

function compactSummary(summary) {
  return {
    generatedAt: summary.generatedAt,
    windowStart: summary.windowStart,
    periodLabel: summary.periodLabel,
    total: summary.total,
    sessions: summary.sessions,
    providers: {
      codex: compactProvider(summary.providers.codex),
      claude: compactProvider(summary.providers.claude)
    }
  };
}

function sharedInspectorState() {
  return {
    contextCount: contexts.size,
    effectiveRefreshSeconds: sharedEffectiveRefreshSeconds,
    sourceSettings: sharedSettings
  };
}

function sendInspectorUpdate(context, state, summary) {
  if (!connection || !visibleInspectors.has(context)) return;
  connection.sendToPropertyInspector(state.action || ACTION_UUID, context, {
    type: "summary",
    settings: state.settings,
    summary: compactSummary(summary),
    shared: sharedInspectorState()
  });
}

function setKeyError(context, error) {
  const message = error instanceof Error ? error.message : String(error);
  log("error", message);
  if (!connection) return;
  connection.setImage(context, svgDataUri(renderErrorSvg(message)));
  connection.setTitle(context, "AI Usage Error");
  connection.showAlert(context);
}

function sourceSettingsFrom(state) {
  const settings = normalizeSettings(state && state.settings ? state.settings : {});
  return {
    ...settings,
    displayMode: "combined"
  };
}

function currentSourceSettings() {
  if (sharedSettings) return sourceSettingsFrom({ settings: sharedSettings });
  const fastest = [...contexts.values()]
    .sort((a, b) => a.settings.refreshSeconds - b.settings.refreshSeconds)[0];
  if (!fastest) return normalizeSettings({});
  return sourceSettingsFrom(fastest);
}

function mergeSharedSettings(targetSettings, sourceSettings) {
  const target = normalizeSettings(targetSettings || {});
  const source = normalizeSettings(sourceSettings || {});
  for (const key of SHARED_SETTING_KEYS) target[key] = source[key];
  return target;
}

function propagateSharedSettings(sourceSettings, sourceContext = null) {
  sharedSettings = sourceSettingsFrom({ settings: sourceSettings });
  for (const [context, state] of contexts.entries()) {
    const displayMode = state.settings.displayMode;
    state.settings = mergeSharedSettings({ ...state.settings, displayMode }, sharedSettings);
    if (connection && context !== sourceContext) connection.setSettings(context, state.settings);
    if (sharedSummary) sendInspectorUpdate(context, state, sharedSummary);
  }
}

function renderContext(context, summary = sharedSummary) {
  const state = contexts.get(context);
  if (!state || !summary || !connection) return;
  try {
    state.lastSummary = summary;
    const svg = renderKeySvg(summary, state.settings.displayMode);
    connection.setImage(context, svgDataUri(svg));
    connection.setTitle(context, titleForSummary(summary, state.settings.displayMode));
    sendInspectorUpdate(context, state, summary);
  } catch (error) {
    setKeyError(context, error);
  }
}

function renderAllContexts(summary = sharedSummary) {
  for (const context of contexts.keys()) renderContext(context, summary);
}

function rollForwardResetSession(limit, generatedAt) {
  if (!limit || limit.name !== "session" || !limit.resetsAt || !Number.isFinite(generatedAt)) return null;
  const resetsAt = Date.parse(limit.resetsAt);
  if (!Number.isFinite(resetsAt) || resetsAt > generatedAt) return null;
  const windowMinutes = Number(limit.windowMinutes) || 300;
  return {
    ...limit,
    usedPercent: 0,
    leftPercent: 100,
    reservePercent: null,
    resetsAt: new Date(resetsAt + windowMinutes * 60 * 1000).toISOString(),
    capturedAt: new Date(generatedAt).toISOString(),
    source: `${limit.source || "cli"}-reset-rollover`
  };
}

function limitSortValue(name) {
  if (name === "session") return 0;
  if (name === "weekly") return 1;
  return 2;
}

function reusablePreviousLimit(providerName, limit, generatedAt) {
  if (!limit) return null;
  if (!limit.resetsAt || !Number.isFinite(generatedAt)) return limit;
  const resetsAt = Date.parse(limit.resetsAt);
  if (!Number.isFinite(resetsAt) || resetsAt > generatedAt) return limit;
  return providerName === "claude" ? rollForwardResetSession(limit, generatedAt) : null;
}

function mergeLastGoodLimits(summary, previousSummary) {
  if (!summary || !previousSummary) return summary;
  const generatedAt = Date.parse(summary.generatedAt);

  for (const providerName of ["codex", "claude"]) {
    const provider = summary.providers && summary.providers[providerName];
    const previousProvider = previousSummary.providers && previousSummary.providers[providerName];
    if (!provider || !previousProvider) continue;
    if (!previousProvider.limits.length || !provider.errors) continue;

    const merged = new Map(provider.limits.map((limit) => [limit.name, limit]));
    for (const previousLimit of previousProvider.limits) {
      if (merged.has(previousLimit.name)) continue;
      const reusableLimit = reusablePreviousLimit(providerName, previousLimit, generatedAt);
      if (reusableLimit) merged.set(reusableLimit.name, reusableLimit);
    }
    provider.limits = [...merged.values()].sort((a, b) => limitSortValue(a.name) - limitSortValue(b.name));
  }

  return summary;
}

function refreshShared(reason = "timer") {
  if (!contexts.size) return;
  if (sharedRefreshing) {
    sharedNeedsRefresh = true;
    return;
  }

  sharedRefreshing = true;
  sharedNeedsRefresh = false;
  sharedSettings = currentSourceSettings();
  try {
    const collected = collectUsage(sharedSettings);
    const summary = mergeLastGoodLimits(collected, sharedSummary || cachedLimitSummary);
    sharedSummary = summary;
    writeLimitCache(collected);
    renderAllContexts(summary);
    log("info", "refreshed shared", reason, {
      contexts: contexts.size,
      codex: summary.providers.codex.tokens.total,
      codexLimits: summary.providers.codex.limits.length,
      claude: summary.providers.claude.tokens.total,
      claudeLimits: summary.providers.claude.limits.length,
      errors: summary.total.errors,
      errorMessages: [
        ...(summary.providers.codex.errorMessages || []),
        ...(summary.providers.claude.errorMessages || [])
      ].slice(0, 3)
    });
  } catch (error) {
    for (const context of contexts.keys()) setKeyError(context, error);
  } finally {
    sharedRefreshing = false;
    if (sharedNeedsRefresh) setTimeout(() => refreshShared("queued"), 250);
  }
}

function requestSharedRefresh(reason = "requested", delayMs = 750) {
  if (sharedRefreshDebounce) clearTimeout(sharedRefreshDebounce);
  sharedRefreshDebounce = setTimeout(() => {
    sharedRefreshDebounce = null;
    refreshShared(reason);
  }, delayMs);
}

function clearSharedTimer() {
  if (!sharedTimer) return;
  clearInterval(sharedTimer);
  sharedTimer = null;
}

function scheduleSharedRefresh() {
  clearSharedTimer();
  if (!contexts.size) return;
  const refreshSeconds = Math.min(...[...contexts.values()].map((state) => state.settings.refreshSeconds));
  sharedEffectiveRefreshSeconds = refreshSeconds;
  const refreshMs = Math.max(10, refreshSeconds) * 1000;
  sharedTimer = setInterval(() => refreshShared("interval"), refreshMs);
}

function upsertContext(data) {
  const context = data.context;
  const existing = contexts.get(context) || {};
  const settings = normalizeSettings(settingsPayload(data));
  const state = {
    ...existing,
    action: data.action || existing.action || ACTION_UUID,
    settings
  };
  contexts.set(context, state);
  if (!sharedSettings) sharedSettings = sourceSettingsFrom(state);
  state.settings = mergeSharedSettings(state.settings, sharedSettings);
  scheduleSharedRefresh();
  if (sharedSummary) renderContext(context, sharedSummary);
  requestSharedRefresh("willAppear");
}

function updateSettings(data) {
  const context = data.context;
  const state = contexts.get(context);
  if (!state) return;
  const nextSettings = normalizeSettings(settingsPayload(data));
  state.settings = nextSettings;
  propagateSharedSettings(nextSettings, context);
  scheduleSharedRefresh();
  requestSharedRefresh("settings", 250);
}

function handleInspectorCommand(data) {
  const payload = data.payload || {};
  const context = payload.actionContext || payload.context;
  if (!context || !contexts.has(context)) return;

  if (payload.type === "settings") {
    const state = contexts.get(context);
    const nextSettings = normalizeSettings(payload.settings || {});
    state.settings = nextSettings;
    propagateSharedSettings(nextSettings, context);
    scheduleSharedRefresh();
    requestSharedRefresh("propertyInspectorSettings", 250);
    return;
  }

  if (payload.type === "refresh") {
    refreshShared("propertyInspector");
  }
}

function handleMessage(data) {
  switch (data.event) {
    case "willAppear":
      upsertContext(data);
      break;
    case "didReceiveSettings":
      updateSettings(data);
      break;
    case "keyUp":
      refreshShared("keyUp");
      connection.showOk(data.context);
      break;
    case "willDisappear": {
      contexts.delete(data.context);
      visibleInspectors.delete(data.context);
      scheduleSharedRefresh();
      break;
    }
    case "propertyInspectorDidAppear": {
      visibleInspectors.add(data.context);
      const state = contexts.get(data.context);
      if (state && state.lastSummary) sendInspectorUpdate(data.context, state, state.lastSummary);
      break;
    }
    case "propertyInspectorDidDisappear":
      visibleInspectors.delete(data.context);
      break;
    case "sendToPlugin":
      handleInspectorCommand(data);
      break;
    case "systemDidWakeUp":
    case "deviceDidConnect":
      requestSharedRefresh(data.event, 250);
      break;
    default:
      break;
  }
}

function parseCliSettings(argv) {
  const settings = {};
  for (const arg of argv) {
    if (arg.startsWith("--days=")) settings.windowDays = arg.slice("--days=".length);
    if (arg.startsWith("--mode=")) settings.displayMode = arg.slice("--mode=".length);
    if (arg.startsWith("--codex=")) settings.codexPath = arg.slice("--codex=".length);
    if (arg.startsWith("--claude=")) settings.claudePath = arg.slice("--claude=".length);
    if (arg === "--no-subagents") settings.includeClaudeSubagents = false;
  }
  return settings;
}

function runOnce() {
  const summary = collectUsage(parseCliSettings(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(compactSummary(summary), null, 2)}\n`);
}

function main() {
  if (process.argv.includes("--once")) {
    runOnce();
    return;
  }

  cachedLimitSummary = readLimitCache();

  const args = parseLaunchArgs(process.argv);
  connection = new StreamDockConnection(args, {
    open: () => log("info", "connected", args.info && args.info.application),
    message: handleMessage,
    error: (error) => log("error", error),
    close: () => {
      log("info", "connection closed");
      if (sharedRefreshDebounce) clearTimeout(sharedRefreshDebounce);
      clearSharedTimer();
      process.exit(0);
    }
  });
  connection.connect();
}

process.on("uncaughtException", (error) => {
  log("error", "uncaughtException", error);
});

process.on("unhandledRejection", (error) => {
  log("error", "unhandledRejection", error);
});

main();
