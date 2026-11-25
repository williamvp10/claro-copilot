# Contratos de integración del MVP

Estas interfaces v1 permiten desarrollar con stubs. Plataforma y agente comparten contratos TypeScript en el backend NestJS. API y worker se comunican con trabajos y eventos persistidos en PostgreSQL. La plataforma conserva la identidad del caso y entrega al run el ámbito necesario. ML se consume por HTTP privado con identidad de servicio. Las herramientas de cuenta exigen autorización vigente del caso.

[Arquitectura Docker](02-arquitectura-docker.md) · [Guía de arranque](01-arranque.md) · [DDD](03-dominio.md) · [Plataforma](plataforma/diseno.md) · [Agente](agente/diseno.md) · [ML](ml/diseno.md)

## Puertos e interfaces iniciales

| Llamador → módulo o servicio | Contrato | Entrada y salida mínimas |
| --- | --- | --- |
| Web → Plataforma | `POST /api/v1/cases` | Apertura saliente por el asesor autenticado. Recibe referencia del chat habilitado, texto inicial y clave de idempotencia. La API fija propietario y modo asistido, persiste caso y primer turno, y encola la entrega al cliente. |
| Web → Plataforma | `POST /api/v1/cases/{id}/messages` | Mensaje dirigido al cliente desde la consola. Comprueba sesión, asignación y clave de idempotencia, guarda el turno del asesor y encola entrega y análisis por separado. |
| Plataforma → Agente | `enqueueRun(turn)` | Recibe run ID preasignado, sobre de turno, ámbito y revisión. Persiste trabajo y devuelve `run_id` con `status=accepted`. Repetir clave y payload devuelve el mismo run. Un payload distinto con la misma clave genera conflicto. |
| Plataforma → Agente | `readRunEvents(run_id, cursor)` | Plataforma consulta eventos del run filtrados por cursor. Devuelve eventos ordenados y el siguiente cursor. Sirve progreso, espera y respuesta terminal. |
| Plataforma → Agente | `enqueueRunResume(result)` | Recibe evento de resultado autenticado con `effect_id`, estado y referencia autorizada. Reanuda con el mismo checkpoint. Un resultado que llega antes del checkpoint queda pendiente en un inbox. La repetición conserva el avance. |
| Agente → Plataforma | `getAgentConfig(revision)` | Devuelve manifiesto inmutable autorizado para el entorno y su hash. Solo revisiones activadas o candidatos de staging con permiso. |
| Agente → Plataforma | `getCustomerContext(run_id)` | Con el ámbito del run validado en plataforma, devuelve datos mínimos permitidos, servicios y referencias de cuenta. El titular se deriva del contexto en servidor. |
| Agente → Plataforma | `getBilling(run_id, period)` / `getTickets(run_id)` | Lecturas tipadas por caso y período. Facturas, saldo y tickets incluyen estado y `fact_ids`. Un error se representa como error o dato pendiente. |
| Agente → Plataforma | `evaluateRetention(run_id, facts)` | Recibe referencias de hechos y devuelve elegibilidad, opciones, motivo y versión de política. Es una evaluación pura. |
| Agente → Plataforma | `createProposal(run_id, input)` | Recibe tipo de acción y referencias de evidencia. Valida y guarda una propuesta interna. Devuelve ID y estado `pending_approval`. |
| Web → Plataforma | `POST /api/v1/proposals/{id}/decision` | Sesión del asesor, decisión aprobada o rechazada, y revisión de propuesta. Solo la plataforma ejecuta el efecto y publica el resultado. |
| Plataforma → Agente | `enqueueIngestion(input)` | Envía referencia de archivo de lectura privada, hash, ámbito y metadatos. Devuelve ID de ingesta. |
| Plataforma → Agente | `getIngestionStatus(job_id)` | Devuelve estado, versión, tiempos de detección/indexado y error saneado si aplica. |
| Agente → MCP | Streamable HTTP privado `/mcp` | Búsqueda pública o de asesor. Devuelve extractos, referencias y versiones autorizadas. Validar el ámbito del run antes de recuperar. |
| MCP → reranker | `POST /internal/v1/rerank` | Consulta saneada y pasajes ya filtrados. Devuelve scores por candidato o un error que activa la ruta RRF. |
| Agente → ML | `POST /internal/v1/predict-intent` | Texto saneado, canal, ID de turno y clave de idempotencia. Devuelve clase, score, versión, modo, recomendación y `prediction_id`. El agente invoca en sombra de forma asíncrona. |
| Plataforma → ML | `POST /internal/v1/predict-churn` | Recibe la foto de variables y los agregados de historial del cliente identificado. Devuelve prioridad relativa, recomendación, horizonte de 90 días, fecha de corte y versión. |
| Plataforma → ML | `POST /internal/v1/intent-labels` | Emite corrección supervisada con `prediction_id`, clase de dominio y `event_id`. ML valida y deduplica. |
| Plataforma → ML | `GET /internal/v1/model-metrics` | Devuelve agregados por ventana, modo, canal y versión. Incluye métricas offline de intención y churn. El estado de drift y el volumen de etiquetas corresponden a intención. |

