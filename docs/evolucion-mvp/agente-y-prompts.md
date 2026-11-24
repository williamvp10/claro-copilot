# Orquestador, subagentes, herramientas y prompts

[Diagrama Archify](diagramas/arquitectura-agente.html) · [Catálogo de prompts y pasos en JSON](prompts.claro-copiloto.json) · [Arquitectura y aceptación](arquitectura-y-aceptacion.md)

## Orquestación propuesta

El siguiente corte amplía la decisión por propósito a solicitudes con varias necesidades y cambios de intención. La [especificación de comportamiento](comportamiento-del-agente.md) identifica las ramas y plantillas que cambian, el contexto permitido por proveedor, los límites del ciclo y las pruebas que debe pasar una candidata. El JSON enlazado arriba es el catálogo que carga el backend al arrancar.

El **orquestador LangGraph.js** corre en el worker de atención. Carga turno, modo, rol, titularidad, revisión del caso y revisión de configuración. Aplica primero las reglas de derivación obligatoria. Usa señales tipadas de Jev para enrutar cuando ayudan y mantiene el clasificador clásico como observación en sombra. Ante ambigüedad solicita aclaración o deriva según política. Cada turno elige un subgrafo principal cuando requiere atención especializada. Una solicitud compuesta puede añadir una lectura de otro dominio dentro del mismo ámbito si el orquestador identifica la segunda intención y la acción es compatible. La clasificación puede proponer la ruta y las herramientas; los permisos y reglas comerciales los aplica NestJS.

Los tres subagentes son **subgrafos con entradas y salidas tipadas** dentro del mismo worker. El orquestador les pasa un contexto por dominio y recibe hechos, evidencia, estado y propuesta tipada. Comparten un cliente MCP y un catálogo de herramientas administrados por el worker. Cada subgrafo recibe su lista permitida y un contexto acotado. Usar checkpoints por ejecución y revisión del caso. Cuando el cliente pide atención humana, el grafo preserva la ruta de derivación y el modo asistido mantiene toda sugerencia en privado. La espera de aprobación se conserva como estado durable de la plataforma. [Composición de subgrafos en LangGraph.js](https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs)

| Subagente | Categorías y filas en tickets.csv | Decisiones y herramientas |
| --- | --- | --- |
| **Soporte técnico** | `soporte_tecnico` (1.571) | Busca manuales, FAQ y avisos vigentes con MCP Conocimiento. Si el titular está verificado y los antecedentes cambian la ruta, consulta servicios y tickets por MCP CRM. Sugiere diagnóstico, ticket o escalamiento N2 según política. |
| **Facturación** | `facturacion` (1.059) | Una pregunta general usa RAG. Un saldo, factura o cargo específico exige titularidad y usa MCP Facturación; agrega contexto del plan por MCP CRM si explica un concepto. Puede proponer un ajuste con evidencia y motivo. El monto acumulado determina si se necesita supervisor. |
| **Comercial y portabilidad** | `consulta_planes` (535), `cancelacion` (372), `portabilidad` (279) | Usa catálogo y políticas vigentes vía MCP Conocimiento. Consulta servicios y elegibilidad vía MCP CRM con caso verificado. Puede proponer oferta cuando existe elegibilidad y aceptación del cliente. En portabilidad explica requisitos o deriva si hace falta autoridad. |

Ante solicitud de terceros, riesgo, fraude, vulnerabilidad, requerimiento legal, falta de confianza o evidencia, aplicar la vía de supervisión de la política. La salida puede ser una abstención con siguiente paso. Los bloqueos de seguridad y las abstenciones esperadas se miden por separado de los errores de ejecución.

Las cinco categorías suman **3.816 tickets** en `03_datos/tickets.csv`. El golden de 30 preguntas añade etiquetas de cobertura que cruzan los dominios. `contratos` se enruta por el tema del contrato. `herramienta` valida el uso de la integración correspondiente. `escalamiento` y `fuera_de_alcance` validan salidas del orquestador. Conservar por separado la etiqueta del escenario de evaluación y la categoría operativa.

### Cómo decide usar una herramienta

