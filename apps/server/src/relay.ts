import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { parseRelayMessage, serialize, type RelayMessage, type Role } from '@httpcoder/protocol';

interface RoomSlots {
  host?: WebSocket;
  consumer?: WebSocket;
}

export interface RelayServerOptions {
  /** porta de escuta; 0 (default) = porta aleatória, útil em testes */
  port?: number;
}

export interface RelayServer {
  /** servidor HTTP subjacente (rotas + upgrade WebSocket) */
  server: http.Server;
  /** porta efetiva; só é válida após o evento 'listening' */
  port(): number;
  /** encerra conexões WS abertas e para de ouvir */
  close(): Promise<void>;
}

function sendError(socket: WebSocket, message: string): void {
  socket.send(serialize({ type: 'error', message }));
}

export function createRelayServer(options: RelayServerOptions = {}): RelayServer {
  // Estado único do relay: salas em memória. Nada é persistido nem inspecionado.
  const rooms = new Map<string, RoomSlots>();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/download/host' || url.pathname === '/download/consumer')) {
      const envName = url.pathname === '/download/host' ? 'HOST_ASSET_URL' : 'CONSUMER_ASSET_URL';
      const target = process.env[envName];
      if (!target) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`variável de ambiente ${envName} não configurada`);
        return;
      }
      res.writeHead(302, { location: target });
      res.end();
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (socket) => {
    // Sala e papel só são definidos depois do hello inicial.
    let room: string | undefined;
    let role: Role | undefined;

    const peer = (): WebSocket | undefined => {
      if (!room || !role) return undefined;
      const slots = rooms.get(room);
      return role === 'host' ? slots?.consumer : slots?.host;
    };

    socket.on('message', (raw) => {
      let msg: RelayMessage;
      try {
        msg = parseRelayMessage(raw.toString());
      } catch {
        sendError(socket, 'mensagem de relay inválida');
        return;
      }

      if (room === undefined) {
        // A primeira mensagem precisa ser um hello { role, room }.
        if (msg.type !== 'hello') {
          sendError(socket, "a primeira mensagem deve ser 'hello'");
          socket.close();
          return;
        }
        const slots = rooms.get(msg.room) ?? {};
        if (slots[msg.role]) {
          sendError(socket, `já existe um ${msg.role} conectado nesta sala`);
          socket.close();
          return;
        }
        slots[msg.role] = socket;
        rooms.set(msg.room, slots);
        room = msg.room;
        role = msg.role;
        peer()?.send(serialize({ type: 'peer-connected', role }));
        return;
      }

      // Relay cego: handshake e frame são retransmitidos verbatim (mesma string
      // recebida, sem resserializar nem inspecionar payload) para a outra ponta.
      // Decisão: se o par ainda não conectou, a mensagem é DESCARTADA — o relay
      // não retém fila de frames (sala ociosa não acumula estado).
      if (msg.type === 'handshake' || msg.type === 'frame') {
        const target = peer();
        if (target && target.readyState === WebSocket.OPEN) {
          target.send(raw.toString());
        }
      }
      // Demais tipos válidos (ex.: outro hello) são ignorados após o registro.
    });

    socket.on('close', () => {
      if (!room || !role) return;
      const slots = rooms.get(room);
      if (!slots) return;
      // Libera o slot apenas se ele ainda é desta conexão.
      if (slots[role] === socket) slots[role] = undefined;
      const other = role === 'host' ? slots.consumer : slots.host;
      if (other) {
        other.send(serialize({ type: 'peer-disconnected', role }));
      } else {
        // Sala vazia sai do mapa — relay volta ao estado ocioso.
        rooms.delete(room);
      }
    });
  });

  server.listen(options.port ?? 0);

  return {
    server,
    port() {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error("servidor ainda não está ouvindo (aguarde o evento 'listening')");
      }
      return address.port;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
