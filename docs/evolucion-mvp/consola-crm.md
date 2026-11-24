# Consola de atención, CRM y escalamiento

## Navegación y experiencia

- **Espacio de trabajo plegable.** Botón con texto accesible y `aria-expanded`. En escritorio alterna menú completo y barra de iconos; en móvil abre un panel con cierre por Escape y retorno de foco. Conservar preferencia de escritorio por operador en el navegador y mantener visible la forma de reabrirlo. El contenido toma el ancho libre. Las rutas, filtros y caso abierto sobreviven a plegar el menú.
- **Bandeja y ficha.** En escritorio se mantienen bandeja, diálogo y ficha; en ancho reducido se navega entre ellas. La ficha privada presenta resumen, hechos, fuentes, acciones pendientes y **«Respuesta sugerida»**. Su botón **«Usar en respuesta»** llena el editor. Si el asesor ya escribió, se ofrece insertar o reemplazar. Enviar siempre requiere la acción explícita del asesor por el canal del caso. Registrar uso, edición y envío sin guardar copias del texto para métricas.
- **CRM integrado.** Una ruta de consola separada contiene directorio autorizado, ficha con datos enmascarados, servicios, tickets, ofertas e historial de casos. Desde una ficha se puede abrir el caso asociado o iniciar uno con el contacto habilitado. En modo demo, administración y superadministración consultan Facturación desde una pestaña de la cuenta. La pestaña de solo lectura muestra saldos, vencimientos, facturas, conceptos y ajustes aplicados. El flujo de solicitud o aprobación de ajustes permanece ligado a los casos. Ni el navegador ni las pantallas incrustan las páginas privadas de las APIs. NestJS proyecta REST y estados de salud, error, carga o falta de permisos bajo el encabezado «Integraciones mock».
- **Seguimiento.** La ficha del caso muestra nivel actual, propietario, motivo, destino, tiempo en cola, eventos y recibos. El historial operativo del CRM enlaza el caso y el ticket original; las transiciones se registran con hora del servidor y metadatos saneados.

### Recorrido desde el CRM integrado

1. **Buscar.** El operador abre CRM desde el menú, filtra por referencia o alias permitido y selecciona un cliente. La ficha identifica la API mock de origen, distingue carga, error y consulta completada, y muestra únicamente los campos autorizados.
2. **Dar seguimiento.** Desde la cuenta, abre un caso existente y ve su propietario, equipo, estado de la cola y último efecto confirmado. Las pestañas permiten consultar servicios, tickets y ofertas en CRM y revisar saldo, facturas y ajustes en Facturación. Si una API falla, se conserva el hilo y el resultado de la otra.
3. **Escalar.** N1 selecciona motivo y cola desde CRM o la ficha del caso. Ambos accesos llaman el mismo comando de escalamiento. Ventana de espera, paquete de contexto y toma exclusiva se conservan en el expediente. Supervisión puede reasignar con motivo registrado.
4. **Gestionar.** Superadmin abre Clientes u Operadores para alta, cambios de estado y asignación de especialidades. Cada acción presenta el resultado confirmado o pendiente y permite consultar su auditoría. Abrir una conversación privada requiere el permiso y ámbito de atención correspondiente.

## Roles y administración

Los roles nuevos son acumulativos solo cuando se concede cada permiso de forma explícita. Una cuenta con privilegios administrativos necesita una capacidad de atención y un caso asignado para abrir conversaciones privadas.

| Rol | Acceso y acciones |
| --- | --- |
| Asesor N1 | Atiende casos asignados, consulta la ficha del titular verificado, usa y edita borradores, confirma acciones permitidas y solicita escalamiento. Ve el estado de sus traspasos tras perder la asignación. |
| Asesor N2 | Ve filas mínimas de su cola por especialidad. Al tomar un caso recibe hilo, fuentes, hechos, resumen, acciones, recibos y pendientes. Puede atenderlo, resolverlo o derivarlo a supervisión. |
| Supervisor | Gestiona colas, reasigna, recibe derivaciones de política y aprueba ajustes cuando corresponde. Accede al caso privado al recibirlo, reasignárselo o abrir una revisión auditada con motivo y alcance. |
| Admin operativo | Consulta Panel general, las seis vistas, salud de integraciones y evaluaciones. En modo demo busca clientes del catálogo y consulta CRM y Facturación en modo lectura. Gestiona candidatas y activa solo revisiones aprobadas. Puede mantener la capacidad de supervisor ya usada para ajustes en la demo. |
| Super admin | Gestiona altas y estado de operadores, roles, especialidades y disponibilidad; busca y administra clientes del mock con permisos de directorio. Consulta auditoría y puede reasignar por motivo operativo. El acceso a una conversación privada usa alcance por caso. |

**Acciones de superadministración.** Invitar/cambiar estado de asesor, asignar N1/N2 y especialidades, gestionar asignación y consultar bitácora. El catálogo de clientes permite alta, actualización de contacto sintético y cambio de estado con confirmación, motivo y recibo. Las mutaciones nuevas se implementarán como extensiones explícitas del CRM mock y se mantendrán separadas de las diez operaciones OpenAPI originales. Facturación conserva su fuente de verdad para saldos y ajustes. La plataforma conserva cuentas y roles internos. Revocar permisos quita acceso al renovar la sesión y también al revalidar una operación en curso. Proteger la última cuenta de superadministración, invalidar sesiones afectadas y auditar altas de privilegios. La migración convierte los `asesor` actuales en N1 y preserva el permiso de aprobación del `admin` actual. Provisionar N2, supervisor y superadmin como identidades de demo separadas.

