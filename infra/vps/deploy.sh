#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

root=${1:?Set the installation directory}
revision=${2:?Set the commit SHA}
export CLARO_IMAGE=${3:?Set the application image digest}
export ML_IMAGE=${4:?Set the ML image digest}
env_file="$root/runtime.env"
infra=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)

[[ "$revision" =~ ^[a-f0-9]{40}$ ]]
[[ "$CLARO_IMAGE" =~ ^[a-z0-9./_-]+/claro-copiloto@sha256:[a-f0-9]{64}$ ]]
[[ "$ML_IMAGE" =~ ^[a-z0-9./_-]+/claro-ml@sha256:[a-f0-9]{64}$ ]]
[[ -r "$env_file" ]] || { echo "Missing $env_file"; exit 1; }

exec 9>"$root/deploy.lock"
flock -w 120 9

app=(docker compose -p claro-copiloto --env-file "$env_file" -f "$infra/compose.yaml")
langfuse=(docker compose -p claro-langfuse --env-file "$env_file" -f "$infra/compose.langfuse.yaml" -f "$infra/compose.langfuse.vps.yaml")
setting() { "${app[@]}" config --environment | awk -v key="$1" 'index($0,key"=")==1 {print substr($0,length(key)+2)}'; }

lm_studio=$(setting LM_STUDIO_ENABLED)
public_url=$(setting BETTER_AUTH_URL)
[[ "$public_url" =~ ^https://[a-zA-Z0-9.-]+$ ]] || { echo 'Set BETTER_AUTH_URL to the public HTTPS origin'; exit 1; }
[[ "$(setting WEB_BIND)" == 127.0.0.1 ]] || { echo 'Set WEB_BIND=127.0.0.1'; exit 1; }
[[ "$(setting LANGFUSE_SHARED_NETWORK)" == claro-copiloto_default ]] || { echo 'Invalid LANGFUSE_SHARED_NETWORK'; exit 1; }
if [[ -z "$(setting KNOWLEDGE_INDEX_REVISION)" || "$(setting KNOWLEDGE_INDEX_REVISION)" == legacy ]]; then
  echo 'Set KNOWLEDGE_INDEX_REVISION to the contextual publication SHA-256'
  exit 1
fi
postgres_started=$("${app[@]}" ps -q --status running postgres)
app+=(-f "$infra/compose.local.yaml" -f "$infra/compose.vps.yaml" -f "$infra/compose.knowledge-originals.yaml")
if [[ $(setting CLARO_PROXY) == traefik ]]; then
  [[ "$(setting CLARO_DOMAIN)" == "${public_url#https://}" ]] || { echo 'CLARO_DOMAIN must match BETTER_AUTH_URL'; exit 1; }
  app+=(-f "$infra/compose.vps.traefik.yaml")
fi
if [[ "$lm_studio" == true ]]; then
  app+=(-f "$infra/compose.vps.lmstudio.yaml")
fi
app+=(--profile ml --profile knowledge --profile observability)
# Explicit job targets activate their own profile only for the individual command.

"${app[@]}" config --quiet
"${langfuse[@]}" config --quiet
trap 'echo "Release $revision failed. Check app/Langfuse status and migration logs on the host."' ERR

# The caller can supply ephemeral GHCR credentials via DOCKER_CONFIG.
docker pull "$CLARO_IMAGE"
docker pull "$ML_IMAGE"
"${app[@]}" pull --ignore-buildable
"${langfuse[@]}" pull
if [[ "$lm_studio" == true ]]; then
  if ! docker image inspect claro-lmstudio:llmster-0.1.1-2 >/dev/null 2>&1; then
    "${app[@]}" build lm-studio
  fi
fi

if [[ -n "$postgres_started" && $(cat "$root/backup.revision" 2>/dev/null || true) != "$revision" ]]; then
  backup=$(mktemp -d "$root/backup.XXXXXX")
  for db in claro_demo claro_crm claro_facturacion; do
    # shellcheck disable=SC2016 # Expansion happens in the container.
    "${app[@]}" exec -T postgres sh -ec 'exec pg_dump -Fc -U "$POSTGRES_USER" "$1"' dump "$db" > "$backup/$db.dump"
  done
  previous_backup=$(readlink "$root/backup" || true)
  ln -sfnT "$backup" "$root/backup"
  printf '%s\n' "$revision" > "$root/backup.revision"
  if [[ "$previous_backup" == "$root"/backup.* ]]; then
    rm -f -- "$previous_backup/claro_demo.dump" "$previous_backup/claro_crm.dump" "$previous_backup/claro_facturacion.dump"
    rmdir -- "$previous_backup"
  fi
fi

"${app[@]}" up -d --no-build --pull never --wait --wait-timeout 180 postgres redis
"${langfuse[@]}" up -d --no-build --pull never --wait --wait-timeout 480
"${app[@]}" up -d --no-build --pull never --wait --wait-timeout 180 mlflow
if ! "${app[@]}" run --rm --no-deps --pull never --entrypoint sh ml-job -ec \
  'test -r /models/releases/intent-e5-svm-1/manifest.json && test -r /models/releases/churn-logistic-1/manifest.json'; then
  ml_inputs=$(setting ML_INPUTS_DIR)
  if [[ ! -r "$ml_inputs/data/tickets.csv" || ! -r "$ml_inputs/data/clientes_churn.csv" ||
        ! -r "$ml_inputs/encoder/model.onnx" || ! -r "$ml_inputs/encoder/tokenizer.json" ]]; then
    echo 'Supply the synthetic training inputs and pinned E5 files in ML_INPUTS_DIR'
    exit 1
  fi
  "${app[@]}" run --rm --no-deps --pull never -e GIT_SHA="$revision" -e ML_IMAGE_DIGEST="$ML_IMAGE" \
    --volume "$ml_inputs/data:/input:ro" --volume "$ml_inputs/encoder:/encoder:ro" \
    ml-job app.train_advisory --tickets /input/tickets.csv --clients /input/clientes_churn.csv \
    --encoder-dir /encoder --output /models/releases
fi
"${app[@]}" up -d --no-build --pull never --wait --wait-timeout 180 ml
if [[ "$lm_studio" == true ]]; then
  "${app[@]}" up -d --no-build --pull never --wait --wait-timeout 600 lm-studio
fi
"${app[@]}" up --no-build --pull never --no-deps --exit-code-from migrate migrate
# Seed before exposing the API. The admin roles and mock accounts use this installation's secrets.
"${app[@]}" run --rm --no-deps --pull never seed
if ! "${app[@]}" run --rm --no-deps --pull never publish-knowledge; then
  echo 'Review the corpus manifest and the FastAPI embedding service before retrying.'
  exit 1
fi
"${app[@]}" up -d --no-build --pull never --wait --wait-timeout 300
prompt_versions=$("${app[@]}" exec -T api node apps/backend/scripts/bootstrap-prompts.mjs)
prompt=$("${app[@]}" exec -T api node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const prompt = JSON.parse(readFileSync(0, "utf8")).versions.find(item => item.key === "public_answer");
  if (!prompt) process.exit(1);
  console.log(prompt.name + " " + prompt.version);
' <<< "$prompt_versions")
read -r prompt_name prompt_version <<< "$prompt"
"${app[@]}" exec -T api node apps/backend/scripts/smoke-langfuse.mjs "$prompt_name" "$prompt_version"

curl --fail --silent --show-error --retry 5 --retry-all-errors --max-time 15 "$public_url/chat" >/dev/null
ln -sfnT "$(dirname "$infra")" "$root/current"
printf '%s\n' "$revision" > "$root/current.sha"
printf 'Release %s healthy at %s/chat\n' "$revision" "$public_url"
