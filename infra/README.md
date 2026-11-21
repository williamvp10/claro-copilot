# Demo deployment

This Compose definition is the deployment specification for the first Dokploy demo and also runs locally. It does not create a Dokploy instance, configure its proxy, provision TLS, or deploy automatically. The application, database and Redis are private except for the web binding. Use a private Dokploy network or a controlled proxy to route public traffic to `web:3000`; only publish the API separately if the application integration requires it. If Dokploy needs a host port, set `WEB_BIND` to the appropriate interface and restrict it with host firewall rules.

## Prepare and verify locally

From the repository root copy `.env.example` to a private env file such as `.env`, then add `POSTGRES_PASSWORD`, `DEMO_HOLDER_CODE`, and any optional chat IDs. Set `DATABASE_URL` with hostname `postgres` and credentials matching `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB`; use a URL-encoded password if it contains reserved characters. Set `REDIS_URL=redis://redis:6379`, the external `BETTER_AUTH_URL`, a strong `BETTER_AUTH_SECRET`, seed credentials and `DEMO_INGRESS_TOKEN`. Telegram credentials are optional for the simulated demo; supply `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` for real Telegram integration. Never commit the env file. Configure `ML_API_URL=http://ml:8000` only when enabling ML and set the same strong `ML_SERVICE_TOKEN` in clients and ML.

```sh
docker compose --env-file .env -f infra/compose.yaml config --quiet
docker compose --env-file .env -f infra/compose.yaml up --build -d
docker compose --env-file .env -f infra/compose.yaml ps
docker compose --env-file .env -f infra/compose.yaml --profile jobs run --rm seed
```

Migration runs before API and worker start. Run the seed against the demo database to create the advisor, admin and three synthetic contacts. Customer ingress can be tested with `POST /api/v1/demo/incoming` in demo mode, authenticated with `DEMO_INGRESS_TOKEN`. Keep that token empty in the deployed demo unless a controlled smoke requires it. API readiness uses `/readyz`, liveness uses `/healthz` and worker health checks its current database-backed heartbeat.

Use `DEMO_ASESSOR_EMAIL` and `DEMO_ASESSOR_PASSWORD` for the advisor and the corresponding `DEMO_ADMIN_*` variables for administration. Set `DEMO_HOLDER_CODE` exclusively for the synthetic identity flow. For real Telegram trials, associate three already-enabled private chats through `DEMO_BILLING_CHAT_ID`, `DEMO_RETENTION_CHAT_ID` and `DEMO_ASSIGNED_CHAT_ID`; configure the Bot API webhook at `/api/v1/webhooks/telegram` with the matching secret and allow messages and callback queries. Closing a case sends an optional satisfaction survey in that chat.

## Dokploy and release evidence

After CI passes on `main`, the candidate job publishes GHCR and produces separate candidate artifacts with the immutable `image@sha256:...` references after image scans. In Dokploy create a Compose application from this repository and set its compose path to `infra/compose.yaml`; supply the private environment values through Dokploy, including `CLARO_IMAGE` and, when enabling the ML profile, `ML_IMAGE` set to the corresponding digests. Configure the web domain/TLS in Dokploy, persist named volumes, and verify the version, migration completion, API `/healthz` and `/readyz`, and web login before routing demo traffic. Pull the candidate image and use a deployment mode that does not rebuild it. Keep the previous verified digest and a database backup to support rollback. Do not roll back an incompatible schema without a tested recovery plan. No automatic deploy is configured.

For evidence, save the workflow run URL, commit, image digest, Compose configuration validation result, migration status, health checks and smoke-test outcome in the release record. Do not include credentials or the rendered Compose configuration, which may contain secrets.

## Optional ML and telemetry

