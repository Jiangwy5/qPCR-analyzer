export const unitScale = { ug: 1, mg: 1000 };
export const unitLabel = { ug: "µg/mL", mg: "mg/mL" };

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function summarize(wells, blank) {
  const used = wells.filter(well => !well.excluded && Number.isFinite(well.od));
  const values = used.map(well => well.od);
  const average = values.length ? mean(values) : null;
  const corrected = average === null ? null : average - blank;
  const sd = values.length < 2 ? null : Math.sqrt(
    values.reduce((total, value) => total + (value - average) ** 2, 0) / (values.length - 1),
  );
  return {
    wells: wells.map(well => well.address),
    used,
    average,
    corrected,
    sd,
    cv: sd !== null && corrected > 0 ? sd / corrected * 100 : null,
    missing: wells.filter(well => !well.excluded && well.od === null).length,
    excluded: wells.filter(well => well.excluded).length,
  };
}

function solve(matrix) {
  for (let column = 0; column < matrix.length; column++) {
    let pivot = column;
    for (let row = column + 1; row < matrix.length; row++) {
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
    }
    if (Math.abs(matrix[pivot][column]) < 1e-12) {
      throw new Error("标准品浓度过于接近，无法稳定拟合。请检查标准品浓度。");
    }
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    const divisor = matrix[column][column];
    matrix[column] = matrix[column].map(value => value / divisor);
    for (let row = 0; row < matrix.length; row++) {
      if (row === column) continue;
      const multiplier = matrix[row][column];
      matrix[row] = matrix[row].map((value, index) => value - multiplier * matrix[column][index]);
    }
  }
  return matrix.map(row => row.at(-1));
}

function fitCurve(points, model) {
  const size = model === "quadratic" ? 3 : 2;
  if (points.length < size) {
    throw new Error(`至少需要 ${size} 个不同浓度、且有有效读数的 BSA 标准品。`);
  }
  const low = points[0].concentration;
  const high = points.at(-1).concentration;
  const center = low + (high - low) / 2;
  const scale = (high - low) / 2;
  const normalized = points.map(point => ({ x: (point.concentration - center) / scale, y: point.corrected }));
  const matrix = Array.from({ length: size }, (_, row) => {
    const sums = Array.from({ length: size }, (_, column) =>
      normalized.reduce((sum, point) => sum + point.x ** (row + column), 0),
    );
    return [...sums, normalized.reduce((sum, point) => sum + point.y * point.x ** row, 0)];
  });
  const [offset, slope, curvature = 0] = solve(matrix);
  if (!Number.isFinite(slope) || slope <= 2 * Math.abs(curvature)) {
    throw new Error("拟合曲线在所选标准浓度范围内无法单调递增。请检查分配、标准点或更换拟合模型。");
  }
  const predict = concentration => {
    const x = (concentration - center) / scale;
    return offset + slope * x + curvature * x * x;
  };
  const lowOd = predict(low);
  const highOd = predict(high);
  const average = mean(points.map(point => point.corrected));
  const total = points.reduce((sum, point) => sum + (point.corrected - average) ** 2, 0);
  const residual = points.reduce((sum, point) => sum + (point.corrected - predict(point.concentration)) ** 2, 0);
  const centerScaled = center / scale;
  const coefficients = {
    a: (curvature / scale) / scale,
    b: (slope - 2 * curvature * centerScaled) / scale,
    c: offset - slope * centerScaled + curvature * centerScaled ** 2,
  };
  if (![lowOd, highOd, ...Object.values(coefficients)].every(Number.isFinite) || highOd <= lowOd) {
    throw new Error("标准曲线超出可计算范围，请检查输入数值。");
  }
  return { predict, coefficients, low, high, lowOd, highOd, r2: total ? 1 - residual / total : null, size };
}

function invertCurve(curve, od) {
  const tolerance = 16 * Number.EPSILON * Math.max(Math.abs(curve.lowOd), Math.abs(curve.highOd));
  if (od < curve.lowOd - tolerance) return { status: "below", concentration: null };
  if (od > curve.highOd + tolerance) return { status: "above", concentration: null };
  let { low, high } = curve;
  for (let iteration = 0; iteration < 52; iteration++) {
    const middle = low + (high - low) / 2;
    if (curve.predict(middle) < od) low = middle;
    else high = middle;
  }
  return { status: "ok", concentration: low + (high - low) / 2 };
}

