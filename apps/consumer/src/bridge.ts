import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { AppMessage, ToolCallMessage } from '@httpcoder/protocol';
import type { PermissionEngine, AskRequest, UserDecision } from './permissions.js';
import type { Sandbox } from './sandbox.js';
import type { Session, SessionStatus } from './session.js';
import { saveFingerprintPin } from './config.js';

/**
 * Mensagens JSON trocadas com a GUI via WebSocket local.
 *
 * Outbound (consumer → GUI): status, models, token, final, tool-result,
 *   permission-request, fingerprint-confirm, fingerprint-mismatch, error.
 * Inbound (GUI → consumer): prompt, permission-result, fingerprint-result.
 *
 * TOFU sem pin: outbound `{"type":"fingerprint-confirm","fingerprint"}`
 * (a sessão fica gateada até a decisão); inbound
 * `{"type":"fingerprint-result","decision":"confirm"|"abort"}` —
 * "confirm" libera a sessão e grava o pin no config; "abort" fecha a conexão.
 */
export type GuiMessage = Record<string, unknown> & { type: string };

/** Interface mínima do lado da GUI (implementada pelo gui-server; stubada nos testes). */
export interface GuiHub extends EventEmitter {
  broadcast(msg: GuiMessage): void;
}

export interface BridgeOptions {
  session: Session;
  sandbox: Sandbox;
  permissions: PermissionEngine;
  hub: GuiHub;
  /** Caminho do consumer.config.json; ao confirmar o fingerprint (TOFU), o pin é gravado nele */
  configPath?: string;
}

/**
 * Cola entre GUI, sessão criptografada e executor sandbox.
 *
 * prompt (GUI) → host; token/final (host) → GUI;
 * tool-call (host) → validação sandbox → permissão (cartão na GUI) → execução → tool-result.
 */
export class Bridge {
  private readonly session: Session;
  private readonly sandbox: Sandbox;
  private readonly permissions: PermissionEngine;
  private readonly hub: GuiHub;
  private readonly configPath?: string;
  /** Fingerprint pendente de confirmação TOFU (sem pin), para reenviar a navegadores recém-conectados */
  private pendingFingerprint?: string;

  constructor(opts: BridgeOptions) {
    this.session = opts.session;
    this.sandbox = opts.sandbox;
    this.permissions = opts.permissions;
    this.hub = opts.hub;
    this.configPath = opts.configPath;

    // --- GUI → host / permissões ---
    this.hub.on('prompt', (msg: GuiMessage) => this.handlePrompt(msg));
    this.hub.on('permission-result', (msg: GuiMessage) => {
      this.permissions.resolve(String(msg.requestId), msg.decision as UserDecision);
    });
    this.hub.on('fingerprint-result', (msg: GuiMessage) => this.handleFingerprintResult(msg));
    this.hub.on('client-connected', () => {
      // novo navegador aberto: sincroniza estado atual
      this.hub.broadcast({ type: 'status', state: this.sessionStatus, fingerprint: this.session.fingerprint });
      if (this.lastModels) this.hub.broadcast({ type: 'models', models: this.lastModels });
      if (this.pendingFingerprint) {
        this.hub.broadcast({ type: 'fingerprint-confirm', fingerprint: this.pendingFingerprint });
      }
    });

    // --- host → GUI ---
    this.session.on('message', (msg: AppMessage) => void this.handleAppMessage(msg));
    this.session.on('status', (status: SessionStatus) => {
      this.sessionStatus = status;
      this.hub.broadcast({ type: 'status', state: status, fingerprint: this.session.fingerprint });
      if (status === 'ready') this.session.sendApp({ type: 'model-list-request' });
    });
    this.session.on('fingerprint-confirm', ({ fingerprint }: { fingerprint: string }) => {
      this.pendingFingerprint = fingerprint;
      this.hub.broadcast({ type: 'fingerprint-confirm', fingerprint });
    });
    this.session.on('fingerprint-mismatch', (mismatch) => {
      this.hub.broadcast({ type: 'fingerprint-mismatch', ...mismatch });
    });
    this.session.on('error', (err: Error) => {
      this.hub.broadcast({ type: 'error', message: err.message });
    });

    // --- pedidos de permissão → cartão na GUI ---
    this.permissions.on('ask', (req: AskRequest) => {
      this.hub.broadcast({ type: 'permission-request', ...req });
    });
  }

