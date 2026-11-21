# Demo deployment

This Compose definition is the deployment specification for the first Dokploy demo and also runs locally. It does not create a Dokploy instance, configure its proxy, provision TLS, or deploy automatically. The application, database and Redis are private except for the web binding. Use a private Dokploy network or a controlled proxy to route public traffic to `web:3000`; only publish the API separately if the application integration requires it. If Dokploy needs a host port, set `WEB_BIND` to the appropriate interface and restrict it with host firewall rules.

## Prepare and verify locally

From the repository root copy `.env.example` to a private env file such as `.env`, then add `POSTGRES_PASSWORD`, `DEMO_HOLDER_CODE`, and any optional chat IDs. Set `DATABASE_URL` with hostname `postgres` and credentials matching `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB`; use a URL-encoded password if it contains reserved characters. Set `REDIS_URL=redis://redis:6379`, the external `BETTER_AUTH_URL`, a strong `BETTER_AUTH_SECRET`, Telegram credentials and seed credentials. Never commit the env file. Configure `ML_API_URL=http://ml:8000` only when enabling ML and set the same strong `ML_SERVICE_TOKEN` in clients and ML.

```sh
docker compose --env-file .env -f infra/compose.yaml config --quiet
docker compose --env-file .env -f infra/compose.yaml up --build -d
docker compose --env-file .env -f infra/compose.yaml ps
docker compose --env-file .env -f infra/compose.yaml --profile jobs run --rm seed
```

Migration runs once before API and worker start; seeding is an explicit job, and can change data. Confirm application migration/seed behavior before running against an existing database. API readiness uses `/readyz`; `/healthz` is available for external liveness checks. Worker health is represented by its process only: enable a file heartbeat check only after the worker actually writes and refreshes `/tmp/claro-worker-heartbeat`.

## Dokploy and release evidence

After CI passes on `main`, the candidate job publishes GHCR and produces `candidate-image.txt` with the immutable `image@sha256:...` reference. In Dokploy create a Compose application from this repository and set its compose path to `infra/compose.yaml`; supply the private environment values through Dokploy, including `CLARO_IMAGE` set to that exact digest. Configure the web domain/TLS in Dokploy, persist named volumes, and verify the version, migration completion, API `/healthz` and `/readyz`, and web login before routing demo traffic. Pull the candidate image and use a deployment mode that does not rebuild it. Keep the previous verified digest and a database backup to support rollback. Do not roll back an incompatible schema without a tested recovery plan. No automatic deploy is configured.

For evidence, save the workflow run URL, commit, image digest, Compose configuration validation result, migration status, health checks and smoke-test outcome in the release record. Do not include credentials or the rendered Compose configuration, which may contain secrets.

## Optional ML and telemetry

With the integrated `services/ml/Dockerfile`, enable ML using `--profile ml`. Its `/data` volume is separate from database and Redis storage; the service is private on port 8000. Run training, release and drift jobs explicitly with `docker compose --env-file .env -f infra/compose.yaml --profile ml run --rm ml python -m app.train <CSV>`, `... ml python -m app.release <VERSION> <OUTPUT>`, and `... ml python -m app.drift`. Mount input data explicitly and keep model artifacts on the ML volume; consult the integrated ML CLI for its exact arguments. `MLFLOW_TRACKING_URI` is configurable; MLflow itself is not provisioned here.

`--profile observability` adds an OTLP collector and a local-only Prometheus UI. Applications must be instrumented and configured with `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel:4318` for data to arrive. Metrics are scraped from the collector; traces go to its debug exporter, not a durable trace backend. Langfuse is an external configurable integration through `LANGFUSE_BASE_URL` and keys, not a provisioned service. Protect telemetry endpoints and avoid sending customer data in telemetry.

## Integration prerequisites

The application must supply `apps/backend/dist/migrate.js`, `seed.js`, `main.js`, `worker.js`, readiness/liveness endpoints, and any ML Dockerfile and CLI before those services can run. The image copies the built workspace including dependencies to preserve pnpm links; it is intentionally not a minimized production image. Docker builds and runtime smoke tests require a running Docker daemon.
