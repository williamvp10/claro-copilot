import 'reflect-metadata';
import { createDatabase } from './database.js';

const database = await createDatabase().initialize();
try {
  await database.runMigrations();
} finally {
  await database.destroy();
}
