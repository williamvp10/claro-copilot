# Demo deployment

This Compose definition is the deployment specification for the first Dokploy demo and also runs locally. It does not create a Dokploy instance, configure its proxy, provision TLS, or deploy automatically. Route the public HTTPS domain to `web:3000`. The browser reaches NestJS through Next.js. NestJS, Redis, PostgreSQL, CRM and billing stay on the private network. If Dokploy needs a host port, set `WEB_BIND` to the appropriate interface and restrict it with host firewall rules.

## Prepare and verify locally

From the repository root copy `.env.example` to a private env file such as `.env`, then add `POSTGRES_PASSWORD`, `DEMO_HOLDER_CODE`, and any optional chat IDs. Set `DATABASE_URL` with hostname `postgres` and credentials matching `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB`; use a URL-encoded password if it contains reserved characters. Set `REDIS_URL=redis://redis:6379`, the external `BETTER_AUTH_URL`, a strong `BETTER_AUTH_SECRET`, seed credentials and `DEMO_INGRESS_TOKEN`. Telegram credentials are optional for the simulated demo; supply `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` for real Telegram integration. Never commit the env file. Configure `ML_API_URL=http://ml:8000` only when enabling ML and set the same strong `ML_SERVICE_TOKEN` in clients and ML.

```sh
docker compose --env-file .env -f infra/compose.yaml config --quiet
docker compose --env-file .env -f infra/compose.yaml up --build -d
docker compose --env-file .env -f infra/compose.yaml ps
docker compose --env-file .env -f infra/compose.yaml --profile jobs run --rm seed
```

Set distinct passwords in `PLATFORM_DATABASE_URL`, `CRM_DATABASE_URL` and `BILLING_DATABASE_URL`. The platform runtime URL must target the same database as `DATABASE_URL`. CRM targets `claro_crm` and billing targets `claro_facturacion`. Set independent `CRM_API_KEY` and `BILLING_API_KEY` values. The API and worker receive the two API keys and the platform runtime connection. Each simulator receives only its own key and database connection.

The migration job uses the PostgreSQL admin connection in `DATABASE_URL` to apply schema changes, create isolated roles and databases, and seed the services. To upgrade a running demo, keep the existing project name, PostgreSQL volume and platform database. Back up the platform database, add the five new variables and run the same Compose commands. Repeat the job to verify it preserves existing operations. The simulator jobs use the same application image/digest as the backend. Run the seed against the demo database to create the advisor, admin and three synthetic contacts for the core demo. Customer ingress can be tested with `POST /api/v1/demo/incoming` in demo mode, authenticated with `DEMO_INGRESS_TOKEN`. Keep that token empty in the deployed demo unless a controlled smoke requires it. API readiness uses `/readyz`, liveness uses `/healthz` and worker health checks its current database-backed heartbeat.

Use `DEMO_ASESSOR_EMAIL` and `DEMO_ASESSOR_PASSWORD` for the advisor and the corresponding `DEMO_ADMIN_*` variables for administration. The seed updates the configured password of each existing demo operator and revokes their sessions when its password changes. The short local credential is accepted only for a loopback origin. Set distinct passwords of at least 12 characters for Dokploy. Set `DEMO_HOLDER_CODE` exclusively for the synthetic identity flow. For real Telegram trials, associate three already-enabled private chats through `DEMO_BILLING_CHAT_ID`, `DEMO_RETENTION_CHAT_ID` and `DEMO_ASSIGNED_CHAT_ID`; configure the Bot API webhook at `/api/v1/webhooks/telegram` with the matching secret and allow messages and callback queries. Closing a case sends an optional satisfaction survey in that chat.

## Dokploy and release evidence

After CI passes on `main`, the candidate job publishes GHCR and produces separate candidate artifacts with the immutable `image@sha256:...` references after image scans. In Dokploy create a Compose application from this repository and set its compose path to `infra/compose.yaml`; supply the private environment values through Dokploy, including `CLARO_IMAGE` and, when enabling the ML profile, `ML_IMAGE` set to the corresponding digests. Configure the web domain/TLS in Dokploy, persist named volumes, and verify the version, migration completion, API `/healthz` and `/readyz`, and web login before routing demo traffic. Run `docker compose --env-file .env -f infra/compose.yaml ps` to check both simulators. Then confirm their status in the administration panel, verify the C-1001 web session and check an adjustment receipt. Pull the candidate image and use a deployment mode that does not rebuild it. Keep the previous verified digest and a database backup to support rollback. Do not roll back an incompatible schema without a tested recovery plan. No automatic deploy is configured.

