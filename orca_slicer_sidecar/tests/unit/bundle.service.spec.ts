import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import {
  importBundle,
  listBundles,
  readBundleSummary,
  deleteBundle,
  resolveBundlePresetPath,
  computeBundleId,
  __test__,
} from "../../src/routes/profiles/bundle.service";
import { AppError } from "../../src/middleware/error";

// Real H2D fixture exported from BambuStudio 02.06.00.51 — the same file
// that drove the Step 0 verification (TEST 7) before this code existed.
// Keeping the path central so test changes only require updating one line.
const FIXTURE = path.join(
  __dirname,
  "..",
  "files",
  "input",
  "H2D-bundle.bbscfg",
);

let originalDataPath: string | undefined;
let scratchRoot: string;

beforeEach(async () => {
  // Each test runs against a fresh DATA_PATH so deletes / re-imports
  // don't bleed into neighbours. /tmp scratch dirs are cleaned up in
  // afterEach.
  originalDataPath = process.env.DATA_PATH;
  scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-test-"));
  process.env.DATA_PATH = scratchRoot;
});

afterEach(async () => {
  if (originalDataPath === undefined) {
    delete process.env.DATA_PATH;
  } else {
    process.env.DATA_PATH = originalDataPath;
  }
  await fs.rm(scratchRoot, { recursive: true, force: true });
});

describe("computeBundleId", () => {
  it("produces a stable 16-hex-char id for identical content", async () => {
    const buf = await fs.readFile(FIXTURE);
    const id1 = computeBundleId(buf);
    const id2 = computeBundleId(buf);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{16}$/);
  });

  it("produces different ids for different content", async () => {
    const buf = await fs.readFile(FIXTURE);
    const tweaked = Buffer.concat([buf, Buffer.from([0])]);
    expect(computeBundleId(buf)).not.toBe(computeBundleId(tweaked));
  });
});

