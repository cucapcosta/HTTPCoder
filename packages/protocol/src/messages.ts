export type Role = 'host' | 'consumer';

// --- Mensagens do relay (texto claro; o servidor as vê para rotear) ---

export interface HelloMessage {
  type: 'hello';
  role: Role;
  /** hashRoom(roomCode) — nunca o código em texto claro */
  room: string;
}
export interface HandshakeMessage {
  type: 'handshake';
  role: Role;
  /** chave pública X25519 (DER/SPKI) em base64 */
  publicKey: string;
}
export interface FrameMessage {
  type: 'frame';
  /** encrypt() em base64 */
  data: string;
}
export interface ErrorMessage {
  type: 'error';
  message: string;
}
export interface PeerEventMessage {
  type: 'peer-connected' | 'peer-disconnected';
  role: Role;
}

export type RelayMessage =
  | HelloMessage
  | HandshakeMessage
  | FrameMessage
  | ErrorMessage
  | PeerEventMessage;

// --- Mensagens de aplicação (viajam criptografadas dentro de FrameMessage) ---

export interface PromptMessage {
  type: 'prompt';
  id: string;
  text: string;
  model?: string;
}
export interface TokenMessage {
  type: 'token';
  id: string;
  text: string;
}
export interface ToolCallMessage {
  type: 'tool-call';
  id: string;
  callId: string;
  name: string;
  args: Record<string, unknown>;
}
export interface ToolResultMessage {
  type: 'tool-result';
  id: string;
  callId: string;
  ok: boolean;
  output: string;
}
export interface FinalMessage {
  type: 'final';
  id: string;
  text: string;
}
export interface ModelListRequestMessage {
  type: 'model-list-request';
}
export interface ModelListMessage {
  type: 'model-list';
  models: string[];
}
export interface AppErrorMessage {
  type: 'app-error';
  id?: string;
  message: string;
}

export type AppMessage =
  | PromptMessage
  | TokenMessage
  | ToolCallMessage
  | ToolResultMessage
  | FinalMessage
  | ModelListRequestMessage
  | ModelListMessage
  | AppErrorMessage;

export function serialize(msg: RelayMessage | AppMessage): string {
  return JSON.stringify(msg);
}

type Raw = Record<string, unknown>;

function asObject(value: unknown): Raw {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('mensagem não é um objeto');
  }
  return value as Raw;
}

function requireString(obj: Raw, field: string): void {
  if (typeof obj[field] !== 'string') throw new Error(`campo '${field}' ausente ou inválido`);
}

function requireRole(obj: Raw): void {
  if (obj.role !== 'host' && obj.role !== 'consumer') {
    throw new Error("campo 'role' deve ser 'host' ou 'consumer'");
  }
}

export function parseRelayMessage(raw: string): RelayMessage {
  const obj = asObject(JSON.parse(raw));
  switch (obj.type) {
    case 'hello':
      requireRole(obj);
      requireString(obj, 'room');
      break;
    case 'handshake':
      requireRole(obj);
      requireString(obj, 'publicKey');
      break;
    case 'frame':
      requireString(obj, 'data');
      break;
    case 'error':
      requireString(obj, 'message');
      break;
    case 'peer-connected':
    case 'peer-disconnected':
      requireRole(obj);
      break;
    default:
      throw new Error(`tipo de mensagem de relay desconhecido: ${String(obj.type)}`);
  }
  return obj as unknown as RelayMessage;
}

export function parseAppMessage(raw: string): AppMessage {
  const obj = asObject(JSON.parse(raw));
  switch (obj.type) {
    case 'prompt':
      requireString(obj, 'id');
      requireString(obj, 'text');
      break;
    case 'token':
    case 'final':
      requireString(obj, 'id');
      requireString(obj, 'text');
      break;
    case 'tool-call':
      requireString(obj, 'id');
      requireString(obj, 'callId');
      requireString(obj, 'name');
      asObject(obj.args);
      break;
    case 'tool-result':
      requireString(obj, 'id');
      requireString(obj, 'callId');
      requireString(obj, 'output');
      if (typeof obj.ok !== 'boolean') throw new Error("campo 'ok' deve ser booleano");
      break;
    case 'model-list-request':
      break;
    case 'model-list':
      if (!Array.isArray(obj.models) || obj.models.some((m) => typeof m !== 'string')) {
        throw new Error("campo 'models' deve ser uma lista de strings");
      }
      break;
    case 'app-error':
      requireString(obj, 'message');
      break;
    default:
      throw new Error(`tipo de mensagem de aplicação desconhecido: ${String(obj.type)}`);
  }
  return obj as unknown as AppMessage;
}
