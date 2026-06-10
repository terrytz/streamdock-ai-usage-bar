"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const DAY_MS = 24 * 60 * 60 * 1000;
const DISPLAY_MODES = Object.freeze([
  "combined",
  "codex",
  "claude",
  "codex-session",
  "codex-weekly",
  "claude-session",
  "claude-weekly",
  "claude-sonnet",
  "claude-opus",
  "cost-30d",
  "tokens-today"
]);

const DEFAULT_SETTINGS = Object.freeze({
  windowDays: 1,
  refreshSeconds: 60,
  displayMode: "combined",
  codexPath: "~/.codex",
  claudePath: "~/.claude/projects",
  codexBarHistoryPath: "~/Library/Application Support/com.steipete.codexbar/history",
  codexBarCostPath: "~/Library/Caches/CodexBar/cost-usage",
  useCodexBarData: true,
  includeClaudeSubagents: true,
  maxFiles: 2000
});

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function normalizeSettings(settings = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  const displayMode = DISPLAY_MODES.includes(merged.displayMode)
    ? merged.displayMode
    : DEFAULT_SETTINGS.displayMode;

  return {
    ...merged,
    windowDays: clampInteger(merged.windowDays, DEFAULT_SETTINGS.windowDays, 1, 90),
    refreshSeconds: clampInteger(merged.refreshSeconds, DEFAULT_SETTINGS.refreshSeconds, 10, 3600),
    maxFiles: clampInteger(merged.maxFiles, DEFAULT_SETTINGS.maxFiles, 50, 10000),
    includeClaudeSubagents: merged.includeClaudeSubagents !== false && merged.includeClaudeSubagents !== "false",
    useCodexBarData: merged.useCodexBarData !== false && merged.useCodexBarData !== "false",
    displayMode,
    codexPath: String(merged.codexPath || DEFAULT_SETTINGS.codexPath).trim(),
    claudePath: String(merged.claudePath || DEFAULT_SETTINGS.claudePath).trim(),
    codexBarHistoryPath: String(merged.codexBarHistoryPath || DEFAULT_SETTINGS.codexBarHistoryPath).trim(),
    codexBarCostPath: String(merged.codexBarCostPath || DEFAULT_SETTINGS.codexBarCostPath).trim()
  };
}

function resolveHomePath(inputPath, homeDir = os.homedir()) {
  if (!inputPath) return inputPath;
  if (inputPath === "~") return homeDir;
  if (inputPath.startsWith("~/")) return path.join(homeDir, inputPath.slice(2));
  return inputPath;
}

function uniqueExistingRoots(roots) {
  const seen = new Set();
  const result = [];
  for (const root of roots) {
    if (!root || seen.has(root)) continue;
    seen.add(root);
    result.push(root);
  }
  return result;
}

function codexRootsFor(inputPath) {
  const root = resolveHomePath(inputPath);
  const roots = [root];
  try {
    const sessions = path.join(root, "sessions");
    const archived = path.join(root, "archived_sessions");
    if (fs.existsSync(sessions)) roots.push(sessions);
    if (fs.existsSync(archived)) roots.push(archived);
  } catch {
    // Keep the direct path; scanProvider will report the missing or unreadable root.
  }
  return uniqueExistingRoots(roots);
}

function claudeRootsFor(inputPath) {
  const root = resolveHomePath(inputPath);
  const roots = [root];
  try {
    const projects = path.join(root, "projects");
    if (path.basename(root) === ".claude" && fs.existsSync(projects)) roots.push(projects);
  } catch {
    // Keep the direct path; scanProvider will report the missing or unreadable root.
  }
  return uniqueExistingRoots(roots);
}

