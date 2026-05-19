import { promises as fs, createReadStream } from "fs";
import * as path from "path";
import * as os from "os";
import { spawn, execFile } from "child_process";
import { AppError } from "../../middleware/error";
import type {
  SlicingSettings,
  SliceResult,
  SliceMetaData,
  UploadedProfiles,
} from "./models";
import { Open } from "unzipper";
import {
  getDefaultBundledProfilesPath,
  resolveProfile,
  type ProfileCategory,
  type ProfileJson,
} from "./profile-resolver";
import { progressStore, parseProgressLine } from "./progress-store";
import { resolveBundlePresetPath } from "../profiles/bundle.service";

export async function sliceModel(
  file: Buffer,
  filename: string,
  settings: SlicingSettings,
  tempProfiles?: UploadedProfiles,
): Promise<SliceResult> {
  let workdir: string;
  let inPath: string;
  let inputDir: string;
  let outputDir: string;
  try {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), "slice-"));
    inputDir = path.join(workdir, "input");
    outputDir = path.join(workdir, "output");
    await fs.mkdir(inputDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });

    inPath = path.join(inputDir, filename);
    await fs.writeFile(inPath, file);
  } catch (error) {
    throw new AppError(
      500,
      "Failed to prepare slicing",
      error instanceof Error ? error.message : String(error),
    );
  }

  const basePath = process.env.DATA_PATH || path.join(process.cwd(), "data");
  const bundledProfilesPath = getDefaultBundledProfilesPath();

  let printerPath: string | undefined;
  let presetPath: string | undefined;
  const filamentPaths: string[] = [];

  try {
    // Bundle selectors take precedence over the flat-disk diskName lookup
    // when set: settings.bundle picks the .bbscfg the rest of the names
    // resolve against. printerName/processName/filamentName(s) are looked
    // up in DATA_PATH/bundles/<id>/{printer,process,filament}/. The result
    // is fed to materializeProfile via the existing diskName/diskBase path
    // — same code path, different source root.
    const bundlePrinter = await bundlePathOrUndefined(
      settings.bundle,
      "printer",
      settings.printerName,
    );
    const bundleProcess = await bundlePathOrUndefined(
      settings.bundle,
      "process",
      settings.processName,
    );
    const bundleFilamentNames = parseBundleFilamentNames(settings);
    const bundleFilamentPaths: string[] = [];
    for (const name of bundleFilamentNames) {
      const p = await bundlePathOrUndefined(settings.bundle, "filament", name);
      if (p) bundleFilamentPaths.push(p);
    }

    printerPath = await materializeProfile({
      inputDir,
      filename: "printer.json",
      category: "machine",
      uploaded: tempProfiles?.printer,
      directPath: bundlePrinter,
      diskName: settings.printer,
      diskBase: basePath,
      diskCategoryDir: "printers",
      bundledProfilesPath,
    });
    presetPath = await materializeProfile({
      inputDir,
      filename: "preset.json",
      category: "process",
      uploaded: tempProfiles?.preset,
      directPath: bundleProcess,
      diskName: settings.preset,
      diskBase: basePath,
      diskCategoryDir: "presets",
      bundledProfilesPath,
    });

    // Resolve filaments in plate order: each upload buffer (or each
    // comma-separated diskName, or each bundle filament path) becomes a
    // separate filament_N.json on disk. The CLI later joins them as
    // semicolon-separated --load-filaments arg.
    // Four input shapes, in priority order:
    //   1. tempProfiles.filaments[]      — N uploaded buffers
    //   2. bundleFilamentPaths           — N paths inside a stored bundle
    //   3. settings.filaments            — comma/semicolon-separated diskNames
    //   4. settings.filament             — legacy single diskName
    const uploadedFilaments = tempProfiles?.filaments ?? [];
    const diskFilamentNames = parseDiskFilamentNames(settings);
    const filamentSpecs: Array<{
      uploaded?: Buffer;
      directPath?: string;
      diskName?: string;
    }> =
      uploadedFilaments.length > 0
        ? uploadedFilaments.map((u) => ({ uploaded: u }))
        : bundleFilamentPaths.length > 0
        ? bundleFilamentPaths.map((p) => ({ directPath: p }))
        : diskFilamentNames.map((n) => ({ diskName: n }));
    for (let i = 0; i < filamentSpecs.length; i++) {
      const p = await materializeProfile({
        inputDir,
        filename: `filament_${i + 1}.json`,
        category: "filament",
        uploaded: filamentSpecs[i].uploaded,
        directPath: filamentSpecs[i].directPath,
        diskName: filamentSpecs[i].diskName,
        diskBase: basePath,
        diskCategoryDir: "filaments",
        bundledProfilesPath,
      });
      if (p) filamentPaths.push(p);
    }
  } catch (error) {
    await fs.rm(workdir, { recursive: true, force: true });
    throw error;
  }

  const args: string[] = [];

  if (settings.exportType === "3mf") {
    args.push("--export-3mf", "result.3mf");
  }

  const sliceArg = settings.plate === undefined ? "1" : settings.plate;
  args.push("--slice", sliceArg);

  if (settings.arrange !== undefined) {
    args.push("--arrange", settings.arrange ? "1" : "0");
  }

  if (settings.orient !== undefined) {
    args.push("--orient", settings.orient ? "1" : "0");
  }

  if (printerPath && presetPath) {
    args.push("--load-settings", `${printerPath};${presetPath}`);
  }

  if (filamentPaths.length > 0) {
    // OrcaSlicer / BambuStudio CLI expects ALL filament profiles in a single
    // --load-filaments arg, semicolon-separated, in plate slot order.
    args.push("--load-filaments", filamentPaths.join(";"));
  }

  if (settings.bedType) {
    args.push("--curr-bed-type", settings.bedType);
  }

  if (settings.multicolorOnePlate) {
    args.push("--allow-multicolor-oneplate");
  }

  args.push("--allow-newer-file");
  args.push("--outputdir", outputDir);

  args.push(inPath);

  if (!process.env.ORCASLICER_PATH) {
    throw new AppError(
      500,
      "Slicing is not configured properly on the server",
      "ORCASLICER_PATH environment variable is not defined",
    );
  }

  // Capture stdout + stderr so failure diagnostics survive the spawn-error
  // wrapper. The CLI prints the *reason* it rejected an input (range checks,
  // missing fields, profile compat failures) to stderr; we keep both streams
  // around so we can include them in the AppError that propagates to
  // Bambuddy. We also wire up `--pipe` to a per-request FIFO so the slicer's
  // structured JSON progress events land in the ProgressStore — Bambuddy
  // polls /slice/progress/:requestId in parallel with this call to drive
  // a live progress toast.
  let cliStdout = "";
  let cliStderr = "";
  const requestId = settings.requestId;
  let fifoPath: string | undefined;
  let progressReader: { close: () => void } | undefined;
  if (requestId) {
    progressStore.start(requestId);
    fifoPath = path.join(workdir, `progress.fifo`);
    try {
      // mkfifo isn't in node's fs API; shell out via the busybox/util-linux
      // binary that's present in every distro the sidecar runs on.
      await new Promise<void>((resolve, reject) => {
        execFile("mkfifo", [fifoPath as string], (err) => (err ? reject(err) : resolve()));
      });
      args.push("--pipe", fifoPath);
      progressReader = startProgressReader(fifoPath, requestId);
    } catch (err) {
      // FIFO creation is best-effort — if it fails (e.g. mkfifo missing,
      // unsupported FS), fall back to the no-progress path rather than
      // failing the slice.
      console.warn(`Progress FIFO setup failed: ${(err as Error).message}`);
      fifoPath = undefined;
    }
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.env.ORCASLICER_PATH as string, args, {
        // Inherit env so DISPLAY / XDG_* etc. (used by some slicer plugins)
        // remain consistent with the previous execFile invocation.
        env: process.env,
      });
      // Buffer stdout/stderr — same 16MB cap the old execFile path used.
      const STDOUT_LIMIT = 16 * 1024 * 1024;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutLen = 0;
      let stderrLen = 0;
      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdoutLen + chunk.length <= STDOUT_LIMIT) {
          stdoutChunks.push(chunk);
          stdoutLen += chunk.length;
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderrLen + chunk.length <= STDOUT_LIMIT) {
          stderrChunks.push(chunk);
          stderrLen += chunk.length;
        }
      });
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        cliStdout = Buffer.concat(stdoutChunks).toString("utf-8");
        cliStderr = Buffer.concat(stderrChunks).toString("utf-8");
        if (code === 0) {
          resolve();
        } else {
          const detail = signal ? `signal ${signal}` : `exit code ${code}`;
          reject(new Error(`Slicer process failed (${detail})`));
        }
      });
    });
  } catch (err) {
    if (progressReader) progressReader.close();
    if (requestId) progressStore.finish(requestId);
    const resultJsonPath = path.join(outputDir, "result.json");
    let json;
    try {
      const content = await fs.readFile(resultJsonPath, "utf-8");
      json = JSON.parse(content);
    } catch {
      await fs.rm(workdir, { recursive: true, force: true });
      throw new AppError(
        500,
        "Failed to slice the model",
        formatCliFailure(err, cliStdout, cliStderr),
      );
    }

    if (json?.error_string) {
      await fs.rm(workdir, { recursive: true, force: true });
      throw new AppError(
        500,
        `Slicing failed with error from slicer: ${json.error_string}`,
        formatCliFailure(err, cliStdout, cliStderr),
      );
    }

    await fs.rm(workdir, { recursive: true, force: true });
    throw new AppError(
      500,
      "Failed to slice the model",
      formatCliFailure(err, cliStdout, cliStderr),
    );
  }

  // Slice succeeded — close the progress reader and schedule the
  // request_id's grace cleanup so a final poll still sees the terminal
  // frame ("All done, Success" / total_percent=100).
  if (progressReader) progressReader.close();
  if (requestId) progressStore.finish(requestId);

  const files = await fs.readdir(outputDir);
  let resultFiles: string[];

  if (settings.exportType === "3mf") {
    resultFiles = files
      .filter((f) => f.toLowerCase().endsWith(".3mf"))
      .map((f) => path.join(outputDir, f));
  } else {
    resultFiles = files
      .filter((f) => f.toLowerCase().endsWith(".gcode"))
      .map((f) => path.join(outputDir, f));
  }

  return { gcodes: resultFiles, workdir };
}

