#!/bin/sh
# Optional voice add-on: local text-to-speech (Piper) and speech-to-text (faster-whisper), no cloud.
# Installs into ~/.local/share/agent-monitor/voice (a uv-managed venv + one English voice). Needs `uv` and PipeWire (pw-record).
# Usage: install-voice.sh [--uninstall]
set -eu
DIR=${AM_VOICE_DIR:-$HOME/.local/share/agent-monitor/voice}
VOICE=en_GB-alan-medium   # calm British male, assistant style
HF=https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/alan/medium
if [ "${1:-}" = "--uninstall" ]; then rm -rf "$DIR"; echo "removed $DIR"; exit 0; fi
command -v uv >/dev/null || { echo "needs uv: sudo pacman -S uv" >&2; exit 1; }
command -v pw-record >/dev/null || { echo "needs PipeWire's pw-record: sudo pacman -S pipewire" >&2; exit 1; }
# WebKit plays the replies through GStreamer; without autoaudiosink the web process aborts
gst-inspect-1.0 autoaudiosink >/dev/null 2>&1 || { echo "needs GStreamer autoaudiosink: sudo pacman -S gst-plugins-good" >&2; exit 1; }
mkdir -p "$DIR"
echo "+ venv $DIR/venv (python 3.12)"
uv venv -q --allow-existing --python 3.12 "$DIR/venv"
echo "+ pip install piper-tts faster-whisper"
uv pip install -q --python "$DIR/venv/bin/python" piper-tts faster-whisper
for f in "$VOICE.onnx" "$VOICE.onnx.json"; do
  [ -s "$DIR/$f" ] || { echo "+ download $f"; curl -fsSL -o "$DIR/$f.part" "$HF/$f" && mv "$DIR/$f.part" "$DIR/$f"; }
done
echo "+ warm up the speech model (first run downloads ~250 MB)"
"$DIR/venv/bin/python" -c 'from faster_whisper import WhisperModel; WhisperModel("small.en", device="cpu", compute_type="int8")'
echo "voice ready — restart the service: systemctl --user restart agent-monitor"
