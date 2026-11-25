# Evolución del MVP de Claro Copiloto

Especificación del siguiente corte para administración, atención, CRM y configuración del agente. La [arquitectura de despliegue](../02-arquitectura-docker.md) conserva web y Telegram en Dokploy. La [auditoría de sustentación](../07-auditoria-sustentacion.md) documenta el punto de partida y la [matriz de aceptación](arquitectura-y-aceptacion.md) registra la evidencia del corte.

| Frente | Entrega |
| --- | --- |
| Administración | Panel general y seis tableros del reto, con filtros, gráficos y estado de la medición. Gestión de usuarios, equipos y clientes según rol. |
| Atención | CRM integrado en la consola, traspaso a N2 o supervisor, ficha privada con evidencia y borrador editable para el asesor. |
| Agente y LLMOps | Orquestador LangGraph.js, tres subgrafos especializados para cinco categorías, MCPs privados para Conocimiento, CRM y Facturación, y catálogo de prompts efectivos y versionados. |

- [Consola, CRM, permisos y escalamiento](consola-crm.md)
- [Atención asistida para cliente, asesor y administración](../../specs/002-atencion-asistida/spec.md) · [Plan de implementación y pruebas](../../specs/002-atencion-asistida/plan.md)
- [Tableros y contrato de métricas](tableros.md)
- [Traspaso de intención y churn a 90 días](ml-intencion-y-churn.md)
- [Agente, decisiones, herramientas y prompts](agente-y-prompts.md)
- [Plan de orquestación Multi-LLM, gestión de modelos y RAG](orquestacion-multillm-y-rag.md)
- [Próximo corte del agente: instrucción base, herramientas existentes y doce pruebas de generalización](comportamiento-del-agente.md)
- [Catálogo JSON de agentes, pasos, tools y plantillas](prompts.claro-copiloto.json)
- [Arquitectura propuesta del agente en Archify](diagramas/arquitectura-agente.html)
- [Arquitectura propuesta de plataforma en Archify](diagramas/arquitectura-plataforma.html)
- [Flujos, orden de desarrollo y aceptación](arquitectura-y-aceptacion.md)

## Punto de partida

| Capacidad | Código disponible y trabajo del siguiente corte |
| --- | --- |
| Panel general y tableros | Existen el resumen, los seis endpoints y las vistas con selección de tarjetas y series persistente por operador y categoría. Queda verificar las fuentes y la instrumentación en el entorno del demo. [Especificación](tableros.md) |
| Consola, CRM y especialistas | Existen directorio, ficha, borrador privado, capacidades N1/N2/supervisor/superadmin y transiciones de cola. El corte debe demostrar el traspaso a cada especialidad, la continuidad con el cliente y la gestión de clientes y asesores con el ámbito correcto. [Especificación](consola-crm.md) |
| Decisiones y herramientas | Existen tres subgrafos y MCPs privados para Conocimiento, CRM y Facturación. El grafo elige lecturas autorizadas por propósito, comprueba antecedentes técnicos antes de ofrecer retención y puede combinar detalle de Facturación y servicio de CRM en el mismo turno. Queda ampliar la evidencia de plataforma por escenario y verificar las trazas en el despliegue. [Especificación](agente-y-prompts.md) |
| Prompts y evaluaciones | El catálogo efectivo se construye desde un JSON versionado y el backend ofrece importación, evaluación, activación y reversión. Una base antigua puede tener `prompts={}`. La evidencia del catálogo y de la ingesta en el despliegue sigue siendo necesaria. [Diagnóstico y publicación](agente-y-prompts.md#diagnóstico-del-panel-de-prompts) |

La especificación toma las seis categorías de la sección 6 del reto, las cinco intenciones de `03_datos/tickets.csv`, la política de escalamiento y los OpenAPI entregados. Las láminas 2–4, 8 y 14 de la presentación enviada fijan los recorridos, el ciclo de evaluación y la medición del acceso proactivo a evidencia. Los servicios conservan APIs Express y bases independientes. En la interfaz se muestran como **CRM · API mock** y **Facturación · API mock**. Las métricas del piloto requieren población, período y línea base. [Contratos de CRM y Facturación](../openapi/simuladores.md)

## Frentes de entrega

1. **Consola y administración.** Validar navegación, permisos y diseño responsive. Añadir selección y persistencia de indicadores y hacer verificable el seguimiento de casos desde CRM.
2. **Agente e integraciones.** Fijar el contrato de selección de herramientas, completar las rutas medidas por categoría y comprobar las capacidades MCP y los recibos contra las dos APIs mock.
3. **Calidad y operación.** Verificar catálogo efectivo y estado de Langfuse en el entorno de entrega, ejecutar la evaluación con el corpus fijado y probar traspasos, acciones idempotentes y despliegue por digest.

Los tres frentes comparten `case_id`, `case_revision`, `run_id`, revisión de prompts y recibos. Los contratos se validan antes de la prueba integrada.
