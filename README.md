# StreamDock AI Usage

StreamDock plugin for showing local Codex and Claude usage on StreamDock / Stream Deck style keys.

The plugin reads local JSONL histories from `~/.codex/sessions`, `~/.codex/archived_sessions`, and `~/.claude/projects`. It also uses CodexBar local history/cache files when available, which provides richer session and weekly quota data.

## Display Modes

- `Combined`: Codex and Claude session/weekly status on one key.
- `Codex Overview`: Codex session and weekly quota bars.
- `Claude Overview`: Claude session and weekly quota bars.
- `Codex Session`: one large Codex session quota button.
- `Codex Weekly`: one large Codex weekly quota button.
- `Claude Session`: one large Claude session quota button.
- `Claude Weekly`: one large Claude weekly quota button.
- `Claude Sonnet`: one large Sonnet quota button, backed by CodexBar's current model-limit bucket.
- `30d Cost`: combined Codex + Claude 30-day cost.
- `Today Tokens`: combined Codex + Claude tokens today.

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
7. Do not delete or modify user data under `~/.codex`, `~/.claude`, CodexBar caches, or StreamDock configuration except for installing this plugin folder.
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

- CodexBar data is optional. If present, it supplies session/weekly quota and cost windows.
- Without CodexBar data, the plugin falls back to local Codex and Claude JSONL usage/activity history.
- Runtime logs are written under `com.terry.ai-usage.sdPlugin/logs/` and are ignored by git.
