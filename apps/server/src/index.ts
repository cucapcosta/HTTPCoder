import { createRelayServer } from './relay.js';

// Bin do relay: sobe o servidor na porta PORT (default 8080) e loga a porta efetiva.
const port = Number(process.env.PORT ?? 8080);
const relay = createRelayServer({ port });

relay.server.on('listening', () => {
  console.log(`relay ouvindo na porta ${relay.port()}`);
});
