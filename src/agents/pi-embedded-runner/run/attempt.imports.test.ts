import { describe, expect, it, vi } from "vitest";

const compactionFailuresImported = vi.hoisted(() => vi.fn());

vi.mock("../compaction-failures.js", () => {
  compactionFailuresImported();
  return {};
});

describe("run attempt module wiring", () => {
  it("loads the compaction failure bridge during runner init", async () => {
    vi.resetModules();
    compactionFailuresImported.mockClear();

    await import("./attempt.js");

    expect(compactionFailuresImported).toHaveBeenCalledTimes(1);
  });
});
