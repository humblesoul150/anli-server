function cumulativePackagingConversions(material) {
  let baseUnitsPerPackage = 1;
  return (material.packagingLevels || []).map((level) => {
    baseUnitsPerPackage *= level.quantity;
    return {
      name: level.name,
      quantity: level.quantity,
      baseUnitsPerPackage,
    };
  });
}

function convertPackageEntries(entries, conversions, baseUnit) {
  const factors = new Map(conversions.map((level) => [level.name, level.baseUnitsPerPackage]));
  let quantity = 0;

  for (const entry of entries || []) {
    let factor = factors.get(entry.name);
    if (!factor && entry.name === baseUnit) factor = 1;
    if (!factor || !Number.isInteger(entry.quantity) || entry.quantity < 0) {
      const error = new Error("Count contains an invalid package unit or quantity.");
      error.statusCode = 400;
      throw error;
    }
    quantity += entry.quantity * factor;
  }

  if ((entries || []).length === 0 && baseUnit) quantity = 0;
  if (!Number.isFinite(quantity) || quantity < 0 || quantity > 1_000_000_000_000) {
    const error = new Error("Counted quantity is outside the supported range.");
    error.statusCode = 400;
    throw error;
  }
  return quantity;
}

module.exports = { cumulativePackagingConversions, convertPackageEntries };
