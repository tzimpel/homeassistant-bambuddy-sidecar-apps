import { Router } from "express";
import { uploadFullPrint } from "../../middleware/upload";
import { AppError } from "../../middleware/error";
import type {
  SliceMetaData,
  SlicingSettings,
  UploadedProfiles,
} from "./models";
import { getMetaDataFromFile, sliceModel } from "./slicing.service";
import { progressStore } from "./progress-store";
import fs from "fs/promises";
import path from "path";
import archiver from "archiver";
import { generateMetaDataHeaders } from "./helpers";

const router = Router();

// Live progress endpoint. Bambuddy generates a request_id when it submits
// to POST /slice and polls this in parallel (the POST holds the
// connection open for the duration of the slice — multi-second to
// multi-minute on complex models — so the only way to surface progress
// to the user is a side-channel like this one). Returns 404 once the
// slice has completed and the entry's grace window has elapsed.
router.get("/progress/:requestId", (req, res) => {
  const id = req.params.requestId;
  const snapshot = progressStore.get(id);
  if (!snapshot) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({
    stage: snapshot.stage,
    total_percent: snapshot.totalPercent,
    plate_percent: snapshot.platePercent,
    plate_index: snapshot.plateIndex,
    plate_count: snapshot.plateCount,
    updated_at: snapshot.updatedAt,
  });
});

router.post(
  "/",
  uploadFullPrint.fields([
    { name: "file", maxCount: 1 },
    { name: "printerProfile", maxCount: 1 },
    { name: "presetProfile", maxCount: 1 },
    // Bambu Lab supports up to 16 AMS slots (4 AMS units of 4 trays each).
    // Accepting that many filament profiles covers every realistic input.
    { name: "filamentProfile", maxCount: 16 },
  ]),
  async (req, res) => {
    if (!req.files || Array.isArray(req.files)) {
      throw new AppError(
        400,
        "Invalid file upload format: files must be uploaded as named fields",
      );
    }

    const files = req.files as { [fieldname: string]: Express.Multer.File[] };

    if (!files["file"]) {
      throw new AppError(400, "Model file is required for slicing");
    }

    const modelFile = files["file"][0];

    const { gcodes, workdir } = await sliceModel(
      modelFile.buffer,
      modelFile.originalname,
      req.body as SlicingSettings,
      {
        printer: files["printerProfile"]?.[0]?.buffer,
        preset: files["presetProfile"]?.[0]?.buffer,
        filaments: files["filamentProfile"]?.map((f) => f.buffer) ?? [],
      } as UploadedProfiles,
    );

    if (gcodes.length === 1) {
      try {
        const metadata = await getMetaDataFromFile(gcodes[0]);
        res.set(generateMetaDataHeaders(metadata));

        res.download(gcodes[0]);
      } finally {
        await fs.rm(workdir, { recursive: true, force: true });
      }
    } else if (gcodes.length > 1) {
      const metadata: SliceMetaData = {
        printTime: 0,
        filamentUsedG: 0,
        filamentUsedMm: 0,
      };

      for (const filePath of gcodes) {
        if (!filePath.endsWith(".gcode")) continue;

        const fileMetadata = await getMetaDataFromFile(filePath);
        metadata.printTime += fileMetadata.printTime;
        metadata.filamentUsedG += fileMetadata.filamentUsedG;
        metadata.filamentUsedMm += fileMetadata.filamentUsedMm;
      }

      res.set(generateMetaDataHeaders(metadata));

      res.attachment("result.zip");
      const archive = archiver("zip", { zlib: { level: 9 } });

      archive.on("error", (err) => {
        throw new AppError(500, `Error creating archive: ${err.message}`);
      });

      res.on("finish", async () => {
        await fs.rm(workdir, { recursive: true, force: true });
      });

      archive.pipe(res);
      gcodes.forEach((filePath) => {
        archive.file(filePath, { name: path.basename(filePath) });
      });

      await archive.finalize();
    } else {
      throw new AppError(500, "No files generated during slicing");
    }
  },
);

export default router;