Los nombres de métodos representan puertos TypeScript. En las interfaces HTTP se valida la identidad y el permiso sobre el recurso. El worker usa los mismos casos de uso de dominio mediante inyección de dependencias. Next.js usa la sesión de Better Auth en el mismo origen para llamar a NestJS. La credencial de servicio se aplica a ML y a las demás llamadas privadas que cruzan un proceso por HTTP. CRM y facturación conservan su OpenAPI original hacia la capa anticorrupción. [CRM OpenAPI](openapi/crm-api.yaml) · [Facturación OpenAPI](openapi/facturacion-api.yaml) · [Extensiones y rutas BFF](openapi/simuladores.md)

## Ejemplo de ejecución

La clave de idempotencia se construye con la referencia estable del turno. El sobre del trabajo conserva `traceparent` para propagar la traza. Antes de enviar el turno, la plataforma reserva el run ID, guarda el vínculo con el caso y fija el ámbito y la revisión activa. Así las herramientas pueden validar el caso aunque se invoquen inmediatamente tras aceptar el run.

```json
{
  "run_id": "run_demo_01",
  "case_id": "case_demo_01",
  "conversation_id": "conv_demo_01",
  "turn_id": "turn_001",
  "channel": "telegram",
  "actor": "cliente",
  "turn_seq": 1,
  "case_revision": 1,
  "attention_mode": "autoservicio",
  "audience": "cliente",
  "scope_ref": "scope_public_demo_01",
  "config_revision": "agent_cfg_001",
  "business_date": "2026-11-18",
  "text": "En mi televisor aparece E-202."
}
```

