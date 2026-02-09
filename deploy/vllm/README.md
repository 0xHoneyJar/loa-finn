# vLLM GPU Deployment Guide

Self-hosted Qwen2.5-Coder inference via vLLM with health-based fallback routing.

## Architecture

```
                   ┌─────────────┐
                   │  loa-finn   │
                   │  (port 3000)│
                   └──┬──────┬───┘
                      │      │
              primary │      │ fallback
                      ▼      ▼
              ┌──────────┐ ┌──────────┐
              │ vllm-7b  │ │ vllm-1.5b│
              │ AWQ      │ │ FP16     │
              │ port 8000│ │ port 8001│
              └──────────┘ └──────────┘
                      │      │
                      ▼      ▼
                ┌──────────────┐
                │ vllm-models  │
                │ (shared vol) │
                └──────────────┘
```

**Primary**: Qwen2.5-Coder-7B-Instruct AWQ (quantized, lower VRAM)
**Fallback**: Qwen2.5-Coder-1.5B-Instruct FP16 (smaller, faster cold start)

Health-based routing automatically degrades to 1.5B when 7B is unhealthy (circuit breaker OPEN state).

## GPU Memory Requirements

| Model | Precision | VRAM Required | Recommended GPU |
|-------|-----------|---------------|-----------------|
| Qwen2.5-Coder-7B-Instruct | AWQ (4-bit) | ~6 GB | RTX 3060 12GB, A10G, T4 |
| Qwen2.5-Coder-1.5B-Instruct | FP16 | ~4 GB | RTX 3060 12GB, A10G, T4 |
| Both models (dual GPU) | Mixed | ~10 GB total | Single A10G 24GB or 2x T4 |
| Both models (single GPU) | Mixed | ~10 GB | A10G 24GB, RTX 4090, A100 |

> **Note**: GPU memory utilization is set to 0.90 by default. Reduce `GPU_MEMORY_UTILIZATION` if you see OOM errors.

## Quick Start (docker-compose)

### 1. Download model weights

```bash
# Create the volume and download models
docker volume create vllm-models
docker run --rm -v vllm-models:/models python:3.11-slim \
  bash -c "pip install huggingface-hub && \
    huggingface-cli download Qwen/Qwen2.5-Coder-7B-Instruct --local-dir /models/Qwen/Qwen2.5-Coder-7B-Instruct && \
    huggingface-cli download Qwen/Qwen2.5-Coder-1.5B-Instruct --local-dir /models/Qwen/Qwen2.5-Coder-1.5B-Instruct"
```

Or use the init script:

```bash
docker run --rm -v vllm-models:/models python:3.11-slim \
  bash /app/deploy/vllm/init-models.sh
```

### 2. Set environment variables

```bash
export CHEVAL_HMAC_SECRET=$(openssl rand -hex 32)
# Optional: R2/S3 for ledger export
# export R2_ENDPOINT=https://your-account.r2.cloudflarestorage.com
# export R2_BUCKET=loa-finn-data
# export R2_ACCESS_KEY_ID=your-key
# export R2_SECRET_ACCESS_KEY=your-secret
```

### 3. Launch

```bash
docker compose -f docker-compose.gpu.yml up -d
```

### 4. Verify

```bash
# Check health
curl http://localhost:8000/health   # vllm-7b
curl http://localhost:8001/health   # vllm-1.5b
curl http://localhost:3000/health   # loa-finn

# Test inference
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"Qwen/Qwen2.5-Coder-7B-Instruct","messages":[{"role":"user","content":"Hello"}],"max_tokens":32}'
```

## Environment Variable Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `CHEVAL_HMAC_SECRET` | (required) | HMAC secret for sidecar auth |
| `CHEVAL_HMAC_SECRET_PREV` | | Previous HMAC secret for key rotation |
| `CHEVAL_MODE` | `subprocess` | Set to `sidecar` for HTTP mode |
| `CHEVAL_PORT` | `3001` | Sidecar HTTP port |
| `REDIS_URL` | | Redis URL (e.g., `redis://redis:6379`) |
| `VLLM_PRIMARY_ENDPOINT` | `http://vllm-7b:8000/v1` | Primary vLLM endpoint |
| `VLLM_FALLBACK_ENDPOINT` | `http://vllm-1.5b:8001/v1` | Fallback vLLM endpoint |
| `GPU_MEMORY_UTILIZATION` | `0.90` | vLLM GPU memory fraction (0.0-1.0) |
| `MAX_MODEL_LEN` | `32768` | Max context length for vLLM |
| `TENSOR_PARALLEL_SIZE` | `1` | Number of GPUs for tensor parallelism |
| `QUANTIZATION` | `awq` | Quantization method (empty for FP16) |
| `R2_ENDPOINT` | | Cloudflare R2 endpoint for ledger export |
| `R2_BUCKET` | `loa-finn-data` | R2/S3 bucket name |
| `R2_ACCESS_KEY_ID` | | R2/S3 access key |
| `R2_SECRET_ACCESS_KEY` | | R2/S3 secret key |

## Cloud Platform Guides

### Fly.io (GPU Machines)

Fly.io offers GPU machines with A10G and A100 GPUs.

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Create app
fly apps create loa-finn-vllm

