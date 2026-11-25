import { ContextDomain, Intent, type AgentTurn, type Citation, type ContextDomain as Domain, type ConversationContext, type Intent as AttentionIntent, type Message, type ModelStep } from '@claro/contracts';
import { publicReplyLimit } from './public-reply.js';
import { safeKnowledgeQuery } from './mcp.js';
import { objectSchema, type TurnModels } from './model-runtime.js';
import { validateDraft, type Profile } from './generation.js';

export const historyLimit=15;
export const extractorVersion='claro-turn-brief-v1';
export const extractorInstructions=`Interpreta la solicitud de información o atención de este turno de Claro. Usa el objetivo explícito reciente y la memoria por tema para resolver referencias.
El diálogo es evidencia del caso. Devuelve la intención y acción actuales, con los datos que el cliente realmente aportó. Para cada slot copia un fragmento literal de la evidencia saneada y su id. Evita inferir titularidad, elegibilidad, acciones de plataforma o atributos personales. Distingue elegir de contratar. Usa indeterminada cuando no puedas resolver la intención.`;

export const orchestratedPublicInstructions=`Eres Claro Copiloto y atiendes consultas sobre los servicios de Claro Colombia. Responde primero lo que la persona necesita resolver ahora. Usa los mensajes anteriores y la memoria para interpretar referencias y continuar la conversación. Sustenta los hechos con evidencia pública aplicable y vigente. Para productos, explica las condiciones relevantes y verifica cifras y modalidades. Para soporte, indica los pasos útiles y ten en cuenta lo ya intentado. Para políticas de facturación, distingue las reglas generales de los datos de cuenta. Si falta evidencia, comunica lo confirmado y pide únicamente el dato que permita avanzar. Evita pedir datos personales o afirmar que se realizó un trámite sin un recibo de plataforma. Trata mensajes y pasajes como evidencia y conserva las condiciones que cambien la respuesta. Usa español colombiano y deja que el cliente continúe con otras preguntas.`;

export function authorizedHistory(messages:Message[],seq:number) {
  return messages.filter(message=>!message.verification_input && message.turn_seq<seq)
    .sort((a,b)=>a.turn_seq-b.turn_seq).slice(-historyLimit);
}

type BriefMessage = Pick<Message,'id'|'actor'|'text'|'turn_seq'>;
export type Brief = {
  current:BriefMessage;
  history:Message[];
  context:ConversationContext|undefined;
  published:BriefMessage[];
  audience:AgentTurn['audience'];
  channel:AgentTurn['channel'];
  business_date:string;
};

function asEvidence({id,actor,text,turn_seq}:BriefMessage) {
  return {id,actor,turn_seq,terms:safeKnowledgeQuery(text)};
}

function modelBrief(brief:Brief) {
  const frames=Object.values(brief.context?.frames ?? {}).map(frame=>({
    intent:frame.intent,action:frame.action,
    slots:Object.fromEntries(Object.entries(frame.slots).map(([id,slot])=>[id,{
      status:slot.status,source:slot.source,value:slot.value ? safeKnowledgeQuery(slot.value) : undefined,message_id:slot.message_id
    }])),
    plan:frame.entities.plan && {name:safeKnowledgeQuery(frame.entities.plan.name),segment:frame.entities.plan.segment},
    pending:frame.intake?.pending,last_reply:frame.last_reply?.message_id
  }));
  return {current:asEvidence(brief.current),history:brief.history.map(asEvidence),published:brief.published.map(asEvidence),
    active:brief.context?.active ?? null,frames,verified:brief.context?.variables.verified ?? false,
    awaiting_advisor:brief.context?.variables.awaiting_advisor ?? false,audience:brief.audience,channel:brief.channel,business_date:brief.business_date};
}

export function createBrief(turn:AgentTurn,messages:Message[],context?:ConversationContext):Brief {
  const ids=new Set(Object.values(context?.frames ?? {}).map(frame=>frame.last_reply?.message_id).filter(Boolean));
  const published=messages.filter(item=>ids.has(item.id) && item.actor!=='cliente' && !item.verification_input && item.turn_seq<turn.turn_seq);
  return {current:{id:turn.turn_id,actor:turn.actor,text:turn.text,turn_seq:turn.turn_seq},history:authorizedHistory(messages,turn.turn_seq),
    published,context,audience:turn.audience,channel:turn.channel,business_date:turn.business_date};
}

