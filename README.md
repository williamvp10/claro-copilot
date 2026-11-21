# Claro Copiloto

**Primer hito del MVP.** Resolver tres casos de facturación y retención en dos modos de atención. El cliente conversa por Telegram y el asesor trabaja en la consola. Una misma conversación guardada alimenta al agente. El asesor escribe al cliente y recibe los recursos que necesita sin formular consultas al copiloto.

| Modo | Quién responde al cliente | Qué ve el asesor |
| --- | --- | --- |
| **Autoservicio** | El agente atiende consultas públicas con citas. Al pedir atención humana, requerir datos de cuenta o detectar un tema sensible, deriva con el contexto acumulado. | Al tomar el caso recibe historial, motivo, resumen, fuentes y pendientes. Tras verificar titularidad, el copiloto recupera automáticamente los hechos de cuenta. |
| **Asistido** | El asesor atiende desde el primer mensaje o tras la derivación. El cliente puede escribir directamente al asesor y el asesor puede iniciar una conversación. | El copiloto sigue los turnos de ambos, actualiza una ficha privada y sugiere el siguiente paso. El asesor decide qué comunicar o aprobar. |

**Recorrido de sustentación.** C-1001 demuestra el paso de autoservicio a atención asistida y el cruce CRM–facturación. C-1004 demuestra contacto iniciado por el asesor y registro de una oferta elegible. C-1007 demuestra contacto directo de un cliente con el asesor y denegación fundada de una oferta. [Guion, datos esperados y criterios de aceptación](docs/06-calidad-y-release.md#tres-casos-de-la-demo)

Para una implantación futura en Claro se puede habilitar primero el copiloto privado y después abrir autoservicio por canal y tipo de consulta. El MVP debe demostrar ambos modos.

## Por dónde empezar

| Documento | Qué define |
| --- | --- |
| [Arranque del MVP](docs/01-arranque.md) | Estructura prevista del monorepo, perfiles local y Dokploy, migraciones y criterios de primera entrega por frente. |
| [Arquitectura Docker](docs/02-arquitectura-docker.md) | Los 13 servicios continuos, jobs, redes, volúmenes y diagramas Mermaid de despliegue, atención, ML y observabilidad. |
| [Dominio compartido](docs/03-dominio.md) | Contextos, propiedad del caso, titularidad, aprobaciones, citas, predicciones y eventos. |
| [Contratos v1](docs/04-contratos.md) | Puertos TypeScript, eventos persistidos, acceso a ML, MCP, SSE y formato de los stubs. |
| [Insumos y fixtures](docs/05-insumos.md) | Inventario de archivos del reto y artefactos de trabajo que se obtienen por separado. |
| [Calidad y release](docs/06-calidad-y-release.md) | Evals, métricas, gates, promoción de `develop` a `main` y criterios de demo. |

## Tres frentes en paralelo

| Frente | Stack y alcance | Documentación |
| --- | --- | --- |
| **Aplicación (plataforma)** | Next.js, shadcn/ui, NestJS, TypeORM, Better Auth y PostgreSQL. Bandeja, autenticación, Telegram, CRM/facturación, aprobaciones y dashboard. | [Diseño de plataforma](docs/plataforma/diseno.md) · [Observabilidad y operación](docs/plataforma/observabilidad.md) |
| **Agente** | LangGraph.js en el worker NestJS, Deep Agents, OpenAI Direct, Jev vía OpenRouter, pgvector, re-ranking local, MCP y Redis. | [Diseño del agente](docs/agente/diseno.md) · [Enrutamiento y re-ranking](docs/agente/enrutamiento-y-reranking.md) · [Atención y prompts](docs/agente/atencion-prompts-y-evals.md) · [Evals con Jev](docs/agente/jev-evals.md) |
| **ML clásico** | FastAPI privado, scikit-learn, MLflow autohospedado y Evidently. Clasificación de intención en sombra con una versión fija. | [Diseño de ML e implementación con MLflow](docs/ml/diseno.md) |

## Decisiones para la presentación

| Decisión | Motivo y consecuencia para la demo |
| --- | --- |
| Una conversación en PostgreSQL con autor, secuencia, modo y propietario. | Conserva lo que cliente y asesor ya dijeron. La entrega pública y la ficha privada tienen destinos distintos. Una derivación cambia quién puede responder y conserva el historial. |
| API y worker desde la misma imagen NestJS, con outbox persistente y SSE a la consola. | La recepción del mensaje y el procesamiento del agente tienen tiempos distintos. El worker puede recuperarse o escalar por separado y la consola puede recuperar el último estado tras reconectar. |
| LangGraph.js para orquestar, MCP para conocimiento y puertos de plataforma para CRM/facturación. | El agente obtiene evidencias y propone. El backend comprueba identidad, política y aprobación antes de ejecutar un efecto. pgvector junto al texto completo conserva tarifas, nombres y referencias exactas bajo filtros de vigencia. |
| ML de intención en sombra mediante FastAPI y MLflow. | Permite contrastar la predicción con etiquetas revisadas. El diagnóstico agrupado por plantilla reportó F1 macro de 0,538. La atención debe continuar si falla el predictor. [Diagnóstico](docs/ml/diseno.md#diagnóstico-del-clasificador) |
| Docker Compose en local y en la VPS con Dokploy. GitHub Actions para pruebas, Evals, escaneo, promoción por digest y smoke. | Se reutilizan las imágenes entre ambientes. Para acreditar la alternativa local se prevé entregar la IaC parametrizada con Terraform y el plan validado del destino de nube. |
| OpenTelemetry y Prometheus para operación, Langfuse para trazas y calidad del agente. | La traza debe conectar el turno con el recurso mostrado, su evidencia y cualquier efecto confirmado. El tablero distinguirá mediciones de demo y beneficios que requieren un piloto. |

Estos documentos especifican el diseño y los criterios de aceptación. Los insumos, código, fixtures ejecutables y evidencias de ejecución se gestionan por separado.
