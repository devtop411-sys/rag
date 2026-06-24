import multer from "multer";

const FILE_SIZE_LIMIT = 20 * 1024 * 1024; // 20 MB

/** Disk-based multer — for routes that need to read the file from disk. */
export const upload = multer({
  dest: "uploads/",
  limits: { fileSize: FILE_SIZE_LIMIT },
});

/** Memory-based multer — for S3 uploads where no disk I/O is needed. */
export const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: FILE_SIZE_LIMIT },
});
