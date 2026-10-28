---
name: setup
description: Set up or repair Claude Code on a self-hosted OpenAI-compatible model for one private folder. Run by the user with the server URL and model ids.
argument-hint: <base-url> <main-model> [simple-model] [folder-name]
disable-model-invocation: true
---

# Self-hosted model setup

Arguments: `$ARGUMENTS`

If the arguments do not hold at least a URL and a model id, stop and show the usage:
`/self-hosted-model:setup <base-url> <main-model> [simple-model] [folder-name]`,
for example `/self-hosted-model:setup https://ai.example.com/api Main-LLM Simple-LLM AI-private`.

Otherwise:

1. Tell the user, in their language, in one line: a macOS dialog will ask for the server's API key, and setup takes a few minutes.
2. Run, with a 10-minute timeout:
   `bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh" $ARGUMENTS`
3. Never read, print or copy anything from `~/.config/self-hosted-model/`, and never ask for the API key in the chat: it holds the keys.
4. On `ERROR:`, show that line and what it means in plain words. When the key was refused, setup can ask for it again with
   `SHM_NEW_KEY=1 bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh" $ARGUMENTS`.
5. On `DONE.`, open the folder in a new VS Code window:
   `"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --new-window "<folder from the DONE line>"`
   Then tell the user, in their language: in that window click Trust if asked, open the Claude panel and work there;
   files with sensitive data go only into that folder; other windows keep using Claude as before.
