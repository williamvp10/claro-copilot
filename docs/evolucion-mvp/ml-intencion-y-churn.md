# Traspaso de intención y churn a 90 días al MVP

El MVP integra dos señales de ML en la atención asistida. **Intención** sugiere el motivo del turno del cliente. **Churn** prioriza la revisión o el seguimiento según el riesgo de baja a 90 días. FastAPI sirve ambos candidatos en sombra y la plataforma presenta sus resultados como orientación privada al asesor. La confirmación y las decisiones de atención siguen a cargo del asesor y la política del flujo vigente.

## Dónde encontrar los experimentos y el código

Los dos CSV se entregan en `Insumos_Prueba_Consultor_IA/03_datos/`, junto al repositorio `claro-copilot`. El paquete es sintético. Los notebooks conservan las salidas ejecutadas y las instrucciones de reproducción. Buscan la carpeta de insumos al subir desde el directorio de trabajo y aceptan `CLARO_INSUMOS_DIR` para otra ubicación. El equipo necesita acceso a los CSV y, para reproducir la evaluación de texto sobre primeros mensajes, a `02_transcripciones/`.

| Experimento | Datos y objetivo | Resultado para el MVP |
| --- | --- | --- |
| [Clasificación de intención](../../services/ml/notebooks/comparacion_intencion.ipynb) | `tickets.csv`. Quedaron 3.796 tickets tras quitar 20 duplicados exactos. La nota del asesor, `descripcion`, predice `categoria`. Las cinco clases son soporte técnico, facturación, consulta de planes, cancelación y portabilidad. | **E5 multilingüe congelado + SVM lineal**. F1 macro **0,785** en particiones agrupadas por plantilla, frente a **0,563** de TF-IDF + regresión logística. Recall de cancelación **0,812** y precisión **0,600**. El F1 de **0,917** en las 50 transcripciones corresponde a solo 15 familias de frases. |
| [Churn a 90 días](../../services/ml/notebooks/comparacion_churn.ipynb) | `clientes_churn.csv` más historia anterior al corte desde `tickets.csv`, vinculada por `cliente_id`. Quedaron 3.000 clientes tras quitar 12 duplicados, con 451 bajas y un único corte del 31 de octubre de 2026. `churn_90d` indica que el cliente canceló algún servicio en los 90 días posteriores. | **Regresión logística L2 con foto e historial**, el mayor ROC-AUC observado en prueba, **0,716**. En la prueba de 600 clientes capturó **37 de 90** bajas al revisar los 120 scores más altos. CatBoost había liderado la selección inicial en desarrollo. La meta de referencia de churn es **0,75**. |
| [Escalamiento a segundo nivel](../../services/ml/notebooks/comparacion_escalamiento.ipynb) | `tickets.csv`. Predice `escalado` a partir del contexto de apertura y variantes con texto. | Experimento para una fase posterior. La integración de este corte cubre intención y churn. |

E5 transforma el texto normalizado en 384 dimensiones. El SVM elige una clase a partir de esos vectores y usa la separación entre las dos clases mejor puntuadas para producir su score. El notebook compara con TF-IDF + regresión logística. El campo `baseline_macro_f1` del bundle usa la clase mayoritaria por fold como referencia simple. En churn, la logística aprende a combinar variables categóricas codificadas y variables numéricas imputadas y escaladas. La evaluación de churn separa clientes de la misma foto. La generalización temporal y la calibración en atención real requieren nuevas cohortes y etiquetas maduras.