# Create volume for model weights
fly volumes create vllm_models --size 50 --region ord

# Download models into volume (one-time)
fly machine run python:3.11-slim \
  --volume vllm_models:/models \
  --command "pip install huggingface-hub && huggingface-cli download Qwen/Qwen2.5-Coder-7B-Instruct --local-dir /models/Qwen/Qwen2.5-Coder-7B-Instruct && huggingface-cli download Qwen/Qwen2.5-Coder-1.5B-Instruct --local-dir /models/Qwen/Qwen2.5-Coder-1.5B-Instruct"
```

Create `fly.toml`:

```toml
app = "loa-finn-vllm"
primary_region = "ord"

[build]
  dockerfile = "deploy/vllm/Dockerfile"

[env]
  MODEL_ID = "Qwen/Qwen2.5-Coder-7B-Instruct"
  QUANTIZATION = "awq"
  GPU_MEMORY_UTILIZATION = "0.90"
  MAX_MODEL_LEN = "32768"

[mounts]
  source = "vllm_models"
  destination = "/models"

[[vm]]
  size = "a10g"      # 24GB VRAM — fits both models
  memory = "16gb"
  cpus = 4

[[services]]
  internal_port = 8000
  protocol = "tcp"

  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]

  [[services.http_checks]]
    interval = 30000
    timeout = 5000
    path = "/health"
```

```bash
# Deploy
fly deploy

# Set secrets for loa-finn
fly secrets set CHEVAL_HMAC_SECRET=$(openssl rand -hex 32)
fly secrets set VLLM_PRIMARY_ENDPOINT=https://loa-finn-vllm.fly.dev/v1
```

### RunPod

RunPod offers on-demand GPU instances with pre-built vLLM templates.

```bash
# Option 1: Use RunPod's vLLM template (recommended)
# 1. Go to runpod.io → Pods → Deploy
# 2. Select "RunPod vLLM" template
# 3. Choose GPU: RTX A6000 (48GB) or A10G (24GB)
# 4. Set environment variables:
#    MODEL_ID=Qwen/Qwen2.5-Coder-7B-Instruct
#    QUANTIZATION=awq
#    MAX_MODEL_LEN=32768

# Option 2: Custom Docker image
# 1. Push your image to Docker Hub or GHCR
docker build -t ghcr.io/your-org/loa-vllm:latest -f deploy/vllm/Dockerfile deploy/vllm/
docker push ghcr.io/your-org/loa-vllm:latest

# 2. Create RunPod pod with custom image
#    Image: ghcr.io/your-org/loa-vllm:latest
#    Volume: /models (Network Volume, 50GB)
#    GPU: RTX A6000 or A10G
#    Port: 8000
```

RunPod network volumes persist across pod restarts:

```bash
# Create network volume (RunPod UI or API)
# Mount at /models
# Run init-models.sh once to populate

# Connect from loa-finn
export VLLM_PRIMARY_ENDPOINT=https://your-pod-id-8000.proxy.runpod.net/v1
```

### Lambda Labs

Lambda Labs provides cloud GPUs with direct SSH access.

```bash
# 1. Launch instance
#    GPU: 1x A10G (24GB) or 1x RTX A6000 (48GB)
#    Image: Ubuntu 22.04 + CUDA 12.x

# 2. SSH and install
ssh ubuntu@<instance-ip>
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin nvidia-container-toolkit
sudo systemctl restart docker

# 3. Clone and deploy
git clone https://github.com/0xHoneyJar/loa-finn.git
cd loa-finn

# 4. Download models
mkdir -p /data/vllm-models
MODEL_DIR=/data/vllm-models bash deploy/vllm/init-models.sh

# 5. Update volume path in docker-compose.gpu.yml
# Replace "vllm-models:" volume with bind mount:
#   volumes:
#     - /data/vllm-models:/models

# 6. Launch
export CHEVAL_HMAC_SECRET=$(openssl rand -hex 32)
docker compose -f docker-compose.gpu.yml up -d

# 7. Verify
curl http://localhost:8000/health
curl http://localhost:3000/health
```

## Single-GPU Setup

To run both models on a single GPU (24GB+ VRAM recommended):

```yaml
# Adjust docker-compose.gpu.yml GPU memory:
# vllm-7b: GPU_MEMORY_UTILIZATION=0.55 (~13GB for 7B AWQ)
# vllm-1.5b: GPU_MEMORY_UTILIZATION=0.35 (~8GB for 1.5B FP16)
```

Both services can share the same GPU device. Docker's NVIDIA runtime handles memory isolation.

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| OOM at startup | GPU memory too small | Reduce `GPU_MEMORY_UTILIZATION` or `MAX_MODEL_LEN` |
| Model loading timeout | Slow disk/network | Increase `start_period` in healthcheck (default 120s) |
| 7B always unhealthy | AWQ not supported on GPU | Use FP16 (set `QUANTIZATION=""`) or use newer GPU |
| Connection refused | Service not ready | Wait for healthcheck to pass (can take 2-3 min) |
| Permission denied on /models | Volume mount issue | Ensure volume exists and has correct permissions |
| `CHEVAL_HMAC_SECRET not set` | Missing env var | Set `CHEVAL_HMAC_SECRET` before starting loa-finn |
