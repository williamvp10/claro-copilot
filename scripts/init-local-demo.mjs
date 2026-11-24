import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const secret = (bytes = 32) => randomBytes(bytes).toString('hex');
const env = {
  COMPOSE_PROJECT_NAME: 'claro-demo-local',
  WEB_PORT: '39092', API_PORT: '39093', ML_API_PORT: '39094',
  LANGFUSE_UI_PORT: '39095', MLFLOW_UI_PORT: '39096',
  BETTER_AUTH_URL: 'http://localhost:39092',
  LANGFUSE_UI_URL: 'http://localhost:39095', MLFLOW_UI_URL: 'http://localhost:39096',
  LANGFUSE_SHARED_NETWORK: 'claro-demo-local_default', LANGFUSE_PRIVATE_SUBNET: '10.254.94.0/24',
  LANGFUSE_BASE_URL: 'http://langfuse-web:3000', LANGFUSE_PROJECT_ID: 'claro-copiloto',
  LANGFUSE_ADMIN_EMAIL: 'observabilidad@demo.claro.test', LANGFUSE_ADMIN_PASSWORD: secret(12),
  LANGFUSE_PUBLIC_KEY: `pk-lf-${secret(16)}`, LANGFUSE_SECRET_KEY: `sk-lf-${secret()}`,
  ML_API_URL: 'http://ml:8000', ML_RELEASE_VERSION: 'intent-e5-svm-1',
  ML_CHURN_BUNDLE_DIR: '/models/releases/churn-logistic-1',
  KNOWLEDGE_MCP_URL: 'http://knowledge-mcp:3030/mcp',
  AGENT_PROVIDERS: 'fixtures', OPENROUTER_API_KEY: '',
  DEMO_MODE: 'true', DEMO_BUSINESS_DATE: '2026-11-18', DEMO_HOLDER_CODE: '123456',
  CLARO_IMAGE: 'claro-copiloto:local-demo', ML_IMAGE: 'claro-ml:local-demo',
};
for (const key of [
  'BETTER_AUTH_SECRET', 'POSTGRES_PASSWORD', 'CRM_API_KEY', 'BILLING_API_KEY',
  'INTEGRATION_MCP_TOKEN', 'INTEGRATION_MCP_SIGNING_KEY', 'KNOWLEDGE_SERVICE_TOKEN',
  'ML_SERVICE_TOKEN', 'DEMO_INGRESS_TOKEN', 'LANGFUSE_DB_PASSWORD', 'LANGFUSE_SALT',
  'LANGFUSE_ENCRYPTION_KEY', 'LANGFUSE_AUTH_SECRET', 'LANGFUSE_CLICKHOUSE_PASSWORD',
  'LANGFUSE_REDIS_PASSWORD', 'LANGFUSE_STORAGE_PASSWORD',
]) env[key] = secret();
for (const role of ['ASESSOR', 'ADMIN', 'N2']) {
  env[`DEMO_${role}_EMAIL`] = `${role.toLowerCase()}@demo.claro.test`;
  env[`DEMO_${role}_PASSWORD`] = secret(12);
}
env.DATABASE_URL = `postgresql://claro:${env.POSTGRES_PASSWORD}@postgres:5432/claro_demo`;
env.PLATFORM_DATABASE_URL = `postgresql://claro_platform_app:${secret()}@postgres:5432/claro_demo`;
env.CRM_DATABASE_URL = `postgresql://claro_crm_app:${secret()}@postgres:5432/claro_crm`;
env.BILLING_DATABASE_URL = `postgresql://claro_billing_app:${secret()}@postgres:5432/claro_facturacion`;

writeFileSync('.env.demo.local', Object.entries(env).map(([key, value]) => `${key}=${value}\n`).join(''), {
  mode: 0o600, flag: 'wx',
});
console.log('Creado .env.demo.local');
