const mongoose = require("mongoose");
const SalaryAdvance = require("../models/salaryAdvance");
const { cloudinary, uploadImage, uploadPdf, deleteAsset } = require("../configs/cloudinary");
const audit = require("../lib/audit");

const MAX_ATTACHMENTS = 5;

function supportedFile(file) {
  if (!file || !Buffer.isBuffer(file.buffer)) return null;
  const bytes = file.buffer;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mediaType: "image/jpeg", resourceType: "image", extension: "jpg" };
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mediaType: "image/png", resourceType: "image", extension: "png" };
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return { mediaType: "image/webp", resourceType: "image", extension: "webp" };
  }
  if (bytes.length >= 5 && bytes.toString("ascii", 0, 5) === "%PDF-") {
    return { mediaType: "application/pdf", resourceType: "raw", extension: "pdf" };
  }
  return null;
}

async function addAttachment(request, response) {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(400).json({ error: "Salary advance ID is invalid." });
  const file = request.file;
  const signature = supportedFile(file);
  if (!signature) return response.status(400).json({ error: "Only valid JPEG, PNG, WebP, and PDF attachments are accepted." });
  const advance = await SalaryAdvance.findById(request.params.id);
  if (!advance) return response.status(404).json({ error: "Salary advance not found." });
  if (!["Pending HR review", "Pending GM review"].includes(advance.status)) return response.status(409).json({ error: "Attachments can only be changed while a request is awaiting approval." });
  if (advance.attachments.length >= MAX_ATTACHMENTS) return response.status(400).json({ error: `A request can have no more than ${MAX_ATTACHMENTS} attachments.` });

  const publicId = `advance-${advance._id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const options = { folder: "anli/salary-advances", publicId, type: "authenticated" };
  const asset = signature.resourceType === "image"
    ? await uploadImage(file.buffer, options)
    : await uploadPdf(file.buffer, options);
  const attachment = {
    name: String(file.originalname || `attachment.${signature.extension}`).slice(0, 180),
    url: asset.url,
    publicId: asset.publicId,
    resourceType: signature.resourceType,
    mediaType: signature.mediaType,
    sizeBytes: file.size,
    uploadedBy: request.authUser._id,
  };
  advance.attachments.push(attachment);
  advance.updatedBy = request.authUser._id;
  advance.activity.push({ action: "Attachment uploaded", actorId: request.authUser._id, actorName: request.authUser.name, note: attachment.name });
  try {
    await advance.save();
  } catch (error) {
    try {
      await deleteAsset(asset.publicId, signature.resourceType, "authenticated");
    } catch (cleanupError) {
      console.error("Unable to clean up an unlinked salary-advance attachment:", cleanupError);
    }
    throw error;
  }
  await audit.recordAudit({
    request,
    eventType: "salary_advance.attachment_uploaded",
    outcome: "success",
    details: { advanceId: String(advance._id), attachmentId: String(advance.attachments.at(-1)._id), resourceType: signature.resourceType, sizeBytes: file.size },
  });
  return response.status(201).json({ attachment: advance.attachments.at(-1) });
}

async function removeAttachment(request, response) {
  if (!mongoose.isValidObjectId(request.params.id) || !mongoose.isValidObjectId(request.params.attachmentId)) {
    return response.status(400).json({ error: "Salary advance or attachment ID is invalid." });
  }
  const advance = await SalaryAdvance.findById(request.params.id);
  if (!advance) return response.status(404).json({ error: "Salary advance not found." });
  if (!["Pending HR review", "Pending GM review"].includes(advance.status)) return response.status(409).json({ error: "Attachments can only be changed while a request is awaiting approval." });
  const attachment = advance.attachments.id(request.params.attachmentId);
  if (!attachment) return response.status(404).json({ error: "Attachment not found." });
  const asset = { publicId: attachment.publicId, resourceType: attachment.resourceType };
  const attachmentId = String(attachment._id);
  attachment.deleteOne();
  advance.updatedBy = request.authUser._id;
  advance.activity.push({ action: "Attachment removed", actorId: request.authUser._id, actorName: request.authUser.name, note: attachment.name });
  await advance.save();
  await audit.recordAudit({
    request,
    eventType: "salary_advance.attachment_removed",
    outcome: "success",
    details: { advanceId: String(advance._id), attachmentId },
  });
  try {
    await deleteAsset(asset.publicId, asset.resourceType, "authenticated");
  } catch (error) {
    console.error("Unable to remove the deleted salary-advance attachment from Cloudinary:", error);
  }
  return response.json({ removed: true });
}

async function getAttachmentDownload(request, response) {
  if (!mongoose.isValidObjectId(request.params.id) || !mongoose.isValidObjectId(request.params.attachmentId)) {
    return response.status(400).json({ error: "Salary advance or attachment ID is invalid." });
  }
  const advance = await SalaryAdvance.findById(request.params.id);
  if (!advance) return response.status(404).json({ error: "Salary advance not found." });
  const attachment = advance.attachments.id(request.params.attachmentId);
  if (!attachment) return response.status(404).json({ error: "Attachment not found." });
  const extension = attachment.mediaType === "application/pdf" ? "pdf" : attachment.mediaType.split("/")[1];
  const url = cloudinary.utils.private_download_url(attachment.publicId, extension, {
    resource_type: attachment.resourceType,
    type: "authenticated",
    attachment: attachment.name,
    expires_at: Math.floor(Date.now() / 1000) + 120,
  });
  return response.json({ url, expiresInSeconds: 120 });
}

module.exports = { addAttachment, getAttachmentDownload, removeAttachment, supportedFile };
