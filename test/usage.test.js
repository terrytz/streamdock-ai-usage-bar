"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  collectUsage,
  parseClaudeUsageText,
  renderKeySvg,
  shortNumber,
  tokenSummaryFromUsage
} = require("../com.terry.ai-usage.sdPlugin/plugin/lib/usage");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "streamdock-ai-usage-"));
}

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

test("collectUsage counts Claude and Codex token fields with de-duplication", () => {
  const root = makeTempDir();
  const now = new Date();
  const timestamp = now.toISOString();
  const codexPath = path.join(root, ".codex");
  const claudePath = path.join(root, ".claude", "projects");

  writeJsonl(path.join(codexPath, "sessions", "2026", "06", "10", "codex.jsonl"), [
    { timestamp, type: "session_meta", payload: { id: "codex-session-1" } },
    { timestamp, type: "turn_context", payload: { turn_id: "turn-1" } },
    {
      timestamp,
      type: "response_item",
      uuid: "codex-usage-1",
      payload: {
        type: "message",
        usage: {
          input_tokens: 10,
          output_tokens: 5
        }
      }
    }
  ]);

  writeJsonl(path.join(claudePath, "project-a", "claude.jsonl"), [
    {
      timestamp,
      type: "assistant",
      requestId: "request-1",
      sessionId: "claude-session-1",
      message: {
        id: "message-1",
        role: "assistant",
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 7,
          output_tokens: 5
        }
      }
    },
    {
      timestamp,
      type: "assistant",
      requestId: "request-1",
      sessionId: "claude-session-1",
      message: {
        id: "message-1",
        role: "assistant",
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 7,
          output_tokens: 5
        }
      }
    },
    {
      timestamp,
      type: "user",
      sessionId: "claude-session-1",
      message: {
        role: "user",
        content: "not inspected by parser"
      }
    }
  ]);

  const summary = collectUsage({
    codexPath,
    claudePath,
    claudeUsageCommand: "",
    windowDays: 7,
    maxFiles: 100
  }, now);

  assert.equal(summary.providers.codex.sessions, 1);
  assert.equal(summary.providers.codex.turns, 1);
  assert.equal(summary.providers.codex.tokens.total, 15);
  assert.equal(summary.providers.codex.requests, 1);

  assert.equal(summary.providers.claude.sessions, 1);
  assert.equal(summary.providers.claude.requests, 1);
  assert.equal(summary.providers.claude.tokens.total, 42);

  assert.equal(summary.total.tokens.total, 57);
  assert.equal(summary.total.requests, 2);
});

test("collectUsage can exclude Claude subagent files", () => {
  const root = makeTempDir();
  const now = new Date();
  const timestamp = now.toISOString();
  const claudePath = path.join(root, ".claude", "projects");

  writeJsonl(path.join(claudePath, "project-a", "subagents", "agent.jsonl"), [
    {
      timestamp,
      type: "assistant",
      requestId: "subagent-request",
      sessionId: "claude-session-1",
      message: {
        role: "assistant",
        usage: {
          input_tokens: 5,
          output_tokens: 5
        }
      }
    }
  ]);

  const excluded = collectUsage({
    codexPath: path.join(root, ".codex"),
    claudePath,
    claudeUsageCommand: "",
    includeClaudeSubagents: false,
    windowDays: 7,
    maxFiles: 100
  }, now);

  const included = collectUsage({
    codexPath: path.join(root, ".codex"),
    claudePath,
    claudeUsageCommand: "",
    includeClaudeSubagents: true,
    windowDays: 7,
    maxFiles: 100
  }, now);

  assert.equal(excluded.providers.claude.tokens.total, 0);
  assert.equal(included.providers.claude.tokens.total, 10);
});

test("tokenSummaryFromUsage supports OpenAI total_tokens without double-counting cached details", () => {
  const summary = tokenSummaryFromUsage({
    input_tokens: 100,
    output_tokens: 20,
    total_tokens: 120,
    input_tokens_details: {
      cached_tokens: 80
    },
    output_tokens_details: {
      reasoning_tokens: 12
    }
  });

  assert.equal(summary.input, 100);
  assert.equal(summary.output, 20);
  assert.equal(summary.cacheRead, 80);
  assert.equal(summary.reasoning, 12);
  assert.equal(summary.total, 120);
});

