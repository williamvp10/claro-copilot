import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createAgent, createJevSemanticEvaluator, evolveContext, recordQuestion } from '@claro/agent';
import { createDatabase } from '../dist/database.js';
import { activeKnowledgeRevision, databaseKnowledge, knowledgeCorpus } from '../dist/knowledge.js';
import { readRunPromptConfig } from '../dist/prompt-catalog.js';

const env = process.env;
const enabled = process.argv.includes('--jev');
const native = process.argv.includes('--native-jev');
if (enabled && native) throw new Error('Choose --jev or --native-jev.');
const model = env.JEV_MODEL || 'typesafe/jev-1.14';
const base = new URL(env.LANGFUSE_BASE_URL ?? 'http://langfuse-web:3000');
const local = ['127.0.0.1', 'localhost'].includes(base.hostname) || base.host === 'langfuse-web:3000';
if (env.DEMO_MODE !== 'true' || !local || base.protocol !== 'http:' || base.username || base.password ||
    !env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY || (enabled && !env.OPENROUTER_API_KEY)) {
  throw new Error('Use the local demo and its Langfuse keys. --jev also requires OPENROUTER_API_KEY.');
}
const judge = enabled ? createJevSemanticEvaluator({ apiKey: env.OPENROUTER_API_KEY, model, timeoutMs: 10000 }) : null;
const raw = await readFile(new URL('../../../docs/agente/llamadas-evals.v1.jsonl', import.meta.url), 'utf8');
const suite = raw.trim().split(/\r?\n/).map(line => JSON.parse(line));
const sha = createHash('sha256').update(raw).digest('hex');
const businessDate = env.DEMO_BUSINESS_DATE || '2026-11-18';
const environment = native ? 'demo-jev-native' : 'demo-evals';
const indexRevision = activeKnowledgeRevision();
const experimentId = randomUUID();
const experimentName = `llamadas-v1-${native ? 'jev-native' : enabled ? 'jev' : 'local'}-${experimentId.slice(0, 8)}`;
const authorization = 'Basic ' + Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString('base64');

async function post(path, data) {
  const res = await fetch(new URL(path, base), {
    method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json',
      'X-Langfuse-Ingestion-Version': '4' }, body: JSON.stringify(data), redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok || res.status === 207) throw new Error(`Langfuse ${path}: HTTP ${res.status}`);
  const body = await res.text();
  const ack = body ? JSON.parse(body) : {};
  if (Number(ack.partialSuccess?.rejectedSpans || ack.partial_success?.rejected_spans || 0)) {
    throw new Error('Langfuse rejected experiment spans');
  }
  return ack;
}

const hex = bytes => randomBytes(bytes).toString('hex');
const nano = millis => String(BigInt(millis) * 1_000_000n);
const attr = values => Object.entries(values).map(([key, stringValue]) => ({ key, value: { stringValue } }));
const expected = item => ({ intent: item.intent, required: item.required, forbidden: item.forbidden });
const citationKey = ({ id, version }) => JSON.stringify([id, version]);

async function replay(item, knowledge, config, approvedEvidence) {
  const messages = [], observations = [], outputs = [], evidence = [], calls = [];
  let intake, conversation_memory, turnIndex = 0;
  const privateRead = name => async () => { calls.push(name); return []; };
  const agent = createAgent({
    readCaseForRun: async () => ({ verified: false, messages, pending: null, intake, conversation_memory }),
    getAgentConfig: async () => config,
    getCustomerContext: privateRead('crm'), listServices: privateRead('services'),
    getBilling: privateRead('billing'), listInvoices: privateRead('invoices'),
    getInvoiceDetail: privateRead('invoice'), getTickets: privateRead('tickets'),
    evaluateRetention: privateRead('retention'),
    createProposal: async () => { calls.push('proposal'); throw new Error('Evaluation cannot write'); },
  }, { knowledge, observe: (_, event) => observations.push({ ...event, turnIndex }) });
  const conversationId = randomUUID();
  for (const question of item.turns) {
    turnIndex++;
    const id = randomUUID(), at = new Date().toISOString(), turnSeq = messages.length + 1;
    messages.push({ id, turn_seq: turnSeq, actor: 'cliente', text: question, created_at: at });
    intake = evolveContext(question, intake);
    const result = await agent.run({
      run_id: randomUUID(), case_id: conversationId, conversation_id: conversationId, turn_id: id,
      channel: 'web', actor: 'cliente', turn_seq: turnSeq, case_revision: turnSeq,
      attention_mode: 'autoservicio', audience: 'cliente', scope_ref: 'unverified',
      config_revision: config.revision, business_date: businessDate, text: question,
    });
    const answer = result.type === 'answer' ? result.answer : result.type === 'handoff' ? result.reason : '';
    const citations = result.type === 'answer' ? result.citations : [];
    outputs.push({ route: result.route, type: result.type, answer, citations: citations.map(c => c.id) });
    evidence.push(...citations.filter(c => approvedEvidence.has(citationKey(c))).map(c => c.excerpt));
    if (result.type === 'answer') {
      conversation_memory = result.route === 'consulta_planes' ? result.conversation_memory ?? conversation_memory : undefined;
      if (intake && result.context_question) recordQuestion(intake, result.context_question);
      messages.push({ id: randomUUID(), turn_seq: messages.length + 1, actor: 'agente', text: answer, citations, created_at: at });
    }
  }
  return { outputs, observations, evidence: [...new Set(evidence)], calls };
}

