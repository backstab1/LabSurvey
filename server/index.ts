import { config } from './config.ts';
import { buildApp } from './app.ts';
import { scheduleBackups } from './backup.ts';

const app = await buildApp();
await app.listen({ port: config.port, host: config.host });
console.log(`SurveyLAB: http://localhost:${config.port}`);
scheduleBackups();
