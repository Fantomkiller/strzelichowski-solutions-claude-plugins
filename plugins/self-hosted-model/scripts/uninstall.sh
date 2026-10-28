#!/bin/bash
# Removes the proxy, its Python and keys. Leaves the private folder and its files in place.
set -uo pipefail

CONF="$HOME/.config/self-hosted-model"
DATA="$HOME/.local/share/self-hosted-model"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
SHM_FOLDER="" SHM_LABEL="com.strzelichowski.self-hosted-model"
[ -r "$CONF/guard.env" ] && . "$CONF/guard.env"

launchctl bootout "gui/$(id -u)/$SHM_LABEL" 2>/dev/null
rm -f "$HOME/Library/LaunchAgents/$SHM_LABEL.plist"
command -v uv >/dev/null && uv tool uninstall litellm >/dev/null 2>&1
[ -n "$SHM_FOLDER" ] && rm -f "$SHM_FOLDER/.claude/settings.local.json"
rm -rf "$DATA" "$CONF"

echo "Removed. Kept: ${SHM_FOLDER:-the private folder} with your files, and uv."
