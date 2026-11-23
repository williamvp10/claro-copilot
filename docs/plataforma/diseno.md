# SDD de plataforma web y backend

**Responsabilidad.** Dar al cliente acceso por chat web y Telegram, y a asesores, supervisión y administración acceso por consola. La plataforma posee casos, colas, identidad, integraciones con CRM y Facturación, aprobaciones, revisiones activas del agente y vistas de los tableros. [Especificación de consola y CRM](../evolucion-mvp/consola-crm.md) · [Panel y seis tableros](../evolucion-mvp/tableros.md)

[Arquitectura Docker](../02-arquitectura-docker.md) · [Guía de arranque](../01-arranque.md) · [Inicio](../../README.md) · [DDD compartido](../03-dominio.md) · [Contratos](../04-contratos.md) · [Diseño de interfaz](#sistema-de-diseño-para-la-consola)

## Componentes

| Componente | Diseño |
| --- | --- |
| **Web** | Next.js App Router, TypeScript, Tailwind y shadcn/ui. Bandeja y caso, chat con progreso y respuesta vía SSE, historial, ficha del titular, citas y confirmación accesible. Admin con métricas, ejecuciones del agente, fuentes y configuración. Cliente Better Auth con cuentas de demo y roles validados en servidor. |
| **Platform API** | NestJS con Express, TypeScript en ESM, TypeORM y PostgreSQL. Módulos de Atención, Identidad, Retención, Aprobación y Administración. TypeORM administra casos, turnos, propuestas, efectos, revisiones y auditoría. Better Auth posee el esquema de sesiones con su adaptador PostgreSQL. |
| **Canales y workers** | Adaptador Telegram con webhook, verificación de secreto y deduplicación. Worker NestJS en proceso separado, con inbox/outbox en PostgreSQL para ejecutar el módulo de agente, entregar mensajes, registrar encuestas y reconciliar efectos. Puerto uniforme para WhatsApp y voz. |
| **Integraciones** | APIs mock de CRM y Facturación con sus OpenAPI, servidas por `crm-simulator` y `billing-simulator` en la red privada, cada una con base y rol propios. La consola consume proyecciones de NestJS. El worker de atención usa MCPs privados de lectura con acceso por caso. Las escrituras pasan por comandos autorizados, outbox y reconciliación por clave del efecto. |
| **Operación** | Traefik/Dokploy, TLS, roles y secretos desde el entorno. Exponer web y webhooks. Red privada para worker, base, mocks, ML y MLflow. Backups verificables de datos y un entorno de staging con sus credenciales. |

## Flujos por perfil

| Perfil | Recorrido principal |
| --- | --- |
| Cliente | Entra por el bot y recibe respuesta pública con cita o transferencia, escribe directamente a un asesor o responde al contacto iniciado por este. Sigue el mismo hilo hasta el cierre. |
| Asesor N1 | Toma o abre el caso, consulta la ficha privada con evidencia y borrador, responde y confirma propuestas permitidas. Puede pedir el traspaso a una especialidad. |
| Asesor N2 | Toma un caso de su cola por especialidad, recibe el mismo hilo con evidencias y pendientes, y lo resuelve o transfiere según política. |
| Supervisor | Atiende escalamiento sensible o ajuste fuera del límite del asesor → revisa hechos y evidencia → decide o reasigna. |
| Admin operativo | Consulta el Panel general y las seis vistas, revisa trazas y evals y publica o restaura una revisión autorizada. |
| Super admin | Gestiona clientes del CRM mock, operadores, capacidades y especialidades. Los cambios tienen auditoría y la ficha privada sigue bajo ámbito de caso. |
| Gestor de conocimiento | Carga fuente con visibilidad y vigencia → sigue su ingesta → verifica cuándo quedó indexada y cuándo entra en vigor. |

**Sesión y autorización.** Next.js y NestJS comparten un origen. Better Auth autentica bajo `/api/auth`. Los guards y casos de uso verifican el rol y el caso. Una sesión de asesor permite usar la consola. La titularidad es una validación adicional para acceder al CRM de ese caso.

**Apertura y propiedad.** En el ingreso por bot, el caso comienza en autoservicio. Para simular el ingreso directo, preparar un chat con ruta de atención humana y asesor asignado: el primer webhook crea el caso asistido y entrega el turno a la bandeja. Para simular el contacto saliente, el asesor selecciona un contacto sintético con chat habilitado y envía el primer mensaje desde la consola. Persistir caso, asignación, turno saliente y outbox en una transacción. Reflejar el estado de entrega y conservar el mismo hilo cuando el cliente responda.

**Consola durante la atención.** El campo de redacción envía mensajes al cliente. Junto al hilo, mostrar la ficha privada con motivo, resumen, evidencias, recursos pendientes y próxima acción. Persistir cada intervención de cliente y asesor y actualizar la ficha por SSE. Si falta titularidad, el cliente verifica su contacto y código de prueba en el chat. El asesor ve el estado y la ficha se actualiza al confirmar el código. Ante reasignación, retirar la vista privada de la sesión anterior. Al cerrar, publicar resolución y solicitar encuesta.

**Acciones.** La propuesta se crea desde el agente usando el contrato interno. Mostrar un diálogo con detalle, implicación y confirmación explícita. La API revalida identidad, rol, política, vigencia e idempotencia. En ejecución usa el mock correspondiente y reanuda el agente con resultado autenticado. Intentos repetidos no duplican efectos y los timeouts ambiguos se reconcilian. En la demo registrar la oferta y mostrar las pruebas de ticket y ajuste. [Contrato de aprobación](../04-contratos.md#aprobación-y-efecto)

## Base de datos y autenticación

| Propietario | Persistencia | Migraciones |
| --- | --- | --- |
| Plataforma | TypeORM con PostgreSQL. Casos, roles de negocio, turnos, auditoría, propuestas y outbox. | Migraciones versionadas y `synchronize: false`. Guardar cambio de dominio y evento en una transacción. |
| Autenticación | Better Auth con su **adaptador PostgreSQL nativo y `pg.Pool`**, esquema `auth` y credencial propia. | CLI de Better Auth para sus tablas. Con `pg.Pool`, configurar `search_path` y crear previamente el esquema. |
| Agente y RAG | `PostgresSaver` de LangGraph.js en esquema de checkpoints. Recuperación híbrida PostgreSQL/pgvector con un repositorio de consultas parametrizadas. Redis para resumen de sesión y preferencias autorizadas. | Preparar el esquema del checkpointer con su mecanismo de instalación. Las tablas de documentos e índice siguen las migraciones del módulo de conocimiento. |
| MLflow y ML | Base lógica dedicada al tracking y un volumen de artefactos. Servicio Python de inferencia con artefacto versionado. | MLflow gestiona su esquema y se respalda junto con sus artefactos. |

La integración usa **Nest con Express y ESM**. Montar las rutas `/api/auth/*` de Better Auth antes del parser JSON y aplicar el parser a las rutas de la API después del handler. Mantener Next.js y `/api` detrás del mismo origen en Dokploy. Better Auth autentica la sesión. Los guards de Nest comprueban permisos de asesor, supervisor y administración, y los casos de uso validan titularidad, alcance y aprobación al leer o actuar. El worker comprueba estas reglas en los servicios de aplicación porque corre fuera del pipeline HTTP. [Better Auth con Express](https://better-auth.com/docs/integrations/express) · [Adaptador PostgreSQL de Better Auth](https://better-auth.com/docs/adapters/postgresql) · [PostgresSaver en LangGraph.js](https://reference.langchain.com/javascript/langchain-langgraph-checkpoint-postgres/index/PostgresSaver)

## Administración del agente

La consola ofrece revisión de prompts, políticas de enrutamiento entre modelos, límites de tokens y tiempo, rutas y estado de publicación. **Langfuse conserva las versiones del texto de prompts y las Evals. La plataforma conserva y activa el manifiesto de revisión** por ambiente. La revisión contiene referencias inmutables a prompts de Langfuse, perfiles de modelo, límites, flags y versiones de política. El agente recibe un `config_revision` fijo por run. La evidencia de Evals también identifica el código desplegable, el índice y la suite evaluada. Los permisos y reglas de escritura residen en la aplicación.

1. Un rol editor crea un candidato desde la revisión activa. Guarda nuevas versiones en Langfuse mediante credenciales de servidor. Puede comparar el texto y perfiles por ruta.
2. Staging ejecuta golden y suite complementaria con las referencias exactas. La consola muestra Evals, trazas, cambios y validaciones pendientes.
3. Un rol publicador activa un candidato con gate aprobado. Validar que el hash del manifiesto coincida con la ejecución revisada y que el entorno no haya cambiado desde la edición. Auditar actor, revisión anterior y nueva.
4. La restauración selecciona una revisión aprobada anterior. Aplica a runs nuevos. Los runs pausados conservan el manifiesto con el que comenzaron y revalidan sus permisos vigentes al reanudar.

Separar permisos de soporte, operación, edición y publicación. Una configuración de administrador solo selecciona modelos y capacidades dentro de una lista habilitada por el sistema. [Versionamiento de prompts de Langfuse](https://langfuse.com/docs/prompt-management/features/prompt-version-control)

## Tableros y observabilidad

El Panel general enlaza a seis tableros con indicadores seleccionables. **Negocio**, **Calidad del LLM**, **Técnica**, **Agentes**, **Machine learning** y **DevOps** conservan los grupos del reto. Cada vista presenta fuente, muestra, ventana y meta cuando aplica. [Definiciones y fuentes por grupo](../evolucion-mvp/tableros.md)

OpenTelemetry une solicitudes, workers y dependencias. El worker envía trazas OTLP saneadas a Langfuse autohospedado. Prometheus recoge las métricas técnicas. El tablero permite abrir una traza autorizada y muestra datos sintéticos y piloto como procedencias distintas. Presenta OpenAI Direct y Jev por OpenRouter como etapas y costos separados. [Diseño de observabilidad](observabilidad.md) [Definiciones de KPIs y metas](../06-calidad-y-release.md#métricas-de-aceptación) · [Enunciado](../06-calidad-y-release.md#métricas-de-aceptación)

## Sistema de diseño para la consola

Identidad de demo inspirada en Claro, con superficies claras, rojo para la acción principal, texto oscuro y estados con iconos y etiquetas. La estructura visual se centra en la conversación y sus evidencias. Usar **Geist** para interfaz y números tabulares para métricas, escala de 4 px y radios de 8–12 px. Si se necesita aplicar identidad corporativa exacta al entregar, tomar valores de un manual de marca autorizado.

| Capa | Decisiones |
| --- | --- |
| Primitivos | Rojo oscuro `#B51226`, tinta `#171717`, blanco `#FFFFFF`, gris `#F5F5F5`, verde oscuro `#166534` y ámbar oscuro `#92400E`. Valores propuestos, con contraste que se valida en los componentes y estados finales. |
| Semánticos | `background`, `foreground`, `primary`, `muted`, `border`, `ring`, `destructive`, `success`, `warning` y `chart-1…5`. Mapear con variables CSS del tema shadcn/ui. |
| Componentes | Chat y ficha con `ScrollArea`, `Tabs`, `Sheet`, `Badge`, `Skeleton` y `Alert`. Derivación y registro de oferta con `AlertDialog` que muestra acción, cliente enmascarado, consecuencias y confirmación. Tablero con `Card`, tabla, filtros y `Chart`. |
| Interacción | Escritorio con bandeja, conversación y panel lateral. En móvil hacer accesible el panel con `Sheet`. Usar foco visible, teclado, etiquetas para estados y anuncios accesibles para cambios significativos del stream. Transiciones CSS cortas y discretas con `prefers-reduced-motion`. Motion se reserva para una transición que mejore orientación tras probar la interfaz. |

Rutas de la consola: conversación y bandeja, detalle y citas del caso, fuentes y versiones, tablero. El cliente continúa por el chat web o Telegram y conserva el hilo al pedir un asesor. [Theming de shadcn/ui](https://ui.shadcn.com/docs/theming)

## Inicio en paralelo y aceptación

1. Crear las pantallas de acceso, bandeja y caso usando un mock de agente que emita progreso y estado final.
2. Implementar webhook, persistencia y propiedad del caso. Conectar las APIs mock y el flujo de aprobación con estados.
3. Añadir configuración, prompts versionados, promoción y restauración. Crear el tablero sobre eventos sintéticos y contratos para telemetría real.
4. Integrar AgentModule a través del worker y sus eventos persistidos. Conectar ML con su API HTTP privada cuando pasen los contratos.

**Criterios.** Los tres orígenes crean un caso con historial durable y autoría visible. El asesor recibe los recursos de C-1001, C-1004 y C-1007 automáticamente. Una nota privada queda fuera del envío al canal y un efecto aprobado se registra una sola vez. [Escenas de aceptación](../06-calidad-y-release.md#tres-casos-de-la-demo) Un admin cambia una revisión en staging, revisa Evals y activa o restaura con auditoría. Cubrir concurrencia al tomar casos, autorización por rol, recuperaciones y recorrido E2E. [Contratos de inicio](../04-contratos.md#stubs-y-aceptación-de-contrato)
