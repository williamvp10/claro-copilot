import type { CaseIntake, ContextQuestion, Intent } from '@claro/contracts';

const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
const measuredSpeed = /\b(?:me da|me marca|me llegan?)\s+\d{1,4}\s*(?:megas?|mbps)\b/;

type Question = ContextQuestion & { intent: Intent; field: string; when: string; omit: string; basis: 'observada'|'propuesta'; transcripts: string[] };
const question = (intent:Intent, field:string, text:string, purpose:string, when:string, omit:string, basis:Question['basis'], transcripts:string[]):Question =>
  ({id:field,intent,field,text,purpose,when,omit,basis,transcripts});

export const contextCatalogVersion = '1';
export const contextQuestions = [
  question('cancelacion','motivo','Entiendo. ¿Qué te lleva a cancelar el servicio?','Preparar el traspaso según sea por fallas, precio, mudanza u otro motivo.',
    'Solicitud de baja sin motivo declarado.','El motivo ya está disponible o el cliente prefiere seguir.', 'propuesta',['TRX-0027','TRX-0036','TRX-0031']),
  question('cancelacion','frecuencia','¿La conexión se cae a diario o solo en momentos puntuales?','Distinguir una falla recurrente de un incidente aislado.',
    'El motivo es una falla y falta la frecuencia.','Ya indicó la frecuencia o pidió continuar.', 'propuesta',['TRX-0031']),
  question('soporte_tecnico','medio','¿Mediste la velocidad por Wi-Fi o con un equipo conectado por cable?','Elegir la comprobación de velocidad adecuada.',
    'Hay lentitud y se desconoce el medio de medición.','El cliente ya indicó cómo midió.', 'observada',['TRX-0001','TRX-0006','TRX-0030','TRX-0042','TRX-0046']),
  question('soporte_tecnico','duracion','¿Hace cuánto está roja la luz LOS?','Determinar si aplica el escalamiento de soporte.',
    'La luz LOS está roja y se desconoce la duración.','Hay duración suficiente o se activa un escalamiento prioritario.', 'propuesta',['TRX-0009','TRX-0043']),
  question('soporte_tecnico','cable','¿Ves el cable delgado de fibra doblado o desconectado?','Comprobar visualmente el cable en una falla de fibra.',
    'Falta un diagnóstico inicial tras descartar escalamiento inmediato.','Ya se conoce el estado o se reporta daño físico.', 'observada',['TRX-0009','TRX-0043']),
  question('soporte_tecnico','imagen','¿Volvió la imagen después de refrescar la señal?','Confirmar si se resolvió E-202 tras el procedimiento.',
    'Ya se explicó cómo refrescar la señal.','El cliente ya confirmó el resultado o todavía está esperando.', 'propuesta',['TRX-0022','TRX-0034','TRX-0035']),
  question('soporte_tecnico','codigo','¿Qué código de error aparece en la pantalla?','Buscar el procedimiento correspondiente al error reportado.',
    'El decodificador muestra un error y falta el código.','El cliente ya indicó el código.', 'propuesta',['TRX-0035']),
  question('facturacion','cargo','¿Qué cargo de la factura quieres revisar?','Elegir el concepto que se verificará con el titular.',
    'Reporta un cobro sin identificarlo.','Ya indicó el concepto o importe.', 'propuesta',['TRX-0011','TRX-0032']),
  question('facturacion','pago','¿Cuándo y por qué medio pagaste?','Ubicar el pago si el servicio no se ha reactivado.',
    'Reporta un pago sin reconexión y faltan datos del pago.','El cliente ya indicó cuándo y por qué medio pagó.', 'propuesta',['TRX-0025']),
  question('consulta_planes','producto','¿Lo buscas para tu casa o para tu celular?','Filtrar el catálogo por tipo de servicio.',
    'Pide opciones sin mencionar el servicio.','Ya indicó hogar o móvil.', 'propuesta',['TRX-0018','TRX-0019']),
  question('consulta_planes','uso','¿Qué uso le darías al internet en casa?','Orientar la selección según el uso y los dispositivos.',
    'Busca una recomendación de internet hogar sin indicar uso.','Pregunta por un plan concreto o ya indicó su uso.', 'propuesta',['TRX-0015','TRX-0018']),
  question('consulta_planes','vivienda','¿Qué tan grande es tu vivienda o en qué zona necesitas mejor señal?','Distinguir necesidades de cobertura Wi-Fi.',
    'Busca una recomendación de hogar y falta contexto de cobertura.','Ya indicó tamaño o necesidades de cobertura.', 'propuesta',['TRX-0001']),
  question('consulta_planes','modalidad','¿Prefieres un plan mensual o hacer recargas cuando las necesites?','Elegir entre el catálogo pospago y el prepago.',
    'Busca un plan móvil y falta la modalidad.','Ya indicó plan mensual o recargas.', 'propuesta',['TRX-0019']),
  question('portabilidad','direccion','¿Quieres traer tu número a Claro o llevarlo a otro operador?','Identificar el sentido de la portabilidad.',
    'Pregunta cómo portar su número sin indicar el destino.','Ya indicó el operador o pide información general clara.', 'propuesta',['TRX-0005','TRX-0010']),
  question('portabilidad','tramite','¿La solicitud ya está en trámite?','Distinguir una consulta inicial de una incidencia pendiente.',
    'La persona describe una dificultad de portabilidad sin indicar si inició.','Ya indicó el estado o el caso requiere escalamiento inmediato.', 'propuesta',['TRX-0021'])
] as const;

