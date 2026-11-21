import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createAgent, createOpenAIPublicWriter, createJevDecisionAdapter, createJevSemanticEvaluator } from '@claro/agent';
import { createDatabase } from '../dist/database.js';
import { databaseKnowledge } from '../dist/knowledge.js';
import { exportAgentSpan } from '../dist/telemetry.js';

const [goldenPath, scenariosPath, candidateId, outputPath] = process.argv.slice(2);
if (!goldenPath || !scenariosPath || !candidateId || !outputPath) {
  throw new Error('Usage: quality:compare GOLDEN.jsonl SCENARIOS.jsonl CANDIDATE_ID REPORT.json');
}
const sha = value => createHash('sha256').update(value).digest('hex');
const readSuite = async (path, count) => {
  const text = await readFile(path, 'utf8');
  const rows = text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  if (rows.length !== count || new Set(rows.map(row=>row.id)).size !== count) throw new Error('Unexpected evaluation suite');
  return { rows, sha256: sha(text) };
};
const [golden, scenarios] = await Promise.all([readSuite(goldenPath, 30), readSuite(scenariosPath, 19)]);
const date = process.env.DEMO_BUSINESS_DATE || '2026-11-18';
const live = process.env.PROMPT_EVAL_PROVIDERS === 'live';
const key = live ? process.env.OPENROUTER_API_KEY : undefined;
if (live && (!key || !process.env.OPENAI_API_KEY)) throw new Error('Live evaluation requires both provider keys');
const jev = key ? {apiKey:key,model:process.env.JEV_MODEL || 'typesafe/jev-1.14',timeoutMs:3500} : null;
const judge = jev && createJevSemanticEvaluator(jev);
const decision = jev && createJevDecisionAdapter(jev);
const writer = live && createOpenAIPublicWriter({apiKey:process.env.OPENAI_API_KEY});
const normalized = input => input.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9%]+/g,' ').trim();
const contents = result => result.type === 'answer' ? result.answer : result.type === 'handoff' ? result.reason :
  result.type === 'card' ? [result.card.summary, ...result.card.facts.map(x=>x.value)].join(' ') : '';
const cited = result => result.type === 'answer' ? result.citations : result.type === 'card' ? result.card.citations : [];
const fallbackPolicy = {id:'evaluation-placeholder',title:'Política',version:'0',excerpt:'Verificar los efectos con un replay de plataforma.'};
const db = await createDatabase().initialize();

function fixture(revision, verified, channel, businessDate, knowledge) {
  const messages = [], calls = [], events = [];
  let currentTurn;
  const read = name => async () => { calls.push(name); return []; };
  const agent = createAgent({
    readCaseForRun:async()=>({verified,messages,pending:null}),
    getAgentConfig:async()=>revision,
    getCustomerContext:read('obtenerCliente'),getBilling:read('listarFacturas'),getTickets:read('listarTickets'),
    evaluateRetention:async()=>({eligible:false,reason:'Requiere replay de plataforma',facts:[],options:[],policy:fallbackPolicy}),
    createProposal:async()=>{ calls.push('proposal'); throw new Error('Requires platform-controlled approval'); }
  }, {knowledge, ...(writer ? {writer} : {}), ...(decision && !verified ? {decision} : {}), observe:(_, item)=>events.push(item)});
  return { calls, events, async run(actor,text) {
    calls.length=0;
    events.length=0;
    const started = Date.now(), turn_id = randomUUID();
    messages.push({id:turn_id,turn_seq:messages.length+1,actor,text,created_at:new Date().toISOString()});
    const mode = verified || actor === 'asesor' ? 'asistido' : 'autoservicio';
    currentTurn={
      run_id:randomUUID(),case_id:'edd',conversation_id:'edd',turn_id,channel,actor,turn_seq:messages.length,
      case_revision:1,attention_mode:mode,audience:mode==='asistido'?'asesor':'cliente',scope_ref:verified?'verified':'unverified',
      config_revision:revision.revision,business_date:businessDate,text
    };
    const result=await agent.run(currentTurn);
    await exportAgentSpan(currentTurn,started,result.route,result.type,events);
    return result;
  } };
}

