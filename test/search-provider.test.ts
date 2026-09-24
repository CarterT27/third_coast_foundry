import { afterEach, describe, expect, it, vi } from "vitest";
import { search } from "../src/worker/lib/search-provider";
import { env } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("search", () => {
  it("sends a timeout signal and reports a timed-out query readably", async () => {
    const fn = vi
      .fn<typeof fetch>()
      .mockRejectedValue(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
    vi.stubGlobal("fetch", fn);
    await expect(search(env, "site:linkedin.com/in engineer")).rejects.toThrow("Brave timed out after 15s");
    expect(fn.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
