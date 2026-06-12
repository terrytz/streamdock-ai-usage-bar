# Install StreamDock AI Usage

This document is for humans and AI agents installing the plugin on macOS or Windows.

## What Gets Installed

StreamDock plugins are folders ending in `.sdPlugin`. This project's plugin folder is:

```text
com.terry.ai-usage.sdPlugin
```

The plugin is installed by placing that folder inside StreamDock's plugins directory, then restarting StreamDock.

## Prerequisites

- StreamDock / HotSpot StreamDock `3.10.191.0421` or newer.
- macOS 10.15+ or Windows 10+.
- Git, if installing from the repository.
- Codex CLI installed and signed in for Codex quota/session data.
- Claude Code CLI installed and signed in for Claude quota/session data.

The plugin does not require a separate Node.js install for normal use. StreamDock launches it with the Node.js runtime declared in `manifest.json`.

Default data paths:

```text
Codex:  ~/.codex
Claude: ~/.claude
```

Claude quota rows come from:

```sh
claude -p "/usage"
```

If a CLI is missing or not signed in, the plugin still loads, but that provider's quota fields may show no data.

## macOS Install

### 1. Clone

```sh
git clone git@github.com:terrytz/streamdock-ai-usage-bar.git
cd streamdock-ai-usage-bar
```

### 2. Install With Symlink

Symlink install is recommended on macOS because future repo updates are picked up after restarting StreamDock.

```sh
mkdir -p "$HOME/Library/Application Support/HotSpot/StreamDock/plugins"
ln -sfn "$PWD/com.terry.ai-usage.sdPlugin" "$HOME/Library/Application Support/HotSpot/StreamDock/plugins/com.terry.ai-usage.sdPlugin"
```

### 3. Restart StreamDock

```sh
osascript -e 'tell application "StreamDock" to quit' || true
open -a StreamDock
```

### 4. Verify

```sh
test -f "$HOME/Library/Application Support/HotSpot/StreamDock/plugins/com.terry.ai-usage.sdPlugin/manifest.json" && echo "installed"
```

## Windows Install

Use PowerShell.

### 1. Clone

```powershell
git clone git@github.com:terrytz/streamdock-ai-usage-bar.git
cd streamdock-ai-usage-bar
```

### 2. Install By Copy

Copy install is recommended on Windows because symlink creation may require Developer Mode or administrator privileges.

```powershell
$pluginDir = Join-Path $env:APPDATA "HotSpot\StreamDock\plugins"
New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
$target = Join-Path $pluginDir "com.terry.ai-usage.sdPlugin"
Copy-Item -Recurse -Force ".\com.terry.ai-usage.sdPlugin" $target
```

### 3. Restart StreamDock

```powershell
Stop-Process -Name StreamDock -ErrorAction SilentlyContinue
Start-Process "StreamDock" -ErrorAction SilentlyContinue
```

If `Start-Process "StreamDock"` cannot find the app, start StreamDock manually from the Start menu.

### 4. Verify

```powershell
Test-Path (Join-Path $env:APPDATA "HotSpot\StreamDock\plugins\com.terry.ai-usage.sdPlugin\manifest.json")
```

## Updating

### macOS Symlink Install

```sh
cd streamdock-ai-usage-bar
git pull
osascript -e 'tell application "StreamDock" to quit' || true
open -a StreamDock
```

### Windows Copy Install

```powershell
cd streamdock-ai-usage-bar
git pull
$pluginDir = Join-Path $env:APPDATA "HotSpot\StreamDock\plugins"
$target = Join-Path $pluginDir "com.terry.ai-usage.sdPlugin"
Copy-Item -Recurse -Force ".\com.terry.ai-usage.sdPlugin" $target
Stop-Process -Name StreamDock -ErrorAction SilentlyContinue
Start-Process "StreamDock" -ErrorAction SilentlyContinue
```

## AI Agent Safety Rules

Agents should:

- Only install `com.terry.ai-usage.sdPlugin`.
- Create the StreamDock plugins directory if it does not exist.
- Prefer symlink on macOS and copy on Windows.
- Restart StreamDock after install.
- Verify `manifest.json` exists in the installed plugin folder.
- Never delete user Codex, Claude, or StreamDock data.
- Never edit credentials, keychains, cookies, or browser caches.
