const express = require("express");
const {
  bootstrapSuperAdmin,
  changePassword,
  getSession,
  login,
  logout,
} = require("../controllers/authController");
const { authenticate } = require("../middleware/authentication");

const router = express.Router();

router.post("/login", login);
router.get("/session", authenticate, getSession);
router.post("/logout", logout);
router.post("/change-password", authenticate, changePassword);
router.post("/bootstrap-super-admin", bootstrapSuperAdmin);

module.exports = router;
