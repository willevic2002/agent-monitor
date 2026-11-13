# Agent Monitor

A small native Linux app for watching and steering [Claude Code](https://docs.claude.com/en/docs/claude-code) sessions live.

- **Brain view:** a 3D "brain" where the lead agent and every running subagent show up as glowing neuron clusters. Next to it are a tool-call log, a chat panel, a per-agent token and cost breakdown, and permission cards with Allow and Deny buttons. Click an agent to see its own chat and tools.
- **Graph view:** the same session laid out as waves of subagents.
- **Permission modes:** *Ask me*, *Accept edits*, *Auto (runs on its own)* and *Plan mode*. You can switch modes in the middle of a run.

It runs your own `claude` CLI with your own settings, plugins and hooks. Nothing goes anywhere except `127.0.0.1`. The UI is a GTK and WebKitGTK window, so no browser tab is involved.

## Requirements (Arch Linux)

```sh
sudo pacman -S --needed python python-gobject gtk3 webkit2gtk-4.1
```

You also need the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code/setup) installed and logged in. `claude --version` should work in a terminal.

## Install

```sh
git clone https://github.com/willevic2002/agent-monitor.git ~/agent-monitor
cd ~/agent-monitor
packaging/install.sh            # --dry-run shows what it would do, --uninstall removes it
```

The installer does four things:
- sets up a systemd **user** service that serves on `127.0.0.1:7777`;
- adds a launcher at `~/.local/bin/agent-monitor`;
- adds a desktop entry, so the app shows up in your app menu;
- on Hyprland with a Lua config (Omarchy), binds **SUPER+ALT+A**. If that key is already taken it skips this step.

Start it from the app menu, with `agent-monitor`, or with SUPER+ALT+A. Type a prompt in the chat panel on the left to start a session.

Use another port with `AM_PORT=7788 packaging/install.sh`. The service looks for `claude` in `~/.local/bin`, mise and `/usr/bin`. If yours lives somewhere else, edit `PATH` in `~/.config/systemd/user/agent-monitor.service`.

## Voice (optional, fully local)

```sh
sudo pacman -S --needed uv pipewire ffmpeg
packaging/install-voice.sh && systemctl --user restart agent-monitor
```

- **Voice out:** Piper reads the lead's replies aloud, and also says when a permission is needed or a run is done. Toggle it with 🔈 in the header.
- **Voice in:** hold 🎙, or hold **Space** outside the text field, and speak. faster-whisper turns the speech into a prompt when you let go.
- **Other voices:** put another Piper voice (`name.onnx` + `name.onnx.json`) in `~/.local/share/agent-monitor/voice/` and write `{"piper_model": "name", "fx": false}` to `~/.config/agent-monitor/voice.json`.

## Security notes

- The server only listens on `127.0.0.1`. The API needs a random token, stored at `~/.config/agent-monitor/token` with mode 0600. The window logs in with a one-time nonce.
- *Auto* mode lets Claude approve its own actions; Claude still blocks risky ones. `bypassPermissions` is intentionally not offered.

## Tests

```sh
for t in test_*.py; do python3 "$t"; done
cd tests/e2e && npm ci && node run.mjs     # needs /usr/bin/chromium; uses a fake claude, no tokens spent
```

## Licence

Vendored libraries: three.js (MIT) and cytoscape.js (MIT). Their licences are in `vendor/`.