1. Aplicar primero seguridad y modo del caso. Para una consulta pública de catálogo, política o soporte, recuperar evidencia vigente. Para una consulta privada, continuar con la verificación de titularidad en el mismo chat si está pendiente. La transferencia a un asesor conserva el objetivo del turno.
2. Construir un plan acotado de lecturas con categoría, propósito y selector tipado. Ejemplos de propósito son `explain_balance`, `inspect_invoice`, `review_recurrence` y `check_offer_eligibility`. El propósito determina la tool. Jev aporta clasificación y complejidad a partir de señales, y el plan se valida en código antes de ejecutarse. Los nombres de tool y permisos se resuelven en el catálogo y los selectores se validan contra el caso.
3. Ejecutar solo la lectura necesaria. «¿Cuánto debo?» usa `billing.get_balance`; «Explícame la factura F‑…» usa `billing.get_invoice_detail` y agrega saldo si el cliente también lo pide. Una consulta sobre un cargo que cambió con el plan añade una lectura de CRM si el detalle requiere el servicio vinculado. Una cancelación por fallas recurrentes revisa tickets antes de considerar elegibilidad comercial.
4. Cerrar con respuesta, borrador privado, aclaración, derivación o propuesta. Registrar propósito, subgrafo, decisión de ejecutar u omitir, tool, estado, latencia y referencia de evidencia sin argumentos sensibles. La suite comprueba herramientas requeridas y omitidas, su secuencia y sus efectos.

El grafo registra el propósito tipado de cada lectura y aplica permisos por dominio. Un caso web verificado probó la secuencia de detalle de factura y contraste de servicio contra ambos MCPs y las APIs mock.

## Etiquetas y responsables

| Etiqueta en Archify | Qué representa | Quién lo ejecuta |
| --- | --- | --- |
| **AGENTE** | Orquestador que aplica política, decide ruta y compone la salida del turno. | Worker de atención con LangGraph.js. |
| **SUBAGENTE** | Subgrafo de Soporte técnico, Facturación o Comercial y portabilidad. Encadena pasos, recupera evidencia y devuelve salida tipada al orquestador. | El mismo worker, con estado y herramientas acotados al dominio. |
| **PASO** | Nodo del grafo que carga, clasifica, consulta, redacta o valida. Sus modos incluyen código, llamada a proveedor y plantilla local. | Orquestador o subagente propietario del paso. |
| **TOOL** | Operación invocable con entrada y salida tipadas, como `search_knowledge` o `billing.get_balance`. Un paso puede invocar una o varias herramientas autorizadas. | Servidor MCP y adaptador que valida el ámbito. |
| **CLIENTE MCP / SERVIDOR MCP** | El cliente común del worker llama a los servidores de Conocimiento, CRM y Facturación. Cada servidor publica las tools de su dominio. | Worker y servicios privados, con permisos por caso y por tool. |
| **PROVEEDOR** | Jev entrega una clasificación. OpenAI puede seleccionar evidencia o redactar una respuesta con material autorizado. | Adaptadores que validan contratos y plazos en el worker. |
| **GESTOR DE PROMPTS** | Langfuse almacena y versiona plantillas. | LLMOps, con selección efectiva de la plataforma. |
| **BACKEND / APROBACIÓN / WORKER / API MOCK** | NestJS aplica permisos y proyecta resultados. El asesor o supervisor confirma y el worker de efectos registra y reconcilia la operación con el mock. | Plataforma, operadores autorizados y APIs privadas. |

## MCPs, herramientas y autorización

| Servidor | Tools de lectura del demo | Contraparte |
| --- | --- | --- |
| **MCP Conocimiento** existente | `search_knowledge` / filtros de audiencia, producto, canal y vigencia, top-k acotado, citas y fechas. | Índice de PostgreSQL con pgvector. |
| **MCP CRM** | `crm.get_customer_context`, `crm.list_services`, `crm.list_recent_tickets`, `crm.evaluate_retention`. | CRM · API mock, mediante los adaptadores HTTP y la evaluación de elegibilidad. |
| **MCP Facturación** | `billing.get_balance`, `billing.list_invoices`, `billing.get_invoice_detail` con identificador de factura validado. | Facturación · API mock. |

El JSON asigna una lista de tools a cada subagente y a cada paso de lectura. El cliente MCP es compartido y el permiso efectivo exige que la tool esté permitida para el subagente, el paso y el caso. En una consulta compuesta, el orquestador puede activar una lectura acotada de otro subgrafo aplicando su propia lista permitida.

| Subgrafo | Permisos de lectura objetivo |
| --- | --- |
| Soporte | `search_knowledge`, `crm.list_services`, `crm.list_recent_tickets`. Consultar CRM con titularidad vigente y cuando el servicio o los antecedentes cambien el diagnóstico. |
| Facturación | `search_knowledge`, `billing.get_balance`, `billing.list_invoices`, `billing.get_invoice_detail`. Agregar `crm.list_services` para contrastar el plan vinculado cuando el cargo lo requiera. |
| Comercial y portabilidad | `search_knowledge`, `crm.get_customer_context`, `crm.list_services`, `crm.evaluate_retention`. Si aparecen fallas recurrentes, el orquestador puede activar la lectura `crm.list_recent_tickets` mediante el paso autorizado de Soporte. |