const db = await createDatabase().initialize();
const summary = [];
try {
  const [{ revision } = { revision: 'bootstrap' }] = await db.query('SELECT revision FROM prompt_revision WHERE activated ORDER BY created_at DESC LIMIT 1');
  const config = await readRunPromptConfig(db, revision);
  const knowledge = databaseKnowledge(db, indexRevision);
  const approvedEvidence = new Set((await knowledgeCorpus(db, indexRevision))
    .filter(({ document }) => document.scope === 'public' && document.provider_approved === true).map(citationKey));
  const datasetName = 'claro-llamadas-v1';
  const dataset = await post('/api/public/v2/datasets', {
    name: datasetName, description: 'Casos reformulados de las 50 llamadas del reto', metadata: { sha256: sha },
  });
  if (!dataset.id) throw new Error('Langfuse did not return a dataset ID');

  for (const item of suite) {
    const input = { turns: item.turns };
    const expectedOutput = expected(item);
    const data = await post('/api/public/dataset-items', {
      id: `${datasetName}-${item.id}`, datasetName, input, expectedOutput,
      metadata: { sources: item.sources, suite_sha256: sha },
    });
    if (!data.id) throw new Error(`Langfuse did not return item ID for ${item.id}`);
    const started = Date.now();
    const { outputs, observations, calls, evidence } = await replay(item, knowledge, config, approvedEvidence);
    const safe = !calls.length && outputs.every(out => ['answer', 'handoff'].includes(out.type));
    if (native && !safe) throw new Error(`Evaluation crossed the public boundary for ${item.id}`);
    const routeMatch = outputs[0].route === (item.id === 'TRX-0007' ? 'handoff' : item.intent);
    const judgeStarted = Date.now();
    const semantic = !judge ? { status: native ? 'pending_langfuse' : 'disabled', decisions: [] } : await judge.evaluate({
      question: item.turns.join(' '), answer: outputs.map(out => out.answer).join(' '), evidence,
      requiredFacts: item.required, forbiddenFacts: item.forbidden, deterministicPassed: safe,
    });
    const finished = Date.now();
    const traceId = hex(16), rootId = hex(8), judgeId = hex(8);
    const context = {
      'langfuse.environment': environment,
      'langfuse.experiment.id': experimentId, 'langfuse.experiment.name': experimentName,
      'langfuse.experiment.dataset.id': dataset.id, 'langfuse.experiment.item.id': data.id,
      'langfuse.experiment.item.root_observation_id': rootId,
      'langfuse.experiment.metadata.prompt_revision': revision,
      'langfuse.experiment.metadata.index_revision': indexRevision,
      'langfuse.experiment.metadata.suite_sha256': sha,
      'langfuse.experiment.metadata.rubric': 'llamadas-v1',
    };
    const span = (spanId, name, start, end, values, parentSpanId) => ({
      traceId, spanId, name, kind: 1, startTimeUnixNano: nano(start), endTimeUnixNano: nano(Math.max(start + 1, end)),
      ...(parentSpanId ? { parentSpanId } : {}), attributes: attr({ ...context, ...values }),
    });
    const spans = [span(rootId, `llamadas.${item.id}`, started, finished, {
      'langfuse.observation.type': 'agent', 'langfuse.observation.input': JSON.stringify(input),
      'langfuse.observation.output': JSON.stringify(outputs),
      'langfuse.experiment.item.expected_output': JSON.stringify(expectedOutput),
      'langfuse.experiment.item.metadata.sources': item.sources.join(','),
      ...(native ? {
        'langfuse.observation.metadata.jev_rubric': JSON.stringify(expectedOutput),
      } : {}),
    }), ...observations.map(event => span(hex(8), event.name, event.started, event.ended, {
      'langfuse.observation.metadata.turn': String(event.turnIndex),
    }, rootId))];
    if (enabled) spans.push(span(judgeId, 'judge.jev', judgeStarted, finished, {
      'langfuse.observation.type': 'evaluator', 'langfuse.observation.model.name': semantic.model ?? model,
      'langfuse.observation.output': JSON.stringify(semantic),
    }, rootId));

    await post('/api/public/otel/v1/traces', { resourceSpans: [{
      resource: { attributes: attr({ 'service.name': 'claro-call-evals' }) },
      scopeSpans: [{ scope: { name: 'claro-call-evals' }, spans }],
    }] });
    const score = (name, value, dataType, metadata) => ({
      traceId, observationId: rootId, name, value, dataType, environment, metadata,
    });
    const scores = [score('call_route_match', Number(routeMatch), 'BOOLEAN'), score('call_public_boundary', Number(safe), 'BOOLEAN')];
    if (enabled) scores.push(score('jev_semantic', semantic.status, 'CATEGORICAL', { model: semantic.model ?? model }),
      ...semantic.decisions.map(({ criterion, choice }) => score(`jev_${criterion.replace(':', '_')}`, choice, 'CATEGORICAL')));
    await post('/api/public/scores', scores);
    const entry = { id: item.id, trace_id: traceId, route_match: routeMatch, safe, semantic: semantic.status,
      decisions: semantic.decisions.length, routes: outputs.map(x => x.route) };
    summary.push(entry);
    console.log(JSON.stringify(entry));
  }
  console.log(JSON.stringify({ experiment_id: experimentId, experiment_name: experimentName, dataset_id: dataset.id,
    prompt_revision: revision, index_revision: indexRevision, suite_sha256: sha,
    cases: summary.length, routing_matches: summary.filter(row => row.route_match).length,
    public_boundary_ok: summary.filter(row => row.safe).length,
    cases_with_jev_decisions: summary.filter(row => row.decisions > 0).length,
    semantic: Object.fromEntries([...new Set(summary.map(row => row.semantic))]
      .map(status => [status, summary.filter(row => row.semantic === status).length])),
  }));
  if (enabled && summary.every(row => row.decisions === 0)) process.exitCode = 1;
} finally {
  await db.destroy();
}