## Escalamiento y continuidad

| Situación | Destino |
| --- | --- |
| LOS rojo durante más de 10 minutos, más de tres reinicios sin solución en la semana o daño físico | N2 Soporte técnico. Para fallas recurrentes se conserva la política comercial de visita prioritaria. Un ticket registrado conserva la visita como pendiente de coordinar. |
| Disputa técnica de facturación o de portabilidad que excede el alcance de N1 | Cola N2 correspondiente, previa confirmación del asesor. Las colas configurables del MVP son Soporte técnico, Facturación, y Comercial y portabilidad. |
| Vulnerabilidad, riesgo, fraude o suplantación, acciones legales, datos de terceros o falta de evidencia o confianza | Supervisor según política. El bot deriva con un mensaje seguro y el resumen evita datos sensibles o de terceros. |
| Ajuste superior a COP 50.000 acumulados por factura | Aprobación de supervisor, conservando el caso con el asesor salvo que también haya un escalamiento de atención. |

**Transiciones.** `solicitado → en_cola → tomado → resuelto` con `cancelado` para solicitudes pendientes y reasignaciones auditadas. N1 conserva atención durante la espera. Tomar el escalamiento adquiere la asignación de forma atómica, aumenta `case_revision` y activa SSE de la cola y del caso. Dos operadores no pueden tomarlo. Al perder asignación, N1 conserva seguimiento de estado con datos mínimos. Si la cola carece de especialistas disponibles, el caso queda visible en supervisión y se mantiene la conversación con N1. Usar el SLA de respuesta de supervisión de 10 minutos y los tiempos de visita de 24/48 horas como indicadores separados de cola.

**Paquete de traspaso.** `case_id`, canal, categoría, motivo y destino, titularidad vigente, referencia al hilo y a la ficha, fuentes versionadas, hechos permitidos, acciones en curso, recibos, sugerencia y próximo paso. Versionar el paquete por revisión. Mostrar primero un resumen mínimo de cola, y cargar el paquete por referencia tras confirmar el nuevo propietario. El historial queda en el mismo caso. La plataforma revisa titularidad y autorización; nunca se incluyen OTP, tokens, datos completos de contacto ni resultados con permisos revocados.

El asesor puede usar un borrador empático desde la ficha de cualquier especialidad donde tenga permiso de atención. La sugerencia incluye reconocimiento del inconveniente cuando corresponde, hechos verificados y un siguiente paso concreto. Después del traspaso se vuelve a proyectar para el nuevo propietario. Si cambian los hechos o el caso, marcar el borrador obsoleto y conservar el texto que el asesor ya escribió. Para atribuir un envío al borrador, el servidor verifica el `run_id`, la revisión y el turno del borrador. Registrar aplicación, edición, envío y valoración como señales distintas. La edición se registra como señal, sin copiar el contenido editado a la telemetría.

**Reglas para tomar y reasignar.** Antes de cambiar el propietario, el servidor comprueba caso abierto, revisión actual, operador activo y disponible y permiso para el destino. La consola de supervisión ofrece un selector de operadores disponibles del destino. Si el caso requiere otra especialidad, se registra el cambio de destino y su motivo. La lista para supervisión solo expone identificador de operador, nombre y especialidades disponibles. Tras la toma, la ficha vuelve a cargar los permisos vigentes, evidencia citable, recibos y pendientes. Un borrador pendiente se presenta ligado a la nueva revisión cuando se haya reproyectado. El propietario anterior conserva el estado del traspaso y pierde el acceso a la conversación.

## Interfaces propuestas

| Interfaz | Propósito |
| --- | --- |
| `GET /api/v1/crm/customers` y `GET /api/v1/crm/customers/:id` | Directorio paginado y ficha proyectada con ámbito. Un asesor ve cuentas ligadas a casos autorizados. En modo demo, administración puede consultar el catálogo y sus fichas con el ámbito de historial habitual. |
| `GET /api/v1/crm/customers/:id/billing`, `GET /api/v1/crm/customers/:id/billing/invoices/:ref` | Saldo y detalle de las facturas de esa cuenta. Requieren modo demo y capacidad de administración o superadministración. |
| `POST /api/v1/admin/customers`, `PATCH /api/v1/admin/customers/:id` | Comandos de superadmin a las extensiones de CRM mock. Usar motivo, revisión esperada, idempotencia y recibo. |
| `GET/POST /api/v1/admin/operators`, `PATCH /api/v1/admin/operators/:id` | Identidad, estados, roles y capacidades, con autorización por operación. |
| `POST /api/v1/cases/:id/escalations`, `GET /api/v1/escalations`, `POST /api/v1/escalations/:id/claim` | Solicitar, listar y tomar. El comando de solicitud exige `destination`, `reason_code`, `case_revision` e `idempotency_key`. Reasignación, cancelación y resolución son transiciones auditadas. |
| `CaseSnapshot.card.suggested_reply` | Borrador privado ligado a `run_id`, `turn_id` y `case_revision`, con estado, texto, fuentes y advertencias estructuradas. Queda fuera de la proyección pública para web y Telegram. |

[Diseño de plataforma existente](../plataforma/diseno.md) · [Contrato actual de los mocks](../openapi/simuladores.md) · [Flujos y pruebas](arquitectura-y-aceptacion.md)
