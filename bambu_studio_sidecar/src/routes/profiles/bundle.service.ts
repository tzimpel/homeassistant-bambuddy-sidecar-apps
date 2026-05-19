import { promises as fs } from "fs";
import { createHash } from "crypto";
import { join, dirname, basename } from "path";
import { Open } from "unzipper";
import { AppError } from "../../middleware/error";

// BambuStudio's "Export Preset Bundle" → "Printer preset bundle (.bbscfg)"
// produces a zip containing one printer JSON, N process JSONs, M filament
// JSONs, and a bundle_structure.json manifest indexing all of them. Each
// inner JSON is a delta with `inherits:` pointing at a BBL system preset
// (e.g. "Bambu Lab H2D 0.4 nozzle"); the existing inherits-resolver in
// slicing/profile-resolver.ts flattens those against the BBL bundle baked
// into the slicer install before invoking --load-settings/--load-filaments.
//
// We unzip imported bundles into DATA_PATH/bundles/<id>/ and use the bundle
// id + preset name as a stable selector at slice time. No transformation of
// the inner files happens at import — they are stored as-extracted so the
// resolver sees exactly what BambuStudio wrote.

const BUNDLES_DIR = "bundles";
const MANIFEST_FILENAME = "bundle_structure.json";
const ALLOWED_TOP_DIRS = new Set(["printer", "process", "filament"]);

export interface BundleManifest {
  bundle_id?: string;
  bundle_type?: string;
  printer_preset_name?: string;
  printer_config?: string[];
  process_config?: string[];
  filament_config?: string[];
  version?: string;
}

export interface BundleSummary {
  id: string;
  printer_preset_name: string;
  printer: string[];
  process: string[];
  filament: string[];
  version?: string;
}

function dataRoot(): string {
  return process.env.DATA_PATH || join(process.cwd(), "data");
}

function bundlesRoot(): string {
  return join(dataRoot(), BUNDLES_DIR);
}

function bundleDir(id: string): string {
  return join(bundlesRoot(), id);
}

// Deterministic short id derived from the zip's content hash. Re-uploading
// the same .bbscfg yields the same id, so duplicates collapse rather than
// piling up. 16 hex chars = 64 bits of entropy, plenty for collision
// avoidance on a per-installation bundle store.
export function computeBundleId(zip: Buffer): string {
  return createHash("sha256").update(zip).digest("hex").slice(0, 16);
}

// Strip "<category>/" prefix to get the leaf preset name without the .json
// extension — that's the form the slice selector uses.
function presetNameFromPath(p: string): string {
  return basename(p).replace(/\.json$/i, "");
}

// Path-traversal guard. Zip entry names are attacker-controlled, so any
// extraction loop must validate before joining onto the filesystem path.
// Reject:
//   - absolute paths
//   - parent traversal (`..` segment)
//   - top-level dirs other than printer/process/filament/manifest
//   - non-.json files (covers a stray cover.png or readme that an attacker
//     could try to use to overwrite something on disk)
function assertSafeEntryPath(entryName: string): void {
  if (entryName.startsWith("/") || /^[a-z]:[\\/]/i.test(entryName)) {
    throw new AppError(400, `Bundle entry has absolute path: ${entryName}`);
  }
  if (entryName.split(/[\\/]/).some((seg) => seg === ".." || seg === ".")) {
    throw new AppError(400, `Bundle entry has parent traversal: ${entryName}`);
  }
  if (entryName === MANIFEST_FILENAME) return;
  const top = entryName.split("/")[0];
  if (!ALLOWED_TOP_DIRS.has(top)) {
    throw new AppError(
      400,
      `Bundle entry not under printer/process/filament: ${entryName}`,
    );
  }
  if (!entryName.toLowerCase().endsWith(".json")) {
    throw new AppError(400, `Bundle contains non-JSON file: ${entryName}`);
  }
}

