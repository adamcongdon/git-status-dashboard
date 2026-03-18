#!/usr/bin/env bash
set -euo pipefail

PLIST_LABEL="com.git-status-dashboard"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
LOG_DIR="$HOME/Library/Logs"
LOG_OUT="$LOG_DIR/git-status-dashboard.log"
LOG_ERR="$LOG_DIR/git-status-dashboard.error.log"
PORT=3847

# Resolve absolute paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/config.json"

echo ""
echo "Git Status Dashboard — Installer"
echo "================================="
echo ""

# 1. Check bun is installed
if ! BUN_PATH="$(which bun 2>/dev/null)"; then
  echo "Error: bun is not installed or not in PATH."
  echo "Install bun: https://bun.sh"
  exit 1
fi
echo "✓ Found bun at: $BUN_PATH"

# 2. Validate or create config.json
if [ -f "$CONFIG" ] && python3 -c "
import json, sys
try:
  d = json.load(open('$CONFIG'))
  dirs = d.get('projectDirs', [])
  sys.exit(0 if isinstance(dirs, list) and len(dirs) > 0 else 1)
except: sys.exit(1)
" 2>/dev/null; then
  echo "✓ Config found: $CONFIG"
else
  echo ""
  echo "No valid config.json found. Let's set it up."
  echo "Enter project directories to scan (comma-separated)."
  echo "Press Enter to use the default: ~/code"
  echo ""
  read -r -p "> " DIR_INPUT

  if [ -z "$DIR_INPUT" ]; then
    DIRS_JSON="[\"$HOME/code\"]"
    echo "Using default: $HOME/code"
  else
    # Convert comma-separated input to JSON array, expanding ~ to $HOME
    DIRS_JSON="$(echo "$DIR_INPUT" | python3 -c "
import sys, json
raw = sys.stdin.read().strip()
parts = [p.strip().replace('~', '$HOME') for p in raw.split(',') if p.strip()]
print(json.dumps(parts))
" HOME="$HOME")"
  fi

  echo "{ \"projectDirs\": $DIRS_JSON }" > "$CONFIG"
  echo "✓ Config saved to $CONFIG"
fi

# 3. Create log directory if needed
mkdir -p "$LOG_DIR"

# 4. Remove existing installation if present
if launchctl list "$PLIST_LABEL" &>/dev/null; then
  echo "Removing existing installation..."
  launchctl bootout "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null || \
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

# 5. Write the LaunchAgent plist
cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${BUN_PATH}</string>
        <string>run</string>
        <string>${SCRIPT_DIR}/server.ts</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${SCRIPT_DIR}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${HOME}</string>
        <key>PATH</key>
        <string>$(dirname "$BUN_PATH"):/usr/local/bin:/usr/bin:/bin</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${LOG_OUT}</string>

    <key>StandardErrorPath</key>
    <string>${LOG_ERR}</string>
</dict>
</plist>
PLIST

echo "✓ LaunchAgent plist written to: $PLIST_PATH"

# 6. Load the LaunchAgent (macOS 13+ uses bootstrap, older uses load)
if launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null; then
  echo "✓ LaunchAgent loaded (bootstrap)"
elif launchctl load "$PLIST_PATH" 2>/dev/null; then
  echo "✓ LaunchAgent loaded (legacy)"
else
  echo "Warning: could not load LaunchAgent automatically."
  echo "You can load it manually: launchctl load \"$PLIST_PATH\""
fi

echo ""
echo "================================="
echo "✓ Installation complete!"
echo ""
echo "  Dashboard: http://localhost:${PORT}"
echo "  Logs:      $LOG_OUT"
echo "  Config:    $CONFIG"
echo ""
echo "The server will start automatically on every login."
echo "To uninstall: ./uninstall.sh"
echo ""

# 7. Open the dashboard in the default browser
if command -v open &>/dev/null; then
  sleep 1
  open "http://localhost:${PORT}" &
fi
