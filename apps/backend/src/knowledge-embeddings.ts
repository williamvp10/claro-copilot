import { z } from 'zod';

const revision='614241f622f53c4eeff9890bdc4f31cfecc418b3';
const reply=z.object({revision:z.literal(revision),vectors:z.array(z.array(z.number().finite()).length(384)).max(16)});

export async function encodeKnowledge(texts:string[],kind:'query'|'passage') {
  const {ML_API_URL,ML_SERVICE_TOKEN}=process.env;
  if (!ML_API_URL || !ML_SERVICE_TOKEN) return null;
  try {
    const response=await fetch(new URL('/internal/v1/knowledge-embedding',ML_API_URL),{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(kind==='query'?750:15000),
      headers:{Authorization:`Bearer ${ML_SERVICE_TOKEN}`,'Content-Type':'application/json'},
      body:JSON.stringify({kind,texts})
    });
    if (!response.ok) return null;
    const parsed=reply.safeParse(await response.json());
    return parsed.success && parsed.data.vectors.length===texts.length ? parsed.data.vectors : null;
  } catch {
    return null;
  }
}
