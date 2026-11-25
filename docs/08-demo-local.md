# Demo local de Claro Copiloto

Para preparar la siguiente iteración, la [especificación del agente](evolucion-mvp/comportamiento-del-agente.md) define el recorrido asistido, las herramientas reutilizadas y los casos que se compararán con esta línea base.

## Estado del corte

Con Docker Desktop configurado con **12 GB**, respondieron el frontend, NestJS, FastAPI, Langfuse y MLflow. La prueba integrada del recorrido de intención y churn pasó con las cuentas sintéticas, la verificación de titular y el tablero de ML. El experimento **`llamadas-v1-jev-bb872340`** está en Langfuse y la API devolvió los **15 casos con puntuación Jev**. Hubo 13 rutas iniciales correctas, 9 veredictos semánticos que requieren revisión y 6 fallos. [Proyecto Langfuse](http://localhost:39095/project/claro-copiloto)

El chat web respondió al caso E-202 con la cita `faq-012`. Langfuse recibió el span `attention.run` y las observaciones de recuperación en `f32efd0b9d9aaf4f8783c2b4146e0ea0`. El recorrido de modelos dejó las trazas `tr-e019f3e206967d28eb8bc7c65b073950` para intención y `tr-69fd905a0ab4704dd9816c80061330ca` para churn en sus respectivos experimentos de MLflow.

El repositorio ya tenía los Compose de la plataforma y Langfuse, un clasificador histórico, los dos bundles de recomendación y el runner para las suites golden y complementaria. El perfil local añade acceso directo a NestJS y FastAPI, y pone a FastAPI en contacto con el servidor de tracking. Los bundles advisory ahora registran un modelo y un run de entrenamiento, y la suite de llamadas publica su propio experimento en Langfuse.

Validación del código en este corte. Agente **39 aprobadas**, backend **40 aprobadas y 2 omitidas** según sus condiciones de integración, FastAPI/MLflow **3 aprobadas**. Compose validó las dos configuraciones. Jev respondió a una invocación real con `typesafe/jev-1.14-20261014`. Los resultados de las pruebas de código se deben complementar con los recorridos de la tabla de aceptación.

Una prueba aislada del servicio contra un servidor MLflow local por HTTP reprodujo ambos candidatos y persistió estas trazas. Los identificadores corresponden a esa instancia de verificación. El demo Docker genera los suyos al entrenar e inferir.

| Modelo | Resultado offline | Traza de inferencia en la prueba aislada |
| --- | --- | --- |
| Intención E5 + SVM | F1 macro 0,785 | `tr-dd97c839e0204f1ec51922c1c2db8998` |
| Churn logístico | ROC-AUC 0,716 | `tr-4da0e2b05a8604d3429563a541d75d27` |

El registro del demo Docker quedó poblado con **claro_intent_e5_svm v1** y **claro_churn_logistic v1**. El entrenamiento se ejecutó desde el anfitrión cuando el job Docker quedó esperando la salud de MLflow. Los runs están en la instancia local. [Run de intención](http://localhost:39096/#/experiments/1/runs/0bb3c9f357d74fd1a458017fb44a688a) · [Run de churn](http://localhost:39096/#/experiments/2/runs/e826138165184d32abf6f049547285f2)

Una prueba de FastAPI desde el anfitrión publicó y leyó en ese MLflow las trazas `tr-151146daeaa11e02b79c8ceccf115654` para intención y `tr-394f5d8535e7571bc4c6e09dd77369d1` para churn. Cada traza lleva la versión servida y el run de entrenamiento correspondiente.

En un replay del agente con el corpus local en memoria, **13 de 15** rutas iniciales coincidieron y **0** turnos intentaron consultar una cuenta sin verificar. Dos regresiones para reproducir en la plataforma:

- **TRX-0005.** «Cambiar de operador conservando mi número» abrió soporte técnico. El segundo turno recuperó portabilidad.
- **TRX-0018.** La consulta de descuento por combinar Hogar y móvil entró a cancelación. Debe evaluarse como consulta comercial con una posible intención secundaria de portabilidad.

En `classify`, la regla de portabilidad reconoce las raíces `portabil` y `portar`, mientras que `descuento` u `oferta` activan cancelación. El plan de corrección es reconocer conservación del número como señal de portabilidad y exigir una señal explícita de baja o retención para tratar un descuento como cancelación. Volver a correr estos dos casos junto a TRX-0029 y TRX-0031 para conservar la detección de cancelaciones reales. [Reglas del agente](../packages/agent/src/index.ts)

## Abrir el demo

| Servicio | Dirección en el equipo | Qué comprobar |
| --- | --- | --- |
| Next.js | [Consola](http://localhost:39092/) · [Chat del cliente](http://localhost:39092/chat) | Entrar como asesor o admin. Abrir un chat nuevo para cada caso. |
| NestJS | [Salud](http://localhost:39093/healthz) · [Preparación](http://localhost:39093/readyz) | Consultar las rutas de aplicación desde el frontend o con una sesión de demo. |
| FastAPI | [Preparación](http://localhost:39094/readyz) · [OpenAPI](http://localhost:39094/docs) | Ver `intent-e5-svm-1` y `churn-logistic-1`. Las predicciones requieren `ML_SERVICE_TOKEN`. |
| Langfuse | [Interfaz](http://localhost:39095) | Proyecto **Claro Copiloto**, vistas **Tracing**, **Datasets**, **Experiments** y **Scores**. |
| MLflow | [Interfaz](http://localhost:39096) | **Models** para las versiones registradas. **Experiments** para los runs de entrenamiento y las trazas `predict-intent` y `predict-churn`. |

Los correos y contraseñas del ensayo están en `.env.demo.local`. Las variables `DEMO_ASESSOR_*`, `DEMO_ADMIN_*` y `LANGFUSE_ADMIN_*` corresponden a cada interfaz. Para probar el chat, inicia con «Quiero consultar mi factura», escribe el alias sintético `11111`, completa el código de seis dígitos y pide un asesor. Toma el caso desde la consola para que el worker solicite la señal de churn. Para el autoservicio sin cuenta, prueba «Mi televisor muestra E-202. ¿Cómo refresco la señal?».

## Levantar una instancia

Desde `claro-copilot`, con Docker Desktop activo, Node y el paquete de insumos en el directorio padre. Crea `.env.demo.local` una vez. Conserva ese archivo junto a sus volúmenes para mantener las credenciales y el proyecto de Langfuse. Las dos redes usan subredes configurables mediante `DEMO_PRIVATE_SUBNET` y `LANGFUSE_PRIVATE_SUBNET`.

```bash
node scripts/init-local-demo.mjs

app() { docker compose --env-file .env.demo.local -f infra/compose.yaml -f infra/compose.local.yaml "$@"; }
lf() { docker compose -p claro-demo-langfuse --env-file .env.demo.local -f infra/compose.langfuse.yaml -f infra/compose.langfuse.local.yaml "$@"; }

app --profile ml --profile knowledge --profile call-evals config --quiet
lf config --quiet
app up -d postgres redis
lf up -d --wait --wait-timeout 600

app --profile ml-jobs build mlflow
app --profile ml-jobs up -d --wait --wait-timeout 600 mlflow
```

Consigue `model.onnx` y `tokenizer.json` de la revisión E5 `614241f622f53c4eeff9890bdc4f31cfecc418b3`. Colócalos juntos en `ENCODER_DIR`. El servicio verifica sus SHA-256. Ejecuta el entrenamiento una vez por volumen y versión. [Assets de E5](https://huggingface.co/intfloat/multilingual-e5-small/tree/614241f622f53c4eeff9890bdc4f31cfecc418b3/onnx)

```bash
inputs="$PWD/../Insumos_Prueba_Consultor_IA"
export ENCODER_DIR=/ruta/al/encoder/onnx
app --profile ml-jobs run --rm -e GIT_SHA="$(git rev-parse HEAD)" \
  -v "$inputs/03_datos:/input:ro" -v "$ENCODER_DIR:/encoder:ro" \
  ml-job app.train_advisory --tickets /input/tickets.csv \
  --clients /input/clientes_churn.csv --encoder-dir /encoder --output /models/releases

app --profile knowledge build web
app --profile ml --profile knowledge up -d --no-build --pull never --wait --wait-timeout 600
app --profile jobs run --rm seed
```

Para cargar la base documental y ambos catálogos, genera y aplica la publicación local. La fecha `DEMO_BUSINESS_DATE` determina qué catálogo usa el agente. Para ensayar publicación incremental, genera primero con `--initial` y aplica la publicación completa desde otro directorio. El script falla si se intenta sobreescribir su salida. [Preparación del corpus](../packages/agent/scripts/README.md)

```bash
publication="$(mktemp -d)"
uv run packages/agent/scripts/prepare_corpus.py --input "$inputs" \
  --output "$publication/corpus.json" --manifest "$publication/manifest.json"
KNOWLEDGE_PUBLICATION_DIR="$publication" app --profile jobs run --rm --user 0 publish-knowledge
```

Comprueba `app --profile ml --profile knowledge ps` y `lf ps`. Para pausar y conservar los datos, usa `app --profile ml --profile knowledge stop` y `lf stop`. `app logs --tail=100 api worker ml mlflow` y `lf logs --tail=100 langfuse-web langfuse-worker lf-clickhouse` muestran diagnósticos.

Si Docker agota sus redes automáticas, comprueba que las dos subredes locales estén libres y ajusta sus variables antes de crear las redes. Si el arranque se queda esperando varias pruebas de salud a la vez, verifica los recursos de Docker Desktop y los servicios listados por `docker ps`. Con los contenedores ya configurados, `lf up -d --no-recreate --wait --wait-timeout 600` reanuda el arranque sobre los mismos volúmenes. El job de entrenamiento de este perfil se ejecuta desde Compose y MLflow se dedica al registro y tracking.

El perfil local admite `LANGFUSE_CLICKHOUSE_VOLUME` para elegir el volumen de ClickHouse. En un ensayo nuevo que aún no ha recibido trazas ni scores, un nombre nuevo permite repetir la inicialización y conservar el volumen que tuvo una migración interrumpida. Mantén el nombre elegido en `.env.demo.local` al reiniciar el demo.

Con ambos modelos listos y el seed aplicado, ejecuta la prueba integrada desde el anfitrión. Crea casos de demo y comprueba titularidad, predicción, retroalimentación y seguimiento.

```bash
ML_API_URL=http://localhost:39094 PLATFORM_E2E_TARGET=http://localhost:39092 \
  node --env-file=.env.demo.local apps/backend/test/ml-advisory-e2e.mjs
```

## Redesplegar el demo principal

Para un demo con el índice contextual publicado, conserva `KNOWLEDGE_INDEX_REVISION` y `KNOWLEDGE_ORIGINALS_DIR` en `.env.demo.release.local`. Mantén el nombre del proyecto y sus volúmenes para conservar las conversaciones y el índice.

Configura `LANGFUSE_CAPTURE_CHAT_IO=true` en `.env.demo.release.local` para ver los mensajes saneados del autoservicio sintético en las nuevas sesiones. El perfil local de Langfuse da a ClickHouse 4 CPU y 4 GiB por defecto. Usa `LANGFUSE_CLICKHOUSE_CPUS`, `LANGFUSE_CLICKHOUSE_MEMORY`, `LANGFUSE_WEB_HEAP_MIB` y `LANGFUSE_WORKER_HEAP_MIB` para adaptar el perfil al presupuesto de Docker Desktop.

```bash
git switch develop
revision="$(git rev-parse --short HEAD)"
export CLARO_IMAGE="claro-copiloto:develop-$revision"
export ML_IMAGE="claro-ml:develop-$revision"
app() { docker compose --env-file .env.demo.local --env-file .env.demo.release.local \
  -f infra/compose.yaml -f infra/compose.local.yaml -f infra/compose.knowledge-originals.yaml \
  --profile knowledge --profile ml "$@"; }
app config --quiet
app build web ml
app up -d --no-build --pull never --wait --wait-timeout 150 \
  api worker web knowledge-mcp crm-mcp billing-mcp ml mlflow
```

Guarda los tags desplegados en `CLARO_IMAGE` y `ML_IMAGE` de `.env.demo.release.local` para futuros reinicios. En el [chat](http://localhost:39092/chat) prueba «¿Qué planes tienen?» seguido de «telefonía móvil». Comprueba en Langfuse que los turnos nuevos estén agrupados en la misma sesión y que **Nuevo chat** abra otra sesión para el mismo visitante.

## Modelos y correlación

El job de entrenamiento registra los candidatos **claro_intent_e5_svm** y **claro_churn_logistic** en MLflow y escribe en cada manifiesto el experimento, run, modelo registrado y `model_id`. FastAPI lee los bundles verificados desde su volumen de solo lectura. NestJS pide inferencia a FastAPI desde el worker. FastAPI conecta con `http://mlflow:5000` para exportar trazas de inferencia, con versión, latencia de predicción y run de entrenamiento. El `model_id` asocia los bundles nuevos al Logged Model y los experimentos de entrenamiento contienen sus trazas. El codificador E5 se conserva junto al bundle de intención y es necesario para volver a servirlo.

El panel [Modelos del agente](http://localhost:39092/?view=models) requiere la capacidad `superadmin`. Configura `AGENT_PROVIDERS=live` e inyecta las credenciales mediante el entorno del backend y del worker. OpenAI usa su API directa. Las familias alternativas requieren OpenRouter y una revisión validada y activada. Guarda en la revisión el motivo y la referencia de la prueba. [Política Multi-LLM y RAG](evolucion-mvp/orquestacion-multillm-y-rag.md#configuración-desde-superadministración)

Para intención, el tag `claro.langfuse_trace_id` usa el mismo identificador calculado por el worker para la ejecución del agente cuando ambos corresponden al mismo turno. El objeto de churn usa como referencia la versión y el run del modelo. En **Tracing** de Langfuse busca `attention.run` y sus observaciones de enrutamiento, recuperación y herramientas. El modo `fixtures` permite probar el flujo con respuestas locales. OpenAI queda bajo la configuración `AGENT_PROVIDERS=live` y la revisión de pasajes habilitados para el proveedor.

## Evaluar las llamadas con Jev

La suite representa los 50 archivos del reto mediante **15 familias y 23 turnos reformulados**. Cada caso conserva los IDs TRX de origen, la intención, hechos requeridos y afirmaciones que el agente debería evitar. Las narraciones del asesor sirven para identificar escenarios. La política y las operaciones confirmadas definen las expectativas actuales. [Casos versionados](agente/llamadas-evals.v1.jsonl)

### Importar la configuración al desplegar

El manifiesto [jev-langfuse.v1.json](agente/jev-langfuse.v1.json) contiene la conexión, el modelo, las dos preguntas y los mapeos del evaluador. La suite [llamadas-evals.v1.jsonl](agente/llamadas-evals.v1.jsonl) contiene los 15 ítems con su salida esperada. Después de `lf up -d --wait`, ejecuta desde la raíz del repositorio con las variables del proyecto de destino.

```bash
node --env-file=.env.demo.local scripts/bootstrap-langfuse-calls.mjs
```

El comando necesita la URL de Langfuse, el ID del proyecto y las dos claves de API del proyecto. Para crear Jev también necesita el correo y la contraseña de Administración. Inyecta `OPENROUTER_API_KEY` desde el almacén de secretos cuando haya que crear la conexión. Si ya existe, el comando verifica su configuración y la reutiliza. Puedes repetir la importación. Si un ítem existente o la definición de Jev difieren, el comando informa la discrepancia para revisión.

Si el proyecto ya tiene un evaluador homónimo con otra definición, repite el comando con `--manifest-evaluator`. El importador registra o verifica `Jev · Llamadas v1 · Manifiesto` con el mismo modelo, preguntas y mapeos del JSON. Usa ese evaluador para ambas corridas y anota su ID y versión.

Con `--dataset-only` cargas solo los casos mediante la API pública. Langfuse también permite importar datasets por CSV desde la interfaz. Para el evaluador **Decision model**, el importador usa la interfaz interna de Langfuse **4.83.0**, la versión fijada en Compose. En otra versión o con acceso por SSO, crea el evaluador desde la UI con el manifiesto y las instrucciones de la sección siguiente. [API de Langfuse](https://langfuse.com/docs/api-and-data-platform/features/public-api) · [Datasets de Langfuse](https://langfuse.com/docs/evaluation/experiments/datasets)

### Ejecutar el juez desde Langfuse

1. Abre **Claro Copiloto → Experiments** y elige una corrida `llamadas-v1-jev-native-*`. Si aparece otra corrida en **Compare**, quítala con su botón **Remove**.
2. Selecciona las 15 filas con **Select all** y pulsa **Evaluate**. El diálogo debe mostrar **15 experiment items across 1 experiment**.
3. Elige **Jev · Llamadas v1** o **Jev · Llamadas v1 · Manifiesto**, según lo que instalaste para el A/B, y pulsa **Run Evaluation**. Langfuse ejecuta el juez en segundo plano. Al terminar, recarga el experimento y consulta los scores de cada fila.
4. En el frontend, entra con el usuario administrador a **Prompts y evaluaciones → Evaluaciones de llamadas con Jev**. Selecciona la corrida y pulsa **Actualizar** para leer los scores guardados en Langfuse.

El evaluador usa la conexión **TypeSafe (System One) → OpenRouter**, con el modelo `typesafe/jev-1.14`. Su estado contiene la pregunta reformulada, la respuesta del agente y la rúbrica del caso. Los criterios registrados son `jev_native_required` y `jev_native_forbidden`. Un caso aprueba cuando cubre todos los puntos requeridos y queda libre de afirmaciones prohibidas. Una omisión completa o una infracción hace fallar el caso. Las demás combinaciones con ambos scores quedan en revisión. Los casos sin los dos scores permanecen pendientes. [Configuración de modelos de decisión en Langfuse](https://langfuse.com/docs/evaluation/evaluation-methods/decision-models)

En volúmenes nuevos, crea la conexión **Jev OpenRouter** en **Settings → LLM Connections** con la clave de OpenRouter. Agrega `typesafe/jev-1.14` como modelo personalizado. En **Evaluators → New evaluator → Decision model**, crea **Jev · Llamadas v1**. Mapea `input` a **Input**, `output` a **Output** y `rubric` a **Metadata**. Cada observación raíz de la corrida incluye `rubric.jev_rubric` con las listas `required` y `forbidden`.

| Pregunta de tipo Choice | Criterio | Opciones |
| --- | --- | --- |
| `jev_native_required` | Cobertura de los puntos en `required` a lo largo de los turnos pertinentes. | `completo`, `parcial`, `ausente` |
| `jev_native_forbidden` | Presencia de alguna afirmación de `forbidden`, con atención a negaciones y promesas. | `limpio`, `dudoso`, `infraccion` |

### Generar nuevas respuestas del agente

Repite el replay después de cambiar rutas, prompts o el índice. El comando usa la revisión activa y publica una corrida nueva. Evalúala desde Langfuse con los pasos anteriores. Ejecutar **Evaluate** otra vez sobre una corrida existente vuelve a aplicar el juez a las respuestas de esa corrida.

```bash
app --profile call-evals run --rm --no-deps call-evals --native-jev
```

Para evaluar los prompts de objetivos, guarda el [cuerpo de la candidata](evolucion-mvp/prompts.candidata-objetivos.json) en `POST /api/v1/admin/prompts` con una sesión de administración. El backend devuelve la revisión y conserva la base activa. Si Langfuse está configurado, registra las versiones de las dos plantillas allí. Después de importar el dataset, ejecuta ambas revisiones con el mismo índice y fecha de negocio.

```bash
app --profile call-evals run --rm --no-deps call-evals --native-jev --revision="$base_revision"
app --profile call-evals run --rm --no-deps call-evals --native-jev --revision="$candidate_revision"
```

Usa una imagen construida con el código que corresponda a cada variante. El replay guarda `runtime_sha256` a partir del código compilado y del lockfile. Usa `GIT_SHA` para añadir la referencia del código fuente. Con `AGENT_PROVIDERS=fixtures` el replay comprueba el grafo y las respuestas locales. Con `AGENT_PROVIDERS=live`, verifica las observaciones `decision.jev`, `decision.evidence`, `generation.openai` y `decision.objectives` junto con el hash de su plantilla. El resumen indica cuántas solicitudes tienen costo registrado por paso y el costo observado por conversación de la suite. [Protocolo de comparación](evolucion-mvp/comportamiento-del-agente.md#evaluación-del-agente-en-langfuse)

### Corridas desde el runner

```bash
app --profile call-evals run --rm call-evals
# Con OPENROUTER_API_KEY en el entorno para esta ejecución
app --profile call-evals run --rm -e OPENROUTER_API_KEY call-evals --jev
```

La primera ejecución registra la ruta del primer turno y el comportamiento previo a verificación. La segunda ejecuta el juez integrado en el runner y guarda scores de API, incluida la métrica `jev_semantic`. El runner usa la revisión activa de prompts y el índice de conocimiento. Las herramientas de lectura controladas detectan accesos privados fuera de flujo. Las cifras, vigencias, aprobaciones e idempotencia se verifican mediante aserciones locales y pruebas de plataforma.

## Plan de pruebas y correcciones

| Prioridad | Prueba | Criterio de cierre |
| --- | --- | --- |
| P0 | Arranque limpio, seed y login de asesor y admin | Los cinco endpoints de la tabla responden, el asesor puede tomar un caso y el admin abre ambos paneles de observabilidad. |
| P0 | Recorrido real de modelo de intención y churn | FastAPI informa ambas versiones, el backend muestra las señales privadas, los dos modelos están en el registro y los experimentos contienen trazas con sus respectivos `model_id`. |
| P0 | Instrumentación del agente | Un turno desde `/chat` produce una traza `attention.run` visible en Langfuse con recuperación o herramienta cuando corresponde. Buscar el mismo ID en un turno de intención correlacionable. |
| P0 | Dataset de llamadas y Jev | Langfuse tiene 15 casos y 30 scores nativos. Administración muestra la misma cobertura y permite abrir cada traza. |
| P1 | Evidencia del comportamiento real de negocio | Ejecutar `apps/backend/test/ml-advisory-e2e.mjs`, los replays de facturación y cancelación y el caso CC-E13. Demostrar cero escrituras previas a aprobación y un recibo después, incluso con reintentos. |
| P1 | Intentos que fallan y continuidad ante indisponibilidad de ML | Verificar con datos sintéticos qué se pierde al detener MLflow y qué ve el asesor al detener FastAPI. Acordar evidencia para alertar cuando deje de llegar telemetría. |
| P1 | Rutas y explicaciones con discrepancias | Revisar los ítems por familia. Las rutas de escalamiento requieren comprobar el destino. Comparar fibra residencial, portabilidad con deuda y retención con las fuentes de la fecha de negocio. |
| P2 | Calibrar el juez y medir calidad antes del piloto | Etiquetar a ciegas una muestra de respuestas correctas, parciales y contradictorias, mantener familias juntas y medir falsos aprobados, cobertura, abstención y costo antes de fijar umbrales. |

Para una corrección, conserva el `experiment_id`, IDs TRX, prompt, índice, rúbrica y modelo efectivo. Vuelve a correr la misma suite tras el cambio y compara por caso. Usa los casos de plataforma para efectos y permisos, y una cohorte independiente para calidad predictiva. [Gate de release](06-calidad-y-release.md) · [Pruebas de los modelos](evolucion-mvp/ml-intencion-y-churn.md)