La rama comercial delega la comprobación de recurrencia al subgrafo Soporte. Si faltan los antecedentes técnicos, la ficha deja esa consulta pendiente antes de evaluar una oferta. La traza usa `review_recurrence` para la lectura de tickets.

Operar los dos MCPs de integración como procesos privados del monorepo por Streamable HTTP. Cada uno consulta su API mock Express. El worker adjunta la identidad de servicio y una capacidad firmada de 15 segundos para una tool, con `run_id`, `case_id`, `case_revision` y destino `crm` o `billing`. El servidor obtiene del turno la audiencia de asesor y revalida vigencia, revisión, tool, titularidad y asignación activa. La referencia del cliente se deriva del caso y Facturación comprueba la pertenencia para `invoice_id`. Las claves REST viven en los adaptadores y el navegador entra por NestJS. Las anotaciones de lectura documentan el contrato. La autorización aplica en servidor por invocación. El adaptador HTTP directo disponible en desarrollo es útil para pruebas de plataforma. Para acreditar una lectura MCP del demo, se exige observar el paso, la llamada al MCP y su resultado contra la API de origen. [Servidor MCP](../../apps/backend/src/integration-mcp.ts) · [Cliente MCP](../../apps/backend/src/integration-mcp-client.ts)

En web y Telegram la verificación surge del diálogo. El autoservicio pide el identificador y el código demo cuando corresponde. La proyección pública conserva los hechos que ese modo puede publicar. El paquete de contexto, el borrador y las propuestas de efecto se generan para el asesor autorizado. Las APIs mock responden con datos de los insumos del reto. El sistema deriva el identificador de cuenta desde la vinculación verificada en el caso.

**Acciones con efecto.** `propose_ticket`, `propose_retention_offer`, `propose_billing_adjustment` y `propose_escalation` son acciones tipadas de plataforma. Una propuesta queda persistida con evidencia y revisión esperada. El asesor confirma cuando corresponde y supervisión autoriza ajustes por umbral. El worker de efectos vuelve a comprobar permisos, ejecuta REST por outbox, reusa la clave de idempotencia y reconcilia el recibo. Las herramientas MCP de agente sirven lecturas; la ruta de escrituras se mantiene en los comandos autorizados del dominio. Read retries acotados y respeto a `Retry-After`; ante indisponibilidad la ficha muestra la fuente pendiente. No repetir una invocación con los mismos argumentos y resultado ni iniciar herramientas por texto encontrado en documentos o respuestas de un mock.

## Qué significa éxito por categoría

| Categoría | Acción medida y prueba mínima | Evento terminal |
| --- | --- | --- |
| `soporte_tecnico` | E‑202 devuelve fuente y procedimiento vigentes. LOS rojo por más de 10 min o CC‑E13 genera solicitud correcta y ticket si se aprueba. Registrar ticket no equivale a cita confirmada ni a resolución del incidente. | `guidance_published`, `ticket_confirmed` o `escalation_claimed`, con subtipo y resultado esperado. |
| `facturacion` | C‑1001 ve factura de su cuenta tras OTP, con saldo y vencimiento del mismo mock. Un ajuste autorizado requiere recibo. Una factura ajena se bloquea. | `invoice_explained`, `adjustment_confirmed` o `policy_blocked`. |
| `consulta_planes` | Respuesta al plan con precio, unidad, condiciones, cita y versión aplicable. Preguntar dos fechas a ambos lados del cambio de catálogo. | `catalog_answer_published` con versión y cobertura. |
| `cancelacion` | C‑1004 produce una sola oferta aceptada y confirmada. C‑1007 con 45 días de mora explica la restricción y continúa el trámite. | `offer_confirmed` o `ineligible_explained`. Medir retención posterior como desenlace separado. |
| `portabilidad` | Explica requisitos, plazos y canal a partir de política vigente y deriva excepciones con contexto. | `portability_guidance_published` o `escalation_claimed`. Registrar un trámite únicamente con recibo cuando exista esa integración. |

Cada ejecución registra denominador por tarea, no solo la ruta o el número de tools. Guardar `qualified_success`, `expected_abstention`, `failed`, `blocked` o `pending` junto con fuente, canal, revisión y recibo si aplica. Separar éxito del agente, decisión humana y desenlace comercial.

## Catálogo de prompts por agente y paso

