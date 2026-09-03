import { EventEmitter } from 'node:events';
import {
  decrypt,
  deriveSessionKey,
  encrypt,
  fingerprint,
  generateIdentity,
  hashRoom,
  parseAppMessage,
  parseRelayMessage,
  serialize,
  type AppMessage,
  type Identity,
} from '@httpcoder/protocol';

export type SessionStatus = 'connecting' | 'connected' | 'ready' | 'waiting-peer' | 'disconnected';

export interface SessionOptions {
  serverUrl: string;
  roomCode: string;
  /** Pin TOFU: se presente e divergir do fingerprint da sessão, aborta (evento fingerprint-mismatch) */
  fingerprintPin?: string;
  /** Identidade X25519 persistente (TOFU). Default: efêmera por processo */
  identity?: Identity;
  /** Reconexão automática (default: true) */
  reconnect?: boolean;
  /** Backoff injetável: tentativa (1-based) → ms de espera (default: exponencial até 30s) */
  backoffMs?: (attempt: number) => number;
  /** Construtor de WebSocket injetável (default: WebSocket global do Node) */
  WebSocketCtor?: new (url: string) => WebSocket;
}

function defaultBackoff(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 30_000);
}

/**
 * Sessão criptografada do consumer com o host, através do relay cego.
 * Espelha o host: hello → handshake X25519 → frames AES-256-GCM nos dois sentidos.
 *
 * Eventos:
 *  - 'status' (SessionStatus)
 *  - 'ready' ({ fingerprint }) — handshake concluído e pin conferido (ou fingerprint confirmado pelo usuário)
 *  - 'fingerprint-confirm' ({ fingerprint }) — sem pin: aguarda resolveFingerprint() para liberar a sessão
 *  - 'fingerprint-mismatch' ({ expected, actual }) — pin TOFU divergente; a sessão aborta
 *  - 'message' (AppMessage) — mensagem de aplicação descriptografada
 *  - 'error' (Error)
 */
export class Session extends EventEmitter {
  private _fingerprint?: string;

  private readonly opts: SessionOptions;
  private readonly backoff: (attempt: number) => number;
  private readonly WebSocketCtor: new (url: string) => WebSocket;
  private readonly identity: Identity;
  private sessionKey?: Buffer;
  private ws?: WebSocket;
  private attempts = 0;
  private closed = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private status: SessionStatus = 'disconnected';
  /** Fingerprint aguardando decisão TOFU do usuário (sem pin configurado) */
  private pendingFingerprint?: string;

  constructor(opts: SessionOptions) {
    super();
    this.opts = opts;
    this.backoff = opts.backoffMs ?? defaultBackoff;
    this.WebSocketCtor = opts.WebSocketCtor ?? (globalThis.WebSocket as unknown as new (url: string) => WebSocket);
    // identidade fixa por processo (persistida pelo caller via identity.ts);
    // só a chave de sessão é efêmera por conexão (forward secrecy)
    this.identity = opts.identity ?? generateIdentity();
  }

  /** Chave pública X25519 local (DER/SPKI), para conferência de fingerprint nos testes. */
  get publicKey(): Buffer {
    return this.identity.publicKey;
  }

  /** Fingerprint da sessão (TOFU), disponível após o handshake. */
  get fingerprint(): string | undefined {
    return this._fingerprint;
  }

  get ready(): boolean {
    return this.sessionKey !== undefined && this.status === 'ready';
  }

  connect(): void {
    if (this.closed) return;
    this.setStatus('connecting');
    const ws = new this.WebSocketCtor(this.opts.serverUrl);
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.setStatus('connected');
      // chave de sessão reiniciada a cada conexão; a identidade permanece a mesma
      this.sessionKey = undefined;
      this.pendingFingerprint = undefined;
      ws.send(serialize({ type: 'hello', role: 'consumer', room: hashRoom(this.opts.roomCode) }));
      this.sendHandshake(ws);
    };

