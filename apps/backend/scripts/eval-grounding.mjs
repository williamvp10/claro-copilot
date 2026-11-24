import { isExtractiveAnswer, normalizeEvidence, verifiesBillingDeadline } from './eval-local-checks.mjs';

const flat = text => text.replace(/\s+/gu, ' ').trim();
const fold = text => flat(text).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const unique = values => [...new Set(values)];

export const citationKey = ({id,version}) => JSON.stringify([id,version]);

export function publishedCitations(citations, documents, {audience,channel,businessDate}) {
  if (!citations.length || new Set(citations.map(citationKey)).size!==citations.length) return [];
  const sources = citations.map(citation => documents.get(citationKey(citation)));
  return sources.every((source,index) => {
    const citation=citations[index];
    return source?.status==='ready' && source.title===citation.title && source.excerpt===citation.excerpt &&
      (source.scope==='public' || audience==='asesor') && source.effective_from<=businessDate &&
      (!source.effective_to || businessDate<source.effective_to) && (!source.channels || source.channels.includes(channel));
  }) ? sources : [];
}

function bundleFromCatalogue(answer, sources) {
  const claim = answer.match(/^(Triple Play|Hogar Fibra) (\d{2,4}) cuesta (\$[\d.]+) al mes e incluye (.+)\.$/i);
  if (!claim) return false;
  const [,product,speed,price,included]=claim;
  const home=product.toLowerCase()==='hogar fibra';
  const row = new RegExp('^'+product+' '+speed+' +(\\d+) Mbps +(\\$[\\d.]+) +(.+)$','i');
  const rows = sources.filter(source=>source.type==='catalogo').flatMap(({excerpt})=>{
    if (!/\bprecio\s+mensual\b/i.test(excerpt)) return [];
    const lines=excerpt.split(/\r?\n/).map(line=>line.trim());
    return lines.flatMap((line,index)=>{
      const observed=line.match(row);
      if (!observed || observed[1]!==speed) return [];
      const continuation=[];
      if (!home) {
        for (const next of lines.slice(index+1)) {
          if (!/^\p{Ll}/u.test(next)) break;
          continuation.push(next);
        }
      }
      const benefits=(home?speed+' Mbps, ':'')+flat([observed[3],...continuation].join(' ')).replace(/ \+ /g,', ').replace(/\.$/,'');
      return [JSON.stringify([observed[2],benefits])];
    });
  });
  return unique(rows).length===1 && rows[0]===JSON.stringify([price,included]);
}

