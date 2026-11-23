# Arquitectura del MVP en Dokploy

[Arquitectura y criterios del siguiente corte del MVP](evolucion-mvp/arquitectura-y-aceptacion.md) · [Agente, subgrafos y herramientas en Archify](evolucion-mvp/diagramas/arquitectura-agente.html)

Claro Copiloto comparte un expediente entre el chat web de cliente, Telegram y la consola de atención. El guion más reciente de la presentación define el alcance. La demo se empaqueta con Compose y el destino de despliegue es una VPS con Dokploy.

[Contratos](04-contratos.md) · [Operación](../infra/README.md) · [Criterios de corte](06-calidad-y-release.md)

## Servicios y persistencia

```mermaid
flowchart LR
  C["Cliente · chat web"] --> Edge["Traefik de Dokploy"]
  T["Telegram Bot API"] --> Edge
  A["N1, N2, supervisión y administración"] --> Edge
  Edge --> Web["Next.js · chat, CRM y tableros"]
  Web -->|"/api, SSE y webhook HTTPS"| API["NestJS · API"]
  subgraph Postgres["Una instancia PostgreSQL · tres roles de aplicación"]
    PG[("Plataforma · casos, outbox, pgvector")]
    CDB[("claro_crm")]
    BDB[("claro_facturacion")]
  end
  API --> PG
  API -->|"CRM y datos autorizados"| CRM["Express · CRM API mock"]
  API --> Billing["Express · Facturación API mock"]
  Worker -->|"Lectura por caso"| CRMMCP["MCP CRM"]
  Worker -->|"Lectura por caso"| BillingMCP["MCP Facturación"]
  CRMMCP --> CRM
  BillingMCP --> Billing
  Worker -->|"Efecto aprobado por outbox"| CRM
  Worker -->|"Efecto aprobado por outbox"| Billing
  CRM --> CDB
  Billing --> BDB
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
| Base | Next.js sirve el chat en `/chat` y la consola en `/`. API, worker, migración y los MCPs privados de CRM y Facturación usan la misma imagen. PostgreSQL conserva casos, sesiones web, acciones, ejecuciones y outbox. Redis conserva el identificador de la última ejecución con TTL. Los mocks Express cargan 20 clientes y 60 facturas desde los insumos. El job de migración mantiene los volúmenes existentes y aprovisiona dos bases aisladas y sus roles. |
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
  participant CRM as CRM API mock
  participant Billing as Facturación API mock
  actor Admin as Supervisor de facturación
  Client->>API: Mensaje de planes o soporte
  API->>DB: Persiste turno con canal e idempotencia
  Agent->>DB: Lee turno y ámbito
  Agent->>Agent: Jev clasifica · RAG filtra · OpenAI redacta
  Agent->>DB: Guarda respuesta validada y citas
  DB-->>Client: SSE web o entrega por Telegram
  Client->>API: Solicita información de cuenta
  opt El chat requiere verificación de cuenta
    API-->>Client: Pide un correo o número de prueba
    Client->>API: Selecciona el contacto y confirma el código simulado
    API->>CRM: Resuelve el alias de prueba
    API->>DB: Vincula la cuenta a la conversación
    API->>Billing: Consulta saldo y factura cuando aplica
    API-->>Client: Responde en el mismo chat
  end
  opt Atención con asesor
    Advisor->>API: Toma el caso y comprueba el estado de titularidad
    Agent->>Agent: Selecciona lecturas CRM y Facturación vía MCP
    Agent->>DB: Actualiza ficha privada con evidencia y borrador
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
    CRM-->>Agent: Devuelve recibo consultable
    Agent->>DB: Proyecta la referencia confirmada
    DB-->>Advisor: Entrega evidencia privada
  end
  opt Ajuste que supera COP 50.000 acumulados por factura
    Advisor->>API: Confirma importe y motivo en el caso verificado
    Admin->>API: Aprueba con su propia sesión
    Agent->>Billing: Valida factura y envía el crédito con clave estable
    Billing-->>Agent: Conserva el crédito y su recibo
    Agent->>DB: Confirma solo tras consultar el recibo
  end
```

El navegador recibe un identificador opaco por cookie HttpOnly. El servidor proyecta el historial visible para esa sesión y mantiene la ficha privada en consola. Telegram vincula el chat desde el webhook autenticado. Ambos canales pueden verificar la cuenta del CRM mock mediante el flujo conversacional de OTP de demo. La titularidad permanece en el expediente al pasar a N1, N2 o supervisión según política. La plataforma revalida rol, revisión y titularidad antes de acceder a hechos privados y requiere aprobación para los efectos.

OpenAI recibe el tema saneado y pasajes públicos vigentes y con aprobación de procesamiento `provider_approved: true`. La aplicación valida referencias y cifras antes de persistir. Ante una falla puede volver al extracto citado o derivar. Las fuentes quedan ligadas a versión y vigencia. OCR automatizado y reranker ONNX son mejoras del diseño documental.

## Arquitectura objetivo en AWS

La propuesta de producción usa ALB y WAF delante de ECS Fargate, Aurora PostgreSQL con pgvector, outbox con relé a SQS FIFO y ElastiCache. S3 aloja documentos y habilita el procesamiento autorizado. Bedrock y SageMaker cubren generación y MLOps en esa arquitectura. WhatsApp y voz asistida con Connect se habilitarían por país tras validar cuotas, datos y operación. GCP se conserva como alternativa evaluada. El corte de demo usa Compose en Dokploy.
