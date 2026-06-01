import { promises as fs } from "fs";
import * as path from "path";
import { AppError } from "../../middleware/error";

export type ProfileCategory = "machine" | "process" | "filament";

export type ProfileJson = Record<string, unknown> & {
  type?: string;
  name?: string;
  inherits?: string;
};

export interface ResolveOptions {
  bundledProfilesPath: string;
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 16;

// `--load-settings` does not run the GUI's preset-registry resolver.
// Required fields like layer_change_gcode live on parent templates
// (fdm_machine_common etc.) that the CLI will NOT pull in implicitly.
// The resolver therefore walks the chain fully — to the root — and emits
// a flat profile with everything baked in. Dangling inherits values that
// don't map to a bundled file are dropped silently (matches how upstream
// fixtures with stale `fdm_process_bbl_0.20` inherits work today).
export async function resolveProfile(
  profile: ProfileJson,
  category: ProfileCategory,
  options: ResolveOptions,
): Promise<ProfileJson> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  let current: ProfileJson = { ...profile };
  stripUserSentinels(current);
  let depth = 0;

  while (
    typeof current.inherits === "string" &&
    current.inherits.length > 0
  ) {
    if (depth >= maxDepth) {
      throw new AppError(
        500,
        "Profile inheritance chain exceeded maximum depth",
        `category=${category} depth=${depth} stopped at inherits=${current.inherits}`,
      );
    }

    const parentName = current.inherits;
    const parentPath = path.join(
      options.bundledProfilesPath,
      category,
      `${parentName}.json`,
    );

    let parentRaw: string;
    try {
      parentRaw = await fs.readFile(parentPath, "utf-8");
    } catch {
      delete current.inherits;
      break;
    }

    let parent: ProfileJson;
    try {
      parent = JSON.parse(parentRaw) as ProfileJson;
    } catch (err) {
      throw new AppError(
        500,
        `Bundled profile is not valid JSON: "${parentName}"`,
        `category=${category} path=${parentPath} ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    current = mergeProfiles(parent, current);
    depth += 1;
  }

  // After full flattening the output is functionally a system preset, so
  // mark it as one (see normalizeFromField for the casing rationale).
  // materializeProfile also calls this unconditionally so System-tier
  // exports with `inherits: ""` — which never reach this code path — get
  // the same treatment.
  normalizeFromField(current);

  // OrcaSlicer's GUI prefixes user clones of system presets with "# "
  // (e.g. "# Bambu Lab X1 Carbon 0.4 nozzle"). The CLI's compatibility
  // check matches the printer's `name` literally against each profile's
  // `compatible_printers` list, which contains the un-prefixed system
  // names. Strip the prefix so a clone-and-export workflow lines up
  // with the bundled compat lists.
  if (typeof current.name === "string" && current.name.startsWith("# ")) {
    current.name = current.name.slice(2);
  }

  return current;
}

/**
 * Strip "auto" sentinel values from a user-exported delta in place.
 *
 * OrcaSlicer's GUI lets users leave many numeric fields set to `-1`
 * (or array equivalents) meaning "use the slicer's default". The CLI's
 * range validation rejects these literally — e.g.
 * `prime_tower_brim_width: "-1" not in range [0, ∞]`. By dropping the
 * field from the user's delta, the merged profile picks up whatever
 * value its bundled ancestor sets, or the CLI's compiled-in default.
 *
 * Empty strings get the same treatment because the GUI emits them for
 * fields the user hasn't customized; the CLI rejects them where a
 * concrete value is expected.
 */
function stripUserSentinels(profile: ProfileJson): void {
  for (const k of Object.keys(profile)) {
    const v = profile[k];
    if (v === "-1" || v === "") {
      delete profile[k];
    } else if (
      Array.isArray(v) &&
      v.length > 0 &&
      v.every((x) => x === "-1" || x === "")
    ) {
      delete profile[k];
    }
  }
}

// BambuStudio's "Export Preset Bundle" omits `type:` on System-tier presets
// (the GUI infers it from the directory the file lived in) and emits
// `inherits: ""` for them, so resolveProfile's inherits walk never runs and
// can't pick up `type` from a parent. The CLI's --load-settings/--load-filaments
// parser then sees a type-less file, logs `operator(): unknown config type
// ... in load-settings`, writes `error_string: "The input preset file is
// invalid and can not be parsed.", return_code: -5` to result.json, and
// exits 0. Stamp the category we already know.
export function ensureProfileType(
  profile: ProfileJson,
  category: ProfileCategory,
): ProfileJson {
  if (typeof profile.type !== "string" || profile.type.length === 0) {
    profile.type = category;
  }
  return profile;
}

// The CLI's compatibility check accepts `from: "system"` (lowercase) as the
// canonical system-tier marker and rejects everything else with
// `from <value> unsupported` (return_code -5, surfaced as the same
// "input preset file is invalid and can not be parsed." rejection).
//
// Two casings appear in real exports:
//   - "User"   — user-cloned presets out of the OrcaSlicer/BambuStudio GUI.
//                After resolveProfile flattens the inherits chain, the
//                output is functionally a system preset and should be
//                marked as such.
//   - "System" — BambuStudio's "Export Preset Bundle" for a System-tier
//                root preset (printer / built-in filament) writes this
//                literally. The GUI accepts it because the GUI's own
//                check is case-insensitive; the CLI's is not.
//
// "Default" and other values are NOT remapped — those are distinct tiers
// the CLI handles, and silently rewriting them would mask a real
// mis-tagged file.
export function normalizeFromField(profile: ProfileJson): ProfileJson {
  if (profile.from === "User" || profile.from === "System") {
    profile.from = "system";
  }
  return profile;
}

export function mergeProfiles(
  parent: ProfileJson,
  child: ProfileJson,
): ProfileJson {
  const merged: ProfileJson = { ...parent, ...child };
  if (typeof parent.inherits === "string" && parent.inherits.length > 0) {
    merged.inherits = parent.inherits;
  } else {
    delete merged.inherits;
  }
  return merged;
}

export function getDefaultBundledProfilesPath(): string | undefined {
  const orcaPath = process.env.BUNDLED_PROFILES_PATH;
  if (orcaPath && orcaPath.length > 0) {
    return orcaPath;
  }
  if (process.env.ORCASLICER_PATH) {
    return path.join(
      path.dirname(process.env.ORCASLICER_PATH),
      "resources",
      "profiles",
      "BBL",
    );
  }
  return undefined;
}
