# Claro Copiloto en una VPS Docker

El release usa dos proyectos Compose en la misma VPS. `claro-copiloto` contiene el frontend, NestJS, los mocks de CRM y facturación, MCP, pgvector, Redis, FastAPI, MLflow, Prometheus y LM Studio. `claro-langfuse` tiene su propio PostgreSQL, Redis, ClickHouse y MinIO. El backend llega a Langfuse a través de la red Docker de la aplicación. Solo el frontend recibe tráfico público mediante el proxy HTTPS. Las interfaces de operación se publican en loopback.

## Capacidad inicial

El demo local usó aproximadamente 2,7 GiB de Langfuse en reposo, incluidos 1,1 GiB de ClickHouse. Los siguientes son límites por contenedor para absorber el trabajo de ingestión y análisis.

| Servicio de Langfuse | vCPU | RAM |
| --- | ---: | ---: |
| Web | 2 | 4 GiB |
| Worker | 2 | 4 GiB |
| ClickHouse | 2 | 8 GiB |
| PostgreSQL | 2 | 4 GiB |
| Redis | 1 | 1,5 GiB |
| MinIO | 2 | 4 GiB |

Para el stack completo, el punto de partida es **12 vCPU, 48 GiB de RAM y 120 GiB SSD**, con alrededor de 26 GiB de límite acumulado para Langfuse, 8 GiB para LM Studio y 9 GiB para los servicios persistentes y la aplicación, más espacio para Docker y el sistema. Los límites no reservan ese consumo y comparten CPU. Comprueba el espacio real según el volumen de trazas, imágenes y backups. La prueba de carga de Langfuse y la latencia del modelo en CPU determinan si hay que cambiar el tamaño de la VPS. Para x86-64 confirma AVX2. El perfil inicial carga Llama 3.2 3B Instruct Q4_K_M en CPU con 8192 tokens; todos los pasos de la política inicial asignan el mismo modelo. [Langfuse Sizing & Scaling](https://langfuse.com/self-hosting/configuration/scaling) · [Langfuse Docker Compose](https://langfuse.com/self-hosting/deployment/docker-compose) · [LM Studio headless](https://lmstudio.ai/docs/developer/core/headless)

En una VPS compartida, el perfil `shared-demo` reduce el agregado de límites de Langfuse a 5,75 GiB, asigna 4 GiB al Llama y reduce la concurrencia y la ventana a 4096 tokens. Su capacidad es para tráfico de demostración. Mide la presión de memoria y CPU del resto de los proyectos durante el arranque y las pruebas.

Los límites se ajustan en `runtime.env` con las variables de los overlays. ClickHouse limita su presupuesto de memoria al 75 % del límite del contenedor y rota sus logs. Prueba cambios de concurrencia con consultas y datos sintéticos representativos.

## Primera instalación

1. Verifica arquitectura x86-64 para las imágenes de GitHub Actions, Docker Compose 2.24 o posterior, espacio, RAM, proxy existente y los puertos de loopback. Usa una cuenta de despliegue con acceso a Docker y al directorio `/opt/claro-copilot`. El archivo `runtime.env` es privado.
2. Prepara el corpus revisado con `prepare_corpus.py --contextual`. Copia `corpus.json` y `manifest.json` a `inputs/publication` y los originales aprobados a `inputs/originals`. El SHA para la inicialización es `sha256` del manifiesto. Para ML, copia únicamente `tickets.csv` y `clientes_churn.csv` a `inputs/ml/data` y los dos archivos E5 fijados a `inputs/ml/encoder`. Los contenedores sin privilegios necesitan permisos de lectura y recorrido en sus montajes. El release entrena y registra en MLflow la primera vez, y reutiliza los volúmenes en adelante. [Entrenamiento y publicación del corpus](../../docs/08-demo-local.md)
3. Ejecuta `bash infra/vps/init-env.sh /opt/claro-copilot <subdominio> <sha256-corpus> traefik` para Dokploy o usa `host` como cuarto argumento si el proxy se ejecuta en el host. Agrega `shared-demo` como quinto argumento para aplicar el perfil de VPS compartida. El script genera credenciales independientes. Guarda el archivo junto a los backups cifrados del demo. Configura el registro DNS para apuntar a la VPS o al túnel ya configurado. En Dokploy, verifica la red externa, el entrypoint y el resolver TLS y ajusta `CLARO_TRAEFIK_NETWORK`, `CLARO_TRAEFIK_ENTRYPOINT` y `CLARO_TRAEFIK_CERTRESOLVER` si difieren de los valores por defecto. Para Caddy en el host, integra el [virtual host](Caddyfile) con el mismo subdominio. [Dokploy y Traefik](https://docs.dokploy.com/docs/core/docker-compose/domains)
4. En el entorno de GitHub Actions `claro-vps`, configura `CLARO_VPS_HOST`, `CLARO_VPS_USER` y, si difieren de los valores por defecto, `CLARO_VPS_PORT` y `CLARO_VPS_ROOT`. Guarda la llave privada de despliegue en `CLARO_VPS_SSH_KEY` y la **clave de host verificada** en formato known_hosts en `CLARO_VPS_KNOWN_HOSTS`. Habilita `CLARO_VPS_ENABLED=true` como **variable del repositorio** cuando el host, DNS e inputs estén listos. Ejecuta manualmente **CI** en `main` para publicar la primera revisión. Después se ejecutará con cada push a `main`. GitHub publica los dos digests después de las pruebas y escaneos, y el release los descarga por SSH usando un token efímero del job.
5. Comprueba el chat en `/chat`, el login de un operador, las versiones de intención y churn, la gestión del caso sintético C-1001 y la traza en Langfuse. El release ya exige migración, health checks, una traza sintética que se pueda volver a leer de Langfuse y una respuesta de la URL HTTPS. Usa un túnel SSH con `-L 39095:127.0.0.1:39095 -L 39096:127.0.0.1:39096` para abrir Langfuse y MLflow en el navegador del operador.

El script conserva el último backup de los tres esquemas PostgreSQL de la aplicación antes de migrar. Define backups fuera de la VPS para esos datos, Langfuse (PostgreSQL, ClickHouse y MinIO) y MLflow. Comprueba restauración antes de usar el stack con datos que deban conservarse. Si un release falla, revisa el estado exacto de la migración y usa el digest anterior únicamente con un esquema compatible. Para revisar la última versión verificada, consulta `current.sha` y los archivos Compose de `current`.
