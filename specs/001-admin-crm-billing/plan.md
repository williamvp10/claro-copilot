# Plan de integración administrativa de CRM y Facturación

## Contexto técnico

TypeScript, NestJS, Next.js, Better Auth y contratos Zod compartidos. Compose inicia las APIs mock privadas y PostgreSQL. El bootstrap existente carga 20 clientes CRM y 60 facturas. En la pila de referencia la cuenta de administración tiene `admin` y `supervisor`.

## Decisiones y principios

- Ampliar en modo demo el acceso de `admin` al catálogo. Separar ese permiso del alcance de `case_history`, de las conversaciones y de las escrituras reservadas a superadministración. Después de desactivar el modo demo, superadministración conserva el catálogo de CRM y se deshabilita la nueva lectura de Facturación por cuenta.
- Los simuladores siguen siendo la fuente de verdad. Los puertos del CRM y Facturación son privados. El frontend usa el proxy de Next.js al BFF y la sesión existente.
- Usar el mismo contrato de lectura de saldo e invoice detail que en los casos. La vista administrativa proyecta los ajustes sin el identificador interno del aprobador.

## Datos y contratos

- `GET /api/v1/me` agrega `can_read_mock_billing`, calculado por el backend.
- `GET /api/v1/crm/customers/:id/billing` devuelve `BillingView`. Un cliente sin registro en Facturación devuelve 404. Un fallo del proveedor devuelve 503.
- `GET /api/v1/crm/customers/:id/billing/invoices/:ref` devuelve `InvoiceDetail`. La factura inexistente o ajena a la cuenta devuelve 404.
- Las rutas nuevas devuelven 401 sin sesión y 403 sin permiso. Reutilizan los validadores de identificadores y operan sobre los registros existentes, sin cambios de esquema.

## Implementación y pruebas

- Reutilizar las lecturas del adaptador REST y los componentes de saldo y detalle de factura. Mantener la selección enlazada a la ficha activa y montar el panel al abrir su pestaña.
- Extender las pruebas de evolución con las identidades ya sembradas. Validar el modo demo desactivado en un proceso separado sobre la base aislada, con la misma configuración de Better Auth.
- Compilar, levantar un proyecto Compose aislado y verificar el flujo en navegador. Actualizar API y web de `claro-demo-local` con la imagen validada y la etiqueta del demo. Conservar las imágenes anteriores, los volúmenes y la configuración.
