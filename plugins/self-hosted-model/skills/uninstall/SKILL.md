---
name: uninstall
description: Remove the self-hosted model proxy, its Python and keys, keeping the private folder and its files.
disable-model-invocation: true
---

# Self-hosted model uninstall

Run `bash "${CLAUDE_PLUGIN_ROOT}/scripts/uninstall.sh"` and show its last line.
Then tell the user, in their language, that the plugin itself goes with `/plugin uninstall self-hosted-model@strzelichowski-solutions`
and that the private folder and its files were left in place.
