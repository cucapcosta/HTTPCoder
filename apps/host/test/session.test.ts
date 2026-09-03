import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateIdentity, type AppMessage } from '@httpcoder/protocol';
import { HostSession } from '../src/session.js';
import { FakeRelayConsumer, ROOM } from './fake-relay.js';

function makeSession(
  url: string,
  overrides: Partial<ConstructorParameters<typeof HostSession>[0]> = {},
  onMessage: (msg: AppMessage) => void = () => {},
): HostSession {
  return new HostSession(
    { serverUrl: url, roomCode: ROOM, ...overrides },
    { onMessage },
  );
}

let fake: FakeRelayConsumer;
let url: string;
let sessions: HostSession[];

beforeEach(async () => {
  fake = new FakeRelayConsumer();
  url = await fake.start();
  sessions = [];
});

afterEach(async () => {
  for (const s of sessions) s.close();
  await fake.stop();
});

function track(session: HostSession): HostSession {
  sessions.push(session);
  return session;
}

describe('HostSession', () => {
  it('completa o handshake e troca AppMessages criptografadas nos dois sentidos', async () => {
    const incoming: AppMessage[] = [];
    const session = track(
      makeSession(url, { confirmFingerprint: async () => true }, (m) => incoming.push(m)),
    );

    const fp = await session.connect();
    expect(fp).toMatch(/^([0-9A-F]{4} ){3}[0-9A-F]{4}$/);
    await fake.waitForKey();

    // host → consumer
    session.send({ type: 'token', id: 'p1', text: 'olá' });
    const got = await fake.nextAppMessage((m) => m.type === 'token');
    expect(got).toEqual({ type: 'token', id: 'p1', text: 'olá' });

    // consumer → host
    fake.sendApp({ type: 'prompt', id: 'p1', text: 'resuma o arquivo' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(incoming).toEqual([{ type: 'prompt', id: 'p1', text: 'resuma o arquivo' }]);
  });

  it('aborta ruidosamente quando fingerprintPin diverge do calculado', async () => {
    const session = track(
      makeSession(url, { fingerprintPin: '0000 0000 0000 0000' }),
    );
    await expect(session.connect()).rejects.toThrow(/fingerprint/i);
  });

  it('sem pin: pede confirmação, salva o pin e estabelece a sessão', async () => {
    let shownFp = '';
    let savedPin = '';
    const session = track(
      makeSession(url, {
        confirmFingerprint: async (fp) => {
          shownFp = fp;
          return true;
        },
        savePin: (pin) => {
          savedPin = pin;
        },
      }),
    );
    const fp = await session.connect();
    expect(shownFp).toBe(fp);
    expect(savedPin).toBe(fp);
    await fake.waitForKey();
  });

  it('sem pin e confirmação negada: aborta sem salvar', async () => {
    let savedPin = '';
    const session = track(
      makeSession(url, {
        confirmFingerprint: async () => false,
        savePin: (pin) => {
          savedPin = pin;
        },
      }),
    );
    await expect(session.connect()).rejects.toThrow(/fingerprint|confirm/i);
    expect(savedPin).toBe('');
  });

  it('com pin correto, conecta sem pedir confirmação', async () => {
    const identity = generateIdentity();
    let savedPin = '';
    const first = track(
      makeSession(url, {
        identity,
        confirmFingerprint: async () => true,
        savePin: (pin) => {
          savedPin = pin;
        },
      }),
    );
    await first.connect();
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = track(
      makeSession(url, {
        identity,
        fingerprintPin: savedPin,
        confirmFingerprint: async () => {
          throw new Error('não deveria pedir confirmação com pin correto');
        },
      }),
    );
    await expect(second.connect()).resolves.toBe(savedPin);
  });

  it('reconecta com backoff injetado após queda da conexão', async () => {
    const sleeps: number[] = [];
    const established: string[] = [];
    const session = track(
      new HostSession(
        {
          serverUrl: url,
          roomCode: ROOM,
          identity: generateIdentity(),
          confirmFingerprint: async () => true,
          savePin: () => {},
          backoffDelays: [5, 10, 20],
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        },
        { onMessage: () => {}, onEstablished: (fp) => established.push(fp) },
      ),
    );
    await session.connect();
    expect(fake.connections).toBe(1);

    fake.dropHost();
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (established.length === 2) {
          clearInterval(timer);
          resolve();
        }
      }, 5);
    });
    expect(fake.connections).toBe(2);
    expect(sleeps[0]).toBe(5);

    // sessão volta a funcionar na nova conexão
    session.send({ type: 'token', id: 'p2', text: 'voltei' });
    const got = await fake.nextAppMessage((m) => m.type === 'token' && m.id === 'p2');
    expect(got).toEqual({ type: 'token', id: 'p2', text: 'voltei' });
  });

  it('envia o handshake imediatamente, sem esperar a confirmação do fingerprint', async () => {
    let resolveConfirm!: (ok: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      resolveConfirm = resolve;
    });
    const session = track(makeSession(url, { confirmFingerprint: () => pending }));

    const connectP = session.connect();
    // O consumer derivou a session key => o handshake do host saiu sem confirm resolvido.
    await fake.waitForKey();

    let settled = false;
    void connectP.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);

    resolveConfirm(true);
    await connectP;
  });

  it('não envia frames de aplicação antes da confirmação; após confirmar, fluem', async () => {
    let resolveConfirm!: (ok: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      resolveConfirm = resolve;
    });
    const logs: string[] = [];
    const session = track(
      new HostSession(
        { serverUrl: url, roomCode: ROOM, confirmFingerprint: () => pending },
        { onMessage: () => {}, onLog: (m) => logs.push(m) },
      ),
    );

    const connectP = session.connect();
    await fake.waitForKey(); // handshake já saiu, confirmação pendente

    session.send({ type: 'token', id: 'x', text: 'cedo demais' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.received).toEqual([]);
    expect(logs.some((l) => /confirma/i.test(l))).toBe(true);

    resolveConfirm(true);
    await connectP;
    session.send({ type: 'token', id: 'x', text: 'agora vai' });
    const got = await fake.nextAppMessage((m) => m.type === 'token');
    expect(got).toEqual({ type: 'token', id: 'x', text: 'agora vai' });
  });

  it('descarta com log frames recebidos antes da confirmação', async () => {
    let resolveConfirm!: (ok: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      resolveConfirm = resolve;
    });
    const logs: string[] = [];
    const incoming: AppMessage[] = [];
    const session = track(
      new HostSession(
        { serverUrl: url, roomCode: ROOM, confirmFingerprint: () => pending },
        { onMessage: (m) => incoming.push(m), onLog: (m) => logs.push(m) },
      ),
    );

    const connectP = session.connect();
    await fake.waitForKey();

    fake.sendApp({ type: 'prompt', id: 'p1', text: 'antes da confirmação' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(incoming).toEqual([]);
    expect(logs.some((l) => /descart|ignor/i.test(l))).toBe(true);

    resolveConfirm(true);
    await connectP;

    fake.sendApp({ type: 'prompt', id: 'p2', text: 'depois da confirmação' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(incoming).toEqual([{ type: 'prompt', id: 'p2', text: 'depois da confirmação' }]);
  });

  it('confirmação negada: fecha a conexão e nada mais sai', async () => {
    const session = track(
      makeSession(url, { confirmFingerprint: async () => false }),
    );
    await expect(session.connect()).rejects.toThrow(/fingerprint|confirm/i);

    // aguarda o fechamento propagar até o relay
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (fake.activeConnections === 0) {
          clearInterval(timer);
          resolve();
        }
      }, 5);
    });

    expect(() => session.send({ type: 'token', id: 'x', text: 'não sai' })).toThrow();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.received).toEqual([]);
  });

  it('send antes do handshake lança erro', () => {
    const session = track(makeSession(url));
    expect(() => session.send({ type: 'token', id: 'x', text: 'y' })).toThrow();
  });
});
