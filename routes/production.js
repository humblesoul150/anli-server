const express = require("express");
const controller = require("../controllers/productionController");
const { authenticate, requirePasswordChanged } = require("../middleware/authentication");
const audit = require("../lib/audit");
const { hasAnyDepartmentRole } = require("../lib/authorization");

const router = express.Router();
const readRoles = ["Super Admin", "Admin", "General Manager", "Production Manager", "Inventory Manager"];
const writeRoles = ["Super Admin", "Admin", "General Manager", "Production Manager", "Inventory Manager"];

function requireRoles(allowedRoles) {
  return async (request, response, next) => {
    if (hasAnyDepartmentRole(request.authUser, allowedRoles)) return next();
    await audit.recordAudit({
      request,
      eventType: "security.authorization_denied",
      outcome: "denied",
      reason: "production_role_required",
      actor: request.authUser,
      details: { resource: request.baseUrl },
    });
    return response.status(403).json({ error: "You do not have permission to access production and inventory records." });
  };
}

const authenticated = [authenticate, requirePasswordChanged];
const reader = [...authenticated, requireRoles(readRoles)];
const writer = [...authenticated, requireRoles(writeRoles)];

router.get("/products", reader, controller.listProducts);
router.post("/products", writer, controller.createProduct);
router.patch("/products/:id", writer, controller.updateProduct);
router.put("/products/:id/recipe", writer, controller.changeRecipe);

router.get("/materials", reader, controller.listMaterials);
router.post("/materials", writer, controller.createMaterial);
router.get("/materials/responsible-users", reader, controller.listInventoryResponsibleUsers);
router.get("/materials/low-stock", reader, controller.listLowStockAlerts);
router.get("/materials/receipts", reader, controller.listMaterialReceipts);
router.get("/materials/production-usages", reader, controller.listProductionMaterialUsages);
router.post("/materials/production-usages", writer, controller.postProductionMaterialUsage);
router.put("/materials/:materialId/locations/:location", writer, controller.configureMaterialLocation);
router.post("/materials/:materialId/receipts", writer, controller.receiveRawMaterial);
router.get("/materials/movements", reader, controller.listRawMovements);
router.post("/materials/transfers", writer, controller.transferRawMaterial);
router.post("/materials/adjustments", writer, controller.adjustRawMaterial);

router.get("/stock/balances", reader, controller.listStockBalances);
router.get("/stock/finished/movements", reader, controller.listFinishedMovements);
router.post("/stock/finished/receipts", writer, controller.receiveFinishedStock);
router.post("/stock/finished/adjustments", writer, controller.adjustFinishedStock);

router.get("/runs", reader, controller.listProductionRuns);
router.post("/runs", writer, controller.createProductionRun);

router.requireProductionReader = requireRoles(readRoles);
router.requireProductionWriter = requireRoles(writeRoles);
module.exports = router;
