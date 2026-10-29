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
} = require("../middleware/authentication");
const { requireAnyRole } = require("../middleware/roleAccess");

const router = express.Router();
const requireAccountAdmin = [
  authenticate,
  requirePasswordChanged,
  requireAnyRole(
    ["Super Admin", "General Manager", "Human Resource"],
    "account_manager_required",
    "Only Super Admin, General Manager, and Human Resource can manage accounts.",
  ),
];

router.get("/", requireAccountAdmin, listUsers);
router.post("/", requireAccountAdmin, createUser);
router.post("/:id/reset-password", requireAccountAdmin, resetUserPassword);
router.patch("/:id", requireAccountAdmin, updateUser);
router.patch("/:id/status", requireAccountAdmin, updateUserStatus);

module.exports = router;