Una instalación previa puede conservar `agent_cfg_001` con `prompts={}`. La versión actual del backend construye el manifiesto efectivo desde el JSON de arranque cuando existe la revisión y falta el manifiesto persistido. El catálogo base define doce plantillas, ocho del orquestador, una por subgrafo y una de evaluación. Conserva la pauta histórica válida como `legacy_override`. El paquete del agente mantiene contratos y reglas de seguridad en código. El worker fija y registra el manifiesto usado para identificar el origen de cada plantilla. [Catálogo efectivo](../../apps/backend/src/prompt-catalog.ts)

El [JSON de arranque](prompts.claro-copiloto.json) define la estructura del corte. Cada agente y subagente tiene `steps` y `prompts` propios. Un paso se identifica como `agent_id.step_id` y declara su modo, referencias de prompt y, cuando consulta, las tools autorizadas. `prompt_refs: []` corresponde a pasos de código, como autorización, recuperación, enrutamiento y validación. Cada prompt tiene un nombre de Langfuse, una plantilla, variables declaradas, ámbito de datos y contrato de salida. La evaluación queda en su propio bloque y usa una plantilla de rúbrica independiente. Las plantillas Jev con formato `jev_question_json` versionan las instrucciones y las descripciones de las opciones. El adaptador deserializa el texto, valida el conjunto exacto de claves y renderiza variables dentro de los campos de texto. Los enums, la forma de la respuesta y los umbrales de aceptación siguen validados en código.

| Propietario | Pasos con plantilla | Datos con los que se ejecuta |
| --- | --- | --- |
| **Orquestador** | Clasificación de intención y complejidad con Jev. Selección opcional de evidencia pública y respuesta pública con OpenAI. Plantillas locales para datos de cuenta, empatía, borrador y traspaso. | Jev y el selector reciben señales categóricas. El redactor recibe tema normalizado y pasajes públicos aprobados. La plataforma rellena valores privados en memoria para la audiencia autorizada. |
| **Soporte técnico** | Fragmento de diagnóstico para el borrador privado. | Síntoma y procedimiento autorizados por plataforma. |
| **Facturación** | Fragmento de explicación de saldo, monto o período. | Valores formateados de la factura del titular. |
| **Comercial y portabilidad** | Fragmento de orientación, condición o alternativa elegible. | Política vigente y hechos autorizados del caso. |
| **Evaluación** | Juicio semántico con Jev, con adjudicación humana ante ambigüedad. | Señales de la suite permitidas para procesamiento externo. Las comprobaciones de permisos y efectos se ejecutan en código. |

El orden del turno depende de la ruta. Primero se carga el caso y se aplican las reglas obligatorias. Cuando la política lo permite, Jev propone intención y complejidad y el orquestador ejecuta el subgrafo elegido. Con los resultados, selecciona una salida pública, un borrador asistido o una derivación. La proyección verifica modo, permisos, citas, cifras, vigencia y estado de efectos. Para el modo asistido, el asesor conserva el control de edición y envío.

La empatía se configura en la pauta de redacción pública y en la plantilla local de reconocimiento del inconveniente. El worker rellena `reported_issue` con una frase normalizada del catálogo del dominio cuando corresponde y omite el fragmento en consultas neutras. Los hechos y el siguiente paso vienen de la plataforma. Una derivación sugerida se redacta como siguiente paso, y una derivación ya registrada se puede comunicar como confirmada.

Ejemplo de borrador privado para una falla recurrente cuando el ticket todavía requiere aprobación. «Entiendo lo incómodo que es perder la conexión varias veces. Revisé los reportes de tu servicio. El siguiente paso es solicitar una visita técnica prioritaria». En una consulta neutra de precio, la respuesta empieza con el dato y su condición vigente.

### Diagnóstico del panel de prompts

