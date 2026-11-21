# Guía de arranque del MVP de Claro Copiloto

El stack aprobado es **Next.js con shadcn/ui**, **NestJS con TypeORM, Better Auth y PostgreSQL**, **LangGraph.js en un worker del mismo backend** y **FastAPI para ML clásico**. Los tres frentes pueden trabajar en paralelo con los mismos contratos y fixtures. Esta guía define los entregables y verificaciones del primer corte.

[Índice del MVP](../README.md) · [Arquitectura Docker](02-arquitectura-docker.md) · [DDD compartido](03-dominio.md) · [Contratos v1](04-contratos.md)

## Estructura prevista del repositorio

| Ruta | Responsabilidad y primera entrega |
| --- | --- |
| `apps/web` | Next.js App Router, shadcn/ui y cliente de Better Auth. Bandeja, caso, chat por SSE y vista de administración. Primero demostrar acceso, caso y propuesta con fixtures. [SDD de plataforma](plataforma/diseno.md) |
| `apps/backend` | Proyecto NestJS con Express y ESM. Entradas `backend-api` y `backend-worker` desde la misma imagen. Módulos de Atención, Identidad, Retención, Aprobaciones, Canales, Administración y Operación. Primero demostrar una sesión y un turno persistido que un worker pueda consumir. |
| `packages/agent` | Grafo, retrieval, adaptadores LLM, Jev, MCP y skills en TypeScript, cargados mediante `AgentModule` del backend. Primero responder E-202 con una cita pública y producir eventos de ejecución. [SDD del agente](agente/diseno.md) |
| `packages/contracts` | Esquemas y fixtures compartidos para turnos, eventos, ámbito, propuestas, efectos e inferencia. Los puertos TypeScript se usan dentro de NestJS. El OpenAPI de ML versiona la frontera HTTP con Python. [Contrato v1](04-contratos.md) |
| `services/ml` | FastAPI, scikit-learn, entrenamiento, serving, drift y registro en MLflow. Primero servir un modelo versionado en sombra y probar su contrato. [Implementación MLflow](ml/diseno.md) |
| `infra` y `evals` | Diseño de Docker Compose para local y Dokploy, CI/CD, evaluación y fixtures. Primero definir el entorno reproducible y el smoke de integración. [Gate de release](06-calidad-y-release.md#promoción-de-develop-a-main) |

Para el monorepo, usar **pnpm workspaces** para JavaScript y un entorno Python separado para ML. Fijar las versiones de Node, Python y dependencias en el primer commit de implementación. Validar en conjunto el arranque ESM de NestJS, Better Auth, TypeORM y los paquetes del grafo antes de integrar endpoints de negocio.

## Perfiles de ejecución

| Componente | Arranque local | Staging y demo en Dokploy |
| --- | --- | --- |
| Web y API | Next.js y NestJS con usuarios y casos sintéticos. Better Auth bajo `/api/auth`. | Un origen HTTPS en Traefik. Enrutar `/api` al backend y el resto a Next.js. Los consumidores web usan cookie de sesión. |
| Worker NestJS | Misma imagen que la API y una entrada de proceso dedicada. Consume trabajos persistidos y reporta estado mediante heartbeat. | Servicio privado con sus propios límites de CPU, memoria y concurrencia. API y worker no se llaman por HTTP. La API entrega SSE desde los eventos del run. |
| Conocimiento | Ingesta y MCP privados. Puede usarse un corpus mínimo mientras se prepara el modelo de re-ranking. | `knowledge-worker`, `knowledge-mcp` y `reranker` con imágenes y health checks separados. Evidencia versionada en PostgreSQL. |
| PostgreSQL y Redis | PostgreSQL con pgvector, esquemas separados y Redis para memoria. | Volúmenes persistentes, credenciales por función y backups comprobados. PostgreSQL respalda casos, outbox, índice y checkpoints. |
| CRM, facturación y ML | Mocks con los fixtures OpenAPI. La API ML puede sustituirse por un stub hasta tener un modelo registrado. | Mocks y FastAPI en red privada. MLflow privado para tracking y registro. El modelo sirve una versión fijada en modo sombra. |
| Proveedores y observabilidad | Adaptadores deterministas para OpenAI, Jev y Langfuse. | Inyectar credenciales separadas para OpenAI Direct, OpenRouter Decisions, Telegram y Langfuse. Collector y Prometheus en red privada, con trazas a Langfuse Cloud. Ejecutar smoke con el corpus sintético y la revisión versionada. |

El primer flujo local se debe poder probar con datos sintéticos y adaptadores de prueba. Las claves reales se inyectan en el servicio que hace cada llamada. El navegador recibe sesión y datos autorizados de la API.

## Persistencia y orden de arranque

1. **Preparar PostgreSQL y Redis.** Crear los roles y esquemas de plataforma, autenticación, conocimiento y checkpoints. Crear la base lógica de MLflow. Habilitar pgvector en la base PostgreSQL que aloja el esquema de conocimiento.
2. **Aplicar una vez cada migración.** TypeORM aplica las migraciones de negocio y conocimiento con `synchronize: false`. Better Auth usa su adaptador PostgreSQL y su migración en `auth`. LangGraph.js prepara su esquema de checkpoint mediante PostgresSaver. MLflow administra su propia base. El release ejecuta estos pasos antes de iniciar API y worker.
3. **Cargar fixtures y arrancar.** Inicializar usuarios de demo por un flujo controlado, CRM y facturación, fuentes autorizadas y una revisión del agente. Levantar la API, el worker y la web. Para ML, registrar un candidato y cargar la versión aprobada en FastAPI.
4. **Comprobar readiness.** La API debe aceptar una sesión y persistir un turno. Verificar que el worker consuma el trabajo y publique un evento. Comprobar que el grafo pueda pausar y reanudar. Confirmar que el predictor está listo o que la ruta funciona con el adaptador degradado.

La configuración documentada incluye una URL de PostgreSQL por ámbito, Redis, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, referencia de la API de ML e identidad entre servicios. Los secretos de proveedores se quedan en servidor. Para Better Auth, montar el handler Express antes del parser JSON y comprobar que las demás rutas conserven su parser. [Diseño de autenticación](plataforma/diseno.md#base-de-datos-y-autenticación)

## Entregas paralelas y criterios de unión

| Frente | Primer corte verificable |
| --- | --- |
| **Aplicación** | Persistir turnos de cliente y asesor. Probar ingreso por bot, ingreso directo a un asesor y apertura desde consola con un chat sintético previamente habilitado. Un stub emite ficha privada por SSE. Verificar historial y destinatario tras reconectar. |
| **Agente** | Partir de una respuesta pública con cita. Ante mensajes de ambos actores actualizar motivo, hechos y pendientes. Reanudar la lectura de cuenta al verificarse la titularidad y presentar elegibilidad o denegación en privado. Probar interrupción, aprobación y reanudación. |
| **ML de predicción** | Entrenar intención con particiones agrupadas, registrar en MLflow y servir una versión fija en sombra sobre mensajes del cliente en ambos modos. Un timeout del predictor deja continuar el caso. |

**Primera integración.** Ejecutar C-1001, C-1004 y C-1007 con las dos vistas abiertas. Observar una transferencia con contexto, una oferta confirmada exactamente una vez y una denegación con cero registros de oferta. En las tres escenas el asesor conversa con el cliente y la ficha llega automáticamente. Registrar destino de cada salida, traza del run y versión del predictor. [Guion de aceptación](06-calidad-y-release.md#tres-casos-de-la-demo)

Mantener E-202 como prueba de respuesta pública con cita y CC-E13 como regresión de creación idempotente de ticket prioritario. [Suite complementaria](05-insumos.md#evaluaciones)

**Gate para staging.** Ejecutar pruebas de contrato y persistencia, los 30 golden y los 19 casos complementarios. El código valida identidad, citas y efectos. Jev califica la semántica de los pasos aplicables. Guardar el manifiesto con digest de backend y web, revisión del agente, modelo de ML, corpus y rúbrica. El mismo candidato pasa de staging a la demo en Dokploy tras aprobar las Evals y el smoke. [Evals con Jev](agente/jev-evals.md)
