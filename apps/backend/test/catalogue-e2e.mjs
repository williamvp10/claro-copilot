import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { Client } from 'pg';

const [phase, statePath] = process.argv.slice(2);
const base = process.env.PLATFORM_E2E_TARGET;
const date = process.env.CATALOGUE_TEST_DATE;
const mobile = date==='2026-12-01' ? 'Claro Max 30 GB' : 'Claro Max 25 GB';
const version = date==='2026-12-01' ? 'CAT-2026 v2.0' : 'CAT-2026 v1.0';
const home = date==='2026-12-01' ? '$84.900' : '$89.900';
assert.ok(['prepare','resume'].includes(phase) && statePath && ['2026-11-30','2026-12-01'].includes(date) &&
  process.env.DEMO_MODE==='true' && new URL(base).hostname==='127.0.0.1' && !process.env.TELEGRAM_BOT_TOKEN,
  'Use a local seeded demo with simulated Telegram and an isolated state file');
const db = new Client({connectionString:process.env.DATABASE_URL});
await db.connect();
const api = '/api/v1';
async function request(path,{body,cookie,telegram}={}) {
  const response = await fetch(new URL(api+path,base),{
    method:body ? 'POST' : 'GET',
    headers:{Origin:process.env.BETTER_AUTH_URL, ...(cookie ? {Cookie:cookie} : {}),
      ...(body ? {'Content-Type':'application/json'} : {}),
      ...(telegram ? {'X-Telegram-Bot-Api-Secret-Token':process.env.TELEGRAM_WEBHOOK_SECRET} : {})},
    ...(body ? {body:JSON.stringify(body)} : {}),signal:AbortSignal.timeout(5000)
  });
  assert.ok(response.ok,`${path}: HTTP ${response.status}`);
  return {value:await response.json(),cookie:response.headers.getSetCookie().map(item=>item.split(';')[0]).join('; ')};
}
const open = cookie => request('/web-chat/session'+(cookie?'/new':''),{cookie,body:{}});
const web = (cookie,text) => request('/web-chat/messages',{cookie,body:{text,idempotency_key:randomUUID()}});
const telegram = (chat_id,text) => request('/webhooks/telegram',{telegram:true,body:{
  update_id:randomInt(10_000_000,2_000_000_000),message:{chat:{id:chat_id,type:'private'},text}
}});
async function eventually(read,check) {
  for (let attempt=0;attempt<60;attempt++) {
    const result=await read();
    if (result && check(result)) return result;
    await wait(200);
  }
  assert.fail('Timed out waiting for the conversational reply');
}
const history = cookie => request('/web-chat/history',{cookie}).then(item=>item.value);
async function rowFor(key,value) {
  const sql = key==='web' ? "snapshot->>'conversation_id'=$1" : 'contact_ref=$1';
  return (await db.query(`SELECT id,snapshot,handoff_pending FROM attention_case WHERE ${sql} AND snapshot->>'status'='open'`,[value])).rows[0];
}
const recent = (read,match) => eventually(read,state=>{
  const last=state.messages.at(-1);
  return last?.actor==='agente' && match(last.text);
});
const money = text=>text.includes(mobile+' cuesta $49.900 al mes, $50.000 menos que el Ilimitado');
const anchor = text=>text.includes('Claro Max Ilimitado cuesta $99.900 al mes');
function verifySources(state) {
  const last=state.messages.at(-1);
  assert.ok(last.citations?.length>0 && last.citations.every(c=>c.version===version && c.source?.page));
  assert.equal(state.awaiting_advisor ?? false,false);
  assert.equal(state.attention_mode,'autoservicio');
}
try {
  if (phase==='prepare') {
    const session=await open();
    const ref='qa-catalogue-'+randomUUID();
    const chat=randomInt(10_000_000,2_000_000_000);
    await db.query("INSERT INTO telegram_contact (ref,chat_id,display_name,fixture) VALUES ($1,$2,$3,'C-1001')",
      [ref,String(chat),'Prueba de catálogo']);
    await web(session.cookie,'¿Qué incluye Claro Max Ilimitado?');
    await telegram(chat,'¿Qué incluye Claro Max Ilimitado?');
    const readTelegram=()=>rowFor('telegram',ref).then(row=>row?.snapshot);
    for (const read of [()=>history(session.cookie),readTelegram]) verifySources(await recent(read,anchor));
    const byWeb=await rowFor('web',session.value.conversation_id);
    assert.equal(byWeb.snapshot.conversation_memory.anchor_plan,'claro max ilimitado');
    assert.equal((await readTelegram()).conversation_memory.anchor_plan,'claro max ilimitado');
    await writeFile(statePath,JSON.stringify({cookie:session.cookie,conversation:session.value.conversation_id,chat,ref}),{mode:0o600,flag:'wx'});
    console.log('Web and Telegram anchor saved in PostgreSQL. Ready for worker restart.');
  } else {
    const {cookie,conversation,chat,ref}=JSON.parse(await readFile(statePath,'utf8'));
    const channels=[
      {send:text=>web(cookie,text),read:()=>history(cookie)},
      {send:text=>telegram(chat,text),read:()=>rowFor('telegram',ref).then(row=>row?.snapshot)}
    ];
    for (const {send,read} of channels) {
      for (const query of ['¿Tienen planes más económicos?','No sé, dime tú. Yo no veo las referencias.','¿Y para mi casa?']) {
        await send(query);
        verifySources(await recent(read,query.includes('casa')
          ? text=>text.includes('Hogar Fibra 300') && text.includes(home) && !text.includes(mobile)
          : money));
      }
    }
    const telegramRow=await rowFor('telegram',ref);
    assert.match(telegramRow.snapshot.messages.at(-1).text,/Fuente|Ver fuente/);
    await eventually(async()=>Number((await db.query("SELECT count(*) FROM attention_event WHERE case_id=$1 AND kind='telegram_simulated'",[telegramRow.id])).rows[0].count),n=>n>=4);
    assert.equal((await history(cookie)).conversation_id,conversation);

    const fresh=await open(cookie);
    assert.notEqual(fresh.value.conversation_id,conversation);
    await web(fresh.cookie,'¿Hay algo más barato?');
    verifySources(await recent(()=>history(fresh.cookie),text=>[home,mobile,'¿Cuál te interesa?'].every(word=>text.includes(word))));
    await web(fresh.cookie,'Quiero un asesor.');
    assert.equal((await history(fresh.cookie)).awaiting_advisor,true);
    await web(fresh.cookie,'¿Tienen algo más barato?');
    assert.equal((await history(fresh.cookie)).awaiting_advisor,true);
    assert.equal((await rowFor('web',fresh.value.conversation_id)).handoff_pending,'Atención humana');

    const legacy=await open(fresh.cookie);
    await web(legacy.cookie,'¿Qué incluye Claro Max Ilimitado?');
    await recent(()=>history(legacy.cookie),anchor);
    const old=await rowFor('web',legacy.value.conversation_id);
    const timestamps=new Date().toISOString();
    const messages=old.snapshot.messages;
    messages.push({id:randomUUID(),turn_seq:messages.length+1,actor:'cliente',text:'¿Tienen planes más económicos?',created_at:timestamps},
      {id:randomUUID(),turn_seq:messages.length+2,actor:'agente',text:'Encontré una guía sobre el tema.',created_at:timestamps},
      {id:randomUUID(),turn_seq:messages.length+3,actor:'cliente',text:'No sé, dime tú.',created_at:timestamps},
      {id:randomUUID(),turn_seq:messages.length+4,actor:'agente',text:'No encontré información vigente suficiente para responder.',created_at:timestamps});
    delete old.snapshot.conversation_memory;
    await db.query("UPDATE attention_case SET snapshot=$1,handoff_pending='Consultar fuente autorizada' WHERE id=$2",[old.snapshot,old.id]);
    assert.equal((await history(legacy.cookie)).awaiting_advisor,true);
    await web(legacy.cookie,'Dime tú.');
    verifySources(await recent(()=>history(legacy.cookie),money));
    assert.equal((await rowFor('web',legacy.value.conversation_id)).handoff_pending,null);
    console.log(`${version}: same web and Telegram cases after restart, plan, savings, citations, home switch, reset and explicit/obsolete queues passed.`);
  }
} finally {
  await db.end();
}