/**
 * Extract metadata (print time, filament used) from a G-code or 3MF file.
 * @param filePath The path to the file.
 * @returns The extracted metadata.
 */
export async function getMetaDataFromFile(
  filePath: string,
): Promise<SliceMetaData> {
  let data = {
    printTime: 0,
    filamentUsedG: 0,
    filamentUsedMm: 0,
  };

  if (filePath.endsWith(".gcode")) {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      data = parseMetaDataFromString(content);
    } catch (error) {
      console.error(
        "Failed to read G-code file for metadata extraction:",
        error,
      );
    }
  } else if (filePath.endsWith(".3mf")) {
    try {
      const dir = await Open.file(filePath);
      for (const file of dir.files.filter((f) => f.path.endsWith(".gcode"))) {
        const content = (await file.buffer()).toString("utf-8");
        const metaData = parseMetaDataFromString(content);
        data.printTime += metaData.printTime;
        data.filamentUsedG += metaData.filamentUsedG;
        data.filamentUsedMm += metaData.filamentUsedMm;
      }
    } catch (error) {
      console.error("Failed to read 3MF file for metadata extraction:", error);
    }
  }

  return data;
}

/**
 * Build a useful `causeMessage` for an AppError when the slicer CLI exited
 * non-zero. The default `execFile` error message is just
 * `Command failed: <full cmdline>` — useless for diagnosing why the slicer
 * rejected the input. Slicer CLIs print actual reasons (range checks,
 * profile compat failures, missing keys) to **stderr**, occasionally with
 * additional context on stdout. Combine them, prefer stderr (where the
 * meaningful diagnostic lives), and trim aggressively so massive G-code
 * dumps from successful-but-late failures don't blow out the response.
 */
