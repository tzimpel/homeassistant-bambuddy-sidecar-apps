import { describe, expect, it } from "vitest";
import { request } from "./setup";
import fs from "fs";
import path from "path";

// Real-world OrcaSlicer / BambuStudio profile exports always inherit from a
// user-facing preset name (e.g. "Bambu Lab X1 Carbon 0.4 nozzle") rather
// than from the low-level fdm_* templates the CLI bakes into its preset
// registry. The CLI rejects the user-facing form with "input preset file
// is invalid and can not be parsed". The profile resolver bridges that
// gap by walking the inheritance chain against the bundled BBL/ profiles
// until it reaches an fdm_* parent the CLI accepts.
describe("STL Slicing - delta profile resolution", () => {
  it("resolves user-facing inherits and slices successfully", async () => {
    const filePath = path.join(__dirname, "../files/input/Cube.stl");
    const fileBuffer = fs.readFileSync(filePath);

    const printerPath = path.join(
      __dirname,
      "../files/input/delta-printer.json",
    );
    const printerBuffer = fs.readFileSync(printerPath);

    const presetPath = path.join(
      __dirname,
      "../files/input/delta-process.json",
    );
    const presetBuffer = fs.readFileSync(presetPath);

    const filamentPath = path.join(__dirname, "../files/input/filament.json");
    const filamentBuffer = fs.readFileSync(filamentPath);

    const response = await request
      .post("/slice")
      .attach("file", fileBuffer, "Cube.stl")
      .attach("printerProfile", printerBuffer, "printer.json")
      .attach("presetProfile", presetBuffer, "process.json")
      .attach("filamentProfile", filamentBuffer, "filament.json")
      .expect(200)
      .expect("x-print-time-seconds", /[0-9]+/)
      .expect("x-filament-used-g", /[0-9.]+/)
      .expect("x-filament-used-mm", /[0-9.]+/);

    const printTime = Number(response.headers["x-print-time-seconds"]);
    const filamentUsedG = Number(response.headers["x-filament-used-g"]);
    const filamentUsedMm = Number(response.headers["x-filament-used-mm"]);

    expect(printTime).toBeGreaterThan(0);
    expect(filamentUsedG).toBeGreaterThan(0);
    expect(filamentUsedMm).toBeGreaterThan(0);
  });

  it("returns 400 when an uploaded profile is not valid JSON", async () => {
    const filePath = path.join(__dirname, "../files/input/Cube.stl");
    const fileBuffer = fs.readFileSync(filePath);

    const printerPath = path.join(__dirname, "../files/input/printer.json");
    const printerBuffer = fs.readFileSync(printerPath);

    const presetPath = path.join(__dirname, "../files/input/process.json");
    const presetBuffer = fs.readFileSync(presetPath);

    // Pre-flight rejection: the resolver parses uploaded profiles as a
    // first-class step now, so malformed JSON surfaces a 400 client error
    // instead of getting passed through to the CLI as a 500.
    const malformedFilament = Buffer.from("{ this is not valid json");

    await request
      .post("/slice")
      .attach("file", fileBuffer, "Cube.stl")
      .attach("printerProfile", printerBuffer, "printer.json")
      .attach("presetProfile", presetBuffer, "process.json")
      .attach("filamentProfile", malformedFilament, "filament.json")
      .expect(400);
  });
});
