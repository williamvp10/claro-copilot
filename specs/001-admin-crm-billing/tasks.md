# Tareas de integración administrativa de CRM y Facturación

## Preparación

- [x] T001 Crear el worktree e inicializar Spec Kit para el feature.
- [x] T002 Definir el permiso compartido de Facturación por cuenta y su proyección en `/api/v1/me`.

## US1 · Directorio CRM

- [x] T003 [US1] Habilitar el catálogo y la ficha para la administración de la demo, respetando el ámbito del historial.
- [x] T004 [US1] Comprobar búsqueda, paginación, enmascarado y roles en `apps/backend/test/evolution-e2e.mjs`.

## US2 · Facturación

- [x] T005 [US2] Añadir las dos lecturas de Facturación y comprobar pertenencia de factura.
- [x] T006 [US2] Montar la pestaña en la ficha con estados de carga, cuenta sin registro, error y reintento.
- [x] T007 [US2] Comprobar las rutas con las sesiones de prueba, modo demo desactivado y facturas de otra cuenta.

## Entrega

- [x] T008 Actualizar el diseño de la consola y ejecutar la compilación y las pruebas en Compose aislado.
- [x] T009 Verificar el recorrido en navegador, incluida una respuesta tardía y la recuperación de una caída.
- [x] T010 Actualizar API y web del demo local y verificar el recorrido con los datos persistidos.

**Dependencias** T002 precede a T003 y T005. T005 precede a T006 y T007. T008 y T009 preceden a T010. Después de T002, el catálogo y las lecturas de Facturación pueden desarrollarse en paralelo.

## Verificación del 2026-11-24

- Compilación Docker y `pnpm test` completados.
- Suites de plataforma, MCP y evolución ejecutadas sobre PostgreSQL y simuladores aislados. Evolución comprobó también una instancia de API con el modo demo desactivado.
- Playwright verificó C-1001, cambio rápido de cuenta, cuenta sin registro y recuperación tras reiniciar Facturación.
- En `claro-demo-local` se recrearon API y web. La prueba final encontró 20 clientes y tres facturas para C-1001. La imagen anterior quedó etiquetada como `claro-copiloto:local-demo-pre-admin-crm-billing`.
