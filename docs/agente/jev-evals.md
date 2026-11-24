# Jev en las Evals y decisiones de Claro Copiloto

**Jev 1.14 de TypeSafe será el primer juez semántico de las Evals del MVP.** El runner verifica primero lo que puede comprobar con código. Jev clasifica el significado cuando hace falta interpretar lenguaje. El agente sigue generando respuestas por OpenAI Direct. Ambos usos de Jev, decisión durante la atención y evaluación posterior, tienen rúbricas, telemetría y criterios de promoción independientes.

[Enrutamiento del agente](enrutamiento-y-reranking.md) · [Playbook y Evals](atencion-prompts-y-evals.md)

## Ejecución actual y conexión con Langfuse

En **Administración → Prompts y evaluaciones → Ejecutar evals**, la API encola la comparación. `eval-worker.mjs` carga las 30 preguntas golden y los 19 escenarios complementarios, y `compare-prompts.mjs` ejecuta ambas revisiones. El informe y el estado del gate se guardan en PostgreSQL. El perfil `local` aplica los checks de código. El perfil `live` requiere `OPENAI_API_KEY` y `OPENROUTER_API_KEY`, usa `JEV_MODEL` para el juez y exporta trazas si hay un destino Langfuse configurado. [Worker](../../apps/backend/scripts/eval-worker.mjs) · [Runner A/B](../../apps/backend/scripts/compare-prompts.mjs)

El adaptador actual de Jev evalúa señales saneadas donde las fuentes y el turno son elegibles. El saneamiento elimina cifras e identificadores. Un veredicto favorable queda como señal para revisión. Importes, vigencia, permisos y efectos se comprueban con código y con recibos del replay de plataforma. [Adaptador semántico](../../packages/agent/src/providers.ts)

Para llevar la comparación a **Experiments** de Langfuse, conservar el replay de LangGraph en el worker y publicar un experimento por revisión, con IDs de caso y turno, versión de corpus, rúbrica y scores vinculados. Un experimento vía SDK puede usar un dataset local. El SDK envía a Langfuse los campos del experimento, por lo que el adaptador debe proyectar solo los datos autorizados. [Experimentos vía SDK](https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk)