/**
 * Spawn a non-blocking reader for the slicer's progress FIFO. Each line
 * is parsed and pushed into the ProgressStore. Returns a closer; the
 * caller is responsible for invoking it on slice exit (success OR
 * failure) so the read stream doesn't leak.
 *
 * The FIFO is opened *after* `--pipe` is on the args list — orca creates
 * the writer side when it spawns, and createReadStream on a missing FIFO
 * would ENOENT. mkfifo runs synchronously beforehand so the read open
 * always finds the FIFO present even if the slicer is slow to attach.
 */
function startProgressReader(
  fifoPath: string,
  requestId: string,
): { close: () => void } {
  let buffer = "";
  let closed = false;
  // The FIFO read end blocks until the slicer opens the write end.
  // Node's createReadStream + flag 'r' opens with O_RDONLY which blocks;
  // we want O_NONBLOCK so the read open returns immediately and waits
  // for data via epoll. If the slicer dies before writing anything, the
  // read end gets EOF cleanly instead of hanging.
  const stream = createReadStream(fifoPath, {
    flags: "r",
    encoding: "utf-8",
  });
  stream.on("data", (chunk: string | Buffer) => {
    if (closed) return;
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const parsed = parseProgressLine(line);
      if (parsed) {
        progressStore.update(requestId, {
          stage: parsed.stage ?? "",
          totalPercent: parsed.totalPercent ?? 0,
          platePercent: parsed.platePercent ?? 0,
          plateIndex: parsed.plateIndex ?? 0,
          plateCount: parsed.plateCount ?? 0,
        });
      }
    }
  });
  stream.on("error", (err) => {
    // Reader errors must not bubble — progress is best-effort. Common
    // case: slicer exits before writing anything, FIFO read end gets
    // EBADF when we close the write side without flushing.
    console.warn(`Progress FIFO read error (${requestId}): ${err.message}`);
  });
  return {
    close: () => {
      closed = true;
      stream.destroy();
    },
  };
}

