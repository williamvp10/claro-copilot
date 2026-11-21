# DDD compartido de Claro Copiloto

El núcleo del dominio es **atender y resolver casos de clientes con asistencia verificable**. Cada caso tiene un propietario y un estado. El agente aporta evidencias y propuestas. Los servicios de plataforma mantienen autoridad sobre identidad, propiedad, elegibilidad, aprobación y efectos.

[Inicio del MVP](../README.md) · [Contratos](04-contratos.md) · [Ejemplos de atención](agente/atencion-prompts-y-evals.md)

## Lenguaje común

| Término | Significado |
| --- | --- |
| **Conversación** | Secuencia de turnos de un canal autorizado. Un identificador del canal vincula mensajes al hilo. |
| **Caso de atención** | Expediente vigente sobre un motivo de contacto. Puede tener varios asuntos, pendientes y resultados parciales. Controla propiedad y derivaciones. |
| **Modo de atención** | En `autoservicio` el agente puede responder al cliente con evidencia pública. En `asistido` el asesor conduce el diálogo y el agente prepara recursos privados. El modo es independiente del canal y de la verificación de identidad. |
| **Origen del caso** | Entrada por el bot, entrada directa a un asesor o apertura por un asesor. La derivación cambia el modo de atención del mismo caso y conserva su origen. |
| **Ficha del copiloto** | Vista privada derivada de los turnos de cliente y asesor. Incluye intención, resumen, hechos verificados, fuentes, pendientes y siguiente paso. La plataforma controla su visibilidad y vigencia. |
| **Titular verificado** | Identidad de cliente vinculada al caso tras validación de un asesor. Tiene ámbito, vigencia y auditoría. |
| **Plan de respuesta** | Evidencias, mensaje, aclaración o recomendación que produce el agente. Puede incluir una solicitud de propuesta. |
| **Propuesta y aprobación** | La propuesta es una acción concreta pendiente. La aprobación es una decisión autenticada de la consola, ligada a propuesta y actor. |
| **Acción confirmada** | El servicio externo confirmó el efecto. El sistema conserva el resultado real y su referencia. |
| **Cita** | Fuente, versión y localizador de la evidencia documental usada. Los hechos privados incluyen referencia a la lectura autorizada. |
| **Predicción de intención** | Clase, score, versión y trazabilidad de una inferencia clásica. En sombra se observa para evaluación. |
| **Revisión del agente** | Configuración inmutable de prompts, perfiles y límites de modelos. La plataforma activa revisiones por entorno. |

## Contextos delimitados y propiedad

| Contexto | Responsable | Agregados y reglas principales |
| --- | --- | --- |
| **Atención y canales** | Plataforma | `CasoAtención` y `Conversación`. Estados abiertos, derivados, en atención humana y cerrados. Deduplica eventos, conserva propietario y entrega respuestas al canal. Un estado de cierre distingue resuelto confirmado, pendiente o abandono. |
| **Identidad y acceso** | Plataforma | `TitularVerificado` y `ÁmbitoDeCaso`. Otorga acceso por rol, caso y titular. Revoca cuando termina su vigencia o cambia la asignación. Las credenciales del canal son referencias opacas. |
| **Cliente y retención** | Plataforma | Adaptadores CRM/facturación y `PropuestaAcción`. Los contratos externos se traducen a hechos mínimos. Las reglas vigentes determinan elegibilidad y el servicio de comandos protege escrituras. |
| **Configuración y operación** | Plataforma | `RevisiónAgente`, `Activación` y vistas de métricas. La consola administra candidatas, Evals, publicación y rollback con auditoría. El cuerpo de prompts se versiona en Langfuse. |
| **Orquestación** | Agente | `RunAgente`, estado del grafo, trazas y checkpoints. Seguimiento de decisiones y herramientas. Resuelve con fuentes o propone el siguiente paso. Un contexto autorizado se reconstruye al reanudar. |
| **Conocimiento y memoria** | Agente | `Fuente`, `VersiónFuente`, `Cita`, `MemoriaSesión` y `PerfilMemoria`. Filtra evidencia por fecha y visibilidad. Redis guarda contexto breve y preferencias autorizadas, con expiración y revocación. |
| **Intención y MLOps** | ML | `VersiónModelo`, `PredicciónIntención`, `EtiquetaRevisada` y `LíneaBaseDrift`. Entrena, registra, sirve y observa versiones. El modo sombra produce telemetría sin cambiar rutas. |

