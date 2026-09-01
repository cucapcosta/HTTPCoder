import { readFileSync } from 'node:fs';

export interface ConsumerConfig {
  /** URL do relay, ex.: wss://httpcoder.up.railway.app/ws */
  serverUrl: string;
  /** Código da sala compartilhado com o host (nunca sai em texto claro) */
  roomCode: string;
  /** Porta da GUI local em 127.0.0.1 (default: 4173) */
  guiPort: number;
  /** Pastas que as tools de arquivo podem acessar */
  allowedPaths: string[];
  /** Executáveis permitidos para run_command */
  allowedCommands: string[];
  /** Fingerprint fixado (TOFU); se divergir da sessão, a conexão é abortada */
  fingerprintPin?: string;
  /** Timeout de run_command em ms (default: 30000) */
  commandTimeoutMs?: number;
}

function requireString(obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`config inválida: campo '${field}' ausente ou não é string`);
  }
  return value;
}

function requireStringArray(obj: Record<string, unknown>, field: string): string[] {
  const value = obj[field];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`config inválida: campo '${field}' deve ser uma lista de strings`);
  }
  return value as string[];
}

/**
 * Carrega o config JSON do consumer.
 * Caminho: argumento explícito, env HTTPCODER_CONSUMER_CONFIG ou ./consumer.config.json.
 */
export function loadConfig(configPath?: string): ConsumerConfig {
  const file = configPath ?? process.env.HTTPCODER_CONSUMER_CONFIG ?? './consumer.config.json';
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`não foi possível ler o arquivo de config: ${file}`);
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`arquivo de config não é JSON válido: ${file}`);
  }

  const config: ConsumerConfig = {
    serverUrl: requireString(obj, 'serverUrl'),
    roomCode: requireString(obj, 'roomCode'),
    guiPort: typeof obj.guiPort === 'number' ? obj.guiPort : 4173,
    allowedPaths: requireStringArray(obj, 'allowedPaths'),
    allowedCommands: requireStringArray(obj, 'allowedCommands'),
  };
  if (typeof obj.fingerprintPin === 'string') config.fingerprintPin = obj.fingerprintPin;
  if (typeof obj.commandTimeoutMs === 'number') config.commandTimeoutMs = obj.commandTimeoutMs;
  return config;
}
