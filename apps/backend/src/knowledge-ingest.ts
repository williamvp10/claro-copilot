import 'reflect-metadata';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { createDatabase } from './database.js';
import { Document, writeDocument } from './knowledge.js';

const source = process.argv[2];
if (!source || (await stat(source)).size > 5_000_000) throw new Error('Pass a reviewed JSON array up to 5 MB');
const documents = z.array(Document).max(5000).parse(JSON.parse(await readFile(source, 'utf8')));
const db = await createDatabase().initialize();
try {
  await db.transaction(async tx => {
    for (const document of documents) await writeDocument(tx, document);
  });
  console.log(`Indexed ${documents.length} reviewed passages`);
} finally {
  await db.destroy();
}
