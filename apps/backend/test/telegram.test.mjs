import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  activeTelegramConnection, callTelegram, encryptTelegramCredentials, readTelegramConnection, telegramWebhookTarget
} from '../dist/telegram.js';

const token = '123456789:demo_telegram_token_for_testing';
const secret = 'demo_webhook_secret';

function env(t, settings) {
  const previous = Object.fromEntries(Object.keys(settings).map(key=>[key,process.env[key]]));
  Object.assign(process.env,settings);
  t.after(()=>{
    for (const [key,value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('managed credentials are authenticated and withheld until the webhook is registered', async t=>{
  env(t,{BETTER_AUTH_SECRET:'test-only-secret',TELEGRAM_BOT_TOKEN:'legacy',TELEGRAM_WEBHOOK_SECRET:'legacy'});
  const credentials = encryptTelegramCredentials({token,secret});
  assert.ok(!credentials.includes(token));
  assert.ok(!credentials.includes(secret));
  assert.notEqual(encryptTelegramCredentials({token,secret}),credentials);
  const row = {credentials,bot_username:'DemoTestingBot',registered:false};
  const db = {query:async()=>[row]};
  assert.equal((await readTelegramConnection(db)).token,token);
  assert.equal(await activeTelegramConnection(db),undefined);
  row.registered=true;
  assert.equal((await activeTelegramConnection(db)).secret,secret);
  row.credentials=credentials.replace(/\.([^.])(?=[^.]+$)/,(_,char)=>char==='A'?'.B':'.A');
  const edited = await activeTelegramConnection(db);
  assert.equal(edited.unreadable,true);
  assert.equal(edited.token,undefined);
  assert.equal(edited.secret,undefined);
});

test('legacy webhook secret works without an outbound bot and webhook setup requires HTTPS', async t=>{
  env(t,{BETTER_AUTH_URL:'http://localhost:39092',TELEGRAM_BOT_TOKEN:'',TELEGRAM_WEBHOOK_SECRET:'legacy'});
  const db = {query:async()=>[]};
  const legacy = await activeTelegramConnection(db);
  assert.equal(legacy.source,'environment');
  assert.equal(legacy.secret,'legacy');
  assert.equal(legacy.token,undefined);
  assert.equal(telegramWebhookTarget(),null);
  process.env.BETTER_AUTH_URL='https://chat.example.test';
  assert.equal(telegramWebhookTarget(),'https://chat.example.test/api/v1/webhooks/telegram');
});

test('Telegram API errors never expose the token or provider message',async t=>{
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(url,`https://api.telegram.org/bot${token}/getMe`);
    assert.equal(options.redirect,'error');
    return Response.json({ok:false,error_code:401,description:token},{status:401});
  });
  await assert.rejects(callTelegram(token,'getMe'),error=>{
    assert.equal(error.rejectedToken,true);
    assert.ok(!JSON.stringify(error).includes(token));
    assert.ok(!error.message.includes(token));
    return true;
  });
});
