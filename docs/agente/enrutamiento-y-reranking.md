# Enrutamiento, clasificación y re-ranking del agente

El MVP usa **OpenAI Responses API directa** para generar, **Jev 1.14 de TypeSafe por OpenRouter** para clasificar y **un cross-encoder local** para reordenar evidencia de conocimiento. LangGraph combina estas señales con los permisos, las reglas de negocio y el presupuesto del turno. La plataforma sigue siendo responsable de aprobar y ejecutar acciones. El clasificador clásico publicado en MLflow conserva su modo sombra para comparar desempeño con etiquetas humanas.

El worker NestJS del agente tiene dos credenciales separadas de servidor. `OPENAI_API_KEY` corresponde al proyecto con créditos y se usa para generación y embeddings. `OPENROUTER_API_KEY` se usa exclusivamente en el adaptador de Jev y su consumo se factura en OpenRouter. Los modelos generativos, incluido el respaldo, usan la conexión directa con OpenAI. [SDD del agente](diseno.md) · [Contratos](../04-contratos.md) · [Jev en OpenRouter](https://openrouter.ai/docs/guides/community/jev)

## Qué decide cada componente

| Componente | Decisión |
| --- | --- |
| Reglas y estado de LangGraph | Aplican autorización, canal, prioridad de derivación, aprobación y capacidad disponible. También determinan qué ruta y modelos pueden usarse según la evidencia y el presupuesto. |
| Jev | Devuelve intención y complejidad como categorías con probabilidades. Es una llamada tipada; el grafo consume los valores y decide la transición permitida. |
| LLM directo de OpenAI | Redacta y sintetiza con evidencia, y puede resolver un objetivo compuesto usando herramientas de lectura previamente habilitadas. El esfuerzo de razonamiento se fija en el perfil de la ruta. |
| Reranker local | Reordena los pasajes autorizados para que el LLM reciba primero la evidencia más relevante. |
| ML clásico | Devuelve predicción de intención y versión de modelo en paralelo, fuera de la latencia visible. La predicción se compara con Jev y etiquetas revisadas. |

### Flujo por turno

1. LangGraph valida el ámbito, fija la revisión y aplica guardas de prioridad. Aplica la regla de derivación cuando corresponda. En atención humana mantiene activo el análisis del diálogo y dirige el resultado a la ficha privada del asesor.
2. Para un objetivo nuevo o ambiguo, manda a Jev el turno saneado y, si hace falta, un resumen mínimo del propósito reciente. Para una respuesta breve que completa una pregunta ya formulada, conserva el propósito registrado en el hilo. La inferencia clásica se despacha aparte.
3. El grafo toma la intención y complejidad como señales. Recupera fuentes vigentes, hechos de cuenta autorizados o ambas cosas. Si la señal está cerca del límite o falta un dato que cambia la ruta, formula una pregunta concreta. Los datos de un cliente se derivan de su vínculo validado por plataforma.
4. Selecciona el nivel de modelo con criterio determinista según cantidad de objetivos, dependencias, evidencia disponible y presupuesto. Ejecuta la síntesis y comprueba cifras, fechas, estado de acciones y citas. Envía al usuario solo la salida que supera estas comprobaciones.
5. Si el resultado propone un efecto, crea una propuesta interna y pausa el run. La aprobación de plataforma reanuda el estado registrado con el resultado real. [Playbook de atención, agentes y Evals](atencion-prompts-y-evals.md) · [Contratos de aprobación](../04-contratos.md#aprobación-y-efecto)

## Jev de TypeSafe por OpenRouter

Usar **`typesafe/jev-1.14`** mediante `POST https://openrouter.ai/api/alpha/decisions` con `Authorization: Bearer <OPENROUTER_API_KEY>`. El contrato nativo toma `state` y `questions` y devuelve `answers`. El endpoint es alpha. Encapsularlo en un adaptador, validar sus campos al recibirlos y ejecutar un smoke antes de promover. Fijar el ID de familia en el manifiesto y capturar el identificador efectivo devuelto por la API. [Referencia de Decisions](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request) · [Catálogo Jev 1.14](https://openrouter.ai/typesafe/jev-1.14)

Ejemplo de petición para un turno público. La plataforma ya depuró el texto y suministró el canal como contexto.

```json
{
  "model": "typesafe/jev-1.14",
  "state": {
    "mensaje": "En el televisor aparece E-202 y no veo ningún canal.",
    "canal": "telegram"
  },
  "questions": {
    "intencion": {
      "type": "choice",
      "instructions": "Clasifica el objetivo principal que el cliente expresa en el turno.",
      "criteria": {
        "soporte_tecnico": "Reporta una falla o pide un procedimiento técnico.",
        "facturacion": "Pregunta por un cobro, saldo, factura o pago.",
        "consulta_planes": "Consulta prestaciones, precios o promociones.",
        "cancelacion": "Pide terminar un servicio.",
        "portabilidad": "Pregunta por portar su número.",
        "fuera_de_alcance": "El propósito es claro y ajeno a la atención de Claro.",
        "indeterminada": "La información no permite distinguir el propósito."
      }
    },
    "complejidad": {
      "type": "choice",
      "instructions": "Determina cuántos objetivos y dependencias aparecen expresamente en el turno.",
      "criteria": {
        "simple": "Hay un objetivo puntual.",
        "intermedia": "Un objetivo exige varias verificaciones relacionadas.",
        "compuesta": "Hay objetivos de más de un dominio o una secuencia de decisiones dependientes.",
        "indeterminada": "Faltan datos para clasificar la complejidad."
      }
    }
  }
}
```

Leer `answers.intencion.choice` y `answers.complejidad.choice`. Conservar `probabilities`, `confidence`, el modelo efectivo, ID de la petición y `usage.cost` para la traza. `confidence` describe concentración de las opciones y se registra por separado de la probabilidad de la clase elegida. El adaptador valida tipos, etiquetas permitidas y probabilidades finitas dentro de [0, 1]. [Tutorial y ejemplo de respuesta](https://openrouter.ai/docs/guides/community/jev-tutorial) · [Primitiva Choice](https://docs.typesafe.ai/primitives/choice)

- **Regla inicial para staging.** Aceptar una intención de bajo riesgo cuando `p1 ≥ 0,75` y `p1 − p2 ≥ 0,20`. Si la clase es `indeterminada`, el margen no alcanza el mínimo o falta una respuesta, pedir una aclaración. Calibrar por clase con precisión, cobertura y ejemplos del piloto. Estos umbrales son hipótesis de partida.
- **Complejidad.** Usar la señal de Jev como indicio. Los dominios, herramientas requeridas y dependencias observadas en código prevalecen. Un resultado `simple` con hechos de facturación y una solicitud de cancelación entra al tratamiento compuesto.
- **Indisponibilidad.** Probar un plazo inicial de 800 ms para Jev. Ante timeout, `429`, cuota, rechazo de contrato o indisponibilidad, aplicar reglas conocidas. Si quedan varias rutas posibles, preguntar o derivar. Mantener activa la protección de identidad en todas las ramas.
- **Datos.** Enviar texto minimizado y saneado, sin recursos de CRM, expedientes, datos de cuenta, anexos ni trazas privadas. Los montos correspondientes a una cuenta se procesan en el ámbito autorizado de la plataforma. El clasificador devuelve categorías. Las reglas y los roles deciden los permisos para consultar o actuar.

## Escalera multi-LLM con OpenAI directo

Tarifas públicas **Standard** en USD por 1 millón de tokens de entrada sin caché y salida, consultadas el **21 de noviembre de 2026**. Validar disponibilidad y cuotas de cada modelo en el proyecto antes de promover. Son parámetros iniciales para staging; el costo por resolución y la calidad se verifican en Evals. [Catálogo de OpenAI](https://developers.openai.com/api/docs/models) · [Tarifas de OpenAI](https://developers.openai.com/api/docs/pricing)

| Perfil | Modelo y esfuerzo | Cuándo usarlo | Entrada / salida | Ejemplo de una llamada |
| --- | --- | --- | --- | --- |
| **Económico** | `gpt-6-luna`, `none` o `low` | FAQ, E-202 con evidencia vigente, instrucciones cortas, aclaración de lenguaje y resumen simple. Empezar por `none` cuando hay una respuesta directa y subir a `low` para síntesis breve. | $0,10 / $0,50 | $0,000325 |
| **Intermedio** | `gpt-6.1-terra`, `low` | Comparar dos o más hechos o fuentes compatibles. Puede explicar una diferencia de períodos, un procedimiento con condiciones o un cambio de versión sustentado. | $1,00 / $5,00 | $0,003250 |
| **Complejo** | `gpt-6.2-sol`, `low` o `medium` | Caso autorizado con múltiples dominios, varias dependencias o conflicto entre fuentes vigentes. `medium` se reserva a casos compuestos donde la evaluación muestre mejor resultado. Deep Agents se activa cuando hay subproblemas de lectura separables. | $2,00 / $10,00 | $0,006500 |
| **Referencia offline** | `gpt-6.2-astra`, `medium` | Comparación excepcional de Evals para saber si los fallos complejos se benefician de un modelo mayor. Su perfil se habilita en staging según presupuesto. | $8,00 / $40,00 | $0,026000 |

El ejemplo asume **2.000 tokens de entrada y 250 de salida facturable**, sin sumar otras llamadas. La salida incluye los tokens de razonamiento cuando el modelo los utiliza. Medir el costo con el uso devuelto por el proveedor y sumar búsqueda, embeddings, Jev, herramientas y reintentos de cada run. Jev figura a **USD 0,042 por millón de tokens de entrada y USD 0 de salida**. Una decisión de 500 tokens de entrada ronda USD 0,000021 en OpenRouter. [Razonamiento y tokens](https://developers.openai.com/api/docs/guides/reasoning) · [Tarifa de Jev](https://openrouter.ai/typesafe/jev-1.14)

### Reglas de selección y respaldo

- **Luna primero** para un objetivo con hechos claros y una secuencia corta. Seleccionar **Terra de entrada** cuando ya se sabe que hacen falta varias comprobaciones relacionadas. Seleccionar **Sol de entrada** en un caso compuesto que cumple los permisos y dispone de datos suficientes. Esto evita pagar una prueba con un modelo menor cuando la complejidad ya es observable.
- Si falta evidencia, ampliar una vez la recuperación autorizada o preguntar por el dato que falta. Si la evidencia es suficiente y la salida falla validación semántica, permitir una nueva síntesis con el siguiente perfil si queda tiempo y presupuesto. Corregir una ausencia de evidencia requiere recuperar o verificar una fuente.
- Un timeout, `429` o `5xx` previo a entregar contenido puede activar **un respaldo**. Luna puede respaldarse con Terra si la cuota y el presupuesto lo permiten. Terra puede subir a Sol. Sol puede degradar a Terra para una respuesta acotada cuando el estado se puede explicar con hechos ya verificados. Si falla OpenAI en todo el proyecto o se agota la cuota, comunicar el estado o derivar mediante plantilla. El perfil offline de Astra queda fuera del tráfico vivo.
- La repetición se limita a síntesis o lecturas idempotentes dentro del plazo del turno. Un efecto incierto permanece pendiente de reconciliación con el mismo identificador. Registrar todas las llamadas y el motivo de la selección, incluida una escalada por calidad, un respaldo o una degradación.
- En staging, iniciar con techo de **USD 0,02 de generación por turno en vivo**, **dos intentos de síntesis** y, en rutas compuestas, hasta **tres subagentes de lectura** dentro del mismo presupuesto. Estimar el consumo antes de cada llamada con el tamaño real de la entrada y el máximo de salida; si se agota el plazo o presupuesto, responder con hechos comprobados y señalar lo pendiente. Validar contra el p95 y el costo de la suite; los valores no son una tarifa garantizada.

## Recuperación y re-ranking

1. **Indexar pasajes citables.** Separar por sección, conservar filas de tarifas, títulos y localizador. Adjuntar `source_id`, `document_version`, producto, visibilidad, estado y fechas efectivas. Usar `text-embedding-3-small` de OpenAI para documentos y consultas. Fijar dimensión y revisión por índice. El precio publicado es USD 0,02 por millón de tokens de entrada. [Modelo de embeddings](https://developers.openai.com/api/docs/models/text-embedding-3-small) · [Guía de embeddings](https://developers.openai.com/api/docs/guides/embeddings)
2. **Filtrar antes de buscar.** Con los datos del caso, aplicar ámbito, fecha de negocio, estado y producto si está confirmado. Las respuestas automáticas al cliente en Telegram recuperan conocimiento público. Para la ficha interna de ese mismo hilo se aplica el ámbito vigente del asesor. Los hechos de CRM y facturación llegan como datos tipados desde herramientas autorizadas.
3. **Recuperar con dos señales.** Usar búsqueda de texto completo de PostgreSQL y similitud coseno de pgvector. Recuperar inicialmente **20 por señal**, fusionar con **RRF** en ranking de 1 a n y constante inicial **60**, y quitar duplicados por pasaje y versión. La búsqueda de texto aporta códigos como E-202. El embedding aporta similitud cuando cambian las palabras. Empezar con búsqueda vectorial exacta para este corpus de demo. Si crece, evaluar ANN con filtros y comparar cobertura. [Búsqueda híbrida en pgvector](https://github.com/pgvector/pgvector#hybrid-search)
4. **Reordenar localmente.** Puntuar hasta **16 candidatos** de la fusión con un cross-encoder de pares consulta-pasaje, `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1`, cargado en un worker de la VPS. Transformar títulos y pasajes a entradas acotadas. Considerar los **cinco mejores** y conservar diversidad de fuentes cuando la pregunta lo requiere. Fijar la revisión del artefacto. [Ficha del reranker](https://huggingface.co/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1)
5. **Controlar latencia y evidencia.** Probar un presupuesto inicial de **350 ms** para re-ranking. Si expira, volver al ranking filtrado de RRF y marcar `rerank_timeout`. El score del cross-encoder ordena pasajes. La decisión de si hay base suficiente usa revisiones de recuperación y validación de referencias; calibrar cualquier umbral de relevancia con pasajes etiquetados. Si faltan pasajes válidos, aclarar, abstenerse o derivar.
6. **Verificar antes de entregar.** Validar que las referencias citadas estén en el conjunto permitido y correspondan a la versión efectiva. Comprobar hechos sensibles como tarifas, fechas, estados o confirmación de acciones contra datos tipados. Ante contradicción, priorizar la fuente oficial vigente según la política de fuentes. Si la contradicción no se puede resolver, informar la incertidumbre y pasar el caso a asesor.

## Trazas, controles de administración y promoción

El panel debe exponer perfiles de modelo, esfuerzo permitido, límites, revisión de prompt, configuración de recuperación y Evals por candidata. Plataforma publica una revisión aprobada con ID inmutable. El span `decision.jev` en Langfuse asocia `run_id`, revisión, clase, probabilidades, motivo de aceptación o abstención, modelo efectivo, latencia y costo de OpenRouter. En la misma traza, las generaciones registran los modelos efectivos, motivos de selección, tokens y costo. Recuperación registra candidatos filtrados, latencia y degradación del re-ranking, citas y resultado final. Exponer costos y p95 agregados; guardar identificadores opacos y evitar guardar texto sensible de entrada en spans de decisión. [SDD de plataforma](../plataforma/diseno.md) · [Observabilidad y operación](../plataforma/observabilidad.md) · [Langfuse Evals](https://langfuse.com/docs/evaluation/overview)

| Verificación | Prueba antes de publicar |
| --- | --- |
| Clasificación | Medir F1 por clase, recall de cancelación y soporte, cobertura aceptada, margen y tasa de aclaración. Contrastar Jev, reglas y ML sombra con etiquetas humanas y cortes separados por familias de transcripción. |
| Multi-LLM | Comparar la misma suite con Luna fija, Terra o Sol por ruta y la escalera completa. Reportar éxito por ruta, costo por resolución y p50/p95 desde el turno hasta la salida visible. Forzar timeouts y probar presupuesto y comportamiento de respaldo con stubs. |
| Re-ranking | Evaluar RRF sin re-ranker y RRF con re-ranker sobre las mismas preguntas documentales. Reportar Recall@5 y nDCG@5, p95 de recuperación y cita correcta. Probar E-202, códigos y el mismo precio consultado con dos fechas de negocio a ambos lados del cambio a catálogo v2. |
| Autorización y groundedness | Verificar cero lecturas privadas con ámbito público, fuentes vigentes, cifras respaldadas y cero efectos externos sin aprobación. Mantener el conjunto de **30 golden** y **19 complementarias**, con exactitud ≥80 %, groundedness ≥0,85 y Recall@k ≥0,90 donde apliquen. |

Las decisiones de Jev en atención se trazan como `decision.jev`. Las Evals emplean un juez Jev con otra rúbrica y telemetría `eval.jev`. [Jev en Evals y otros procesos](jev-evals.md)

Los perfiles, tiempos y umbrales anteriores son una configuración inicial. Antes de publicar, confirmar con datos del proyecto y la VPS disponibilidad, costos observados, tiempos y calidad. [Enunciado y métricas del reto](../05-insumos.md#material-del-reto) · [Golden del reto](../05-insumos.md#evaluaciones) · [Fixtures complementarios](../05-insumos.md#evaluaciones)
