# Insumos y fixtures del MVP

Usar el paquete original de la prueba como fuente para desarrollo local y staging. Los nombres indicados son rutas dentro del material autorizado. El repositorio describe su uso para que cada frente prepare los mismos escenarios.

[Arranque](01-arranque.md) · [Contratos](04-contratos.md) · [Calidad y release](06-calidad-y-release.md)

## Material del reto

| Material | Uso |
| --- | --- |
| `Prueba_LT_IA_Senior_v2.docx` | Objetivos, entregables, restricciones y metas de evaluación. |
| `Insumos_Prueba_Consultor_IA/README.md` | Inventario y fecha de referencia del caso, 18 de noviembre de 2026. |
| Convención de entorno | Usar fixtures y credenciales de prueba. Incorporar material por un canal autorizado, con rutas configurables y sin credenciales en el repositorio. |

## Documentos y transcripciones

- `01_documentos/` contiene catálogo, manuales, FAQ, contratos, políticas y correos. La ingesta conserva fuente, versión y vigencia. Clasificar visibilidad antes de recuperar para Telegram.
- `02_transcripciones/` contiene 50 transcripciones, su índice CSV y 3 WAV. Se usan para conocer patrones de atención, validar transferencia de intención y demostrar transcripción. Sanear identificadores antes de indexar, evaluar o exportar trazas.
- `06_actualizaciones/LEEME.md` y el catálogo v2 describen la prueba de reindexación. Mantener el golden al 18 de noviembre de 2026 y ejecutar un caso de vigencia de v2 desde el 1 de diciembre de 2026.

## Políticas y contratos

| Ruta dentro de los insumos | Responsabilidad |
| --- | --- |
| `01_documentos/contratos_politicas/Politica_Retencion_Clientes.docx` | Reglas de elegibilidad, ofertas y visita prioritaria por recurrencia. |
| `01_documentos/contratos_politicas/Politica_Escalamiento_Atencion.docx` | Escalamiento a supervisor y N2, y manejo de datos del titular. |
| `04_apis/crm-api.yaml` | Contrato original de cliente, servicios, tickets y registro de oferta. |
| `04_apis/facturacion-api.yaml` | Contrato original de facturas, saldo y ajustes. |
| `04_apis/datos_mock/` | Fixtures del mock de CRM y facturación para lecturas y escrituras aprobadas. |

El adaptador de plataforma fija la base URL de cada API y conserva sus paths, esquemas y `operationId`. El mock carga fixtures de forma idempotente por ambiente.

### Fixtures para las dos modalidades

En el golden, GQ-25 corresponde a la cuenta C-1001 y requiere cruzar CRM con facturación. GQ-26 y GQ-27 combinan el CRM de C-1004 y C-1007 con la política de retención. Preparar por separado el estado de la conversación, la ruta del chat y la asignación del asesor para cada escena. Reiniciar el estado mutable del mock entre ensayos, conservando las escrituras durante la prueba de idempotencia. [Resultados esperados y origen de cada chat](06-calidad-y-release.md#tres-casos-de-la-demo)

## Datos de ML

- `03_datos/tickets.csv` aporta 3.816 filas para clasificar intención con `descripcion → categoria`. El pipeline deduplica antes de separar por grupos de plantillas.
- `03_datos/clientes_churn.csv` aporta 3.012 filas para exploración de churn. El modelo operativo de este MVP es intención en sombra.
- `03_datos/diccionario_datos.md` documenta campos, etiquetas y cortes. Las características y resultados de diagnóstico quedan en el [diseño de ML](ml/diseno.md#diagnóstico-del-clasificador).

## Evaluaciones

- **Golden del reto.** `05_evaluacion/golden_dataset.jsonl` o su CSV equivalente contiene 30 casos. Mantener una copia de referencia congelada y registrar su versión al ejecutar.
- **Suite complementaria de trabajo.** `evals_atencion.jsonl`, generada durante el diseño, contiene 19 casos multietapa. Se prepara como input del runner fuera de esta entrega documental. Los escenarios, el formato y las aserciones se describen en [atención, prompts y Evals](agente/atencion-prompts-y-evals.md#evals-a-construir).
- **Runner semántico.** Implementar el [contrato de Jev](agente/jev-evals.md#contrato-de-implementación-del-evaluador). Las Evals reciben observaciones saneadas. La traza de ejecución y el contador de efectos aportan las comprobaciones deterministas.