For evidence, save the workflow run URL, commit, image digest, Compose configuration validation result, migration status, health checks and smoke-test outcome in the release record. Do not include credentials or the rendered Compose configuration, which may contain secrets.

## Optional ML and telemetry

With the integrated `services/ml/Dockerfile`, `--profile ml` starts the private ML API and MLflow 2.22. MLflow uses its own persistent SQLite backend and artifact volume and has no published port. It is intended for a single host; protect the internal network because this MLflow server has no authentication. The serving API mounts the model volume read-only and keeps its SQLite state on a separate writable volume. The demo pins `ML_RELEASE_VERSION=2`. Publish the verified bundle to the model volume before starting the ML profile. Readiness reports the loaded version.

Use `--profile ml-jobs` for explicit jobs on the same image and model volume. For example, mount a local CSV read-only using `docker compose --env-file .env -f infra/compose.yaml --profile ml-jobs run --rm -v "$PWD/tickets.csv:/input/tickets.csv:ro" ml-job app.train /input/tickets.csv`; publish a registry version with `... ml-job app.release <VERSION> /models/releases/<VERSION>` and run drift with `... ml-job app.drift`. Set `ML_IMAGE_DIGEST` and `GIT_SHA` for release provenance. Wait for MLflow startup before invoking jobs, restrict access to CSV and artifacts, and back up the three ML volumes together. The initial volume setup changes ownership to the ML image user. MLflow is not needed by the serving API once a release exists.

`--profile observability` adds an OTLP collector and a local-only Prometheus UI. Prometheus scrapes the API's private `/metrics` endpoint. The Collector accepts OTLP and can be used by additional instrumentation. Set `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and optionally `LANGFUSE_BASE_URL` to export the worker's sanitized run traces to Langfuse over OTLP/HTTP. Protect telemetry endpoints and avoid sending customer data in telemetry.

## Integration prerequisites

The application must supply `apps/backend/dist/migrate.js`, `seed.js`, `main.js`, `worker.js`, readiness/liveness endpoints, and any ML Dockerfile and CLI before those services can run. The image copies the built workspace including dependencies to preserve pnpm links; it is intentionally not a minimized production image. Docker builds and runtime smoke tests require a running Docker daemon.

## Knowledge and provider modes

The base Compose stack uses PostgreSQL knowledge retrieval. To exercise private MCP, set a strong `KNOWLEDGE_SERVICE_TOKEN`, set `KNOWLEDGE_MCP_URL=http://knowledge-mcp:3030/mcp` and include `--profile knowledge`. The web proxy publishes only the platform API and leaves the knowledge server on the Compose network.

The migration seeds two reviewed public passages. The ingester accepts a private JSON array with `id`, `title`, `version`, `excerpt`, `scope` and `effective_from`. Add an exclusive `effective_to` to the previous version when publishing a replacement. Set `DEMO_BUSINESS_DATE` to replay an effective date. Invoke `pnpm --filter @claro/backend knowledge:ingest /path/to/reviewed-passages.json` with `DATABASE_URL` configured and the database migrated. Prepare the private exercise sources with the [corpus utility](../packages/agent/scripts/README.md), then ingest the resulting JSON.

The default agent uses local decisions and returns cited excerpts. Set `AGENT_PROVIDERS=live` and both provider keys to enable OpenAI Responses and Jev. OpenAI receives a minimized topic and current public excerpts explicitly approved for provider processing with `provider_approved: true`. For other sources the worker uses the cited excerpt locally. Jev receives fixed categorical features for routing. Account data, authorization and business decisions stay on the platform.

The three scene replays, E-202 retrieval, CC-E13 prioritized support, and role/feedback checks run in the platform integration job. The release still requires the full golden and complementary suites, calibrated Jev review and real-account verification of Telegram, OpenAI, OpenRouter and Langfuse. Prompt candidates stay blocked when independent evaluation evidence is unavailable.