  private sessionStatus: SessionStatus = 'disconnected';
  private lastModels?: string[];

  /** Decisão TOFU vinda da GUI: repassa à sessão; ao confirmar, grava o pin no config. */
  private handleFingerprintResult(msg: GuiMessage): void {
    const decision = msg.decision;
    if (decision !== 'confirm' && decision !== 'abort') return;
    const fingerprint = this.pendingFingerprint ?? this.session.fingerprint;
    this.pendingFingerprint = undefined;
    this.session.resolveFingerprint(decision);
    if (decision === 'confirm' && this.configPath && fingerprint) {
      try {
        saveFingerprintPin(this.configPath, fingerprint);
      } catch (err) {
        this.hub.broadcast({
          type: 'error',
          message: `falha ao gravar fingerprintPin no config: ${err instanceof Error ? err.message : err}`,
        });
      }
    }
  }

  private handlePrompt(msg: GuiMessage): void {
    if (typeof msg.text !== 'string' || msg.text.length === 0) return;
    if (!this.session.ready) {
      this.hub.broadcast({ type: 'error', message: 'sessão ainda não está pronta' });
      return;
    }
    const prompt: AppMessage = { type: 'prompt', id: randomUUID(), text: msg.text };
    if (typeof msg.model === 'string' && msg.model.length > 0) prompt.model = msg.model;
    this.session.sendApp(prompt);
  }

  private async handleAppMessage(msg: AppMessage): Promise<void> {
    switch (msg.type) {
      case 'token':
      case 'final':
        this.hub.broadcast({ type: msg.type, id: msg.id, text: msg.text });
        break;
      case 'tool-call':
        await this.handleToolCall(msg);
        break;
      case 'model-list':
        this.lastModels = msg.models;
        this.hub.broadcast({ type: 'models', models: msg.models });
        break;
      case 'app-error':
        this.hub.broadcast({ type: 'error', id: msg.id, message: msg.message });
        break;
      default:
        break;
    }
  }

  /**
   * Ordem das validações: (1) sandbox valida o alvo ANTES de qualquer prompt;
   * (2) permissão do usuário; (3) execução. Recusas em (1) nunca chegam à GUI.
   */
  private async handleToolCall(msg: ToolCallMessage): Promise<void> {
    const reply = (ok: boolean, output: string): void => {
      if (this.session.ready) {
        this.session.sendApp({ type: 'tool-result', id: msg.id, callId: msg.callId, ok, output });
      }
      this.hub.broadcast({ type: 'tool-result', callId: msg.callId, name: msg.name, ok, output });
    };

    // (1) validação do sandbox + alvo normalizado
    let target: string;
    try {
      target = await this.normalizeTarget(msg);
    } catch (err) {
      reply(false, err instanceof Error ? err.message : String(err));
      return;
    }

    // (2) permissão (com diff para write_file)
    const meta: Record<string, unknown> = { args: msg.args, callId: msg.callId };
    if (msg.name === 'write_file') {
      meta.diff = {
        before: (await this.sandbox.readCurrentContent(target)) ?? '',
        after: String(msg.args.content ?? ''),
      };
    }
    const allowed = await this.permissions.authorize(msg.name, target, meta);
    if (!allowed) {
      reply(false, 'permissão negada pelo usuário');
      return;
    }

    // (3) execução
    const result = await this.sandbox.execute(msg.name, msg.args);
    reply(result.ok, result.output);
  }

  /** Normaliza e valida o alvo da tool: caminho real para arquivos, executável para comandos. */
  private async normalizeTarget(msg: ToolCallMessage): Promise<string> {
    switch (msg.name) {
      case 'read_file':
      case 'write_file':
        return this.sandbox.resolvePath(String(msg.args.path ?? ''));
      case 'list_dir':
        return this.sandbox.resolvePath(String(msg.args.path ?? '.'));
      case 'run_command':
        return this.sandbox.checkCommand(String(msg.args.command ?? '')).executable;
      default:
        throw new Error(`ferramenta desconhecida: ${msg.name}`);
    }
  }
}
