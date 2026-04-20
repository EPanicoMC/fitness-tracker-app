export async function searchOpenFoodFacts(query) {
  if (!query || query.length < 2) return [];
  try {
    const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=10&lc=it&cc=it`;
    const res  = await fetch(url);
    const data = await res.json();
    if (!data.products) return [];
    return data.products
      .filter(p => p.nutriments && p.product_name)
      .map(p => ({
        name:            p.product_name_it || p.product_name,
        kcal_per_100g:   Math.round(p.nutriments['energy-kcal_100g'] || 0),
        protein_per_100g: Math.round((p.nutriments['proteins_100g']      || 0) * 10) / 10,
        carbs_per_100g:   Math.round((p.nutriments['carbohydrates_100g'] || 0) * 10) / 10,
        fats_per_100g:    Math.round((p.nutriments['fat_100g']           || 0) * 10) / 10,
        source:  'openfoodfacts',
        barcode: p.code
      }))
      .filter(p => p.kcal_per_100g > 0 && p.name)
      .slice(0, 8);
  } catch(e) {
    console.error('OpenFoodFacts error:', e);
    return [];
  }
}

export function calcKcalFromMacro(protein, carbs, fats) {
  return Math.round((protein * 4) + (carbs * 4) + (fats * 9));
}
