// OWNER: low-experience teammate. Remove `.skip` as you implement.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chat } from "../src/worker/lib/nvidia";
import { extractContext } from "../src/worker/services/documents";
import { env } from "./helpers";

vi.mock("../src/worker/lib/nvidia", () => ({ chat: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

describe.skip("extractContext", () => {
  it("makes one LLM call that includes the document text and returns trimmed text", async () => {
    vi.mocked(chat).mockResolvedValue("  Economics major at UChicago.  ");
    const note = await extractContext(env, "resume", "RESUME_TEXT_123");
    expect(chat).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(chat).mock.calls[0][1])).toContain("RESUME_TEXT_123");
    expect(note).toBe("Economics major at UChicago.");
  });
});
