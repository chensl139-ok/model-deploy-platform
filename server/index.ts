import { readConfig } from './config.js';
import { buildApp } from './app.js';

const config = readConfig();
const { app } = await buildApp(config, { logger: true });
await app.listen({ host: config.HOST, port: config.PORT });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => { await app.close(); process.exit(0); });
