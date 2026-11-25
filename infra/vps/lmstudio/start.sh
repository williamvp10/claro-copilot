#!/usr/bin/env bash
set -euo pipefail
lms=/home/lms/.lmstudio/bin/lms
model_dir=/home/lms/.lmstudio/models/lmstudio-community/Llama-3.2-3B-Instruct-GGUF
model_file=Llama-3.2-3B-Instruct-Q4_K_M.gguf
mkdir -p "$model_dir"
if [[ ! -f "$model_dir/$model_file" ]]; then
  curl --fail --silent --show-error --location --retry 3 --continue-at - \
    "https://huggingface.co/lmstudio-community/Llama-3.2-3B-Instruct-GGUF/resolve/c91307b5cf18c8106b1f8a6218c26ae4dbfee472/$model_file" \
    --output "$model_dir/$model_file.part"
  printf '%s  %s\n' e4f1a04d927b09ec18eb2f233d85ecd760fc2d35cec97e37f8604d3632210d9a "$model_dir/$model_file.part" | sha256sum -c
  mv "$model_dir/$model_file.part" "$model_dir/$model_file"
fi
"$lms" daemon up
trap '"$lms" daemon down' EXIT
trap 'exit 0' TERM INT
"$lms" load llama-3.2-3b-instruct --identifier claro-llama --context-length "${LM_STUDIO_CONTEXT}" --gpu "${LM_STUDIO_GPU}" --yes
"$lms" server start --bind 0.0.0.0 --port 1234
# Exit if the daemon's HTTP API disappears so the container can recover.
while sleep 15; do
  curl -fsS --max-time 5 http://127.0.0.1:1234/v1/models >/dev/null
done
