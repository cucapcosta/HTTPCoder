import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export type Evaluation = 'allow' | 'deny' | 'ask';
export type UserDecision = 'once' | 'always' | 'deny';

export interface AskRequest {
  requestId: string;
  tool: string;
  /** Alvo normalizado (caminho real ou nome do executável) */
  target: string;
  /** Metadados extras para a GUI (args, diff, etc.) */
  [key: string]: unknown;
}

/** Tools que o consumer sabe executar; qualquer outra é negada sem perguntar. */
const KNOWN_TOOLS = new Set(['read_file', 'write_file', 'list_dir', 'run_command']);

function ruleKey(tool: string, target: string): string {
  return `${tool}${target}`;
}

/**
 * Motor de permissão das tool-calls.
 * Regras "sempre permitir" ficam só em memória, por par (tool, alvo normalizado),
 * e nunca expandem o sandbox — apenas dispensam o prompt repetido.
 */
export class PermissionEngine extends EventEmitter {
  private readonly alwaysRules = new Set<string>();
  private readonly pending = new Map<string, (decision: UserDecision) => void>();

  /** Avaliação síncrona: 'deny' para tool desconhecida, 'allow' se há regra, senão 'ask'. */
  evaluate(tool: string, target: string): Evaluation {
    if (!KNOWN_TOOLS.has(tool)) return 'deny';
    return this.alwaysRules.has(ruleKey(tool, target)) ? 'allow' : 'ask';
  }

  /**
   * Autoriza uma tool-call. Quando a avaliação é 'ask', emite o evento 'ask'
   * (para a GUI mostrar o cartão) e aguarda resolve() com a decisão do usuário.
   */
  authorize(tool: string, target: string, meta: Record<string, unknown> = {}): Promise<boolean> {
    const evaluation = this.evaluate(tool, target);
    if (evaluation === 'allow') return Promise.resolve(true);
    if (evaluation === 'deny') return Promise.resolve(false);

    const requestId = randomUUID();
    return new Promise<boolean>((resolve) => {
      this.pending.set(requestId, (decision) => {
        if (decision === 'always') this.alwaysRules.add(ruleKey(tool, target));
        resolve(decision !== 'deny');
      });
      const request: AskRequest = { requestId, tool, target, ...meta };
      this.emit('ask', request);
    });
  }

  /** Aplica a decisão do usuário a um pedido pendente. Retorna false se o id é desconhecido. */
  resolve(requestId: string, decision: UserDecision): boolean {
    const resolver = this.pending.get(requestId);
    if (!resolver) return false;
    this.pending.delete(requestId);
    resolver(decision);
    return true;
  }
}
