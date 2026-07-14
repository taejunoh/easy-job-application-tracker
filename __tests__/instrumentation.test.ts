describe("server instrumentation", () => {
  const originalRuntime = process.env.NEXT_RUNTIME;

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = originalRuntime;
  });

  it("validates the complete server environment during Node.js startup", async () => {
    const getServerEnv = jest.fn(() => Object.freeze({}));
    jest.doMock("@/lib/server-env", () => ({ getServerEnv }));
    process.env.NEXT_RUNTIME = "nodejs";

    const { register } = await import("@/instrumentation");
    await register();

    expect(getServerEnv).toHaveBeenCalledTimes(1);
  });

  it("does not import Node-only environment validation in another runtime", async () => {
    const getServerEnv = jest.fn(() => Object.freeze({}));
    jest.doMock("@/lib/server-env", () => ({ getServerEnv }));
    process.env.NEXT_RUNTIME = "edge";

    const { register } = await import("@/instrumentation");
    await register();

    expect(getServerEnv).not.toHaveBeenCalled();
  });
});
