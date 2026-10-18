// utils/deleteMedia.js
const cloudinary = require('cloudinary').v2;

// If already configured elsewhere, you can remove this block
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Delete a single video or audio by its public_id
const deleteMedia = async (publicId, resourceType = "image") => {
  try {
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType,
    });

    console.log("Cloudinary deletion result:", result);
    return result;
  } catch (err) {
    console.error("Error deleting media from Cloudinary:", err);
    throw err;
  }
};


module.exports = deleteMedia;