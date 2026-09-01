import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import {
  decrypt,
  deriveSessionKey,
  encrypt,
  generateIdentity,
  hashRoom,
  parseAppMessage,
  parseRelayMessage,
  serialize,
  type AppMessage,
  type Identity,
} from '@httpcoder/protocol';

export const ROOM = 'sala-de-teste-42';

/**
 * Relay cego + consumer fake em um só processo: repassa o papel do consumer
 * (inicia o handshake) e expõe helpers para afirmar o tráfego criptografado.
 */
export class FakeRelayConsumer {
  sessionKey?: Buffer;
  received: AppMessage[] = [];
  connections = 0;

  private wss?: WebSocketServer;
  private sockets = new Set<WsSocket>();
  private waiters: Array<{
    pred: (msg: AppMessage) => boolean;
    resolve: (msg: AppMessage) => void;
  }> = [];

  constructor(
    readonly identity: Identity = generateIdentity(),
    private readonly roomCode: string = ROOM,
  ) {}

  async start(): Promise<string> {
    this.wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => this.wss!.on('listening', resolve));
    this.wss.on('connection', (socket) => {
      this.connections += 1;
      this.sockets.add(socket);
      socket.on('message', (data) => this.handle(socket, data.toString()));
      socket.on('close', () => this.sockets.delete(socket));
    });
    const { port } = this.wss.address() as AddressInfo;
    return `ws://127.0.0.1:${port}`;
  }

  private handle(socket: WsSocket, raw: string): void {
    const msg = parseRelayMessage(raw);
    if (msg.type === 'hello') {
      if (msg.role !== 'host') throw new Error(`role inesperado: ${msg.role}`);
      if (msg.room !== hashRoom(this.roomCode)) throw new Error('room hash divergente');
      socket.send(
        serialize({
          type: 'handshake',
          role: 'consumer',
          publicKey: this.identity.publicKey.toString('base64'),
        }),
      );
      return;
    }
    if (msg.type === 'handshake') {
      if (msg.role !== 'host') throw new Error(`role inesperado: ${msg.role}`);
      this.sessionKey = deriveSessionKey(
        this.identity.privateKey,
        Buffer.from(msg.publicKey, 'base64'),
      );
      return;
    }
    if (msg.type === 'frame') {
      if (!this.sessionKey) throw new Error('frame antes do handshake');
      const plain = decrypt(this.sessionKey, Buffer.from(msg.data, 'base64')).toString('utf8');
      const app = parseAppMessage(plain);
      this.received.push(app);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(app)) {
          w.resolve(app);
          return false;
        }
        return true;
      });
    }
  }

  /** Envia mensagem de aplicação criptografada ao host (última conexão ativa). */
  sendApp(msg: AppMessage): void {
    if (!this.sessionKey) throw new Error('sem session key');
    const frame = encrypt(this.sessionKey, Buffer.from(serialize(msg), 'utf8'));
    const socket = [...this.sockets].at(-1);
    if (!socket) throw new Error('sem conexão com o host');
    socket.send(serialize({ type: 'frame', data: frame.toString('base64') }));
  }

  nextAppMessage(pred: (msg: AppMessage) => boolean = () => true): Promise<AppMessage> {
    const already = this.received.find(pred);
    if (already) return Promise.resolve(already);
    return new Promise((resolve) => this.waiters.push({ pred, resolve }));
  }

  /** Aguarda o fake derivar a session key (processar a resposta de handshake do host). */
  waitForKey(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (this.sessionKey) {
          clearInterval(timer);
          resolve();
        }
      }, 5);
    });
  }

  /** Derruba a conexão atual do host (simula queda de rede). */
  dropHost(): void {
    for (const socket of this.sockets) socket.terminate();
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    await new Promise((resolve) => this.wss?.close(resolve));
  }
}
