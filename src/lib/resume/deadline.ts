import "server-only";

export type ResumeDeadline = Readonly<{
  expiresAt: number;
  signal: AbortSignal;
  remainingMs(): number;
  dispose(): void;
}>;

export function createResumeDeadline(
  durationMs: number,
  reason: Error,
): ResumeDeadline {
  const controller = new AbortController();
  const expiresAt = performance.now() + durationMs;
  const timer = setTimeout(() => controller.abort(reason), durationMs);
  timer.unref?.();

  return Object.freeze({
    expiresAt,
    signal: controller.signal,
    remainingMs: () => Math.max(0, expiresAt - performance.now()),
    dispose: () => clearTimeout(timer),
  });
}
