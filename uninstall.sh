#!/usr/bin/env bash
set -euo pipefail

PLIST_LABEL="com.git-status-dashboard"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

echo ""
echo "Git Status Dashboard — Uninstaller"
echo "===================================="
echo ""

# Unload the LaunchAgent
if launchctl list "$PLIST_LABEL" &>/dev/null; then
  if launchctl bootout "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null; then
    echo "✓ LaunchAgent unloaded (bootout)"
  elif launchctl unload "$PLIST_PATH" 2>/dev/null; then
    echo "✓ LaunchAgent unloaded (legacy)"
  else
    echo "Warning: could not unload LaunchAgent. It may already be stopped."
  fi
else
  echo "  LaunchAgent was not running."
fi

# Remove the plist
if [ -f "$PLIST_PATH" ]; then
  rm -f "$PLIST_PATH"
  echo "✓ Plist removed: $PLIST_PATH"
else
  echo "  Plist not found (already removed)."
fi

echo ""
echo "===================================="
echo "✓ Uninstall complete. Server stopped."
echo "   Run ./install.sh to reinstall."
echo ""