test("renderKeySvg creates a StreamDock-compatible SVG data surface", () => {
  const root = makeTempDir();
  const now = new Date();
  const timestamp = now.toISOString();
  const claudePath = path.join(root, ".claude", "projects");

  writeJsonl(path.join(claudePath, "project-a", "claude.jsonl"), [
    {
      timestamp,
      type: "assistant",
      requestId: "request-1",
      sessionId: "claude-session-1",
      message: {
        role: "assistant",
        usage: {
          input_tokens: 1000,
          output_tokens: 250
        }
      }
    }
  ]);

  const summary = collectUsage({
    codexPath: path.join(root, ".codex"),
    claudePath,
    claudeUsageCommand: "",
    windowDays: 7,
    maxFiles: 100
  }, now);

  const svg = renderKeySvg(summary, "combined");
  assert.match(svg, /<svg/);
  assert.match(svg, /Claude/);
  assert.match(svg, /1\.3K/);
  assert.equal(shortNumber(1250), "1.3K");
});

test("collectUsage reads Codex CLI session and weekly limits", () => {
  const root = makeTempDir();
  const now = new Date("2026-06-10T15:40:00Z");
  const codexPath = path.join(root, ".codex");

  writeJsonl(path.join(codexPath, "sessions", "2026", "06", "10", "codex.jsonl"), [
    {
      timestamp: "2026-06-10T15:38:35Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1000,
            output_tokens: 50,
            total_tokens: 1050
          }
        }
      },
      rate_limits: {
        primary: {
          used_percent: 38,
          window_minutes: 300,
          resets_at: "2026-06-10T17:30:43Z"
        },
        secondary: {
          used_percent: 94,
          window_minutes: 10080,
          resets_at: "2026-06-11T01:00:23Z"
        }
      }
    }
  ]);

  const summary = collectUsage({
    codexPath,
    claudePath: path.join(root, ".claude"),
    claudeUsageCommand: "",
    windowDays: 7,
    maxFiles: 100
  }, now);

  assert.equal(summary.providers.codex.limits[0].name, "session");
  assert.equal(summary.providers.codex.limits[0].leftPercent, 62);
  assert.equal(summary.providers.codex.limits[1].name, "weekly");
  assert.equal(summary.providers.codex.limits[1].leftPercent, 6);
  assert.equal(summary.providers.codex.limits[0].source, "codex-events");
  assert.equal(summary.providers.codex.tokens.total, 1050);

  const focused = renderKeySvg(summary, "codex");
  const combined = renderKeySvg(summary, "combined");
  assert.match(focused, /Session/);
  assert.match(focused, /62%/);
  assert.match(focused, /Weekly/);
  assert.match(focused, /6%/);
  assert.notEqual(focused, combined);
});

test("parseClaudeUsageText reads Claude Code /usage quota output", () => {
  const now = new Date("2026-06-12T02:45:00Z");
  const text = [
    "You are currently using your subscription to power your Claude Code usage",
    "",
    "Current session: 91% used · resets Jun 12 at 12:29pm (Asia/Shanghai)",
    "Current week (all models): 44% used · resets Jun 15 at 6pm (Asia/Shanghai)",
    "Current week (Sonnet only): 6% used · resets Jun 15 at 5:59pm (Asia/Shanghai)"
  ].join("\n");

  const limits = parseClaudeUsageText(text, now);
  assert.equal(limits.length, 3);

  assert.equal(limits[0].name, "session");
  assert.equal(limits[0].usedPercent, 91);
  assert.equal(limits[0].leftPercent, 9);
  assert.equal(limits[0].windowMinutes, 300);
  assert.equal(limits[0].source, "claude-cli");

  assert.equal(limits[1].name, "weekly");
  assert.equal(limits[1].usedPercent, 44);
  assert.equal(limits[1].leftPercent, 56);
  assert.equal(limits[1].windowMinutes, 10080);

  assert.equal(limits[2].name, "sonnet");
  assert.equal(limits[2].usedPercent, 6);
  assert.equal(limits[2].leftPercent, 94);
  assert.equal(limits[2].label, "Sonnet");
});

test("collectUsage attaches Claude Code CLI /usage limits", () => {
  const root = makeTempDir();
  const now = new Date("2026-06-12T02:45:00Z");
  const claudePath = path.join(root, ".claude", "projects");
  fs.mkdirSync(claudePath, { recursive: true });

  const command = path.join(root, "fake-claude");
  fs.writeFileSync(command, [
    "#!/bin/sh",
    "cat <<'OUT'",
    "You are currently using your subscription to power your Claude Code usage",
    "",
    "Current session: 91% used · resets Jun 12 at 12:29pm (Asia/Shanghai)",
    "Current week (all models): 44% used · resets Jun 15 at 6pm (Asia/Shanghai)",
    "Current week (Sonnet only): 6% used · resets Jun 15 at 5:59pm (Asia/Shanghai)",
    "OUT"
  ].join("\n"));
  fs.chmodSync(command, 0o755);

  const summary = collectUsage({
    codexPath: path.join(root, ".codex"),
    claudePath,
    claudeUsageCommand: command,
    maxFiles: 100
  }, now);

  assert.equal(summary.providers.claude.limits[0].name, "session");
  assert.equal(summary.providers.claude.limits[0].leftPercent, 9);
  assert.equal(summary.providers.claude.limits[1].name, "weekly");
  assert.equal(summary.providers.claude.limits[1].leftPercent, 56);
  assert.equal(summary.providers.claude.limits[2].name, "sonnet");
  assert.equal(summary.providers.claude.limits[2].leftPercent, 94);

  const sonnetSvg = renderKeySvg(summary, "claude-sonnet");
  assert.match(sonnetSvg, /Claude Sonnet/);
  assert.match(sonnetSvg, /94%/);
});

