import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ModelCredentials } from '@claro/agent';
import { AgentModelPolicy, ModelProvider as ProviderSchema, ModelStep, agentModelCatalog, assignedModelIds, modelComponentByStep, modelProfileRank, modelTuningIssue,
  type AgentModelCatalog, type AgentModelExecutions, type AgentModelRevision, type ModelOption, type ModelProvider, type ModelTuning, type ModelValidation } from '@claro/contracts';
import type { Request } from 'express';
import type { DataSource } from 'typeorm';
import { z } from 'zod';
import { modelCredentials, probeModel } from './agent-providers.js';
import { agentModelDigest, modelRevision, usesRetiredModel } from './agent-model-storage.js';
import { AUTH, canManageAdministration, getViewer, type createAuth } from './auth.js';
import { DATABASE } from './database.js';
import { browserEndpoint } from './dashboard.js';
import { traceIdentifier } from './telemetry.js';

const ExecutionProvider=ProviderSchema.or(z.literal('lmstudio'));
const Revision=z.string().min(1).max(128);
const Reason=z.string().trim().min(5).max(300);
const Draft=z.object({base_revision:Revision,reason:Reason,policy:AgentModelPolicy}).strict();
const Change=z.object({expected_revision:Revision,reason:Reason,evidence:z.string().trim().min(3).max(240)}).strict();
const SELECT_REVISIONS=`SELECT r.*,v.report AS validation,
  (EXISTS (SELECT 1 FROM agent_model_config_active a WHERE a.revision=r.revision) OR
   EXISTS (SELECT 1 FROM agent_model_config_event e WHERE e.revision=r.revision OR e.previous_revision=r.revision)) AS was_active
  FROM agent_model_config_revision r
  LEFT JOIN agent_model_config_validation v USING(revision)`;

function parse<T>(schema:z.ZodType<T>, value:unknown):T {
  const parsed=schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException('Configuración de modelos inválida');
  return parsed.data;
}

type Inventory=Map<string,boolean|null>;

async function inventory(provider:ModelProvider,key:string|undefined):Promise<Inventory> {
  if (!key) return new Map();
  try {
    const endpoints={openai:'https://api.openai.com/v1/models',openrouter:'https://openrouter.ai/api/v1/models/user'};
    const response=await fetch(endpoints[provider],{redirect:'error',headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(4000)});
    if (!response.ok) return new Map();
    const {data}=await response.json() as {data:{id:string;supported_parameters?:string[]}[]};
    return new Map(data.map((item:{id:string;supported_parameters?:string[]})=>[
      item.id,provider==='openrouter'?item.supported_parameters?.includes('structured_outputs')===true:null
    ]));
  } catch { return new Map(); }
}

async function capabilities(keys:ModelCredentials) {
  const [openai,openrouter]=await Promise.all([
    inventory('openai',keys.openai),inventory('openrouter',keys.openrouter)
  ]);
  return {openai,openrouter};
}

@Controller('api/v1/admin/agent-models')
export class AgentModelAdminController {
  constructor(@Inject(DATABASE) private readonly db:DataSource,
    @Inject(AUTH) private readonly auth:ReturnType<typeof createAuth>['auth']) {}

  private async viewer(req:Request) {
    const viewer=await getViewer(req,this.auth,this.db);
    if (!canManageAdministration(viewer)) throw new ForbiddenException();
    if (req.method==='POST' && req.get('Origin')!==new URL(process.env.BETTER_AUTH_URL ?? 'http://127.0.0.1:0').origin) {
      throw new ForbiddenException('Origen inválido');
    }
    return viewer;
  }

  private async revision(id:string):Promise<AgentModelRevision> {
    const [row]=await this.db.query(`${SELECT_REVISIONS} WHERE r.revision=$1`,[id]);
    if (!row) throw new NotFoundException('Revisión de modelos desconocida');
    return modelRevision(row);
  }

  @Get('catalog')
  async catalog(@Req() req:Request):Promise<AgentModelCatalog> {
    await this.viewer(req);
    const keys=modelCredentials(), listed=await capabilities(keys);
    return {
      providers:{openai:!!keys.openai,openrouter:!!keys.openrouter},
      models:agentModelCatalog.map(model=>({...model,available:listed[model.provider].has(model.id),
        structured_outputs:listed[model.provider].get(model.id) ?? null}))
    };
  }

