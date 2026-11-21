import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createAgent, createJevSemanticEvaluator } from '@claro/agent';
import { createDatabase } from '../dist/database.js';
import { databaseKnowledge } from '../dist/knowledge.js';

const paths = process.argv.slice(2);
if (paths.length !== 2) throw new Error('Pass the private golden and conversation JSONL paths.');
const suites = await Promise.all(paths.map(async (path) => {
  const raw = await readFile(path, 'utf8');
  return {
    hash: createHash('sha256').update(raw).digest('hex'),
    rows: raw.split(/\r?\n/).filter(line=>line.trim()).map(line=>JSON.parse(line))
  };
}));
const [golden, conversations] = suites;
const baseDate = process.env.DEMO_BUSINESS_DATE || '2026-11-18';
const normalize = input => input.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9%]+/g,' ').trim();
const db = await createDatabase().initialize();
const knowledge = databaseKnowledge(db);
const judge = process.env.JEV_ENABLE_EVALS === 'true' && process.env.OPENROUTER_API_KEY
  ? createJevSemanticEvaluator({apiKey:process.env.OPENROUTER_API_KEY,model:process.env.JEV_MODEL || 'typesafe/jev-1.14'}) : null;

function session(verified, channel, businessDate) {
  const messages = [];
  const calls = [];
  const safeRead = name => async () => { calls.push(name); return []; };
  const agent = createAgent({
    readCaseForRun: async () => ({verified,messages,pending:null}),
    getAgentConfig: async revision=>({revision,prompts:{}}),
    getCustomerContext:safeRead('crm'), getBilling:safeRead('billing'), getTickets:safeRead('tickets'),
    evaluateRetention:async()=>{
      calls.push('retention');
      return {eligible:false,reason:'Se requiere un replay con datos de negocio',facts:[],options:[],
        policy:{id:'evaluation-placeholder',title:'Política',version:'0',excerpt:'Ejecutar replay de plataforma.'}};
    },
    createProposal:async()=>{calls.push('proposal'); throw new Error('Run approval cases against the platform');}
  },{knowledge});
  return {
    calls,
    async run(actor,text) {
      const turn = messages.length + 1;
      const time = new Date().toISOString();
      const turnId = randomUUID();
      messages.push({ id:turnId,turn_seq:turn,actor,text,created_at:time });
      const mode = verified || actor === 'asesor' ? 'asistido' : 'autoservicio';
      return agent.run({
        run_id:randomUUID(), case_id:'quality',conversation_id:'quality',turn_id:turnId,channel,actor,
        turn_seq:turn,case_revision:1,attention_mode:mode,audience:mode==='asistido'?'asesor':'cliente',
        scope_ref:verified?'verified':'unverified',config_revision:'quality',business_date:businessDate,text
      });
    }
  };
}
try {
  const goldenResults = [];
  for (const item of golden.rows) {
    if (item.herramientas_esperadas?.length) {
      goldenResults.push({id:item.id,status:'platform_replay_required'});
      continue;
    }
    const fixture = session(false,'telegram',baseDate);
    const output = await fixture.run('cliente',item.pregunta);
    const answer = output.type==='answer'?output.answer:output.type==='handoff'?output.reason:'';
    const citations = output.type==='answer'?output.citations:[];
    const facts = item.puntos_clave ?? [];
    const deterministicPassed = output.type==='answer' && citations.length>0 && facts.length>0 &&
      facts.every(value=>normalize(answer).includes(normalize(value))) && fixture.calls.length===0;
    const semantic = judge ? (await judge.evaluate({
      question:item.pregunta,answer,evidence:citations.map(c=>c.excerpt),requiredFacts:facts,deterministicPassed
    })).status : 'disabled';
    goldenResults.push({id:item.id,status:deterministicPassed?'literal_match':'review',route:output.route,citations:citations.map(c=>c.id),semantic});
  }

  const conversationResults = [];
  for (const item of conversations.rows) {
    const replay = session(item.input.identity_status==='verified',item.input.channel, item.input.business_date);
    const observations = [];
    for (const [index, step] of item.input.steps.entries()) {
      if (step.type !== 'message') {
        observations.push({step:index+1,status:'platform_replay_required'});
        continue;
      }
      const output = await replay.run(step.actor,step.text);
      observations.push({step:index+1,route:output.route,type:output.type,
        citations:(output.type==='answer'?output.citations:output.type==='card'?output.card.citations:[]).map(c=>c.id)});
    }
    conversationResults.push({id:item.id,critical:item.critical,status:'review',observations});
  }
  console.log(JSON.stringify({
    gate:'review_required', business_date:baseDate, golden_sha256:golden.hash, complementary_sha256:conversations.hash,
    counts:{golden:goldenResults.length, literal_matches:goldenResults.filter(r=>r.status==='literal_match').length, complementary:conversationResults.length},
    golden:goldenResults, complementary:conversationResults
  }, null, 2));
} finally {
  await db.destroy();
}
