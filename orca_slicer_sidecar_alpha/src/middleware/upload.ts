import multer from "multer";
import path from "path";
import { AppError } from "./error";

const storage = multer.memoryStorage();

const allowedModelMimeTypes = [
  "model/stl",
  "application/step",
  "model/step",
  "model/3mf",
];
const allowedModelExts = [".stl", ".step", ".stp", ".3mf"];

export const uploadJson = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.mimetype !== "application/json" || ext !== ".json") {
      return cb(
        new AppError(400, "Invalid file type. Only JSON files are allowed.")
      );
    }
    cb(null, true);
  },
  limits: { fileSize: 4_000_000 },
});

// BambuStudio's "Export Preset Bundle" emits files with a `.bbscfg`
// extension but standard zip content. Browsers/clients vary on the MIME
// type they send: zip-aware ones use application/zip, others fall through
// to application/octet-stream. The two real bundles we tested against were
// 38KB and 32KB; 50MB is comfortably above any plausible single-printer
// bundle and well below the 100MB model cap.
const allowedBundleMimeTypes = [
  "application/zip",
  "application/x-zip-compressed",
  "application/octet-stream",
];
const allowedBundleExts = [".bbscfg", ".zip"];

export const uploadBundle = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (
      !allowedBundleMimeTypes.includes(file.mimetype) ||
      !allowedBundleExts.includes(ext)
    ) {
      return cb(
        new AppError(
          400,
          "Invalid file type. Only .bbscfg printer-preset-bundle archives are accepted."
        )
      );
    }
    cb(null, true);
  },
  limits: { fileSize: 50_000_000 },
});

export const uploadModel = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    if (
      !allowedModelMimeTypes.includes(file.mimetype) ||
      !allowedModelExts.includes(ext)
    ) {
      return cb(
        new AppError(
          400,
          "Invalid file type. Only STL, STEP, and 3MF files are allowed."
        )
      );
    }
    cb(null, true);
  },
  limits: { fileSize: 100_000_000 },
});

export const uploadFullPrint = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const modelField = "file";
    const profileFields = [
      "printerProfile",
      "presetProfile",
      "filamentProfile",
    ];

    const ext = path.extname(file.originalname).toLowerCase();

    if (file.fieldname === modelField) {
      if (
        !allowedModelMimeTypes.includes(file.mimetype) ||
        !allowedModelExts.includes(ext)
      ) {
        return cb(
          new AppError(
            400,
            "Invalid file type. Only STL, STEP, and 3MF files are allowed."
          )
        );
      }

      return cb(null, true);
    }

    if (profileFields.includes(file.fieldname)) {
      if (file.mimetype !== "application/json" || ext !== ".json") {
        return cb(
          new AppError(
            400,
            `Invalid file type for ${file.fieldname}. Only JSON files are allowed.`
          )
        );
      }

      return cb(null, true);
    }

    return cb(new AppError(400, "Unexpected file field received."));
  },
  limits: { fileSize: 100_000_000 },
});
