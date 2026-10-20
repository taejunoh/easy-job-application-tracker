import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import * as safety from './diagnostic-safety.mjs';

test('environment inventory accepts only terminal empty responses', () => {
  assert.equal(typeof safety.assertEmptyEnvironmentInventory, 'function');
  assert.doesNotThrow(() => safety.assertEmptyEnvironmentInventory(
    { envs: [] }, { data: [], pagination: { count: 0, next: null, prev: null } },
  ));
  for (const shared of [
    { data: [] }, { data: [], pagination: null }, { data: [], pagination: [] },
    { data: [], pagination: { count: 0, next: null } },
    { data: [], pagination: { count: 0, next: false, prev: null } },
    { data: [], pagination: { count: 1, next: null, prev: null } },
  ]) assert.throws(() => safety.assertEmptyEnvironmentInventory({ envs: [] }, shared), { code: 'ISOLATION' });
  for (const project of [{ envs: [], pagination: {} }, { envs: [{}] }]) {
    assert.throws(() => safety.assertEmptyEnvironmentInventory(project, { data: [], pagination: { count: 0, next: null, prev: null } }), { code: 'ISOLATION' });
  }
});

function fakeTimers() {
  const callbacks = new Map();
  let id = 0;
  return {
    active: callbacks,
    setTimeout(fn) { callbacks.set(++id, fn); return id; },
    setInterval(fn) { callbacks.set(++id, fn); return id; },
    clearTimeout(key) { callbacks.delete(key); },
    clearInterval(key) { callbacks.delete(key); },
    fire(key) { callbacks.get(key)?.(); },
  };
}

test('capture wait converts asynchronous sink failure to one safe rejection and cleanup', async () => {
  const timers = fakeTimers();
  let failOutput;
  let pauseSignal;
  let cleanup = 0;
  const pending = safety.waitForCapture({
    timers,
    emit() {},
    onFailure(listener) { failOutput = listener; return () => {}; },
    pause({ signal }) { pauseSignal = signal; return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); },
  }).finally(() => { cleanup++; });
  await Promise.resolve();
  failOutput();
  await assert.rejects(pending, error => error.code === 'CAPTURE' && error.message === 'CAPTURE');
  assert.equal(pauseSignal.aborted, true);
  assert.equal(cleanup, 1);
  assert.equal(timers.active.size, 0);
});

test('queued cancellation never starts pause or leaves timers/listeners behind', async () => {
  const timers = fakeTimers();
  let started = 0;
  let detached = 0;
  const pending = safety.waitForCapture({ timers, emit() {},
    onFailure(listener) { queueMicrotask(listener); return () => { detached++; }; },
    pause() { started++; return new Promise(() => {}); },
  });
  await assert.rejects(pending, { code: 'CAPTURE' });
  await Promise.resolve();
  assert.equal(started, 0);
  assert.equal(detached, 1);
  assert.equal(timers.active.size, 0);
});

test('capture output-failure registration errors reject safely and clear timers', async () => {
  const timers = fakeTimers();
  let started = 0;
  const pending = safety.waitForCapture({ timers, emit() {},
    onFailure() { throw new Error('private registration fault'); },
    pause() { started++; return Promise.resolve(); },
  });
  let caught;
  try { await pending; } catch (error) { caught = error; }
  assert.equal(caught?.code, 'CAPTURE');
  assert.equal(caught?.message, 'CAPTURE');
  assert.equal(timers.active.size, 0);
  assert.equal(started, 0);
});

test('sticky output converts sync and async stream errors into a safe boundary', async () => {
  const failure = new Error('private raw stream error');
  const stream = new Writable({ write(_chunk, _encoding, callback) { callback(failure); } });
  const output = safety.createStickyOutput(stream);
  let notifications = 0;
  output.onFailure(() => { notifications++; });
  output('safe line');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(notifications, 1);
  assert.throws(() => output('later line'), error => error.code === 'CAPTURE' && !error.message.includes('private'));

  const syncOutput = safety.createStickyOutput({ on() { return this; }, write() { throw failure; } });
  assert.throws(() => syncOutput('safe line'), { code: 'CAPTURE' });
  assert.throws(() => syncOutput('later line'), { code: 'CAPTURE' });
});

test('pre-aborted pause installs no input work or timer', async () => {
  const controller = new AbortController();
  controller.abort();
  const input = new EventEmitter();
  let resumed = 0;
  let paused = 0;
  let timerCount = 0;
  input.resume = () => { resumed++; };
  input.pause = () => { paused++; };
  const pending = safety.pauseForInput({ timeoutMs: 1000, signal: controller.signal, input,
    timers: { setTimeout() { timerCount++; return 1; }, clearTimeout() { timerCount--; } },
  });
  assert.deepEqual(input.eventNames(), []);
  assert.equal(resumed, 0);
  assert.equal(paused, 0);
  assert.equal(timerCount, 0);
  await assert.rejects(pending, { code: 'CAPTURE' });
});

test('input error rejects safely and removes every listener and timer', async () => {
  const controller = new AbortController();
  const timers = fakeTimers();
  const input = new EventEmitter();
  let resumed = 0;
  let paused = 0;
  input.resume = () => { resumed++; };
  input.pause = () => { paused++; };
  const pending = safety.pauseForInput({ timeoutMs: 1000, signal: controller.signal, input, timers });
  await Promise.resolve();
  const rejection = assert.rejects(pending, error => error.code === 'CAPTURE' && error.message === 'CAPTURE');
  assert.doesNotThrow(() => input.emit('error', new Error('private input error')));
  await rejection;
  assert.equal(resumed, 1);
  assert.equal(paused, 1);
  assert.deepEqual(input.eventNames(), []);
  assert.equal(timers.active.size, 0);
});
