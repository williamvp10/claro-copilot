const editions = [
  {date:'2026-11-30', version:'CAT-2026 v1.0', mobile:'Claro Max 25 GB', home:'$89.900'},
  {date:'2026-12-01', version:'CAT-2026 v2.0', mobile:'Claro Max 30 GB', home:'$84.900'}
];

function supported(result, pattern, version) {
  return result.type==='answer' && result.route==='consulta_planes' && pattern.test(result.answer) &&
    result.citations.length>0 && result.citations.every(source=>source.version===version && source.id.startsWith('catalogo')) &&
    result.answer.length<=235;
}

export async function catalogueRegressions(newSession, knowledge) {
  const cases = [];
  for (const {date, version, mobile, home} of editions) {
    for (const channel of ['web','telegram']) {
      const run = newSession(channel,date,knowledge);
      const initial = await run('cliente','¿Qué incluye Claro Max Ilimitado?');
      const offer = await run('cliente','¿Tienen planes más económicos?');
      const repeat = await run('cliente','No sé, dime tú. Yo no veo las referencias.');
      const switchService = await run('cliente','¿Y para mi casa?');
      const fresh = await newSession(channel,date,knowledge)('cliente','¿Hay algo más barato?');
      const selection = new RegExp(mobile+' cuesta \\$49\\.900 al mes, \\$50\\.000 menos que el Ilimitado');
      const switchExpected = switchService.type==='answer' && switchService.answer.includes('Hogar Fibra 300') &&
        switchService.answer.includes(home) && !switchService.answer.includes(mobile);
      const freshExpected = fresh.type==='answer' && [mobile,home,'Hogar Fibra 300','$49.900','¿Cuál te interesa?'].every(text=>fresh.answer.includes(text));
      cases.push({id:`comparacion-${channel}-${date}`,passed: supported(initial,/Claro Max Ilimitado.*\$99\.900/,version) &&
        supported(offer,selection,version) && supported(repeat,selection,version) && switchExpected &&
        supported(switchService,/Hogar Fibra/,version) && freshExpected && fresh.citations.length===2 &&
        supported(fresh,/¿Cuál te interesa\?/,version)});
    }
    const run = newSession('web',date,knowledge);
    const prepaid = await run('cliente','¿Qué paquete prepago es más barato para una semana?');
    const followup = await run('cliente','Dime tú.');
    cases.push({id:`prepago-${date}`,passed: [prepaid,followup].every(reply=>
      supported(reply,/Paquete Semanal.*\$15\.000.*7 días/,version) && !reply.answer.includes('al mes'))});
  }
  const run = newSession('web',editions[0].date,{...knowledge,catalog:async()=>{throw new Error('unavailable');}});
  const unavailable = await run('cliente','¿Tienen planes móviles más económicos?');
  const handoff = await run('cliente','Quiero hablar con un asesor.');
  cases.push({id:'catalogo-indisponible-y-derivacion-explicita',passed: unavailable.type==='answer' &&
    unavailable.citations.length===0 && /no puedo confirmar el precio.*¿Quieres hablar con uno\?/i.test(unavailable.answer) &&
    handoff.type==='handoff' && handoff.pending==='Atención humana'});
  return cases;
}