const byId = new Map(contextQuestions.map(item=>[item.id,item]));
export function questionById(id?:string): ContextQuestion|undefined {
  const item = id ? byId.get(id) : undefined;
  return item && {id:item.id,text:item.text,purpose:item.purpose};
}

export function contextIntent(input:string):Intent|undefined {
  const text=normalize(input);
  if (/\b(?:cancel\w*|dar de baja|retirar el servicio)\b/.test(text) && !/\bpolitica de retencion\b/.test(text)) return 'cancelacion';
  if (/\b(?:portab\w*|portar\w*|mismo numero)\b/.test(text)) return 'portabilidad';
  if (/\b(?:factur\w*|saldo|cobro|cargo|pague|pago|pse)\b/.test(text)) return 'facturacion';
  if (measuredSpeed.test(text) || /\b(?:e[ -]?202|los roja?|wi[ -]?fi|lent\w*|intermiten\w*|se cae|sin internet|sin senal|decodificador|modem)\b/.test(text)) return 'soporte_tecnico';
  if (/\b(?:planes?|fibra|pospago|prepago|paquetes?)\b/.test(text)) return 'consulta_planes';
  return undefined;
}

export function evolveContext(input:string, previous?:CaseIntake, intentHint?:Intent):CaseIntake|undefined {
  const text=normalize(input);
  const explicit=contextIntent(input);
  const isCancellationReply=previous?.intent==='cancelacion' && !!previous.pending &&
    (explicit==='soporte_tecnico' || explicit==='facturacion' && /car[oa]|precio|me cobran mucho/.test(text)) &&
    !/\b(?:otra pregunta|ahora|quiero consultar|quiero revisar)\b/.test(text);
  const intent=(isCancellationReply?previous.intent:explicit) ?? previous?.intent ?? intentHint;
  if (!intent) return undefined;
  const current:CaseIntake=previous?.intent===intent
    ? {...previous,facts:{...previous.facts},asked:[...previous.asked]}
    : {intent,facts:{},asked:[]};
  const known=current.facts;
  if (/\b(?:prefiero no|no quiero (?:decir|responder|explicar)|omitir|salt(?:ar|emos)|solo (?:quiero )?cancelar|igual quiero cancelar|proceda|hagale|contin[uú]a)\b/.test(text)) current.skip=true;
  if (intent==='cancelacion') {
    if (/\b(?:mud\w*|traslad\w*|sin cobertura|no (?:hay|tienen) cobertura)\b/.test(text)) known.motivo='Mudanza o cobertura';
    else if (/\b(?:fall\w*|intermiten\w*|cae|corta|funciona|sin internet|inestable)\b/.test(text)) known.motivo='Fallas del servicio';
    else if (/\b(?:precio|car[oa]|barat\w*|costo|costos|presupuesto|descuento|competencia|otro operador|me cobran mucho)\b/.test(text)) known.motivo='Precio u otra oferta';
    else if (/\b(?:no lo uso|no lo necesito|otro motivo|ya no lo necesito)\b/.test(text)) known.motivo='Otro motivo';
    if (/\b(?:a diario|todos los dias|cada dia|siempre|diari\w*)\b/.test(text)) known.frecuencia='A diario';
    if (/\b(?:a veces|puntual\w*|ocasional\w*|solo una vez)\b/.test(text)) known.frecuencia='En momentos puntuales';
    if (!known.motivo && current.pending==='motivo' && !explicit && !current.skip && text.length>=4 &&
        !/^(no se|no|ok|hola|gracias|cual|como|que|quiero hablar)|\b(?:asesor|humano)\b/.test(text)) known.motivo='Otro motivo declarado';
  }
  if (intent==='soporte_tecnico') {
    if (/\bdecodificador\b/.test(text) && /\berror\b/.test(text)) known.equipo='Decodificador';
    const code=text.match(/\be[ -]?(\d{3})\b/);
    if (code) known.codigo=`E-${code[1]}`;
    if (/\b(?:e[ -]?202)\b/.test(text)) known.sintoma='E-202';
    else if (/\blos\b/.test(text) && /\broj[ao]\b/.test(text)) known.sintoma='Luz LOS roja';
    else if (measuredSpeed.test(text) || /\b(?:lent\w*|velocidad|med[ií])\b/.test(text)) known.sintoma='Lentitud';
    if (/\b(?:por|via|conectad[oa] por) (?:el )?cable\b/.test(text) || text==='cable') known.medio='Cable';
    else if (/\bwi[ -]?fi\b/.test(text)) known.medio='Wi-Fi';
    const duration=text.match(/\b(\d{1,3}|un|una|dos|media|varias|diez|treinta)\s*(minutos?|horas?)\b/);
    if (duration) known.duracion=duration[0];
    if (/\b(?:cable|fibra)\b/.test(text) && /\b(?:doblad\w*|desconectad\w*|bien conectado)\b/.test(text)) known.cable='Estado del cable informado';
    if (current.pending==='imagen') {
      if (/\b(?:volvio|ya veo|se arreglo|funciona|si)\b/.test(text) && !/^no\b/.test(text)) known.imagen='Imagen recuperada';
      else if (/\b(?:sigue igual|no (?:volvio|funciona|veo)|no)\b/.test(text)) known.imagen='Imagen aún ausente';
    }
  }
  if (intent==='facturacion') {
    if (/\b(?:cargo|cobro)\b/.test(text)) {
      known.objetivo='Revisar un cargo';
      if (/\$\s*\d|\bf-\d|\b(?:instalacion|roaming|ajuste|descuento|repetidor)\b/.test(text)) known.cargo='Concepto o importe informado';
    }
    if (current.pending==='cargo' && /\$\s*\d|\b(?:instalacion|roaming|ajuste|descuento|repetidor)\b/.test(text)) known.cargo='Concepto o importe informado';
    if (/\b(?:pague|hice (?:el |un )?pago)\b/.test(text) || current.pending==='pago') {
      known.objetivo='Pago sin reconexión';
      if (/\b(?:hoy|ayer|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/.test(text)) known.fecha_pago='Fecha de pago informada';
      if (/\b(?:pse|tarjeta|efectivo|transferencia|banco)\b/.test(text)) known.medio_pago='Medio de pago informado';
      if (known.fecha_pago && known.medio_pago) known.pago='Fecha y medio informados';
    }
  }
  if (intent==='consulta_planes') {
    if (/\b(?:casa|hogar|fibra)\b/.test(text)) known.producto='Hogar';
    else if (/\b(?:celular|movil|pospago|prepago)\b/.test(text)) known.producto='Móvil';
    if (/\b(?:fibra\s*\d+|max\s*\d+|ilimitado|triple play)\b/.test(text)) known.plan='Plan específico';
    if (/\b(?:jueg\w*|trabaj\w*|estudi\w*|streaming|video\w*|dispositiv\w*|naveg\w*)\b/.test(text)) known.uso='Uso de internet informado';
    if (/\b(?:pospago|mensual)\b/.test(text)) known.modalidad='Plan mensual';
    if (/\b(?:prepago|recarga\w*)\b/.test(text)) known.modalidad='Recargas';
    if (/\b(?:pequen[ao]|grande|pisos?|apartamento|habitaci\w*)\b/.test(text)) known.vivienda='Necesidad de cobertura informada';
  }
  if (intent==='portabilidad') {
    if (/\b(?:a claro|para claro|hacia claro|traer (?:mi|el) numero)\b/.test(text)) known.direccion='Hacia Claro';
    if (/\b(?:otro operador|salir de claro)\b/.test(text)) known.direccion='Hacia otro operador';
    if (/\b(?:intento|intenta\w*|rechaz\w*|solicite|bloquead\w*)\b/.test(text)) known.incidencia='Incidencia en portabilidad';
    if (/\b(?:quiero|como)\b/.test(text) && /\b(?:portar\w*|portabilidad|mismo numero)\b/.test(text) && !/\b(?:deuda|tarda|dias|plazo|requisito)\b/.test(text)) known.objetivo='Orientación de portabilidad';
    if (/\b(?:ya (?:inicie|esta|solicite)|en tramite)\b/.test(text)) known.tramite='Solicitud iniciada';
  }
  if (current.pending && (known[current.pending] || current.skip)) delete current.pending;
  return current;
}

export function nextContextQuestion(intake?:CaseIntake):ContextQuestion|undefined {
  if (!intake || intake.skip) return;
  const {intent,facts,asked}=intake;
  let id:string|undefined;
  if (intent==='cancelacion' && asked.length<2) {
    if (!facts.motivo && !asked.includes('motivo')) id='motivo';
    else if (facts.motivo==='Fallas del servicio' && !facts.frecuencia) id='frecuencia';
  }
  if (intent==='soporte_tecnico') {
    if (facts.equipo==='Decodificador' && !facts.codigo) id='codigo';
    if (facts.sintoma==='Lentitud' && !facts.medio) id='medio';
    if (facts.sintoma==='Luz LOS roja' && !facts.duracion) id='duracion';
    else if (facts.sintoma==='Luz LOS roja' && !facts.cable) id='cable';
  }
  if (intent==='facturacion') {
    if (facts.objetivo==='Revisar un cargo' && !facts.cargo) id='cargo';
    if (facts.objetivo==='Pago sin reconexión' && !facts.pago) id='pago';
  }
  if (intent==='consulta_planes' && !facts.plan) {
    if (!facts.producto) id='producto';
    else if (facts.producto==='Hogar' && !facts.uso) id='uso';
    else if (facts.producto==='Hogar' && !facts.vivienda) id='vivienda';
  }
  if (intent==='portabilidad') {
    if (facts.incidencia && !facts.tramite) id='tramite';
    else if (!facts.direccion && (facts.incidencia || facts.objetivo)) id='direccion';
  }
  return id && !asked.includes(id) && !facts[id] ? questionById(id) : undefined;
}

export function recordQuestion(intake:CaseIntake, next:ContextQuestion) {
  if (!intake.asked.includes(next.id) && intake.asked.length<12) intake.asked.push(next.id);
  intake.pending=next.id;
}