  @Get('revisions')
  async revisions(@Req() req:Request) {
    await this.viewer(req);
    const [{active,revisions}]=await this.db.query(`SELECT a.revision AS active,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC) FROM (
        ${SELECT_REVISIONS} ORDER BY created_at DESC LIMIT 100
      ) r) AS revisions FROM agent_model_config_active a WHERE singleton`);
    const history:Parameters<typeof modelRevision>[0][] = revisions.map((row:Parameters<typeof modelRevision>[0])=>({...row,created_at:new Date(row.created_at)}));
    const result=history.map(modelRevision);
    if (!result.some(item=>item.revision===active)) result.unshift(await this.revision(active));
    return {active,revisions:result};
  }

  @Get('executions')
  async executions(@Req() req:Request):Promise<AgentModelExecutions> {
    await this.viewer(req);
    const endpoint=browserEndpoint(process.env.LANGFUSE_UI_URL);
    const project=encodeURIComponent(process.env.LANGFUSE_PROJECT_ID || 'claro-copiloto');
    const projectUrl=endpoint ? `${endpoint}/project/${project}` : null;
    const recent:{id:string;created_at:Date;metadata:Record<string,unknown>;exported:boolean}[]=await this.db.query(`
      WITH recent AS (
        SELECT id,case_id,created_at,metadata FROM attention_event
        WHERE kind='model.call' AND created_at>=now()-interval '7 days'
        ORDER BY created_at DESC,id DESC LIMIT 40
      )
      SELECT r.id,r.created_at,r.metadata,EXISTS(
        SELECT 1 FROM attention_event e WHERE e.case_id=r.case_id AND e.kind='langfuse_exported'
          AND e.metadata->>'run_id'=r.metadata->>'run_id'
      ) AS exported FROM recent r ORDER BY r.created_at DESC,r.id DESC`);
    return {
      langfuse_url:projectUrl ? `${projectUrl}/traces` : null,
      items:recent.flatMap(({id,created_at,metadata,exported})=>{
        const {step_id,provider,model_config_revision,requested_model,effective_model,status,attempt,ms,cost_usd,cost_basis,run_id}=metadata;
        const step=ModelStep.safeParse(step_id), route=ExecutionProvider.safeParse(provider);
        if (!step.success || !route.success || typeof model_config_revision!=='string' ||
            typeof requested_model!=='string' || typeof status!=='string' || typeof attempt!=='number') return [];
        return [{
          id:String(id),at:created_at.toISOString(),step:step.data,provider:route.data,revision:model_config_revision,
          requested_model,effective_model:typeof effective_model==='string' && effective_model ? effective_model : null,
          status,attempt,latency_ms:typeof ms==='number' ? ms : null,cost_usd:typeof cost_usd==='number' ? cost_usd : null,
          cost_basis:typeof cost_basis==='string' ? cost_basis : null,
          trace_url:projectUrl && exported && typeof run_id==='string' ? `${projectUrl}/traces/${traceIdentifier(run_id)}` : null
        }];
      })
    };
  }

  @Post('revisions')
  async save(@Req() req:Request,@Body() input:unknown) {
    const viewer=await this.viewer(req);
    const {base_revision,reason,policy}=parse(Draft,input);
    const revision=randomUUID();
    await this.db.transaction(async tx=>{
      const [active]=await tx.query('SELECT revision FROM agent_model_config_active WHERE singleton FOR SHARE');
      if (active.revision!==base_revision) throw new ConflictException('La revisión activa cambió');
      await tx.query(`INSERT INTO agent_model_config_revision(revision,base_revision,digest,policy,created_by,reason)
        VALUES($1,$2,$3,$4,$5,$6)`,[revision,base_revision,agentModelDigest(policy),policy,viewer.id,reason]);
    });
    return this.revision(revision);
  }

