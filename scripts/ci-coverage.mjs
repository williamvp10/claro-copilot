import { readFile, writeFile } from 'node:fs/promises';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Pass an LCOV report and an output path');
const report = await readFile(input, 'utf8');
const count = prefix => [...report.matchAll(new RegExp('^' + prefix + ':(\\d+)$', 'gm'))]
  .reduce((total, match) => total + Number(match[1]), 0);
const measured = count('LF');
const covered = count('LH');
if (!measured || covered > measured) throw new Error('Missing or invalid line coverage');
await writeFile(output, JSON.stringify({line_coverage_pct:covered * 100 / measured,
  lines_found:measured, lines_hit:covered, scope:'backend and agent Node suites'}, null, 2) + '\n');
