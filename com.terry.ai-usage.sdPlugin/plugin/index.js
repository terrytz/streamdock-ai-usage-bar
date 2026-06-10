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
const contexts = new Map();
const visibleInspectors = new Set();

let connection = null;

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
    const logDir = path.join(__dirname, "..", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, "ai-usage.log"), line);
  } catch {
    // Logging must never break the key update loop.
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

function sendInspectorUpdate(context, state, summary) {
  if (!connection || !visibleInspectors.has(context)) return;
  connection.sendToPropertyInspector(state.action || ACTION_UUID, context, {
    type: "summary",
    settings: state.settings,
    summary: compactSummary(summary)
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

function refreshContext(context, reason = "timer") {
  const state = contexts.get(context);
  if (!state) return;
  if (state.refreshing) {
    state.needsRefresh = true;
    return;
  }

  state.refreshing = true;
  state.needsRefresh = false;
  try {
    const summary = collectUsage(state.settings);
    state.lastSummary = summary;
    const svg = renderKeySvg(summary, state.settings.displayMode);
    connection.setImage(context, svgDataUri(svg));
    connection.setTitle(context, titleForSummary(summary, state.settings.displayMode));
    sendInspectorUpdate(context, state, summary);
    log("info", "refreshed", context, reason, {
      codex: summary.providers.codex.tokens.total,
      claude: summary.providers.claude.tokens.total,
      errors: summary.total.errors
    });
  } catch (error) {
    setKeyError(context, error);
  } finally {
    state.refreshing = false;
    if (state.needsRefresh) {
      setTimeout(() => refreshContext(context, "queued"), 250);
    }
  }
}

function clearTimer(state) {
  if (state && state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

function scheduleContext(context) {
  const state = contexts.get(context);
  if (!state) return;
  clearTimer(state);
  const refreshMs = Math.max(10, state.settings.refreshSeconds) * 1000;
  state.timer = setInterval(() => refreshContext(context, "interval"), refreshMs);
}

function upsertContext(data) {
  const context = data.context;
  const existing = contexts.get(context) || {};
  const settings = normalizeSettings(settingsPayload(data));
  const state = {
    ...existing,
    action: data.action || existing.action || ACTION_UUID,
    settings,
    refreshing: false,
    needsRefresh: false
  };
  contexts.set(context, state);
  scheduleContext(context);
  refreshContext(context, "willAppear");
}

function updateSettings(data) {
  const context = data.context;
  const state = contexts.get(context);
  if (!state) return;
  state.settings = normalizeSettings(settingsPayload(data));
  scheduleContext(context);
  refreshContext(context, "settings");
}

function handleInspectorCommand(data) {
  const payload = data.payload || {};
  const context = payload.actionContext || payload.context;
  if (!context || !contexts.has(context)) return;

  if (payload.type === "settings") {
    const state = contexts.get(context);
    state.settings = normalizeSettings(payload.settings || {});
    scheduleContext(context);
    refreshContext(context, "propertyInspectorSettings");
    return;
  }

  if (payload.type === "refresh") {
    refreshContext(context, "propertyInspector");
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
      refreshContext(data.context, "keyUp");
      connection.showOk(data.context);
      break;
    case "willDisappear": {
      const state = contexts.get(data.context);
      clearTimer(state);
      contexts.delete(data.context);
      visibleInspectors.delete(data.context);
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
      for (const context of contexts.keys()) refreshContext(context, data.event);
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

  const args = parseLaunchArgs(process.argv);
  connection = new StreamDockConnection(args, {
    open: () => log("info", "connected", args.info && args.info.application),
    message: handleMessage,
    error: (error) => log("error", error),
    close: () => {
      log("info", "connection closed");
      for (const state of contexts.values()) clearTimer(state);
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
