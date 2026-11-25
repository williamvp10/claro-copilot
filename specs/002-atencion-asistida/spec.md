# Experiencia de atención asistida y escalamientos

**Rama de implementación** `develop` · **Fecha** 2026-11-24 · **Estado** Aprobada

La [ampliación del 25 de noviembre](#at-07--retención-y-respuesta-al-cliente) fue aprobada para el demo. Su [plan de implementación](plan.md#6-plan-de-ampliación-del-25-de-noviembre) usa `develop` como base.

El cliente debe saber quién lo atiende y qué pasa mientras espera. El asesor debe poder tomar el siguiente caso, entenderlo y responder en el mismo espacio de trabajo. El administrador de Claro debe poder recibir y atender las derivaciones de cualquier destino en el demo. La conversación conserva su canal e historial desde la primera espera hasta la resolución.

## Qué observamos en el código actual

| Superficie | Comportamiento observado |
| --- | --- |
| Chat del cliente | La cabecera cambia a «Asesor asignado» y aparece un texto genérico mientras llega la primera respuesta. La toma inicial cambia la asignación, pero el comando no agrega un aviso al hilo ni encola su entrega a Telegram. La proyección web carece de un estado público para el escalamiento de atención. |
| Bandeja del asesor | La consulta mezcla asignados y disponibles y ordena por actualización reciente. El botón «Tomar caso» está dentro de la vista del caso. |
| Copiloto | La respuesta sugerida se encuentra dentro de Resumen. El formulario de escalamiento puede prellenar un código de política, recibe el motivo del asesor y al confirmar muestra un aviso general. El botón se sigue renderizando mientras el caso está abierto y asignado, aunque ya haya una solicitud activa. |
| Administración | El admin sembrado recibe `admin` y `supervisor`. Una cola de especialidad exige `n2` y la especialidad para la toma. Supervisión puede ver ciertas colas por falta de especialistas, aunque esa visibilidad por sí sola no habilita tomarlas. |

[Chat web](../../apps/web/app/chat/page.tsx) · [Consola](../../apps/web/app/page.tsx) · [Casos y toma inicial](../../apps/backend/src/cases.ts) · [Cola y transiciones](../../apps/backend/src/platform-evolution.ts) · [Identidades de demo](../../apps/backend/src/seed.ts)

## AT-01 · Casos en el espacio de trabajo

- Incorporar **Casos** como entrada del menú de atención. Abrir un tablero compacto con **Disponibles para tomar** y **Mis casos**. Cada lista con su total, estado de carga, estado vacío y reintento si falla. Distinguir seguimiento de una derivación propia de los casos que se pueden atender.
- En **Disponibles para tomar**, ordenar por la hora en que el caso entró a esa cola, del más antiguo al más nuevo. Una nueva intervención del cliente conserva su posición. Mostrar canal, referencia o alias permitido, hora de llegada, tiempo en espera y **Tomar caso** en cada fila. Antes de tomar se muestra una proyección mínima. **Mis casos** permite reabrir una conversación asignada y consultar sus derivaciones.
- Al tomar un caso, mostrar confirmación y abrir el historial con la ficha privada. Si otra persona lo tomó primero, actualizar la lista y anunciar «Otro asesor tomó este caso». El resultado es idéntico desde el tablero y desde el botón que ya existe dentro de la bandeja.

## AT-02 · Qué ve el cliente durante la atención

| Transición confirmada | Chat web | Telegram |
| --- | --- | --- |
| Solicitud inicial en espera | Subtítulo destacado **Buscando un asesor** y una animación discreta de espera con alternativa estática. El cliente puede seguir escribiendo. | Aviso de espera por el hilo de origen. |
| Primera toma | Subtítulo **Atención con [nombre visible]** y aviso verde en el hilo **[Nombre visible] tomó tu caso y recibió el historial. Puedes seguir escribiendo aquí.** | El mismo aviso llega como mensaje del sistema. |
| Escalamiento en cola | Subtítulo **Caso escalado · En espera** y aviso en el hilo **Escalamos tu caso a [destino]. Puedes seguir escribiendo aquí mientras el equipo lo toma.** | El mismo aviso llega como mensaje del sistema. |
| Toma del escalamiento | Subtítulo de atención y aviso verde **[Nombre visible] tomó tu caso y recibió el historial.** Se conserva el mensaje previo de escalamiento. | Mensaje de toma en el mismo hilo. |
| Cancelación de una derivación en cola | Si se cancela, avisar **Tu asesor continuará atendiendo este caso.** Se restablece el subtítulo de atención. | El mismo aviso llega como mensaje del sistema. |

Usar el nombre visible autorizado del operador o «Un asesor de Claro» cuando no esté disponible. El estado verde representa una toma confirmada, con el texto **En atención**. El cliente conserva el editor al esperar o cambiar de asesor. Los avisos quedan en el historial al recargar o reconectar. Mostrar cada transición una vez y usar un anuncio accesible por cambio de estado.

## AT-03 · Jerarquía de la ficha del caso

La cabecera conserva **Asistencia en tiempo real** y muestra **Solicitar escalamiento** o el estado confirmado de la derivación. Debajo van dos pestañas al mismo nivel, **Resumen** y **Datos del cliente**. Al abrir un caso se selecciona **Resumen**. El contenido de cada pestaña empieza debajo de esa navegación.

### Resumen

| Apartado | Qué necesita ver el asesor |
| --- | --- |
| **Resumen del caso** | El problema, lo ya intentado o respondido y en qué punto quedó la atención. Darle la mayor jerarquía visual. Indicar **Generado con IA** cuando corresponda y mostrar la última actualización. Conservar el texto vigente durante la actualización. |
| **Motivo del escalamiento** | Destacar el motivo confirmado por el asesor y el destino. Cuando el caso solo pasó del bot a N1, mostrar **Motivo del traspaso**. Identificar la procedencia del texto si es una sugerencia de IA o una confirmación del asesor. |
| **Recomendaciones y pendientes** | Mostrar primero el siguiente paso y después las alternativas aplicables, la evidencia que las respalda, las condiciones y lo que falta por confirmar. Identificar las acciones confirmadas por la plataforma. La respuesta para el cliente se usa desde el editor, según [AT-04](#at-04--respuesta-sugerida-arriba-del-editor). |
| **Intención sugerida** | Mostrar la intención en lenguaje claro y permitir confirmarla o corregirla. Indicar la selección ya registrada por el asesor. |
| **Hechos y fuentes** | Distinguir lo declarado por el cliente de los hechos comprobados. Mostrar citas con título, edición y acceso a la fuente cuando esté disponible. |
| **Seguimiento del caso** | Mostrar nivel, estado, derivaciones y recibos confirmados en un detalle expandible. Mantener visibles en la cabecera los cambios de estado que requieren atención. |

### Datos del cliente

- Dentro de la pestaña, ofrecer **CRM** y **Facturación** como segundo nivel. Abrir **CRM** por defecto. Cada vista comunica por separado la falta de titularidad, la carga, el error de proveedor y el resultado disponible. Mantener el caso y su historial al cambiar de pestaña.
- En **CRM**, si el caso aún no tiene cliente vinculado, permitir comprobar si existe un registro con los datos de identificación requeridos. Si se confirma que no existe, mostrar **Crear cliente** a quien tenga permiso de alta para el caso asignado. Reutilizar el formulario de alta del CRM, con datos sintéticos en el demo. Después de recibir el comprobante del CRM, asociar el registro al mismo caso y mostrar el siguiente paso de verificación de titularidad. Una coincidencia se dirige al flujo de vinculación y verificación de la cuenta existente.
- En **Facturación**, mostrar saldos, vencimientos y detalle con el permiso vigente. Usar **Pendiente** en ámbar, **Vencida** en rojo y **Pagada** en verde. Conservar **Saldada por ajuste** como estado diferenciado. Si el cliente existe en CRM pero aún no tiene registro de facturación, mostrar ese estado dentro de Facturación.

En escritorio, el hilo mantiene su columna y la ficha queda a su lado. En móvil, la ficha se abre desde **Ficha** y vuelve al hilo al cerrar, con retorno del foco. Ambos tamaños muestran la misma jerarquía de navegación.

## AT-04 · Respuesta sugerida arriba del editor

- Colocar **Respuesta sugerida por IA** inmediatamente encima de **Mensaje al cliente**. Usar borde y fondo índigo suave y un realce breve cuando llega una sugerencia nueva. El bloque puede expandirse para leer sugerencias largas y sus fuentes. Mantener a la vista el editor y el botón de envío.
- El Copiloto propone un texto en voz del asesor, listo para revisar, con los hechos comprobados y un siguiente paso. La sugerencia se actualiza con el historial, incluidos los mensajes efectivamente enviados por el asesor. El texto de ayuda para el operador y las acciones pendientes quedan en la ficha.
- **Usar en respuesta** copia el texto a un editor editable. Si ya hay texto, ofrecer **Insertar** y **Reemplazar**. Llevar el foco al editor al aplicar. **Enviar mensaje** requiere una acción del asesor. Si llega una sugerencia más reciente, no sobrescribir lo que ya escribió. Una sugerencia obsoleta deja de ofrecerse como actual. Conservar las señales de uso, edición y valoración.

## AT-05 · Escalamiento claro y editable

- **Solicitar escalamiento** abre un formulario con **Destino** y **Motivo para el equipo receptor**. Ofrecer Soporte técnico, Facturación y Supervisión, además de Comercial y portabilidad, que ya existe en la operación. Al seleccionar el destino, el Copiloto prepara un borrador breve desde el historial y la evidencia vigente. El asesor puede aplicarlo, editarlo, pedir otra sugerencia o redactar desde cero. Ante fallo o evidencia insuficiente, conserva el formulario manual. Un resultado tardío nunca reemplaza lo escrito.
- Al confirmar, mostrar **Enviando solicitud…** hasta recibir estado confirmado. Una vez en cola, el botón se convierte en **Caso escalado · En espera de [destino]** y se refleja también en **Asistencia en tiempo real**. El asesor de origen conserva el seguimiento. En el demo, durante la espera la consola deja la conversación en lectura para ese asesor y explica el bloqueo del envío. Si se cancela antes de la toma, se reactiva el envío del asesor asignado y se conserva su borrador local. Si otro operador lo toma, se retira el acceso privado anterior y queda un registro mínimo de seguimiento.
- Si el servidor rechaza o vence la solicitud, mantener la redacción y mostrar el error junto al formulario. Si se pierde la respuesta de confirmación, reconciliar el estado antes de ofrecer un reintento. Una confirmación repetida representa la misma solicitud. La IA redacta la sugerencia. El asesor decide el destino y confirma la derivación.

## AT-06 · Administración atiende el nivel 2 del demo

- En el demo el **Administrador de Claro**, con capacidades explícitas de administración y supervisión, tiene una cola de nivel 2 con todos los destinos. **Tomar caso** le asigna la conversación, abre el historial y habilita responder como operador de atención. Mostrar la especialidad original y el progreso del escalamiento. Las acciones de aprobar ajustes conservan sus permisos y flujos propios.
- La regla de demo cubre Soporte técnico, Facturación, Supervisión y Comercial y portabilidad. Fuera del demo, la plataforma deriva por especialidad y capacidad de atención. Los operadores deben estar activos y disponibles para tomar. Las lecturas de datos privados siguen condicionadas a la asignación y, para CRM y Facturación, a la titularidad verificada.
- Al tomar, el receptor recibe lo ya conversado, el motivo confirmado, evidencias y pendientes. El Copiloto reanuda sus sugerencias privadas con el contexto actualizado del nuevo propietario. El caso sigue abierto para continuar la charla desde el mismo canal.

## AT-07 · Retención y respuesta al cliente

- En **Recomendaciones y pendientes**, mostrar las alternativas elegibles, el servicio, su cargo vigente, los datos verificados que explican la elegibilidad, las condiciones de política, la edición citada y la decisión pendiente. Usar los valores vigentes del caso al renderizar.
- En **Respuesta sugerida por IA**, redactar el próximo mensaje en voz del asesor con las alternativas autorizadas para ese cliente. Si la oferta estándar aplica, el borrador puede decir «Por tu antigüedad, puedo ofrecerte un 30 % de descuento sobre el cargo fijo durante seis meses o pasarte al siguiente plan sin costo adicional durante ese mismo plazo. ¿Cuál prefieres?». Mantener el contexto operativo, los identificadores y las referencias de política fuera del texto que se aplica al editor.
- Si el cliente pide un porcentaje distinto, registrar lo solicitado en recomendaciones y mostrar el siguiente paso según la elegibilidad y el permiso. Para una excepción pendiente, el borrador comunica que Administración puede revisar la solicitud. Después de la aprobación, puede ofrecer las condiciones aprobadas. Tras la aceptación exacta, muestra el pendiente de activación o el estado confirmado por los recibos. Si cambian servicio, porcentaje o vigencia, solicitar una nueva aceptación.
- En **Datos del cliente → CRM**, mostrar el estado de cada alternativa y **Solicitar revisión** al asesor cuando corresponda. **Autorizar excepción** queda disponible para Administración dentro del caso autorizado, con servicio, porcentaje, duración, motivo y vista previa del cargo. Mantener titularidad y elegibilidad como requisitos del flujo. La excepción amplía el porcentaje dentro de la política configurada del demo, con auditoría de autorización, aceptación, registro y aplicación.
- En **Facturación**, mostrar el beneficio programado desde el siguiente ciclo emitible y el desglose cuando exista la factura. Para descuentos, mostrar cargo fijo base, porcentaje, importe del beneficio y cargo neto por servicio. Mostrar **Confirmado en CRM**, **Programado en Facturación** y **Aplicado en factura** según sus comprobantes. Una petición, un borrador o una aceptación informal por sí solos carecen de efecto en CRM y Facturación.
- Los botones de escalamiento y de **Datos del cliente** siguen los componentes, tamaños, foco, carga y variantes de la consola. Usar un solo control de escalamiento por estado visible. En CRM y Facturación dar jerarquía primaria a la confirmación y usar variantes secundarias para consultar, reintentar o cancelar.

**Ejemplo de ficha antes de conversar la oferta.** Recomendar presentar las dos alternativas y esperar la decisión del cliente. Mostrar Hogar Fibra 500 por $109.900 y Claro Max 60 GB por $59.415 como cargos de referencia. Mostrar 40 meses de antigüedad, 0 días de mora y 0 ofertas en los últimos 12 meses. La política de referencia admite hasta 30 días de mora y una oferta por cliente en 12 meses, define beneficios según antigüedad y exige revisión técnica prioritaria para fallas recurrentes. Citar **Política de retención y descuentos · POL-RET-2026 v3.1** en la ficha. Las alternativas elegibles y sus términos se leen del resultado vigente de CRM.

## AT-08 · Cierre y seguimiento

- El asesor asignado puede cerrar un caso asistido. El diálogo ofrece **Cerrar como resuelto** cuando hay confirmación del cliente o evidencia operativa que el asesor registra con motivo. **Cerrar con pendientes** registra el motivo y conserva los compromisos, con fecha y responsable cuando se acuerde un seguimiento. Las métricas distinguen resultado operativo, confirmación del cliente y cierre con pendientes.
- Interpretar «listo, gracias» según lo que precede. Después de una pregunta explícita sobre la resolución o el cierre, una respuesta afirmativa inequívoca puede quedar como evidencia vinculada al mensaje. Después de una oferta, una explicación o una promesa de facturación, conservar el sentido de aceptación o agradecimiento que corresponda. Una discrepancia, negativa o nueva solicitud conserva el pendiente. El cliente ve el cierre confirmado en el hilo.
- Mostrar **Seguimiento recomendado** con prioridad **Habitual** en verde, **Media** en ámbar, **Alta** en rojo y **Sin predicción** en neutro. Acompañar el color con texto. Mostrar **Predicción de riesgo de baja a 90 días**, versión del modelo y fecha de corte cuando haya inferencia, con indicación de datos sintéticos. El horizonte del modelo y la fecha de contacto se muestran por separado.
- Precargar una fecha recomendada según prioridad y permitir modificarla antes de confirmar. Mostrar fecha y responsable confirmados. Si falta predicción o el servicio de ML falla, queda disponible la programación manual para el titular verificado. Mostrar estados **Programado**, **Vencido**, **Completado** y **Cancelado**. Conservar el seguimiento tras cerrar el chat.
- Agregar **Seguimientos programados** inmediatamente debajo de **Directorio CRM** en el menú. La tabla muestra cliente autorizado, caso, fecha, prioridad, responsable y estado. Ordenar por fecha ascendente, destacar vencidos y permitir filtrar por estado y prioridad. Ofrecer acceso al caso y acciones de reprogramar o completar según permiso. En móvil, conservar una lectura por fila sin desbordar la consola.

## AT-09 · Una cuenta de Administración en el demo

- **Administración** reúne los apartados y comandos que hoy requieren Superadministración. Incluye **Modelos del agente**, **Operadores**, la gestión del **Directorio CRM**, las funciones administrativas de prompts y RAG, las colas de nivel 2 y las aprobaciones habilitadas. El servidor decide los permisos de pantalla y operación. El historial privado del caso conserva su alcance de titularidad, asignación o revisión autorizada.
- Sembrar únicamente una identidad administrativa en el demo y retirar el acceso de la cuenta de Superadministración. Mantener el historial de autoría. Asesor y Soporte N2 conservan sus capacidades de atención. Aplicar la unificación al demo y mantener las reglas actuales de otros entornos. [Alcance de CRM y Facturación](../001-admin-crm-billing/spec.md#ampliación-propuesta-del-demo)

## Dirección visual y accesibilidad

| Uso | Tratamiento |
| --- | --- |
| Marca y acciones | Conservar Geist, superficies claras y rojo Claro en acciones principales de marca. Dentro de la ficha usar superficies neutras e índigo para IA y foco contextual. |
| Asistencia por IA | Índigo profundo `#3730A3` sobre `#EEF2FF`, icono de destello y texto de procedencia. El resumen tiene mayor peso tipográfico que los detalles. El motivo, las fuentes y los controles se distinguen por jerarquía y espacio. |
| Operación | Azul `#1E40AF` sobre `#EFF6FF` para búsqueda, ámbar `#92400E` sobre `#FFFBEB` para espera de escalamiento, verde `#166534` sobre `#F0FDF4` para toma confirmada. Acompañar el color con texto e icono. En facturas, el rojo `#991B1B` sobre `#FEF2F2` representa vencimiento. |
| Interacción | Foco visible, pestañas operables con teclado, objetivos táctiles de 44 px, contraste de texto normal de al menos 4,5:1 y disposición sin desbordamiento global. Respetar `prefers-reduced-motion` en espera y realce. Mantener los cambios de estado en una región accesible y evitar anuncios repetidos en las actualizaciones del stream. |

[Plan de implementación y pruebas](plan.md) · [Consola, permisos y escalamiento](../../docs/evolucion-mvp/consola-crm.md)
