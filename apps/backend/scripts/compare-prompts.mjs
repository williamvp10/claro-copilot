import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createAgent, createOpenAIPublicWriter, createJevDecisionAdapter, createJevSemanticEvaluator } from '@claro/agent';
import { createDatabase } from '../dist/database.js';
import { databaseKnowledge } from '../dist/knowledge.js';
import { exportAgentSpan } from '../dist/telemetry.js';
import { effectiveManifest, manifestDigest, runPromptConfig } from '../dist/prompt-catalog.js';
import { checkScenarioStep, classifyScenarioChecks, isExtractiveAnswer, normalizeEvidence } from './eval-local-checks.mjs';

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
let judge;
const decision = jev && createJevDecisionAdapter(jev);
const writer = live && createOpenAIPublicWriter({apiKey:process.env.OPENAI_API_KEY});
const normalized = normalizeEvidence;
const contents = result => result.type === 'answer' ? result.answer : result.type === 'handoff' ? result.reason :
  result.type === 'card' ? [result.card.summary, ...result.card.facts.map(x=>x.value)].join(' ') : '';
const cited = result => result.type === 'answer' ? result.citations : result.type === 'card' ? result.card.citations : [];
const fallbackPolicy = {id:'evaluation-placeholder',title:'Política',version:'0',excerpt:'Verificar los efectos con un replay de plataforma.'};
const db = await createDatabase().initialize();
const jobId = process.env.PROMPT_EVAL_JOB_ID;

function fixture(revision, verified, channel, businessDate, knowledge, advisor = false) {
  const messages = [], calls = [], events = [];
  let currentTurn;
  const read = name => async () => { calls.push(name); return []; };
  const agent = createAgent({
    readCaseForRun:async()=>({verified,messages,pending:null}),
    getAgentConfig:async()=>revision,
    getCustomerContext:read('obtenerCliente'),listServices:read('listarServicios'),getBilling:read('obtenerSaldo'),listInvoices:read('listarFacturas'),getInvoiceDetail:read('obtenerFactura'),getTickets:read('listarTickets'),
    evaluateRetention:async()=>{calls.push('evaluateRetention');return ({eligible:false,reason:'Requiere replay de plataforma',facts:[],options:[],policy:fallbackPolicy});},
    createProposal:async()=>{ calls.push('proposal'); throw new Error('Requires platform-controlled approval'); }
  }, {knowledge:{search:async (...args)=>{calls.push('search_public_kb');return knowledge.search(...args);}}, requireApprovedPrompts:live, ...(writer ? {writer} : {}), ...(decision && !verified && !advisor ? {decision} : {}), observe:(_, item)=>events.push(item)});
  const session = { calls, events, durationMs:undefined, async run(actor,text) {
    calls.length=0;
    events.length=0;
    const started = Date.now(), turn_id = randomUUID();
    messages.push({id:turn_id,turn_seq:messages.length+1,actor,text,created_at:new Date().toISOString()});
    const mode = verified || advisor || actor === 'asesor' ? 'asistido' : 'autoservicio';
    currentTurn={
      run_id:randomUUID(),case_id:'edd',conversation_id:'edd',turn_id,channel,actor,turn_seq:messages.length,
      case_revision:1,attention_mode:mode,audience:mode==='asistido'?'asesor':'cliente',scope_ref:verified?'verified':'unverified',
      config_revision:revision.revision,business_date:businessDate,text
    };
    const result=await agent.run(currentTurn);
    session.durationMs=Date.now()-started;
    if (live) await exportAgentSpan(currentTurn,started,result.route,result.type,events,revision.prompt_metadata);
    return result;
  } };
  return session;
}

