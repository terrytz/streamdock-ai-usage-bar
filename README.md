# StreamDock AI Usage

StreamDock plugin for showing local Codex and Claude usage on StreamDock / Stream Deck style keys.

The plugin reads local CLI data from Codex CLI and Claude Code CLI. Codex quota data comes from Codex CLI `rate_limits` records under the configured Codex data path, usually `~/.codex`; Claude quota data comes from parsing `claude -p "/usage"`; Claude Code token/session activity comes from the configured Claude data path, usually `~/.claude`.

All visible keys share one process-wide usage snapshot. The Property Inspector separates per-key display from shared datasource settings. `Display` belongs to the selected key; datasource settings such as refresh interval, scan window, data paths, and session thresholds are propagated across AI Usage keys so every key renders from the same collected Codex/Claude summary.

## Display Modes

- `Combined`: Codex CLI and Claude Code session/weekly status on one key.
- `Codex Overview`: Codex CLI session and weekly quota bars.
- `Claude Overview`: Claude Code session and weekly quota bars plus local activity.
- `Codex Session`: one large Codex session quota button.
- `Codex Weekly`: one large Codex weekly quota button.
- `Claude Session`: one large Claude Code session quota button.
- `Claude Weekly`: one large Claude Code weekly quota button.
- `Claude Sonnet`: one large Claude Code Sonnet-only weekly quota button.
- `30d Cost`: reserved for local cost data when available.
- `Today Tokens`: combined Codex + Claude tokens today.
- `Agent Sessions`: active, working, and needs-input counts across Codex CLI and Claude Code.
- `Codex Sessions`: focused Codex CLI session monitor.
- `Claude Sessions`: focused Claude Code session monitor.
- `Needs Input`: one large human-input-needed counter with Codex/Claude split.

Session monitor modes scan recent local JSONL session files. A session is `active` when its latest event is inside the configured active window, `working` when the latest event looks like reasoning/tool work, and `needs input` when the latest assistant response appears complete and is waiting for the next human turn. The defaults are a 24-hour lookback and a 30-minute active window.

## Quick Install

See [INSTALL.md](INSTALL.md) for full macOS and Windows instructions.

### macOS

```sh
git clone git@github.com:terrytz/streamdock-ai-usage-bar.git
cd streamdock-ai-usage-bar
mkdir -p "$HOME/Library/Application Support/HotSpot/StreamDock/plugins"
ln -s "$PWD/com.terry.ai-usage.sdPlugin" "$HOME/Library/Application Support/HotSpot/StreamDock/plugins/com.terry.ai-usage.sdPlugin"
osascript -e 'tell application "StreamDock" to quit' || true
open -a StreamDock
```

### Windows PowerShell

```powershell
git clone git@github.com:terrytz/streamdock-ai-usage-bar.git
cd streamdock-ai-usage-bar
$pluginDir = Join-Path $env:APPDATA "HotSpot\StreamDock\plugins"
New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
$target = Join-Path $pluginDir "com.terry.ai-usage.sdPlugin"
Copy-Item -Recurse -Force ".\com.terry.ai-usage.sdPlugin" $target
Stop-Process -Name StreamDock -ErrorAction SilentlyContinue
Start-Process "StreamDock" -ErrorAction SilentlyContinue
```

## AI Agent Install Prompt

Copy this prompt into Codex, Claude Code, Hermes Agent, or another local coding agent:

```text
Install the StreamDock AI Usage plugin from GitHub.

Repo: git@github.com:terrytz/streamdock-ai-usage-bar.git

Requirements:
1. Clone or update the repo into a local development folder.
2. Install the StreamDock plugin folder named `com.terry.ai-usage.sdPlugin`.
3. On macOS, install it into:
   `~/Library/Application Support/HotSpot/StreamDock/plugins/com.terry.ai-usage.sdPlugin`
   Prefer a symlink from the cloned repo for development. Create the plugins directory if needed.
4. On Windows, install it into:
   `%APPDATA%\HotSpot\StreamDock\plugins\com.terry.ai-usage.sdPlugin`
   Prefer copying the plugin folder unless symlink permissions are clearly available.
5. Restart StreamDock after installation.
6. Verify that the plugin manifest exists at:
   `<StreamDock plugins folder>/com.terry.ai-usage.sdPlugin/manifest.json`
7. Do not delete or modify user data under `~/.codex`, `~/.claude`, or StreamDock configuration except for installing this plugin folder.
8. Report the final plugin install path and whether StreamDock was restarted.

Useful commands:

macOS:
mkdir -p "$HOME/Library/Application Support/HotSpot/StreamDock/plugins"
ln -sfn "$PWD/com.terry.ai-usage.sdPlugin" "$HOME/Library/Application Support/HotSpot/StreamDock/plugins/com.terry.ai-usage.sdPlugin"
osascript -e 'tell application "StreamDock" to quit' || true
open -a StreamDock

Windows PowerShell:
$pluginDir = Join-Path $env:APPDATA "HotSpot\StreamDock\plugins"
New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
$target = Join-Path $pluginDir "com.terry.ai-usage.sdPlugin"
Copy-Item -Recurse -Force ".\com.terry.ai-usage.sdPlugin" $target
Stop-Process -Name StreamDock -ErrorAction SilentlyContinue
Start-Process "StreamDock" -ErrorAction SilentlyContinue
```

## Development

```sh
npm test
npm run check
```

For a one-shot CLI preview of the parsed summary:

```sh
node com.terry.ai-usage.sdPlugin/plugin/index.js --once
```

## Notes

- The plugin does not read third-party usage caches. Quota displays must come from the CLIs' own data.
- Current Codex CLI writes session/weekly quota snapshots as `rate_limits` in its session JSONL. Current Claude Code exposes quota text through `claude -p "/usage"`; the plugin parses the `Current session`, `Current week (all models)`, and `Current week (Sonnet only)` lines.
- `Codex data` and `Claude data` settings are local transcript/history roots used for token totals and session/activity scanning. They are not used as account credentials.
- Property Inspector fields under `Shared Data Source` apply across AI Usage keys. The inspector shows the effective shared refresh interval and visible key count.
- Runtime logs are written under `com.terry.ai-usage.sdPlugin/logs/` and are ignored by git.
