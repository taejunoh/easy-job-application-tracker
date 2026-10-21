// Public-safe, local-only diagnostic boundaries. These helpers perform no I/O.
const ERROR_CODES = new Set(['ISOLATION', 'CAPTURE', 'SCHEMA']);

export class DiagnosticSafetyError extends Error {
  constructor(code) {
    const safeCode = ERROR_CODES.has(code) ? code : 'SCHEMA';
    super(safeCode);
    this.name = 'DiagnosticSafetyError';
    this.code = safeCode;
  }
}

const fail = code => { throw new DiagnosticSafetyError(code); };
const rejectSchema = () => Promise.reject(new DiagnosticSafetyError('SCHEMA'));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isFunction = value => typeof value === 'function';
const hasFunctions = (target, names) => isObject(target) && names.every(name => isFunction(target[name]));
const attempt = fn => { try { fn(); } catch { /* best-effort cleanup */ } };
// Untrusted getters/proxies may throw while inspecting; treat that as invalid.
const check = test => { try { return test() === true; } catch { return false; } };
const MAX_TIMER_MS = 2 ** 31 - 1;

export function assertEmptyEnvironmentInventory(project, shared) {
  let ok;
  try {
    const projectEnvs = Array.isArray(project) ? project : isObject(project) ? project.envs : undefined;
    ok = Array.isArray(projectEnvs) && projectEnvs.length === 0 &&
      (Array.isArray(project) || !Object.hasOwn(project, 'pagination')) &&
      isObject(shared) && Array.isArray(shared.data) && shared.data.length === 0 &&
      isObject(shared.pagination) && shared.pagination.count === 0 &&
      shared.pagination.next === null && shared.pagination.prev === null;
  } catch { ok = false; }
  if (!ok) fail('ISOLATION');
}

export function waitForCapture(options) {
  let pause, emit, onFailure, timers;
  const valid = check(() => {
    if (!isObject(options)) return false;
    ({ pause, emit, onFailure, timers } = options);
    return isFunction(pause) && isFunction(emit) &&
      (onFailure == null || isFunction(onFailure)) &&
      (timers == null || hasFunctions(timers, ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']));
  });
  if (!valid) return rejectSchema();
  const clock = timers ?? globalThis;
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe;
    let timeout;
    let heartbeat;
    const release = () => {
      attempt(() => clock.clearTimeout(timeout));
      attempt(() => clock.clearInterval(heartbeat));
      const off = unsubscribe;
      unsubscribe = undefined;
      attempt(() => off?.());
    };
    const finish = failed => {
      if (settled) return;
      settled = true;
      release();
      attempt(() => controller.abort());
      if (failed) reject(new DiagnosticSafetyError('CAPTURE'));
      else resolve();
    };
    const beat = () => {
      if (settled) return;
      Promise.resolve().then(() => emit('capture-wait')).catch(() => finish(true));
    };
    const steps = [
      () => { timeout = clock.setTimeout(() => finish(true), 120000); },
      () => { heartbeat = clock.setInterval(beat, 10000); },
      () => {
        if (!onFailure) return;
        const off = onFailure(() => finish(true));
        if (settled) attempt(() => off?.());
        else unsubscribe = off;
      },
    ];
    try {
      for (const step of steps) {
        step();
        if (settled) return release();
      }
    } catch { return finish(true); }
    Promise.resolve().then(() => {
      if (settled || controller.signal.aborted) return;
      return pause({ timeoutMs: 120000, signal: controller.signal });
    }).then(() => finish(false), () => finish(true));
  });
}

// This contains output transport errors; it does not redact line contents.
export function createStickyOutput(stream) {
  if (!check(() => hasFunctions(stream, ['on', 'write']))) fail('SCHEMA');
  let failed = false;
  const listeners = new Set();
  const failure = () => {
    if (failed) return;
    failed = true;
    for (const listener of listeners) { try { listener(); } catch { /* do not leak sink errors */ } }
    listeners.clear();
  };
  try { stream.on('error', failure); } catch { fail('CAPTURE'); }
  const output = line => {
    if (failed) fail('CAPTURE');
    try { stream.write(line, error => { if (error) failure(); }); }
    catch { failure(); fail('CAPTURE'); }
  };
  output.onFailure = listener => {
    if (!isFunction(listener)) fail('SCHEMA');
    if (failed) { try { listener(); } catch { /* do not leak sink errors */ } }
    else listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return output;
}

const hasLineBreak = chunk => {
  if (typeof chunk === 'string') return /[\r\n]/.test(chunk);
  const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return bytes.includes(10) || bytes.includes(13);
};

export function pauseForInput(options) {
  let timeoutMs, signal, input, timers;
  const valid = check(() => {
    if (!isObject(options)) return false;
    ({ timeoutMs, signal, input, timers } = options);
    return Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMER_MS &&
      hasFunctions(input, ['on', 'once', 'removeListener', 'resume', 'pause']) &&
      // Reading aborted brand-checks the signal, so forged prototypes fail here.
      (signal == null || (signal instanceof AbortSignal && typeof signal.aborted === 'boolean')) &&
      (timers == null || hasFunctions(timers, ['setTimeout', 'clearTimeout']));
  });
  if (!valid) return rejectSchema();
  const captureFailed = () => Promise.reject(new DiagnosticSafetyError('CAPTURE'));
  if (signal?.aborted) return captureFailed();
  if (!check(() => input.readableEnded !== true && input.destroyed !== true && input.errored == null)) return captureFailed();
  const source = input;
  const clock = timers ?? globalThis;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const release = () => {
      attempt(() => clock.clearTimeout(timer));
      attempt(() => source.removeListener('data', data));
      attempt(() => source.removeListener('end', ended));
      attempt(() => source.removeListener('error', errored));
      attempt(() => signal?.removeEventListener('abort', aborted));
    };
    const finish = failed => {
      if (settled) return;
      settled = true;
      release();
      attempt(() => source.pause());
      if (failed) reject(new DiagnosticSafetyError('CAPTURE'));
      else resolve();
    };
    const data = chunk => {
      try {
        if (typeof chunk === 'string' || ArrayBuffer.isView(chunk)) { if (hasLineBreak(chunk)) finish(false); }
        else finish(true);
      } catch { finish(true); }
    };
    const ended = () => finish(true);
    const errored = () => finish(true);
    const aborted = () => finish(true);
    const steps = [
      () => { timer = clock.setTimeout(() => finish(true), timeoutMs); },
      () => source.on('data', data),
      () => source.once('end', ended),
      () => source.on('error', errored),
      () => signal?.addEventListener('abort', aborted, { once: true }),
      () => source.resume(),
    ];
    try {
      for (const step of steps) {
        step();
        if (settled) return release();
      }
    } catch { finish(true); }
  });
}
