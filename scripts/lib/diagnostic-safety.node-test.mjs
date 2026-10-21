import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { readFileSync } from 'node:fs';
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

// --- hardening tests ---------------------------------------------------------

const isSafe = code => error => error instanceof safety.DiagnosticSafetyError && error.code === code && error.message === code;
const goodShared = () => ({ data: [], pagination: { count: 0, next: null, prev: null } });

// Resolves to 'pending' | 'resolved' | <error code> after one macrotask, without hanging on a stuck promise.
async function outcome(promise) {
  let state = 'pending';
  promise.then(() => { state = 'resolved'; }, error => { state = error?.code ?? 'rejected'; });
  await new Promise(resolve => setImmediate(resolve));
  return state;
}

function spyTimers() {
  const timers = fakeTimers();
  timers.installs = 0;
  for (const name of ['setTimeout', 'setInterval']) {
    const original = timers[name];
    timers[name] = fn => { timers.installs++; return original(fn); };
  }
  return timers;
}

function makeInput(overrides = {}) {
  const input = new EventEmitter();
  input.resumes = 0;
  input.pauses = 0;
  input.resume = () => { input.resumes++; };
  input.pause = () => { input.pauses++; };
  return Object.assign(input, overrides);
}

function startPause(options = {}) {
  const input = options.input ?? makeInput();
  const timers = options.timers ?? spyTimers();
  const pending = safety.pauseForInput({ timeoutMs: 1000, ...options, input, timers });
  return { input, timers, pending };
}

function assertClean(input, timers) {
  assert.deepEqual(input.eventNames(), []);
  assert.equal(timers.active.size, 0);
}

test('DiagnosticSafetyError collapses unknown codes to SCHEMA', () => {
  const error = new safety.DiagnosticSafetyError('BOGUS');
  assert.equal(error.code, 'SCHEMA');
  assert.equal(error.message, 'SCHEMA');
  assert.equal(new safety.DiagnosticSafetyError('ISOLATION').code, 'ISOLATION');
});

// ---- pauseForInput ----

test('pause resolves on a newline in a string chunk', async () => {
  const { input, pending } = startPause();
  input.emit('data', 'ok\n');
  assert.equal(await outcome(pending), 'resolved');
});

test('pause does not treat the text "10" as a newline', async () => {
  const { input, timers, pending } = startPause();
  input.emit('data', '10');
  assert.equal(await outcome(pending), 'pending');
  timers.fire(1);
  await assert.rejects(pending, isSafe('CAPTURE'));
  assertClean(input, timers);
});

test('pause resolves on a carriage return in a Buffer or Uint8Array chunk', async () => {
  for (const chunk of [Buffer.from('ok\r'), Buffer.from('ok\n'), new Uint8Array([97, 13]), 'ok\r']) {
    const { input, pending } = startPause();
    input.emit('data', chunk);
    assert.equal(await outcome(pending), 'resolved');
  }
});

test('pause ignores byte chunks without a line break', async () => {
  const { input, timers, pending } = startPause();
  input.emit('data', Buffer.from('abc'));
  assert.equal(await outcome(pending), 'pending');
  timers.fire(1);
  await assert.rejects(pending, isSafe('CAPTURE'));
});

test('pause rejects CAPTURE on an unsupported chunk type', async () => {
  for (const chunk of [{}, 10, null, undefined]) {
    const { input, timers, pending } = startPause();
    input.emit('data', chunk);
    await assert.rejects(pending, isSafe('CAPTURE'));
    assertClean(input, timers);
  }
});

test('pause rejects invalid timeoutMs with SCHEMA and installs nothing', async () => {
  for (const timeoutMs of [undefined, null, 0, -1, NaN, Infinity, '5', 2 ** 31]) {
    const input = makeInput();
    const timers = spyTimers();
    await assert.rejects(safety.pauseForInput({ timeoutMs, input, timers }), isSafe('SCHEMA'));
    assert.deepEqual(input.eventNames(), []);
    assert.equal(timers.installs, 0);
    assert.equal(input.resumes, 0);
  }
  for (const timeoutMs of [2 ** 31 - 1, 0.1 * 3 * 1000, 1.5]) {
    const { input, pending } = startPause({ timeoutMs });
    input.emit('data', '\n');
    assert.equal(await outcome(pending), 'resolved');
  }
});

