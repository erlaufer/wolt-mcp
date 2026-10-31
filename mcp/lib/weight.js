// Catalog-backed weights shared by the preview and the actual purchase.
export function orderWeight(line, item) {
  const cfg = item?.sell_by_weight_config;
  const selected = line.weighted_item_info;
  if (!cfg && !selected) return null;
  if (!cfg || !selected) throw new Error(`${line.name || line.id}: basket and catalog disagree about weight; re-add the item`);
  const grams = selected.purchased_weight_in_grams;
  const step = cfg.grams_per_step;
  const price = cfg.price_per_kg;
  if ((selected.weighted_item_input_type || "grams") !== "grams" || (cfg.input_type || "grams") !== "grams") throw new Error(`${line.name || line.id}: piece-based weighted items must be ordered on wolt.com`);
  if (!Number.isSafeInteger(grams) || grams <= 0 || !Number.isSafeInteger(step) || step <= 0 || grams % step !== 0) throw new Error(`${line.name || line.id}: weight must be a positive multiple of ${step} grams; re-add the item`);
  if (!Number.isSafeInteger(price) || price < 0 || price !== line.price) throw new Error(`${line.name || line.id}: the price per kg changed; re-add the item and quote again`);
  return { count: 1, purchased_weight_in_grams: grams, price_per_kg: price, weighted_item_input_type: "grams", grams_per_step: step };
}

export function itemAmount(price, count, weighted) {
  return weighted ? Math.round(weighted.price_per_kg * weighted.purchased_weight_in_grams / 1000) : price * count;
}
