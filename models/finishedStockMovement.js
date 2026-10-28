const mongoose = require("mongoose");

const FINISHED_MOVEMENT_TYPES = [
  "Opening balance",
  "Production",
  "Sales dispatch",
  "Damage/write-off",
  "Internal use/sample",
  "Other stock in",
  "Adjustment increase",
  "Adjustment decrease",
];

const finishedStockMovementSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "FinishedProduct", required: true, index: true },
    type: { type: String, enum: FINISHED_MOVEMENT_TYPES, required: true },
    direction: { type: String, enum: ["in", "out"], required: true },
    inventoryUnit: { type: String, enum: ["piece_legacy", "pack"], default: "piece_legacy" },
    quantityPacks: { type: Number, min: 1, validate: Number.isInteger },
    packTypeSnapshot: { type: String, enum: ["Box", "Carton"] },
    piecesPerPackSnapshot: { type: Number, min: 1, validate: Number.isInteger },
    quantityPieces: { type: Number, min: 1, validate: Number.isInteger },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    reference: { type: String, required: true, trim: true, maxlength: 80 },
    sourceType: { type: String, enum: ["production", "receipt", "adjustment", "sale", "opening"], required: true },
    sourceId: { type: mongoose.Schema.Types.ObjectId, default: null },
    idempotencyKey: { type: String, trim: true, maxlength: 120 },
    reason: { type: String, trim: true, maxlength: 300, default: "" },
    productName: { type: String, required: true, trim: true, maxlength: 160 },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_document, value) {
        value.id = String(value._id);
        delete value._id;
        delete value.__v;
        return value;
      },
    },
  },
);

finishedStockMovementSchema.pre("validate", function validateInventoryUnit(next) {
  if (this.inventoryUnit === "pack" &&
    (!Number.isInteger(this.quantityPacks) || this.quantityPacks < 1 ||
      !this.packTypeSnapshot || !Number.isInteger(this.piecesPerPackSnapshot) || this.piecesPerPackSnapshot < 1)) {
    this.invalidate("quantityPacks", "Pack movements require a positive pack quantity and packaging snapshot.");
  }
  if (this.inventoryUnit !== "pack" && (!Number.isInteger(this.quantityPieces) || this.quantityPieces < 1)) {
    this.invalidate("quantityPieces", "Legacy piece movements require a positive piece quantity.");
  }
  next();
});

finishedStockMovementSchema.index({ productId: 1, date: -1, createdAt: -1 });
finishedStockMovementSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
finishedStockMovementSchema.index({ sourceType: 1, sourceId: 1 });

module.exports = mongoose.models.FinishedStockMovement ||
  mongoose.model("FinishedStockMovement", finishedStockMovementSchema);
module.exports.FINISHED_MOVEMENT_TYPES = FINISHED_MOVEMENT_TYPES;