test('pause rejects malformed arguments with SCHEMA and installs nothing', async () => {
  const input = makeInput();
  const noPause = { on() {}, once() {}, removeListener() {}, resume() {} };
  const cases = [
    undefined, null, 'x', [], {},
    { timeoutMs: 1 },
    { timeoutMs: 1, input: null },
    { timeoutMs: 1, input: noPause },
    { timeoutMs: 1, input, signal: { aborted: false } },
    { timeoutMs: 1, input, signal: Object.create(AbortSignal.prototype) },
    { timeoutMs: 1, input, timers: { setTimeout() {} } },
    { timeoutMs: 1, input, timers: 'x' },
    { get timeoutMs() { throw new Error('private getter'); }, input },
  ];
  for (const options of cases) {
    await assert.rejects(safety.pauseForInput(options), isSafe('SCHEMA'));
  }
  assert.deepEqual(input.eventNames(), []);
  assert.equal(input.resumes, 0);
});

test('pause treats a null signal as no signal', async () => {
  const { input, pending } = startPause({ signal: null });
  input.emit('data', '\n');
  assert.equal(await outcome(pending), 'resolved');
});

test('pause validates before the abort check', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(safety.pauseForInput({ timeoutMs: 0, input: makeInput(), signal: controller.signal }), isSafe('SCHEMA'));
});

test('pause fails fast on ended or destroyed input without installing anything', async () => {
  for (const [flag, value] of [['readableEnded', true], ['destroyed', true], ['errored', new Error('private stream fault')]]) {
    const input = makeInput({ [flag]: value });
    const timers = spyTimers();
    await assert.rejects(safety.pauseForInput({ timeoutMs: 1000, input, timers }), isSafe('CAPTURE'));
    assert.deepEqual(input.eventNames(), []);
    assert.equal(timers.installs, 0);
    assert.equal(input.resumes, 0);
    assert.equal(input.pauses, 0);
  }
});

