import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

function hashRuntime() {
  const hash = createHash('sha256').update('claro-runtime-v1\0');
  const packages = [
    ['backend', fileURLToPath(new URL('.', import.meta.url))],
    ['agent', dirname(require.resolve('@claro/agent'))],
    ['contracts', dirname(require.resolve('@claro/contracts'))]
  ];
  for (const [name, root] of packages) {
    for (const file of readdirSync(root,{encoding:'utf8',recursive:true}).filter(file=>file.endsWith('.js')).sort()) {
      const digest=createHash('sha256').update(readFileSync(join(root,file))).digest('hex');
      hash.update(JSON.stringify([name,file,digest]));
    }
  }
  hash.update(readFileSync(new URL('../../../pnpm-lock.yaml',import.meta.url)));
  return hash.digest('hex');
}

export const runtimeSha256 = hashRuntime();
