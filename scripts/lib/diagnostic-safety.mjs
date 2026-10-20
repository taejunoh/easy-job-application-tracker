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
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function assertEmptyEnvironmentInventory(project, shared) {
  const projectEnvs = Array.isArray(project) ? project : isObject(project) ? project.envs : undefined;
  if (!Array.isArray(projectEnvs) || projectEnvs.length !== 0 ||
      (!Array.isArray(project) && Object.hasOwn(project, 'pagination')) ||
      !isObject(shared) || !Array.isArray(shared.data) || shared.data.length !== 0 ||
      !isObject(shared.pagination) || shared.pagination.count !== 0 ||
      shared.pagination.next !== null || shared.pagination.prev !== null) fail('ISOLATION');
}

export function waitForCapture({ pause, emit, onFailure, timers }) {
  const clock = timers ?? globalThis;
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe;
    let timeout;
    let heartbeat;
    const finish = failed => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timeout);
      clock.clearInterval(heartbeat);
      try { unsubscribe?.(); } catch { /* cleanup remains best-effort */ }
      controller.abort();
      if (failed) reject(new DiagnosticSafetyError('CAPTURE'));
      else resolve();
    };
    timeout = clock.setTimeout(() => finish(true), 120000);
    heartbeat = clock.setInterval(() => {
      try { emit('capture-wait'); } catch { finish(true); }
    }, 10000);
    if (onFailure) {
      let off;
      try { off = onFailure(() => finish(true)); }
      catch { finish(true); }
      if (settled) { try { off?.(); } catch { /* safe cleanup */ } }
      else unsubscribe = off;
    }
    if (!settled) Promise.resolve().then(() => {
      if (settled || controller.signal.aborted) return;
      return pause({ timeoutMs: 120000, signal: controller.signal });
    }).then(() => finish(false), () => finish(true));
  });
}

// This contains output transport errors; it does not redact line contents.
export function createStickyOutput(stream) {
  let failed = false;
  const listeners = new Set();
  const failure = () => {
    if (failed) return;
    failed = true;
    for (const listener of listeners) { try { listener(); } catch { /* do not leak sink errors */ } }
  };
  stream.on('error', failure);
  const output = line => {
    if (failed) fail('CAPTURE');
    try { stream.write(line, error => { if (error) failure(); }); }
    catch { failure(); fail('CAPTURE'); }
  };
  output.onFailure = listener => {
    if (failed) listener();
    else listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return output;
}

export function pauseForInput({ timeoutMs, signal, input, timers }) {
  if (signal?.aborted) return Promise.reject(new DiagnosticSafetyError('CAPTURE'));
  const source = input;
  const clock = timers ?? globalThis;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = failed => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timer);
      source.removeListener('data', data);
      source.removeListener('end', ended);
      source.removeListener('error', errored);
      signal?.removeEventListener('abort', aborted);
      source.pause();
      if (failed) reject(new DiagnosticSafetyError('CAPTURE'));
      else resolve();
    };
    const data = bytes => { if (bytes.includes(10)) finish(false); };
    const ended = () => finish(true);
    const errored = () => finish(true);
    const aborted = () => finish(true);
    timer = clock.setTimeout(() => finish(true), timeoutMs);
    source.on('data', data);
    source.once('end', ended);
    source.on('error', errored);
    signal?.addEventListener('abort', aborted, { once: true });
    source.resume();
  });
}
