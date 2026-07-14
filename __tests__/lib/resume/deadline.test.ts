import { createResumeDeadline } from "@/lib/resume/deadline";

describe("resume processing deadline", () => {
  it("uses one absolute monotonic deadline and aborts with the supplied reason", async () => {
    jest.useFakeTimers();
    const reason = new Error("resume deadline");

    try {
      const deadline = createResumeDeadline(15_000, reason);
      const startedAt = performance.now();

      expect(deadline.expiresAt).toBe(startedAt + 15_000);
      expect(deadline.remainingMs()).toBe(15_000);

      await jest.advanceTimersByTimeAsync(14_999);
      expect(deadline.signal.aborted).toBe(false);
      expect(deadline.remainingMs()).toBe(1);

      await jest.advanceTimersByTimeAsync(1);
      expect(deadline.signal.aborted).toBe(true);
      expect(deadline.signal.reason).toBe(reason);
      expect(deadline.remainingMs()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it("can be disposed without aborting after successful processing", async () => {
    jest.useFakeTimers();
    const deadline = createResumeDeadline(15_000, new Error("deadline"));

    try {
      deadline.dispose();
      await jest.advanceTimersByTimeAsync(15_001);

      expect(deadline.signal.aborted).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});
