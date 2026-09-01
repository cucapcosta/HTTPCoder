import { readFileSync, writeFileSync } from 'node:fs';

export interface HostConfig {
  /** URL WebSocket do relay (ws:// ou wss://). */
  serverUrl: string;
  /** Código da sala compartilhado com o consumer (texto claro, só no config local). */
  roomCode: string;
  /** URL base da API do Ollama. */
  ollamaUrl: string;
  /** Modelo default quando o prompt não especifica um. */
  defaultModel: string;
  /** Fingerprint fixado (TOFU); ausente na primeira conexão. */
  fingerprintPin?: string;
}

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

/** Caminho do config: env HTTPCODER_HOST_CONFIG ou ./host.config.json. */
export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.HTTPCODER_HOST_CONFIG ?? 'host.config.json';
}

function requireString(obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`config inválida: campo '${field}' é obrigatório e deve ser string não vazia`);
  }
  return value;
}

/** Carrega e valida o config JSON do host. Lança erro claro em qualquer problema. */
export function loadConfig(path: string = resolveConfigPath()): HostConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`não foi possível ler o config do host em '${path}': ${reason}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`config inválida em '${path}': esperado um objeto JSON`);
  }
  const obj = raw as Record<string, unknown>;

  const serverUrl = requireString(obj, 'serverUrl');
  if (!/^wss?:\/\//.test(serverUrl)) {
    throw new Error(`config inválida: 'serverUrl' deve começar com ws:// ou wss:// (recebido: '${serverUrl}')`);
  }
  const roomCode = requireString(obj, 'roomCode');
  const defaultModel = requireString(obj, 'defaultModel');

  let ollamaUrl = DEFAULT_OLLAMA_URL;
  if (obj.ollamaUrl !== undefined) ollamaUrl = requireString(obj, 'ollamaUrl');

  let fingerprintPin: string | undefined;
  if (obj.fingerprintPin !== undefined) {
    if (typeof obj.fingerprintPin !== 'string') {
      throw new Error("config inválida: 'fingerprintPin' deve ser string quando presente");
    }
    fingerprintPin = obj.fingerprintPin;
  }

  return { serverUrl, roomCode, ollamaUrl, defaultModel, fingerprintPin };
}

/**
 * Fixa o fingerprint no arquivo de config (TOFU), preservando os demais campos.
 */
export function saveFingerprintPin(path: string, pin: string): void {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  raw.fingerprintPin = pin;
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
}
