const mongoose = require("mongoose");

const rawMaterialPackagingLevelSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 40 },
    quantity: { type: Number, required: true, min: 0.000001 },
  },
  { _id: false },
);

const rawMaterialSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 40 },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    category: { type: String, required: true, trim: true, maxlength: 80, default: "General" },
    unit: { type: String, required: true, trim: true, maxlength: 24 },
    packagingLevels: { type: [rawMaterialPackagingLevelSchema], default: [] },
    active: { type: Boolean, default: true, index: true },
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

rawMaterialSchema.index({ code: 1 }, { unique: true });
rawMaterialSchema.index({ name: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });

module.exports =
  mongoose.models.RawMaterial || mongoose.model("RawMaterial", rawMaterialSchema);