export function analyzePlate(wells, settings) {
  const blankGroup = summarize(wells.filter(well => well.kind === "blank"), 0);
  const raw = settings.blankMode === "raw";
  if (raw && !blankGroup.used.length) {
    throw new Error("请分配至少一个有读数的有效空白孔。已扣空白的读数可在曲线设置中选择「已扣空白」。");
  }
  const blank = raw ? blankGroup.average : 0;
  const standardGroups = new Map();
  const sampleGroups = new Map();
  const unassigned = [];
  for (const well of wells) {
    if (well.kind === "standard") {
      const group = standardGroups.get(well.concentration) ?? [];
      group.push(well);
      standardGroups.set(well.concentration, group);
    } else if (well.kind === "sample") {
      const key = JSON.stringify([well.name, well.dilution]);
      const group = sampleGroups.get(key) ?? [];
      group.push(well);
      sampleGroups.set(key, group);
    } else if (!well.kind && well.od !== null && !well.excluded) {
      unassigned.push(well.address);
    }
  }
  const standards = [...standardGroups].sort(([left], [right]) => left - right)
    .map(([concentration, group]) => ({ concentration, ...summarize(group, blank) }));
  const scale = unitScale[settings.unit];
  const points = standards.filter(point => point.used.length).map(point => ({
    ...point,
    concentration: point.concentration / scale,
  }));
  const curve = fitCurve(points, settings.model);
  const samples = [...sampleGroups].map(([key, group]) => {
    const { name, dilution } = group[0];
    const summary = summarize(group, blank);
    const result = summary.used.length
      ? invertCurve(curve, summary.corrected)
      : { status: "missing", concentration: null };
    const original = result.concentration === null ? null : result.concentration * dilution;
    if (original !== null && !Number.isFinite(original)) {
      throw new Error(`「${name}」的原样浓度超出可计算范围，请检查稀释倍数。`);
    }
    const outside = summary.used.filter(well => invertCurve(curve, well.od - blank).status !== "ok")
      .map(well => well.address);
    return { key, name, dilution, ...summary, ...result, original, outside };
  });
  const warnings = [];
  if (unassigned.length) warnings.push(`已有读数但未分配的孔：${unassigned.join("、")}`);
  if (raw && blankGroup.missing) warnings.push(`有 ${blankGroup.missing} 个空白孔缺少读数。`);
  if (points.length === curve.size) warnings.push("标准点数等于模型的参数个数，R² 无法用于检验拟合偏差。");
  if (standards.some(point => !point.used.length)) warnings.push("部分标准浓度缺少有效读数，未用于拟合。");
  if (!samples.length) warnings.push("孔板上还未分配样品。");
  return { blank, blankGroup, standards, points, curve, samples, warnings };
}

export function calculatePreparation(stock, added, fold, measuredVolume) {
  const hasStock = Number.isFinite(stock) && stock > 0;
  const hasAdded = Number.isFinite(added) && added >= 0;
  const hasFold = Number.isFinite(fold) && fold > 1;
  const total = hasStock && hasAdded ? stock + added : null;
  const measured = Number.isFinite(measuredVolume) && measuredVolume > 0;
  const finalVolume = measuredVolume === null ? total : measured ? measuredVolume : null;
  const expected = hasStock && hasFold ? stock / (fold - 1) : null;
  const actualFold = total !== null && hasFold ? (added / total) * fold : null;
  const difference = expected !== null && hasAdded ? added - expected : null;
  let status = "ok";
  if ([stock, added, fold].some(Number.isNaN)) status = "invalid";
  else if (!hasStock) status = "missing-stock";
  else if (!hasFold) status = "missing-fold";
  else if (!hasAdded) status = "missing-added";
  else if (actualFold < 0.99) status = "below";
  else if (actualFold > 1.01) status = "above";
  return { status, total, measured, finalVolume, expected, actualFold, difference };
}

export function calculateLoading(stockConcentration, stockVolume, finalVolume, targetMass) {
  const totalProtein = stockConcentration * stockVolume;
  const concentration = totalProtein / finalVolume;
  if (!Number.isFinite(concentration) || concentration <= 0) return { status: "invalid" };
  if (targetMass === null) return { status: "missing-mass", concentration };
  if (!Number.isFinite(targetMass) || targetMass <= 0) return { status: "invalid-mass", concentration };
  const volume = targetMass / concentration;
  if (!Number.isFinite(volume) || volume <= 0) return { status: "invalid", concentration };
  if (volume - finalVolume > 1e-12 * finalVolume) return { status: "insufficient", concentration, volume };
  return { status: "ok", concentration, volume };
}
