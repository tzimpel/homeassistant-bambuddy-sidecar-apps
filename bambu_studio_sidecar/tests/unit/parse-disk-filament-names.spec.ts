import { describe, expect, it } from "vitest";
import { parseDiskFilamentNames } from "../../src/routes/slicing/slicing.service";

describe("parseDiskFilamentNames", () => {
  it("returns an empty list when neither field is set", () => {
    expect(parseDiskFilamentNames({})).toEqual([]);
  });

  it("falls back to legacy single `filament` when `filaments` is missing", () => {
    expect(parseDiskFilamentNames({ filament: "Bambu PLA Black" })).toEqual([
      "Bambu PLA Black",
    ]);
  });

  it("splits comma-separated `filaments`", () => {
    expect(
      parseDiskFilamentNames({ filaments: "Bambu PLA Black,Bambu PLA White" }),
    ).toEqual(["Bambu PLA Black", "Bambu PLA White"]);
  });

  it("splits semicolon-separated `filaments` (CLI native delimiter)", () => {
    expect(
      parseDiskFilamentNames({ filaments: "Bambu PLA Black;Bambu PLA White" }),
    ).toEqual(["Bambu PLA Black", "Bambu PLA White"]);
  });

  it("trims whitespace and drops empty entries", () => {
    expect(
      parseDiskFilamentNames({
        filaments: " Bambu PLA Black , , Bambu PLA White ; ",
      }),
    ).toEqual(["Bambu PLA Black", "Bambu PLA White"]);
  });

  it("prefers `filaments` over the legacy `filament` field", () => {
    // Caller explicitly upgraded to the array shape — ignore the legacy
    // singular so a stale field can't sneak back in as a third entry.
    expect(
      parseDiskFilamentNames({
        filament: "LegacyName",
        filaments: "Multi A,Multi B",
      }),
    ).toEqual(["Multi A", "Multi B"]);
  });
});
