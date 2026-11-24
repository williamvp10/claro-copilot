# Observabilidad y operación de la consola

La consola del asesor muestra evidencia y estado del caso. La consola de administración muestra calidad, salud y versiones, y permite preparar cambios. Ambas consumen la **API de plataforma**. Esta API consulta Langfuse, MLflow y los datos operativos con credenciales de servidor y aplica permisos antes de componer la respuesta.

[Arquitectura Docker y observabilidad](../02-arquitectura-docker.md#observabilidad-evals-y-dashboard) · [Inicio del MVP](../../README.md) · [Contratos](../04-contratos.md) · [KPIs y definiciones](../06-calidad-y-release.md#métricas-de-aceptación)

## Qué se muestra por rol

| Pantalla | Datos y controles | Fuente |
| --- | --- | --- |
| **Asesor · Bandeja** | Canal, motivo, tiempo en cola, estado y casos asignados. Al tomar un caso, la API confirma propiedad y registra el cambio. | Atención en PostgreSQL y eventos de plataforma. |
| **Asesor · Caso** | Conversación, estado de titularidad, ficha autorizada, citas y resultado de herramientas relevantes. La propuesta indica acción, alcance y estado de aprobación. | Eventos del agente, retrieval y APIs de CRM y facturación tras verificar titular. |
| **Asesor · Cierre** | Motivos, asuntos resueltos y pendientes, responsable y encuesta si llegó. La intención estimada aparece como sombra, con opción de corrección y su versión. | Caso y feedback en plataforma, inferencia del servicio de ML y resumen validado del agente. |
| **Admin · Panorama** | Volumen y éxito por ruta, p95, costo, error de herramientas, frescura, exactitud y estado de release. Tarjetas con período, ambiente, muestra y hora de actualización. | Vistas agregadas de plataforma, Langfuse, métricas técnicas, MLflow y artefactos de CI. |
| **Admin · Ejecuciones** | Traza vinculada al turno con duración, resultado, versión y etapas. Incluye decisión Jev, retrieval, re-ranking, generación, herramientas y aprobación cuando existan. Se enmascaran campos sensibles. | Observaciones de Langfuse y resumen de auditoría de plataforma. |
| **Admin · Revisiones** | Comparar revisiones, editar prompts, seleccionar perfiles de modelo, configurar límites y revisar Evals antes de promover o restaurar. Mostrar revisión activa por entorno. | Manifiestos de plataforma, versiones de prompts en Langfuse y resultados de CI. |

En desarrollo, usar números, casos y acciones sintéticos. En ejecución, una lectura sin muestra o con la fuente caída se presenta como **sin datos**, **pendiente** o **última actualización** según corresponda. El estado real del caso y los efectos provienen de plataforma y el CRM mock.

## Contrato de telemetría

- **Correlación.** Propagar `traceparent`. Asociar `run_id`, `case_id` opaco, canal, modo de atención, audiencia, ruta, entorno y `config_revision`. Usar referencias opacas en observaciones de detalle. Las series agregadas usan dimensiones de cardinalidad acotada.
- **Sesiones y usuarios en Langfuse.** Cada turno exportado conserva su propia traza y comparte `sessionId` con los demás turnos de la conversación. En chat web, al pulsar **Nuevo chat** desde una sesión válida se inicia otra conversación con el mismo `userId` anónimo. En Telegram el usuario se asocia al contacto interno del canal. La plataforma calcula ambos identificadores con HMAC y los propaga a todas las observaciones. Los cambios se aplican desde la primera traza exportada con esta versión. [Sesiones](https://langfuse.com/docs/observability/features/sessions) · [Usuarios](https://langfuse.com/docs/observability/features/users)
- **Etapas.** Nombrar los spans `turn.intake`, `decision.jev`, `retrieval.hybrid`, `retrieval.rerank`, `llm.generate`, `tool.read`, `action.waiting_approval`, `action.execute`, `ml.predict_shadow` y `channel.deliver`. Registrar duración y estado solo cuando la etapa ocurra. Langfuse conserva código de resultado y motivo estructurado.
- **Ficha proactiva.** Vincular turno, recurso esperado y versión de ficha con su primera visualización efectiva en el navegador. Registrar cuándo el asesor buscó manualmente el recurso o respondió al cliente. Mostrar tiempos por escena y, con volumen suficiente, p95 por modo. Informar casos elegibles, recursos correctos disponibles a tiempo y casos sin recurso. [Definición de los dos indicadores](../06-calidad-y-release.md#métricas-de-aceptación)
- **Modelos y costo.** Cada observación registra proveedor, modelo, perfil, versión de prompt o esquema de decisión, uso y costo imputable. En OpenAI Direct, registrar uso de Responses, incluidos tokens de razonamiento cuando estén disponibles sin duplicar el total de salida. En Jev, registrar uso/costo que devuelve OpenRouter. Mostrar ambos proveedores por separado y marcar estimaciones y datos faltantes. El costo interno del reranker de CPU se reporta con métricas de infraestructura por separado.
- **Privacidad.** Enmascarar entrada, salida, resultados y trazas antes de enviar. Para Jev enviar solo mensaje mínimo saneado y señales necesarias, sin documentos, saldos, importes individualizados ni identificadores del titular. La autorización, la auditoría de escritura y el consentimiento viven en plataforma.
- **Lecturas.** En la demo el dashboard consulta métricas propias, auditoría agregada, evaluación activa y la API interna de ML. Prometheus y Langfuse autohospedado brindan inspección operativa. La evolución del tablero puede consultar Metrics API v2 y Observations API v2 de Langfuse para agregar y navegar trazas. [API pública de Langfuse](https://langfuse.com/docs/api-and-data-platform/features/public-api) · [Metrics API](https://langfuse.com/docs/metrics/features/metrics-api) · [Registro de uso y costos](https://langfuse.com/docs/observability/features/token-and-cost-tracking)

### Fuente de verdad de cada grupo

| Grupo | Persistencia y cálculo |
| --- | --- |
| Negocio y CSAT | Postgres: `CasoTomado`, resolución, cierre, recontacto, encuesta, derivación y oferta. AHT y FCR requieren ventanas comparables. Calcular CSAT con votos válidos y mostrar participación. |
| Calidad de RAG y LLM | Langfuse y CI: resultado de golden y suite complementaria, groundedness, Recall@k, citas válidas y abstenciones. Distinguir `eval.jev` de `decision.jev`, y mostrar costo de evaluación, cobertura, pasos pendientes de revisión y versión de la rúbrica. Identificar corpus, modelo, prompt y dataset. |
| Agentes | Langfuse y auditoría: éxito por tarea, errores por invocación, reintentos, escalamiento, bloqueos y efectos. Los spans de espera humana se muestran aparte del tiempo de servicio. |
| Técnicas | OpenTelemetry Collector y Prometheus para API, worker e ingesta: p95 de contenido visible y final, entrega por canal, disponibilidad, frescura y costo por conversación. Separar progreso SSE del primer texto visible. |
| ML | MLflow y servicio ML: F1 y recall offline, versión exacta, modo, predicciones, divergencias y alertas de drift. El F1 online requiere etiquetas revisadas. |
| DevOps | CI registra cobertura, lead time, tamaños, escaneos, resultados de Evals y smoke, digest y estado del despliegue. |

## Cambiar la configuración desde administración

1. Un editor autorizado prepara una revisión candidata. Cada prompt apunta a una versión fija de Langfuse. Los perfiles de generación solo muestran modelos de **OpenAI Direct** de la lista permitida. En la sección de clasificación, **Jev por OpenRouter** tiene su propio modelo, versión del esquema y métricas.
2. El editor prueba en staging. Registrar manifiesto, modelos, versión de preguntas de Jev, corpus, índice, código y suite de Evals usados. Visualizar diferencias y trazas anonimizadas.
3. Un publicador promueve el mismo manifiesto con gate aprobado. Una restauración elige una revisión aprobada anterior. Las ejecuciones en curso conservan su revisión. El backend revalida permisos y políticas al procesar acciones.
4. Guardar en auditoría actor, entorno, hash, revisión anterior, nueva revisión y resultado. Las APIs permiten consultar el estado de la publicación. Las credenciales de OpenAI, OpenRouter y Langfuse se inyectan como secretos del servicio.

**Roles.** Asesor atiende casos asignados. Supervisor recibe escalamiento. Editor propone cambios. Publicador puede activarlos. Admin operativo consulta agregados y las trazas permitidas. El permiso de publicación no permite registrar efectos del CRM de otros casos. [Versionado de prompts de Langfuse](https://langfuse.com/docs/prompt-management/features/prompt-version-control)

## Recorridos para evaluar la interfaz

1. **Asesor.** Recorrer las tres escenas de facturación y retención. Ver la ficha privada al abrir, recibir o tomar el caso, responder al cliente y comprobar cómo ese mensaje cambia los pendientes. La pantalla debe distinguir contexto de cliente, recomendación del agente y resultado del mock.
2. **Admin operativo.** Abrir una traza y explicar qué clasificó Jev, qué documentos recuperó y reordenó el sistema, qué modelo de OpenAI respondió y qué aportó ML en sombra. Contrastar uso, latencia y estado por etapa.
3. **Editor y publicador.** Preparar un cambio de prompt o perfil, revisar la candidata y comprobar que la publicación depende del gate de Evals. Una revisión aprobada debe poder rastrearse desde el dashboard a la configuración y a un run posterior.

Para implementar estos recorridos, la plataforma expone vistas agregadas y referencias de ejecución por rol. Las pruebas de integración comprobarán que las credenciales, la publicación y la ejecución de efectos se controlan en el servidor.