function quotedBody(answer,sources) {
  return sources.some(({excerpt,type})=>{
    const text=flat(excerpt);
    if (type==='soporte') {
      const answerAfterHeading=excerpt.match(/^## [^\r\n]+\r?\n([\s\S]+)$/)?.[1];
      if (answerAfterHeading && flat(answerAfterHeading)===answer) return true;
      const allowedHeading=/^\d+\.\s+(?=Restablecimiento de fábrica:)|^\d+\.\s+Control parental\s+(?=El PIN de control parental por defecto)/;
      if (allowedHeading.test(text) && text.replace(allowedHeading,'')===answer) return true;
    }
    return false;
  });
}

function verifyAdvisorPromotion(question,answer,sources) {
  const subject=fold(question);
  const claim=fold(answer).match(/^la promocion es para altas nuevas \(solo clientes nuevos de internet hogar\)\. para un cliente actual que cambia de plan, aplica el precio de lista(?: \((\$[\d.]+) al mes\))?\.$/);
  if (!claim || !/\bfibra\s+500\b/.test(subject) || !/\bpromoci\w*\b/.test(subject) ||
      !/\bcliente actual\b/.test(subject) || /\bcancel\w*\b/.test(subject)) return false;
  const policy=sources.some(source=>source.scope==='advisor' && source.type==='boletin' &&
    /\bpromocion fibra 500\b/.test(fold(source.excerpt)) &&
    /\baplica (?:unicamente|solo) a clientes nuevos de internet hogar\b/.test(fold(source.excerpt)) &&
    /\ba los clientes actuales que quieran mejorar su plan se les aplica el precio de lista\b/.test(fold(source.excerpt)));
  if (!policy || !claim[1]) return policy;
  const rates=unique(sources.filter(source=>source.type==='catalogo' && /\bprecio\s+mensual\b/i.test(source.excerpt)).flatMap(({excerpt})=>
    [...excerpt.matchAll(/^Hogar Fibra 500 +500 Mbps +(\$[\d.]+) /gmi)].map(match=>match[1])));
  return rates.length===1 && rates[0]===claim[1];
}

function verifyEscalation(answer,sources) {
  const supervised=answer.match(/^Escalar a un supervisor humano\. (El cliente menciona acciones legales: .+\.)$/);
  if (supervised) return sources.some(({type,excerpt})=>type==='politica' &&
    /^\d+\.\s+Escalamiento obligatorio a supervisor humano$/mi.test(excerpt) &&
    excerpt.split(/\r?\n/).some(line=>flat(line)===supervised[1]));
  const support=fold(answer).match(/^(verificar que el cable de fibra este conectado y sin dobleces\. )?si la luz los sigue roja por mas de (\d+) minutos, escalar a soporte tecnico nivel 2 por posible falla de fibra\.$/);
  if (!support) return false;
  const thresholds=unique(sources.filter(({type})=>type==='politica').flatMap(({excerpt})=>{
    if (!/^\d+\.\s+escalamiento a soporte tecnico nivel 2$/mi.test(excerpt.normalize('NFD').replace(/[\u0300-\u036f]/g,''))) return [];
    return [...fold(excerpt).matchAll(/indicador los en rojo en el modem por mas de (\d+) minutos \(falla de fibra\)\./g)].map(match=>match[1]);
  }));
  const cable=sources.some(({type,excerpt})=>type==='soporte' && /\blos rojo\b[^.]*\bcable de fibra no este doblado ni desconectado\b/.test(fold(excerpt)));
  return thresholds.length===1 && thresholds[0]===support[2] && (!support[1] || cable);
}

function verifyWifiConfiguration(answer,sources) {
  const steps=fold(answer).match(/^abre ((?:\d{1,3}\.){3}\d{1,3}) en el navegador\. entra con el usuario ([a-z\d_-]+) y la clave de la etiqueta\. ve a (.+)\. cambia la contrasena(?: \(minimo (\d+) caracteres\))? y guarda\.$/);
  if (!steps || sources.length!==3 || !sources.every(source=>source.type==='soporte' &&
      source.version===sources[0].version && source.scope===sources[0].scope)) return false;
  const indices=sources.map(({id})=>id.match(/^(.+)-(\d{3})$/));
  if (!indices[0] || !indices.every((match,index)=>match?.[1]===indices[0][1] &&
      Number(match[2])===Number(indices[0][2])+index)) return false;
  const [entry,login,settings]=sources.map(source=>fold(source.excerpt));
  const ip=entry.match(/^2\. abra un navegador e ingrese a https?:\/\/((?:\d{1,3}\.){3}\d{1,3})\.$/)?.[1];
  const user=login.match(/^3\. usuario: ([a-z\d_-]+)\. contrasena: la indicada en la etiqueta(?: inferior del equipo)?\.$/)?.[1];
  const details=settings.match(/^4\. vaya a ([a-z\d _>-]+), cambie (?:el nombre de red y )?la contrasena(?: \(minimo (\d+) caracteres\))? y guarde\.$/);
  if (!ip || !user || !details || ip!==steps[1] || user!==steps[2] || details[2]!==steps[4]) return false;
  const menu=details[1].split('>').map(flat);
  return menu.length>=2 && menu.slice(0,-1).join(', ')+' y '+menu.at(-1)===steps[3];
}

function mobileThrottle(answer, sources) {
  const claim = fold(answer).match(/^despues de consumir (\d+ gb), la velocidad baja a (\d+ mbps) hasta el siguiente ciclo de facturacion\.$/);
  if (!claim) return false;
  const limits = sources.filter(source=>source.type==='catalogo').flatMap(({excerpt})=>
    [...fold(excerpt).matchAll(/\bplan ilimitado:\s*despues de consumir (\d+ gb) en el ciclo de facturacion,\s*la velocidad de navegacion se reduce a (\d+ mbps) hasta el siguiente ciclo\b/g)]
      .map(match=>JSON.stringify(match.slice(1))));
  return unique(limits).length===1 && limits[0]===JSON.stringify(claim.slice(1));
}

function mobileContract(answer, sources) {
  const [condition, financing] = answer.split(/(?<=\.) /);
  if (!financing || !/^los planes moviles pospago no tienen permanencia minima\.$/.test(fold(condition)) ||
      !/^si el usuario .*equipo financiado.*saldo pendiente.*\.$/.test(fold(financing))) return false;
  return sources.filter(source=>source.type==='contrato').some(({excerpt})=>{
    const body=flat(excerpt);
    const contract=body.match(/(?:^|\.\s|permanencia\s)(Los planes móviles pospago no tienen cláusula de permanencia mínima\.)/i)?.[1];
    const quote=body.match(/(?:^|\.\s)(Si el usuario [^.]*equipo financiado[^.]*saldo pendiente[^.]*\.)/i)?.[1];
    return quote===financing && contract?.replace(/cláusula de /i,'')===condition && answer===condition+' '+financing;
  });
}

function retentionRange(label, months) {
  const range=fold(label).match(/^(mas de|menos de|entre) (\d+)(?: y (\d+))? meses$/);
  if (!range) return false;
  const [,kind,lower,upper]=range;
  if (kind==='entre') return months>=Number(lower) && months<=Number(upper);
  return upper===undefined && (kind==='mas de' ? months>Number(lower) : months<Number(lower));
}

function policyOffers(question, answer, sources) {
  const periods = unique([...normalizeEvidence(question).matchAll(/\b(\d{1,3}) meses (?:de antiguedad|como cliente)\b/g)].map(match=>Number(match[1])));
  const claims = answer.match(/^Si CRM confirma la elegibilidad, la política para ese tramo indica estas opciones\. Opción A: (.+)\. Opción B: (.+)\.$/);
  if (periods.length!==1 || !claims) return false;
  const eligibleRows=sources.filter(source=>source.scope==='advisor' && source.type==='politica' && /^POL-RET-/.test(source.version)).flatMap(({excerpt})=>
    excerpt.split(/\r?\n/).flatMap(line=>{
      const [range,...options]=line.split('|').map(flat);
      return options.length===2 && options.every(Boolean) && retentionRange(range,periods[0]) ? [JSON.stringify(options)] : [];
    }));
  return eligibleRows.length===1 && eligibleRows[0]===JSON.stringify(claims.slice(1));
}

function verifySignalRefresh(answer,sources) {
  const wait=fold(answer).match(/^abre mi claro, entra en mi tv y elige «refrescar senal»\. deja el decodificador encendido y espera hasta (\d{1,2} minutos?)\.(?: cuando termine la espera, cuentame: ¿volvio la imagen\?)?$/)?.[1];
  if (!wait) return false;
  const durations=unique(sources.filter(source=>source.type==='soporte').flatMap(({excerpt})=>{
    const text=fold(excerpt);
    if (!/\be[ -]?202\b/.test(text) || !/\bmi claro\W+mi tv\W+refrescar senal\b/.test(text) ||
        !/\b(?:equipo|decodificador) encendido\b/.test(text)) return [];
    return [...text.matchAll(/\besper(?:a|ar|e) hasta (\d{1,2} minutos?)\b/g)].map(match=>match[1]);
  }));
  return durations.length===1 && durations[0]===wait;
}

export function verifyPublishedAnswer({question,answer,sources}) {
  if (!sources.length) return null;
  if (isExtractiveAnswer(answer,sources)) return 'extractive';
  if (verifiesBillingDeadline(question,answer,sources)) return 'billing_deadline_calculation';
  const text=flat(answer);
  if (quotedBody(text,sources)) return 'quoted_source_section';
  if (bundleFromCatalogue(text,sources)) return 'catalogue_bundle';
  if (mobileThrottle(text,sources)) return 'mobile_throttle_policy';
  if (mobileContract(text,sources)) return 'mobile_contract_terms';
  if (policyOffers(question,text,sources)) return 'retention_policy_matrix';
  if (verifyAdvisorPromotion(question,text,sources)) return 'promotion_policy_and_catalogue';
  if (verifyEscalation(text,sources)) return 'escalation_policy';
  if (verifyWifiConfiguration(text,sources)) return 'wifi_manual_steps';
  if (verifySignalRefresh(text,sources)) return 'signal_refresh_manual';
  return null;
}
