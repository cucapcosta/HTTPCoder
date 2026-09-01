/**
 * Cliente mínimo da API do Ollama (lista de modelos + chat com streaming NDJSON).
 * Usa o fetch global do Node; streaming via reader sobre o body.
 */

export interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string; items?: { type: string } }>;
      required: string[];
    };
  };
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  onToken?: (token: string) => void;
}

export interface ChatResult {
  content: string;
  toolCalls: OllamaToolCall[];
}

/** Tools agênticas executadas pelo consumer (o host só retransmite os calls). */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Lê o conteúdo de um arquivo de texto no computador do usuário.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Caminho do arquivo a ler.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Escreve (cria ou sobrescreve) um arquivo no computador do usuário.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Caminho do arquivo a escrever.' },
          content: { type: 'string', description: 'Conteúdo completo do arquivo.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'Lista os arquivos e pastas de um diretório no computador do usuário.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Caminho do diretório a listar.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Executa um comando permitido no computador do usuário e retorna a saída.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Executável do comando (ex.: git, npm).' },
          args: {
            type: 'array',
            description: 'Argumentos do comando.',
            items: { type: 'string' },
          },
        },
        required: ['command', 'args'],
      },
    },
  },
];

interface NdjsonLine {
  message?: { role?: string; content?: string; tool_calls?: OllamaToolCall[] };
  done?: boolean;
  error?: string;
}

export class OllamaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** GET /api/tags → nomes dos modelos instalados. */
  async listModels(): Promise<string[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/tags`);
    if (!res.ok) {
      throw new Error(`Ollama /api/tags respondeu ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    return (body.models ?? []).map((m) => m.name ?? '').filter((n) => n !== '');
  }

  /** POST /api/chat com stream=true; parseia NDJSON linha a linha. */
  async chat(options: ChatOptions): Promise<ChatResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        tools: options.tools,
        stream: true,
      }),
    });
    if (!res.ok) {
      throw new Error(`Ollama /api/chat respondeu ${res.status}: ${await res.text()}`);
    }
    if (!res.body) throw new Error('Ollama /api/chat não retornou body para streaming');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    const toolCalls: OllamaToolCall[] = [];

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed === '') return;
      const parsed = JSON.parse(trimmed) as NdjsonLine;
      if (parsed.error) throw new Error(`erro do Ollama: ${parsed.error}`);
      const token = parsed.message?.content;
      if (typeof token === 'string' && token !== '') {
        content += token;
        options.onToken?.(token);
      }
      if (parsed.message?.tool_calls) toolCalls.push(...parsed.message.tool_calls);
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== '') handleLine(buffer);

    return { content, toolCalls };
  }
}