function windowStartForDays(days, now = new Date()) {
  if (days <= 1) {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  return new Date(now.getTime() - days * DAY_MS);
}

function periodLabel(days) {
  return days <= 1 ? "today" : `${days}d`;
}

function numberFrom(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function addTokenTotals(target, source) {
  target.input += source.input;
  target.output += source.output;
  target.cacheCreation += source.cacheCreation;
  target.cacheRead += source.cacheRead;
  target.reasoning += source.reasoning;
  target.total += source.total;
}

function emptyTokens() {
  return {
    input: 0,
    output: 0,
    cacheCreation: 0,
    cacheRead: 0,
    reasoning: 0,
    total: 0
  };
}

function emptyProvider(name) {
  return {
    name,
    tokens: emptyTokens(),
    limits: [],
    cost: emptyCost(),
    requests: 0,
    messages: 0,
    turns: 0,
    sessions: 0,
    records: 0,
    files: 0,
    skippedFiles: 0,
    errors: 0,
    errorMessages: [],
    lastAt: null
  };
}

function emptyCost() {
  return {
    todayTokens: 0,
    latestTokens: 0,
    thirtyDayTokens: 0,
    todayCostNanos: 0,
    thirtyDayCostNanos: 0,
    source: null
  };
}

function tokenSummaryFromUsage(usage) {
  if (!usage || typeof usage !== "object") return null;

  const input = numberFrom(usage.input_tokens)
    || numberFrom(usage.prompt_tokens)
    || numberFrom(usage.inputTokenCount)
    || numberFrom(usage.promptTokenCount);

  const output = numberFrom(usage.output_tokens)
    || numberFrom(usage.completion_tokens)
    || numberFrom(usage.outputTokenCount)
    || numberFrom(usage.completionTokenCount);

  const explicitCacheCreation = numberFrom(usage.cache_creation_input_tokens)
    || numberFrom(usage.cacheCreationInputTokens);

  const nestedCacheCreation = usage.cache_creation && typeof usage.cache_creation === "object"
    ? numberFrom(usage.cache_creation.ephemeral_1h_input_tokens)
      + numberFrom(usage.cache_creation.ephemeral_5m_input_tokens)
    : 0;

  const cacheCreation = explicitCacheCreation || nestedCacheCreation;

  const explicitCacheRead = numberFrom(usage.cache_read_input_tokens)
    || numberFrom(usage.cacheReadInputTokens);

  const cacheRead = explicitCacheRead
    || numberFrom(usage.cached_input_tokens)
    || numberFrom(usage.input_tokens_details && usage.input_tokens_details.cached_tokens);

  const reasoning = numberFrom(usage.reasoning_tokens)
    || numberFrom(usage.reasoning_output_tokens)
    || numberFrom(usage.output_tokens_details && usage.output_tokens_details.reasoning_tokens);

  let total = numberFrom(usage.total_tokens) || numberFrom(usage.totalTokenCount);
  if (!total) {
    total = input + output + cacheCreation + explicitCacheRead;
  }

  if (!input && !output && !cacheCreation && !cacheRead && !reasoning && !total) {
    return null;
  }

  return {
    input,
    output,
    cacheCreation,
    cacheRead,
    reasoning,
    total
  };
}

function firstUsageObject(record) {
  const candidates = [
    record && record.usage,
    record && record.message && record.message.usage,
    record && record.payload && record.payload.usage,
    record && record.payload && record.payload.message && record.payload.message.usage,
    record && record.payload && record.payload.response && record.payload.response.usage,
    record && record.payload && record.payload.info && record.payload.info.last_token_usage,
    record && record.response && record.response.usage,
    record && record.item && record.item.usage,
    record && record.payload && record.payload.item && record.payload.item.usage
  ];

  for (const candidate of candidates) {
    if (tokenSummaryFromUsage(candidate)) return candidate;
  }

  return null;
}

function usageId(record) {
  return record.requestId
    || (record.message && record.message.id)
    || record.responseId
    || (record.response && record.response.id)
    || (record.payload && record.payload.requestId)
    || (record.payload && record.payload.id)
    || record.uuid
    || null;
}

function recordTimestamp(record, fallbackMs) {
  const raw = record.timestamp
    || record.createdAt
    || record.created_at
    || record.time
    || (record.payload && (record.payload.timestamp || record.payload.created_at || record.payload.started_at));

  const date = raw ? new Date(raw) : new Date(fallbackMs);
  return Number.isFinite(date.getTime()) ? date : null;
}

function isInWindow(date, start, now) {
  if (!date) return false;
  return date.getTime() >= start.getTime() && date.getTime() <= now.getTime() + 5 * 60 * 1000;
}

function shouldSkipDirectory(fullPath, dirent, options) {
  if (!dirent.isDirectory()) return false;
  if (dirent.name === ".git" || dirent.name === "node_modules") return true;
  if (!options.includeSubagents && fullPath.split(path.sep).includes("subagents")) return true;
  return false;
}

function walkJsonlFiles(root, options) {
  const files = [];
  const errors = [];
  const stack = [root];
  const cutoffMs = options.windowStart.getTime() - 2 * DAY_MS;

  while (stack.length && files.length < options.maxFiles * 4) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      errors.push(`Cannot read ${dir}: ${error.message}`);
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (shouldSkipDirectory(fullPath, entry, options)) continue;
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;

      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < cutoffMs) continue;
        files.push({ path: fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch (error) {
        errors.push(`Cannot stat ${fullPath}: ${error.message}`);
      }
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return {
    files: files.slice(0, options.maxFiles),
    skippedFiles: Math.max(0, files.length - options.maxFiles),
    errors
  };
}

function addError(stats, message) {
  stats.errors += 1;
  if (stats.errorMessages.length < 5) stats.errorMessages.push(message);
}

function normalizePercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function titleCase(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function displayLimitLabel(name) {
  const normalized = String(name || "").toLowerCase();
  if (normalized === "session") return "Session";
  if (normalized === "weekly") return "Weekly";
  if (normalized === "opus") return "Sonnet";
  if (normalized === "sonnet") return "Sonnet";
  return titleCase(normalized);
}

function resetIsoFrom(value) {
  if (!value) return null;
  if (typeof value === "number") {
    const date = new Date(value > 10_000_000_000 ? value : value * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function limitSortValue(name) {
  if (name === "session") return 0;
  if (name === "weekly") return 1;
  return 2;
}

function makeLimit(name, data, source, capturedAt = null) {
  if (!data || typeof data !== "object") return null;
  const usedPercent = normalizePercent(data.usedPercent ?? data.used_percent);
  if (usedPercent === null) return null;
  const normalizedName = String(name || data.name || "limit").toLowerCase();

  return {
    name: normalizedName,
    label: displayLimitLabel(normalizedName),
    usedPercent,
    leftPercent: Math.max(0, 100 - usedPercent),
    reservePercent: normalizePercent(data.reservePercent ?? data.reserve_percent),
    windowMinutes: Number(data.windowMinutes ?? data.window_minutes) || null,
    resetsAt: resetIsoFrom(data.resetsAt ?? data.resets_at),
    capturedAt: resetIsoFrom(capturedAt ?? data.capturedAt ?? data.captured_at),
    source
  };
}

function upsertLimit(stats, limit) {
  if (!limit) return;
  const existingIndex = stats.limits.findIndex((candidate) => candidate.name === limit.name);
  if (existingIndex === -1) {
    stats.limits.push(limit);
  } else {
    const existing = stats.limits[existingIndex];
    const existingCaptured = existing.capturedAt ? new Date(existing.capturedAt).getTime() : 0;
    const nextCaptured = limit.capturedAt ? new Date(limit.capturedAt).getTime() : 0;
    if (nextCaptured >= existingCaptured) stats.limits[existingIndex] = limit;
  }
  stats.limits.sort((a, b) => limitSortValue(a.name) - limitSortValue(b.name) || a.label.localeCompare(b.label));
}

function collectRecordLimits(provider, record, stats) {
  if (provider !== "codex") return;
  const rateLimits = record && record.payload && record.payload.rate_limits;
  if (!rateLimits || typeof rateLimits !== "object") return;
  upsertLimit(stats, makeLimit("session", rateLimits.primary, "codex-events", record.timestamp));
  upsertLimit(stats, makeLimit("weekly", rateLimits.secondary, "codex-events", record.timestamp));
}

function countProviderActivity(provider, record, stats, sessionIds) {
  if (provider === "codex") {
    if (record.type === "session_meta" && record.payload && record.payload.id) {
      sessionIds.add(record.payload.id);
    }
    if (record.type === "turn_context") stats.turns += 1;
    if (record.type === "response_item" && record.payload && record.payload.type === "message") {
      stats.messages += 1;
    }
    return;
  }

  if (record.sessionId) sessionIds.add(record.sessionId);
  if (record.type === "assistant" || record.type === "user") stats.messages += 1;
}

function scanProvider(provider, roots, settings, now = new Date()) {
  const stats = emptyProvider(provider);
  const windowStart = windowStartForDays(settings.windowDays, now);
  const sessionIds = new Set();
  const seenUsageIds = new Set();
  const seenFiles = new Set();

  for (const root of roots) {
    if (!root || !fs.existsSync(root)) {
      addError(stats, `Missing path: ${root}`);
      continue;
    }

    const walk = walkJsonlFiles(root, {
      windowStart,
      maxFiles: settings.maxFiles,
      includeSubagents: provider !== "claude" || settings.includeClaudeSubagents
    });

    stats.skippedFiles += walk.skippedFiles;
    for (const message of walk.errors) addError(stats, message);

    for (const file of walk.files) {
      if (seenFiles.has(file.path)) continue;
      seenFiles.add(file.path);
      stats.files += 1;

      let text;
      try {
        text = fs.readFileSync(file.path, "utf8");
      } catch (error) {
        addError(stats, `Cannot read ${file.path}: ${error.message}`);
        continue;
      }

      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (!line) continue;

        let record;
        try {
          record = JSON.parse(line);
        } catch (error) {
          addError(stats, `${file.path}:${index + 1}: ${error.message}`);
          continue;
        }

        const timestamp = recordTimestamp(record, file.mtimeMs);
        if (!isInWindow(timestamp, windowStart, now)) continue;

        stats.records += 1;
        if (!stats.lastAt || timestamp > new Date(stats.lastAt)) {
          stats.lastAt = timestamp.toISOString();
        }

        countProviderActivity(provider, record, stats, sessionIds);
        collectRecordLimits(provider, record, stats);

        const usage = firstUsageObject(record);
        const tokenSummary = tokenSummaryFromUsage(usage);
        if (!tokenSummary) continue;

        const id = usageId(record);
        if (id && seenUsageIds.has(id)) continue;
        if (id) seenUsageIds.add(id);

        stats.requests += 1;
        addTokenTotals(stats.tokens, tokenSummary);
      }
    }
  }

  stats.sessions = sessionIds.size;
  return stats;
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function collectCodexBarLimits(provider, settings) {
  if (!settings.useCodexBarData) return [];
  const historyRoot = resolveHomePath(settings.codexBarHistoryPath);
  const filePath = path.join(historyRoot, `${provider}.json`);
  const history = readJsonFile(filePath);
  if (!history || typeof history !== "object") return [];

  const latestByName = new Map();
  const groups = [
    ...Object.values(history.accounts || {}),
    history.unscoped || []
  ];

  for (const limits of groups) {
    if (!Array.isArray(limits)) continue;
    for (const limitGroup of limits) {
      const entries = Array.isArray(limitGroup.entries) ? limitGroup.entries : [];
      for (const entry of entries) {
        const limit = makeLimit(limitGroup.name, {
          ...entry,
          windowMinutes: limitGroup.windowMinutes
        }, "codexbar", entry.capturedAt);
        if (!limit) continue;
        const existing = latestByName.get(limit.name);
        const existingCaptured = existing && existing.capturedAt ? new Date(existing.capturedAt).getTime() : 0;
        const nextCaptured = limit.capturedAt ? new Date(limit.capturedAt).getTime() : 0;
        if (!existing || nextCaptured >= existingCaptured) latestByName.set(limit.name, limit);
      }
    }
  }

  return [...latestByName.values()].sort((a, b) => limitSortValue(a.name) - limitSortValue(b.name) || a.label.localeCompare(b.label));
}

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateKeysForLastDays(days, now = new Date()) {
  const keys = new Set();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let offset = 0; offset < days; offset += 1) {
    keys.add(dateKey(new Date(start.getTime() - offset * DAY_MS)));
  }
  return keys;
}

function addCost(target, source) {
  target.todayTokens += source.todayTokens || 0;
  target.latestTokens += source.latestTokens || 0;
  target.thirtyDayTokens += source.thirtyDayTokens || 0;
  target.todayCostNanos += source.todayCostNanos || 0;
  target.thirtyDayCostNanos += source.thirtyDayCostNanos || 0;
  if (!target.source && source.source) target.source = source.source;
}

function collectCodexBarCost(provider, settings, now = new Date()) {
  const result = emptyCost();
  if (!settings.useCodexBarData) return result;

  const costRoot = resolveHomePath(settings.codexBarCostPath);
  const fileName = provider === "codex" ? "codex-v8.json" : "claude-v2.json";
  const payload = readJsonFile(path.join(costRoot, fileName));
  if (!payload || !payload.days || typeof payload.days !== "object") return result;

  const todayKeys = dateKeysForLastDays(1, now);
  const thirtyDayKeys = dateKeysForLastDays(30, now);
  let latestDayKey = null;

  for (const dayKey of Object.keys(payload.days)) {
    if (!latestDayKey || dayKey > latestDayKey) latestDayKey = dayKey;
    const isToday = todayKeys.has(dayKey);
    const isThirtyDay = thirtyDayKeys.has(dayKey);
    if (!isToday && !isThirtyDay) continue;

    for (const values of Object.values(payload.days[dayKey] || {})) {
      if (!Array.isArray(values)) continue;
      let tokens = 0;
      let costNanos = 0;
      if (provider === "codex") {
        tokens = numberFrom(values[0]) + numberFrom(values[2]);
      } else {
        tokens = numberFrom(values[0]) + numberFrom(values[2]) + numberFrom(values[3]);
        costNanos = numberFrom(values[4]);
      }
      if (isToday) {
        result.todayTokens += tokens;
        result.todayCostNanos += costNanos;
      }
      if (isThirtyDay) {
        result.thirtyDayTokens += tokens;
        result.thirtyDayCostNanos += costNanos;
      }
    }
  }

  if (provider === "codex") {
    for (const file of Object.values(payload.files || {})) {
      const costByDay = file && file.codexCostNanos;
      if (!costByDay || typeof costByDay !== "object") continue;
      for (const [dayKey, models] of Object.entries(costByDay)) {
        if (!todayKeys.has(dayKey) && !thirtyDayKeys.has(dayKey)) continue;
        for (const value of Object.values(models || {})) {
          if (todayKeys.has(dayKey)) result.todayCostNanos += numberFrom(value);
          if (thirtyDayKeys.has(dayKey)) result.thirtyDayCostNanos += numberFrom(value);
        }
      }
    }
  }

  if (latestDayKey && payload.days[latestDayKey]) {
    for (const values of Object.values(payload.days[latestDayKey])) {
      if (!Array.isArray(values)) continue;
      result.latestTokens += provider === "codex"
        ? numberFrom(values[0]) + numberFrom(values[2])
        : numberFrom(values[0]) + numberFrom(values[2]) + numberFrom(values[3]);
    }
  }

  result.source = "codexbar";
  return result;
}

function applyCodexBarData(provider, stats, settings, now) {
  const limits = collectCodexBarLimits(provider, settings);
  if (limits.length) stats.limits = limits;
  const cost = collectCodexBarCost(provider, settings, now);
  if (cost.source) stats.cost = cost;
}

function mergeTotals(providers) {
  const total = {
    name: "total",
    tokens: emptyTokens(),
    cost: emptyCost(),
    requests: 0,
    messages: 0,
    turns: 0,
    sessions: 0,
    records: 0,
    files: 0,
    skippedFiles: 0,
    errors: 0
  };

  for (const provider of providers) {
    addTokenTotals(total.tokens, provider.tokens);
    addCost(total.cost, provider.cost);
    total.requests += provider.requests;
    total.messages += provider.messages;
    total.turns += provider.turns;
    total.sessions += provider.sessions;
    total.records += provider.records;
    total.files += provider.files;
    total.skippedFiles += provider.skippedFiles;
    total.errors += provider.errors;
  }

  return total;
}

function collectUsage(rawSettings = {}, now = new Date()) {
  const settings = normalizeSettings(rawSettings);
  const codex = scanProvider("codex", codexRootsFor(settings.codexPath), settings, now);
  const claude = scanProvider("claude", claudeRootsFor(settings.claudePath), settings, now);
  applyCodexBarData("codex", codex, settings, now);
  applyCodexBarData("claude", claude, settings, now);
  const total = mergeTotals([codex, claude]);

  return {
    generatedAt: now.toISOString(),
    windowStart: windowStartForDays(settings.windowDays, now).toISOString(),
    periodLabel: periodLabel(settings.windowDays),
    settings,
    total,
    providers: {
      codex,
      claude
    }
  };
}

function shortNumber(value) {
  const number = Math.round(Number(value) || 0);
  if (Math.abs(number) >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (Math.abs(number) >= 1_000_000) return `${(number / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (Math.abs(number) >= 1_000) return `${(number / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(number);
}

function providerDisplay(provider) {
  const session = limitFor(provider, "session");
  const weekly = limitFor(provider, "weekly");
  if (session && weekly) return `S${session.leftPercent}% W${weekly.leftPercent}%`;
  if (session) return `${session.leftPercent}% left`;
  if (provider.tokens.total > 0) return shortNumber(provider.tokens.total);
  if (provider.turns > 0) return `${shortNumber(provider.turns)} turns`;
  if (provider.requests > 0) return `${shortNumber(provider.requests)} req`;
  if (provider.messages > 0) return `${shortNumber(provider.messages)} msg`;
  if (provider.sessions > 0) return `${shortNumber(provider.sessions)} sess`;
  return "0";
}

function mainDisplay(summary, mode) {
  if (mode === "codex") return focusedMainDisplay(summary.providers.codex);
  if (mode === "claude") return focusedMainDisplay(summary.providers.claude);
  if (mode === "codex-session") return singleLimitDisplay(summary.providers.codex, "session");
  if (mode === "codex-weekly") return singleLimitDisplay(summary.providers.codex, "weekly");
  if (mode === "claude-session") return singleLimitDisplay(summary.providers.claude, "session");
  if (mode === "claude-weekly") return singleLimitDisplay(summary.providers.claude, "weekly");
  if (mode === "claude-sonnet" || mode === "claude-opus") return singleLimitDisplay(summary.providers.claude, "opus");
  if (mode === "cost-30d") return displayCost(summary.total.cost.thirtyDayCostNanos);
  if (mode === "tokens-today") return shortNumber(summary.total.cost.todayTokens || summary.total.tokens.total);
  const codexSession = limitFor(summary.providers.codex, "session");
  const claudeSession = limitFor(summary.providers.claude, "session");
  if (codexSession || claudeSession) {
    const values = [];
    if (codexSession) values.push(`C${codexSession.leftPercent}%`);
    if (claudeSession) values.push(`A${claudeSession.leftPercent}%`);
    return values.join(" ");
  }
  if (summary.total.tokens.total > 0) return shortNumber(summary.total.tokens.total);
  if (summary.total.requests > 0) return `${shortNumber(summary.total.requests)} req`;
  if (summary.total.turns > 0) return `${shortNumber(summary.total.turns)} turns`;
  if (summary.total.messages > 0) return `${shortNumber(summary.total.messages)} msg`;
  return "No data";
}

function focusedMainDisplay(provider) {
  const session = limitFor(provider, "session");
  if (session) return `${session.leftPercent}% left`;
  return providerDisplay(provider);
}

function singleLimitDisplay(provider, name) {
  const limit = limitFor(provider, name);
  return limit ? `${limit.leftPercent}% left` : providerDisplay(provider);
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function barWidth(value, total, maxWidth) {
  if (!total || total <= 0) return 0;
  return Math.max(2, Math.round((value / total) * maxWidth));
}

function providerPrimaryMetric(provider) {
  return provider.tokens.total || provider.requests || provider.turns || provider.messages || provider.sessions || 0;
}

function limitFor(provider, name) {
  return provider && Array.isArray(provider.limits)
    ? provider.limits.find((limit) => limit.name === name)
    : null;
}

function displayCost(nanos) {
  const dollars = Number(nanos || 0) / 1_000_000_000;
  if (!dollars) return "$0";
  if (dollars >= 1000) return `$${(dollars / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (dollars >= 100) return `$${Math.round(dollars)}`;
  return `$${dollars.toFixed(2).replace(/\.00$/, "")}`;
}

function percentColor(percent, fallback) {
  if (percent === null || percent === undefined) return fallback;
  if (percent <= 10) return "#ff6b6b";
  if (percent <= 25) return "#ffb15f";
  return fallback;
}

function resetLabel(resetsAt, now = new Date()) {
  if (!resetsAt) return "";
  const date = new Date(resetsAt);
  if (!Number.isFinite(date.getTime())) return "";
  const ms = date.getTime() - now.getTime();
  if (ms <= 0) return "now";
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

function updatedLabel(summary) {
  const updated = new Date(summary.generatedAt);
  return Number.isFinite(updated.getTime())
    ? `${String(updated.getHours()).padStart(2, "0")}:${String(updated.getMinutes()).padStart(2, "0")}`
    : "";
}

function limitLineSvg(limit, y, color, now) {
  const left = limit ? limit.leftPercent : null;
  const lineColor = percentColor(left, color);
  const width = left === null ? 0 : Math.max(2, Math.round((left / 100) * 94));
  const label = limit ? limit.label : "No limit data";
  const value = limit ? `${left}%` : "-";
  const reset = limit && limit.resetsAt ? `Reset ${resetLabel(limit.resetsAt, now)}` : "";
  const reserve = limit && limit.reservePercent !== null ? `${limit.reservePercent}% reserve` : "";
  return `
  <text x="18" y="${y}" font-family="Arial, sans-serif" font-size="10" font-weight="700" fill="#f8fafc">${escapeXml(label)}</text>
  <text x="126" y="${y}" text-anchor="end" font-family="Arial, sans-serif" font-size="14" font-weight="700" fill="${lineColor}">${escapeXml(value)}</text>
  <rect x="18" y="${y + 7}" width="108" height="8" rx="4" fill="#2a3440"/>
  <rect x="18" y="${y + 7}" width="${width}" height="8" rx="4" fill="${lineColor}"/>
  <text x="18" y="${y + 27}" font-family="Arial, sans-serif" font-size="8" fill="#9aa7b5">${escapeXml(reset || reserve)}</text>`;
}

function combinedProviderSvg(provider, label, y, color, now) {
  const session = limitFor(provider, "session");
  const weekly = limitFor(provider, "weekly");
  const sessionLeft = session ? `${session.leftPercent}%` : "-";
  const weeklyLeft = weekly ? `${weekly.leftPercent}%` : "-";
  const sessionWidth = session ? Math.max(2, Math.round((session.leftPercent / 100) * 43)) : 0;
  const weeklyWidth = weekly ? Math.max(2, Math.round((weekly.leftPercent / 100) * 43)) : 0;
  const sessionColor = percentColor(session && session.leftPercent, color);
  const weeklyColor = percentColor(weekly && weekly.leftPercent, color);

  return `
  <text x="18" y="${y}" font-family="Arial, sans-serif" font-size="12" font-weight="700" fill="#f8fafc">${escapeXml(label)}</text>
  <text x="68" y="${y}" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" font-weight="700" fill="${sessionColor}">S ${escapeXml(sessionLeft)}</text>
  <text x="126" y="${y}" text-anchor="end" font-family="Arial, sans-serif" font-size="12" font-weight="700" fill="${weeklyColor}">W ${escapeXml(weeklyLeft)}</text>
  <rect x="18" y="${y + 8}" width="50" height="7" rx="3.5" fill="#2a3440"/>
  <rect x="18" y="${y + 8}" width="${sessionWidth}" height="7" rx="3.5" fill="${sessionColor}"/>
  <rect x="76" y="${y + 8}" width="50" height="7" rx="3.5" fill="#2a3440"/>
  <rect x="76" y="${y + 8}" width="${Math.max(0, Math.round((weeklyWidth / 43) * 50))}" height="7" rx="3.5" fill="${weeklyColor}"/>
  <text x="18" y="${y + 27}" font-family="Arial, sans-serif" font-size="8" fill="#9aa7b5">Session</text>
  <text x="126" y="${y + 27}" text-anchor="end" font-family="Arial, sans-serif" font-size="8" fill="#9aa7b5">Weekly</text>`;
}

function renderFocusedSvg(summary, providerName) {
  const provider = summary.providers[providerName];
  const color = providerName === "codex" ? "#54c7d4" : "#e28a67";
  const session = limitFor(provider, "session");
  const weekly = limitFor(provider, "weekly");
  const source = session || weekly ? (session || weekly).source : provider.cost.source || "local";
  const name = providerName === "codex" ? "Codex" : "Claude";
  const latest = provider.cost.latestTokens || provider.cost.todayTokens || provider.tokens.total;
  const thirtyDayTokens = provider.cost.thirtyDayTokens || provider.tokens.total;
  const now = new Date(summary.generatedAt);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect width="144" height="144" rx="18" fill="#0b0f14"/>
  <rect x="9" y="9" width="126" height="126" rx="14" fill="#111820" stroke="#2b3948" stroke-width="2"/>
  <text x="18" y="28" font-family="Arial, sans-serif" font-size="14" font-weight="700" fill="#f8fafc">${escapeXml(name)}</text>
  <text x="126" y="28" text-anchor="end" font-family="Arial, sans-serif" font-size="9" fill="#9aa7b5">${escapeXml(updatedLabel(summary))}</text>
  ${limitLineSvg(session, 47, color, now)}
  ${limitLineSvg(weekly, 85, color, now)}
  <text x="18" y="125" font-family="Arial, sans-serif" font-size="9" fill="#9aa7b5">30d ${escapeXml(shortNumber(thirtyDayTokens))}</text>
  <text x="76" y="125" text-anchor="middle" font-family="Arial, sans-serif" font-size="9" fill="#9aa7b5">${escapeXml(displayCost(provider.cost.thirtyDayCostNanos))}</text>
  <text x="126" y="125" text-anchor="end" font-family="Arial, sans-serif" font-size="9" fill="#9aa7b5">${escapeXml(shortNumber(latest))}</text>
</svg>`;
}

function renderCombinedSvg(summary) {
  const codex = summary.providers.codex;
  const claude = summary.providers.claude;
  const totalTokens = summary.total.cost.thirtyDayTokens || summary.total.tokens.total;
  const totalCost = summary.total.cost.thirtyDayCostNanos;
  const now = new Date(summary.generatedAt);
  const errors = summary.total.errors ? `${summary.total.errors} err` : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect width="144" height="144" rx="18" fill="#0b0f14"/>
  <rect x="9" y="9" width="126" height="126" rx="14" fill="#111820" stroke="#2b3948" stroke-width="2"/>
  <text x="18" y="28" font-family="Arial, sans-serif" font-size="14" font-weight="700" fill="#f8fafc">Overview</text>
  <text x="126" y="28" text-anchor="end" font-family="Arial, sans-serif" font-size="9" fill="#9aa7b5">${escapeXml(updatedLabel(summary))}</text>
  ${combinedProviderSvg(codex, "Codex", 50, "#54c7d4", now)}
  ${combinedProviderSvg(claude, "Claude", 88, "#e28a67", now)}
  <text x="18" y="124" font-family="Arial, sans-serif" font-size="9" fill="#9aa7b5">30d ${escapeXml(shortNumber(totalTokens))}</text>
  <text x="84" y="124" text-anchor="middle" font-family="Arial, sans-serif" font-size="9" fill="#9aa7b5">${escapeXml(displayCost(totalCost))}</text>
  <text x="126" y="124" text-anchor="end" font-family="Arial, sans-serif" font-size="9" fill="#9aa7b5">${escapeXml(errors)}</text>
</svg>`;
}

function singleMetricBaseSvg({ title, value, subtitle, color, percent, footer }) {
  const safePercent = percent === null || percent === undefined ? null : Math.max(0, Math.min(100, Number(percent)));
  const barWidthValue = safePercent === null ? 0 : Math.max(2, Math.round((safePercent / 100) * 108));
  const metricColor = percentColor(safePercent, color);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect width="144" height="144" rx="18" fill="#0b0f14"/>
  <rect x="9" y="9" width="126" height="126" rx="14" fill="#111820" stroke="#2b3948" stroke-width="2"/>
  <text x="18" y="30" font-family="Arial, sans-serif" font-size="13" font-weight="700" fill="#f8fafc">${escapeXml(title)}</text>
  <text x="72" y="72" text-anchor="middle" font-family="Arial, sans-serif" font-size="32" font-weight="700" fill="${metricColor}">${escapeXml(value)}</text>
  <text x="72" y="91" text-anchor="middle" font-family="Arial, sans-serif" font-size="10" fill="#9aa7b5">${escapeXml(subtitle || "")}</text>
  <rect x="18" y="104" width="108" height="10" rx="5" fill="#2a3440"/>
  <rect x="18" y="104" width="${barWidthValue}" height="10" rx="5" fill="${metricColor}"/>
  <text x="72" y="128" text-anchor="middle" font-family="Arial, sans-serif" font-size="9" fill="#9aa7b5">${escapeXml(footer || "")}</text>
</svg>`;
}

function renderSingleLimitSvg(summary, providerName, limitName) {
  const provider = summary.providers[providerName];
  const limit = limitFor(provider, limitName);
  const color = providerName === "codex" ? "#54c7d4" : "#e28a67";
  const providerLabel = providerName === "codex" ? "Codex" : "Claude";
  const title = limit ? `${providerLabel} ${limit.label}` : `${providerLabel} ${titleCase(limitName)}`;
  const value = limit ? `${limit.leftPercent}%` : "-";
  const reset = limit && limit.resetsAt ? `Resets in ${resetLabel(limit.resetsAt, new Date(summary.generatedAt))}` : "No quota data";
  const footer = limit ? `${limit.usedPercent}% used` : providerDisplay(provider);

  return singleMetricBaseSvg({
    title,
    value,
    subtitle: reset,
    color,
    percent: limit && limit.leftPercent,
    footer
  });
}

function renderSingleCostSvg(summary) {
  return singleMetricBaseSvg({
    title: "30d Cost",
    value: displayCost(summary.total.cost.thirtyDayCostNanos),
    subtitle: `${shortNumber(summary.total.cost.thirtyDayTokens || summary.total.tokens.total)} tokens`,
    color: "#66b8ff",
    percent: null,
    footer: "Codex + Claude"
  });
}

function renderSingleTodayTokensSvg(summary) {
  const tokens = summary.total.cost.todayTokens || summary.total.tokens.total;
  return singleMetricBaseSvg({
    title: "Today Tokens",
    value: shortNumber(tokens),
    subtitle: `Cost ${displayCost(summary.total.cost.todayCostNanos)}`,
    color: "#3ddc97",
    percent: null,
    footer: "Codex + Claude"
  });
}

function renderKeySvg(summary, mode = "combined") {
  const normalizedMode = DISPLAY_MODES.includes(mode) ? mode : "combined";
  if (normalizedMode === "codex" || normalizedMode === "claude") {
    return renderFocusedSvg(summary, normalizedMode);
  }
  if (normalizedMode === "codex-session") return renderSingleLimitSvg(summary, "codex", "session");
  if (normalizedMode === "codex-weekly") return renderSingleLimitSvg(summary, "codex", "weekly");
  if (normalizedMode === "claude-session") return renderSingleLimitSvg(summary, "claude", "session");
  if (normalizedMode === "claude-weekly") return renderSingleLimitSvg(summary, "claude", "weekly");
  if (normalizedMode === "claude-sonnet" || normalizedMode === "claude-opus") return renderSingleLimitSvg(summary, "claude", "opus");
  if (normalizedMode === "cost-30d") return renderSingleCostSvg(summary);
  if (normalizedMode === "tokens-today") return renderSingleTodayTokensSvg(summary);
  return renderCombinedSvg(summary);
}

function renderErrorSvg(message) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect width="144" height="144" rx="18" fill="#160b0b"/>
  <rect x="10" y="10" width="124" height="124" rx="14" fill="#241111" stroke="#663333" stroke-width="2"/>
  <text x="72" y="55" text-anchor="middle" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#ff6b6b">ERR</text>
  <text x="72" y="82" text-anchor="middle" font-family="Arial, sans-serif" font-size="11" fill="#ffd5d5">${escapeXml(String(message).slice(0, 20))}</text>
  <text x="72" y="104" text-anchor="middle" font-family="Arial, sans-serif" font-size="10" fill="#b88484">AI Usage</text>
</svg>`;
}

function svgDataUri(svg) {
  return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
}

function titleForSummary(summary, mode = "combined") {
  const text = mainDisplay(summary, mode);
  return text === "No data" ? "AI Usage" : `AI ${text}`;
}

module.exports = {
  DEFAULT_SETTINGS,
  normalizeSettings,
  resolveHomePath,
  codexRootsFor,
  claudeRootsFor,
  collectUsage,
  renderKeySvg,
  renderErrorSvg,
  svgDataUri,
  titleForSummary,
  shortNumber,
  tokenSummaryFromUsage,
  windowStartForDays
};