- [Preparación de datos, evaluación y exportación](../../services/ml/app/train_advisory.py)
- [Codificador E5 de revisión fija](../../services/ml/app/e5.py) y [esquema de entrada y transformaciones de churn](../../services/ml/app/churn.py)
- [Carga de artefactos y política de recomendación](../../services/ml/app/advisory.py) y [endpoints de FastAPI](../../services/ml/app/main.py)
- [Pruebas del servicio](../../services/ml/tests/test_service.py) y [contratos de plataforma](../04-contratos.md#predicción-y-observabilidad)

## Responsabilidades y contrato del corte

| Capa | Responsabilidad | Evidencia esperada |
| --- | --- | --- |
| FastAPI | `POST /internal/v1/predict-intent`, `POST /internal/v1/predict-churn`, `POST /internal/v1/intent-labels` y `GET /internal/v1/model-metrics`, con autenticación de servicio. Carga de los dos candidatos o de la versión histórica de intención. | Ambos IDs en `/readyz` del entorno de verificación y manifiestos con sus runs de MLflow. |
| Plataforma | Encolar los turnos elegibles, construir las fotos fechadas de demo y resolver la foto del titular verificado. Conservar resultados privados, confirmar supervisión y registrar el ciclo del seguimiento. | Predicción vinculada al turno, resultado de foto vinculado al titular y su corte, supervisión idempotente y seguimiento acordado antes de completarse. |
| Consola y administración | Mostrar señales y seguimiento en la ficha del asesor y al cierre. Agregar resultados offline y métricas de operación con sus denominadores. | Comparar las proyecciones privadas y públicas, completar el recorrido con el servicio real y cotejar las métricas con los eventos de prueba. |

[Encolado de turnos](../../apps/backend/src/cases.ts) · [Worker](../../apps/backend/src/worker.ts) · [Consumo de métricas](../../apps/backend/src/telemetry.ts) · [Dashboard](../../apps/backend/src/dashboard.ts)

## Reproducir los bundles y arrancar FastAPI

Desde la raíz del repositorio, `../Insumos_Prueba_Consultor_IA` debe apuntar al paquete entregado. Obtenga `model.onnx` y `tokenizer.json` de la carpeta `onnx` de la revisión E5 fijada. La carga verifica ambos SHA-256. Conserve los dos archivos juntos y ajuste `ENCODER_DIR` en el comando. [Archivos E5 de la revisión usada](https://huggingface.co/intfloat/multilingual-e5-small/tree/614241f622f53c4eeff9890bdc4f31cfecc418b3/onnx)

```bash
repo="$(pwd)"
insumos="$repo/../Insumos_Prueba_Consultor_IA"
ENCODER_DIR="/ruta/a/e5/onnx"
releases="$(mktemp -d)"

cd "$repo/services/ml"
uv sync --frozen --python 3.12
# Apuntar MLFLOW_TRACKING_URI al servidor privado para registrar los dos runs.
uv run --frozen python -m app.train_advisory \
  --tickets "$insumos/03_datos/tickets.csv" \
  --clients "$insumos/03_datos/clientes_churn.csv" \
  --encoder-dir "$ENCODER_DIR" \
  --output "$releases"

export ML_STATE_DB="$releases/state.sqlite3"
export ML_BUNDLE_DIR="$releases/intent-e5-svm-1"
export ML_CHURN_BUNDLE_DIR="$releases/churn-logistic-1"
# Cargar ML_SERVICE_TOKEN desde el secreto de desarrollo antes de arrancar.
uv run --frozen uvicorn app.main:app --port 8000
```

Para Docker Compose, el job de entrenamiento puede escribir los dos bundles directamente en el volumen. Desde la raíz, con `insumos` y `ENCODER_DIR` definidos como arriba y los archivos legibles por el contenedor, iniciar el MLflow privado y comprobar que responda antes de lanzar el job.

```bash
docker compose --env-file .env -f infra/compose.yaml --profile ml-jobs up -d mlflow
docker compose --env-file .env -f infra/compose.yaml --profile ml-jobs run --rm \
  -v "$insumos/03_datos:/input:ro" -v "$ENCODER_DIR:/encoder:ro" \
  ml-job app.train_advisory --tickets /input/tickets.csv --clients /input/clientes_churn.csv \
  --encoder-dir /encoder --output /models/releases
```

Configurar `ML_RELEASE_VERSION=intent-e5-svm-1`, `ML_CHURN_BUNDLE_DIR=/models/releases/churn-logistic-1` y la URL privada `ML_API_URL=http://ml:8000` para plataforma. Inyectar el mismo `ML_SERVICE_TOKEN` en servidor y cliente interno. Al iniciar con el perfil `ml`, la API monta los bundles en lectura y conserva los datos operativos de intención en el volumen de SQLite. El job rechaza reemplazar un bundle existente. `train_advisory` genera `manifest.json` y `evaluation.json` por versión. El tablero enlaza runs solo cuando el bundle registra ID de run y experimento. [Configuración de Compose](../../infra/compose.yaml) · [Guía del servicio](../../services/ml/README.md#candidatos-de-intención-y-churn)

## Cómo debe quedar la integración

### Intención en el turno

1. Mantener el trabajo asíncrono del worker. Analizar el primer turno que expresa un motivo y los cambios de motivo que lleguen en un turno posterior del cliente. Excluir datos de verificación, mensajes del asesor y mensajes generados por el agente. Usar el texto saneado y la clave de idempotencia del turno.
2. Correlacionar el resultado con `case_id`, turno y revisión vigentes. Si la titularidad o la asignación cambian y permanece el mismo turno elegible, proyectar su clasificación bajo la revisión vigente y las reglas de acceso actuales. Guardar referencia, clase, versión y recomendación. Publicarlo en el canal de eventos de la ficha del asesor autorizado. Descartar resultados tardíos para turnos sustituidos. Ante timeout o 503, continuar la atención y dejar el evento operativo de indisponibilidad.
3. Mostrar una etiqueta como **Intención sugerida · Facturación** con una acción como **Revisar el cobro**. Si la recomendación es `clarify_intent`, sugerir una pregunta aclaratoria. Si es `confirm_cancellation_intent`, pedir al asesor confirmar el motivo con el cliente. La consola envía `prediction_id`, `label` y un `event_id` estable a `POST /api/v1/cases/:id/ml/intent-label`. NestJS valida propietario y predicción vigente, registra una decisión final por predicción y la sincroniza mediante outbox con `/internal/v1/intent-labels`. Una decisión aceptada conserva su vínculo histórico al turno aunque avance la conversación. Los reintentos del mismo comando conservan el mismo evento.
4. Mantener la decisión efectiva de enrutamiento en el flujo actual del agente y las reglas de dominio. La confirmación de un motivo permite consultar la elegibilidad y preparar una propuesta. La ejecución de ofertas, ajustes o visitas sigue el flujo autorizado de aprobación y recibo.

El score de intención es una separación de clases sin calibrar. La recomendación de sugerir una categoría usa cortes por clase que buscaron al menos 90 % de precisión observada en la evaluación agrupada, con un mínimo de 30 predicciones y tres plantillas. Son parámetros de sombra hasta validarlos con primeros mensajes. **La cancelación siempre requiere confirmación**, con independencia del score.

### Churn en la ficha y al cierre

1. Después de verificar al titular, resolver desde plataforma su referencia y el permiso del asesor. Consultar una foto fechada y calcular el historial con los datos disponibles hasta ese corte. El entrenamiento usa días completos, con el límite exclusivo al inicio del día siguiente. Llamar a FastAPI desde servidor. La ficha recibe prioridad, recomendación, fecha de corte y versión. Consultar la misma señal al cerrar. Recalcular si se dispone de una foto posterior y consistente.
2. Proveer desde CRM, facturación, telemetría y el historial del cliente las variables que pide `ChurnPrediction`. Entre ellas están tipo de servicio, planes, cargo mensual, antigüedad, mora, caídas, uso, NPS y ofertas previas. Las ventanas de 30 y 90 días requieren conteos de las cinco categorías y de los casos con categoría aún indisponible. Los conteos deben reconciliar con `tickets_90d` y con `dias_desde_ultimo_ticket`. Mantener la distinción entre cero medido, dato faltante permitido y campo inaplicable.
3. La población de los mocks es distinta de la de entrenamiento. El seed de demo construye fotos para C-1001, C-1004 y C-1007 con corte del 18 de noviembre de 2026, usando los servicios activos, mora, cargo, antigüedad, tickets y ofertas del fixture CRM. Un ticket abierto aporta historial en `categoria_no_disponible`. Usar un método de pago sintético donde el CRM carece del campo requerido. Mantener en `null` NPS, caídas y uso si el fixture no los mide. Las fotos están identificadas como sintéticas y requieren `DEMO_MODE=true`. Para una cuenta sin foto válida, mostrar **Seguimiento a 90 días · Sin datos disponibles** y continuar el caso. El payload interno contiene la fecha y variables del modelo. La referencia de cuenta se conserva dentro de NestJS.
4. En prioridad alta, revisar fallas repetidas, reclamos y compromisos después de resolver el motivo principal. Al cerrar, acordar con el cliente el seguimiento de cualquier pendiente y registrar fecha y responsable. En prioridad media, verificar pendientes y confirmar el próximo paso. En prioridad habitual, seguir el cierre estándar. Si el cliente expresa intención de baja, usar el flujo de retención aprobado y su comprobación de elegibilidad.

El seguimiento usa `POST /api/v1/cases/:id/ml/follow-up` con `case_revision`, `event_id` y `status`. Para `agreed` requiere fecha de compromiso y una banda disponible para el titular. El servidor asigna como responsable al asesor que acuerda. Para `completed` requiere un acuerdo del mismo caso y titular. El asesor asignado puede completarlo desde la ficha de un caso cerrado. Una transacción permite un seguimiento por caso y titular y protege los reintentos concurrentes. Este registro es interno y queda asociado a la versión y corte que orientaron al asesor.

| Banda de churn | Regla en `churn-logistic-1` |
| --- | --- |
| Alta | Score desde **0,2152**, percentil 80 de desarrollo. |
| Media | Score desde **0,1214** y por debajo de P80. |
| Habitual | Score por debajo de P50. |

P80 representa una posición relativa en la cohorte. En la prueba reservada, el corte fijo P80 marcó 118 de 600 clientes y capturó 36 de 90 bajas. El ejercicio con un cupo exacto de 120 capturó 37. Mostrar el nombre de la banda al asesor y su fecha de corte. El score sin calibrar queda como dato técnico. [Esquema de la foto](../../services/ml/app/churn.py)

### Dashboard y operación

- **Ficha privada.** Mostrar **Intención sugerida** con Confirmar, Corregir o Aclarar según corresponda. Mostrar **Seguimiento a 90 días** con banda, fecha de corte y próxima acción disponible. El titular y el asesor asignado determinan el ámbito de acceso.
- **Administración.** Mantener la calidad offline junto a su muestra, versión y evaluación. Para intención operativa, usar la etiqueta registrada por predicción dentro de la cohorte de predicciones proyectadas en el período. Exponer cuántas se confirmaron, cuántas se corrigieron, cuántas se sincronizaron y cuál es la cobertura. Para churn, cobertura de fotos = casos con entrada válida / casos verificados evaluados en la ventana. Una foto válida cuenta para cobertura aunque FastAPI esté indisponible. Contar el último intento de cada caso y publicar la distribución de bandas y los resultados sin datos, inválidos o indisponibles. Contar seguimientos acordados y completados una vez por registro. Los filtros del tablero se aplican al período en Bogotá y a canal y categoría cuando existen. Las métricas offline conservan su propia cohorte.
- **Activación.** Cargar ambos modelos en sombra y habilitar la ficha por ambiente o grupo de piloto. Verificar que el flujo principal continúe si ML está indisponible. Para revertir, seleccionar el bundle previo de intención y retirar la configuración de churn del perfil. Conservar la trazabilidad del ambiente y la versión observada.

## Criterios de aceptación del traspaso

- [x] Ejecutar los dos notebooks en una copia limpia de trabajo con los insumos del reto y regenerar los bundles con `app.train_advisory`.
- [x] Comprobar ambas versiones en `/readyz`, autenticación interna y consulta de las dos evaluaciones offline desde Administración.
- [x] Comprobar la confirmación obligatoria de una sugerencia de cancelación, el descarte de un turno sustituido y la sincronización idempotente por `prediction_id`.
- [x] Comprobar una foto válida, una cuenta sin foto, rechazo de fotos incoherentes y continuidad de atención con FastAPI fuera de servicio. Comprobar que otro operador y el cliente web carecen de acceso a la ficha.
- [x] Acordar, mostrar por SSE y completar un seguimiento tras cerrar el caso. Repetir ambos comandos y verificar un solo registro de cada transición. Comprobar la vista de cierre y el tablero en Chrome.
- [x] Reproducir **F1 macro 0,785** y **ROC-AUC 0,716**, con 37 de 90 bajas capturadas al revisar 120 de los 600 casos de prueba de churn.

### Evidencia local del corte

| Modelo | Versión servida | Run de entrenamiento comprobado en MLflow |
| --- | --- | --- |
| Intención | `intent-e5-svm-1` | `6e366fd978b54da48e5cdc123c621929` |
| Churn | `churn-logistic-1` | `8a4bc240df33443f9daafb1e70983c30` |

Los dos runs se comprobaron como `FINISHED` y contenían modelo, manifiesto y evaluación. La prueba integrada ejercita NestJS, PostgreSQL, FastAPI y las APIs mock con la cuenta C-1001 y una verificada sin foto. Desde la raíz, con un entorno de prueba sembrado y los dos bundles en `/readyz`, ejecutar `node apps/backend/test/ml-advisory-e2e.mjs`. Las variables de conexión, los usuarios `DEMO_ASESSOR_*`, `DEMO_ADMIN_*` y `DEMO_N2_*` y sus permisos deben corresponder a esa instancia. La prueba crea casos y eventos de demo. [Prueba integrada](../../apps/backend/test/ml-advisory-e2e.mjs) · [Pruebas de FastAPI](../../services/ml/tests/test_service.py)

La verificación corresponde al entorno local. Antes de usar las señales en un piloto operativo se necesitan primeros turnos etiquetados, una cohorte posterior de churn y revisión de los umbrales. Las metas de F1 macro 0,80 y ROC-AUC 0,75 siguen por alcanzar.
