# Claro Copiloto en Dokploy

Usa el proveedor GitHub de Dokploy con `main`, el tipo **Docker Compose** y el archivo [compose.dokploy.yaml](../../compose.dokploy.yaml). Este punto de entrada reúne Next.js, NestJS, los mocks de CRM y facturación, PostgreSQL con pgvector, Redis, FastAPI, MLflow, Prometheus y Langfuse. Traefik publica el frontend y los accesos HTTPS protegidos de Langfuse y MLflow. Las bases de datos y las API internas usan la red de Compose. El agente consume los modelos por HTTPS mediante OpenAI directo y OpenRouter.

## Recursos compartidos

Langfuse usó cerca de 2,7 GiB en reposo en el demo local. El perfil `shared-demo` fija límites por contenedor de 1,25 GiB para web, 1 GiB para worker, 2,25 GiB para ClickHouse, 512 MiB para PostgreSQL y 384 MiB para Redis y MinIO, alrededor de 5,75 GiB acumulados. Las aplicaciones comparten CPU y RAM de la VPS. [Tamaño de Langfuse](https://langfuse.com/self-hosting/configuration/scaling)

El perfil completo de Compose deja 8 GiB a ClickHouse y 4 GiB a cada proceso web y worker. El despliegue de la VPS usa `AGENT_PROVIDERS=live` con `OPENAI_API_KEY` y `OPENROUTER_API_KEY` en **Environment** de Dokploy. OpenAI es el proveedor de la política inicial. En instalaciones que usaban el modelo local, la migración asigna OpenAI y configura Gemini Flash Lite vía OpenRouter como respaldo de esos pasos. Administración puede seleccionar modelos de OpenRouter y validar revisiones en **Modelos del agente**. `AGENT_TURN_TIMEOUT_MS` limita el trabajo total del turno.

## Arranque y actualización

1. Prepara el corpus con `prepare_corpus.py --contextual`. Empaqueta `publication/corpus.json`, `publication/manifest.json`, `originals/`, `ml/data/tickets.csv` y `ml/data/clientes_churn.csv` en `demo-inputs.tgz`. Incluye únicamente los insumos aprobados para el demo. El SHA de la publicación está en el manifiesto. [Entrenamiento y publicación del corpus](../../docs/08-demo-local.md)
2. Ejecuta `bash infra/vps/init-env.sh <directorio-privado> <subdominio> <sha256-corpus> traefik shared-demo`. Agrega `INPUT_ARCHIVE_SHA256=<sha256-del-archivo-tgz>` al archivo generado y guarda las variables en la sección **Environment** del servicio Compose. Completa las dos claves de proveedor allí antes de desplegar. Verifica `CLARO_TRAEFIK_NETWORK`, `CLARO_TRAEFIK_ENTRYPOINT` y `CLARO_TRAEFIK_CERTRESOLVER` contra el Traefik del host. Configura el DNS con el subdominio que coincida con `BETTER_AUTH_URL`. [Dokploy y Traefik](https://docs.dokploy.com/docs/core/docker-compose/domains)
3. Inicia el despliegue y usa **Docker → Containers → private-inputs → Upload File** para subir `demo-inputs.tgz` a `/inputs/demo-inputs.tgz`. En Dokploy 0.31.2, si aparece `spawn E2BIG`, transfiere el archivo por partes de hasta 64 KiB y ensámblalo desde la terminal `/bin/sh` del contenedor. Usa un nombre temporal y renómbralo después de comprobar el SHA-256. El contenedor de entrada verifica el SHA antes de extraer. El job de ML descarga y verifica los archivos de E5, registra los dos modelos en MLflow y persiste los bundles. La base documental se publica antes de habilitar el frontend. Se conservan las bases, el corpus y los modelos en los volúmenes de Docker en cada despliegue. [Volúmenes en Dokploy](https://docs.dokploy.com/docs/core/docker-compose)
4. Comprueba el chat en `/chat`, el login de operador, las versiones de intención y churn, el caso sintético C-1001 y las trazas de Langfuse. Confirma el trigger **On Push** del proveedor GitHub para `main`. [Despliegue automático de Dokploy](https://docs.dokploy.com/docs/core/auto-deploy)

Respalda los volúmenes de aplicación, Langfuse y MLflow antes de cambios de esquema o de versión. Guarda las credenciales y los respaldos fuera de la VPS.

## Promoción de develop a la VPS

Los cambios se prueban en `develop` y se integran en `main` conservando la configuración de la VPS. El push a `main` activa el despliegue existente de Dokploy. Antes del push, ejecuta `pnpm build`, `pnpm typecheck`, `pnpm test` y la validación de Compose de CI. Confirma un respaldo recuperable cuando la revisión cambie el esquema.

El despliegue que incorpora atención asistida usa `platform-release-backup` para guardar un archivo de PostgreSQL previo a la migración en el volumen privado `platform-release-backups`. Dokploy espera a que `pg_restore --list` pueda leer el archivo antes de migrar. Conserva una copia fuera de la VPS como parte de la operación de respaldo.

Después del despliegue, comprueba que las tareas de migración, usuarios, publicación documental y bootstrap de prompts finalizaron. Verifica en HTTPS el acceso de Asesor, Administración, Soporte N2 y Supervisión. Administración gestiona los modelos, los prompts y las funciones administrativas del demo. La cuenta anterior de Superadministración queda retirada al ejecutar el seed.

Prueba un chat sintético con una cita, un traspaso y un cierre asistido. Comprueba en Langfuse la sesión de ese chat, la entrada y salida publicables, y la revisión de los prompts o del modelo cuando intervengan. Compose activa la captura de texto solo para los turnos públicos elegibles del demo web. El exportador enmascara contactos y referencias antes de enviarlos. `LANGFUSE_CAPTURE_CHAT_IO=false` deshabilita la captura de texto. Verifica los experimentos de intención y de riesgo de baja en MLflow. Registra el commit desplegado y los resultados fuera de las credenciales del entorno.

El servicio `langfuse-calls-init` importa los datasets sintéticos y el evaluador nativo de Jev al desplegar. El perfil `call-evals` publica un replay manual de las llamadas desde Compose. En el experimento de Langfuse, aplica **Jev · Llamadas v1** a sus 15 ítems y comprueba los dos criterios en **Prompts y evaluaciones**. [Ejecutar el juez](../../docs/08-demo-local.md#ejecutar-el-juez-desde-langfuse)

## Datos del tablero

**Calidad del LLM** consulta el último experimento Jev nativo del período. Un caso cuenta como evaluado al recibir los dos criterios. Si ejecutas otro experimento, el tablero muestra la cobertura y los veredictos a medida que Langfuse guarda los resultados. La vista de **Tableros** consulta las fuentes cada 30 segundos mientras esté visible.

Para habilitar el historial de **DevOps**, guarda `DOKPLOY_METRICS_API_KEY` en **Environment** del Compose con permiso de lectura de despliegues del servicio. Puedes ajustar `DOKPLOY_METRICS_URL`, `DOKPLOY_METRICS_COMPOSE_ID` y `GITHUB_METRICS_REPO` si cambias de instalación. Para un repositorio privado, configura también `GITHUB_METRICS_API_TOKEN` con permiso de lectura de Actions. [API de despliegues de Dokploy](https://docs.dokploy.com/docs/api/deployment)

El recolector lee el historial de Dokploy cada minuto y GitHub Actions cada dos minutos. Comprueba por HTTPS `/chat` y el estado de la API. Vincula la primera comprobación correcta a un despliegue completado cuando el SHA coincide con el de la imagen en ejecución. Los despliegues anteriores pueden quedar sin observación HTTPS. La sonda se ejecuta desde la VPS y conserva 32 días de muestras.
