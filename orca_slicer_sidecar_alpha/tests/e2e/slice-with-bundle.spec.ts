import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { request } from "./setup";
import { promises as fs } from "fs";
import fsSync from "fs";
import path from "path";
import os from "os";

// End-to-end coverage for the bundle-based slicing path. Uploads a real
// BambuStudio "Printer Preset Bundle" (.bbscfg) via POST /profiles/bundle,
// then slices Cube.stl using the bundle id + preset names as selectors,
// expecting the existing inherits-resolver to flatten the deltas against
// the BambuStudio-shipped BBL/ profiles before invoking the CLI.
//
// This is the regression test for Step 0 TEST 7 (the empirical proof that
// .bbscfg deltas slice cleanly when fed through the resolver).
describe("Slicing - bundle selector path", () => {
  let originalDataPath: string | undefined;
  let scratchRoot: string;

  beforeAll(async () => {
    // Each run gets a fresh DATA_PATH so previously-imported bundles from
    // other test files don't bleed in. We restore the prior value in
    // afterAll so any side-effects on the shared process env don't leak.
    originalDataPath = process.env.DATA_PATH;
    scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-e2e-"));
    process.env.DATA_PATH = scratchRoot;
  });

  afterAll(async () => {
    if (originalDataPath === undefined) {
      delete process.env.DATA_PATH;
    } else {
      process.env.DATA_PATH = originalDataPath;
    }
    await fs.rm(scratchRoot, { recursive: true, force: true });
  });

  it("imports a bundle and slices via bundle+preset-name selectors", async () => {
    const bundlePath = path.join(
      __dirname,
      "../files/input/H2D-bundle.bbscfg",
    );
    const bundleBuffer = fsSync.readFileSync(bundlePath);

    // 1. Upload the bundle. Idempotent — re-running this test re-uses the
    //    same id since the content hash hasn't changed.
    const upload = await request
      .post("/profiles/bundle")
      .attach("file", bundleBuffer, "H2D-bundle.bbscfg")
      .expect(201);

    expect(upload.body.id).toMatch(/^[0-9a-f]{16}$/);
    expect(upload.body.printer).toContain("# Bambu Lab H2D 0.4 nozzle");
    expect(upload.body.process).toContain("# 0.20mm Standard @BBL H2D");
    expect(upload.body.filament).toContain("# Bambu PLA Basic @BBL H2D");
    const bundleId: string = upload.body.id;

    // 2. Slice Cube.stl picking from the bundle by name. Mirrors what
    //    Bambuddy's SliceModal will eventually send.
    const stlPath = path.join(__dirname, "../files/input/Cube.stl");
    const stlBuffer = fsSync.readFileSync(stlPath);

    const response = await request
      .post("/slice")
      .field("bundle", bundleId)
      .field("printerName", "# Bambu Lab H2D 0.4 nozzle")
      .field("processName", "# 0.20mm Standard @BBL H2D")
      .field("filamentName", "# Bambu PLA Basic @BBL H2D")
      .attach("file", stlBuffer, "Cube.stl")
      .expect(200)
      .expect("x-print-time-seconds", /[0-9]+/)
      .expect("x-filament-used-g", /[0-9.]+/)
      .expect("x-filament-used-mm", /[0-9.]+/);

    expect(Number(response.headers["x-print-time-seconds"])).toBeGreaterThan(0);
    expect(Number(response.headers["x-filament-used-g"])).toBeGreaterThan(0);
    expect(Number(response.headers["x-filament-used-mm"])).toBeGreaterThan(0);
    // BambuStudio CLI emits G-code with this header line at the top.
    expect(response.text).toMatch(/^; HEADER_BLOCK_START/);
    expect(response.text).toContain("BambuStudio");
  }, 120_000);

  it("slices when preset names are passed without the '# ' user-clone prefix", async () => {
    // Same flow as above but exercising the ergonomic API form: callers
    // shouldn't have to know about BambuStudio's "# " prefix convention.
    const bundlePath = path.join(
      __dirname,
      "../files/input/H2D-bundle.bbscfg",
    );
    const bundleBuffer = fsSync.readFileSync(bundlePath);

    const upload = await request
      .post("/profiles/bundle")
      .attach("file", bundleBuffer, "H2D-bundle.bbscfg")
      .expect(201);
    const bundleId: string = upload.body.id;

    const stlPath = path.join(__dirname, "../files/input/Cube.stl");
    const stlBuffer = fsSync.readFileSync(stlPath);

    await request
      .post("/slice")
      .field("bundle", bundleId)
      .field("printerName", "Bambu Lab H2D 0.4 nozzle")
      .field("processName", "0.20mm Standard @BBL H2D")
      .field("filamentName", "Bambu PLA Basic @BBL H2D")
      .attach("file", stlBuffer, "Cube.stl")
      .expect(200);
  }, 120_000);

  it("returns 404 when slicing references an unknown bundle id", async () => {
    const stlPath = path.join(__dirname, "../files/input/Cube.stl");
    const stlBuffer = fsSync.readFileSync(stlPath);

    await request
      .post("/slice")
      .field("bundle", "deadbeef00000000")
      .field("printerName", "anything")
      .field("processName", "anything")
      .field("filamentName", "anything")
      .attach("file", stlBuffer, "Cube.stl")
      .expect(404);
  });

  it("returns 404 when a preset name is unknown within a known bundle", async () => {
    const bundlePath = path.join(
      __dirname,
      "../files/input/H2D-bundle.bbscfg",
    );
    const bundleBuffer = fsSync.readFileSync(bundlePath);
    const upload = await request
      .post("/profiles/bundle")
      .attach("file", bundleBuffer, "H2D-bundle.bbscfg")
      .expect(201);
    const bundleId: string = upload.body.id;

    const stlPath = path.join(__dirname, "../files/input/Cube.stl");
    const stlBuffer = fsSync.readFileSync(stlPath);

    const res = await request
      .post("/slice")
      .field("bundle", bundleId)
      .field("printerName", "# Bambu Lab H2D 0.4 nozzle")
      .field("processName", "Imaginary Process")
      .field("filamentName", "# Bambu PLA Basic @BBL H2D")
      .attach("file", stlBuffer, "Cube.stl")
      .expect(404);

    expect(res.body.message ?? res.body.error).toMatch(
      /process preset "Imaginary Process" not found/i,
    );
  });
});