    ws.onmessage = (event: MessageEvent) => {
      let msg;
      try {
        msg = parseRelayMessage(String(event.data));
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
        return;
      }
      switch (msg.type) {
        case 'handshake':
          this.handleHandshake(msg.publicKey);
          break;
        case 'frame':
          this.handleFrame(msg.data);
          break;
        case 'peer-connected':
          // host (re)apareceu: reenvia o handshake para garantir a derivação da chave
          if (msg.role === 'host') this.sendHandshake(ws);
          break;
        case 'peer-disconnected':
          if (msg.role === 'host') this.setStatus('waiting-peer');
          break;
        case 'error':
          this.emit('error', new Error(msg.message));
          break;
        case 'hello':
          break;
      }
    };

    ws.onclose = () => {
      this.sessionKey = undefined;
      this.pendingFingerprint = undefined;
      this.setStatus('disconnected');
      if (this.closed || this.opts.reconnect === false) return;
      this.attempts += 1;
      this.reconnectTimer = setTimeout(() => this.connect(), this.backoff(this.attempts));
    };

    ws.onerror = () => {
      this.emit('error', new Error('falha na conexão WebSocket com o relay'));
    };
  }

  /** Envia mensagem de aplicação criptografada. Lança se a sessão não estiver pronta. */
  sendApp(msg: AppMessage): void {
    if (this.pendingFingerprint !== undefined) {
      throw new Error('aguardando confirmação do fingerprint (TOFU)');
    }
    if (!this.sessionKey || !this.ws || this.ws.readyState !== this.ws.OPEN) {
      throw new Error('sessão ainda não está pronta (handshake pendente)');
    }
    const frame = encrypt(this.sessionKey, Buffer.from(serialize(msg), 'utf8'));
    this.ws.send(serialize({ type: 'frame', data: frame.toString('base64') }));
  }

  /**
   * Decisão TOFU do usuário sobre o fingerprint exibido (evento 'fingerprint-confirm'):
   * 'confirm' libera a sessão (evento 'ready'); 'abort' fecha a conexão.
   * No-op quando não há confirmação pendente.
   */
  resolveFingerprint(decision: 'confirm' | 'abort'): void {
    if (this.pendingFingerprint === undefined) return;
    const fp = this.pendingFingerprint;
    this.pendingFingerprint = undefined;
    if (decision === 'abort') {
      this.sessionKey = undefined;
      this.closed = true;
      this.ws?.close();
      return;
    }
    this.setStatus('ready');
    this.emit('ready', { fingerprint: fp });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private sendHandshake(ws: WebSocket): void {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(
      serialize({ type: 'handshake', role: 'consumer', publicKey: this.identity.publicKey.toString('base64') }),
    );
  }

  private handleHandshake(publicKeyB64: string): void {
    const peerKey = Buffer.from(publicKeyB64, 'base64');
    this.sessionKey = deriveSessionKey(this.identity.privateKey, peerKey);
    const fp = fingerprint(this.identity.publicKey, peerKey, this.opts.roomCode);

    const pin = this.opts.fingerprintPin;
    if (pin && pin !== fp) {
      // TOFU: o fingerprint mudou — aborta sem enviar nada de aplicação
      this.sessionKey = undefined;
      this.emit('fingerprint-mismatch', { expected: pin, actual: fp });
      this.closed = true;
      this.ws?.close();
      return;
    }
    if (this._fingerprint === fp && (this.pendingFingerprint !== undefined || this.status === 'ready')) {
      // handshake duplicado na mesma conexão (ex.: re-handshake em peer-connected):
      // a chave é idêntica — mantém o estado (gate TOFU ou ready) sem re-emitir eventos
      return;
    }
    this._fingerprint = fp;
    if (!pin) {
      // TOFU sem pin: gateia a sessão até o usuário confirmar o fingerprint
      this.pendingFingerprint = fp;
      this.emit('fingerprint-confirm', { fingerprint: fp });
      return;
    }
    this.setStatus('ready');
    this.emit('ready', { fingerprint: fp });
  }

  private handleFrame(dataB64: string): void {
    if (this.pendingFingerprint !== undefined) {
      // frames de aplicação antes da decisão TOFU são descartados
      console.warn('[consumer] frame descartado: aguardando confirmação do fingerprint (TOFU)');
      return;
    }
    if (!this.sessionKey) return;
    try {
      const plain = decrypt(this.sessionKey, Buffer.from(dataB64, 'base64'));
      this.emit('message', parseAppMessage(plain.toString('utf8')));
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  private setStatus(status: SessionStatus): void {
    this.status = status;
    this.emit('status', status);
  }
}