// Extract a bundle zip into DATA_PATH/bundles/<id>/. Idempotent: if the
// destination already exists (same content hash, same id), we no-op and
// return the existing summary. Returns the full BundleSummary either way.
export async function importBundle(zip: Buffer): Promise<BundleSummary> {
  if (zip.length === 0) {
    throw new AppError(400, "Bundle file is empty");
  }
  const id = computeBundleId(zip);
  const dir = bundleDir(id);

  // Already imported — short-circuit. The manifest read below will throw
  // 400 if the existing dir is somehow corrupt (someone hand-edited it),
  // which is the right failure mode.
  try {
    await fs.access(join(dir, MANIFEST_FILENAME));
    return await readBundleSummary(id);
  } catch {
    // not yet imported — fall through to extraction
  }

  let central;
  try {
    central = await Open.buffer(zip);
  } catch (err) {
    throw new AppError(
      400,
      "Bundle file is not a valid zip archive",
      err instanceof Error ? err.message : String(err),
    );
  }

  await fs.mkdir(dir, { recursive: true });

  let manifestRaw: string | undefined;
  for (const file of central.files) {
    if (file.type !== "File") continue;
    const entryName = file.path.replace(/\\/g, "/");
    assertSafeEntryPath(entryName);

    const out = join(dir, entryName);
    await fs.mkdir(dirname(out), { recursive: true });
    const content = await file.buffer();
    await fs.writeFile(out, content);

    if (entryName === MANIFEST_FILENAME) {
      manifestRaw = content.toString("utf-8");
    }
  }

  if (!manifestRaw) {
    // BambuStudio always emits bundle_structure.json. Its absence means the
    // upload wasn't a Printer Preset Bundle — most likely the user picked
    // "Filament preset bundle" or a single-category .zip from the export
    // dialog. Reject with a message that points them at the right export.
    await fs.rm(dir, { recursive: true, force: true });
    throw new AppError(
      400,
      "Bundle is missing bundle_structure.json — only Printer Preset Bundles (.bbscfg) are supported. Export via File → Export → Export Preset Bundle and pick 'Printer preset bundle'.",
    );
  }

  return await readBundleSummary(id);
}

// Build the user-facing summary by reading the manifest. Doing this on
// every import + list call (rather than caching) keeps the on-disk store
// authoritative — a user clearing /data/bundles/ recovers cleanly.
export async function readBundleSummary(id: string): Promise<BundleSummary> {
  let raw: string;
  try {
    raw = await fs.readFile(join(bundleDir(id), MANIFEST_FILENAME), "utf-8");
  } catch {
    throw new AppError(404, `Bundle "${id}" not found`);
  }
  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(raw) as BundleManifest;
  } catch (err) {
    throw new AppError(
      500,
      `Bundle "${id}" has unreadable manifest`,
      err instanceof Error ? err.message : String(err),
    );
  }
  return {
    id,
    printer_preset_name: manifest.printer_preset_name ?? "",
    printer: (manifest.printer_config ?? []).map(presetNameFromPath),
    process: (manifest.process_config ?? []).map(presetNameFromPath),
    filament: (manifest.filament_config ?? []).map(presetNameFromPath),
    version: manifest.version,
  };
}

export async function listBundles(): Promise<BundleSummary[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(bundlesRoot());
  } catch {
    return [];
  }
  const summaries: BundleSummary[] = [];
  for (const entry of entries) {
    try {
      summaries.push(await readBundleSummary(entry));
    } catch {
      // Skip directories with broken/missing manifest rather than failing
      // the whole listing — the rest of the user's bundles are still usable.
      continue;
    }
  }
  // Stable order so paginated UIs render consistently.
  summaries.sort((a, b) =>
    a.printer_preset_name.localeCompare(b.printer_preset_name),
  );
  return summaries;
}

export async function deleteBundle(id: string): Promise<void> {
  const dir = bundleDir(id);
  try {
    await fs.access(dir);
  } catch {
    throw new AppError(404, `Bundle "${id}" not found`);
  }
  await fs.rm(dir, { recursive: true, force: true });
}

// Resolve a "<category>/<preset name>" selector to the on-disk JSON file
// path. The bundle stores files under their original `# ...json` names
// (with the BambuStudio "user clone" prefix), so we accept the name with
// or without the leading `# ` for ergonomic API use.
export async function resolveBundlePresetPath(
  id: string,
  category: "printer" | "process" | "filament",
  presetName: string,
): Promise<string> {
  const dir = join(bundleDir(id), category);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    throw new AppError(
      404,
      `Bundle "${id}" has no ${category} directory`,
    );
  }
  const wanted = presetName.replace(/\.json$/i, "");
  for (const entry of entries) {
    const stem = entry.replace(/\.json$/i, "");
    if (stem === wanted || stem === `# ${wanted}` || `# ${stem}` === wanted) {
      return join(dir, entry);
    }
  }
  throw new AppError(
    404,
    `${category} preset "${presetName}" not found in bundle "${id}"`,
  );
}

export const __test__ = {
  bundleDir,
  bundlesRoot,
  assertSafeEntryPath,
};
