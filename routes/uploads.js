const express = require("express");
const {
  authenticate,
  requirePasswordChanged,
} = require("../middleware/authentication");
const { signUploadParams } = require("../configs/cloudinary");

const router = express.Router();

router.post(
  "/signed",
  authenticate,
  requirePasswordChanged,
  (request, response) => {
    const {
      folder = "anli/uploads",
      publicId,
      resourceType = "image",
      type = "upload",
      maxBytes = 1024 * 1024,
      allowedFormats,
    } = request.body || {};

    if (typeof folder !== "string" || folder.trim().length === 0) {
      return response
        .status(400)
        .json({ error: "A Cloudinary folder is required." });
    }
    if (resourceType !== "image" && resourceType !== "raw") {
      return response
        .status(400)
        .json({ error: "resourceType must be image or raw." });
    }
    if (
      !Number.isFinite(Number(maxBytes)) ||
      Number(maxBytes) <= 0 ||
      Number(maxBytes) > 10 * 1024 * 1024
    ) {
      return response
        .status(400)
        .json({ error: "maxBytes must be between 1 and 10 MB." });
    }

    const params = signUploadParams({
      folder: folder.trim(),
      publicId:
        typeof publicId === "string" && publicId.trim()
          ? publicId.trim()
          : undefined,
      resourceType,
      type,
      maxBytes: Number(maxBytes),
      allowedFormats:
        Array.isArray(allowedFormats) && allowedFormats.length
          ? allowedFormats.map(String)
          : undefined,
    });

    return response.json({
      uploadUrl: params.uploadUrl,
      apiKey: params.apiKey,
      timestamp: params.timestamp,
      signature: params.signature,
      publicId: params.publicId,
      folder: params.folder,
      cloudName: params.cloudName,
      resourceType: params.resourceType,
      type: params.type,
      maxBytes: params.maxBytes,
      allowedFormats: params.allowedFormats,
    });
  },
);

module.exports = router;
