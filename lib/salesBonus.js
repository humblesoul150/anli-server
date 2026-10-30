const DEFAULT_SALES_BONUS_SETTINGS = Object.freeze({
  enabled: true,
  standard: Object.freeze({
    minimumQuantity: 100,
    maximumQuantity: 999,
    qualifyingQuantity: 100,
    bonusQuantity: 1,
  }),
  volume: Object.freeze({
    minimumQuantity: 1000,
    qualifyingQuantity: 1000,
    bonusQuantity: 40,
  }),
});

function normalizeSettings(settings) {
  return {
    enabled: settings?.enabled !== false,
    standard: {
      minimumQuantity: settings?.standard?.minimumQuantity ?? DEFAULT_SALES_BONUS_SETTINGS.standard.minimumQuantity,
      maximumQuantity: settings?.standard?.maximumQuantity ?? DEFAULT_SALES_BONUS_SETTINGS.standard.maximumQuantity,
      qualifyingQuantity: settings?.standard?.qualifyingQuantity ?? DEFAULT_SALES_BONUS_SETTINGS.standard.qualifyingQuantity,
      bonusQuantity: settings?.standard?.bonusQuantity ?? DEFAULT_SALES_BONUS_SETTINGS.standard.bonusQuantity,
    },
    volume: {
      minimumQuantity: settings?.volume?.minimumQuantity ?? DEFAULT_SALES_BONUS_SETTINGS.volume.minimumQuantity,
      qualifyingQuantity: settings?.volume?.qualifyingQuantity ?? DEFAULT_SALES_BONUS_SETTINGS.volume.qualifyingQuantity,
      bonusQuantity: settings?.volume?.bonusQuantity ?? DEFAULT_SALES_BONUS_SETTINGS.volume.bonusQuantity,
    },
  };
}

function calculateSalesBonus(boxQuantity, settings = DEFAULT_SALES_BONUS_SETTINGS) {
  if (!Number.isSafeInteger(boxQuantity) || boxQuantity < 0) return { bonusQuantity: 0, tier: null };
  const normalized = normalizeSettings(settings);
  if (!normalized.enabled) return { bonusQuantity: 0, tier: null };

  const { standard, volume } = normalized;
  if (boxQuantity >= volume.minimumQuantity) {
    return {
      bonusQuantity: Math.floor(boxQuantity / volume.qualifyingQuantity) * volume.bonusQuantity,
      tier: "volume",
    };
  }
  if (boxQuantity >= standard.minimumQuantity && boxQuantity <= standard.maximumQuantity) {
    return {
      bonusQuantity: Math.floor(boxQuantity / standard.qualifyingQuantity) * standard.bonusQuantity,
      tier: "standard",
    };
  }
  return { bonusQuantity: 0, tier: null };
}

function allocateBonus(eligibleLines, bonusQuantity) {
  if (!bonusQuantity || !eligibleLines.length) return eligibleLines.map((line) => ({ ...line, bonusPacks: 0 }));
  const eligibleQuantity = eligibleLines.reduce((sum, line) => sum + line.packs, 0);
  const allocated = eligibleLines.map((line, index) => {
    const exact = bonusQuantity * (line.packs / eligibleQuantity);
    return {
      ...line,
      index,
      base: Math.floor(exact),
      remainder: exact - Math.floor(exact),
    };
  });
  let remaining = bonusQuantity - allocated.reduce((sum, line) => sum + line.base, 0);
  const remainderOrder = [...allocated].sort((left, right) =>
    right.remainder - left.remainder || left.index - right.index,
  );
  for (const line of remainderOrder) {
    if (remaining <= 0) break;
    line.base += 1;
    remaining -= 1;
  }
  return allocated.map(({ index, base, remainder, ...line }) => ({ ...line, bonusPacks: base }));
}

module.exports = {
  DEFAULT_SALES_BONUS_SETTINGS,
  normalizeSettings,
  calculateSalesBonus,
  allocateBonus,
};
