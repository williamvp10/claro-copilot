# Arquitectura del MVP en Dokploy

Claro Copiloto comparte un expediente entre el chat web de cliente, Telegram y la consola de atención. El guion más reciente de la presentación define el alcance. La demo se empaqueta con Compose y el destino de despliegue es una VPS con Dokploy.

[Contratos](04-contratos.md) · [Operación](../infra/README.md) · [Criterios de corte](06-calidad-y-release.md)

## Servicios y persistencia

```mermaid
flowchart LR
  C["Cliente · chat web"] --> Edge["Traefik de Dokploy"]
  T["Telegram Bot API"] --> Edge
  A["Asesor y administración"] --> Edge
  Edge --> Web["Next.js · chat y consola"]
  Web -->|"/api, SSE y webhook HTTPS"| API["NestJS · API"]
  API --> PG[("PostgreSQL · casos, outbox, índice pgvector")]
  PG --> Worker["NestJS · worker LangGraph"]
  Worker --> PG
  Worker --> Redis[("Redis · última ejecución")]
  Worker --> MCP["MCP privado · conocimiento"]
  MCP --> PG
  Worker --> OpenAI["OpenAI Direct · redacción pública"]
  Worker --> Jev["OpenRouter · Jev"]
  Worker --> ML["FastAPI · clasificador en sombra"]
  Worker --> LF["Langfuse · Compose de observabilidad"]
  Train["Job de entrenamiento"] --> Reg["MLflow OSS · registro"]
  Reg --> Release["Job de publicación"]
  Release --> Bundle[("Bundle verificado de solo lectura")]
  Bundle --> ML
```

| Perfil | Procesos y almacenamiento |
| --- | --- |
| Base | Next.js sirve el chat en /chat y la consola en /. API, worker y migración usan la misma imagen. PostgreSQL conserva casos, sesiones web, acciones, ejecuciones y outbox. Redis conserva el identificador de la última ejecución con TTL. Los efectos de CRM y facturación usan fixtures y persistencia local. |
| knowledge | MCP privado de solo lectura. El corpus aprobado se prepara fuera del repositorio y se carga con el comando de ingesta. Filtros de audiencia y vigencia, búsqueda de texto y vectores de hashing en pgvector, fusión RRF y reordenamiento en el agente con términos de dominio, coincidencia ponderada y diversidad de fuentes. |
| ml y ml-jobs | MLflow OSS registra modelos con SQLite y persistencia en mlflow-data. La publicación verifica el modelo y su firma. FastAPI carga el bundle fijado desde ml-models en solo lectura y guarda señales en ml-state. Los fallos del predictor se auditan y la atención continúa. |
| observability | Prometheus obtiene métricas del backend. El agente exporta trazas OTLP saneadas a Langfuse. El Compose separado de Langfuse contiene web, worker, PostgreSQL, ClickHouse, Redis y almacenamiento compatible con S3. ClickHouse escucha en la red privada IPv4 y el worker espera el arranque verificado del servicio web. |

## Atención y acción aprobada

```mermaid
sequenceDiagram
  actor Client as Cliente web o Telegram
  participant API as API del canal
  participant DB as Caso y outbox
  participant Agent as Worker
  actor Advisor as Asesor
  participant CRM as CRM simulado
  Client->>API: Mensaje de planes o soporte
  API->>DB: Persiste turno con canal e idempotencia
  Agent->>DB: Lee turno y ámbito
  Agent->>Agent: Jev clasifica · RAG filtra · OpenAI redacta
  Agent->>DB: Guarda respuesta validada y citas
  DB-->>Client: SSE web o entrega por Telegram
  Client->>API: Solicita información de cuenta
  alt Chat web de demo
    API-->>Client: Pide un correo o número de prueba
    Client->>API: Selecciona el contacto y confirma el código simulado
    API->>DB: Vincula la cuenta a la conversación
    API->>CRM: Lee la información solicitada
    API-->>Client: Responde en el mismo chat
  else Telegram
    Agent->>DB: Registra derivación con el historial
  end
  opt Atención con asesor
    Advisor->>API: Toma el caso y comprueba el estado de titularidad
    Agent->>DB: Actualiza ficha privada de cuenta
    DB-->>Advisor: SSE de consola
    Advisor->>API: Responde en la misma conversación
    API-->>Client: Envía respuesta al canal de origen
  end
  opt Retención elegible y alternativa aceptada
    Client->>API: Acepta alternativa por el canal de origen
    Agent->>DB: Guarda propuesta pendiente
    Advisor->>API: Aprueba la propuesta
    API->>DB: Publica comando con clave idempotente
    Agent->>CRM: Revalida y registra una sola operación
    CRM-->>DB: Conserva referencia confirmada
    DB-->>Advisor: Entrega evidencia privada
  end
```

El navegador recibe un identificador opaco por cookie HttpOnly. El servidor proyecta el historial visible para esa sesión y mantiene la ficha privada en consola. La verificación simulada del chat web vincula una cuenta del mock en PostgreSQL. El asesor recibe la titularidad verificada cuando el cliente pide ayuda desde ese hilo. Telegram vincula el chat desde el webhook autenticado. La plataforma revalida rol y titularidad antes de acceder a hechos privados y requiere aprobación para los efectos.

OpenAI recibe el tema saneado y pasajes públicos vigentes y con aprobación de procesamiento `provider_approved: true`. La aplicación valida referencias y cifras antes de persistir. Ante una falla puede volver al extracto citado o derivar. Las fuentes quedan ligadas a versión y vigencia. OCR automatizado y reranker ONNX son mejoras del diseño documental.

## Arquitectura objetivo en AWS

La propuesta de producción usa ALB y WAF delante de ECS Fargate, Aurora PostgreSQL con pgvector, outbox con relé a SQS FIFO y ElastiCache. S3 aloja documentos y habilita el procesamiento autorizado. Bedrock y SageMaker cubren generación y MLOps en esa arquitectura. WhatsApp y voz asistida con Connect se habilitarían por país tras validar cuotas, datos y operación. GCP se conserva como alternativa evaluada. El corte de demo usa Compose en Dokploy.