async function score(id, input, result, session, required, forbidden, authorizesReads, expectedSourceIds, judgeEvidence) {
  const answer = contents(result), citations = cited(result);
  const usedPrivateRead = session.calls.length > 0 && !authorizesReads;
  const forbiddenHit = forbidden.some(value=>normalized(answer).includes(normalized(value)));
  const deterministic = !usedPrivateRead && !forbiddenHit && result.type !== 'failed';
  const expectedFacts = required.length > 0 && required.every(value=>normalized(answer).includes(normalized(value)));
  const semantic = judge && !authorizesReads && deterministic && citations.length > 0 && required.length > 0
    && citations.every(citation => judgeEvidence.has(JSON.stringify([citation.id,citation.version])))
    ? await judge.evaluate({question:input,answer,evidence:citations.map(x=>x.excerpt),requiredFacts:required,forbiddenFacts:forbidden,deterministicPassed:true})
    : null;
  const retrieval = session.events.find(item=>item.name==='retrieval');
  const top = String(retrieval?.metadata.top_5 ?? '').split(',').filter(Boolean);
  const recall = expectedSourceIds.length
    ? expectedSourceIds.filter(aliases=>aliases.some(prefix=>top.some(value=>value.startsWith(prefix)))).length/expectedSourceIds.length
    : null;
  const grounded = semantic && semantic.decisions.length ? semantic.decisions.every((x)=>
    x.criterion.startsWith('required') ? x.choice==='presente' : x.choice==='ausente') : null;
  const correct = deterministic && expectedFacts && citations.length>0 && (recall===null || recall===1) && semantic?.status!=='fail';
  return { id, route:result.route, result:result.type, citations:citations.map(x=>x.id), usedPrivateRead, forbiddenHit,
    score:correct?'verified_exact':deterministic?'review':'failed', semantic:semantic?.status ?? 'unavailable',
    recall, grounded, remote_generation:session.events.some(item=>item.name==='generation.openai' && item.metadata.status==='accepted'),
    cost_usd:session.events.reduce((sum,item)=>sum+Number(item.metadata.cost_usd ?? 0),0) };
}

function evidencePrefixes(sources = []) {
  const mapping = {
    'Catalogo_Planes_Claro_2026.pdf':['catalogo-v1','catalogo-2026'],
    'FAQ_Atencion_Clientes.md':['faq'],
    'Manual_Decodificador_DecoBox4K.pdf':['deco'],
    'Manual_Modem_ZTX-F680.pdf':['modem'],
    'Politica_Retencion_Clientes.docx':['retencion'],
    'Politica_Escalamiento_Atencion.docx':['escalamiento'],
    'Politica_Portabilidad_Numerica.docx':['portabilidad'],
    'Politica_Facturacion_y_Pagos.docx':['facturacion'],
    'Contrato_Servicios_Hogar.docx':['contrato-hogar'],
    'Contrato_Servicios_Movil_Pospago.docx':['contrato-movil']
  };
  return sources.filter(source=>!source.endsWith('-api')).map(source=>mapping[source] ?? []);
}

async function batch(rows, run) {
  const results=[];
  for (let index=0;index<rows.length;index+=4) {
    results.push(...await Promise.all(rows.slice(index,index+4).map(run)));
  }
  return results;
}

