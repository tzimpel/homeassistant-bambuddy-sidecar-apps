import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  progressStore,
  parseProgressLine,
} from "../../src/routes/slicing/progress-store";

describe("parseProgressLine", () => {
  it("parses a real OrcaSlicer progress line", () => {
    const line =
      '{"message":"Generating G-code","plate_count":1,"plate_index":1,"plate_percent":80,"total_percent":75}';
    expect(parseProgressLine(line)).toEqual({
      stage: "Generating G-code",
      totalPercent: 75,
      platePercent: 80,
      plateIndex: 1,
      plateCount: 1,
    });
  });

  it("parses the terminal All-done frame", () => {
    const line =
      '{"message":"All done, Success","plate_count":1,"plate_index":0,"plate_percent":100,"total_percent":100}';
    expect(parseProgressLine(line)).toEqual({
      stage: "All done, Success",
      totalPercent: 100,
      platePercent: 100,
      plateIndex: 0,
      plateCount: 1,
    });
  });

  it("returns null on blank lines", () => {
    expect(parseProgressLine("")).toBeNull();
    expect(parseProgressLine("   ")).toBeNull();
    expect(parseProgressLine("\n")).toBeNull();
  });

  it("returns null on non-JSON debug lines", () => {
    // Slicers occasionally write plain debug strings to the same FIFO
    // when --debug is high. Don't blow up on them.
    expect(parseProgressLine("[DEBUG] starting plate 1")).toBeNull();
    expect(parseProgressLine("malformed{")).toBeNull();
  });

  it("returns null on JSON without any progress fields", () => {
    expect(parseProgressLine('{"unrelated":"data"}')).toBeNull();
  });

  it("tolerates partial fields by defaulting to 0", () => {
    // Some early frames only carry `message` and `total_percent` while
    // others omit message entirely. Default missing numeric fields to 0
    // so the consumer doesn't have to defensive-check every key.
    const line =
      '{"message":"Initializing","total_percent":2}';
    expect(parseProgressLine(line)).toEqual({
      stage: "Initializing",
      totalPercent: 2,
      platePercent: 0,
      plateIndex: 0,
      plateCount: 0,
    });
  });

  it("rejects non-finite percents (NaN/Infinity from broken slicers)", () => {
    const line =
      '{"message":"foo","total_percent":null,"plate_percent":"bad"}';
    const parsed = parseProgressLine(line);
    expect(parsed).toEqual({
      stage: "foo",
      totalPercent: 0,
      platePercent: 0,
      plateIndex: 0,
      plateCount: 0,
    });
  });
});

describe("ProgressStore", () => {
  beforeEach(() => {
    progressStore._resetForTesting();
  });

  afterEach(() => {
    progressStore._resetForTesting();
  });

  it("returns undefined for unknown ids", () => {
    expect(progressStore.get("nope")).toBeUndefined();
  });

  it("stores and retrieves a progress snapshot", () => {
    progressStore.start("abc");
    progressStore.update("abc", {
      stage: "Generating G-code",
      totalPercent: 75,
      platePercent: 80,
      plateIndex: 1,
      plateCount: 1,
    });
    const got = progressStore.get("abc");
    expect(got).toMatchObject({
      stage: "Generating G-code",
      totalPercent: 75,
      platePercent: 80,
      plateIndex: 1,
      plateCount: 1,
    });
    expect(typeof got?.updatedAt).toBe("number");
  });

  it("ignores updates for unstarted ids — start() is required first", () => {
    progressStore.update("never-started", { stage: "x", totalPercent: 50 });
    expect(progressStore.get("never-started")).toBeUndefined();
  });

  it("preserves the last-known frame in the grace window after finish()", () => {
    vi.useFakeTimers();
    progressStore.start("xyz");
    progressStore.update("xyz", {
      stage: "All done, Success",
      totalPercent: 100,
      platePercent: 100,
      plateIndex: 0,
      plateCount: 1,
    });
    progressStore.finish("xyz");

    // Within the 30s grace, the terminal frame is still readable.
    expect(progressStore.get("xyz")?.totalPercent).toBe(100);

    // After grace expires the entry disappears.
    vi.advanceTimersByTime(30_000 + 100);
    expect(progressStore.get("xyz")).toBeUndefined();

    vi.useRealTimers();
  });

  it("start() cancels any pending cleanup for the same id", () => {
    vi.useFakeTimers();
    progressStore.start("reused");
    progressStore.update("reused", { stage: "first", totalPercent: 50 });
    progressStore.finish("reused");

    // Re-start before grace expires — cleanup must NOT fire and wipe the
    // freshly-started entry. Re-start also resets to the zero frame.
    vi.advanceTimersByTime(15_000);
    progressStore.start("reused");
    progressStore.update("reused", { stage: "second", totalPercent: 10 });

    // Original cleanup would have fired at 30s. Make sure we're past it.
    vi.advanceTimersByTime(20_000);
    expect(progressStore.get("reused")?.stage).toBe("second");

    vi.useRealTimers();
  });
});
