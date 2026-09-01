import { describe, expect, it } from 'vitest';
import {
  decrypt,
  deriveSessionKey,
  encrypt,
  fingerprint,
  generateIdentity,
  hashRoom,
} from '../src/crypto.js';

describe('crypto', () => {
  it('deriva a mesma chave de sessão nos dois lados do handshake X25519', () => {
    const host = generateIdentity();
    const consumer = generateIdentity();

    const keyHost = deriveSessionKey(host.privateKey, consumer.publicKey);
    const keyConsumer = deriveSessionKey(consumer.privateKey, host.publicKey);

    expect(keyHost.equals(keyConsumer)).toBe(true);
    expect(keyHost.length).toBe(32);
  });

  it('gera chaves de sessão diferentes para pares de identidade diferentes', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const c = generateIdentity();

    const keyAB = deriveSessionKey(a.privateKey, b.publicKey);
    const keyAC = deriveSessionKey(a.privateKey, c.publicKey);

    expect(keyAB.equals(keyAC)).toBe(false);
  });

  it('faz round-trip encrypt/decrypt com AES-256-GCM', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const key = deriveSessionKey(a.privateKey, b.publicKey);

    const plaintext = Buffer.from('olá, mundo criptografado', 'utf8');
    const frame = encrypt(key, plaintext);

    expect(frame.equals(plaintext)).toBe(false);
    expect(decrypt(key, frame).toString('utf8')).toBe('olá, mundo criptografado');
  });

  it('rejeita descriptografia com a chave errada', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const c = generateIdentity();
    const keyAB = deriveSessionKey(a.privateKey, b.publicKey);
    const keyAC = deriveSessionKey(a.privateKey, c.publicKey);

    const frame = encrypt(keyAB, Buffer.from('segredo'));

    expect(() => decrypt(keyAC, frame)).toThrow();
  });

  it('rejeita frame adulterado (tag GCM inválida)', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const key = deriveSessionKey(a.privateKey, b.publicKey);

    const frame = encrypt(key, Buffer.from('segredo'));
    frame[frame.length - 1] ^= 0xff;

    expect(() => decrypt(key, frame)).toThrow();
  });

  it('fingerprint é estável e independe da ordem das chaves', () => {
    const host = generateIdentity();
    const consumer = generateIdentity();

    const f1 = fingerprint(host.publicKey, consumer.publicKey, 'sala-x');
    const f2 = fingerprint(consumer.publicKey, host.publicKey, 'sala-x');

    expect(f1).toBe(f2);
    expect(f1).toMatch(/^([0-9A-F]{4} ){3}[0-9A-F]{4}$/);
  });

  it('fingerprint muda com outro código de sala', () => {
    const host = generateIdentity();
    const consumer = generateIdentity();

    expect(fingerprint(host.publicKey, consumer.publicKey, 'sala-x')).not.toBe(
      fingerprint(host.publicKey, consumer.publicKey, 'sala-y'),
    );
  });

  it('hashRoom é determinístico e distingue códigos', () => {
    expect(hashRoom('sala-x')).toBe(hashRoom('sala-x'));
    expect(hashRoom('sala-x')).not.toBe(hashRoom('sala-y'));
    expect(hashRoom('sala-x')).toMatch(/^[0-9a-f]{64}$/);
  });
});
