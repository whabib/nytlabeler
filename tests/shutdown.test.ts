import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { installShutdownHandlers } from '../src/shutdown.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const originalConsole = { log: console.log, warn: console.warn, error: console.error };
before(() => {
  console.log = console.warn = console.error = () => {};
});
after(() => {
  Object.assign(console, originalConsole);
});

describe('installShutdownHandlers', () => {
  test('on SIGTERM, hands leadership over and then exits', async () => {
    const signals = new EventEmitter();
    const events: string[] = [];
    installShutdownHandlers({
      signals,
      resign: async () => {
        events.push('resigning');
        await wait(20);
        events.push('resigned');
      },
      exit: (code) => events.push(`exit ${code}`),
    });
    signals.emit('SIGTERM');
    await wait(50);
    assert.deepStrictEqual(events, ['resigning', 'resigned', 'exit 0']);
  });

  test('handles SIGINT the same way, and only shuts down once', async () => {
    const signals = new EventEmitter();
    let resigns = 0;
    const exits: number[] = [];
    installShutdownHandlers({
      signals,
      resign: async () => {
        resigns++;
        await wait(20);
      },
      exit: (code) => exits.push(code),
    });
    signals.emit('SIGINT');
    signals.emit('SIGTERM');
    await wait(50);
    assert.strictEqual(resigns, 1);
    assert.deepStrictEqual(exits, [0]);
  });

  test('exits even if the handover fails', async () => {
    const signals = new EventEmitter();
    const exits: number[] = [];
    installShutdownHandlers({
      signals,
      resign: async () => {
        throw new Error('database unreachable');
      },
      exit: (code) => exits.push(code),
    });
    signals.emit('SIGTERM');
    await wait(20);
    assert.deepStrictEqual(exits, [0]);
  });

  test('exits after the timeout if the handover hangs', async () => {
    const signals = new EventEmitter();
    const exits: number[] = [];
    installShutdownHandlers({
      signals,
      resign: () => new Promise(() => {}),
      exit: (code) => exits.push(code),
      timeoutMs: 30,
    });
    signals.emit('SIGTERM');
    await wait(10);
    assert.deepStrictEqual(exits, [], 'Still waiting for the handover');
    await wait(50);
    assert.deepStrictEqual(exits, [0]);
  });
});
