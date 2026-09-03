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

export interface SessionOptions {
  serverUrl: string;
  roomCode: string;
  /** Pin TOFU salvo no config; ausente na primeira conexão. */
  fingerprintPin?: string;
  /** Identidade X25519; gerada uma vez por processo se omitida (reusada nas reconexões). */
  identity?: Identity;
  /** Primeira conexão: exibe o fingerprint e aguarda confirmação manual do usuário. */
  confirmFingerprint?: (fp: string) => Promise<boolean>;
  /** Chamada após confirmação para fixar o pin (persistência fica a cargo do caller). */
  savePin?: (pin: string) => void;
  /** Delays de backoff em ms; o último se repete. Injetável para teste. */
  backoffDelays?: number[];
  /** Injetável para teste. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SessionCallbacks {
  onMessage: (msg: AppMessage) => void;
  onLog?: (msg: string) => void;
  onEstablished?: (fingerprint: string) => void;
  onDisconnected?: () => void;
  /** Erro fatal (ex.: fingerprint divergente) — a sessão não reconecta. */
  onFatal?: (err: Error) => void;
}

const DEFAULT_BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000];

/**
 * Sessão do host com o relay: hello, handshake X25519 (o consumer inicia),
 * fingerprint TOFU e frames criptografados AES-256-GCM. Reconecta com backoff.
 */
export class HostSession {
  private readonly identity: Identity;
  private readonly delays: number[];
  private readonly sleep: (ms: number) => Promise<void>;

  private ws?: WebSocket;
  private sessionKey?: Buffer;
  private established = false;
  private closed = false;
  private fatal = false;
  private attempts = 0;
  /** Pin efetivo da sessão: vem do config ou é aceito via confirmação nesta execução. */
  private pin?: string;

  private connectResolve?: (fp: string) => void;
  private connectReject?: (err: Error) => void;

  constructor(
    private readonly options: SessionOptions,
    private readonly callbacks: SessionCallbacks,
  ) {
    this.identity = options.identity ?? generateIdentity();
    this.delays = options.backoffDelays ?? DEFAULT_BACKOFF;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pin = options.fingerprintPin;
  }

  /** Conecta e resolve com o fingerprint quando a sessão é estabelecida. */
  connect(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.openSocket();
    });
  }

  /**
   * Envia AppMessage criptografada dentro de um frame do relay.
   * Gate TOFU: com a confirmação do fingerprint pendente, descarta com log —
   * o handshake é a única mensagem que sai antes da confirmação.
   */
  send(msg: AppMessage): void {
    if (!this.sessionKey || !this.ws) {
      throw new Error('sessão não estabelecida: handshake ainda não completou');
    }
    if (!this.established) {
      this.log('frame descartado: confirmação do fingerprint ainda pendente');
      return;
    }
    const frame = encrypt(this.sessionKey, Buffer.from(serialize(msg), 'utf8'));
    this.ws.send(serialize({ type: 'frame', data: frame.toString('base64') }));
  }

  /** Encerra sem reconectar. */
  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  private log(msg: string): void {
    this.callbacks.onLog?.(msg);
  }

  private openSocket(): void {
    const ws = new WebSocket(this.options.serverUrl);
    this.ws = ws;
    ws.addEventListener('open', () => {
      ws.send(
        serialize({
          type: 'hello',
          role: 'host',
          room: hashRoom(this.options.roomCode),
        }),
      );
    });
    ws.addEventListener('message', (ev) => {
      void this.onRelayMessage(ws, String(ev.data)).catch((err: unknown) => {
        this.failFatal(err instanceof Error ? err : new Error(String(err)));
      });
    });
    ws.addEventListener('error', () => {
      this.log('erro no socket do relay');
    });
    ws.addEventListener('close', () => {
      void this.onClose();
    });
  }

  private async onRelayMessage(ws: WebSocket, raw: string): Promise<void> {
    const msg = parseRelayMessage(raw);
    switch (msg.type) {
      case 'handshake':
        await this.onHandshake(ws, msg.publicKey);
        break;
      case 'frame': {
        if (!this.established || !this.sessionKey) {
          this.log('frame recebido antes da confirmação do fingerprint; descartando');
          return;
        }
        const plain = decrypt(this.sessionKey, Buffer.from(msg.data, 'base64')).toString('utf8');
        this.callbacks.onMessage(parseAppMessage(plain));
        break;
      }
      case 'error':
        this.failFatal(new Error(`erro do relay: ${msg.message}`));
        break;
      case 'peer-connected':
        this.log(`peer conectado: ${msg.role}`);
        break;
      case 'peer-disconnected':
        this.log(`peer desconectado: ${msg.role}`);
        break;
      default:
        break;
    }
  }

  private async onHandshake(ws: WebSocket, peerPublicKeyB64: string): Promise<void> {
    const peerPublicKey = Buffer.from(peerPublicKeyB64, 'base64');
    const sessionKey = deriveSessionKey(this.identity.privateKey, peerPublicKey);
    const fp = fingerprint(this.identity.publicKey, peerPublicKey, this.options.roomCode);

    if (this.pin !== undefined && this.pin !== fp) {
      throw new Error(
        `FINGERPRINT DIVERGENTE! Esperado (pin salvo): ${this.pin} — calculado: ${fp}. ` +
          'Possível MITM ou consumer reinstalado; abortando.',
      );
    }

    // O fingerprint = hash(pubHost ‖ pubConsumer ‖ roomCode): o consumer só
    // consegue calculá-lo e exibi-lo depois de receber nossa chave pública.
    // Por isso o handshake sai ANTES de qualquer confirmação do usuário.
    this.sessionKey = sessionKey;
    ws.send(
      serialize({
        type: 'handshake',
        role: 'host',
        publicKey: this.identity.publicKey.toString('base64'),
      }),
    );

    if (this.pin === undefined) {
      const confirm = this.options.confirmFingerprint;
      const ok = confirm ? await confirm(fp) : false;
      if (!ok) {
        throw new Error(`fingerprint ${fp} não confirmado pelo usuário; abortando`);
      }
      this.pin = fp;
      this.options.savePin?.(fp);
    }

    this.established = true;
    this.attempts = 0;
    this.callbacks.onEstablished?.(fp);
    this.connectResolve?.(fp);
    this.connectResolve = undefined;
    this.connectReject = undefined;
  }

  private async onClose(): Promise<void> {
    this.ws = undefined;
    const wasEstablished = this.established;
    this.established = false;
    this.sessionKey = undefined;
    if (this.closed || this.fatal) return;
    if (wasEstablished) this.callbacks.onDisconnected?.();

    const delay = this.delays[Math.min(this.attempts, this.delays.length - 1)]!;
    this.attempts += 1;
    this.log(`conexão com o relay caiu; reconectando em ${delay}ms`);
    await this.sleep(delay);
    if (this.closed || this.fatal) return;
    this.openSocket();
  }

  private failFatal(err: Error): void {
    if (this.fatal) return;
    this.fatal = true;
    this.log(`erro fatal: ${err.message}`);
    this.callbacks.onFatal?.(err);
    this.connectReject?.(err);
    this.connectResolve = undefined;
    this.connectReject = undefined;
    this.ws?.close();
  }
}
