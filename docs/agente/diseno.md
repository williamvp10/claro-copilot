# SDD de agente, conocimiento y LLMOps

El [spec del próximo corte](../evolucion-mvp/comportamiento-del-agente.md) define la decisión por objetivos, el contexto confiable del turno y las pruebas de generalización sobre los tres subgrafos del demo.

[Propuesta de orquestador, subagentes, MCPs y prompts para el siguiente corte](../evolucion-mvp/agente-y-prompts.md) · [Catálogo JSON de arranque](../evolucion-mvp/prompts.claro-copiloto.json)

**Responsabilidad.** Módulo TypeScript con LangGraph.js en el mismo proyecto NestJS que la plataforma. Un worker separado del proceso HTTP resuelve turnos con contexto, herramientas y evidencia. El agente recomienda y propone. La [plataforma](../plataforma/diseno.md) posee el cliente vinculado, el caso y los efectos de negocio. Las lecturas autorizadas de CRM y Facturación usan MCPs privados sobre las APIs mock. FastAPI aporta señales de ML en sombra.

[Arquitectura Docker](../02-arquitectura-docker.md) · [Guía de arranque](../01-arranque.md) · [Decisión de backend](../plataforma/diseno.md) · [DDD](../03-dominio.md) · [Contratos](../04-contratos.md) · [Playbook, prompts iniciales y Evals](atencion-prompts-y-evals.md) · [Inventario de fixtures](../05-insumos.md#evaluaciones)

## Ejecución en el backend

El worker NestJS consume el turno desde el outbox y publica eventos del run en PostgreSQL. Plataforma entrega al chat la respuesta pública autorizada o publica la ficha privada por SSE según el modo. El agente procesa los turnos de cliente y asesor del mismo hilo. Dentro del worker, el grafo invoca puertos TypeScript de dominio. Consulta ML por HTTP privado y usa adaptadores de OpenAI, Jev, MCP y telemetría. El checkpoint y la revisión activa quedan vinculados al run.

**Asistencia durante el diálogo.** Leer los turnos en orden y distinguir quién pidió algo, quién ya respondió y qué consulta quedó pendiente. Si el cliente pasa de facturación a cancelación, recuperar la política y evaluar elegibilidad. Si el asesor ya presentó la alternativa, actualizar el siguiente paso a esperar la decisión del cliente. Una actualización puramente contextual puede reutilizar hechos vigentes y autorizados. Si falta identidad, dejar la lectura pendiente hasta recibir `TitularVerificado`. Al tomar el caso, reconstruir la ficha con lo ya confirmado.

## Grafo y patrones agénticos

1. **Entrada y guardas.** Aceptar turno idempotente, comprobar ámbito y fijar `config_revision`. Derivar ante una condición prioritaria o una solicitud humana. Invocar clasificación clásica en sombra fuera de la espera del turno.
2. **Router de LangGraph.** Aplicar guardas y determinar la intención y la complejidad con el contexto del caso. El grafo resuelve la ruta permitida y los datos faltantes. Una pregunta pública usa el subgrafo de conocimiento. Una consulta de cuenta usa la herramienta tipada permitida. Una decisión comercial consulta las reglas de retención de plataforma. Pedir una aclaración concreta cuando cambie el próximo paso.
3. **Delegación selectiva.** LangGraph.js elige entre **Soporte técnico**, **Facturación** y **Comercial y portabilidad**. Cada subgrafo recibe un contexto acotado y consulta las tools listas para su paso. En una consulta compuesta, el orquestador puede solicitar una lectura adicional de otro dominio dentro del mismo ámbito. El resultado vuelve como evidencia, estado y propuesta tipada. [Mapa de decisiones y herramientas](../evolucion-mvp/agente-y-prompts.md)
4. **Supervisión humana.** Una acción requiere una propuesta tipada creada en la plataforma. Guardar checkpoint y pausar mediante `interrupt`. La plataforma ejecuta tras aprobación y reanuda con un resultado autorizado. Al reanudar, volver a evaluar el ámbito y usar la misma revisión del run.
5. **Salida verificable.** Validar hechos, citas, visibilidad y estado de efectos. Distinguir propuesta, pendiente y confirmado. La falta de evidencia produce aclaración, abstención o derivación. Publicar eventos con cursor para que plataforma entregue progreso y contenido validado. [Subgrafos de LangGraph.js](https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs)

## Decisiones tipadas y multi-LLM

LangGraph determina el propósito con el turno, la memoria del caso y las reglas del dominio. Ante ambigüedad, pide una aclaración o deriva según la política. El clasificador clásico conserva su rol en sombra. Jev de TypeSafe actúa como juez de las evaluaciones.

La generación, el análisis de casos y los subagentes usan **OpenAI Responses API directamente**. Seleccionar perfiles por dificultad, calidad esperada, presupuesto y latencia. OpenRouter se usa solo para Jev. El lanzamiento fija modelos y límites en el manifiesto y registra ruta, proveedor, consumo y resultado en Langfuse. El cambio de modelo durante un turno respeta el presupuesto y el contexto autorizado. [Perfiles, límites y re-ranking](enrutamiento-y-reranking.md) · [TypeSafe en OpenRouter](https://openrouter.ai/typesafe) · [Modelos OpenAI](https://developers.openai.com/api/docs/models)

## Memoria y persistencia

El orquestador y los subagentes comparten el estado tipado del mismo caso. Incluye el historial conversacional autorizado del cliente, el asistente y el asesor, con orden, autor y citas. También incluye la ruta activa, el plan en consulta, la elección comercial, la verificación y las preguntas pendientes. Facturación y CRM aplican sus controles de titularidad al ejecutar cada lectura. Los datos de verificación quedan fuera del estado discursivo. Los proveedores externos reciben los datos previstos por cada paso y Langfuse registra el número y rango de turnos cargados.

| Capa | Qué se guarda | Criterio de acceso y vida útil |
| --- | --- | --- |
| **Caso en PostgreSQL** | Historial y estado de atención compartidos por el orquestador y los subagentes. | Cargar por caso y revisión vigente con alcance de plataforma. |
| **Checkpoints en PostgreSQL** | Resultado tipado de cada ejecución y reanudación. | Identificar por ejecución y efecto. Revalidar acceso antes de publicar un resultado reanudado. |
| **Redis de sesión** | Referencia de la última ejecución del agente. | Clave por conversación con TTL de 24 horas para el demo. |

Cada turno reconstruye su contexto desde PostgreSQL. La comparación comercial puede buscar preferencias expresadas al principio de la conversación dentro del mismo asunto. Un cambio de dominio delimita la búsqueda, para que una recomendación anterior no se arrastre a una consulta de cuenta.

## RAG, re-ranking e ingesta

1. **Versionar fuentes.** La plataforma autoriza la carga y remite un manifiesto y referencia de archivo. `knowledge-worker` detecta cambios, deduplica por hash, extrae PDF, Word, tablas, EML, Markdown y TXT, y transcribe WAV. Usar OCR cuando aplique, enmascarar identificadores y publicar versiones listas de forma atómica. Conservar vigencia y ámbito público, interno o restringido.
2. **Filtrar antes de buscar.** PostgreSQL con pgvector y búsqueda de texto completo. Aplicar fecha de negocio, ámbito, estado, tipo, producto, canal cuando aplique y fuente vigente antes de recuperar candidatos léxicos y semánticos. Combinar rankings con RRF.
3. **Reordenar candidatos.** Enviar el conjunto acotado a `reranker`, un servicio privado en Node y ONNX Runtime para el cross-encoder `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1`. Comparar Recall@k, precisión o nDCG y p95 contra RRF. Si falla el reranker, conservar los resultados ya filtrados y marcar degradación. Validar recursos y rendimiento en la VPS.
4. **Controlar alucinaciones.** Entregar al modelo contexto mínimo, esquema de respuesta y referencias. Verificar correspondencia de citas con los fragmentos recuperados, vigencia y permisos. Validar cifras, fechas, acciones y estados contra hechos tipados. Si hay contradicción o evidencia insuficiente, aclarar o derivar. Publicar únicamente contenido visible y validado.
5. **Probar frescura y límites.** Subir v2 y medir carga → indexación. Probar fecha anterior y posterior a su entrada en vigor. Mantener separado el golden original de noviembre. Hacer accesibles en Telegram solo las fuentes o extractos aprobados como públicos. [Búsqueda híbrida en pgvector](https://github.com/pgvector/pgvector#hybrid-search) · [Ficha del reranker](https://huggingface.co/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1)

## Tools, prompts y Langfuse

**MCP de conocimiento** ofrece `search_knowledge` mediante `knowledge-mcp` por Streamable HTTP privado, con filtros por audiencia y vigencia. `crm-mcp` expone lecturas de contexto, servicios, tickets y elegibilidad. `billing-mcp` expone saldo, listado y detalle de factura. Los subagentes reciben herramientas acotadas al objetivo, al paso y al caso. La escritura externa queda en el servicio de comandos de plataforma. [Matriz de herramientas](../evolucion-mvp/agente-y-prompts.md#mcps-herramientas-y-autorización)

Usar el catálogo JSON para el arranque y Langfuse para editar y versionar las plantillas. La revisión publicada desde administración fija el nombre, versión y hash de los prompts que carga cada turno. Trazar en Langfuse cada run, ruta, modelo, herramienta, retrieval, reranker, abstención, pausa y resultado. Añadir latencia, tokens, costo, versiones de prompt e índice y `prediction_id` cuando esté disponible. Enmascarar antes de exportar. Capturar motivos estructurados y evidencias, sin razonamiento privado.

**Gate de calidad.** Ejecutar 30 casos golden y 19 complementarios antes de publicar. Verificar herramientas, citas, ámbitos, permisos y efectos con reglas deterministas. Usar Jev como primer juez semántico fuera del camino crítico, después de las aserciones deterministas. Calibrar con etiquetas humanas y reportar abstenciones, cobertura y costo antes de activar el gate. Metas del reto ≥80 % exactitud, ≥0,85 groundedness y ≥0,90 recall@k donde aplique. Segmentar por ruta y aislar fallos de proveedores. Promover solo la revisión evaluada. [Diseño y evaluador Jev](jev-evals.md) · [Langfuse Evals](https://langfuse.com/docs/evaluation/overview)

## Inicio en paralelo y aceptación

1. Implementar puertos de runs y eventos persistidos, checkpoints de LangGraph.js y subgrafo E-202 sobre una fuente pública.
2. Añadir ingesta v2, búsqueda híbrida, reranker y verificación de citas.
3. Verificar los clientes MCP, la autorización por ámbito y la continuidad ante fallos de la inferencia en sombra.
4. Comprobar ejecución con OpenAI Direct y Jev, trazas en Langfuse y el gate A/B por revisión efectiva.

**Criterios.** El agente entrega automáticamente factura, oferta elegible o denegación en los [tres casos del hito](../06-calidad-y-release.md#tres-casos-de-la-demo). En atención asistida todas sus sugerencias se muestran en privado. Como regresión adicional, E-202 se responde con cita válida, un caso sensible se deriva, una propuesta queda suspendida sin POST externo, la reanudación conserva estado y muestra el efecto real, y una nueva fuente cambia la respuesta según fecha. Una ejecución compuesta muestra subagentes, modelos y herramientas en Langfuse. Medir primer contenido visible por separado de los eventos de progreso y reportar p95 contra el objetivo del reto.
