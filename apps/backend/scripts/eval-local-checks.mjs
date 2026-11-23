/** Deterministic observations over an isolated agent run. They do not stand in for platform replay. */
const normalize = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
export const normalizeEvidence = value => normalize(value).replace(/[^a-z0-9%]+/g,' ').trim();

/** Recognize cited text reproduced alone, in paragraphs, or as one contiguous quoted procedure. */
export function isExtractiveAnswer(answer, citations) {
 const quote=value=>String(value ?? '').normalize('NFC').replace(/\s+/gu,' ').trim();
 const complete=quote(answer);
 if (!complete || !citations.length) return false;
 const excerpts=citations.map(item=>quote(item.excerpt)).filter(Boolean);
 if (excerpts.includes(complete) || excerpts.join(' ')===complete) return true;
 return answer.split(/\r?\n\s*\r?\n/).map(quote).filter(Boolean).every(paragraph=>excerpts.includes(paragraph));
}
const aliases = {
  search_public_kb:['search_public_kb'], obtenerCliente:['obtenerCliente'], obtenerSaldo:['obtenerSaldo'],
  listarFacturas:['listarFacturas'], obtenerFactura:['obtenerFactura'], listarTickets:['listarTickets'],
  refresh_signal:['refresh_signal'], aplicarAjuste:['aplicarAjuste'], crearTicket:['crearTicket'],
  registrarOfertaRetencion:['registrarOfertaRetencion']
};
const effectTools = new Set(['refresh_signal','aplicarAjuste','crearTicket','registrarOfertaRetencion']);
function observedRoute(expected,result) {
 const text=normalize(result.type==='handoff' ? `${result.reason} ${result.pending}` : result.type==='card' ? `${result.card.summary} ${result.card.next_action}` : result.answer ?? '');
 const destination=result.type==='card' ? result.card.suggested_escalation?.destination : undefined;
 switch(expected) {
  case 'conocimiento_publico': return result.type==='answer' && result.citations.length>0;
  case 'aclarar': return result.type==='answer' && result.citations.length===0 && /\?/.test(result.answer);
  case 'derivar_n2': return destination==='soporte_tecnico' || (result.type==='handoff' && /soporte (?:n2|tecnico de nivel 2)/.test(text));
  case 'derivar_supervisor': return destination==='supervision' || (result.type==='handoff' && /supervision|supervisor/.test(text));
  case 'derivar_asesor': return result.type==='handoff' && /asesor|titularidad/.test(text);
  case 'fuera_de_alcance': return result.type==='handoff' && result.route==='fuera_de_alcance';
  case 'retencion': return result.type==='card' && result.route==='cancelacion';
  case 'consulta_cuenta': case 'consulta_cuenta_degradada': return result.type==='card' && result.route==='facturacion';
  case 'esperar_aprobacion': return result.type==='card' && result.card.proposal?.status==='pending_approval';
  case 'accion_confirmada': case 'seguimiento': return null;
  default:return null;
 }
}
function check(name,status,detail,scope='agent_harness') { return {name,status,scope,...(detail ? {detail} : {})}; }
export function checkScenarioStep({expected={},result,calls=[],events=[],durationMs,verified=false,fixtureDependent=false,sourcePrefixes=[]}) {
 const checks=[]; const observed=new Set(calls);
 const route=expected.route ? observedRoute(expected.route,result) : null;
 if (expected.route) checks.push(check('route',route===null?'unverified':route?'passed':fixtureDependent?'unverified':'failed',`expected=${expected.route}; observed=${result.route}`));
 for (const tool of expected.required_tools ?? []) {
  const names=aliases[tool]; const found=names?.some(name=>observed.has(name));
  checks.push(check(`required_tool:${tool}`,found?'passed':(!names || fixtureDependent ? 'unverified':'failed'),!names?'Tool is not observable in this harness':undefined));
 }
 if (expected.required_any_tool?.length) {
  const found=expected.required_any_tool.some(tool=>aliases[tool]?.some(name=>observed.has(name)));
  const known=expected.required_any_tool.every(tool=>aliases[tool]);
  checks.push(check('required_any_tool',found?'passed':(!known || fixtureDependent ? 'unverified':'failed')));
 }
 for (const tool of expected.forbidden_tools ?? []) {
  const names=aliases[tool]; const found=names?.some(name=>observed.has(name));
  checks.push(check(`forbidden_tool:${tool}`,!names?'unverified':found?'failed':'passed'));
 }
 if (expected.required_subagents?.length) {
  const agents=new Set(events.map(event=>event.metadata?.agent_id).filter(Boolean));
  for (const agent of expected.required_subagents) {
   const actual=agent==='retencion' ? 'comercial' : agent;
   checks.push(check(`subagent:${agent}`,agents.has(actual)?'passed':fixtureDependent?'unverified':'failed'));
  }
 }
 const effects=calls.filter(name=>effectTools.has(name)).length;
 if (expected.external_writes!==undefined) checks.push(check('external_writes',expected.external_writes===0 ? (effects===0?'passed':'failed') : 'unverified',`observed_harness=${effects}; expected_platform=${expected.external_writes}`,expected.external_writes===0?'agent_harness':'platform_replay'));
 if (expected.internal_handoff_count!==undefined) checks.push(check('internal_handoff_count','unverified','A suggested handoff is not an authorized platform handoff','platform_replay'));
 for (const field of ['pending_action','required_tool_args','case_state','satisfaction','inspect_surfaces','forbidden_content_categories']) {
  if (Object.hasOwn(expected,field)) checks.push(check(field,'unverified','Requires authorized platform replay or surface inspection','platform_replay'));
 }
 if (verified || fixtureDependent) checks.push(check('account_fixture','unverified','Account values and authorization require real case and simulator state','platform_replay'));
 const citations=result.type==='answer'?result.citations:result.type==='card'?result.card.citations:[];
 if (sourcePrefixes.length) {
  const matches=sourcePrefixes.some(group=>group.some(prefix=>citations.some(c=>c.id.startsWith(prefix))));
  checks.push(check('allowed_citation_source',matches?'passed':sourcePrefixes.some(group=>group.length===0)?'unverified':citations.length?'failed':'unverified'));
 }
 if ((expected.required_facts ?? []).length) checks.push(check('required_facts','unverified','Narrative requirements require evidence-backed semantic or human review','human_review'));
 if ((expected.forbidden_facts ?? []).length) checks.push(check('forbidden_facts','unverified','Absence of a narrative phrase does not prove the prohibited meaning is absent','human_review'));
 checks.push(check('elapsed_ms',Number.isFinite(durationMs)?'observed':'unverified',Number.isFinite(durationMs)?String(durationMs):undefined));
 return checks;
}
export function classifyScenarioChecks(checks) {
 if (checks.some(item=>item.status==='failed')) return 'failed';
 if (checks.some(item=>item.status==='unverified' && item.scope==='platform_replay')) return 'platform_replay_required';
 if (checks.some(item=>item.status==='unverified')) return 'review';
 return 'verified_exact';
}