function formatCliFailure(
  err: unknown,
  stdout: string,
  stderr: string,
): string {
  const head = err instanceof Error ? err.message : String(err);
  const stderrTrim = stderr.trim();
  const stdoutTrim = stdout.trim();
  const parts: string[] = [head];
  if (stderrTrim) parts.push(`stderr: ${truncate(stderrTrim, 4096)}`);
  if (stdoutTrim) parts.push(`stdout: ${truncate(stdoutTrim, 4096)}`);
  return parts.join("\n");
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}… [truncated ${s.length - max} chars]` : s;
}

export function parseDiskFilamentNames(settings: SlicingSettings): string[] {
  // settings.filaments wins over the legacy single settings.filament so a
  // multi-color caller can drop the legacy field without it sneaking back in.
  if (settings.filaments && settings.filaments.length > 0) {
    return settings.filaments
      .split(/[,;]/)
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
  }
  if (settings.filament && settings.filament.length > 0) {
    return [settings.filament];
  }
  return [];
}

export function parseBundleFilamentNames(settings: SlicingSettings): string[] {
  // Mirrors parseDiskFilamentNames but reads the bundle-specific fields.
  // Exists as a separate function rather than overloading filaments/filament
  // because the bundle path may want to coexist with legacy disk-name input
  // (e.g. printer/process from bundle, single legacy filament from disk).
  if (settings.filamentNames && settings.filamentNames.length > 0) {
    return settings.filamentNames
      .split(/[,;]/)
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
  }
  if (settings.filamentName && settings.filamentName.length > 0) {
    return [settings.filamentName];
  }
  return [];
}

// Convenience wrapper that returns undefined when either the bundle id or
// preset name is missing — lets the caller pass the result straight to
// materializeProfile's `directPath`, where undefined means "no bundle
// source, fall back to upload/disk lookup as usual".
async function bundlePathOrUndefined(
  bundleId: string | undefined,
  category: "printer" | "process" | "filament",
  presetName: string | undefined,
): Promise<string | undefined> {
  if (!bundleId || !presetName) return undefined;
  return await resolveBundlePresetPath(bundleId, category, presetName);
}

function parseMetaDataFromString(content: string): SliceMetaData {
  const data: SliceMetaData = {
    printTime: 0,
    filamentUsedG: 0,
    filamentUsedMm: 0,
  };

  try {
    // Extract print time
    const timeIndex = content.indexOf("total estimated time");
    if (timeIndex !== -1) {
      const timeSlice = content.slice(timeIndex, timeIndex + 80);
      const timeMatch = timeSlice.match(
        /total estimated time:\s*((?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?)/i,
      );
      if (timeMatch) {
        const days = parseInt(timeMatch[2] || "0");
        const hours = parseInt(timeMatch[3] || "0");
        const minutes = parseInt(timeMatch[4] || "0");
        const seconds = parseInt(timeMatch[5] || "0");
        data.printTime = days * 86400 + hours * 3600 + minutes * 60 + seconds;
      }
    }

    if (timeIndex === -1) {
      const altTimeIndex = content.indexOf(
        "; estimated printing time (normal mode)",
      );
      if (altTimeIndex !== -1) {
        const timeSlice = content.slice(altTimeIndex, altTimeIndex + 100);
        const timeMatch = timeSlice.match(
          /; estimated printing time \(normal mode\) = \s*((?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?)/i,
        );
        if (timeMatch) {
          const days = parseInt(timeMatch[2] || "0");
          const hours = parseInt(timeMatch[3] || "0");
          const minutes = parseInt(timeMatch[4] || "0");
          const seconds = parseInt(timeMatch[5] || "0");
          data.printTime = days * 86400 + hours * 3600 + minutes * 60 + seconds;
        }
      }
    }

    // Extract filament used [mm]
    const filamentMmIndex = content.indexOf("; filament used [mm]");
    if (filamentMmIndex !== -1) {
      const filamentMmSlice = content.slice(
        filamentMmIndex,
        filamentMmIndex + 50,
      );
      const mmMatch = filamentMmSlice.match(
        /; filament used \[mm\] = \s*(\d+(\.\d+)?)/,
      );
      if (mmMatch) {
        data.filamentUsedMm = parseFloat(mmMatch[1]);
      }
    }

    // Extract filament used [g]
    const filamentGIndex = content.indexOf("; filament used [g]");
    if (filamentGIndex !== -1) {
      const filamentGSlice = content.slice(filamentGIndex, filamentGIndex + 50);
      const gMatch = filamentGSlice.match(
        /; filament used \[g\] = \s*(\d+(\.\d+)?)/,
      );
      if (gMatch) {
        data.filamentUsedG = parseFloat(gMatch[1]);
      }
    }
  } catch (err) {
    console.error("Failed to parse metadata from string:", err);
  }

  return data;
}

interface MaterializeProfileArgs {
  inputDir: string;
  filename: string;
  category: ProfileCategory;
  uploaded: Buffer | undefined;
  // Pre-resolved on-disk path. Used by the bundle selector to point at a
  // file inside DATA_PATH/bundles/<id>/<category>/. Skips diskName's
  // implicit "<base>/<categoryDir>/<name>.json" composition because the
  // bundle layout doesn't follow that flat shape.
  directPath?: string | undefined;
  diskName: string | undefined;
  diskBase: string;
  diskCategoryDir: string;
  bundledProfilesPath: string | undefined;
}

async function materializeProfile(
  args: MaterializeProfileArgs,
): Promise<string | undefined> {
  let raw: string;
  let isUserUpload: boolean;

  if (args.uploaded && args.uploaded.length > 0) {
    raw = args.uploaded.toString("utf-8");
    isUserUpload = true;
  } else if (args.directPath) {
    try {
      raw = await fs.readFile(args.directPath, "utf-8");
    } catch (err) {
      throw new AppError(
        500,
        `Failed to read ${args.category} profile from bundle: ${args.directPath}`,
        err instanceof Error ? err.message : String(err),
      );
    }
    isUserUpload = false;
  } else if (args.diskName) {
    const diskPath = path.join(
      args.diskBase,
      args.diskCategoryDir,
      `${args.diskName}.json`,
    );
    try {
      raw = await fs.readFile(diskPath, "utf-8");
    } catch (err) {
      throw new AppError(
        500,
        `Failed to read stored ${args.category} profile "${args.diskName}"`,
        err instanceof Error ? err.message : String(err),
      );
    }
    isUserUpload = false;
  } else {
    return undefined;
  }

  let profile: ProfileJson;
  try {
    profile = JSON.parse(raw) as ProfileJson;
  } catch (err) {
    const status = isUserUpload ? 400 : 500;
    const sourceLabel = isUserUpload ? "uploaded" : "stored";
    throw new AppError(
      status,
      `Invalid JSON in ${sourceLabel} ${args.category} profile`,
      err instanceof Error ? err.message : String(err),
    );
  }

  if (typeof profile.inherits === "string" && profile.inherits.length > 0) {
    if (!args.bundledProfilesPath) {
      throw new AppError(
        500,
        `Profile resolution required but bundled profiles path is not configured (category=${args.category} inherits="${profile.inherits}")`,
        "Set BUNDLED_PROFILES_PATH or ORCASLICER_PATH so the resolver can locate resources/profiles/BBL.",
      );
    }
    profile = await resolveProfile(profile, args.category, {
      bundledProfilesPath: args.bundledProfilesPath,
    });
  }

  const outPath = path.join(args.inputDir, args.filename);
  try {
    await fs.writeFile(outPath, JSON.stringify(profile));
  } catch (err) {
    throw new AppError(
      500,
      `Failed to write resolved ${args.category} profile`,
      err instanceof Error ? err.message : String(err),
    );
  }
  return outPath;
}
