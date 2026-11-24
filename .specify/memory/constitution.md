# Principios de Claro Copiloto

## Fuente de verdad

CRM y Facturación mock conservan sus registros y operaciones. La plataforma
conserva las identidades internas, las conversaciones y las decisiones del caso.

## Acceso por operación

NestJS comprueba la sesión y el alcance de cada operación. Los endpoints de
atención consultan información de una cuenta cuando el operador tiene el alcance
del caso y se ha verificado al titular. La consola administrativa usa sus
permisos explícitos y presenta proyecciones con los campos autorizados.

## Límites de despliegue

Next.js presenta las vistas y llega a las APIs privadas a través de NestJS.
Cada simulador usa una clave y una base de datos propias. Los cambios del demo
se validan con datos sintéticos y se aplican conservando sus datos persistidos.

## Verificación

Los cambios en permisos y contratos HTTP se comprueban con las suites de
integración del monorepo. Los cambios en el recorrido del operador se verifican
en la consola con el rol correspondiente.

**Versión** 1.0.0 · **Fecha** 2026-11-24