Run the preliminary suite probe with `pnpm --filter @claro/backend quality:probe /private/golden_dataset.jsonl /private/evals_atencion.jsonl`. It reports suite hashes, cites observed passages and marks control events for integrated replay. It emits IDs and decisions without raw transcripts. Literal matches are an aid for review. Optional `JEV_ENABLE_EVALS=true` adds the minimized semantic signal when authorized credentials are configured. The probe reports `review_required`; use the acceptance thresholds and evidence in the release criteria to decide promotion.

[Terraform for an existing Dokploy installation](terraform/README.md) declares the project, environment and Compose source.

## Integrated chat and observability

The customer UI is at /chat. The advisor UI remains at /. The web demo uses separate synthetic sessions. For Telegram delivery, provision the bot token and configure the authorized chats before enabling the HTTPS webhook.

Run the migration job to load the simulator accounts and run the demo seed to create the operators. Use `11111` or `cliente1@example.test` for C-1001, `22222` or `cliente2@example.test` for C-1004, and `33333` or `cliente3@example.test` for C-1007. Ask for an invoice, balance, current plan, or open tickets. In both the web chat and Telegram, send the contact and code as ordinary messages. The demo simulates delivery and accepts any six digits on a current challenge. Telegram checks the alias against the synthetic account assigned to that chat. Use a separate browser session to try a different account. CRM and billing expose the supplied OpenAPI over the private network. [Simulator extensions and frontend views](../docs/openapi/simuladores.md) Account verification and responses are available only in demo mode.

Deploy `compose.langfuse.yaml` under its own project name. Set `LANGFUSE_SHARED_NETWORK` to the application Compose network. Start the application first so that network exists.

```sh
docker compose --env-file .env -f infra/compose.yaml --profile knowledge --profile ml --profile observability up -d --build
docker compose --project-name claro-langfuse --env-file .env -f infra/compose.langfuse.yaml up -d
```