El demo local ejecuta **Jev · Llamadas v1** como evaluador nativo de decisión de Langfuse. La conexión **Jev OpenRouter** usa TypeSafe y el modelo `typesafe/jev-1.14`. El evaluador puntúa contenido requerido y afirmaciones prohibidas en el dataset sintético `claro-llamadas-v1`. Langfuse guarda ambos scores por caso y Administración consulta esos resultados. [Ejecutar desde la interfaz](../08-demo-local.md#ejecutar-el-juez-desde-langfuse) · [Evaluadores de modelos de decisión](https://langfuse.com/docs/evaluation/evaluation-methods/decision-models)

La comparación de revisiones conserva el informe y la evidencia de plataforma. Cualquier uso de los scores nativos como gate requiere medir primero su concordancia con revisores humanos.

Para el ajuste de prompts y subagentes, el [protocolo del próximo corte](../evolucion-mvp/comportamiento-del-agente.md#evaluación-del-agente-en-langfuse) establece cómo obtener las corridas nativas de base y candidata, comparar los 15 casos y completar la evidencia con pruebas de atención asistida.

## Dónde incluir Jev en el agente

| Punto | Uso de Jev | Qué conserva el flujo en código |
| --- | --- | --- |
| **Entrada de un objetivo nuevo o ambiguo** | Clasificar intención y complejidad como categorías tipadas. Una sola llamada puede contestar ambas preguntas. | Prioridad de escalamiento, ámbito, permisos, continuidad del caso y selección final del modelo de OpenAI. |
| **Cambio de asunto** | Detectar si el turno cambia el objetivo cuando el contexto y las reglas sencillas dejan dudas. Validar este uso después del routing inicial. | Estado de la conversación y transición permitida. Una respuesta breve que completa una aclaración conserva el propósito activo. |
| **Selección de subgrafo** | Señalar si hay uno o varios dominios. Una señal ambigua conduce a aclaración o revisión. | Determinar qué herramientas son admisibles y si procede delegación a Deep Agents. Nunca ejecutar una escritura por una clase devuelta por Jev. |
| **Revisión de respuesta en vivo** | Candidato para casos acotados que ya pasaron validación de citas. Probar primero fuera del camino crítico y añadirlo solo si reduce fallas justificando la latencia. | Filtros de acceso y vigencia, citas existentes, concordancia con hechos tipados, acciones confirmadas y fallback seguro. |

El cross-encoder local se queda como reranker. Jev puede etiquetar relevancia de pasajes en muestras de evaluación y enviar los casos ambiguos a revisión. La identidad y la elegibilidad provienen de plataforma. El clasificador clásico permanece en sombra y su señal se compara con Jev y etiquetas revisadas. [Catálogo y precio de Jev 1.14](https://openrouter.ai/typesafe/jev-1.14)

## Evals antes del despliegue

1. **Correr el caso con fecha fija y mocks.** Capturar respuesta, evidencias realmente recuperadas, herramientas, argumentos, subagentes y efectos externos. Guardar revisión del agente, índice y archivo de fixtures.
2. **Ejecutar aserciones deterministas.** Validar ruta, herramientas, argumentos, permisos, privacidad, aprobación, idempotencia y estado real. Una cita debe estar en el conjunto recuperado y ser visible y vigente. Comparar importes, plazos y códigos cuando estén normalizados. Ante un fallo crítico, registrar y bloquear promoción.
3. **Usar Jev para la parte semántica.** Enviar una llamada por paso con rúbrica aplicable. Agrupar las decisiones sobre hechos requeridos, afirmaciones prohibidas y evidencia. La entrada es el enunciado saneado, la respuesta observada y extractos limitados. Excluir herramientas, trazas crudas y datos de cuenta.
4. **Adjudicar casos dudosos.** Si Jev devuelve una clase ambigua, puntuaciones bajas, respuesta inconsistente o error de proveedor, marcar revisión o error. Conservar la disponibilidad y la cobertura por separado. Un paso sin rúbrica semántica no requiere llamada.
5. **Publicar resultados.** El informe actual guarda los veredictos y la telemetría disponible. Vincular los scores a experimentos es la integración propuesta con Langfuse. CI registra resultados y exige gates. Antes de usar el juez automático como criterio de release, medir concordancia con revisores humanos. [Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request) · [Choice de TypeSafe](https://docs.typesafe.ai/primitives/choice) · [Evals en Langfuse](https://langfuse.com/docs/evaluation/overview)

| Rúbrica | Salida de Jev | Ejemplo |
| --- | --- | --- |
| Hecho requerido | `presente`, `ausente`, `contradicho`, `ambiguo` | E-202 explica dónde refrescar señal y cuánto esperar, aunque use una paráfrasis. |
| Afirmación prohibida | `afirmada`, `no_afirmada`, `ambigua` | «La visita quedó agendada» falla si la API únicamente confirmó un ticket y la respuesta afirma una cita efectiva. |
| Respaldo con evidencia | `respaldada`, `no_respaldada`, `evidencia_insuficiente` | La explicación de la factura se apoya en extractos verificables. Una cita correcta puede acompañar una afirmación que el extracto no sustenta. |

El resultado semántico del paso pasa cuando todos sus criterios aplicables pasan. Una violación clara falla. Una salida incierta queda en revisión. La rúbrica de respaldo mide la respuesta contra la evidencia suministrada. La **exactitud del caso** reagrupa sus pasos e incluye los checks de código aplicables. Registrar por separado groundedness, cobertura semántica, decisiones pendientes y errores. El evaluador semántico emite su resultado para que CI lo combine con las aserciones deterministas.

**GQ-28 y CC-E13.** El código observa cero POST antes de aprobar y un solo ticket prioritario después. Jev distingue semánticamente «ticket registrado» de «visita agendada». Son dos capas del mismo caso. [Golden original](../05-insumos.md#evaluaciones) · [Suite complementaria](../05-insumos.md#evaluaciones)

## Calibración y costo

- **Conjunto humano independiente.** Dos revisores califican una muestra equilibrada de respuestas correctas, paráfrasis, parciales, contradictorias y no respaldadas. Dejar fuera del ajuste un conjunto con otras familias. Comparar precisión/recall de fallas, falsos aprobados, matriz de confusión, cobertura y costo. Un juez que coincide con Jev en el routing puede compartir el mismo error, por eso la intención se valida con etiqueta humana y el score se compara con baseline.
- **Umbrales iniciales.** La configuración inicial usa una probabilidad mínima de **0,75** para la opción elegida y margen **0,20** sobre la segunda opción como punto de partida. Se trata de señales de abstención, no de garantías de calibración. Definir el criterio final por rúbrica después de revisar falsos aprobados y tasas de revisión.
- **Cascada para reducir gasto.** Verificar por código primero, juntar preguntas del mismo paso, limitar evidencia y reutilizar resultados idénticos con clave de modelo efectivo, rúbrica y hashes de entrada. Reservar revisión humana para discrepancias, casos críticos y muestreo. Un juez LLM de OpenAI puede usarse como referencia en una muestra de calibración. Mantenerlo fuera del gate ordinario.
- **Estimación de orden de magnitud.** Hay 30 preguntas golden con puntos clave y 21 de 24 pasos complementarios con hechos requeridos o prohibidos. Si se hacen 51 llamadas de 1.000 tokens de entrada cada una, a USD 0,042/M cuesta aproximadamente **USD 0,00214** en Jev. Es una hipótesis de volumen que excluye generación original, etiquetado, almacenamiento, reintentos e impuestos. El dato para reportar es `usage.cost` medido en OpenRouter. [Precio publicado](https://openrouter.ai/typesafe/jev-1.14)

En Langfuse, diferenciar `decision.jev` para ruta operativa de `eval.jev` para evaluación. Asociar `dataset_version`, `rubric_version`, `case_id`, paso, revisión de agente, modelo efectivo y estado. Almacenar scores de hechos, groundedness, revisión, cobertura y costo. **Comparar candidatos sobre el mismo juez y rúbrica.** Un cambio de juez requiere recalibración o evaluar ambos candidatos en paralelo con el mismo esquema.

## Usos de Jev fuera del agente

| Área | Uso propuesto | Momento y control |
| --- | --- | --- |
| **Control de calidad** | Muestrear respuestas y clasificar fallos en recuperación, cita, dato incorrecto, permiso, herramienta o comunicación. | Lote post-atención. Revisar señales y agrupar en el dashboard. El estado oficial del caso viene de eventos. |
| **Curación de dataset** | Sugerir etiqueta de intención, clases confusas y ejemplos que merecen revisión para ML clásico o Evals. | Semanal o previo a reentrenar. Guardar etiqueta sugerida, versión y decisión humana aparte. Excluir del test principal etiquetas solo propuestas por Jev. |
| **Ingesta y búsqueda** | Sugerir producto, tema o tipo de documento. Evaluar si un pasaje trata el motivo de consulta para construir etiquetas de re-ranking. | Lote de ingesta o evaluación. Visibilidad, vigencia y publicación requieren metadatos verificados y control del gestor. |
| **Operación post-atención** | Etiquetar motivo de recontacto, pendiente o categoría de escalamiento para revisar muestras. | Asíncrono, con datos minimizados. CSAT y resolución salen de votos, hechos verificados y estados del caso. |

**Orden de entrega.** Activar primero Jev en routing como ya está diseñado y en Evals offline de hechos, afirmaciones prohibidas y respaldo. Medir costo, tasa de revisión y falsos aprobados. El etiquetado offline de fallos y curación de datasets son siguientes incorporaciones. Evaluar cualquier llamada adicional en vivo contra impacto en p95 y cobertura.

## Contrato de implementación del evaluador

El runner prepara por caso y paso una observación con `question`, `answer` y `evidence` cuando corresponda. Lee `required_facts` y `forbidden_facts` de la suite complementaria o `puntos_clave` del golden. El modo plan valida el caso y la rúbrica localmente. Para evaluar con OpenRouter, usar una credencial de servidor y una observación saneada y apta para compartirse.

Ejemplo de observación de E-202, compatible con CC-E01 y GQ-21.

```json
{
  "question": "El televisor muestra E-202. ¿Qué hago?",
  "answer": "En Mi Claro, abre Mi TV y usa Refrescar señal. Deja el decodificador encendido hasta 15 minutos.",
  "evidence": ["FAQ: refresque la señal en Mi Claro, Mi TV > Refrescar señal, y espere hasta 15 minutos con el decodificador encendido."]
}
```

La salida distingue `pass`, `fail`, `review`, `error` y `not_applicable`. El informe fija la rúbrica, conserva las decisiones y guarda la latencia del paso y el costo de generación cuando están disponibles. La instrumentación del juez y la publicación de scores por paso completan la integración propuesta. [Gate de calidad](../06-calidad-y-release.md#promoción-de-develop-a-main)