async function replay(revision, knowledge, judgeEvidence) {
  const questions=await batch(golden.rows,async row=>{
    const scope = row.herramientas_esperadas.length > 0;
    const session = fixture(revision,scope,'telegram',date,knowledge);
    const result = await session.run('cliente', row.pregunta);
    const item = await score(row.id,row.pregunta,result,session,row.puntos_clave ?? [],[],scope,scope ? [] : evidencePrefixes(row.fuentes),judgeEvidence);
    return scope ? {...item,score:'platform_replay_required'} : item;
  });
  const conversations=await batch(scenarios.rows,async row=>{
    const verified = row.input.identity_status === 'verified';
    const channel = row.input.channel === 'consola' ? 'web' : row.input.channel;
    const session = fixture(revision,verified,channel,row.input.business_date || date,knowledge);
    const steps=[];
    for (const [index, step] of row.input.steps.entries()) {
      const expected=row.expected.find(item=>item.after_step===index+1);
      if (step.type !== 'message') { steps.push({step:index+1,score:'platform_replay_required'}); continue; }
      const result=await session.run(step.actor,step.text);
      const observation=await score(row.id,step.text,result,session,expected?.required_facts ?? [],expected?.forbidden_facts ?? [],verified,
        evidencePrefixes(expected?.allowed_citation_sources),judgeEvidence);
      steps.push({ ...observation, step:index+1, expected_route:expected?.route, expected_writes:expected?.external_writes ?? 0,
        score:observation.score==='failed'?'failed':'review' });
    }
    return {id:row.id,critical:row.critical,steps};
  });
  const avg = values => values.length ? values.reduce((sum,value)=>sum+Number(value),0)/values.length : null;
  return { revision:revision.revision, questions, conversations, metrics:{
    accuracy:questions.filter(x=>x.score==='verified_exact').length/questions.length,
    // Unknown/ambiguous justifications remain part of the denominator.
    groundedness:judge ? avg(questions.filter(x=>x.citations.length>0).map(x=>x.grounded===true)) : null,
    recall_at_5:avg(questions.filter(x=>x.recall!==null).map(x=>x.recall)),
    remote_generation_cases:[...questions,...conversations.flatMap(x=>x.steps)].filter(x=>x.remote_generation).length,
    unresolved_critical:conversations.filter(x=>x.critical && x.steps.some(step=>step.score!=='verified_exact')).length,
    cost_usd:[...questions,...conversations.flatMap(x=>x.steps)].reduce((sum,x)=>sum+(x.cost_usd??0),0)
  } };
}

try {
  const report = await db.transaction('REPEATABLE READ', async tx => {
    const [base] = await tx.query('SELECT revision,prompts FROM prompt_revision WHERE activated');
    const [candidate] = await tx.query('SELECT revision,base_revision,prompts FROM prompt_revision WHERE revision=$1 AND NOT activated',[candidateId]);
    if (!candidate || candidate.base_revision!==base?.revision) throw new Error('Candidate must derive from the active revision');
    const documents = await tx.query('SELECT id,version,document FROM knowledge_document ORDER BY id,version');
    const judgeEvidence = new Set(documents.filter(({document}) =>
      document.scope==='public' && document.provider_approved===true).map(({id,version})=>JSON.stringify([id,version])));
    let pendingQuery = Promise.resolve();
    const knowledge = databaseKnowledge({query: (...args) => {
      const started = pendingQuery.then(() => tx.query(...args));
      pendingQuery = started.catch(() => undefined);
      return started;
    }});
    const [baseline,proposed] = await Promise.all([replay(base,knowledge,judgeEvidence),replay(candidate,knowledge,judgeEvidence)]);
    const m = proposed.metrics;
    const passed = Boolean(writer && jev) && m.accuracy>=0.8 && m.groundedness>=0.85 && m.recall_at_5>=0.9 && m.unresolved_critical===0 &&
      proposed.questions.every(x=>!x.usedPrivateRead && !x.forbiddenHit);
    const result = { gate:passed?'passed':'review_required', evidence:{
      date, golden_sha256:golden.sha256, scenarios_sha256:scenarios.sha256, corpus_sha256:sha(JSON.stringify(documents)),
      rubric:'jev-public-claims-v1', provider_mode:writer&&jev?'live':'local',
      models: live ? { decisions:jev.model, generation:['gpt-6-luna','gpt-6.1-terra','gpt-6.2-sol'] } : null,
      golden_count:30, complementary_count:19
    }, baseline, proposed };
    await tx.query(`INSERT INTO prompt_evaluation(candidate_revision,base_revision,report) VALUES ($1,$2,$3)
      ON CONFLICT(candidate_revision) DO UPDATE SET report=EXCLUDED.report,completed_at=now()`,[candidate.revision,base.revision,result]);
    return result;
  });
  await writeFile(outputPath, JSON.stringify(report,null,2)+'\n', { mode:0o600, flag:'wx' });
  console.log(JSON.stringify({ gate:report.gate, baseline:report.baseline.metrics, candidate:report.proposed.metrics }));
} finally {
  await db.destroy();
}
