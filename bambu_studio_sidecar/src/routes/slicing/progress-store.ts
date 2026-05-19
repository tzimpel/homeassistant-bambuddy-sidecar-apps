/**
 * In-memory progress tracker for active slice jobs.
 *
 * The slicer CLI emits structured JSON lines via the `--pipe` flag while
 * slicing — one line per stage transition (Detecting perimeters, Generating
 * supports, Generating G-code, etc.) plus a percent counter. This module
 * stores the latest snapshot per request_id so a separate HTTP poller can
 * read it without coupling to the slice-completion response.
 *
 * Lifecycle:
 *   1. Caller (slicing service) generates / accepts a request_id and calls
 *      `start(id)` before spawning the slicer.
 *   2. Each parsed JSON line lands as `update(id, {stage, percent, ...})`.
 *   3. On slicer exit `finish(id)` schedules cleanup after a grace window
 *      so the caller's last-poll can still read the terminal frame.
 *
 * The store is intentionally tiny and unbounded by entry count — we expect
 * a handful of concurrent slices, each cleaned up within seconds of exit.
 * If that ever changes, add a hard cap + LRU eviction here.
 */
export interface SliceProgress {
  /** Stage label emitted by the slicer ("Generating G-code", etc.). */
  stage: string;
  /** Overall progress 0-100 across all plates the CLI was asked to slice. */
  totalPercent: number;
  /** Progress 0-100 within the current plate. */
  platePercent: number;
  /** 1-indexed plate position; 0 means "all plates" / final completion. */
  plateIndex: number;
  /** Total plates in this slice run. */
  plateCount: number;
  /** Unix ms timestamp of the last update. Useful for stale detection. */
  updatedAt: number;
}

// Grace window kept after `finish()` so a poll that just missed the slice
// completion still sees the terminal frame instead of a 404. Bambuddy
// polls every 1s; 30s is plenty.
const FINISH_GRACE_MS = 30_000;

class ProgressStore {
  private map = new Map<string, SliceProgress>();
  private cleanupTimers = new Map<string, NodeJS.Timeout>();

  start(requestId: string): void {
    // Cancel any pending cleanup from a previous request that reused the id
    // (unlikely but defensible).
    const existing = this.cleanupTimers.get(requestId);
    if (existing) {
      clearTimeout(existing);
      this.cleanupTimers.delete(requestId);
    }
    this.map.set(requestId, {
      stage: "",
      totalPercent: 0,
      platePercent: 0,
      plateIndex: 0,
      plateCount: 0,
      updatedAt: Date.now(),
    });
  }

  update(requestId: string, partial: Partial<Omit<SliceProgress, "updatedAt">>): void {
    const current = this.map.get(requestId);
    if (!current) return;
    this.map.set(requestId, {
      ...current,
      ...partial,
      updatedAt: Date.now(),
    });
  }

  get(requestId: string): SliceProgress | undefined {
    return this.map.get(requestId);
  }

  /** Schedule cleanup. The entry stays readable for ~30s so the caller's
   * last poll can read the terminal frame. */
  finish(requestId: string): void {
    const timer = setTimeout(() => {
      this.map.delete(requestId);
      this.cleanupTimers.delete(requestId);
    }, FINISH_GRACE_MS);
    // Allow the process to exit without waiting on this timer.
    timer.unref?.();
    this.cleanupTimers.set(requestId, timer);
  }

  /** Test helper — drop everything immediately. */
  _resetForTesting(): void {
    for (const timer of this.cleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.cleanupTimers.clear();
    this.map.clear();
  }
}

export const progressStore = new ProgressStore();

/**
 * Parse the slicer's JSON-line progress format. Returns the parsed object
 * or null when the line is not a valid progress event (blank, malformed,
 * or unrelated debug output that happened to land on the pipe).
 *
 * Real example:
 *   {"message":"Generating G-code","plate_count":1,"plate_index":1,
 *    "plate_percent":80,"total_percent":75}
 */
export function parseProgressLine(line: string): Partial<SliceProgress> | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  // The slicer always emits message + total_percent; the others sometimes
  // come back as 0 / missing on pre-slice "Initializing" frames. Defaults
  // keep the consumer's UI from flickering.
  const stage = typeof parsed.message === "string" ? parsed.message : "";
  const totalPercent = numberOr0(parsed.total_percent);
  const platePercent = numberOr0(parsed.plate_percent);
  const plateIndex = numberOr0(parsed.plate_index);
  const plateCount = numberOr0(parsed.plate_count);
  if (!stage && totalPercent === 0 && platePercent === 0) return null;
  return { stage, totalPercent, platePercent, plateIndex, plateCount };
}

function numberOr0(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return 0;
}
