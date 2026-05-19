import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { uploadJson, uploadBundle } from "../../middleware/upload";
import type { Category } from "../slicing/models";
import {
  saveSetting,
  listSettings,
  getSetting,
  deleteSetting,
} from "./settings.service";
import {
  importBundle,
  listBundles,
  readBundleSummary,
  deleteBundle,
} from "./bundle.service";
import { AppError } from "../../middleware/error";
import { getDefaultBundledProfilesPath } from "../slicing/profile-resolver";

const router = Router();

// In-process cache for the bundled-profiles index. The bundle is read from the
// slicer's read-only `resources/profiles/BBL/` tree, which only changes when
// the container image is rebuilt — a long TTL is safe and avoids re-reading
// hundreds of JSON files on every Slice modal open. `null` = "not yet built".
type BundledFilament = {
  name: string;
  base_id: string | null;
  // Filament-only metadata. Bambuddy uses these to pre-pick a profile per
  // plate slot in the SliceModal multi-color flow. Bundled BBL profiles
  // commonly carry `filament_type` on the leaf preset; `filament_colour` is
  // typically missing on bundled profiles (color is a runtime spool attribute,
  // not a profile attribute) but populated when present so the consumer can
  // do exact-match where possible.
  filament_type: string | null;
  filament_colour: string | null;
};
type BundledIndex = {
  printer: { name: string; base_id: string | null }[];
  process: { name: string; base_id: string | null }[];
  filament: BundledFilament[];
};
let bundledIndexCache: BundledIndex | null = null;
let bundledIndexCachedAt = 0;
const BUNDLED_CACHE_TTL_MS = 60 * 60 * 1000; // 1h

router.get("/bundled", async (_req, res) => {
  // Bambuddy SliceModal calls this to populate the "Standard" tier of profile
  // dropdowns. Empty arrays are returned (200, not 503) when the bundled tree
  // can't be located — callers degrade to "no standard tier" without surfacing
  // a confusing error.
  const bundledPath = getDefaultBundledProfilesPath();
  if (!bundledPath) {
    res.status(200).json({ printer: [], process: [], filament: [] });
    return;
  }

  const now = Date.now();
  if (bundledIndexCache && now - bundledIndexCachedAt < BUNDLED_CACHE_TTL_MS) {
    res.status(200).json(bundledIndexCache);
    return;
  }

  const result: BundledIndex = {
    printer: await readBundledDir(path.join(bundledPath, "machine"), false),
    process: await readBundledDir(path.join(bundledPath, "process"), false),
    filament: (await readBundledDir(
      path.join(bundledPath, "filament"),
      true,
    )) as BundledFilament[],
  };
  bundledIndexCache = result;
  bundledIndexCachedAt = now;
  res.status(200).json(result);
});

async function readBundledDir(
  dir: string,
  includeFilamentMetadata: boolean,
): Promise<({ name: string; base_id: string | null } | BundledFilament)[]> {
  if (!fs.existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const out: ({ name: string; base_id: string | null } | BundledFilament)[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(dir, entry);
    try {
      const raw = await fs.promises.readFile(filePath, "utf8");
      const json = JSON.parse(raw) as {
        name?: string;
        inherits?: string;
        instantiation?: string;
        filament_type?: string | string[];
        filament_colour?: string | string[];
      };
      // Bundled profiles ship a mix of concrete presets and abstract bases
      // (e.g. `fdm_filament_pla`). Skip the latter so the slicer modal only
      // offers things a user can actually pick. `instantiation:"true"` is the
      // BBL convention for "this is a leaf preset".
      if (json.instantiation && json.instantiation !== "true") continue;
      if (!json.name) continue;
      const base = { name: json.name, base_id: json.inherits ?? null };
      if (includeFilamentMetadata) {
        out.push({
          ...base,
          filament_type: firstScalar(json.filament_type),
          filament_colour: firstScalar(json.filament_colour),
        });
      } else {
        out.push(base);
      }
    } catch {
      // Corrupted / unreadable individual file — skip without breaking the
      // rest of the listing.
      continue;
    }
  }
  // Stable alphabetical order by name so the dropdown is predictable.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function firstScalar(value: string | string[] | undefined): string | null {
  // OrcaSlicer stores per-extruder fields like `filament_type` as arrays
  // (e.g. `["PLA"]` for single-extruder, `["PLA", "PETG"]` for bi-material).
  // For pre-pick matching the first slot is what matters; the caller already
  // knows which slot it's matching to and a per-slot value isn't meaningful
  // on a bundled profile that hasn't been bound to a specific extruder yet.
  if (Array.isArray(value)) return value[0] ?? null;
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

// Bundle routes are defined before /:category so the literal "bundle" /
// "bundles" path segments don't get matched as a category by the more
// generic handlers below (validateCategory would reject them).
//
// POST /profiles/bundle
//   Upload a BambuStudio "Printer Preset Bundle" (.bbscfg). Idempotent —
//   re-uploading the same file yields the same bundle id and re-uses the
//   existing extracted directory.
router.post("/bundle", uploadBundle.single("file"), async (req, res) => {
  if (!req.file) {
    throw new AppError(400, "Bundle file is required");
  }
  const summary = await importBundle(req.file.buffer);
  res.status(201).json(summary);
});

// GET /profiles/bundles
//   List every bundle stored in DATA_PATH/bundles. Each summary names the
//   inner printer / process / filament presets a slice request can pick
//   from, so the consumer doesn't need a second round-trip per bundle to
//   build a Slice modal.
router.get("/bundles", async (_req, res) => {
  const bundles = await listBundles();
  res.status(200).json(bundles);
});

// GET /profiles/bundles/:id
//   Single-bundle summary (same shape as the list entry). Useful when a
//   client persists the id and wants to re-confirm the bundle still exists
//   and which presets it contains before showing slice options.
router.get("/bundles/:id", async (req, res) => {
  const summary = await readBundleSummary(req.params.id);
  res.status(200).json(summary);
});

// DELETE /profiles/bundles/:id
//   Remove a bundle and its extracted preset files. Slicing requests
//   referencing this id will fail with 404 afterwards.
router.delete("/bundles/:id", async (req, res) => {
  await deleteBundle(req.params.id);
  res.status(204).send();
});

router.post("/:category", uploadJson.single("file"), async (req, res) => {
  const name = req.body.name;

  validateName(name);

  if (!req.file) {
    throw new AppError(400, "File is required");
  }

  validateCategory(req.params.category as string);

  const content = JSON.parse(req.file.buffer.toString("utf8"));
  await saveSetting(req.params.category as Category, name, content);
  res.status(201).json({ name });
});

router.get("/:category", async (req, res) => {
  validateCategory(req.params.category);

  const settings = await listSettings(req.params.category as Category);
  res.status(200).json(settings);
});

router.get("/:category/:name", async (req, res) => {
  validateCategory(req.params.category);
  validateName(req.params.name);

  const setting = await getSetting(
    req.params.category as Category,
    req.params.name,
  );
  res.status(200).json(setting);
});

router.delete("/:category/:name", async (req, res) => {
  validateCategory(req.params.category);
  validateName(req.params.name);

  await deleteSetting(req.params.category as Category, req.params.name);
  res.status(204).send();
});

function validateCategory(category: string) {
  if (!category || !["printers", "presets", "filaments"].includes(category)) {
    throw new AppError(400, "Invalid or missing category");
  }
}

function validateName(name: string) {
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    throw new AppError(400, "Name cannot be empty");
  }
  if (!/^[a-zA-Z0-9]+$/.test(name)) {
    throw new AppError(400, "Name must only contain letters and numbers");
  }
}

export default router;
