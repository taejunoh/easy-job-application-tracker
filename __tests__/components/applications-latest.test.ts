import { loadLatestApplications } from "@/app/applications/page";

describe("application filter requests", () => {
  it("does not let an older success replace the newest results", async () => {
    const first = deferred<string[]>();
    const second = deferred<string[]>();
    const request = jest
      .fn<Promise<string[]>, []>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const sequence = { current: 0 };
    const apply = jest.fn();
    const fail = jest.fn();
    const setLoading = jest.fn();

    const oldRequest = loadLatestApplications(
      sequence,
      request,
      apply,
      fail,
      setLoading,
    );
    const newRequest = loadLatestApplications(
      sequence,
      request,
      apply,
      fail,
      setLoading,
    );
    second.resolve(["new"]);
    await newRequest;
    first.resolve(["old"]);
    await oldRequest;

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(["new"]);
    expect(fail).not.toHaveBeenCalled();
    expect(setLoading.mock.calls).toEqual([[true], [true], [false]]);
  });

  it("does not let an older failure replace the newest success or loading state", async () => {
    const first = deferred<string[]>();
    const second = deferred<string[]>();
    const request = jest
      .fn<Promise<string[]>, []>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const sequence = { current: 0 };
    const apply = jest.fn();
    const fail = jest.fn();
    const setLoading = jest.fn();

    const oldRequest = loadLatestApplications(
      sequence,
      request,
      apply,
      fail,
      setLoading,
    );
    const newRequest = loadLatestApplications(
      sequence,
      request,
      apply,
      fail,
      setLoading,
    );
    first.reject(new Error("old failure"));
    await oldRequest;

    expect(apply).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(setLoading.mock.calls).toEqual([[true], [true]]);

    second.resolve(["new"]);
    await newRequest;

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(["new"]);
    expect(fail).not.toHaveBeenCalled();
    expect(setLoading.mock.calls).toEqual([[true], [true], [false]]);
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
