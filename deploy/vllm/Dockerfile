# deploy/vllm/Dockerfile — vLLM runtime (SDD §4.11, T-3.1)
# Model weights loaded from volume mount at /models, NOT baked into image.
# This keeps the image small (~2GB) and allows model changes without rebuilds.
FROM vllm/vllm-openai:v0.6.3

ARG MODEL_ID=Qwen/Qwen2.5-Coder-7B-Instruct
ARG QUANTIZATION=awq

# NO model download at build time — weights come from volume mount.
# Use init-models.sh or an init container to populate the volume.

# Runtime configuration via environment
ENV MODEL_ID=${MODEL_ID}
ENV QUANTIZATION=${QUANTIZATION}
ENV MAX_MODEL_LEN=32768
ENV GPU_MEMORY_UTILIZATION=0.90
ENV TENSOR_PARALLEL_SIZE=1

EXPOSE 8000

# Use shell form to expand env vars at runtime
CMD python3 -m vllm.entrypoints.openai.api_server \
    --model /models/${MODEL_ID} \
    ${QUANTIZATION:+--quantization ${QUANTIZATION}} \
    --max-model-len ${MAX_MODEL_LEN} \
    --gpu-memory-utilization ${GPU_MEMORY_UTILIZATION} \
    --tensor-parallel-size ${TENSOR_PARALLEL_SIZE} \
    --port 8000 \
    --host 0.0.0.0
