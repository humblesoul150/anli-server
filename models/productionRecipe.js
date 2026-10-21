const mongoose = require("mongoose");

const recipeIngredientSchema = new mongoose.Schema(
  {
    materialId: { type: mongoose.Schema.Types.ObjectId, ref: "RawMaterial", required: true },
    materialName: { type: String, required: true, trim: true, maxlength: 160 },
    unit: { type: String, required: true, trim: true, maxlength: 24 },
    quantityPerTank: { type: Number, required: true, min: 0.000001 },
  },
  { _id: false },
);

const productionRecipeSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "FinishedProduct", required: true },
    version: { type: Number, required: true, min: 1, validate: Number.isInteger },
    tankVolumeLitres: { type: Number, required: true, default: 1000, enum: [1000] },
    ingredients: { type: [recipeIngredientSchema], required: true, validate: [(items) => items.length > 0, "A recipe must contain at least one ingredient."] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
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

productionRecipeSchema.index({ productId:  1, version: 1 }, { unique: true });

module.exports =
  mongoose.models.ProductionRecipe ||
  mongoose.model("ProductionRecipe", productionRecipeSchema);
