import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export type McpDomain = 'crm' | 'billing';
export type McpCapability = {run_id:string;case_id:string;case_revision:number;aud:McpDomain;exp:number;actions:string[]};
export function signCapability(cap:McpCapability, key:string):string {
 const payload=Buffer.from(JSON.stringify(cap)).toString('base64url');
 return `${payload}.${createHmac('sha256',key).update(payload).digest('base64url')}`;
}
export function verifyCapability(raw:string, key:string, audience:McpDomain, now=Date.now()):McpCapability {
 const [payload,signature,extra]=raw.split('.');
 if (!payload || !signature || extra) throw new Error('invalid capability');
 const expected=createHmac('sha256',key).update(payload).digest(), actual=Buffer.from(signature,'base64url');
 if (actual.length!==expected.length || !timingSafeEqual(actual,expected)) throw new Error('invalid signature');
 const cap=z.object({run_id:z.string().min(1),case_id:z.string().min(1),case_revision:z.number().int().positive(),aud:z.enum(['crm','billing']),exp:z.number().finite(),actions:z.array(z.string()).min(1).max(8)}).strict().parse(JSON.parse(Buffer.from(payload,'base64url').toString()));
 if (cap.aud!==audience || cap.exp<=now || cap.exp>now+60000) throw new Error('invalid audience or expiration');
 return cap;
}