describe("importBundle", () => {
  it("extracts a real H2D bundle, returns a populated summary", async () => {
    const zip = await fs.readFile(FIXTURE);
    const summary = await importBundle(zip);

    expect(summary.id).toMatch(/^[0-9a-f]{16}$/);
    expect(summary.printer_preset_name).toBe("# Bambu Lab H2D 0.4 nozzle");
    // The H2D fixture has one printer preset, multiple processes, and many
    // filaments. Exact counts may shift if the fixture is regenerated, so
    // assert ranges + presence of representative names rather than exact
    // arrays.
    expect(summary.printer).toContain("# Bambu Lab H2D 0.4 nozzle");
    expect(summary.process).toContain("# 0.20mm Standard @BBL H2D");
    expect(summary.filament).toContain("# Bambu PLA Basic @BBL H2D");
    expect(summary.printer.length).toBeGreaterThanOrEqual(1);
    expect(summary.process.length).toBeGreaterThan(1);
    expect(summary.filament.length).toBeGreaterThan(1);
  });

  it("writes inner files under DATA_PATH/bundles/<id>/", async () => {
    const zip = await fs.readFile(FIXTURE);
    const summary = await importBundle(zip);

    const dir = path.join(scratchRoot, "bundles", summary.id);
    const manifest = await fs.readFile(
      path.join(dir, "bundle_structure.json"),
      "utf-8",
    );
    expect(manifest).toContain("printer_preset_name");

    // A representative file from each category survives extraction.
    await expect(
      fs.access(path.join(dir, "printer", "# Bambu Lab H2D 0.4 nozzle.json")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(dir, "process", "# 0.20mm Standard @BBL H2D.json")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(dir, "filament", "# Bambu PLA Basic @BBL H2D.json")),
    ).resolves.toBeUndefined();
  });

  it("is idempotent on re-upload (same content yields same id, no duplicate)", async () => {
    const zip = await fs.readFile(FIXTURE);
    const first = await importBundle(zip);
    const second = await importBundle(zip);

    expect(second.id).toBe(first.id);
    const entries = await fs.readdir(path.join(scratchRoot, "bundles"));
    expect(entries).toHaveLength(1);
  });

  it("rejects a non-zip buffer with HTTP 400", async () => {
    await expect(importBundle(Buffer.from("not a zip"))).rejects.toThrow(
      AppError,
    );
    await expect(importBundle(Buffer.from("not a zip"))).rejects.toMatchObject({
      status: 400,
    });
  });

  it("rejects an empty buffer", async () => {
    await expect(importBundle(Buffer.alloc(0))).rejects.toMatchObject({
      status: 400,
    });
  });

  it("rejects a zip that is not a Printer Preset Bundle (no manifest)", async () => {
    // Build a tiny zip with a single unrelated file, no bundle_structure.json,
    // and no entries under printer/process/filament/. The fileFilter rejects
    // it on the first non-allowed entry name (stray.txt fails assertSafeEntryPath).
    const archiver = (await import("archiver")).default;
    const stagingPath = path.join(scratchRoot, "stray.zip");
    await new Promise<void>((resolve, reject) => {
      const out = require("fs").createWriteStream(stagingPath);
      const archive = archiver("zip");
      out.on("close", () => resolve());
      out.on("error", reject);
      archive.on("error", reject);
      archive.pipe(out);
      archive.append("not a manifest", { name: "stray.txt" });
      archive.finalize();
    });
    const zip = await fs.readFile(stagingPath);

    await expect(importBundle(zip)).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("assertSafeEntryPath (path-traversal guard)", () => {
  // Entries the unzipper feeds to extraction are validated before we touch
  // the filesystem. Each of these would be a critical bug if the guard let
  // it through — they cover the common attack patterns documented for
  // "zip slip" exploits.
  it.each([
    ["../etc/passwd", "parent traversal"],
    ["printer/../../etc/passwd", "embedded parent traversal"],
    ["/etc/passwd", "absolute path"],
    ["C:\\Windows\\System32", "windows absolute path"],
    ["printer/foo.exe", "non-JSON file under known dir"],
    ["unknown/foo.json", "unknown top-level dir"],
    ["foo.json", "JSON at root other than manifest"],
  ])("rejects %s (%s)", (entry) => {
    expect(() => __test__.assertSafeEntryPath(entry)).toThrow(AppError);
  });

  it("accepts safe entries", () => {
    expect(() =>
      __test__.assertSafeEntryPath("bundle_structure.json"),
    ).not.toThrow();
    expect(() =>
      __test__.assertSafeEntryPath("printer/Foo.json"),
    ).not.toThrow();
    expect(() =>
      __test__.assertSafeEntryPath("process/0.20mm Standard.json"),
    ).not.toThrow();
    expect(() =>
      __test__.assertSafeEntryPath("filament/PLA Basic.json"),
    ).not.toThrow();
  });
});

describe("listBundles / readBundleSummary / deleteBundle", () => {
  it("returns an empty list when no bundles have been imported", async () => {
    expect(await listBundles()).toEqual([]);
  });

  it("listBundles returns each imported bundle once", async () => {
    const zip = await fs.readFile(FIXTURE);
    const summary = await importBundle(zip);
    const list = await listBundles();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(summary.id);
    expect(list[0].printer_preset_name).toBe(summary.printer_preset_name);
  });

  it("readBundleSummary throws 404 for an unknown id", async () => {
    await expect(readBundleSummary("deadbeef00000000")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("deleteBundle removes the directory and makes subsequent reads 404", async () => {
    const zip = await fs.readFile(FIXTURE);
    const summary = await importBundle(zip);
    await deleteBundle(summary.id);
    await expect(readBundleSummary(summary.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("deleteBundle throws 404 when the id was never imported", async () => {
    await expect(deleteBundle("00000000deadbeef")).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("resolveBundlePresetPath", () => {
  it("resolves a preset name with the BambuStudio user-clone '# ' prefix", async () => {
    const zip = await fs.readFile(FIXTURE);
    const summary = await importBundle(zip);

    const p = await resolveBundlePresetPath(
      summary.id,
      "printer",
      "# Bambu Lab H2D 0.4 nozzle",
    );
    expect(p).toContain("printer");
    expect(p).toContain("# Bambu Lab H2D 0.4 nozzle.json");
    await expect(fs.access(p)).resolves.toBeUndefined();
  });

  it("resolves a preset name without the '# ' prefix (ergonomic form)", async () => {
    const zip = await fs.readFile(FIXTURE);
    const summary = await importBundle(zip);

    const p = await resolveBundlePresetPath(
      summary.id,
      "printer",
      "Bambu Lab H2D 0.4 nozzle",
    );
    expect(p).toContain("# Bambu Lab H2D 0.4 nozzle.json");
  });

  it("resolves the trailing .json extension if the caller includes it", async () => {
    const zip = await fs.readFile(FIXTURE);
    const summary = await importBundle(zip);

    const p = await resolveBundlePresetPath(
      summary.id,
      "process",
      "# 0.20mm Standard @BBL H2D.json",
    );
    expect(p).toContain("# 0.20mm Standard @BBL H2D.json");
  });

  it("throws 404 for an unknown preset name in a known bundle", async () => {
    const zip = await fs.readFile(FIXTURE);
    const summary = await importBundle(zip);

    await expect(
      resolveBundlePresetPath(summary.id, "filament", "No Such Filament"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("throws 404 when the bundle id was never imported", async () => {
    await expect(
      resolveBundlePresetPath("deadbeef00000000", "printer", "anything"),
    ).rejects.toMatchObject({ status: 404 });
  });
});
