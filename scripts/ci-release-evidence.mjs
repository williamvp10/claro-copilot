import { readFile, writeFile } from 'node:fs/promises';

const [imageDigestPath, coveragePath, output] = process.argv.slice(2);
const { COMPONENT, GITHUB_SHA, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, IMAGE_BYTES, COMMIT_AT } = process.env;
const image = (await readFile(imageDigestPath, 'utf8')).trim();
const digest = image.split('@')[1];
const bytes = Number(IMAGE_BYTES);
const coverage = COMPONENT === 'claro-copiloto' ? JSON.parse(await readFile(coveragePath,'utf8')).line_coverage_pct : null;
if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? '') || !Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('Invalid inspected image');
if (!/^[a-f0-9]{40}$/.test(GITHUB_SHA ?? '') || !COMMIT_AT || !Number.isFinite(Date.parse(COMMIT_AT))) throw new Error('Invalid commit');
await writeFile(output, JSON.stringify({
  sha:GITHUB_SHA,digest,component:COMPONENT,
  workflow_url:`${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`,
  ci:'passed',coverage_pct:coverage,bytes,critical:0,scanned_at:new Date().toISOString(),commit_at:COMMIT_AT,
  smoke:'pending',smoke_verified_at:null
}, null, 2) + '\n');
