const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");

const USER_ROLES = [
  "Super Admin",
  "Admin",
  "General Manager",
  "Human Resource",
  "Marketing Manager",
  "Sales Manager",
  "Production Manager",
  "Inventory Manager",
  "Accountant",
];

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
      match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    },
    password: {
      type: String,
      required: true,
      select: false,
      validate: {
        validator(password) {
          const minLength =
            this.mustChangePassword && this.temporaryPasswordExpiresAt ? 6 : 8;
          return typeof password === "string"
            && password.length >= minLength
            && Buffer.byteLength(password, "utf8") <= 72;
        },
        message: "Password does not meet the minimum length or maximum byte limit.",
      },
    },
    mustChangePassword: { type: Boolean, default: true },
    temporaryPasswordExpiresAt: { type: Date },
    sessionVersion: { type: Number, default: 0 },
    roles: {
      type: [
        {
          type: String,
          enum: USER_ROLES,
        },
      ],
      required: true,
      validate: {
        validator: (roles) => roles.length > 0 && new Set(roles).size === roles.length,
        message: "Assign at least one distinct valid role.",
      },
    },
    status: {
      type: String,
      enum: ["Active", "Suspended", "Deactivated"],
      default: "Active",
    },
    lastActive: { type: Date },
    suspensionReason: { type: String, trim: true, maxlength: 500 },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_document, value) {
        value.id = String(value._id);
        delete value._id;
        delete value.__v;
        delete value.password;
        return value;
      },
    },
    toObject: {
      transform(_document, value) {
        value.id = String(value._id);
        delete value._id;
        delete value.__v;
        delete value.password;
        return value;
      },
    },
  },
);

userSchema.pre("save", async function hashPassword() {
  if (!this.isModified("password")) return;
  const minLength =
    this.mustChangePassword && this.temporaryPasswordExpiresAt ? 6 : 8;
  if (this.password.length < minLength || Buffer.byteLength(this.password, "utf8") > 72) {
    throw new Error(`Password must be ${minLength} or more characters and no more than 72 UTF-8 bytes.`);
  }
  this.password = await bcrypt.hash(this.password, 12);
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

const User = mongoose.models.User || mongoose.model("User", userSchema);

module.exports = User;
module.exports.USER_ROLES = USER_ROLES;
