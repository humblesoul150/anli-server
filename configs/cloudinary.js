const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function signUploadParams(options = {}) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = options.folder || "anli/uploads";
  const publicId = options.publicId || `upload-${timestamp}`;
  const resourceType = options.resourceType || "image";
  const type = options.type || "upload";
  const allowedFormats =
    Array.isArray(options.allowedFormats) && options.allowedFormats.length
      ? options.allowedFormats
      : ["jpg", "jpeg", "png", "webp", "pdf"];
  const maxBytes =
    Number.isFinite(options.maxBytes) && options.maxBytes > 0
      ? Math.min(options.maxBytes, 10 * 1024 * 1024)
      : 1024 * 1024;

  const signingParams = {
    folder,
    public_id: publicId,
    timestamp,
    type,
    allowed_formats: allowedFormats.join(","),
  };

  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`,
    cloudName,
    apiKey,
    timestamp,
    signature: cloudinary.utils.api_sign_request(signingParams, apiSecret),
    publicId,
    folder,
    resourceType,
    type,
    allowedFormats,
    maxBytes,
  };
}

function uploadImage(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return Promise.reject(new TypeError("An image buffer is required."));
  }

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: options.folder || "anli/company-profile",
        public_id: options.publicId,
        overwrite: false,
        resource_type: "image",
        type: options.type || "upload",
        transformation: options.transformation || [
          { quality: "auto", fetch_format: "auto" },
        ],
      },
      (error, result) => {
        if (error) return reject(error);
        if (!result?.secure_url || !result?.public_id) {
          return reject(
            new Error("Cloudinary returned an incomplete image result."),
          );
        }
        return resolve({ url: result.secure_url, publicId: result.public_id });
      },
    );
    stream.end(buffer);
  });
}

function uploadPdf(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return Promise.reject(new TypeError("A PDF buffer is required."));
  }

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: options.folder || "anli/employee-documents",
        public_id: options.publicId,
        overwrite: false,
        resource_type: "raw",
        type: "authenticated",
        format: "pdf",
      },
      (error, result) => {
        if (error) return reject(error);
        if (!result?.secure_url || !result?.public_id) {
          return reject(
            new Error("Cloudinary returned an incomplete document result."),
          );
        }
        return resolve({ url: result.secure_url, publicId: result.public_id });
      },
    );
    stream.end(buffer);
  });
}

function deleteAsset(publicId, resourceType = "image", type = "upload") {
  if (!publicId) return Promise.resolve({ result: "not found" });
  return cloudinary.uploader.destroy(publicId, {
    resource_type: resourceType,
    type,
  });
}

function deleteImage(publicId) {
  return deleteAsset(publicId, "image", "upload");
}

module.exports = {
  cloudinary,
  uploadImage,
  uploadPdf,
  deleteAsset,
  deleteImage,
  signUploadParams,
};