Un evento terminal puede incluir `status`, `route`, `reason_codes`, `answer`, `citation_ids`, `fact_ids`, `handoff_destination` y `proposal_id` cuando apliquen. Estados de run propuestos `accepted`, `running`, `waiting_approval`, `completed`, `failed`. La ruta de negocio la decide el grafo. Jev aporta etiquetas tipadas y ML clásico emite una predicción de sombra. La ruta conserva nombres del [playbook y fixtures de Evals](agente/atencion-prompts-y-evals.md#evals-a-construir). Cada evento tiene `seq`, `event_id`, `type` y `run_id`. Tipos mínimos `progress`, `answer_chunk`, `waiting_approval`, `handoff`, `completed` y `failed`.

**Contexto de entrega.** Plataforma fija `actor`, `turn_seq`, `case_revision`, `attention_mode` y `audience` a partir del caso autenticado. El texto del mensaje carece de autoridad sobre esos campos. En autoservicio la respuesta validada para `cliente` puede llegar al canal. En asistido, los runs de análisis de turnos de cliente y asesor usan `audience=asesor` y emiten `FichaAsesorActualizada` por SSE privado. Los mensajes que el asesor decide enviar al cliente siguen el puerto de mensajes de plataforma.

**Chat web y traspaso.** `POST /api/v1/web-chat/session/new` abre una conversación separada con una cookie nueva bajo los mismos controles de origen y cuota que la apertura de sesión. La conversación anterior se conserva en la plataforma. El estado público usa `awaiting_advisor` y `attention_mode` para reflejar la espera y la asignación. En la cola, un asesor N1 puede ver `handoff_reason`. El historial, las lecturas de cuenta y las señales de ML se habilitan al asignar el caso al asesor correspondiente.

| Evento | Datos y regla de consumo |
| --- | --- |
| `TurnoRecibido` | Caso, conversación, turno, autor, orden, texto y referencia del canal. Deduplicar la entrega del webhook o el reenvío desde la consola. Registrar las salidas del agente para el historial y excluirlas, junto con fichas y acuses de entrega, de los disparadores de análisis. |
| `CasoTomado` / `TitularVerificado` | Identidad del evento, caso y nueva revisión. Recalcular la ficha desde el hilo vigente. Al verificar, retomar automáticamente la lectura pendiente en el ámbito autorizado. Deduplicar por evento para que el mismo turno pueda reevaluarse con nuevos permisos. |
| `FichaAsesorActualizada` | Caso, revisión, último `turn_seq` considerado, intención, resumen, `fact_ids`, `citation_ids`, pendientes, próxima acción y `proposal_id` si aplica. Guardar la vista en PostgreSQL. El cliente SSE autorizado recupera la ficha vigente y continúa desde su cursor. |

Al publicar o entregar una salida, plataforma comprueba de nuevo modo, propietario, ámbito y revisión. Descartar las salidas públicas pendientes de una revisión anterior al traspaso. Actualizar la ficha solo si la revisión y los turnos siguen vigentes. Una revocación corta el SSE autorizado y retira la ficha anterior.

## Aprobación y efecto

1. El agente solicita una propuesta interna para el caso y pausa su run. La propuesta guarda revisión, tipo, titular, detalle normalizado y caducidad.
2. La plataforma recibe la decisión desde una sesión autorizada. Una transacción fija la decisión y, al aprobar, escribe trabajo en el outbox. El worker verifica de nuevo rol, titular, elegibilidad y versión antes de ejecutar.
3. La plataforma guarda el resultado con una clave de efecto única y reanuda el run con `confirmed`, `rejected`, `expired` o `pending_verification`. Una respuesta ambigua conserva estado pendiente. Para deduplicar el mock, usar un registro persistente de efectos con la clave interna de la propuesta. En una API externa futura, comprobar su mecanismo de idempotencia y reconciliación.
4. El agente describe el resultado recibido. Una oferta registrada, un ticket creado y una visita agendada son estados diferentes.

## Predicción y observabilidad

Ejemplo de respuesta del servicio de ML. El score es ilustrativo y no representa probabilidad calibrada.

```json
{
  "prediction_id": "pred_demo_01",
  "label": "soporte_tecnico",
  "score": 0.62,
  "score_type": "uncalibrated",
  "model_version": "intent-e5-svm-1",
  "mode": "shadow",
  "recommendation": "suggest_intent_for_review",
  "requires_human_confirmation": true
}
```

Clases `soporte_tecnico`, `facturacion`, `consulta_planes`, `cancelacion`, `portabilidad`. Un predictor indisponible responde `503` o expira por timeout. El proceso principal sigue su ruta. `POST /api/v1/cases/:id/ml/intent-label` recibe `prediction_id`, `label` y `event_id`. La plataforma valida sesión, propietario y turno vigente. El outbox reusa el evento al reenviar y la ficha distingue el registro local del acuse de FastAPI.

Para churn la prioridad hace referencia a los percentiles del score en desarrollo. `CaseSnapshot.ml` presenta banda, corte, recomendación y versión al asesor autorizado. La foto queda ligada al titular verificado. `POST /api/v1/cases/:id/ml/follow-up` recibe `case_revision`, `event_id` y `status`. El comando `agreed` exige `due_date` y una banda disponible. `completed` exige un acuerdo pendiente del mismo caso y titular. La plataforma conserva responsable y fecha del acuerdo. El panel identifica cohorte y métricas offline y separa cobertura de fotos, bandas y seguimientos observados. [Integración de intención y churn](evolucion-mvp/ml-intencion-y-churn.md)

Propagar `traceparent`, `run_id` y referencias opacas a través de plataforma, agente y ML. Exponer métricas agregadas por canal, ruta y versión. El detalle de Langfuse conserva prompts/versiones, resultados saneados y latencias. Los eventos de dominio respaldan las métricas de negocio.

## Stubs y aceptación de contrato

- **Stub de agente.** Secuencias de respuesta pública, derivación con historial y fichas privadas de factura, oferta elegible y denegación. Permitir retrasar una salida para probar un cambio de propietario o turno. Permite desarrollar bandeja, streaming y confirmación en plataforma.
- **Stub de plataforma.** Contextos sintéticos público y asesor, lecturas de los clientes C-1001, C-1004, C-1007 y C-1013, aprobación, umbral de ajuste y fallos configurables. Sirve para desarrollar el grafo sin depender de la consola.
- **Stub de ML.** Predicción fija con versión y modo sombra, así como timeout reproducible. Permite probar que las decisiones del turno sobreviven a la falta de inferencia.
- **Pruebas comunes.** Validar campos, eventos ordenados, aislamiento de identidad, replay con la misma clave, fallo de lectura, caso tomado por humano y cero efectos antes de aprobar. Versionar los schemas de contrato y usar los mismos fixtures para cada consumidor.

## Manifiesto de configuración del agente

Plataforma publica una revisión inmutable por ambiente. El agente usa identificadores permitidos y accede a cada credencial desde su adaptador de servidor. La revisión indica las referencias de modelos y prompts. Las credenciales, reglas de autorización y permisos de herramientas se resuelven en la aplicación.

```json
{
  "revision": "agent_cfg_002",
  "prompt_refs": {
    "orchestrator": {"name": "claro/orchestrator", "version": 4},
    "support": {"name": "claro/support", "version": 3}
  },
  "classifier": {
    "provider": "openrouter",
    "model": "typesafe/jev-1.14",
    "schema_revision": "claro_intent_v1",
    "timeout_ms": 800
  },
  "generation": {
    "provider": "openai_direct",
    "profiles": {
      "economico": {"model": "gpt-6-luna", "reasoning_effort": "none"},
      "intermedio": {"model": "gpt-6.1-terra", "reasoning_effort": "low"},
      "complejo": {"model": "gpt-6.2-sol", "reasoning_effort": "low"}
    },
    "max_generation_cost_usd_per_turn": 0.02
  },
  "retrieval_profile": "hybrid_rerank_v1",
  "intent_model_mode": "shadow"
}
```

El ejemplo fija los valores iniciales para evaluación. El modo de ML se lee del release aprobado. El panel muestra la revisión activa, carga una candidata y solicita Evals sobre su hash. Para activarla, una operación de plataforma exige el resultado aprobado para el mismo manifiesto y una revisión base vigente. Una restauración sigue el mismo control de permisos y auditoría. [Reglas y umbrales de enrutamiento](agente/enrutamiento-y-reranking.md) · [Datos y operación del panel](plataforma/observabilidad.md)

## Chat de cliente en el MVP

| Ruta | Contrato |
| --- | --- |
| POST /api/v1/web-chat/session | Emite o recupera una sesión sintética mediante cookie HttpOnly y SameSite. La sesión dura 24 horas. |
| POST /api/v1/web-chat/messages | Recibe texto e idempotency_key. La API obtiene canal, rol y expediente de la sesión. Usa la misma persistencia y outbox que Telegram. |
| POST /api/v1/web-chat/verification/start | Busca el alias `identifier` en el mock y crea un desafío de cinco minutos para el mismo expediente. |
| POST /api/v1/web-chat/verification/confirm | Recibe `challenge_id` y `code`. El modo demo acepta seis dígitos, vincula la cuenta al caso y retoma la consulta. |
| GET /api/v1/web-chat/history | Devuelve conversación, mensajes visibles para la sesión, modo, estado, cursor y etapa de verificación. La ficha y el propietario se consultan en la API autorizada de asesor. |
| GET /api/v1/web-chat/events | Envía conversation.updated con la proyección pública. Reanuda con cursor o Last-Event-ID. |

El navegador consulta periódicamente el historial para recuperar mensajes persistidos si se interrumpe SSE. El asesor responde al canal de origen y el modo asistido mantiene el mismo expediente. Los alias y códigos se capturan en formularios del chat y quedan fuera del historial y de los proveedores de IA. El vínculo entre cuentas de distintos canales requiere una operación independiente de verificación.

El [corte propuesto de atención asistida](../specs/002-atencion-asistida/plan.md#2-continuidad-pública-en-web-y-telegram) agrega la etapa pública de atención y avisos persistidos de toma, escalamiento y cancelación. La proyección del cliente incluye el nombre visible autorizado del asesor y el destino público cuando corresponda. El motivo confirmado y la ficha siguen en la interfaz privada del caso.
