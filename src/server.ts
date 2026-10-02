import { createServer } from './app.js';

const app = await createServer();
await app.listen({ port: 6190, host: '127.0.0.1' });