async function score(id, input, result, session, required, forbidden, authorizesReads, expectedSourceIds, judgeEvidence, publicTurn, expectedAbstention = false) {
  const answer = contents(result), citations = cited(result);
  const usedPrivateRead = session.calls.some(call=>['obtenerCliente','obtenerSaldo','listarFacturas','obtenerFactura','listarServicios','listarTickets','evaluateRetention'].includes(call)) && !authorizesReads;
  const forbiddenHit = forbidden.some(value=>normalized(answer).includes(normalized(value)));
  const deterministic = !usedPrivateRead && !forbiddenHit && result.type !== 'failed';
  const expectedFacts = required.length > 0 && required.every(value=>normalized(answer).includes(normalized(value)));
  const semantic = judge && publicTurn && !authorizesReads && deterministic && citations.length > 0 && required.length > 0
    && citations.every(citation => judgeEvidence.has(JSON.stringify([citation.id,citation.version])))
    ? await judge.evaluate({question:input,answer,evidence:citations.map(x=>x.excerpt),requiredFacts:required,forbiddenFacts:forbidden,deterministicPassed:true})
    : null;
  const retrieval = session.events.find(item=>item.name==='retrieval');
  const top = String(retrieval?.metadata.top_5 ?? '').split(',').filter(Boolean);
  const recall = expectedSourceIds.length
    ? expectedSourceIds.filter(aliases=>aliases.some(prefix=>top.some(value=>value.startsWith(prefix)))).length/expectedSourceIds.length
    : null;
  const extractive = (result.type === 'answer' || result.type === 'card') && isExtractiveAnswer(answer,citations);
  const grounded = extractive ? true : semantic?.status === 'pass' && semantic.decisions.length ? semantic.decisions.every((x)=>
    x.criterion.startsWith('required') ? x.choice==='presente' : x.choice==='ausente') : null;
  const abstention = expectedAbstention && result.type==='handoff' && result.route==='fuera_de_alcance' && citations.length===0;
  const correct = deterministic && (abstention || (expectedFacts && citations.length>0 && (recall===null || recall===1) && semantic?.status!=='fail'));
  return { id, route:result.route, result:result.type, citations:citations.map(x=>x.id), usedPrivateRead, forbiddenHit,
    score:correct?'verified_exact':deterministic?'review':'failed', elapsed_ms:session.durationMs, semantic:semantic?.status ?? 'unavailable',
    recall, grounded, grounded_method:extractive?'extractive':grounded!==null?'jev':null, top_5:top,
    fact_matches:required.filter(value=>normalized(answer).includes(normalized(value))).length, required_fact_count:required.length,
    remote_generation:session.events.some(item=>item.name==='generation.openai' && item.metadata.status==='accepted'),
    generation_statuses:session.events.filter(item=>item.name==='generation.openai').map(item=>String(item.metadata.status)),
    cost_usd:session.events.reduce((sum,item)=>sum+Number(item.metadata.cost_usd ?? 0),0) };
}

const sourcesByName = {
  'Catalogo_Planes_Claro_2026.pdf':['catalogo-v1','catalogo-v2','catalogo-2026'],
  'FAQ_Atencion_Clientes.md':['faq'],
  'Manual_Decodificador_DecoBox4K.pdf':['deco'],
  'Manual_Modem_ZTX-F680.pdf':['modem'],
  'Politica_Retencion_Clientes.docx':['retencion'],
  'Politica_Escalamiento_Atencion.docx':['escalamiento'],
  'Politica_Portabilidad_Numerica.docx':['portabilidad'],
  'Politica_Facturacion_y_Pagos.docx':['facturacion'],
  'Contrato_Servicios_Hogar.docx':['contrato-hogar'],
  'Contrato_Servicios_Movil_Pospago.docx':['contrato-movil'],
  '01_recordatorio_promo_fibra500.eml':['boletin-promo'],
  '02_incidente_masivo_chapinero.eml':['boletin-incidente'],
  '03_nuevo_refresco_senal_app.eml':['boletin-refresco']
};
const advisorReference = /\.(docx|eml)$/i;
function evidencePrefixes(sources = []) {
  return sources.filter(source=>!source.endsWith('-api')).map(source=>sourcesByName[source] ?? []);
}

async function batch(rows, run) {
  const results=[];
  for (let index=0;index<rows.length;index+=4) {
    const completed = await Promise.all(rows.slice(index,index+4).map(run));
    results.push(...completed);
    if (jobId) await db.query("UPDATE prompt_eval_job SET completed_cases=completed_cases+$2 WHERE id=$1 AND status='running'",
      [jobId,completed.length]);
  }
  return results;
}

