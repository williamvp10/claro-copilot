# Implementación del clasificador clásico con MLflow

**Modelo del MVP.** Clasificador multiclase en CPU con **TF-IDF de palabras de uno y dos términos y regresión logística ponderada por clase**. Entrena sobre `descripcion → categoria` de los tickets. MLflow autohospedado registra y versiona el modelo. Una API FastAPI privada sirve una versión fija en **modo sombra**. La capa de decisión del agente mantiene el enrutamiento efectivo y recibe esta predicción como telemetría asíncrona. El clasificador completo corre en la VPS y su inferencia no consume créditos de OpenAI ni OpenRouter.

[Arquitectura Docker](../02-arquitectura-docker.md#ml-clásico-y-mlflow) · [Contratos de integración](../04-contratos.md)

## Datos y decisión de alcance

| Insumo | Uso en el MVP | Evidencia y límite |
| --- | --- | --- |
| Tickets de atención | Entrenamiento, baseline y evaluación agrupada. | 3.816 filas entregadas, 3.796 tras quitar duplicados exactos, 164 descripciones literales distintas y 40 plantillas normalizadas. Las descripciones son notas de asesores. |
| Transcripciones etiquetadas | Evaluación de transferencia con turnos iniciales del cliente. | 50 registros, 10 por intención y 18 formulaciones distintas del primer motivo. Reservar por familia y medir Telegram con una muestra aparte. |
| Churn a 90 días | Experimento offline independiente. | ROC-AUC exploratoria de **0,700** con un único corte. Usar churn en atención requiere población enlazable y variables vigentes que el CRM mock no proporciona. |

Clases del contrato `soporte_tecnico`, `facturacion`, `consulta_planes`, `cancelacion` y `portabilidad`. Entrada del estimador: texto del turno saneado. El canal se usa para segmentar evaluación y drift. Los identificadores y atributos posteriores al cierre quedan fuera de las variables de predicción. El golden de RAG y el feedback del cliente siguen su ciclo de calidad propio. [Diccionario de datos](../05-insumos.md#datos-de-ml)

### Diagnóstico del clasificador

El diagnóstico previo obtuvo **F1 macro 0,967** con partición aleatoria, **0,538** al separar plantillas y **recall 0,340** para cancelación en la evaluación agrupada. El baseline mayoritario quedó en **F1 macro 0,117**. La separación por plantillas es la referencia inicial. Las cifras son de datos sintéticos.

## Entrenamiento y evaluación

1. **Preparar.** Leer el CSV en modo lectura, validar columnas y las cinco categorías, y registrar anomalías y duplicados. Aplicar el saneamiento de la plataforma y una misma normalización de Unicode, mayúsculas, espacios e identificadores de larga longitud para train y serving. Preservar términos como `E-202`, negaciones y palabras de intención. Para agrupar, usar una huella separada que normalice secuencias numéricas y variantes de plantilla. Revisar etiquetas conflictivas y documentar las exclusiones.
2. **Separar.** Crear un manifiesto congelado de folds con `StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=42)`. Mantener una plantilla y sus casi duplicados dentro del mismo grupo. Comprobar que cada fold de prueba tenga soporte por clase y auditar clientes compartidos entre particiones. Si el agrupamiento deja clases sin cobertura, ajustar el número de folds y registrar el cambio. Evaluar aparte las transcripciones reservadas y disponer de muestras de Telegram anotadas sin ver la predicción.
3. **Ajustar.** Comparar `DummyClassifier(strategy="most_frequent")` con un `Pipeline` scikit-learn de `TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True)` y `LogisticRegression(C=1.0, solver="lbfgs", class_weight="balanced", max_iter=1000)`. Esta configuración inicial se mide contra el diagnóstico previo. Usar la misma versión de scikit-learn en train y serving. Ajustar vocabulario, IDF y estimador dentro de cada fold.
4. **Medir.** Agregar predicciones fuera de muestra y registrar F1 macro como métrica principal, precisión, recall y soporte por clase, matriz de confusión y recall de cancelación. Mostrar el resultado por fold y la transferencia por canal por separado. Tratar `max(predict_proba)` como score sin calibrar. Para activar el enrutamiento en una versión posterior, revisar calibración y cobertura en un conjunto independiente.
5. **Exportar.** Después de medir los folds, ajustar el candidato de serving con los tickets habilitados. Conservar los conjuntos conversacionales reservados. Registrar en MLflow parámetros, huella del dataset, manifiesto de grupos, versiones, Git SHA, métricas y matrices. Guardar el pipeline y su firma con un ejemplo sintético saneado, usando `mlflow.sklearn.log_model` con `serialization_format="skops"`. Validar una recarga del artefacto en la misma imagen de serving y limitar los tipos permitidos a los revisados.

[Partición por grupos](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.StratifiedGroupKFold.html) · [TF-IDF](https://scikit-learn.org/stable/modules/generated/sklearn.feature_extraction.text.TfidfVectorizer.html) · [Regresión logística](https://scikit-learn.org/stable/modules/generated/sklearn.linear_model.LogisticRegression.html) · [Serialización y firma en MLflow](https://mlflow.org/docs/latest/api_reference/python_api/mlflow.sklearn.html)

## Instalación de MLflow en Dokploy

| Servicio Compose | Función | Persistencia y acceso |
| --- | --- | --- |
| `ml-db` | PostgreSQL para tracking, registro y permisos. Puede ser una base y un rol dedicados en un Postgres compartido. | Volumen o respaldo gestionado, acceso privado. |
| `mlflow` | Tracking Server y Registry OSS. | Volumen nombrado de artefactos. Los clientes suben y bajan a través del servidor. UI solo por acceso interno autenticado, VPN o túnel. |
| `ml-train` | Job CPU manual o lanzado desde CI autorizado. | Insumos de solo lectura y credencial de entrenamiento. Se apaga tras registrar la ejecución. |
| `ml-release` | Job que resuelve, verifica y publica una versión de modelo. | Escribe el bundle aprobado en el volumen de release. |
| `ml-api` | FastAPI con una versión del modelo cargada al iniciar. | Bundle de release verificado y montado en solo lectura. Predicción para el agente. Etiquetas y métricas para la plataforma. |
| `ml-drift` | Job programado que compara señales y consolida métricas. | Registros saneados y acceso de escritura a reportes. |

1. Fijar versiones y digests de imágenes. Construir el servidor con MLflow, driver PostgreSQL y `mlflow[auth]` si se usa autenticación nativa. Inyectar URI de base y credenciales mediante secretos de Dokploy. Crear la base previamente, respaldar antes de cambios de versión y ejecutar `mlflow db upgrade "$MLFLOW_BACKEND_STORE_URI"` como paso único de migración.
2. Montar `mlflow_artifacts` en `/var/lib/mlflow/artifacts` y arrancar el servidor en la red privada. Este es el comando de referencia para el contenedor usando autenticación nativa.

   ```bash
   mlflow server \
     --host 0.0.0.0 \
     --port 5000 \
     --backend-store-uri "$MLFLOW_BACKEND_STORE_URI" \
     --serve-artifacts \
     --artifacts-destination /var/lib/mlflow/artifacts \
     --allowed-hosts "$MLFLOW_ALLOWED_HOSTS" \
     --app-name basic-auth
   ```

3. Configurar `MLFLOW_AUTH_CONFIG_PATH`, `MLFLOW_FLASK_SERVER_SECRET_KEY` y `MLFLOW_AUTH_ADMIN_PASSWORD` para el alta inicial según la versión fijada. Persistir permisos en PostgreSQL y conceder acceso explícito a entrenamiento, lectura y publicación. La lista de hosts contiene el nombre interno y, si aplica, el proxy privado. Mantener el puerto de tracking sin publicación pública. Validar TLS si se usa un proxy y comprobar que las rutas de experimentos y artefactos exijan autenticación.
4. Desde `ml-train`, configurar `MLFLOW_TRACKING_URI` y las credenciales de alcance limitado `MLFLOW_TRACKING_USERNAME` y `MLFLOW_TRACKING_PASSWORD`. Ejecutar un entrenamiento y comprobar que la UI muestre el run, que un experimento nuevo use una URI de artefactos proxificada y que se puedan descargar los artefactos autorizados.
5. Programar respaldo coordinado de PostgreSQL y del volumen de artefactos. Realizar una restauración de prueba que abra el run y recupere la misma versión con su checksum. Mantener separados los entornos de staging y demo.

[Docker Compose en Dokploy](https://docs.dokploy.com/docs/core/docker-compose) · [Servidor de tracking y artefactos](https://mlflow.org/docs/latest/self-hosting/architecture/tracking-server/) · [Migraciones del backend](https://mlflow.org/docs/latest/tracking/backend-stores/) · [Seguridad de red](https://mlflow.org/docs/latest/self-hosting/security/network/) · [Autenticación nativa](https://mlflow.org/docs/latest/self-hosting/security/basic-http-auth/)

## Registro, release e inferencia

- **Registro.** Crear el modelo `claro_copiloto_intencion`. Usar el alias `candidate` como referencia para revisión. Asociar a todo release una versión numérica exacta `models:/claro_copiloto_intencion/<versión>`, run ID, hash del bundle, firma, digest de imagen y modo `shadow`. El resolver del release descarga y verifica antes de publicar.
- **Serving.** `ml-api` carga al iniciar el bundle aprobado y publica `POST /internal/v1/predict-intent`. Recibe texto saneado, canal, ID de turno y clave de idempotencia. Devuelve `prediction_id`, `label`, `score`, `score_type=uncalibrated`, `model_version` y `mode=shadow`. Usar `traceparent` para correlación y deduplicar por turno y versión. Readiness exige modelo y firma válidos. El serving soporta reinicios del tracking al usar su copia local.
- **Integración.** En autoservicio y asistido, LangGraph registra la solicitud asíncrona ante un turno sustantivo del cliente o un cambio de intención expresado por él. Los mensajes del asesor contextualizan la ficha y las correcciones explícitas pueden aportar etiquetas revisadas. El predictor clasifica el texto del cliente para evitar atribuirle intenciones expresadas por el asesor. Un timeout o `503` se observa y el turno continúa. La corrección del asesor viaja por `POST /internal/v1/intent-labels` con `prediction_id`, clase y evento deduplicable. Mantener la predicción original para evaluar.
- **Promoción.** El release sombra requiere reproducibilidad, contrato, trazabilidad y aislamiento comprobados. Habilitar una futura participación en el enrutamiento con **F1 macro ≥0,80** en evaluación agrupada, validación conversacional por canal, revisión de recall de cancelación y umbral de abstención aprobado. Para rollback, redeploy del manifiesto con la imagen y versión previa.

[Versiones y aliases del Registry](https://mlflow.org/docs/latest/ml/model-registry/workflow/) · [API compartida de inferencia](../04-contratos.md#predicción-y-observabilidad)

## Drift, dashboard y evidencia de demo

Registrar timestamp, canal, versión, clase, score, latencia, tamaño del turno y proporción de tokens fuera de vocabulario. Guardar solo IDs opacos y señales derivadas para métricas. En `ml-drift`, comparar con Evidently la ventana actual con una referencia conversacional por versión y canal. En el arranque, mostrar `sin referencia` hasta contar con una línea base. Como punto de partida, usar ventanas de siete días con al menos 100 predicciones y dos ventanas no solapadas con señal sostenida antes de abrir una revisión. Ajustar esos valores con tráfico y volumen de la demo.

El dashboard obtiene agregados mediante `GET /internal/v1/model-metrics`. Mostrar versión, modo, cantidad de predicciones, p95, cobertura de etiquetas, score y drift por canal. La calidad offline viene de MLflow. F1 de operación se calcula sobre predicciones unidas a una etiqueta verificada, con tamaño de muestra y precisión/recall por clase. Una alerta de drift abre revisión y posible entrenamiento de un candidato nuevo. [Cómo compara Evidently referencia y ventana actual](https://docs.evidentlyai.com/metrics/explainer_drift)

**Demo lista cuando** el pipeline reproduce el diagnóstico agrupado, MLflow muestra un run y una versión recuperable, un turno real dispara predicción en sombra, la conversación continúa con el predictor caído, una corrección se vincula por ID y el dashboard muestra una alerta simulada identificada como tal. La verificación de contratos, restauración y latencia se ejecuta al implementar el stack.