test("renderKeySvg supports single-purpose display modes", () => {
  const root = makeTempDir();
  const now = new Date("2026-06-10T15:40:00Z");
  const codexPath = path.join(root, ".codex");

  writeJsonl(path.join(codexPath, "sessions", "2026", "06", "10", "codex.jsonl"), [
    {
      timestamp: now.toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1000,
            output_tokens: 50,
            total_tokens: 1050
          }
        }
      },
      rate_limits: {
        primary: { used_percent: 38, window_minutes: 300, resets_at: "2026-06-10T17:30:43Z" },
        secondary: { used_percent: 94, window_minutes: 10080, resets_at: "2026-06-11T01:00:23Z" }
      }
    }
  ]);

  const summary = collectUsage({
    codexPath,
    claudePath: path.join(root, ".claude"),
    claudeUsageCommand: "",
    maxFiles: 100
  }, now);

  const modes = [
    "codex-session",
    "codex-weekly",
    "claude-session",
    "claude-weekly",
    "claude-sonnet",
    "cost-30d",
    "tokens-today"
  ];
  const svgs = modes.map((mode) => renderKeySvg(summary, mode));
  assert.equal(new Set(svgs).size, modes.length);
  assert.match(svgs[0], /Codex Session/);
  assert.match(svgs[1], /Codex Weekly/);
  assert.match(svgs[4], /Claude Sonnet/);
  assert.match(svgs[5], /30d Cost/);
  assert.match(svgs[6], /Today Tokens/);
});

test("collectUsage summarizes active agent sessions and human-input waits", () => {
  const root = makeTempDir();
  const now = new Date("2026-06-10T15:40:00Z");
  const activeTimestamp = now.toISOString();
  const codexPath = path.join(root, ".codex");
  const claudePath = path.join(root, ".claude", "projects");

  writeJsonl(path.join(codexPath, "sessions", "2026", "06", "10", "codex-running.jsonl"), [
    { timestamp: activeTimestamp, type: "session_meta", payload: { id: "codex-running", cwd: "/work/a" } },
    { timestamp: activeTimestamp, type: "response_item", payload: { type: "reasoning" } }
  ]);

  writeJsonl(path.join(codexPath, "sessions", "2026", "06", "10", "codex-input.jsonl"), [
    { timestamp: activeTimestamp, type: "session_meta", payload: { id: "codex-input", cwd: "/work/b" } },
    { timestamp: activeTimestamp, type: "response_item", payload: { type: "message", role: "assistant" } }
  ]);

  writeJsonl(path.join(claudePath, "project-a", "claude-input.jsonl"), [
    {
      timestamp: activeTimestamp,
      type: "assistant",
      sessionId: "claude-input",
      cwd: "/work/c",
      message: {
        role: "assistant",
        stop_reason: "end_turn"
      }
    }
  ]);

  writeJsonl(path.join(claudePath, "project-b", "claude-running.jsonl"), [
    {
      timestamp: activeTimestamp,
      type: "assistant",
      sessionId: "claude-running",
      cwd: "/work/d",
      message: {
        role: "assistant",
        stop_reason: "tool_use"
      }
    }
  ]);

  const summary = collectUsage({
    codexPath,
    claudePath,
    claudeUsageCommand: "",
    windowDays: 7,
    sessionLookbackHours: 24,
    activeSessionMinutes: 30,
    maxFiles: 100
  }, now);

  assert.equal(summary.sessions.codex.recent, 2);
  assert.equal(summary.sessions.codex.active, 2);
  assert.equal(summary.sessions.codex.running, 1);
  assert.equal(summary.sessions.codex.needsInput, 1);
  assert.equal(summary.sessions.claude.recent, 2);
  assert.equal(summary.sessions.claude.active, 2);
  assert.equal(summary.sessions.claude.running, 1);
  assert.equal(summary.sessions.claude.needsInput, 1);
  assert.equal(summary.sessions.total.active, 4);
  assert.equal(summary.sessions.total.running, 2);
  assert.equal(summary.sessions.total.needsInput, 2);

  const modes = ["agent-sessions", "codex-sessions", "claude-sessions", "needs-input"];
  const svgs = modes.map((mode) => renderKeySvg(summary, mode));
  assert.equal(new Set(svgs).size, modes.length);
  assert.match(svgs[0], /Agent Sessions/);
  assert.match(svgs[1], /Codex Sessions/);
  assert.match(svgs[2], /Claude Sessions/);
  assert.match(svgs[3], /Needs Input/);
});

