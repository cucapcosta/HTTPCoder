import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

// Tipos das mensagens trocadas com o gui-server local (WS em JSON)
type GuiInbound =
  | { type: 'status'; state: string; fingerprint?: string }
  | { type: 'token'; id: string; text: string }
  | { type: 'final'; id: string; text: string }
  | { type: 'models'; models: string[] }
  | { type: 'permission-request'; requestId: string; tool: string; target: string; args: Record<string, unknown>; diff?: { before: string; after: string } }
  | { type: 'tool-result'; callId: string; name: string; ok: boolean; output: string }
  | { type: 'fingerprint-confirm'; fingerprint: string }
  | { type: 'fingerprint-mismatch'; expected: string; actual: string }
  | { type: 'error'; message: string };

interface ChatMessage {
  key: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  streaming?: boolean;
}

interface PermissionCard {
  requestId: string;
  tool: string;
  target: string;
  args: Record<string, unknown>;
  diff?: { before: string; after: string };
}

const TOOL_LABEL: Record<string, string> = {
  read_file: 'Ler arquivo',
  write_file: 'Escrever arquivo',
  list_dir: 'Listar diretório',
  run_command: 'Executar comando',
};

function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [cards, setCards] = useState<PermissionCard[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [status, setStatus] = useState('disconnected');
  const [fp, setFp] = useState<string | undefined>();
  const [fpConfirm, setFpConfirm] = useState<string | undefined>();
  const [alert, setAlert] = useState('');
  const [input, setInput] = useState('');
  const wsRef = useRef<WebSocket | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const ws = new WebSocket(`ws://${location.host}`);
    wsRef.current = ws;
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as GuiInbound;
      switch (msg.type) {
        case 'status':
          setStatus(msg.state);
          setFp(msg.fingerprint);
          break;
        case 'token':
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.key === msg.id && m.role === 'assistant');
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = { ...next[idx]!, text: next[idx]!.text + msg.text, streaming: true };
              return next;
            }
            return [...prev, { key: msg.id, role: 'assistant', text: msg.text, streaming: true }];
          });
          break;
        case 'final':
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.key === msg.id && m.role === 'assistant');
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = { ...next[idx]!, text: msg.text || next[idx]!.text, streaming: false };
              return next;
            }
            return [...prev, { key: msg.id, role: 'assistant', text: msg.text }];
          });
          break;
        case 'models':
          setModels(msg.models);
          break;
        case 'permission-request':
          setCards((prev) => [...prev, msg]);
          break;
        case 'fingerprint-confirm':
          setFpConfirm(msg.fingerprint);
          break;
        case 'tool-result':
          setMessages((prev) => [
            ...prev,
            {
              key: `tool-${msg.callId}`,
              role: 'tool',
              text: `${msg.ok ? '✓' : '✗'} ${msg.name}: ${msg.output.slice(0, 500)}`,
            },
          ]);
          break;
        case 'fingerprint-mismatch':
          setAlert(`Fingerprint mudou! pin=${msg.expected} atual=${msg.actual}. Conexão abortada.`);
          break;
        case 'error':
          setAlert(msg.message);
          break;
      }
    };
    return () => ws.close();
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo(0, listRef.current.scrollHeight);
  }, [messages, cards]);

  const send = (msg: unknown) => wsRef.current?.send(JSON.stringify(msg));

  const decide = (card: PermissionCard, decision: 'once' | 'always' | 'deny') => {
    send({ type: 'permission-result', requestId: card.requestId, decision });
    setCards((prev) => prev.filter((c) => c.requestId !== card.requestId));
  };

  const decideFingerprint = (decision: 'confirm' | 'abort') => {
    send({ type: 'fingerprint-result', decision });
    setFpConfirm(undefined);
    if (decision === 'abort') setAlert('Conexão abortada pelo usuário (fingerprint não confirmado).');
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || status !== 'ready') return;
    send({ type: 'prompt', text, model });
    setMessages((prev) => [...prev, { key: `user-${Date.now()}`, role: 'user', text }]);
    setInput('');
  };

  const ready = status === 'ready';

  return (
    <>
      <header>
        <h1>HTTPCoder</h1>
        <span id="status" className={ready ? 'connected' : ''}>
          <span className="dot" />
          {ready ? 'conectado ao host' : status}
        </span>
        {fp && <span id="fingerprint">{fp}</span>}
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">modelo padrão do host</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </header>
      {alert && <div id="banner" style={{ display: 'block' }}>{alert}</div>}
      <div id="messages" ref={listRef}>
        {fpConfirm && (
          <div className="perm">
            <h3>Confirmar fingerprint do host</h3>
            <div className="target">Confirme que o host exibe o MESMO fingerprint:</div>
            <pre className="target" style={{ fontSize: 16, letterSpacing: 1 }}>{fpConfirm}</pre>
            <div className="actions">
              <button className="once" onClick={() => decideFingerprint('confirm')}>
                Confirmar
              </button>
              <button className="deny" onClick={() => decideFingerprint('abort')}>
                Abortar
              </button>
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.key} className={`msg ${m.role}`}>
            {m.text}
            {m.streaming ? '▌' : ''}
          </div>
        ))}
        {cards.map((c) => (
          <div key={c.requestId} className="perm">
            <h3>{TOOL_LABEL[c.tool] ?? c.tool}</h3>
            <div className="target">{c.target}</div>
            {c.tool === 'run_command' && <pre className="target">{String(c.args.command)}</pre>}
            {c.diff && (
              <div className="diff">
                <pre>{c.diff.before || '(arquivo novo / vazio)'}</pre>
                <pre>{c.diff.after}</pre>
              </div>
            )}
            <div className="actions">
              <button className="once" onClick={() => decide(c, 'once')}>
                Permitir uma vez
              </button>
              <button onClick={() => decide(c, 'always')}>Sempre permitir</button>
              <button className="deny" onClick={() => decide(c, 'deny')}>
                Negar
              </button>
            </div>
          </div>
        ))}
      </div>
      <form onSubmit={submit}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={ready ? 'Envie um prompt ao host…' : 'aguardando conexão com o host…'}
          disabled={!ready}
        />
        <button type="submit" disabled={!ready}>
          Enviar
        </button>
      </form>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
