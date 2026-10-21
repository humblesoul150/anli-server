const mongoose = require("mongoose");

const finishedProductSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 40 },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    category: { type: String, required: true, enum: ["Cup", "Bottle"] },
    unit: { type: String, required: true, enum: ["150 ml", "180 ml", "200 ml", "250 ml", "300 ml", "350 ml", "500 ml"] },
    flavour: { type: String, required: true, enum: ["Mango", "Pineapple milk"] },
    packType: { type: String, enum: ["Box", "Carton"] },
    piecesPerPack: { type: Number, min: 1, validate: Number.isInteger },
    packWeightKg: { type: Number, min: 0.000001 },
    recipeRequired: { type: Boolean, default: false },
    active: { type: Boolean, default: true, index: true },
    activeRecipeId: { type: mongoose.Schema.Types.ObjectId, ref: "ProductionRecipe", default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
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

finishedProductSchema.pre("validate", function validatePack(next) {
  const hasAnyPackDetail = this.packType || this.piecesPerPack !== undefined || this.packWeightKg !== undefined;
  if (hasAnyPackDetail && (!this.packType || !Number.isInteger(this.piecesPerPack) || this.piecesPerPack < 1 || !Number.isFinite(this.packWeightKg) || this.packWeightKg <= 0)) {
    this.invalidate("packType", "Pack type requires a positive pieces-per-pack count and net weight in kilograms.");
  }
  next();
});

finishedProductSchema.index({ code: 1 }, { unique: true });
finishedProductSchema.index({ name: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });

module.exports =
  mongoose.models.FinishedProduct ||
  mongoose.model("FinishedProduct", finishedProductSchema);
