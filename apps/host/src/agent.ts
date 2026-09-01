import { randomUUID } from 'node:crypto';
import type { AppMessage, ToolResultMessage } from '@httpcoder/protocol';
import { TOOL_DEFINITIONS, type ChatMessage, type OllamaClient } from './ollama.js';

export interface AgentDeps {
  ollama: OllamaClient;
  defaultModel: string;
  /** Destino das mensagens de aplicação (normalmente a HostSession). */
  session: { send(msg: AppMessage): void };
}

/** Proteção contra loop infinito de tool_calls. */
const MAX_TOOL_ROUNDS = 25;

/**
 * Loop agêntico do host: roda o modelo com as tools, retransmite tool_calls ao
 * consumer e alimenta os tool-results de volta até a resposta final.
 */
export class AgentLoop {
  /** Waiters de tool-result pendentes, chaveados por `${promptId}:${callId}`. */
  private readonly pendingToolResults = new Map<
    string,
    (result: ToolResultMessage) => void
  >();

  constructor(private readonly deps: AgentDeps) {}

  async handleMessage(msg: AppMessage): Promise<void> {
    switch (msg.type) {
      case 'prompt':
        await this.runPrompt(msg);
        break;
      case 'tool-result': {
        const waiter = this.pendingToolResults.get(`${msg.id}:${msg.callId}`);
        if (waiter) {
          this.pendingToolResults.delete(`${msg.id}:${msg.callId}`);
          waiter(msg);
        }
        break;
      }
      case 'model-list-request':
        await this.sendModelList();
        break;
      default:
        break;
    }
  }

  private send(msg: AppMessage): void {
    this.deps.session.send(msg);
  }

  private async sendModelList(): Promise<void> {
    try {
      const models = await this.deps.ollama.listModels();
      this.send({ type: 'model-list', models });
    } catch (err) {
      this.send({ type: 'app-error', message: errorMessage(err) });
    }
  }

  private waitToolResult(promptId: string, callId: string): Promise<ToolResultMessage> {
    return new Promise((resolve) => {
      this.pendingToolResults.set(`${promptId}:${callId}`, resolve);
    });
  }

  private async runPrompt(prompt: { id: string; text: string; model?: string }): Promise<void> {
    const model = prompt.model ?? this.deps.defaultModel;
    const messages: ChatMessage[] = [{ role: 'user', content: prompt.text }];
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        const { content, toolCalls } = await this.deps.ollama.chat({
          model,
          messages,
          tools: TOOL_DEFINITIONS,
          onToken: (text) => this.send({ type: 'token', id: prompt.id, text }),
        });

        if (toolCalls.length === 0) {
          this.send({ type: 'final', id: prompt.id, text: content });
          return;
        }

        // registra a fala do assistente (com os calls) antes dos resultados
        messages.push({ role: 'assistant', content, tool_calls: toolCalls });

        for (const call of toolCalls) {
          const callId = randomUUID();
          this.send({
            type: 'tool-call',
            id: prompt.id,
            callId,
            name: call.function.name,
            args: call.function.arguments,
          });
          const result = await this.waitToolResult(prompt.id, callId);
          messages.push({ role: 'tool', content: result.output });
        }
      }
      throw new Error(`limite de ${MAX_TOOL_ROUNDS} rodadas de tool_calls atingido`);
    } catch (err) {
      this.send({ type: 'app-error', id: prompt.id, message: errorMessage(err) });
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