With the integrated `services/ml/Dockerfile`, `--profile ml` starts the private ML API and MLflow 2.22. MLflow uses its own persistent SQLite backend and artifact volume and has no published port. It is intended for a single host; protect the internal network because this MLflow server has no authentication. The serving API mounts the model volume read-only and keeps its SQLite state on a separate writable volume. Set `ML_RELEASE_VERSION` to the exact published numeric version before enabling ML; readiness fails until the bundle exists.

Use `--profile ml-jobs` for explicit jobs on the same image and model volume. For example, mount a local CSV read-only using `docker compose --env-file .env -f infra/compose.yaml --profile ml-jobs run --rm -v "$PWD/tickets.csv:/input/tickets.csv:ro" ml-job app.train /input/tickets.csv`; publish a registry version with `... ml-job app.release <VERSION> /models/releases/<VERSION>` and run drift with `... ml-job app.drift`. Set `ML_IMAGE_DIGEST` and `GIT_SHA` for release provenance. Wait for MLflow startup before invoking jobs, restrict access to CSV and artifacts, and back up the three ML volumes together. The initial volume setup changes ownership to the ML image user. MLflow is not needed by the serving API once a release exists.

`--profile observability` adds an OTLP collector and a local-only Prometheus UI. Prometheus scrapes the API's private `/metrics` endpoint. The Collector accepts OTLP and can be used by additional instrumentation. Set `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and optionally `LANGFUSE_BASE_URL` to export the worker's sanitized run traces to Langfuse over OTLP/HTTP. Protect telemetry endpoints and avoid sending customer data in telemetry.

## Integration prerequisites

The application must supply `apps/backend/dist/migrate.js`, `seed.js`, `main.js`, `worker.js`, readiness/liveness endpoints, and any ML Dockerfile and CLI before those services can run. The image copies the built workspace including dependencies to preserve pnpm links; it is intentionally not a minimized production image. Docker builds and runtime smoke tests require a running Docker daemon.

## Knowledge and provider modes

The base Compose stack uses PostgreSQL knowledge retrieval. To exercise private MCP, set a strong `KNOWLEDGE_SERVICE_TOKEN`, set `KNOWLEDGE_MCP_URL=http://knowledge-mcp:3030/mcp` and include `--profile knowledge`. The web proxy publishes only the platform API and leaves the knowledge server on the Compose network.

The migration seeds two reviewed public passages. The ingester accepts a private JSON array with `id`, `title`, `version`, `excerpt`, `scope` and `effective_from`. Add an exclusive `effective_to` to the previous version when publishing a replacement. Set `DEMO_BUSINESS_DATE` to replay an effective date. Invoke `pnpm --filter @claro/backend knowledge:ingest /path/to/reviewed-passages.json` with `DATABASE_URL` configured and the database migrated. Prepare the private exercise sources with the [corpus utility](../packages/agent/scripts/README.md), then ingest the resulting JSON.

The default agent uses local decisions and returns cited excerpts. To opt into remote selection, set `AGENT_PROVIDERS=live`, the OpenRouter and OpenAI credentials and the OpenAI model IDs for the profiles you want to use. The provider adapters send minimized categorical inputs, and the worker keeps authorization and business decisions local.

The three scene replays, E-202 retrieval and role/feedback checks run in the platform integration job. The release still requires the full golden and complementary suites, calibrated Jev review and real-account verification of Telegram, OpenAI, OpenRouter and Langfuse. Prompt candidates stay blocked when independent evaluation evidence is unavailable.

Run the preliminary suite probe with `pnpm --filter @claro/backend quality:probe /private/golden_dataset.jsonl /private/evals_atencion.jsonl`. It reports suite hashes, cites observed passages and marks control events for integrated replay. It emits IDs and decisions without raw transcripts. Literal matches are an aid for review. Optional `JEV_ENABLE_EVALS=true` adds the minimized semantic signal when authorized credentials are configured. The probe reports `review_required`; use the acceptance thresholds and evidence in the release criteria to decide promotion.

[Terraform for an existing Dokploy installation](terraform/README.md) declares the project, environment and Compose source.
