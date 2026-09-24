// OWNER: Ania. Remove `.skip` as you implement.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chat } from "../src/worker/lib/nvidia";
import { extractContext } from "../src/worker/services/documents";
import { env } from "./helpers";

vi.mock("../src/worker/lib/nvidia", () => ({ chat: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

describe("extractContext", () => {
  it("makes one LLM call that includes the document text and returns trimmed text", async () => {
    vi.mocked(chat).mockResolvedValue("  Economics major at UChicago.  ");
    const note = await extractContext(env, "resume", "RESUME_TEXT_123");
    expect(chat).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(chat).mock.calls[0][1])).toContain("RESUME_TEXT_123");
    expect(note).toBe("Economics major at UChicago.");
  });

  it("asks for advanced coursework when the document is a transcript", async () => {
    vi.mocked(chat).mockResolvedValue("Advanced coursework: Econometrics (A).");
    await extractContext(env, "transcript", "TRANSCRIPT_TEXT");
    const [system] = vi.mocked(chat).mock.calls[0][1];
    expect(system.role).toBe("system");
    expect(system.content).toContain("Advanced coursework:");
  });

  it("asks for fixed labeled lines per kind and no contact details", async () => {
    vi.mocked(chat).mockResolvedValue("Headline: Analyst.");
    await extractContext(env, "linkedin", "LINKEDIN_TEXT");
    const [system] = vi.mocked(chat).mock.calls[0][1];
    expect(system.content).toContain("Headline:");
    expect(system.content).toContain("Volunteering & groups:");
    expect(system.content).not.toContain("GPA:");
    expect(system.content).toMatch(/leave out phone numbers, email addresses/i);
  });

  it("keeps schools separate, ignores boilerplate, and gives resumes projects and awards", async () => {
    vi.mocked(chat).mockResolvedValue("Projects: Oracle Trading.");
    await extractContext(env, "resume", "RESUME_TEXT");
    const [system] = vi.mocked(chat).mock.calls[0][1];
    expect(system.content).toContain("Projects:");
    expect(system.content).toContain("Awards:");
    expect(system.content).toMatch(/Keep each school separate/);
    expect(system.content).toMatch(/Ignore boilerplate/);
    expect(system.content).toMatch(/never write "none"/);
  });

  it("drops watermark lines before calling the model", async () => {
    vi.mocked(chat).mockResolvedValue("GPA: 3.9");
    const watermark = "UNIVERSITY OF CALIFORNIA, SAN DIEGO • ".repeat(3);
    await extractContext(env, "transcript", `COURSE_LINE\n${watermark}\nMATH 109 A+`);
    const user = vi.mocked(chat).mock.calls[0][1][1].content;
    expect(user).toContain("COURSE_LINE");
    expect(user).toContain("MATH 109 A+");
    expect(user).not.toContain("SAN DIEGO");
  });

  it("keeps only the kind's labeled lines and strips filler", async () => {
    vi.mocked(chat).mockResolvedValue(
      [
        "Carter Tran",
        "",
        "Education: The College, B.S. Mathematics, minors: none printed, Graduation date not printed",
        "GPA: 3.923",
        "Clubs/Affiliations: None listed",
        "Honors: none",
      ].join("\n"),
    );
    const note = await extractContext(env, "transcript", "TRANSCRIPT_TEXT");
    expect(note).toBe("Education: The College, B.S. Mathematics\nGPA: 3.923");
  });
});
