# SDD de agente, conocimiento y LLMOps

**Responsabilidad.** Módulo TypeScript con LangGraph.js en el mismo proyecto NestJS que la plataforma. Un worker separado del proceso HTTP resuelve turnos con contexto, herramientas y evidencia. El agente puede recomendar o proponer. La [plataforma](../plataforma/diseno.md) posee el cliente vinculado, el caso y los efectos de negocio. El módulo empieza con stubs de herramientas CRM, facturación y ML.

[Arquitectura Docker](../02-arquitectura-docker.md) · [Guía de arranque](../01-arranque.md) · [Decisión de backend](../plataforma/diseno.md) · [DDD](../03-dominio.md) · [Contratos](../04-contratos.md) · [Playbook, prompts iniciales y Evals](atencion-prompts-y-evals.md) · [Inventario de fixtures](../05-insumos.md#evaluaciones)

## Ejecución en el backend

El worker NestJS consume el turno desde el outbox y publica eventos del run en PostgreSQL. Plataforma entrega al chat la respuesta pública autorizada o publica la ficha privada por SSE según el modo. El agente procesa los turnos de cliente y asesor del mismo hilo. Dentro del worker, el grafo invoca puertos TypeScript de dominio. Consulta ML por HTTP privado y usa adaptadores de OpenAI, Jev, MCP y telemetría. El checkpoint y la revisión activa quedan vinculados al run.

**Asistencia durante el diálogo.** Leer los turnos en orden y distinguir quién pidió algo, quién ya respondió y qué consulta quedó pendiente. Si el cliente pasa de facturación a cancelación, recuperar la política y evaluar elegibilidad. Si el asesor ya presentó la alternativa, actualizar el siguiente paso a esperar la decisión del cliente. Una actualización puramente contextual puede reutilizar hechos vigentes y autorizados. Si falta identidad, dejar la lectura pendiente hasta recibir `TitularVerificado`. Al tomar el caso, reconstruir la ficha con lo ya confirmado.

## Grafo y patrones agénticos

1. **Entrada y guardas.** Aceptar turno idempotente, comprobar ámbito y fijar `config_revision`. Derivar ante una condición prioritaria o una solicitud humana. Invocar clasificación clásica en sombra fuera de la espera del turno.
2. **Router de LangGraph.** Aplicar guardas y consultar Jev para clasificación tipada de intención y complejidad. El grafo resuelve la ruta permitida y los datos faltantes. Una pregunta pública usa el subgrafo de conocimiento. Una consulta de cuenta usa la herramienta tipada permitida. Una decisión comercial consulta las reglas de retención de plataforma. Pedir una aclaración concreta cuando cambie el próximo paso.
3. **Evolución de delegación selectiva.** Deep Agents recibiría un turno compuesto con el contexto mínimo. Invoca hasta tres subagentes de solo lectura, con un nivel de profundidad. **Soporte y conocimiento** contrasta síntomas y fuentes. **Facturación** verifica importes y períodos. **Retención** prepara alternativas según hechos y reglas. Devolver evidencia tipada y respetar límites de tiempo, pasos y herramientas por ruta.
4. **Supervisión humana.** Una acción requiere una propuesta tipada creada en la plataforma. Guardar checkpoint y pausar mediante `interrupt`. La plataforma ejecuta tras aprobación y reanuda con un resultado autorizado. Al reanudar, volver a evaluar el ámbito y usar la misma revisión del run.
5. **Salida verificable.** Validar hechos, citas, visibilidad y estado de efectos. Distinguir propuesta, pendiente y confirmado. La falta de evidencia produce aclaración, abstención o derivación. Publicar eventos con cursors para que plataforma entregue progreso y contenido validado. [Persistencia de LangGraph](https://docs.langchain.com/oss/python/langgraph/persistence) · [Deep Agents Subagents](https://docs.langchain.com/oss/python/deepagents/subagents)

## Decisiones tipadas y multi-LLM

**Jev de TypeSafe** se invoca mediante la API de decisiones de OpenRouter desde un nodo acotado de clasificación. Recibe texto saneado y señales mínimas. Devuelve etiquetas y scores tipados. El grafo verifica esquema, soporte de la etiqueta y reglas vigentes. Si Jev no responde o debe abstenerse, usar una regla aplicable, una aclaración o una derivación. El clasificador clásico conserva su rol en sombra.

La generación, el análisis de casos y los subagentes usan **OpenAI Responses API directamente**. Seleccionar perfiles por dificultad, calidad esperada, presupuesto y latencia. OpenRouter se usa solo para Jev. El lanzamiento fija modelos y límites en el manifiesto y registra ruta, proveedor, consumo y resultado en Langfuse. El cambio de modelo durante un turno respeta el presupuesto y el contexto autorizado. [Perfiles, límites y re-ranking](enrutamiento-y-reranking.md) · [TypeSafe en OpenRouter](https://openrouter.ai/typesafe) · [Modelos OpenAI](https://developers.openai.com/api/docs/models)

## Memoria y persistencia

| Capa | Qué se guarda | Criterio de acceso y vida útil |
| --- | --- | --- |
| **Checkpoints de LangGraph en PostgreSQL** | Estado mínimo de ejecución, IDs de evidencia y pausas de aprobación. | `thread_id` ligado a ámbito y conversación. Revalidar acceso al reanudar. El historial de conversaciones pertenece a plataforma. |
| **Redis de sesión** | Resumen saneado del caso y últimos turnos necesarios. | Clave por canal, conversación y ámbito. TTL inicial de 24 horas para la demo. Revocar al cambiar titular, rol o asignación. |
| **Redis de perfil autorizado** | Preferencias explícitas de idioma, accesibilidad o atención que se puedan reutilizar. | Solo para identidades vinculadas con autorización vigente. Guardar por sujeto opaco y tipo, con TTL inicial de 30 días, persistencia AOF y borrado al revocar. Se puede aislar en un Redis separado si la política de expulsión o recursos lo requiere. |

Los TTL son decisiones iniciales de demo. No mezclar memoria de perfiles con cachés anónimas ni usar mensajes como fuente de permisos. Guardar referencias y preferencias autorizadas, evitando PII y datos de cuenta en memoria. La pérdida de Redis reduce contexto y la sesión puede reconstruirse desde el mínimo permitido por plataforma. [Persistencia de Redis](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)

## RAG, re-ranking e ingesta

1. **Versionar fuentes.** La plataforma autoriza la carga y remite un manifiesto y referencia de archivo. `knowledge-worker` detecta cambios, deduplica por hash, extrae PDF, Word, tablas, EML, Markdown y TXT, y transcribe WAV. Usar OCR cuando aplique, enmascarar identificadores y publicar versiones listas de forma atómica. Conservar vigencia y ámbito público, interno o restringido.
2. **Filtrar antes de buscar.** PostgreSQL con pgvector y búsqueda de texto completo. Aplicar fecha de negocio, ámbito, estado, tipo, producto, canal cuando aplique y fuente vigente antes de recuperar candidatos léxicos y semánticos. Combinar rankings con RRF.
3. **Reordenar candidatos.** Enviar el conjunto acotado a `reranker`, un servicio privado en Node y ONNX Runtime para el cross-encoder `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1`. Comparar Recall@k, precisión o nDCG y p95 contra RRF. Si falla el reranker, conservar los resultados ya filtrados y marcar degradación. Validar recursos y rendimiento en la VPS.
4. **Controlar alucinaciones.** Entregar al modelo contexto mínimo, esquema de respuesta y referencias. Verificar correspondencia de citas con los fragmentos recuperados, vigencia y permisos. Validar cifras, fechas, acciones y estados contra hechos tipados. Si hay contradicción o evidencia insuficiente, aclarar o derivar. Publicar únicamente contenido visible y validado.
5. **Probar frescura y límites.** Subir v2 y medir carga → indexación. Probar fecha anterior y posterior a su entrada en vigor. Mantener separado el golden original de noviembre. Hacer accesibles en Telegram solo las fuentes o extractos aprobados como públicos. [Búsqueda híbrida en pgvector](https://github.com/pgvector/pgvector#hybrid-search) · [Ficha del reranker](https://huggingface.co/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1)

## Tools, prompts y Langfuse

**MCP de conocimiento** ofrece `search_public_kb` y `search_advisor_kb` en `knowledge-mcp` por Streamable HTTP privado. La plataforma expone puertos TypeScript de lectura, reglas y propuestas con ámbito verificado. Los subagentes reciben el mínimo de tools por perfil. Las skills de soporte, facturación y retención sirven como instrucciones revisadas y versionadas. La escritura externa queda en el servicio de comandos de plataforma.

Guardar el cuerpo de prompts en Langfuse con versiones fijas. La revisión publicada desde administración indica cuáles cargar. Trazar en Langfuse cada run, ruta, modelo, herramienta, retrieval, reranker, abstención, pausa y resultado. Añadir latencia, tokens, costo, versiones de prompt e índice y `prediction_id` cuando esté disponible. Enmascarar antes de exportar. Capturar motivos estructurados y evidencias, sin razonamiento privado.

**Gate de calidad.** Ejecutar 30 casos golden y 19 complementarios antes de publicar. Verificar herramientas, citas, ámbitos, permisos y efectos con reglas deterministas. Usar Jev como primer juez semántico fuera del camino crítico, después de las aserciones deterministas. Calibrar con etiquetas humanas y reportar abstenciones, cobertura y costo antes de activar el gate. Metas del reto ≥80 % exactitud, ≥0,85 groundedness y ≥0,90 recall@k donde aplique. Segmentar por ruta y aislar fallos de proveedores. Promover solo la revisión evaluada. [Diseño y evaluador Jev](jev-evals.md) · [Langfuse Evals](https://langfuse.com/docs/evaluation/overview)

## Inicio en paralelo y aceptación

1. Implementar puertos de runs y eventos persistidos, checkpoints de LangGraph.js y subgrafo E-202 sobre una fuente pública.
2. Añadir ingesta v2, búsqueda híbrida, reranker y verificación de citas.
3. Conectar stubs de plataforma y ML, autorización por ámbito, validación de herramientas y pausa/reanudación.
4. Conectar perfiles OpenAI Direct, Jev, trazas y Evals. Evaluar delegación de lectura con Deep Agents después del corte.

**Criterios.** El agente entrega automáticamente factura, oferta elegible o denegación en los [tres casos del hito](../06-calidad-y-release.md#tres-casos-de-la-demo). En atención asistida todas sus sugerencias se muestran en privado. Como regresión adicional, E-202 se responde con cita válida, un caso sensible se deriva, una propuesta queda suspendida sin POST externo, la reanudación conserva estado y muestra el efecto real, y una nueva fuente cambia la respuesta según fecha. Una ejecución compuesta muestra subagentes, modelos y herramientas en Langfuse. Medir primer contenido visible por separado de los eventos de progreso y reportar p95 contra el objetivo del reto.