La API de plataforma es la capa anticorrupción para CRM y facturación. Tiene su base lógica y rol propios. El agente consume puertos TypeScript autorizados y conserva conocimiento y checkpoints en sus esquemas propios. API y worker NestJS intercambian trabajos y eventos persistidos. ML posee las bases y artefactos de su ciclo. En la VPS se puede compartir una instancia de PostgreSQL con bases y credenciales separadas. Los contextos intercambian eventos y APIs.

## Reglas que atraviesan los tres frentes

- **Identidad y propiedad.** Un identificador escrito en el chat nunca concede acceso. El asesor asignado puede tomar el caso y validar titularidad. La plataforma conserva el diálogo entre cliente y asesor. Al cambiar de propietario, invalida la entrega pública automática, revalida el alcance del nuevo propietario y actualiza su ficha privada.
- **Política y acciones.** El cliente puede expresar aceptación en el canal. La plataforma exige confirmación del asesor vinculada a la propuesta antes de usar los mocks. Confirma los efectos que el mock devuelve. Un ticket de visita representa una solicitud hasta obtener confirmación de agenda.
- **Evidencia.** El índice distingue documentos listos, activos y retirados. El agente filtra por fecha efectiva y visibilidad antes de combinar búsquedas. La consola muestra el localizador y el alcance autorizado.
- **Auditoría y continuidad.** Cada turno y efecto tiene identidad estable. La aprobación se consume una vez, los eventos se deduplican y el estado anterior permanece disponible para auditar. Una revisión de prompt o modelo no cambia un run a mitad del flujo.
- **Satisfacción.** El estado se basa en confirmación, resultado del sistema o disposición del asesor. La encuesta del cliente, el feedback del asesor y las inferencias del modelo se registran como señales distintas.

### Ciclo de comandos y eventos

| Comando | Evento principal | Uso |
| --- | --- | --- |
| Abrir conversación | `CasoAbierto` | Fijar origen y modo. En apertura saliente, vincular asesor, chat habilitado y primer mensaje. |
| Aceptar mensaje | `TurnoRecibido` | Registrar autor y orden. Tanto una intervención del cliente como una respuesta del asesor pueden actualizar el contexto. |
| Verificar titular | `TitularVerificado` | Reactivar el pendiente de cuenta y consultar las herramientas autorizadas para el motivo vigente. |
| Actualizar ficha | `FichaAsesorActualizada` | Publicar recursos privados al asesor autorizado por SSE. La ficha identifica el turno más reciente considerado. |
| Derivar y tomar caso | `CasoDerivado`, `CasoTomado` | Estado de bandeja y métricas por destino. |
| Proponer y aprobar acción | `PropuestaCreada`, `AcciónAprobada` | Pausar y habilitar ejecución tras revalidar. |
| Ejecutar efecto | `AcciónConfirmada` o `AcciónPendienteDeVerificación` | Reanudar el run con resultado confiable y evitar escribir de nuevo bajo incertidumbre. |
| Indexar fuente | `VersiónIndexada` | Seguimiento de frescura y de vigencia. |
| Activar revisión | `RevisiónAgenteActivada` | Fijar configuración para runs nuevos del entorno. |
| Cerrar y recoger feedback | `CasoCerrado`, `FeedbackRecibido` | Calidad, resolución y CSAT. |
| Revisar intención y detectar drift | `EtiquetaIntenciónRevisada`, `DriftDetectado` | Medición del modelo y revisión para reentrenar. |

Validar las reglas de negocio con los insumos vigentes. Para casos de múltiples asuntos, mantener cada resultado y el estado del caso por separado. [Política de escalamiento](05-insumos.md#políticas-y-contratos) · [Política de retención](05-insumos.md#políticas-y-contratos)