  @Post('revisions/:id/validate')
  async validate(@Req() req:Request,@Param('id') id:string):Promise<ModelValidation> {
    await this.viewer(req);
    const {policy,digest}=await this.revision(id);
    const keys=modelCredentials(), listed=await capabilities(keys);
    const options=new Map(agentModelCatalog.map(model=>[model.id,model]));
    const assignments=ModelStep.options.flatMap(step=>{
      const rule=policy.steps[step];
      const tuning=rule.tuning;
      const componentLimit=policy.component_limits?.[modelComponentByStep[step]]?.max_cost_usd;
      return assignedModelIds(rule).map(model=>{
        const option=options.get(model);
        const probeKey=JSON.stringify([model,tuning?.reasoning,tuning?.verbosity,tuning?.temperature,tuning?.max_output_tokens]);
        if (!option) return {step,model,probeKey,tuning,reason:'modelo_no_aprobado'};
        const tooLow=rule.mode==='auto' && Object.entries(rule.profiles).some(([profile,id])=>
          id===model && modelProfileRank[option.profile]<modelProfileRank[profile as keyof typeof modelProfileRank]);
        const baseCost=(256*option.input_usd_per_million+(tuning?.max_output_tokens ?? 480)*option.output_usd_per_million)/1e6;
        const reason=modelTuningIssue(step,tuning,option) ||
          (tooLow?'perfil_incompatible':baseCost>Math.min(policy.max_cost_usd,componentLimit ?? Infinity)?'presupuesto_insuficiente':'');
        return {step,model,probeKey,tuning,reason};
      });
    });
    const checks=new Map<string,string>();
    const pending=[...new Map(assignments.filter(item=>!item.reason).map(item=>[item.probeKey,item])).values()];
    const check=async ({model,tuning}:typeof pending[number]) => {
      const option=options.get(model)!;
      const key=keys[option.provider];
      if (!key) return 'credencial_ausente';
      if (!listed[option.provider].has(model)) return 'modelo_no_disponible';
      if (listed[option.provider].get(model)===false) return 'salida_estructurada_incompatible';
      return probeModel(option,key,tuning);
    };
    for(let index=0;index<pending.length;index+=2) {
      await Promise.all(pending.slice(index,index+2).map(async item=>checks.set(item.probeKey,await check(item))));
    }
    const issues=assignments.flatMap(({step,model,reason,probeKey})=>{
      const failure=reason || checks.get(probeKey);
      return failure ? [{step,model,reason:failure}] : [];
    });
    const validation={digest,checked_at:new Date().toISOString(),issues};
    await this.db.query(`INSERT INTO agent_model_config_validation(revision,report) VALUES($1,$2)
      ON CONFLICT(revision) DO UPDATE SET report=excluded.report`,[id,validation]);
    return validation;
  }

  private async change(req:Request,id:string,input:unknown,kind:'activate'|'restore') {
    const viewer=await this.viewer(req);
    const {expected_revision,reason,evidence}=parse(Change,input);
    const selected=await this.db.transaction(async tx=>{
      const [active]=await tx.query('SELECT revision FROM agent_model_config_active WHERE singleton FOR UPDATE');
      if (active.revision!==expected_revision) throw new ConflictException('La revisión activa cambió');
      const [row]=await tx.query(`${SELECT_REVISIONS} WHERE r.revision=$1`,[id]);
      if (!row) throw new NotFoundException('Revisión de modelos desconocida');
      const revision=modelRevision(row);
      if (id===active.revision) throw new ConflictException('La revisión ya está activa');
      if (usesRetiredModel(revision.policy)) throw new ConflictException('La revisión incluye un modelo retirado');
      if (revision.validation?.digest!==revision.digest || revision.validation.issues.length) {
        throw new ConflictException('Valida la revisión con los proveedores antes de aplicarla');
      }
      if (kind==='activate' && revision.base_revision!==active.revision) throw new ConflictException('El borrador tiene otra revisión base');
      if (kind==='restore') {
        const [prior]=await tx.query('SELECT 1 FROM agent_model_config_event WHERE revision=$1 OR previous_revision=$1 LIMIT 1',[id]);
        if (!prior) throw new ConflictException('La revisión aún no se ha activado');
      }
      await tx.query('UPDATE agent_model_config_active SET revision=$1 WHERE singleton',[id]);
      await tx.query(`INSERT INTO agent_model_config_event(kind,revision,previous_revision,operator_id,reason,evidence)
        VALUES($1,$2,$3,$4,$5,$6)`,[kind,id,active.revision,viewer.id,reason,evidence]);
      return revision;
    });
    return {active:id,revision:{...selected,was_active:true}};
  }

  @Post('revisions/:id/activate')
  async activate(@Req() req:Request,@Param('id') id:string,@Body() input:unknown) {
    return this.change(req,id,input,'activate');
  }

  @Post('revisions/:id/restore')
  async restore(@Req() req:Request,@Param('id') id:string,@Body() input:unknown) {
    return this.change(req,id,input,'restore');
  }
}
