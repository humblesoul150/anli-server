const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

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
        transformation: options.transformation || [{ quality: "auto", fetch_format: "auto" }],
      },
      (error, result) => {
        if (error) return reject(error);
        if (!result?.secure_url || !result?.public_id) {
          return reject(new Error("Cloudinary returned an incomplete image result."));
        }
        return resolve({ url: result.secure_url, publicId: result.public_id });
      },
    );
    stream.end(buffer);
  });
}

function deleteImage(publicId) {
  if (!publicId) return Promise.resolve({ result: "not found" });
  return cloudinary.uploader.destroy(publicId, { resource_type: "image" });
}

module.exports = { cloudinary, uploadImage, deleteImage };