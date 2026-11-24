import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

const manifestUrl = new URL('../docs/agente/jev-langfuse.v1.json', import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
const { dataset, connection, evaluator } = manifest;
const { LANGFUSE_UI_URL, LANGFUSE_PROJECT_ID: projectId, LANGFUSE_PUBLIC_KEY: publicKey,
  LANGFUSE_SECRET_KEY: secretKey, LANGFUSE_ADMIN_EMAIL: email, LANGFUSE_ADMIN_PASSWORD: password,
  OPENROUTER_API_KEY: openRouterKey } = process.env;
const args = process.argv.slice(2);
const datasetOnly = args[0] === '--dataset-only';
if (args.length > Number(datasetOnly)) throw new Error('Uso: bootstrap-langfuse-calls.mjs [--dataset-only]');
if (manifest.schema_version !== 1) throw new Error('Versión de manifiesto incompatible.');
if (!LANGFUSE_UI_URL || !projectId || !publicKey || !secretKey) {
  throw new Error('Configura LANGFUSE_UI_URL, LANGFUSE_PROJECT_ID y las dos API keys del proyecto.');
}
const base = new URL(LANGFUSE_UI_URL);
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) ||
    base.username || base.password || base.search || base.hash || base.pathname !== '/') {
  throw new Error('Usa el origen HTTPS de Langfuse o su origen HTTP en loopback.');
}

const suite = await readFile(new URL(dataset.source, manifestUrl));
const sha256 = createHash('sha256').update(suite).digest('hex');
const items = suite.toString('utf8').trim().split(/\r?\n/).map(line => {
  const { id, turns, intent, required, forbidden, sources } = JSON.parse(line);
  const nonEmptyStrings = values => Array.isArray(values) && values.length > 0 &&
    values.every(value => typeof value === 'string' && value.trim());
  if (!/^TRX-\d{4}$/.test(id) || typeof intent !== 'string' || !intent.trim() ||
      ![turns, required, forbidden, sources].every(nonEmptyStrings)) {
    throw new Error('La suite contiene un caso inválido.');
  }
  return {
    id: `${dataset.name}-${id}`, datasetName: dataset.name, input: { turns },
    expectedOutput: { intent, required, forbidden }, metadata: { sources, suite_sha256: sha256 }
  };
});
if (items.length !== dataset.items || new Set(items.map(({ id }) => id)).size !== items.length) {
  throw new Error('El número de casos o los identificadores del dataset son incompatibles con el manifiesto.');
}

const authorization = 'Basic ' + Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
const evaluatorId = createHash('sha1').update(Buffer.from('be660d0931bd48fda710d1b084688d1d', 'hex'))
  .update(JSON.stringify([projectId, evaluator.name])).digest().subarray(0, 16);
evaluatorId[6] = (evaluatorId[6] & 0x0f) | 0x50;
evaluatorId[8] = (evaluatorId[8] & 0x3f) | 0x80;
const destinationEvaluatorId = evaluatorId.toString('hex').replace(/^(........)(....)(....)(....)/, '$1-$2-$3-$4-');

function http(path, options = {}) {
  return fetch(new URL(path, base), { ...options, redirect: 'manual', signal: AbortSignal.timeout(25000) });
}
async function publicRequest(path, body, missing = false) {
  const write = body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) };
  const response = await http('/api/public/' + path, {
    ...write, headers: { Authorization: authorization, 'Content-Type': 'application/json' }
  });
  if (missing && response.status === 404) return null;
  if (!response.ok) throw new Error(`API pública de Langfuse, ${path}, HTTP ${response.status}.`);
  return response.json();
}

async function importDataset() {
  const desired = { name: dataset.name, description: dataset.description, metadata: { sha256 } };
  const current = await publicRequest('v2/datasets/' + encodeURIComponent(dataset.name), undefined, true);
  if (current && current.metadata?.sha256 !== desired.metadata.sha256) {
    throw new Error(`El dataset ${dataset.name} tiene otra huella. Revisa los cambios antes de importarlo.`);
  }
  const missing = [];
  for (const item of items) {
    const found = await publicRequest('dataset-items/' + encodeURIComponent(item.id), undefined, true);
    if (!found) missing.push(item);
    else if (found.datasetId !== current?.id || found.status !== 'ACTIVE' || !['input', 'expectedOutput', 'metadata']
      .every(field => isDeepStrictEqual(found[field], item[field]))) {
      throw new Error(`El ítem ${item.id} difiere del manifiesto o pertenece a otro dataset.`);
    }
  }
  const target = current ?? await publicRequest('v2/datasets', desired);
  if (!target.id || target.name !== dataset.name) throw new Error('Langfuse devolvió un dataset inesperado.');
  for (const item of missing) {
    const created = await publicRequest('dataset-items', item);
    if (created.id !== item.id || created.datasetId !== target.id) throw new Error('Langfuse devolvió un ítem inesperado.');
  }
  console.log(`Dataset ${dataset.name} (${target.id}). ${items.length} casos, ${missing.length} creados.`);
}