Use the pinned release digest and pull without rebuilding in Dokploy. The demo defaults Langfuse ingestion and trace upserts to two concurrent jobs per worker and caps its Node heap at 768 MiB. Set `LANGFUSE_WORKER_HEAP_MIB`, `LANGFUSE_INGESTION_CONCURRENCY`, and `LANGFUSE_TRACE_UPSERT_CONCURRENCY` to match available capacity and traffic. [Langfuse sizing and scaling](https://langfuse.com/self-hosting/configuration/scaling) Generate independent hexadecimal secrets for the Langfuse database, salt, encryption, auth, ClickHouse, Redis and storage variables declared in the Compose file. Set the generated LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY in both stacks, configure the operator account and use LANGFUSE_BASE_URL=http://langfuse-web:3000 for the worker. The UI binds to localhost for operator access through a tunnel. Keep env files private and pass them explicitly with --env-file.

Para diagnosticar un arranque, comprobar PostgreSQL, Redis, ClickHouse y MinIO antes de iniciar `langfuse-web` y `langfuse-worker`. Un `Dirty database version` indica una migración interrumpida. Para una base con historial, revisar el estado efectivo y respaldar antes de aplicar la recuperación oficial. Un ensayo nuevo puede usar su propio proyecto y volúmenes. [Migraciones fallidas de ClickHouse](https://langfuse.com/faq/all/self-hosting-clickhouse-handling-failed-migrations)

Create a candidate in administration with a public_answer prompt. From a private mounted copy of the evaluation inputs, run:

```sh
pnpm --filter @claro/backend quality:compare GOLDEN.jsonl SCENARIOS.jsonl CANDIDATE_ID REPORT.json
pnpm --filter @claro/backend quality:review CANDIDATE_ID REVIEW.json
```

The comparison runs locally by default. Set `PROMPT_EVAL_PROVIDERS=live` only for suites and evidence authorized for processing by the configured providers. Record the authorization with the release evidence. The semantic judge receives minimized facts only for public steps with approved cited evidence. Record platform replay outcomes for private steps. The review JSON includes the three comparison hashes under evidence. Golden entries use correct, grounded and artifact. Critical scenario entries use passed and artifact. Reference the controlled platform replay or reviewed case evidence by artifact ID. The administrator can activate a candidate with a passing report against the current baseline.

## Evidence for the defense

Place `golden_dataset.jsonl` and `evals_atencion.jsonl` in a private directory and set `PROMPT_EVAL_INPUT_DIR` to its absolute path. Set `PROMPT_EVAL_ENABLED=true` and start the `evals` profile. From Administration save a public-answer candidate and queue its evaluation. The worker persists progress and the comparison, while the API exposes case IDs, outcomes and review status. Default evaluations run locally. Use `PROMPT_EVAL_PROVIDERS=live` exclusively with the authorized suite and reviewed public passages. The review command can attach reviewed evidence before activation. Keep the mounted inputs readable to the job user.

Prepare the approved corpus and a publication manifest in a private directory outside the repository. Use `--approved-public` only with a private approval artifact. Preparation copies the provider flag when ID, version and text match that reviewed artifact exactly.

```sh
uv run packages/agent/scripts/prepare_corpus.py --input "$INPUTS" --output "$PUBLICATION/corpus.json" --manifest "$PUBLICATION/manifest.json"
KNOWLEDGE_PUBLICATION_DIR="$PUBLICATION" docker compose --env-file .env -f infra/compose.yaml --profile jobs run --rm publish-knowledge
```

Use `--initial` for the first catalog on an isolated rehearsal. A second run with the updated input publishes the current release transactionally. The catalog change is effective at the start of 2026-12-01. Repeating the exact manifest is idempotent. The publication hash and source hashes are stored without source text in the publication record.

Langfuse and MLflow bind to loopback on ports `39085` and `39086`. Configure `LANGFUSE_UI_URL` and `MLFLOW_UI_URL` in the app with the browser-facing addresses. An operator can open either tool from Administration. On Dokploy use an SSH tunnel to the same loopback ports and keep both UIs off the public ingress. To verify the trace export, open the listed run in Langfuse and check retrieval, generation, tool calls and the confirmed effect. Compare the version and run ID shown by FastAPI and the panel with the registered model in MLflow. [Matriz de sustentación](../docs/07-auditoria-sustentacion.md)

## Evolución de la consola y prompts

Configurar `INTEGRATION_MCP_TOKEN` con al menos 24 caracteres y `INTEGRATION_MCP_SIGNING_KEY` con al menos 32. CRM y Facturación tienen un proceso MCP privado cada uno. Cada proceso recibe las credenciales de su propia API mock. El worker emite una capacidad firmada, acotada a una tool, el run, el caso y su revisión. El servidor revalida el titular y la asignación antes de consultar. Las escrituras pasan por NestJS y el outbox.

Para ensayar traspasos y gestión, completar las parejas `DEMO_N2_*`, `DEMO_SUPERVISOR_*` y `DEMO_SUPERADMIN_*` y volver a ejecutar el seed. El admin actual conserva aprobación de facturación. Las credenciales de prueba se configuran por instancia. Los usuarios de asesor y atención N2 acceden a conversaciones por asignación.

El catálogo [prompts.claro-copiloto.json](../docs/evolucion-mvp/prompts.claro-copiloto.json) se carga durante la migración de la plataforma. Con Langfuse autohospedado disponible y las claves de proyecto configuradas, importar sus plantillas iniciales con:

```sh
docker compose --env-file .env -f infra/compose.yaml run --rm --no-deps api node apps/backend/scripts/bootstrap-prompts.mjs
```

El comando usa la etiqueta `bootstrap` y conserva la revisión activa de Claro Copiloto. Para aplicar una edición, importar el número de versión desde **Prompts y evaluaciones**, comparar candidata y activa, revisar las adjudicaciones y activar tras el gate. Se puede restaurar una revisión efectivamente publicada. Cada turno usa el contenido y hash guardados en la revisión que le corresponde. [Diseño del manifiesto y del gate](../docs/evolucion-mvp/agente-y-prompts.md)

El tablero DevOps acepta el `release-evidence.json` que genera CI junto al digest. Después de verificar el smoke en la VPS, completar `smoke` y `smoke_verified_at` en el registro del mismo SHA y digest e importarlo desde DevOps. Los demás tableros indican la procedencia, período y tamaño de muestra. La disponibilidad usa Prometheus cuando se habilita el perfil `observability`. La frescura mide detección durante la ingesta a publicación del índice. [Definiciones de indicadores](../docs/evolucion-mvp/tableros.md)

### Smoke de Langfuse v4

Después de publicar una plantilla de arranque en el proyecto demo, usa su nombre y número de versión en el smoke. El comando confirma que el proyecto corresponde a las claves y que Langfuse devuelve el turno, la herramienta y la generación enlazada al prompt. Las tres observaciones comparten un ID sintético y el reporte evita valores de cuenta y mensajes. El script consulta la API v2 de observaciones. [API pública de Langfuse v4](https://langfuse.com/docs/api-and-data-platform/features/public-api)

Configura `LANGFUSE_BASE_URL` de forma explícita. El exportador reconoce el rechazo parcial aun cuando el receptor devuelve HTTP 200. La lectura posterior de observaciones en el smoke comprueba que la traza se procesó en el proyecto. [Respuesta OTLP de aceptación parcial](https://opentelemetry.io/docs/specs/otlp/)

```sh
docker compose --env-file .env -f infra/compose.yaml exec -T api \
  node apps/backend/scripts/smoke-langfuse.mjs claro/copiloto/responder-en-autoservicio VERSION
```

### Comprobantes de replay para prompts candidatos

Usa una base de demo aislada, conserva la revisión activa y exporta `LOCAL_PROMPT_REPLAY_REVISION` y `LOCAL_PROMPT_REPLAY_SCENARIO` al iniciar el API en loopback con entrega Telegram deshabilitada. Los fixtures son C‑1013 para CC‑E03, CC‑E10 y CC‑E13, C‑1004 para CC‑E11 y C‑1007 para CC‑E12. Los datos de los mocks deben estar en el estado inicial de cada caso. Ejecuta primero el A/B y reutiliza la misma candidata, corpus y fecha para acumular comprobantes en el mismo informe. Al completar CC‑E11, reenvía la aprobación con la misma clave después de recibir el primer comprobante.

Para CC‑E10, usa el ingreso de prueba autenticado `/api/v1/demo/incoming` con `channel` igual a `whatsapp`. El proceso debe tener seleccionado el escenario CC‑E10 y el caso debe ser el fixture C‑1013. El comprobante identifica el transporte como `whatsapp_fixture`. El ensayo verifica la ruta y la toma por supervisión usando la plataforma local. El canal de despliegue sigue siendo web y Telegram.

```sh
node apps/backend/scripts/verify-platform-replay.mjs CANDIDATE CC-E11 CASE_ID PROPOSAL_ID ELIGIBILITY_RUN ACCEPTANCE_RUN
node apps/backend/scripts/verify-platform-replay.mjs CANDIDATE CC-E13 CASE_ID PROPOSAL_ID SUPPORT_RUN
node apps/backend/scripts/verify-platform-replay.mjs CANDIDATE CC-E10 CASE_ID - RUN_ID --scenario-suite SCENARIOS.jsonl
```

CC‑E03, CC‑E10 y CC‑E12 usan la misma forma del comando con `-` y la suite original. Los comprobantes verifican revisión, caso, fecha, rúbrica y huellas del informe. Según el escenario, comprueban lecturas y ausencia de efectos, o aprobación y recibo del mock. El juicio sobre la respuesta se registra en la adjudicación humana. El gate exige una comparación conectada y conserva como pendientes los casos que requieren evidencia adicional.

Para las preguntas de cuenta, inicia el API con el ID golden como `LOCAL_PROMPT_REPLAY_SCENARIO` y reproduce la pregunta literal con titularidad verificada. Usa el mismo informe A/B y la suite golden correspondiente. GQ‑25, GQ‑26 y GQ‑27 verifican lecturas y cero efectos. En GQ‑28 se comprueba el ticket solo después de que el asesor lo apruebe y el mock devuelva el recibo. La visita sigue pendiente de coordinación. El verificador guarda hechos de la ejecución en la plataforma, y la adjudicación registra por separado el juicio sobre la respuesta.

```sh
node apps/backend/scripts/verify-golden-platform.mjs CANDIDATE GQ-25 CASE_ID RUN_ID GOLDEN.jsonl
node apps/backend/scripts/verify-golden-platform.mjs CANDIDATE GQ-28 CASE_ID RUN_ID GOLDEN.jsonl PROPOSAL_ID
```
