# Claro Copiloto

Claro Copiloto es un asistente de atención al cliente para telecomunicaciones. Combina **autoservicio en Telegram** con una **consola web para asesores**. El cliente puede pasar de una consulta automática a una conversación con un asesor sin repetir lo que ya explicó.

La misma conversación guardada alimenta ambos modos. Quien tiene a cargo el caso controla la respuesta pública, y la consola muestra en privado el contexto, las fuentes y las acciones disponibles.

## Cómo funciona

| Modo | Experiencia |
| --- | --- |
| **Autoservicio** | El copiloto responde preguntas públicas sobre planes, soporte y servicios con citas a fuentes vigentes. Cuando el caso requiere atención humana o datos de cuenta, entrega al asesor el hilo, el motivo y los pendientes. |
| **Atención asistida** | El asesor conversa directamente con el cliente. El copiloto interpreta los mensajes de ambos y prepara en privado la ficha, la evidencia y el siguiente paso, sin que el asesor tenga que escribirle por separado. |

Con la titularidad verificada, la consola reúne datos de CRM y facturación con información documental relevante. Las propuestas comerciales muestran sus condiciones y requieren confirmación explícita del asesor antes de ejecutarse. Administración puede revisar el estado de los casos, la calidad de las respuestas y la trazabilidad de cada acción.

## Casos de uso

| Caso | Resultado esperado |
| --- | --- |
| **Consulta de facturación** | El cliente consulta un plan en Telegram y luego pregunta por su factura. El asesor recibe el hilo y, tras validar la titularidad, encuentra el plan, el saldo y el vencimiento en la ficha. |
| **Retención elegible** | El copiloto presenta las opciones respaldadas por la política vigente. Tras la aceptación del cliente y la aprobación del asesor, la plataforma registra una sola oferta en el CRM simulado, incluso si la confirmación se repite. |
| **Retención sin elegibilidad** | La ficha explica por qué la mora supera el límite de la política y sugiere cómo continuar con la solicitud. El CRM conserva cero ofertas registradas para ese caso. |

[Escenarios y criterios de aceptación](docs/06-calidad-y-release.md#tres-casos-de-la-demo)

## Arquitectura

- **Plataforma.** Next.js y shadcn/ui para la consola. NestJS, Better Auth, TypeORM y PostgreSQL para sesiones, casos, integraciones y aprobaciones.
- **Agente.** LangGraph.js en un worker de NestJS. OpenAI genera las respuestas, Jev clasifica los turnos y el agente recupera fuentes vigentes con búsqueda híbrida, re-ranking y herramientas MCP.
- **Aprendizaje automático.** FastAPI sirve el clasificador clásico de intención y MLflow registra sus versiones. El modelo opera en sombra para medir su desempeño durante la atención.
- **Despliegue y operación.** Docker Compose en Dokploy. OpenTelemetry, Prometheus y Langfuse aportan métricas, trazas y resultados de evaluación para el dashboard.

[Arquitectura y despliegue](docs/02-arquitectura-docker.md) · [Diseño de plataforma](docs/plataforma/diseno.md) · [Diseño del agente](docs/agente/diseno.md) · [Diseño de ML](docs/ml/diseno.md) · [Calidad y evaluación](docs/06-calidad-y-release.md)

El repositorio reúne el diseño del MVP y sus criterios de aceptación. Las integraciones de cuenta se especifican sobre los mocks de CRM y facturación y usan datos sintéticos. [Insumos del proyecto](docs/05-insumos.md)
