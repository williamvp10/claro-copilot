import type { Message, ModelProfile } from '@claro/contracts';
import { objectSchema, type TurnModels } from './model-runtime.js';

type History = Pick<Message, 'id' | 'actor' | 'text'>[];
const schema = objectSchema({text:{type:'string'},references:{type:'array',items:{type:'string'}}});

export function assistedHistory(messages: Message[], turn?: number): History {
  return messages.filter(message=>!message.attention_notice && !message.verification_input &&
    (turn === undefined || message.turn_seq<=turn)).slice(-16).map(({id,actor,text})=>({id,actor,text:text.slice(0,900)}));
}

export async function assistedWriting(models:TurnModels, promptRef:'assisted_case_summary'|'escalation_reason'|'assisted_reply',
  instructions:string, profile:ModelProfile, history:History, context:object) {
  if (!history.some(message=>message.actor==='cliente')) return null;
  const limit=promptRef==='escalation_reason' ? 500 : 1000;
  const allowedIds=new Set(history.map(message=>message.id));
  const numbers=(value:string)=>value.match(/\d+(?:[.,]\d+)*/g) ?? [];
  const knownNumbers=new Set(numbers(JSON.stringify({history:history.map(message=>message.text),context})));
  return models.call({step:'write_advisor',profile,promptRef,instructions,input:{history,context},schema,maxOutput:450,
    accept(value) {
      if (!value || typeof value!=='object') return null;
      const fields=value as Record<string,unknown>;
      if (typeof fields.text!=='string' || !Array.isArray(fields.references) ||
          !fields.references.every((ref:unknown):ref is string=>typeof ref==='string')) return null;
      const text=fields.text.trim(),references=fields.references as string[];
      if (text.length<3 || text.length>limit || !references.length || references.length>16 || references.some(ref=>!allowedIds.has(ref)) ||
          numbers(text).some(value=>!knownNumbers.has(value)) || /https?:\/\/|<[^>]*>|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\+?\d(?:[ .()-]*\d){6,}/i.test(text)) return null;
      return {text,references};
    }});
}
