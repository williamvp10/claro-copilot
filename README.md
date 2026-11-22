# Claro Copiloto

Claro Copiloto es un asistente de atención al cliente para telecomunicaciones. Combina **autoservicio en chat web y Telegram** con una **consola web para asesores**. El cliente puede pasar de una consulta automática a una conversación con un asesor sin repetir lo que ya explicó.

La misma conversación guardada alimenta ambos modos. Quien tiene a cargo el caso controla la respuesta pública, y la consola muestra en privado el contexto, las fuentes y las acciones disponibles.

## Cómo funciona

| Modo | Experiencia |
| --- | --- |
| **Autoservicio** | El copiloto responde preguntas públicas sobre planes, soporte y servicios con citas a fuentes vigentes. Cuando el caso requiere atención humana o datos de cuenta, entrega al asesor el hilo, el motivo y los pendientes. |
| **Atención asistida** | El asesor conversa directamente con el cliente. El copiloto interpreta los mensajes de ambos y prepara en privado la ficha, la evidencia y el siguiente paso, sin que el asesor tenga que escribirle por separado. |

El chat web verifica una cuenta de prueba con un código simulado de seis dígitos y consulta el CRM y la facturación simulados. La titularidad se conserva si el cliente pide un asesor. Las propuestas comerciales muestran sus condiciones y requieren confirmación explícita del asesor antes de ejecutarse. Administración consulta métricas agregadas y registra revisiones candidatas de configuración.

## Casos de uso

| Caso | Resultado esperado |
| --- | --- |
| **Consulta de facturación** | El cliente consulta un plan y luego pide su factura. Verifica su cuenta en el chat con el alias `11111` y cualquier código de seis dígitos. Si pide un asesor, la consola recibe el mismo hilo con la cuenta ya verificada. |
| **Retención elegible** | El copiloto presenta las opciones respaldadas por la política vigente. Tras la aceptación del cliente y la aprobación del asesor, la plataforma registra una sola oferta en el CRM simulado, incluso si la confirmación se repite. |
| **Retención sin elegibilidad** | La ficha explica por qué la mora supera el límite de la política y sugiere cómo continuar con la solicitud. El CRM conserva cero ofertas registradas para ese caso. |

[Escenarios y criterios de aceptación](docs/06-calidad-y-release.md#tres-casos-de-la-demo)

## Arquitectura

- **Plataforma.** Next.js y shadcn/ui para la consola. NestJS, Better Auth, TypeORM y PostgreSQL para sesiones, casos, integraciones y aprobaciones.
- **Agente.** LangGraph.js en un worker de NestJS. El worker recupera evidencia vigente y redacta respuestas públicas con citas mediante OpenAI Direct en el perfil conectado. Consulta el índice PostgreSQL o el MCP privado y usa Jev para clasificación tipada en el perfil conectado.
- **Aprendizaje automático.** FastAPI sirve el clasificador clásico de intención y MLflow registra sus versiones. El modelo opera en sombra para medir su desempeño durante la atención.
- **Despliegue y operación.** Docker Compose en Dokploy. Prometheus consulta los contadores del backend. El worker puede exportar trazas saneadas por OpenTelemetry al Compose separado de Langfuse autohospedado. El panel agrega indicadores del dominio y del servicio de ML.

[Arquitectura y despliegue](docs/02-arquitectura-docker.md) · [Diseño de plataforma](docs/plataforma/diseno.md) · [Diseño del agente](docs/agente/diseno.md) · [Diseño de ML](docs/ml/diseno.md) · [Calidad y evaluación](docs/06-calidad-y-release.md)

## Ejecutar en local

Requiere Docker con Compose. Completa una copia privada de `.env.example` y sigue los pasos de arranque, sembrado y verificación. La consola usa el mismo origen para sesión y API. Telegram se configura con un webhook HTTPS y chats de prueba habilitados. [Arranque y configuración de Dokploy](infra/README.md)

El backend y el agente incluyen pruebas de contrato, autorización, RAG y los tres recorridos con CRM simulado. El clasificador mantiene el modo sombra. La evaluación con los tickets entregados obtuvo F1 macro agrupado de **0,563** y recall de cancelación de **0,340**. [Entrenamiento, servicio y registro](services/ml/README.md)

El corte de demo requiere el resultado de las suites completas y la verificación de las integraciones con credenciales del entorno. [Criterios de release](docs/06-calidad-y-release.md) · [Recursos de la prueba](docs/05-insumos.md)
