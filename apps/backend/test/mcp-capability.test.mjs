import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signCapability, verifyCapability } from '../src/mcp-capability.ts';

test('capability binds audience, case revision, tools and short expiry', () => {
 const key='test-signing-key-which-is-at-least-32-characters';
 const now=1_700_000_000_000;
 const cap={run_id:'run-1',case_id:'case-1',case_revision:2,aud:'billing',exp:now+15000,actions:['billing.get_balance']};
 const signed=signCapability(cap,key);
 assert.deepEqual(verifyCapability(signed,key,'billing',now),cap);
 assert.throws(()=>verifyCapability(signed,key,'crm',now));
 assert.throws(()=>verifyCapability(signed,key,'billing',now+15000));
 assert.throws(()=>verifyCapability(signed,'other-key','billing',now));
 const payload=Buffer.from(JSON.stringify({...cap,case_revision:3,actions:['billing.list_invoices']})).toString('base64url');
 assert.throws(()=>verifyCapability(`${payload}.${signed.split('.')[1]}`,key,'billing',now));
 assert.throws(()=>verifyCapability(signCapability({...cap,exp:now+60001},key),key,'billing',now));
});
