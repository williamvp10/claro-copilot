import { readFileSync, writeFileSync } from 'node:fs';

function read(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    return '';
  }
}

const head = read('.git/HEAD');
const mainRef = 'refs/heads/main';
const sha = head === 'ref: ' + mainRef
  ? read('.git/' + mainRef) || read('.git/packed-refs').split('\n')
    .find(line => line.endsWith(' ' + mainRef))?.split(' ')[0]
  : head;
writeFileSync('.deployment-revision', /^[a-f0-9]{40}$/.test(sha ?? '') ? sha : '');
