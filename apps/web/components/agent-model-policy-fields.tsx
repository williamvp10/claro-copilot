import {
  assignedModelIds, ModelReasoning, ModelTone, ModelVerbosity, writesModelResponse,
  type AgentModelCatalog, type ModelAssignment, type ModelStep, type ModelTuning
} from '@claro/contracts';
import styles from './admin-agent-models.module.css';

export const toneLabels={cercano:'Cercano',formal:'Formal',directo:'Directo'};
export const verbosityLabels={low:'Breve',medium:'Equilibrada',high:'Detallada'};
export const reasoningLabels={none:'Desactivado',low:'Bajo',medium:'Medio',high:'Alto',xhigh:'Muy alto',max:'Máximo'};

function capabilities(rule:ModelAssignment,catalog:AgentModelCatalog) {
  const models=assignedModelIds(rule).map(id=>catalog.models.find(item=>item.id===id));
  const openai=models.every(model=>model?.provider==='openai');
  const noReasoning=openai && models.every(model=>model?.supports_no_reasoning);
  const temperature=noReasoning && models.every(model=>(rule.tuning?.reasoning ?? model?.reasoning)==='none');
  return {openai,noReasoning,temperature};
}

export function compatibleAssignment(rule:ModelAssignment,step:ModelStep,catalog:AgentModelCatalog):ModelAssignment {
  if (!rule.tuning) return rule;
  const {openai,noReasoning,temperature}=capabilities(rule,catalog);
  const response=writesModelResponse(step);
  const tuning:ModelTuning={
    reasoning:openai && (rule.tuning.reasoning!=='none'||noReasoning) ? rule.tuning.reasoning : undefined,
    verbosity:openai&&response ? rule.tuning.verbosity : undefined,
    temperature:temperature&&response ? rule.tuning.temperature : undefined,
    tone:response ? rule.tuning.tone : undefined,
    max_output_tokens:response ? rule.tuning.max_output_tokens : undefined
  };
  return {...rule,tuning:Object.values(tuning).some(value=>value!==undefined)?tuning:undefined};
}

export function OptionalNumber({label,value,placeholder,min,max,precision,onChange,descriptionId}:{
  label:string;value:number|undefined;placeholder?:string;min:number;max:number;precision?:string;
  onChange:(value:number|undefined)=>void;descriptionId?:string
}) {
  return <label>{label}<input type="number" min={min} max={max} step={precision} value={value ?? ''}
    placeholder={placeholder} aria-describedby={descriptionId}
    onChange={event=>onChange(event.target.value==='' ? undefined : event.target.valueAsNumber)}/></label>;
}

export function ResponseFields({rule,step,catalog,onChange}:{
  rule:ModelAssignment;step:ModelStep;catalog:AgentModelCatalog;onChange:(value:ModelAssignment)=>void
}) {
  const {openai,noReasoning,temperature}=capabilities(rule,catalog);
  const response=writesModelResponse(step);
  const tuning=rule.tuning;
  const set=(values:Partial<ModelTuning>)=>onChange({...rule,tuning:{...tuning,...values}});
  if (!openai && !response) return null;
  return <fieldset className={styles.formSection}>
    <legend>{response?'Personalización de la respuesta':'Razonamiento'}</legend>
    {response&&<p>Los ajustes de redacción se aplican a las respuestas que genera un modelo.</p>}
    <div className={styles.fields}>
      {response&&<label>Tono<select value={tuning?.tone ?? ''} onChange={event=>set({tone:ModelTone.safeParse(event.target.value).data})}>
        <option value="">Predeterminado</option>{ModelTone.options.map(tone=><option key={tone} value={tone}>{toneLabels[tone]}</option>)}
      </select></label>}
      {openai&&<label>Esfuerzo de razonamiento<select value={tuning?.reasoning ?? ''} onChange={event=>set({reasoning:ModelReasoning.safeParse(event.target.value).data})}>
        <option value="">Según el modelo</option>
        {ModelReasoning.options.filter(effort=>effort!=='none'||noReasoning).map(effort=><option key={effort} value={effort}>{reasoningLabels[effort]}</option>)}
      </select></label>}
      {response&&openai&&<label>Extensión<select value={tuning?.verbosity ?? ''} onChange={event=>set({verbosity:ModelVerbosity.safeParse(event.target.value).data})}>
        <option value="">Predeterminada</option>{ModelVerbosity.options.map(level=><option key={level} value={level}>{verbosityLabels[level]}</option>)}
      </select></label>}
      {response&&<OptionalNumber label="Límite de tokens de salida" value={tuning?.max_output_tokens} placeholder="Predeterminado"
        min={128} max={2048} onChange={max_output_tokens=>set({max_output_tokens})}/>}
      {response&&temperature&&<OptionalNumber label="Creatividad (temperatura)" value={tuning?.temperature} placeholder="Predeterminada"
        min={0} max={2} precision="any" onChange={temperature=>set({temperature})} descriptionId="model-temperature-help"/>}
    </div>
    {response&&<p id="model-temperature-help">{temperature
      ?'Una temperatura baja favorece respuestas más consistentes. Una temperatura alta aumenta la variación.'
      :'La temperatura se habilita con Luna o Terra y razonamiento desactivado en todos los modelos de esta llamada, incluido el respaldo.'}</p>}
  </fieldset>;
}