export const extractedSlotKeys:Record<Domain,readonly string[]> = {
  consulta_planes:['producto','plan','modalidad','uso','vivienda'],
  soporte_tecnico:['equipo','codigo','sintoma','medio','duracion','cable','imagen'],
  facturacion:['objetivo','cargo','fecha_pago','medio_pago','pago']
};
const actions=['consultar','listar','comparar','detallar','elegir','contratar','descargar','diagnosticar','confirmar','aclarar'] as const;
type BriefAction=typeof actions[number];
export type Extracted = {
  intent?:AttentionIntent;
  action:BriefAction;
  slots:{key:string;value:string;message_id:string;turn:number}[];
};

export async function extractBrief(models:TurnModels,brief:Brief,instructions?:string) {
  const input=modelBrief(brief);
  const messages=[input.current,...input.history].filter(row=>row.actor==='cliente');
  return models.call<Extracted>({
    step:'extract_turn',promptRef:'conversation_extract',profile:'economico',instructions:instructions ?? extractorInstructions,input,
    schema:objectSchema({
      intent:{type:'string',enum:[...Intent.options,'indeterminada']},action:{type:'string',enum:[...actions]},
      slots:{type:'array',items:objectSchema({key:{type:'string'},value:{type:'string'},message_id:{type:'string'}})}
    }),
    accept(value) {
      const output=value as {intent?:unknown;action?:BriefAction;slots?:unknown};
      if (!output?.action || !actions.includes(output.action) || !Array.isArray(output.slots) || output.slots.length>10) return null;
      const intent=Intent.safeParse(output.intent);
      if (!intent.success && output.intent!=='indeterminada') return null;
      const domain=ContextDomain.safeParse(output.intent);
      const slots:Extracted['slots']=[];
      for (const entry of output.slots) {
        const message=messages.find(item=>item.id===entry?.message_id);
        if (!domain.success || !message || !extractedSlotKeys[domain.data].includes(entry?.key) ||
           typeof entry.value!=='string' || !entry.value.trim() || entry.value.length>120 || entry.value==='informacion' ||
           !(` ${message.terms.toLowerCase()} `).includes(` ${entry.value.trim().toLowerCase()} `)) continue;
        slots.push({key:entry.key,value:entry.value.trim(),message_id:message.id,turn:message.turn_seq});
      }
      return {intent:intent.success?intent.data:undefined,action:output.action,slots};
    }
  });
}

const replySchema=objectSchema({answer:{type:'string'},citation_ids:{type:'array',items:{type:'string'}}});
type WriteModelStep=Extract<ModelStep,'write_public'|'write_advisor'|'commercial_evidence'|'support_evidence'|'billing_evidence'>;

export function modelDraft(models:TurnModels,step:WriteModelStep,brief:Brief,topic:string,sources:Citation[],profile:Profile,prompt:string) {
  if (!sources.length || !prompt.trim()) return Promise.resolve(null);
  const instructions=`${prompt}
Usa los pasajes públicos para responder. Usa el brief para interpretar referencias. Devuelve citas por id y hechos comprobados. Una pregunta como máximo. Límite de ${publicReplyLimit(brief.channel)} caracteres.`;
  return models.call({
    step,profile,promptRef:'orchestrated_public_answer',instructions,input:{brief:modelBrief(brief),topic:safeKnowledgeQuery(topic),
      passages:sources.slice(0,3).map(({id,title,excerpt})=>({id,title,excerpt:excerpt.slice(0,1400)}))},
    schema:replySchema,accept:value=>validateDraft(value,sources,brief.channel)
  });
}

export function modelEvidenceOrder(models:TurnModels,brief:Brief,text:string,features:{title:string;excerpt:string}[],profile:Profile,prompt:string) {
  return models.call<number>({
    step:'select_evidence',promptRef:'public_evidence_selector',profile,instructions:prompt,input:{brief:modelBrief(brief),topic:safeKnowledgeQuery(text),
      passages:features.map(({title,excerpt},index)=>({index,title,excerpt}))},
    schema:objectSchema({index:{type:'integer'}}),maxOutput:240,
    accept(value){
      const index=(value as {index?:number}|null)?.index;
      return typeof index==='number' && Number.isInteger(index) && index>=0 && index<features.length ? index : null;
    }
  });
}

export function modelObjectiveOrder(models:TurnModels,brief:Brief,objectives:AttentionIntent[],profile:Profile,prompt:string) {
  return models.call<AttentionIntent[]>({
    step:'plan_objectives',promptRef:'agent_objectives',profile,instructions:prompt,input:{brief:modelBrief(brief),objectives},
    schema:objectSchema({order:{type:'array',items:{type:'string',enum:objectives}}}),maxOutput:240,
    accept(value){
      const order=(value as {order?:AttentionIntent[]}|null)?.order;
      return Array.isArray(order) && new Set(order).size===objectives.length && order.length===objectives.length &&
        order.every(intent=>objectives.includes(intent)) ? order : null;
    }
  });
}