async function evaluatorSession() {
  if (!email || !password) throw new Error('Configura LANGFUSE_ADMIN_EMAIL y LANGFUSE_ADMIN_PASSWORD.');
  const cookies = new Map();
  async function sessionRequest(path, init = {}) {
    const response = await http(path, {
      ...init, headers: { ...init.headers, cookie: [...cookies.values()].join('; ') }
    });
    for (const header of response.headers.getSetCookie()) {
      const cookie = header.split(';', 1)[0];
      cookies.set(cookie.slice(0, cookie.indexOf('=')), cookie);
    }
    return response;
  }
  const csrf = await sessionRequest('/api/auth/csrf');
  if (!csrf.ok) throw new Error(`No se pudo iniciar sesión en Langfuse, HTTP ${csrf.status}.`);
  const { csrfToken } = await csrf.json();
  await sessionRequest('/api/auth/callback/credentials', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrfToken, email, password, callbackUrl: base.href, json: 'true' })
  });
  const auth = await sessionRequest('/api/auth/session');
  if (!auth.ok || !(await auth.json())?.user) throw new Error('Langfuse rechazó el inicio de sesión de Administración.');

  // The stable public API in 4.83.0 does not expose Decision model evaluators.
  return async (method, input, write = false) => {
    const payload = JSON.stringify({ json: { projectId, ...input } });
    const path = '/api/trpc/' + method;
    const response = await sessionRequest(write ? path : path + '?input=' + encodeURIComponent(payload), write ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload
    } : {});
    if (!response.ok) throw new Error(`Interfaz de Langfuse ${manifest.langfuse_version}, ${method}, HTTP ${response.status}.`);
    const result = (await response.json()).result?.data?.json;
    if (!result) throw new Error(`Respuesta incompatible de Langfuse en ${method}.`);
    return result;
  };
}

async function importEvaluator(rpc) {
  const links = await rpc('llmApiKey.all', { includeDecisionModels: true });
  const installed = links.data.find(row => row.provider === connection.provider);
  if (installed && !Object.keys(connection).every(field => isDeepStrictEqual(installed[field], connection[field]))) {
    throw new Error(`La conexión ${connection.provider} difiere del manifiesto.`);
  }
  if (!installed && !openRouterKey) throw new Error('Configura OPENROUTER_API_KEY para crear la conexión Jev.');

  const list = await rpc('evalsV2.list', { search: evaluator.name });
  if (list.totalItems > list.evaluators.length) throw new Error('La búsqueda devolvió más evaluadores de los que se pueden verificar.');
  const matches = list.evaluators.filter(row => row.name === evaluator.name);
  if (matches.length > 1) throw new Error(`Hay varios evaluadores llamados ${evaluator.name}.`);
  const current = matches[0] && await rpc('evalsV2.get', { evaluatorId: matches[0].id });
  if (current) {
    const version = current.versions.reduce((latest, row) => row.version > (latest?.version ?? 0) ? row : latest, null);
    const definition = version && {
      type: current.type, modelConfig: { provider: version.provider, model: version.model },
      variableMapping: version.variableMapping, questions: version.questions
    };
    if (current.description !== evaluator.description || !isDeepStrictEqual(definition, evaluator.definition)) {
      throw new Error(`El evaluador ${evaluator.name} difiere del manifiesto.`);
    }
    if (current.blockedAt) throw new Error(`El evaluador ${evaluator.name} está bloqueado en Langfuse.`);
  }
  if (!installed) await rpc('llmApiKey.create', { ...connection, secretKey: openRouterKey }, true);
  const target = current ?? await rpc('evalsV2.create', { ...evaluator, evaluatorId: destinationEvaluatorId }, true);
  if (target.type !== evaluator.definition.type || !target.id || target.blockedAt) {
    throw new Error('Langfuse no devolvió un evaluador de decisión activo.');
  }
  console.log(`Evaluador ${evaluator.name} (${target.id}). ${current ? 'Ya configurado' : 'Creado'}.`);
}

try {
  const accessible = await publicRequest('projects');
  if (!accessible.data.some(row => row.id === projectId)) {
    throw new Error('Las API keys de Langfuse no corresponden a LANGFUSE_PROJECT_ID.');
  }
  const rpc = datasetOnly ? null : await evaluatorSession();
  await importDataset();
  if (rpc) await importEvaluator(rpc);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