describe("Bundle CRUD endpoints", () => {
  let originalDataPath: string | undefined;
  let scratchRoot: string;

  beforeAll(async () => {
    originalDataPath = process.env.DATA_PATH;
    scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-crud-e2e-"));
    process.env.DATA_PATH = scratchRoot;
  });

  afterAll(async () => {
    if (originalDataPath === undefined) {
      delete process.env.DATA_PATH;
    } else {
      process.env.DATA_PATH = originalDataPath;
    }
    await fs.rm(scratchRoot, { recursive: true, force: true });
  });

  it("supports POST → GET (single + list) → DELETE roundtrip", async () => {
    const bundlePath = path.join(
      __dirname,
      "../files/input/H2D-bundle.bbscfg",
    );
    const bundleBuffer = fsSync.readFileSync(bundlePath);

    // POST: returns 201 + summary
    const upload = await request
      .post("/profiles/bundle")
      .attach("file", bundleBuffer, "H2D-bundle.bbscfg")
      .expect(201);
    const bundleId: string = upload.body.id;
    expect(upload.body.printer_preset_name).toBe("# Bambu Lab H2D 0.4 nozzle");

    // GET single
    const single = await request
      .get(`/profiles/bundles/${bundleId}`)
      .expect(200);
    expect(single.body.id).toBe(bundleId);

    // GET list
    const list = await request.get("/profiles/bundles").expect(200);
    expect(Array.isArray(list.body)).toBe(true);
    expect(list.body.find((b: { id: string }) => b.id === bundleId)).toBeTruthy();

    // DELETE
    await request.delete(`/profiles/bundles/${bundleId}`).expect(204);

    // GET after delete → 404
    await request.get(`/profiles/bundles/${bundleId}`).expect(404);
  });

  it("rejects an upload that isn't a .bbscfg / .zip", async () => {
    const stlPath = path.join(__dirname, "../files/input/Cube.stl");
    const stlBuffer = fsSync.readFileSync(stlPath);
    await request
      .post("/profiles/bundle")
      .attach("file", stlBuffer, "Cube.stl")
      .expect(400);
  });
});
