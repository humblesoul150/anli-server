const express = require("express");
const {
  createUser,
  listUsers,
  resetUserPassword,
  updateUser,
  updateUserStatus,
} = require("../controllers/userController");
const {
  authenticate,
  requirePasswordChanged,
  requireSuperAdmin,
} = require("../middleware/authentication");

const router = express.Router();
const requireAccountAdmin = [
  authenticate,
  requireSuperAdmin,
  requirePasswordChanged,
];

router.get("/", requireAccountAdmin, listUsers);
router.post("/", requireAccountAdmin, createUser);
router.post("/:id/reset-password", requireAccountAdmin, resetUserPassword);
router.patch("/:id", requireAccountAdmin, updateUser);
router.patch("/:id/status", requireAccountAdmin, updateUserStatus);

module.exports = router;
