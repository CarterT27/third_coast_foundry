import { afterEach, describe, expect, it, vi } from "vitest";
import { search, SearchCapacityError, stripTags } from "../src/worker/lib/search-provider";
import { SubrequestLimitError, withSubrequestLimit } from "../src/worker/lib/subrequests";
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

  it("reports a used-up monthly quota as capacity without retrying", async () => {
    const fn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("{}", { status: 429, headers: { "X-RateLimit-Remaining": "49, 0" } }),
    );
    vi.stubGlobal("fetch", fn);
    await expect(search(env, "q")).rejects.toBeInstanceOf(SearchCapacityError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a per-second 429 once, then reports capacity", async () => {
    const fn = vi.fn<typeof fetch>().mockImplementation(async () => new Response("{}", { status: 429 }));
    vi.stubGlobal("fetch", fn);
    await expect(search(env, "q")).rejects.toThrow("Search is at capacity this month");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("stops at the subrequest budget without fetching", async () => {
    const fn = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fn);
    await expect(search(withSubrequestLimit(env, 0), "q")).rejects.toBeInstanceOf(SubrequestLimitError);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("stripTags", () => {
  it("strips markup and decodes named and numeric entities", () => {
    expect(stripTags("<strong>Jane</strong>&nbsp;Doe &#8211; PM at AT&amp;T &mdash; &#x27;24&hellip; &bogus;")).toBe(
      "Jane Doe – PM at AT&T — '24… &bogus;",
    );
  });

  it("decodes each entity once", () => {
    expect(stripTags("&amp;lt;")).toBe("&lt;");
  });
});
