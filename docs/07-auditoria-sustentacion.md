# Evidencia de sustentación

La matriz contrasta el reto técnico y la presentación de quince láminas con la aplicación. El insumo original contiene datos ficticios, incluyendo los archivos de CRM y facturación. Los gráficos de la consola leen la actividad de la aplicación y los informes de evaluación. Cualquier dato con muestra insuficiente conserva el estado «Sin muestra».

| Lámina | Compromiso | Evidencia y condición de cierre |
| --- | --- | --- |
| 1 | Asistencia para atención y retención | El asesor conversa en la consola y recibe la ficha privada. Probar el caso de principio a fin en el entorno presentado. |
| 2 | Autoservicio y atención asistida en web y Telegram | El OTP y las transferencias se probaron por HTTP, SSE y webhook. El envío con el bot requiere token, chats autorizados y webhook HTTPS operativo. |
| 3 | Evidencia junto al caso | La ficha, las citas y las pestañas de CRM y Facturación se verifican con un caso asignado y cuenta verificada. |
| 4 | Compose, persistencia y predicción | Completar el smoke con API, worker, redis, pgvector, Express, MCP y ML. La vista previa nativa tiene alcance separado del despliegue en Compose. |
| 5 | Catálogo vigente y RAG | Publicar ambos catálogos con manifiesto. Comprobar vigencia en 2026-11-30 y 2026-12-01 y conservación del histórico. La extracción automatizada revisada cubre texto de PDF, DOCX, Markdown y correo. OCR y el cross-encoder independiente siguen como brechas técnicas. |
| 6 | Retención elegible y denegada | C-1004 registra un solo efecto después de la aprobación. C-1007 conserva cero ofertas. |
| 7 | Registro de MLflow e inferencia en sombra | Abrir el run, contrastar versión y checksum del artefacto y observar las predicciones en el panel. El desempeño del modelo original está bajo la meta de activación. |
| 8 | TDD, EDD y comparación A/B | Ejecutar 30 golden y 19 complementarios. Asociar los replays de plataforma a los casos críticos. La promoción exige evidencia aprobada. |
| 9 | Entrega por digest y recuperación | Conservar el run de CI, el informe, el digest, el smoke y la referencia disponible para recuperación. La publicación de una imagen candidata no cambia el entorno por sí sola. |
| 10 | Canales y ejecución en AWS | Arquitectura objetivo. La evidencia de la demo demuestra los contratos y eventos equivalentes en Compose. |
| 11 | Datos y modelos en AWS | Arquitectura objetivo. La demo muestra PostgreSQL y MLflow autohospedados. |
| 12 | Capacidad de 10.000 asesores | Dimensionamiento ilustrativo. Requiere prueba de carga y medición de reconexiones SSE, picos y latencia. |
| 13 | Controles ante fallos | Validar una caída de dependencia, que el caso siga operativo y que el resultado figure en la traza. Alertas de AWS corresponden a la arquitectura objetivo. |
| 14 | Tablero y métricas | Mostrar series y denominadores medidos, comparativo A/B, ejecución de ML, error de herramientas y tiempos de atención. Los objetivos de AHT, FCR, escalamiento y retención requieren piloto con línea base. |
| 15 | Roadmap | CRM corporativo, voz, WhatsApp y despliegue multipaís son hitos posteriores a la sustentación. |

Para cada corte registrar en conjunto commit, digests, ambiente, checksum del corpus, versión activa/candidata, hash de la suite, run de MLflow y los `run_id` de los casos mostrados en Langfuse. Registrar por separado métricas pendientes del reto que requieren población, instrumentación o un entorno adicional, como primer token, frescura en operación, feedback del asesor, audio y cobertura global.

## Evidencia base

| Verificación | Resultado de referencia |
| --- | --- |
| C-1001, C-1004, C-1007, E-202 y CC-E13 | Replays locales con PostgreSQL y contratos oficiales. |
| Gate RAG anterior | 14/30 coincidencias, Recall@5 de 0,920, groundedness de 0,783 activo y 0,739 candidato. 12 escenarios críticos por adjudicar. |
| ML original | F1 macro de 0,563 y recall de cancelación de 0,340 en evaluación agrupada. |

[Gate y resultados](06-calidad-y-release.md) · [Operación del corte](../infra/README.md)

## Corrida local de cierre

- Se publicó primero el paquete inicial y luego el actualizado. El segundo contiene 90 pasajes de los insumos, incluidos 49 extractos elegibles para procesamiento externo. El mismo manifiesto aplicado por segunda vez conservó el estado. La búsqueda devolvió el catálogo v1 el 30 de noviembre y v2 el 1 de diciembre.
- El modelo se reentrenó con `tickets.csv` en el registro local, que asignó la versión 1 a este run. Se comprobó la misma versión en MLflow, FastAPI y el tablero al procesar un turno. F1 macro agrupado 0,563 y recall de cancelación 0,340.
- La evaluación local completó las 98 verificaciones A/B sobre los 49 casos. La comparación conectada repitió la suite cuya autorización y hashes se comprobaron. Ambos prompts obtuvieron 14/30 de coincidencia, Recall@5 de 0,920 y 12 casos críticos pendientes. Fidelidad de 0,783 para la base y 0,826 para la candidata. El gate quedó en revisión.
- El corte local opera con PostgreSQL nativo, búsqueda textual, FastAPI y MLflow. El build del Compose y el arranque de Langfuse agotaron el plazo de Docker Desktop. Quedan pendientes la evidencia de pgvector, una traza en la interfaz de Langfuse, la entrega con el bot de Telegram y la promoción en Dokploy.
