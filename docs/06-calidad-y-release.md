# Calidad, CI y release del MVP

Promover un candidato con evidencia reproducible. El manifiesto vincula el código, digests de imágenes, revisión de agente, modelo y prompts, corpus, índice, reranker, versión de ML, políticas y suite evaluada. Cada ejecución de pruebas en local y CI usa una revisión fija.

[Arquitectura Docker](02-arquitectura-docker.md) · [Insumos y suites](05-insumos.md#evaluaciones) · [Evals con Jev](agente/jev-evals.md) · [Observabilidad](plataforma/observabilidad.md)

## Promoción de develop a main

| Etapa | Verificación y resultado esperado |
| --- | --- |
| **PR a `develop`** | Lint y tipos, unitarias de dominio, contrato OpenAPI y MCP, permisos, idempotencia, smoke de RAG y replay de casos con stubs. |
| **Candidato desde `develop`** | Construir y escanear imágenes, registrar digests, validar migraciones y ejecutar el candidato en un ambiente local o en CI. Probar sesión, webhook, SSE, disponibilidad del worker, RAG versionado y API de predicción. |
| **PR de `develop` a `main`** | Correr golden y complementarios sobre el candidato exacto. Los fallos de autorización, visibilidad y efectos bloquean. Revisar el reporte semántico, la cobertura, las abstenciones y el manifiesto. |
| **Primer despliegue en Dokploy** | Promover los digests y la revisión ya evaluados. Ejecutar smoke tras el cambio. Ante fallo, restaurar el manifiesto anterior con migraciones compatibles y comprobar recuperación. |

Mantener separadas las credenciales por ambiente. Un nuevo commit que cambie la composición del candidato requiere otro build y otra evaluación. Registrar en CI el manifiesto, las Evals, el resultado del smoke y el release. [Checks de ramas protegidas](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)

## Qué comprobar en las Evals

1. **Código.** Comprobar rutas, argumentos, permisos, citas vigentes, efecto aprobado, idempotencia y estado real. `CC-E13` exige cero escrituras antes de aprobar y un ticket prioritario después.
2. **Jev.** Agrupar preguntas por paso para evaluar hechos requeridos, afirmaciones prohibidas y respaldo con evidencia. Calibrar con etiquetas humanas. Registrar el costo, la cobertura y los casos que quedan en revisión. Comparar candidatas con juez y rúbrica fijos.
3. **ML.** Mostrar inferencia en sombra, versión, evaluación agrupada y alerta de drift demostrable. El gate de F1 aplica al uso futuro de la predicción en el enrutamiento. Mantener el modo sombra mientras falte validación.
4. **Frescura y fallas.** Validar catálogo v1 y v2 con el reloj de negocio controlado, reinicio de worker con reanudación, rechazo de aprobación inválida y continuidad de atención ante timeout de ML.

## Métricas de aceptación

| Área | Indicadores de inicio |
| --- | --- |
| Negocio y atención | AHT, FCR, escalamiento N2, retención y CSAT. Medir mejoras contra una línea base comparable y mostrar tamaño de muestra. Distinguir resultados sintéticos y piloto. |
| LLM y RAG | Exactitud golden ≥80 %, groundedness ≥0,85 y Recall@k ≥0,90 donde aplique. Mostrar citas válidas, abstenciones y frescura de la fuente. |
| Agentes y control | Éxito por tarea ≥90 %, error de herramientas ≤3 % y cero efectos sin aprobación. Medir reintentos, derivados, pausas y bucles. |
| Técnica | Disponibilidad ≥99 %, primer contenido visible web p95 ≤2 s, respuesta completa p95 ≤8 s y frescura documental ≤15 min. Reportar costo por conversación y errores por proveedor. |
| ML | F1 macro, recall por clase, matriz de confusión, versión, cobertura y drift. Meta F1 ≥0,80 para evaluar activación tras validar generalización. |
| Asistencia proactiva | Medir desde el turno que expresa la necesidad hasta que el recurso correcto se muestra en la consola. Reportar también la espera de verificación de titularidad. Medir casos asistidos con el recurso correcto visible antes de la primera búsqueda manual (o antes de responder si no hubo búsqueda), sobre casos asistidos que requerían ese recurso. Validar su pertinencia con el resultado esperado o revisión del asesor. |
| DevOps | Cobertura ≥70 %, lead time <30 min, cero vulnerabilidades críticas, tamaños de imagen y smoke del release. |

Estas son metas de aceptación, con origen en el reto o sus criterios de operación. El tablero muestra intervalo, canal, entorno, denominador y versión. El tiempo de espera de una aprobación humana se reporta por separado.

## Tres casos de la demo

Preparar los fixtures oficiales al 18 de noviembre de 2026, dos vistas (cliente en Telegram y asesor en Next.js) y chats de prueba ya habilitados. Configurar la ruta de entrada del chat público para C-1001 y la asignación directa del chat de C-1007 antes del primer mensaje. Para C-1004, iniciar un **caso nuevo** desde la consola sobre el contacto de prueba. Estas asociaciones determinan el destino del chat. La titularidad se verifica en el caso antes de consultar la cuenta.

| Caso y origen | Conversación y respuesta esperada | Evidencia de aceptación |
| --- | --- | --- |
| **C-1001 · Facturación** (GQ-25). Cliente entra por el bot. | Empezar con una duda pública sobre Fibra 500 y abrir la cita del catálogo vigente. Al preguntar por su factura pasa al asesor con hilo, motivo y consulta pendiente. Tras validar titularidad, la ficha muestra Hogar Fibra 500 ($109.900), Claro Max 60 GB ($59.415) y factura de noviembre pendiente por $169.315, con vencimiento el 25 de noviembre. | Observar la respuesta pública y luego la ficha privada por SSE con lecturas de CRM y facturación. El asesor responde desde el mismo caso. Verificar cero lecturas de cuenta antes de la validación y cero respuestas públicas automáticas después de tomarlo. |
| **C-1004 · Retención elegible** (GQ-26). Asesor inicia el chat. | Guardar el saludo saliente y la respuesta «quiero cancelar». Con titularidad verificada, mostrar política citada, 30 meses de antigüedad, cero mora y cero ofertas en los últimos 12 meses. Alternativas: 30 % sobre $89.900 por seis meses o mejora a Fibra 500 sin costo por seis meses. | Comprobar que una respuesta del asesor actualiza el pendiente de la ficha. Tras aceptación del cliente y aprobación en consola, verificar una sola llamada efectiva de registro en CRM y su referencia. Repetir la aprobación y recargar el caso. El CRM conserva un único registro. |
| **C-1007 · Retención denegada** (GQ-27). Cliente escribe directamente al asesor asignado. | El cliente pide cancelar y solicita un descuento. Al verificarse la titularidad, el agente lee CRM, cita la política y muestra en privado 45 días de mora frente al límite de 30. Sugiere continuar el trámite de cancelación. | Mostrar el motivo en la consola, la respuesta enviada por el asesor y cero ofertas registradas. Al cierre quedan intención, resumen y trámite pendiente. |

**Prueba transversal.** Ejecutar las escenas sin consultas manuales al copiloto. Verificar que mensajes de ambos actores quedan ordenados tras recargar, que el cambio de modo conserva el resumen y que una ficha privada jamás entra en la cola de Telegram. Forzar una respuesta pública tardía tras la toma del caso y un resultado privado atrasado tras un turno más reciente. Comprobar que se descartan y que la ficha actual permanece visible.

## Evidencia complementaria para la sustentación

- Copiar el catálogo v2 a la fuente vigilada, medir frescura y consultar a ambos lados de su entrada en vigor.
- Mostrar una inferencia en sombra con su versión de MLflow y una alerta de drift identificada como simulada.
- Abrir la traza de un caso y la ejecución del pipeline para el mismo release. Presentar las 30 preguntas oficiales, con resultados individuales para las cuatro con herramientas (GQ-25 a GQ-28), y las 19 complementarias. Las tres escenas anteriores añaden verificaciones de interfaz y efectos a las respuestas esperadas del golden.
- Para la entrega local, guardar el plan de Terraform por ambiente, el arranque con Compose y el smoke de la aplicación. Vincular las evidencias al commit y al manifiesto evaluado.