| Lo que ve el operador | Qué comprobar y qué debe indicar la interfaz |
| --- | --- |
| Catálogo vacío o sin revisión activa | Verificar digest de frontend y backend, el seed y la migración de la base que usa el contenedor y `GET /api/v1/admin/prompts` autenticado como admin. Una respuesta `200 []` indica que la consulta no encontró revisiones. Una revisión antigua con `prompts={}` debe proyectar las doce plantillas efectivas. Un error de autorización, red o configuración tiene su propio mensaje de diagnóstico. |
| Hay catálogo con origen `git_bootstrap` | Mostrar plantilla, paso, hash y revisión. Una versión Langfuse queda pendiente de importación hasta que exista un número confirmado para ese nombre. |
| Langfuse tiene versiones y la plataforma sigue con la base | Mostrar de forma independiente versión externa, candidata importada y revisión efectiva. La etiqueta en Langfuse sirve de referencia de edición. |
| Evaluación sin informe | Distinguir candidata inexistente, evaluación aún sin ejecutar, en cola, ejecutándose o fallida. Verificar `PROMPT_EVAL_ENABLED`, el worker del perfil `evals` y los dos insumos de la suite. Ofrecer el informe previo con su fecha y huella. Distinguir `review_required`, aprobado y rechazado. El catálogo activo sigue visible en todos esos estados. [Configuración del demo](../../infra/README.md#evidence-for-the-defense) |

Para el diagnóstico del entorno del usuario, guardar el estado HTTP, digest, ID de revisión activa, cantidad de plantillas y origen por plantilla. Para evals, añadir el estado de la candidata, el del job y la huella del último informe. Estos datos permiten ubicar el fallo antes de cambiar plantillas o activar una revisión.

La validación del demo abre la vista con una base migrada, obtiene el catálogo, importa una versión exacta, inicia el A/B y abre una traza cuyo `prompt_ref` y versión corresponden a la revisión ejecutada. La evaluación de tono valora reconocimiento específico, lenguaje natural y siguiente paso verificable, junto con el control determinista de cifras, fuentes, promesas y efectos. Incluir un caso neutro, uno de falla recurrente y uno de retención denegada.

## Editar en Langfuse y activar en Claro Copiloto

Langfuse permite crear y editar plantillas desde **Prompts**, conservar cada versión y recuperarla mediante nombre y versión desde el servidor. Sus etiquetas como `staging` o `production` son referencias móviles. La activación en Claro Copiloto queda registrada como una revisión de plataforma. [Edición de prompts](https://langfuse.com/docs/prompt-management/get-started) · [Versiones y etiquetas](https://langfuse.com/docs/prompt-management/features/prompt-version-control)

1. **Arranque.** Importar las plantillas base del JSON con sus nombres estables. Para una instalación con `prompts={}`, proyectar las plantillas de arranque con su procedencia y conservar las revisiones históricas. El catálogo registra el cuerpo y hash aprobados. Las versiones numéricas de Langfuse se registran cuando el servicio las asigna.
2. **Edición.** Un operador autorizado edita una plantilla en Langfuse o crea la candidata desde el panel a través de NestJS. El backend importa la versión exacta con su diff y comprueba que coincide con las variables declaradas, el tipo y el contrato de salida. La revisión candidata reúne todas las referencias que usará el turno, incluidas las que siguen iguales.
3. **Evaluación y activación.** Ejecutar el A/B con las 30 preguntas golden y los 19 escenarios, además de empatía, pertenencia, autorización, vigencia, escalamiento y efectos idempotentes. Fijar manifiestos y rúbrica durante la comparación. La política de release exige exactitud ≥80 %, groundedness ≥0,85, Recall@5 ≥0,90 y cero fallos críticos. Activar la revisión completa en una transacción auditada tras el gate. Un rollback selecciona una revisión aprobada previa. [Gate y evidencia del corte](../06-calidad-y-release.md)
4. **Ejecución.** Cada turno fija la revisión efectiva al comenzar. Para cada plantilla guarda clave, nombre de Langfuse, versión numérica cuando aplique, hash SHA‑256 del texto, contrato y origen. El worker usa el texto de esa versión, con copia local del mismo hash para interrupciones de Langfuse. Si el texto aprobado no se puede resolver, el flujo se abstiene de generar y usa salida determinista autorizada, evidencia citada o derivación según el caso.
5. **Observabilidad.** El panel presenta plantilla efectiva, origen `git_bootstrap` o `langfuse`, versión, diff, historial, evals y trazas. Las observaciones registran `run_id`, `agent_id`, `step_id`, `prompt_ref`, versión y un identificador de tool cuando aplique. Las generaciones se vinculan a su prompt en Langfuse. Las vistas previas usan ejemplos ficticios. Los valores de cuenta, los mensajes privados y las credenciales permanecen en la plataforma. [Vínculo de prompts con trazas](https://langfuse.com/docs/prompt-management/features/link-to-traces)

El grafo conserva en código sus rutas, permisos, esquemas de Jev y herramientas, límites de ejecución, reglas de aprobación y comprobaciones sobre la salida. Las instrucciones de redacción, clasificación, rúbrica y plantillas se cargan del catálogo aprobado. Una edición de texto pasa por evals y puede activarse sin redesplegar. Un cambio de taxonomía, entradas permitidas o permisos requiere un release de código.
