#!/usr/bin/env bash
# deploy/vllm/init-models.sh — Download model weights to shared volume (SDD §4.11, T-3.1)
# Run once to populate the vllm-models volume.
# Can also be used as an init container command.
set -euo pipefail

MODEL_DIR="${MODEL_DIR:-/models}"

echo "[init-models] Installing huggingface-hub CLI..."
pip install --quiet huggingface-hub

echo "[init-models] Downloading Qwen2.5-Coder-7B-Instruct..."
huggingface-cli download Qwen/Qwen2.5-Coder-7B-Instruct \
  --local-dir "${MODEL_DIR}/Qwen/Qwen2.5-Coder-7B-Instruct"

echo "[init-models] Downloading Qwen2.5-Coder-1.5B-Instruct..."
huggingface-cli download Qwen/Qwen2.5-Coder-1.5B-Instruct \
  --local-dir "${MODEL_DIR}/Qwen/Qwen2.5-Coder-1.5B-Instruct"

echo "[init-models] Done. Models available at ${MODEL_DIR}"
ls -la "${MODEL_DIR}/Qwen/"