async function replay(revision, knowledge, judgeEvidence) {
  const questions=await batch(golden.rows,async row=>{
    const scope = row.herramientas_esperadas.length > 0;
    const advisor = scope || row.fuentes.some(source=>advisorReference.test(source));
    const session = fixture(revision,scope,advisor?'web':'telegram',date,knowledge,advisor);
    const result = await session.run('cliente', row.pregunta);
    const item = await score(row.id,row.pregunta,result,session,row.puntos_clave ?? [],[],scope,scope ? [] : evidencePrefixes(row.fuentes),
      judgeEvidence,!advisor,row.tipo==='fuera_de_alcance');
    return scope ? {...item,score:'platform_replay_required'} : item;
  });
  const conversations=await batch(scenarios.rows,async row=>{
    const verified = row.input.identity_status === 'verified';
    const channel = row.input.channel === 'consola' ? 'web' : row.input.channel;
    const advisor = row.input.channel === 'consola';
    const session = fixture(revision,verified,channel,row.input.business_date || date,knowledge,advisor);
    const steps=[];
    for (const [index, step] of row.input.steps.entries()) {
      const expected=row.expected.find(item=>item.after_step===index+1);
      if (step.type !== 'message') { steps.push({step:index+1,score:'platform_replay_required',checks:[{name:'control_event',status:'unverified',scope:'platform_replay',detail:'Requires the real approval, effect and receipt'}]}); continue; }
      const result=await session.run(step.actor,step.text);
      const observation=await score(row.id,step.text,result,session,expected?.required_facts ?? [],expected?.forbidden_facts ?? [],verified,
        evidencePrefixes(expected?.allowed_citation_sources),judgeEvidence,!advisor && step.actor==='cliente');
      const checks=checkScenarioStep({expected,result,calls:session.calls,events:session.events,durationMs:session.durationMs,verified,
        fixtureDependent:Boolean(verified || row.input.fixture || row.input.mock_variant || row.input.case_state || row.input.previous_handoff),
        sourcePrefixes:evidencePrefixes(expected?.allowed_citation_sources)});
      const classification=classifyScenarioChecks(checks);
      steps.push({ ...observation, step:index+1, expected_route:expected?.route, expected_writes:expected?.external_writes ?? 0,
        checks, score:observation.score==='failed'?'failed':classification });
    }
    return {id:row.id,critical:row.critical,steps};
  });
  const avg = values => values.length ? values.reduce((sum,value)=>sum+Number(value),0)/values.length : null;
  const turns=[...questions,...conversations.flatMap(x=>x.steps)];
  const generationStatuses={};
  for (const status of turns.flatMap(turn=>turn.generation_statuses ?? [])) {
    generationStatuses[status]=(generationStatuses[status] ?? 0)+1;
  }
  return { revision:revision.revision, questions, conversations, metrics:{
    accuracy:questions.filter(x=>x.score==='verified_exact').length/questions.length,
    // Unknown/ambiguous justifications remain part of the denominator.
    groundedness:judge ? avg(questions.filter(x=>x.citations.length>0 && x.score!=='platform_replay_required').map(x=>x.grounded===true)) : null,
    grounded_evidence_count:questions.filter(x=>x.grounded!==null).length,
    routed_to_retrieval:questions.filter(x=>x.top_5.length>0).length,
    recall_at_5:avg(questions.filter(x=>x.recall!==null).map(x=>x.recall)),
    remote_generation_cases:turns.filter(x=>x.remote_generation).length,
    generation_statuses:generationStatuses,
    unresolved_critical:conversations.filter(x=>x.critical && x.steps.some(step=>step.score!=='verified_exact')).length,
    local_elapsed_ms:turns.filter(x=>Number.isFinite(x.elapsed_ms)).map(x=>x.elapsed_ms),
    latency_scope:'isolated agent turn; not end-to-end, p95 or release evidence',
    cost_usd:[...questions,...conversations.flatMap(x=>x.steps)].reduce((sum,x)=>sum+(x.cost_usd??0),0)
  } };
}

try {
  const report = await db.transaction('REPEATABLE READ', async tx => {
    const [base] = await tx.query('SELECT * FROM prompt_revision WHERE activated');
    const [candidate] = await tx.query('SELECT * FROM prompt_revision WHERE revision=$1 AND NOT activated',[candidateId]);
    if (!candidate || candidate.base_revision!==base?.revision) throw new Error('Candidate must derive from the active revision');
    const baseConfig = runPromptConfig(base);
    const candidateConfig = runPromptConfig(candidate);
    const referenceRubric = baseConfig.prompts.check_semantic_criterion;
    judge = jev && referenceRubric ? createJevSemanticEvaluator({ ...jev, semanticTemplate: referenceRubric }) : null;
    const documents = await tx.query('SELECT id,version,document FROM knowledge_document ORDER BY id,version');
    const judgeEvidence = new Set(documents.filter(({document}) =>
      document.scope==='public' && document.provider_approved===true).map(({id,version})=>JSON.stringify([id,version])));
    let pendingQuery = Promise.resolve();
    const knowledge = databaseKnowledge({query: (...args) => {
      const started = pendingQuery.then(() => tx.query(...args));
      pendingQuery = started.catch(() => undefined);
      return started;
    }});
    const [baseline,proposed] = await Promise.all([replay(baseConfig,knowledge,judgeEvidence),replay(candidateConfig,knowledge,judgeEvidence)]);
    const m = proposed.metrics;
    const passed = Boolean(writer && judge) && m.remote_generation_cases>0 && m.accuracy>=0.8 && m.groundedness>=0.85 && m.recall_at_5>=0.9 && m.unresolved_critical===0 &&
      proposed.questions.every(x=>!x.usedPrivateRead && !x.forbiddenHit) &&
      proposed.conversations.every(x=>x.steps.every(step=>!step.usedPrivateRead && !step.forbiddenHit && step.score!=='failed'));
    const result = { gate:passed?'passed':'review_required', evidence:{
      date, golden_sha256:golden.sha256, scenarios_sha256:scenarios.sha256, corpus_sha256:sha(JSON.stringify(documents)),
      rubric:baseConfig.prompt_metadata.check_semantic_criterion?.sha256 ?? 'unavailable',
      baseline_manifest_sha256:manifestDigest(effectiveManifest(base)),
      candidate_manifest_sha256:manifestDigest(effectiveManifest(candidate)),
      provider_mode:writer&&judge?'live':'local',
      models: live ? { decisions:jev.model, generation:['gpt-6-luna','gpt-6.1-terra','gpt-6.2-sol'] } : null,
      golden_count:30, complementary_count:19, provider_approved_passages:judgeEvidence.size
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