test("collectUsage does not count stale or archived sessions as needing input", () => {
  const root = makeTempDir();
  const now = new Date("2026-06-10T15:40:00Z");
  const staleTimestamp = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
  const codexPath = path.join(root, ".codex");
  const claudePath = path.join(root, ".claude", "projects");

  writeJsonl(path.join(codexPath, "archived_sessions", "2026", "06", "10", "archived.jsonl"), [
    { timestamp: now.toISOString(), type: "session_meta", payload: { id: "archived-session", cwd: "/work/archived" } },
    { timestamp: now.toISOString(), type: "response_item", payload: { type: "message", role: "assistant" } }
  ]);

  writeJsonl(path.join(codexPath, "sessions", "2026", "06", "10", "stale-codex.jsonl"), [
    { timestamp: staleTimestamp, type: "session_meta", payload: { id: "stale-codex", cwd: "/work/stale" } },
    { timestamp: staleTimestamp, type: "response_item", payload: { type: "message", role: "assistant" } }
  ]);

  writeJsonl(path.join(claudePath, "project-a", "stale-claude.jsonl"), [
    {
      timestamp: staleTimestamp,
      type: "assistant",
      sessionId: "stale-claude",
      message: {
        role: "assistant",
        stop_reason: "end_turn"
      }
    }
  ]);

  const summary = collectUsage({
    codexPath,
    claudePath,
    claudeUsageCommand: "",
    windowDays: 7,
    sessionLookbackHours: 24,
    activeSessionMinutes: 30,
    maxFiles: 100
  }, now);

  assert.equal(summary.sessions.codex.recent, 1);
  assert.equal(summary.sessions.codex.active, 0);
  assert.equal(summary.sessions.codex.needsInput, 0);
  assert.equal(summary.sessions.claude.recent, 1);
  assert.equal(summary.sessions.claude.active, 0);
  assert.equal(summary.sessions.claude.needsInput, 0);
  assert.equal(summary.sessions.total.needsInput, 0);
});

test("collectUsage keeps newest Claude session status when subagent files share the session id", () => {
  const root = makeTempDir();
  const now = new Date("2026-06-10T15:40:00Z");
  const olderTimestamp = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  const toolUseTimestamp = new Date(now.getTime() - 90 * 1000).toISOString();
  const toolResultTimestamp = new Date(now.getTime() - 60 * 1000).toISOString();
  const claudePath = path.join(root, ".claude", "projects");
  const sessionId = "claude-shared-session";

  writeJsonl(path.join(claudePath, "project-a", "main.jsonl"), [
    {
      timestamp: toolUseTimestamp,
      type: "assistant",
      sessionId,
      cwd: "/work/main",
      message: {
        role: "assistant",
        stop_reason: "tool_use"
      }
    },
    {
      timestamp: toolResultTimestamp,
      type: "user",
      sessionId,
      cwd: "/work/main",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_test",
            content: "ok"
          }
        ]
      }
    }
  ]);

  writeJsonl(path.join(claudePath, "project-a", "subagents", "agent.jsonl"), [
    {
      timestamp: olderTimestamp,
      type: "assistant",
      sessionId,
      cwd: "/work/subagent",
      message: {
        role: "assistant",
        stop_reason: "end_turn"
      }
    }
  ]);

  const summary = collectUsage({
    codexPath: path.join(root, ".codex"),
    claudePath,
    claudeUsageCommand: "",
    includeClaudeSubagents: true,
    windowDays: 7,
    sessionLookbackHours: 24,
    activeSessionMinutes: 30,
    maxFiles: 100
  }, now);

  assert.equal(summary.sessions.claude.active, 1);
  assert.equal(summary.sessions.claude.running, 1);
  assert.equal(summary.sessions.claude.needsInput, 0);
  assert.equal(summary.sessions.claude.items[0].lastRole, "tool");
  assert.equal(summary.sessions.claude.items[0].lastStopReason, "tool_use");
});
