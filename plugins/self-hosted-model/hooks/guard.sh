#!/bin/bash
# Blocks a prompt or tool call that touches the private folder unless the session runs on the local proxy.
# The folder's own settings route it there; this catches the folder opened in a window where they did not load.
CONF="$HOME/.config/self-hosted-model/guard.env"
[ -r "$CONF" ] || exit 0
. "$CONF"
[ -n "${SHM_FOLDER:-}" ] || exit 0
[ "${ANTHROPIC_BASE_URL%/}" = "$SHM_PROXY" ] && exit 0

input="$(cat)"
short="~/${SHM_FOLDER#"$HOME"/}"
case "$input" in
  *"$SHM_FOLDER"* | *"$short"*) ;;
  *) exit 0 ;;
esac

echo "STOP: $SHM_FOLDER is only for the self-hosted model, and this session does not run on it." \
  "Open that folder in its own VS Code window (File > Open Folder) and start a new chat there." >&2
exit 2
