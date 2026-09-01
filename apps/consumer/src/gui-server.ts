import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import type { GuiHub, GuiMessage } from './bridge.js';

export interface GuiServerOptions {
  /** Porta local (0 = porta livre aleatória, útil em testes) */
  port: number;
  /** Diretório com index.html e app.js */
  publicDir: string;
}

export interface GuiServer extends GuiHub {
  readonly port: number;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

class GuiServerImpl extends EventEmitter implements GuiServer {
  readonly port: number;

  constructor(
    private readonly server: Server,
    private readonly wss: WebSocketServer,
  ) {
    super();
    const addr = server.address() as { port: number };
    this.port = addr.port;
  }

  /** Envia uma mensagem JSON a todos os navegadores conectados. */
  broadcast(msg: GuiMessage): void {
    const data = JSON.stringify(msg);
    for (const client of this.wss.clients) {
      if (client.readyState === client.OPEN) client.send(data);
    }
  }

  close(): Promise<void> {
    return new Promise((res) => {
      for (const client of this.wss.clients) client.terminate();
      this.wss.close(() => this.server.close(() => res()));
    });
  }
}

/**
 * Servidor local da GUI: HTTP em 127.0.0.1 servindo o bundle React
 * e WebSocket (lib ws) para os eventos JSON da interface.
 * Mensagens vindas da GUI são re-emitidas como eventos (msg.type) no objeto retornado.
 */
export function createGuiServer(opts: GuiServerOptions): Promise<GuiServer> {
  const server: Server = createServer((req, res) => {
    const url = req.url === '/' ? '/index.html' : (req.url ?? '/index.html');
    // estáticos confinados ao publicDir: sem path traversal
    const file = path.join(path.resolve(opts.publicDir), path.normalize(url).replace(/^([/\\])+/, ''));
    if (!file.startsWith(path.resolve(opts.publicDir) + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    readFile(file)
      .then((content) => {
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
        res.end(content);
      })
      .catch(() => res.writeHead(404).end('not found'));
  });

  let hub: GuiServerImpl;
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws: WebSocket) => {
    hub.emit('client-connected', { type: 'client-connected' });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as GuiMessage;
        if (typeof msg.type === 'string') hub.emit(msg.type, msg);
      } catch {
        // mensagem malformada da GUI local: ignora
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      hub = new GuiServerImpl(server, wss);
      resolve(hub);
    });
  });
}