test('pause setup failure rejects CAPTURE without raw errors or leaked listeners', async () => {
  const input = makeInput({ resume() { throw new TypeError('private resume fault'); } });
  const timers = spyTimers();
  await assert.rejects(safety.pauseForInput({ timeoutMs: 1000, input, timers }), isSafe('CAPTURE'));
  assertClean(input, timers);

  const controller = new AbortController();
  const input2 = makeInput();
  const timers2 = spyTimers();
  timers2.setTimeout = () => { throw new Error('private timer fault'); };
  await assert.rejects(safety.pauseForInput({ timeoutMs: 1000, input: input2, signal: controller.signal, timers: timers2 }), isSafe('CAPTURE'));
  assertClean(input2, timers2);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('pause stops installing when an injected timer fires synchronously', async () => {
  const input = makeInput();
  const timers = spyTimers();
  const original = timers.setTimeout;
  timers.setTimeout = fn => { const id = original(fn); fn(); return id; };
  await assert.rejects(safety.pauseForInput({ timeoutMs: 1000, input, timers }), isSafe('CAPTURE'));
  assertClean(input, timers);
  assert.equal(input.resumes, 0);
});

test('pause still settles when cleanup steps throw', async () => {
  const { input, pending } = startPause({ input: makeInput({ pause() { throw new Error('private pause fault'); } }) });
  input.emit('data', '\n');
  assert.equal(await outcome(pending), 'resolved');
  assert.deepEqual(input.eventNames(), []);

  const timers = spyTimers();
  timers.clearTimeout = () => { throw new Error('private clear fault'); };
  const second = startPause({ timers });
  second.input.emit('data', '\n');
  assert.equal(await outcome(second.pending), 'resolved');
  assert.deepEqual(second.input.eventNames(), []);

  const third = startPause({ timers });
  third.input.emit('end');
  await assert.rejects(third.pending, isSafe('CAPTURE'));
});

test('pause success removes every listener and timer and pauses once', async () => {
  const controller = new AbortController();
  const { input, timers, pending } = startPause({ signal: controller.signal });
  assert.deepEqual(input.eventNames().sort(), ['data', 'end', 'error']);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  input.emit('data', 'go\n');
  await pending;
  assertClean(input, timers);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(input.resumes, 1);
  assert.equal(input.pauses, 1);
});

test('pause end event rejects CAPTURE with cleanup', async () => {
  const { input, timers, pending } = startPause();
  input.emit('end');
  await assert.rejects(pending, isSafe('CAPTURE'));
  assertClean(input, timers);
  assert.equal(input.pauses, 1);
});

test('pause abort mid-wait rejects CAPTURE with cleanup', async () => {
  const controller = new AbortController();
  const { input, timers, pending } = startPause({ signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, isSafe('CAPTURE'));
  assertClean(input, timers);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(input.pauses, 1);
});

test('pause timeout rejects CAPTURE with cleanup', async () => {
  const { input, timers, pending } = startPause();
  assert.equal(timers.active.size, 1);
  timers.fire(1);
  await assert.rejects(pending, isSafe('CAPTURE'));
  assertClean(input, timers);
  assert.equal(input.pauses, 1);
});

// ---- waitForCapture ----

function startCapture(options = {}) {
  const timers = options.timers ?? spyTimers();
  const pending = safety.waitForCapture({ emit() {}, pause: () => new Promise(() => {}), ...options, timers });
  return { timers, pending };
}

test('capture wait rejects malformed arguments with SCHEMA and installs no timers', async () => {
  const pause = () => Promise.resolve();
  const emit = () => {};
  const cases = [
    () => undefined, () => null, () => 'x', () => [],
    () => ({}),
    timers => ({ timers, pause }),
    timers => ({ timers, emit }),
    timers => ({ timers, pause: 1, emit }),
    timers => ({ timers, pause, emit: 'x' }),
    timers => ({ timers, pause, emit, onFailure: 'x' }),
    () => ({ pause, emit, timers: 'x' }),
    () => ({ pause, emit, timers: { setTimeout() {}, clearTimeout() {}, setInterval() {} } }),
    timers => ({ timers, get pause() { throw new Error('private getter'); }, emit }),
  ];
  for (const build of cases) {
    const timers = spyTimers();
    await assert.rejects(safety.waitForCapture(build(timers)), isSafe('SCHEMA'));
    assert.equal(timers.installs, 0);
  }
});

test('capture wait resolves when pause resolves and cleans up once', async () => {
  let unsubscribed = 0;
  let signal;
  const { timers, pending } = startCapture({
    onFailure: () => () => { unsubscribed++; },
    pause: options => { signal = options.signal; return Promise.resolve(); },
  });
  await pending;
  assert.equal(unsubscribed, 1);
  assert.equal(signal.aborted, true);
  assert.equal(timers.active.size, 0);
});

test('capture wait works without onFailure', async () => {
  const { timers, pending } = startCapture({ pause: () => Promise.resolve() });
  await pending;
  assert.equal(timers.active.size, 0);
});

test('capture wait timeout rejects CAPTURE with cleanup', async () => {
  let unsubscribed = 0;
  let signal;
  const { timers, pending } = startCapture({
    onFailure: () => () => { unsubscribed++; },
    pause: options => { signal = options.signal; return new Promise(() => {}); },
  });
  await Promise.resolve();
  timers.fire(1);
  await assert.rejects(pending, isSafe('CAPTURE'));
  assert.equal(unsubscribed, 1);
  assert.equal(signal.aborted, true);
  assert.equal(timers.active.size, 0);
});

test('capture wait hides raw pause rejection and synchronous pause throws', async () => {
  const raw = startCapture({ pause: () => Promise.reject(new Error('private pause error')) });
  await assert.rejects(raw.pending, isSafe('CAPTURE'));
  assert.equal(raw.timers.active.size, 0);

  const sync = startCapture({ pause() { throw new TypeError('private sync pause error'); } });
  await assert.rejects(sync.pending, isSafe('CAPTURE'));
  assert.equal(sync.timers.active.size, 0);
});

test('capture wait onFailure listener called synchronously cancels before pause starts', async () => {
  let started = 0;
  let detached = 0;
  const { timers, pending } = startCapture({
    onFailure(listener) { listener(); return () => { detached++; }; },
    pause() { started++; return new Promise(() => {}); },
  });
  await assert.rejects(pending, isSafe('CAPTURE'));
  await Promise.resolve();
  assert.equal(started, 0);
  assert.equal(detached, 1);
  assert.equal(timers.active.size, 0);
});

test('capture wait still settles when cleanup steps throw', async () => {
  const timers = spyTimers();
  timers.clearTimeout = () => { throw new Error('private clear fault'); };
  const ok = startCapture({ timers, pause: () => Promise.resolve() });
  await ok.pending;
  assert.equal(timers.active.size, 1); // only the timeout whose clear threw remains; interval was still cleared

  const timers2 = spyTimers();
  timers2.clearInterval = () => { throw new Error('private clear fault'); };
  const bad = startCapture({ timers: timers2, pause: () => Promise.reject(new Error('x')), onFailure: () => () => { throw new Error('private off fault'); } });
  await assert.rejects(bad.pending, isSafe('CAPTURE'));
});

test('capture heartbeat emits and contains sync and async emit failures', async () => {
  const seen = [];
  const onUnhandled = reason => seen.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const emitted = [];
    const healthy = startCapture({ emit: line => { emitted.push(line); } });
    healthy.timers.fire(2);
    assert.equal(await outcome(healthy.pending), 'pending');
    assert.deepEqual(emitted, ['capture-wait']);
    healthy.timers.fire(1);
    await assert.rejects(healthy.pending, isSafe('CAPTURE'));

    const sync = startCapture({ emit() { throw new Error('private emit error'); } });
    sync.timers.fire(2);
    assert.equal(await outcome(sync.pending), 'CAPTURE');
    assert.equal(sync.timers.active.size, 0);

    const async = startCapture({ emit: () => Promise.reject(new Error('private async emit error')) });
    async.timers.fire(2);
    assert.equal(await outcome(async.pending), 'CAPTURE');
    assert.equal(async.timers.active.size, 0);
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(seen, []);
});

test('capture setup failures reject CAPTURE and leave no timers', async () => {
  let started = 0;
  const timers = spyTimers();
  timers.setInterval = () => { throw new Error('private interval fault'); };
  const pending = safety.waitForCapture({ timers, emit() {}, pause() { started++; return new Promise(() => {}); } });
  await assert.rejects(pending, isSafe('CAPTURE'));
  assert.equal(timers.active.size, 0);
  assert.equal(started, 0);
});

test('capture setup stops when an injected timer fires synchronously', async () => {
  let started = 0;
  let registered = 0;
  const timers = spyTimers();
  const original = timers.setTimeout;
  timers.setTimeout = fn => { const id = original(fn); fn(); return id; };
  const pending = safety.waitForCapture({ timers, emit() {},
    onFailure() { registered++; return () => {}; },
    pause() { started++; return new Promise(() => {}); },
  });
  await assert.rejects(pending, isSafe('CAPTURE'));
  assert.equal(timers.active.size, 0);
  assert.equal(registered, 0);
  assert.equal(started, 0);
});

// ---- createStickyOutput ----

test('sticky output rejects streams without on and write with SCHEMA', () => {
  for (const stream of [undefined, null, 'x', {}, { on() {} }, { write() {} }, { on: 1, write() {} }]) {
    assert.throws(() => safety.createStickyOutput(stream), isSafe('SCHEMA'));
  }
});

test('sticky output contains a throwing stream.on registration', () => {
  assert.throws(() => safety.createStickyOutput({ on() { throw new Error('private on fault'); }, write() {} }), isSafe('CAPTURE'));
});

test('sticky output rejects non-function failure listeners with SCHEMA', () => {
  const output = safety.createStickyOutput({ on() {}, write() {} });
  for (const listener of [undefined, null, 'x', {}]) assert.throws(() => output.onFailure(listener), isSafe('SCHEMA'));
});

test('sticky output does not notify on successful writes', () => {
  const written = [];
  const output = safety.createStickyOutput({ on() {}, write(line, callback) { written.push(line); callback(); } });
  let notifications = 0;
  output.onFailure(() => { notifications++; });
  output('a');
  output('b');
  assert.deepEqual(written, ['a', 'b']);
  assert.equal(notifications, 0);
});

test('sticky output notifies on a stream error event alone', () => {
  const stream = new EventEmitter();
  stream.write = (_line, callback) => callback();
  const output = safety.createStickyOutput(stream);
  let notifications = 0;
  output.onFailure(() => { notifications++; });
  stream.emit('error', new Error('private stream error'));
  stream.emit('error', new Error('private stream error'));
  assert.equal(notifications, 1);
  assert.throws(() => output('later'), isSafe('CAPTURE'));
});

test('sticky output notifies on a write callback error alone', () => {
  const stream = { on() {}, write(_line, callback) { callback(new Error('private write error')); } };
  const output = safety.createStickyOutput(stream);
  let notifications = 0;
  output.onFailure(() => { notifications++; });
  assert.doesNotThrow(() => output('first'));
  assert.equal(notifications, 1);
  assert.throws(() => output('later'), isSafe('CAPTURE'));
});

test('sticky output guards listeners registered after failure', () => {
  const output = safety.createStickyOutput({ on() {}, write(_line, callback) { callback(new Error('x')); } });
  output('first');
  let called = 0;
  assert.doesNotThrow(() => output.onFailure(() => { called++; throw new Error('private listener fault'); }));
  assert.equal(called, 1);
});

test('sticky output unsubscribe prevents notification and listeners are not retained', () => {
  const stream = new EventEmitter();
  stream.write = () => {};
  const output = safety.createStickyOutput(stream);
  let removed = 0;
  let kept = 0;
  const off = output.onFailure(() => { removed++; });
  output.onFailure(() => { kept++; });
  off();
  stream.emit('error', new Error('x'));
  assert.equal(removed, 0);
  assert.equal(kept, 1);
});

// ---- assertEmptyEnvironmentInventory ----

test('inventory accepts array-form project and rejects malformed inputs', () => {
  assert.doesNotThrow(() => safety.assertEmptyEnvironmentInventory([], goodShared()));
  const reject = (project, shared) => assert.throws(() => safety.assertEmptyEnvironmentInventory(project, shared), isSafe('ISOLATION'));
  reject([{}], goodShared());
  for (const project of [null, undefined, 'x', 1]) reject(project, goodShared());
  for (const shared of [null, undefined, [], 'x']) reject({ envs: [] }, shared);
  reject({ envs: [] }, { data: [], pagination: { count: 0, next: null, prev: 'page-1' } });
  reject({ envs: [] }, { data: [{}], pagination: { count: 0, next: null, prev: null } });
});

test('inventory maps inspection errors to ISOLATION', () => {
  const throwing = () => { throw new Error('private getter fault'); };
  assert.throws(() => safety.assertEmptyEnvironmentInventory({ envs: [] }, { data: [], get pagination() { return throwing(); } }), isSafe('ISOLATION'));
  assert.throws(() => safety.assertEmptyEnvironmentInventory({ envs: [] }, { get data() { return throwing(); }, pagination: {} }), isSafe('ISOLATION'));
  const trap = new Proxy({}, { get: throwing, has: throwing, getOwnPropertyDescriptor: throwing, ownKeys: throwing });
  assert.throws(() => safety.assertEmptyEnvironmentInventory(trap, goodShared()), isSafe('ISOLATION'));
  assert.throws(() => safety.assertEmptyEnvironmentInventory({ envs: [] }, trap), isSafe('ISOLATION'));
});

// ---- contract ----

test('module has no imports, require, or process access and exports the documented surface', () => {
  const source = readFileSync(new URL('./diagnostic-safety.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.doesNotMatch(source, /\brequire\s*\(/);
  assert.doesNotMatch(source, /\bprocess\./);
  assert.deepEqual(Object.keys(safety).sort(), [
    'DiagnosticSafetyError', 'assertEmptyEnvironmentInventory', 'createStickyOutput', 'pauseForInput', 'waitForCapture',
  ]);
});

// ---- end to end ----

function wireEndToEnd(writeImpl) {
  const input = makeInput();
  const stream = new Writable({ write: writeImpl });
  const output = safety.createStickyOutput(stream);
  const captureTimers = fakeTimers();
  const pending = safety.waitForCapture({
    timers: captureTimers,
    emit: output,
    onFailure: output.onFailure,
    pause: options => safety.pauseForInput({ ...options, input, timers: fakeTimers() }),
  });
  return { input, output, pending, captureTimers };
}

test('end to end: newline on input resolves and leaves no input listeners', async () => {
  const { input, pending, captureTimers } = wireEndToEnd((_chunk, _encoding, callback) => callback());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(input.eventNames().sort(), ['data', 'end', 'error']);
  input.emit('data', Buffer.from('continue\n'));
  await pending;
  assert.deepEqual(input.eventNames(), []);
  assert.equal(captureTimers.active.size, 0);
});

test('end to end: stream write failure rejects CAPTURE and leaves no input listeners', async () => {
  const { input, output, pending, captureTimers } = wireEndToEnd((_chunk, _encoding, callback) => callback(new Error('private sink error')));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(input.eventNames().sort(), ['data', 'end', 'error']);
  output('x');
  await assert.rejects(pending, isSafe('CAPTURE'));
  assert.deepEqual(input.eventNames(), []);
  assert.equal(captureTimers.active.size, 0);
});
