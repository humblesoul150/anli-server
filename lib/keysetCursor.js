function encodeKeysetCursor(document) {
  const createdAt = new Date(document?.createdAt);
  const id = String(document?._id || "");
  if (Number.isNaN(createdAt.getTime()) || !/^[a-f\d]{24}$/i.test(id)) {
    throw new TypeError(
      "A keyset cursor requires a document date and ObjectId.",
    );
  }
  return Buffer.from(
    JSON.stringify({ createdAt: createdAt.toISOString(), id }),
  ).toString("base64url");
}

function decodeKeysetCursor(value) {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return null;
  }
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded).toString("base64url") !== value) return null;
    const cursor = JSON.parse(decoded);
    if (
      !cursor ||
      typeof cursor !== "object" ||
      Array.isArray(cursor) ||
      Object.keys(cursor).length !== 2 ||
      typeof cursor.createdAt !== "string" ||
      typeof cursor.id !== "string" ||
      !/^[a-f\d]{24}$/i.test(cursor.id)
    ) {
      return null;
    }
    const createdAt = new Date(cursor.createdAt);
    if (
      Number.isNaN(createdAt.getTime()) ||
      createdAt.toISOString() !== cursor.createdAt
    )
      return null;
    return { createdAt, id: cursor.id };
  } catch {
    return null;
  }
}

module.exports = { decodeKeysetCursor, encodeKeysetCursor };
