#!/usr/bin/env bash
set -euo pipefail
umask 077

root=${1:?Set the installation directory}
domain=${2:?Set the public hostname}
publication=${3:?Set the published corpus SHA-256}
proxy=${4:-host}
capacity=${5:-full}
[[ "$root" =~ ^/[a-zA-Z0-9_./-]+$ && "$domain" =~ ^[a-zA-Z0-9.-]+$ ]]
[[ "$publication" =~ ^[a-f0-9]{64}$ && "$proxy" =~ ^(host|traefik)$ && "$capacity" =~ ^(full|shared-demo)$ ]]
[[ ! -e "$root/runtime.env" ]] || { echo 'runtime.env already exists'; exit 1; }
install -d -m 700 "$root" "$root/releases" "$root/inputs"
secret() { openssl rand -hex "${1:-32}"; }
postgres_password=$(secret)
temporary=$(mktemp "$root/.runtime.XXXXXX")
trap 'rm -f -- "$temporary"' EXIT
cat > "$temporary" <<ENV
CLARO_DOMAIN=$domain
CLARO_PROXY=$proxy
BETTER_AUTH_URL=https://$domain
BETTER_AUTH_SECRET=$(secret)
WEB_BIND=127.0.0.1
WEB_PORT=39092
API_PORT=39093
PROMETHEUS_PORT=39097
POSTGRES_PASSWORD=$postgres_password
DATABASE_URL=postgresql://claro:$postgres_password@postgres:5432/claro_demo
PLATFORM_DATABASE_URL=postgresql://claro_platform_app:$(secret)@postgres:5432/claro_demo
CRM_DATABASE_URL=postgresql://claro_crm_app:$(secret)@postgres:5432/claro_crm
BILLING_DATABASE_URL=postgresql://claro_billing_app:$(secret)@postgres:5432/claro_facturacion
CRM_API_KEY=$(secret)
BILLING_API_KEY=$(secret)
INTEGRATION_MCP_TOKEN=$(secret)
INTEGRATION_MCP_SIGNING_KEY=$(secret)
KNOWLEDGE_SERVICE_TOKEN=$(secret)
KNOWLEDGE_MCP_URL=http://knowledge-mcp:3030/mcp
KNOWLEDGE_INDEX_REVISION=$publication
KNOWLEDGE_PUBLICATION_DIR=$root/inputs/publication
KNOWLEDGE_ORIGINALS_DIR=$root/inputs/originals
ML_INPUTS_DIR=$root/inputs/ml
ML_API_URL=http://ml:8000
ML_SERVICE_TOKEN=$(secret)
ML_RELEASE_VERSION=intent-e5-svm-1
ML_CHURN_BUNDLE_DIR=/models/releases/churn-logistic-1
MLFLOW_UI_PORT=39096
MLFLOW_UI_URL=http://localhost:39096
AGENT_PROVIDERS=live
OPENAI_API_KEY=
OPENROUTER_API_KEY=
AGENT_TURN_TIMEOUT_MS=40000
DEMO_MODE=true
DEMO_BUSINESS_DATE=2026-11-24
DEMO_HOLDER_CODE=$(od -An -N4 -tu4 /dev/urandom | awk '{printf "%06d",100000+($1%900000)}')
LANGFUSE_SHARED_NETWORK=claro-copiloto_default
LANGFUSE_UI_PORT=39095
LANGFUSE_UI_URL=http://localhost:39095
LANGFUSE_BASE_URL=http://langfuse-web:3000
LANGFUSE_PROJECT_ID=claro-copiloto
LANGFUSE_ADMIN_EMAIL=observabilidad@demo.claro.test
LANGFUSE_ADMIN_PASSWORD=$(secret 16)
LANGFUSE_DB_PASSWORD=$(secret)
LANGFUSE_SALT=$(secret)
LANGFUSE_ENCRYPTION_KEY=$(secret)
LANGFUSE_AUTH_SECRET=$(secret)
LANGFUSE_CLICKHOUSE_PASSWORD=$(secret)
LANGFUSE_REDIS_PASSWORD=$(secret)
LANGFUSE_STORAGE_PASSWORD=$(secret)
LANGFUSE_PUBLIC_KEY=pk-lf-$(secret 16)
LANGFUSE_SECRET_KEY=sk-lf-$(secret)
ENV

for role in ASESSOR ADMIN N2 SUPERVISOR SUPERADMIN; do
  printf 'DEMO_%s_EMAIL=%s@demo.claro.test\nDEMO_%s_PASSWORD=%s\n' "$role" "$(printf '%s' "$role" | tr '[:upper:]' '[:lower:]')" "$role" "$(secret 16)" >> "$temporary"
done
if [[ "$capacity" == shared-demo ]]; then
  cat >> "$temporary" <<'ENV'
LANGFUSE_WEB_CPUS=1
LANGFUSE_WEB_MEMORY=1280m
LANGFUSE_WEB_HEAP_MIB=768
LANGFUSE_WORKER_CPUS=1
LANGFUSE_WORKER_MEMORY=1024m
LANGFUSE_WORKER_HEAP_MIB=640
LANGFUSE_INGESTION_CONCURRENCY=2
LANGFUSE_TRACE_UPSERT_CONCURRENCY=2
LANGFUSE_CLICKHOUSE_CPUS=2
LANGFUSE_CLICKHOUSE_MEMORY=2304m
LANGFUSE_POSTGRES_CPUS=0.5
LANGFUSE_POSTGRES_MEMORY=512m
LANGFUSE_REDIS_CPUS=0.5
LANGFUSE_REDIS_MEMORY=384m
LANGFUSE_REDIS_MAXMEMORY=128mb
LANGFUSE_STORAGE_CPUS=0.5
LANGFUSE_STORAGE_MEMORY=384m
CLARO_POSTGRES_MEMORY=512m
CLARO_REDIS_MEMORY=128m
CLARO_WEB_MEMORY=384m
CLARO_API_MEMORY=384m
CLARO_WORKER_MEMORY=384m
CLARO_MOCK_MEMORY=128m
CLARO_KNOWLEDGE_MEMORY=192m
CLARO_ML_MEMORY=1536m
CLARO_MLFLOW_MEMORY=768m
CLARO_ML_TRAIN_MEMORY=2304m
CLARO_PROMETHEUS_MEMORY=256m
CLARO_OTEL_MEMORY=128m
ENV
fi
ln -- "$temporary" "$root/runtime.env"
printf 'Created %s/runtime.env with private runtime credentials\n' "$root"
