# Simuladores de CRM y facturación

El CRM corre en `crm-simulator:8081/v1` y Facturación en `billing-simulator:8082/v1`. NestJS consume los 10 endpoints originales por HTTP privado. El navegador consulta NestJS con su sesión Better Auth. Las lecturas desde un caso requieren titularidad y ámbito de atención. El directorio habilita la consulta administrativa de cuentas y facturas sintéticas en modo demo.

[OpenAPI original de CRM](crm-api.yaml) · [OpenAPI original de facturación](facturacion-api.yaml)

| Servicio | Datos iniciales | Persistencia |
| --- | --- | --- |
| CRM | 20 clientes con servicios, tickets, estados, antigüedad y mora de los insumos | `claro_crm` conserva clientes, tickets, ofertas y recibos. Documentos, números, correos, nombres y seriales se proyectan como alias ficticios. |
| Facturación | 60 facturas con IDs, períodos, fechas, estados, conceptos y valores de los insumos | `claro_facturacion` conserva facturas, créditos y recibos. |
| Plataforma | Conversaciones, vinculación de titularidad, aprobaciones y proyección de efectos | La base actual de plataforma conserva su nombre, volumen y datos. |

El job `migrate` aplica las migraciones de plataforma y aprovisiona las tres bases sobre la instancia existente. Crea tres roles de aplicación y concede a cada uno acceso a su base. La carga idempotente conserva los cambios de atención. Los tickets y ofertas previamente confirmados en la plataforma se importan con la referencia original.

## Extensiones de integración

| Contrato | Comportamiento |
| --- | --- |
| CRM `POST /v1/identidades/resolver` | Recibe `{"alias":"11111"}` y devuelve únicamente `{"cliente_id":"C-1001"}`, o 404. Para el OTP simulado también sirven `22222` y `33333` o `cliente1@example.test`, `cliente2@example.test` y `cliente3@example.test`. |
| CRM `GET /v1/clientes/{clienteId}/elegibilidad-retencion` | Devuelve `eligible`, `reason` y `options[]`. Aplica tramos de antigüedad, límite de mora, historial de 12 meses y visita técnica prioritaria para fallas recurrentes. El CRM revalida antes de registrar. |
| `X-API-Key` y `X-Request-ID` | Cada servicio valida su propia clave y devuelve un ID de correlación opaco. Las solicitudes autorizadas tienen 60 usos por minuto por servicio. Un 429 incluye `Retry-After`. |
| `Idempotency-Key` y `X-Operation-Reference` | En escrituras, la misma clave y comando devuelven el recibo original. Si cambia el comando de un recibo ya registrado, la API responde 409. El BFF siempre incluye la clave. Clientes compatibles con el OpenAPI original pueden omitirla y recibir una clave nueva. |
| `GET /v1/operaciones/{clave}` | Devuelve `clave`, `referencia` y `tipo` para una escritura persistida, o 404. Las respuestas 201 de oferta y ajuste conservan su cuerpo vacío. El recibo y la escritura se guardan en una sola transacción. |
| Proyección de facturas | Listado y detalle incluyen `saldo_abierto` y `total_ajustado`. El detalle incluye `ajustes`. El saldo impago agrega vencidos y devuelve el subtotal vencido por separado. El próximo vencimiento corresponde a una factura pendiente con saldo abierto. Un crédito conserva el valor original, el estado y la fecha de pago de la factura. El simulador rechaza con 409 créditos superiores al saldo. |

La fecha de negocio es `DEMO_BUSINESS_DATE` y vale `2026-11-18` por defecto. Con `SIMULATOR_FAULT_MODE=off` las llamadas siguen el guion sin fallos inyectados. El modo `every-50` devuelve 503 en cada llamada autorizada número 50. El modo de pruebas `test` habilita `X-Simulator-Fault` con valores `503`, `timeout` y `lost-after-commit`. CI usa esos fallos en servidores efímeros en loopback.

## Operación desde la consola

- El asesor asignado abre un caso verificado. **CRM** muestra ficha, servicios, tickets, elegibilidad e historial de ofertas. **Facturación** muestra saldo, facturas, conceptos y créditos.
- La confirmación del asesor encola el comando con la cuenta, revisión del caso y una clave estable. Para registrar una oferta, el asesor confirma que el cliente aceptó la alternativa. Un ajuste que deja el acumulado por factura por encima de **COP 50.000** pasa a aprobación. Administración decide con su propia sesión. Un ajuste exactamente de COP 50.000 acumulados puede pasar directamente.
- El worker revalida el ámbito del caso antes del envío. Si llega a un resultado incierto, conserva **Pendiente de verificación**, consulta el recibo y reutiliza la clave al reintentar. El asesor ve **Confirmada** cuando existe el recibo.
- **Directorio CRM** permite a administración y superadministración consultar la cuenta en modo demo. En la pestaña **Facturación** se muestran saldo, facturas, detalle y ajustes aplicados en modo lectura.
- **Panel general** muestra por separado la disponibilidad actual, latencia de la sonda, solicitudes y errores de transporte de las últimas 24 horas. Una caída del CRM deja operativas la consulta de Facturación y la conversación.

El BFF publica lecturas en `/api/v1/cases/{id}/integrations/{crm,billing,billing/invoices/{ref}}` y lecturas y confirmaciones en `/api/v1/cases/{id}/integrations/operations`. La ficha del Directorio CRM lee `/api/v1/crm/customers/{id}/billing` y `/api/v1/crm/customers/{id}/billing/invoices/{ref}`. Administración consume `/api/v1/admin/integrations` y `/api/v1/admin/integrations/approvals`. Las respuestas de cuenta y la decisión de aprobación quedan dentro de la plataforma.

[Despliegue en Docker y Dokploy](../../infra/README.md) · [Flujos de arquitectura](../02-arquitectura-docker.md)
