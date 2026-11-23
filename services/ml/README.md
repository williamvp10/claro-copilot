# Intent classifier

Private service. `ML_SERVICE_TOKEN` is required for `/internal/v1/*` using Bearer authentication; expose health endpoints only on a private network. `ML_BUNDLE_DIR` points to an approved, read-only version directory and `ML_STATE_DB` to a writable persistent SQLite file. SQLite requires one host and a persistent volume; do not share it over a network filesystem. The service fails readiness without credentials, valid state and a verified model. Only derived features and hashes, never input text, are persisted.

Train with `python -m app.train /path/to/tickets.csv`; set `MLFLOW_TRACKING_URI` and credentials appropriate to the private tracking server. CSV must provide `descripcion,categoria`; five classes and grouped test coverage are required. Set `GIT_SHA` for traceability. Conflicting template groups are retained together in each fold and logged as hashes and label counts for review; excluding all conflicts from the supplied data removes entire classes. No conflict exclusions are applied. The pipeline logs an MLflow run and registers a numeric version with candidate alias.

Release with `python -m app.release VERSION /models/releases/VERSION` and `ML_IMAGE_DIGEST` set. The version must be numeric, destination must not exist, and publication validates the bundle before an atomic rename. Mount the selected release read-only at `ML_BUNDLE_DIR`. MLflow is not needed during serving. Protect the release volume and manifest from tampering: checksum detects corruption but is not a cryptographic signature. Use the same pinned runtime image for training, release and serving.

`python -m app.drift` writes a report to the state database. This initial implementation uses a clearly identified score/OOV heuristic, not Evidently: it requires three seven-day windows with 100 observations each and reports review only when both recent windows differ from the preceding reference. It is not a substitute for a curated conversational reference. Until sufficient data exists the status is `sin referencia`. Schedule this command separately, not in the API process. Offline grouped quality is returned from the checksum-verified release evaluation; online quality uses the latest received supervised label per prediction and includes its sample size.

Run locally with `uv sync --frozen` then `uv run uvicorn app.main:app --port 8000`; tests with `uv run pytest`. No training data or model artifacts should be committed.

Training registers a custom `claro_skops` model directory with MLflow signature and synthetic input example; the release resolver validates and loads it using the reviewed allowlist.

## Candidatos de intención y churn

El servicio también carga **E5 multilingüe + SVM lineal** para intención y **regresión logística L2 con historial** para churn. Los dos usan los candidatos de los notebooks y devuelven recomendaciones para revisión humana en modo sombra.

Prepare los archivos ONNX de [multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small/tree/614241f622f53c4eeff9890bdc4f31cfecc418b3/onnx) para la revisión fijada. El entrenamiento y la carga validan los checksums contra los archivos de esa revisión. Dentro de `services/ml`, ejecute:

```bash
uv run --frozen python -m app.train_advisory \
  --tickets /ruta/03_datos/tickets.csv \
  --clients /ruta/03_datos/clientes_churn.csv \
  --encoder-dir /ruta/e5/onnx \
  --output /ruta/releases
```

El comando crea `intent-e5-svm-1` y `churn-logistic-1` con métricas, versión y huellas de los datos. Si `MLFLOW_TRACKING_URI` está configurado, registra un run de entrenamiento por candidato en `claro-intent-advisory` y `claro-churn-advisory`; los manifiestos guardan los identificadores de run y experimento. Se registran métricas agregadas, huellas, modelo serializado, evaluación y manifiesto, sin filas ni textos de entrada. Los archivos del codificador E5 no se suben a MLflow y siguen siendo necesarios junto al bundle. Un fallo de tracking configurado detiene el entrenamiento; sin esa variable no se contacta MLflow y el comportamiento de los bundles no cambia. Monte ambos en solo lectura. En ejecución local configure `ML_BUNDLE_DIR` y `ML_CHURN_BUNDLE_DIR` con los directorios de cada artefacto. En Compose publíquelos en el volumen `ml-models` y configure `ML_RELEASE_VERSION=intent-e5-svm-1` y `ML_CHURN_BUNDLE_DIR=/models/releases/churn-logistic-1`. El proceso usa el codificador local. La configuración existente de intención TF-IDF también es compatible.

| Endpoint interno | Momento | Resultado |
| --- | --- | --- |
| `POST /internal/v1/predict-intent` | Primer turno sustantivo del cliente o cambio claro de motivo | Intención sugerida, score sin calibrar y recomendación de confirmar o aclarar. Confirmar siempre una intención de cancelación y aplicar elegibilidad antes de proponer una oferta. |
| `POST /internal/v1/predict-churn` | Al identificar al titular y disponer de una foto de datos. Consultar la misma señal al cierre | Score, fecha de corte, versión, horizonte de 90 días, prioridad y recomendación. Recibe las variables tabulares y los conteos de tickets a 30 y 90 días del contrato OpenAPI. |
| `GET /internal/v1/model-metrics` | Revisión del modelo | Métricas offline de ambas tareas. Las métricas operativas y las etiquetas supervisadas existentes corresponden a intención. |

Para sugerir una categoría de intención distinta de cancelación, la evaluación agrupada busca el menor corte con **al menos 90 % de precisión observada**, 30 predicciones y tres plantillas. Si esa evidencia falta o el score queda por debajo del corte, el servicio recomienda aclarar la intención. La cancelación siempre se confirma. El 90 % es una meta de precisión para un conjunto de predicciones en los datos del reto. Los cortes requieren validación adicional con primeros turnos antes de orientar un piloto.

La prioridad alta de churn comienza en el **percentil 80 de los scores de desarrollo** y la media en el percentil 50. Esos valores representan posición relativa en la cohorte de referencia. La proporción de clientes que supera el umbral puede variar en otra población. Usar la prioridad alta para ofrecer revisión humana de pendientes y seguimiento de retención. Usar la media para verificar pendientes y el flujo habitual en el resto. Las políticas vigentes y la confirmación del asesor gobiernan cualquier oferta o contacto. El seed de plataforma construye tres fotos para la demo desde el fixture CRM y el worker solicita inferencia al verificar y tomar el caso. El seguimiento queda en la plataforma. [Integración y verificación](../../docs/evolucion-mvp/ml-intencion-y-churn.md)
