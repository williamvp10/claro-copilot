# Especificación de la integración administrativa de CRM y Facturación

**Rama** `feature/admin-crm-billing` · **Fecha** 2026-11-24

## Historias y criterios de aceptación

### US1 · Consultar el Directorio CRM (P1)

Como administrador de la demo quiero buscar clientes del mock y consultar su ficha para verificar los datos ya cargados.

1. Dada una sesión de administración en modo demo, al abrir el directorio el filtro superior permite ver la primera página del catálogo y buscar por nombre o identificador. Al elegir un resultado, la lista se cierra y la ficha usa el ancho disponible.
2. Al seleccionar C-1001 se muestran su ficha, servicios, tickets e historial según el alcance del operador. Cada servicio destaca el plan, la mensualidad y el estado; cada ticket muestra categoría, referencia, fecha y estado. Las ofertas aparecen cuando existen registros. La API mantiene enmascarados el correo y el teléfono.
3. Un asesor sigue viendo sus cuentas verificadas y asignadas. El alta y la edición desde el Directorio CRM requieren superadministración. La consulta administrativa de una cuenta conserva el control de acceso a sus conversaciones e historial. [Alta propuesta desde un caso de atención](../002-atencion-asistida/spec.md#datos-del-cliente)

### US2 · Consultar Facturación por cuenta (P1)

Como administrador o superadministrador de la demo quiero consultar el saldo y las facturas de una cuenta desde su ficha, aunque no tenga un caso asignado.

1. Al abrir Facturación de C-1001 se muestran el saldo, los vencimientos y las tres facturas cargadas. Al abrir una factura se muestran conceptos y ajustes aplicados en modo lectura.
2. Al pedir una factura de otra cuenta se obtiene el mismo resultado que al pedir una factura inexistente. Una sesión sin permiso queda fuera de esta consulta.
3. Una cuenta recién creada en CRM que todavía no existe en Facturación presenta un estado informativo. Ante una caída, Facturación presenta un error con reintento y CRM sigue accesible.
4. Al cambiar rápidamente de cliente o factura, una respuesta tardía de la selección anterior nunca se muestra como parte de la selección vigente.

## Requisitos funcionales

- **FR-001** El catálogo completo de CRM se abre a la capacidad de administración durante la demo. Superadministración conserva sus permisos existentes de directorio y gestión.
- **FR-002** La lectura de Facturación por cuenta exige una sesión activa con capacidad de administración o superadministración y modo demo activo.
- **FR-003** La consola comunica el acceso a la pestaña a partir de la sesión. Cada consulta de Facturación comprueba el permiso y el detalle comprueba la pertenencia de la factura.
- **FR-004** Los simuladores son la fuente de los registros. La plataforma conserva los permisos de conversación, la titularidad por caso y el flujo de ajustes.
- **FR-005** La ficha conserva una selección coherente durante carga, error, reintento y cambio de cuenta o factura.

## Criterios de éxito

- Un administrador de la demo encuentra C-1001 desde el catálogo y abre sus tres facturas sin crear un caso.
- La suite integrada comprueba las restricciones por sesión, modo y pertenencia.
- La validación en navegador cubre el caso exitoso, la cuenta sin facturación, la caída de Facturación y una respuesta tardía.

## Ampliación propuesta del demo

- La cuenta **Administración** hereda la gestión del Directorio CRM y los otros permisos administrativos del demo conforme a [AT-09](../002-atencion-asistida/spec.md#at-09--una-cuenta-de-administración-en-el-demo). El control por cuenta, conversación y titularidad se comprueba en el backend.
- CRM conserva la oferta aprobada y aceptada, y Facturación conserva la programación y los descuentos efectivamente aplicados a cada factura. El detalle de cada ciclo muestra el servicio, cargo fijo base, porcentaje, descuento y cargo neto. La vista de Directorio CRM consulta el estado dentro del alcance autorizado. [AT-07 y pruebas de retención](../002-atencion-asistida/plan.md#pruebas-de-aceptación)
