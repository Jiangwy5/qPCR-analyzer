import { analyzePlate, calculateLoading, unitLabel, unitScale } from "./bca-core.mjs";

const byId = id => document.getElementById(id);
const rowNames = [..."ABCDEFGH"];
const columnCount = 12;
const storageKey = "labToolsBcaPlateV1";
const settingsIds = ["unit", "blank-mode", "model", "cv-limit", "wb-mass", "wb-volume", "wb-buffer"];
const statusText = {
  ok: "范围内",
  below: "低于标准曲线范围",
  above: "高于标准曲线范围",
  missing: "无有效读数",
};
const loadingStatus = {
  ok: "可配样",
  "sample-only": "仅计算取样量",
  "no-buffer": "待填缓冲液倍数",
  "insufficient-volume": "总体积不足",
  "invalid-volume": "超出可计算范围",
};

let wells = blankPlate();
const wellElements = [];
let selected = new Set();
let anchor = null;
let drag = null;
let suppressClick = false;
let analysis = null;
let wbRows = [];
let chart = null;
const wbChoices = new Map();

function blankPlate() {
  return rowNames.flatMap(row => Array.from({ length: columnCount }, (_, column) => ({
    address: row + (column + 1),
    od: null,
    kind: null,
    excluded: false,
  })));
}

function element(tag, content) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  return node;
}

function showMessage(id, message, error = false) {
  const node = byId(id);
  node.textContent = message;
  node.toggleAttribute("data-error", error);
}

function format(value, digits = 5) {
  return Number.isFinite(value) ? String(Number(value.toPrecision(digits))) : "—";
}

function readSettings() {
  return {
    unit: byId("unit").value,
    blankMode: byId("blank-mode").value,
    model: byId("model").value,
    cvLimit: numericValue(byId("cv-limit")),
  };
}

function numericValue(input) {
  return Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : null;
}

function saveDraft() {
  try {
    const settings = Object.fromEntries(settingsIds.map(id => [id, byId(id).value]));
    sessionStorage.setItem(storageKey, JSON.stringify({ wells, settings, choices: [...wbChoices] }));
  } catch {
    // The calculator also works when storage is unavailable.
  }
}

function restoreDraft() {
  try {
    const data = JSON.parse(sessionStorage.getItem(storageKey));
    if (!data || !Array.isArray(data.wells) || data.wells.length !== wells.length) return;
    wells = wells.map((well, index) => ({ ...data.wells[index], address: well.address }));
    for (const id of settingsIds) if (typeof data.settings?.[id] === "string") byId(id).value = data.settings[id];
    for (const [name, key] of data.choices ?? []) wbChoices.set(name, key);
  } catch {
    // Start with the default settings when a saved draft is unavailable.
  }
}

function addPlateButton(cell, title, label, action) {
  const button = element("button", title);
  button.type = "button";
  button.setAttribute("aria-label", label);
  if (action) button.addEventListener("click", action);
  cell.append(button);
  return button;
}

function toggleWells(indices) {
  const allSelected = indices.every(index => selected.has(index));
  for (const index of indices) {
    if (allSelected) selected.delete(index);
    else selected.add(index);
  }
  renderSelection();
}

function addRectangle(start, end, selection) {
  const startRow = Math.floor(start / columnCount);
  const endRow = Math.floor(end / columnCount);
  const startCol = start % columnCount;
  const endCol = end % columnCount;
  for (let row = Math.min(startRow, endRow); row <= Math.max(startRow, endRow); row++) {
    for (let col = Math.min(startCol, endCol); col <= Math.max(startCol, endCol); col++) {
      selection.add(row * columnCount + col);
    }
  }
}

function renderSelection() {
  for (const [index, item] of wellElements.entries()) {
    item.cell.classList.toggle("selected", selected.has(index));
    item.button.setAttribute("aria-pressed", String(selected.has(index)));
  }
  const names = [...selected].sort((a, b) => a - b).map(index => wells[index].address);
  byId("selection").textContent = names.length
    ? `已选 ${names.length} 孔 · ${names.slice(0, 8).join("、")}${names.length > 8 ? "…" : ""}`
    : "请先选择孔位";
  for (const id of ["apply-role", "remove-role", "exclude", "include", "clear-selection"]) {
    byId(id).disabled = names.length === 0;
  }
}

function clearSelection() {
  selected.clear();
  anchor = null;
  renderSelection();
}

function renderWell(index) {
  const { cell, tag, button } = wellElements[index];
  const well = wells[index];
  const unit = byId("unit").value;
  const marker = {
    blank: "空白",
    standard: well.kind === "standard" ? format(well.concentration / unitScale[unit]) : "",
    sample: well.name,
  }[well.kind] ?? "";
  const detail = {
    blank: "空白",
    standard: `标准品 ${marker} ${unitLabel[unit]}`,
    sample: `样品 ${marker} · BCA 稀释 ${well.dilution}×`,
  }[well.kind] ?? "";
  for (const role of ["blank", "standard", "sample"]) cell.classList.toggle(role, well.kind === role);
  cell.classList.toggle("excluded", well.excluded);
  tag.textContent = well.excluded ? "排除" : marker;
  cell.title = [well.address, detail, well.excluded ? "已排除" : ""].filter(Boolean).join(" · ");
  button.setAttribute("aria-label", cell.title);
}

function renderPlateProgress() {
  const read = wells.filter(well => well.od !== null).length;
  const assigned = wells.filter(well => well.kind).length;
  byId("plate-progress").textContent = `已录入 ${read} / 96 孔 · 已分配 ${assigned} 孔`;
}

function syncPlate() {
  for (const [index, well] of wells.entries()) {
    const input = wellElements[index].input;
    input.value = well.od ?? "";
    input.removeAttribute("aria-invalid");
    renderWell(index);
  }
  renderPlateProgress();
}

function createPlate() {
  const table = byId("plate");
  const head = table.createTHead().insertRow();
  head.append(element("th"));
  for (let column = 0; column < columnCount; column++) {
    const cell = element("th");
    cell.scope = "col";
    addPlateButton(cell, String(column + 1), `选择第 ${column + 1} 列`, () => {
      toggleWells(rowNames.map((_, row) => row * columnCount + column));
    });
    head.append(cell);
  }
  const body = table.createTBody();
  for (const [row, label] of rowNames.entries()) {
    const line = body.insertRow();
    const heading = element("th");
    heading.scope = "row";
    addPlateButton(heading, label, `选择 ${label} 行`, () => {
      toggleWells(Array.from({ length: columnCount }, (_, column) => row * columnCount + column));
    });
    line.append(heading);
    for (let column = 0; column < columnCount; column++) {
      const index = row * columnCount + column;
      const address = wells[index].address;
      const cell = line.insertCell();
      cell.className = "well";
      cell.dataset.index = String(index);
      const top = element("div");
      top.className = "well-head";
      const button = addPlateButton(top, address, `选择 ${address} 孔`, event => {
        if (suppressClick) return;
        if (event.shiftKey && anchor !== null) {
          addRectangle(anchor, index, selected);
          renderSelection();
        } else {
          anchor = index;
          toggleWells([index]);
        }
      });
      button.addEventListener("pointerdown", event => {
        if (event.button === 0 && !event.shiftKey) drag = { start: index, base: new Set(selected), moved: false };
      });
      const tag = element("span");
      tag.className = "well-tag";
      top.append(tag);
      const input = element("input");
      input.type = "number";
      input.step = "any";
      input.inputMode = "decimal";
      input.autocomplete = "off";
      input.setAttribute("aria-label", `${address} 吸光度`);
      input.addEventListener("input", () => {
        wells[index].od = numericValue(input);
        if (input.validity.badInput) input.setAttribute("aria-invalid", "true");
        else input.removeAttribute("aria-invalid");
        renderPlateProgress();
        markChanged();
      });
      input.addEventListener("keydown", event => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        const next = wellElements[index + (event.shiftKey ? -1 : 1)]?.input;
        next?.focus();
        next?.select();
      });
      cell.append(top, input);
      wellElements.push({ cell, button, tag, input });
    }
  }

  window.addEventListener("pointermove", event => {
    if (!drag || !event.buttons) return;
    const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest(".well");
    if (!cell) return;
    const end = Number(cell.dataset.index);
    if (!drag.moved && end === drag.start) return;
    drag.moved = true;
    selected = new Set(drag.base);
    addRectangle(drag.start, end, selected);
    renderSelection();
  });
  window.addEventListener("pointerup", () => {
    if (drag?.moved) {
      suppressClick = true;
      anchor = drag.start;
      setTimeout(() => { suppressClick = false; }, 0);
    }
    drag = null;
  });
  window.addEventListener("pointercancel", () => { drag = null; });
  syncPlate();
  renderSelection();
}

function updateAssignmentFields() {
  const role = byId("role").value;
  byId("standard-field").hidden = role !== "standard";
  byId("sample-fields").hidden = role !== "sample";
  byId("standard-unit").textContent = unitLabel[byId("unit").value];
}

function setForSelection(update, message) {
  for (const index of selected) {
    update(wells[index]);
    renderWell(index);
  }
  showMessage("assignment-feedback", `${selected.size} 孔${message}。`);
  clearSelection();
  renderPlateProgress();
  markChanged();
}

function applyRole() {
  const kind = byId("role").value;
  const assignment = { kind, concentration: undefined, name: undefined, dilution: undefined };
  if (kind === "standard") {
    const concentration = numericValue(byId("standard-concentration")) * unitScale[byId("unit").value];
    if (concentration <= 0 || !Number.isFinite(concentration)) {
      showMessage("assignment-feedback", "请输入大于 0 的标准品浓度。零浓度孔请选择「空白」。", true);
      byId("standard-concentration").focus();
      return;
    }
    assignment.concentration = concentration;
  }
  if (kind === "sample") {
    assignment.name = byId("sample-name").value.trim();
    assignment.dilution = numericValue(byId("sample-dilution"));
    if (!assignment.name || assignment.dilution === null || assignment.dilution < 1) {
      showMessage("assignment-feedback", "请填写样品名称及大于或等于 1 的稀释倍数。", true);
      byId(assignment.name ? "sample-dilution" : "sample-name").focus();
      return;
    }
  }
  setForSelection(well => Object.assign(well, assignment), "已分配");
}

function markChanged() {
  analysis = null;
  wbRows = [];
  byId("analysis").hidden = true;
  byId("wb").hidden = true;
  showMessage("analysis-feedback", "请点击「计算浓度」查看当前孔板的结果。");
  saveDraft();
}

function loadExample() {
  if (wells.some(well => well.kind || well.od !== null) && !confirm("载入示例会替换当前孔板，继续吗？")) return;
  wells = blankPlate();
  const setPair = (index, assignment, readings) => {
    for (const [offset, od] of readings.entries()) Object.assign(wells[index + offset], assignment, { od });
  };
  setPair(0, { kind: "blank" }, [0.098, 0.102]);
  const concentrations = [125, 250, 500, 750, 1000];
  for (const [row, concentration] of concentrations.entries()) {
    const od = 0.1 + 0.0008 * concentration;
    const readings = [od - 0.002, od + 0.002].map(value => Number(value.toFixed(3)));
    setPair((row + 1) * columnCount, { kind: "standard", concentration }, readings);
  }
  setPair(2, { kind: "sample", name: "样品 A", dilution: 10 }, [0.498, 0.502]);
  setPair(14, { kind: "sample", name: "样品 B", dilution: 5 }, [0.579, 0.581]);
  setPair(26, { kind: "sample", name: "样品 C", dilution: 1 }, [0.99, 1.01]);
  const settings = { unit: "ug", "blank-mode": "raw", model: "linear", "cv-limit": "10", "wb-mass": "20", "wb-volume": "20", "wb-buffer": "4" };
  for (const [id, value] of Object.entries(settings)) byId(id).value = value;
  previousUnit = settings.unit;
  byId("standard-concentration").value = "";
  wbChoices.clear();
  updateAssignmentFields();
  syncPlate();
  clearSelection();
  showMessage("assignment-feedback", "已载入示例孔板和 WB 配样设置。");
  markChanged();
}

function groupNotes(group, limit) {
  const notes = [];
  if (group.used.length === 1) notes.push("仅 1 孔");
  if (group.cv !== null && group.cv > limit) notes.push("复孔 CV 偏高");
  if (group.missing) notes.push(`${group.missing} 孔缺读数`);
  if (group.excluded) notes.push(`${group.excluded} 孔已排除`);
  if (group.outside?.length && group.status === "ok") notes.push(`超范围复孔 ${group.outside.join("、")}`);
  return notes;
}

function renderTable(id, headings, rows) {
  const table = byId(id);
  table.replaceChildren();
  const head = table.createTHead().insertRow();
  for (const heading of headings) {
    const cell = element("th", heading);
    cell.scope = "col";
    head.append(cell);
  }
  const body = table.createTBody();
  if (!rows.length) {
    const cell = body.insertRow().insertCell();
    cell.colSpan = headings.length;
    cell.textContent = "暂无结果";
  }
  for (const values of rows) {
    const row = body.insertRow();
    for (const value of values) {
      const cell = row.insertCell();
      if (value instanceof HTMLElement) cell.append(value);
      else cell.textContent = value ?? "";
    }
  }
}

function highlight(value, className) {
  const span = element("span", value);
  span.className = className;
  return span;
}

function equation(curve, model) {
  const { a, b, c } = curve.coefficients;
  const signed = value => `${value < 0 ? " − " : " + "}${format(Math.abs(value))}`;
  if (model === "quadratic") return `A₅₆₂ = ${format(a)}C²${signed(b)}C${signed(c)}`;
  return `A₅₆₂ = ${format(b)}C${signed(c)}`;
}

function plotCurve(curve, points, unit) {
  chart?.destroy();
  chart = null;
  const canvas = byId("curve");
  canvas.hidden = !window.Chart;
  byId("chart-fallback").hidden = Boolean(window.Chart);
  if (!window.Chart) return;
  const line = Array.from({ length: 41 }, (_, index) => {
    const x = curve.low + (curve.high - curve.low) * (index / 40);
    return { x, y: curve.predict(x) };
  });
  chart = new window.Chart(canvas, {
    type: "scatter",
    data: {
      datasets: [
        { label: "BSA 标准品均值", data: points.map(point => ({ x: point.concentration, y: point.corrected })), pointRadius: 4, backgroundColor: "#255fc8", order: 0 },
        { label: "拟合曲线", data: line, showLine: true, pointRadius: 0, borderWidth: 2, borderColor: "#6281ae", order: 1 },
      ],
    },
    options: {
      animation: false,
      maintainAspectRatio: false,
      scales: {
        x: { title: { display: true, text: `BSA 浓度（${unit}）` } },
        y: { title: { display: true, text: "校正吸光度 A₅₆₂" } },
      },
    },
  });
}

function renderAnalysis(result, settings) {
  const { curve, points, standards, samples, warnings, blank } = result;
  const unit = unitLabel[settings.unit];
  const scale = unitScale[settings.unit];
  const summary = [
    ["拟合方程", equation(curve, settings.model)],
    ["R²", format(curve.r2, 6)],
    ["标准浓度范围", `${format(curve.low)}–${format(curve.high)} ${unit}`],
    ["空白校正", settings.blankMode === "raw" ? `扣除 ${format(blank)}（${result.blankGroup.used.length} 孔）` : "按已扣空白读数计算"],
  ];
  byId("fit-summary").replaceChildren(...summary.flatMap(([key, value]) => [element("dt", key), element("dd", value)]));
  renderTable("standard-results", [`BSA（${unit}）`, "使用孔数", "校正 A₅₆₂", "CV (%)", "提示"], standards.map(group => [
    format(group.concentration / scale), group.used.length, format(group.corrected), format(group.cv),
    groupNotes(group, settings.cvLimit).join(" · ") || "—",
  ]));
  renderTable("sample-results", [
    "样品", "BCA 稀释倍数", "使用孔数", "校正 A₅₆₂", "CV (%)", `测定液（${unit}）`, `原样（${unit}）`, "状态",
  ], samples.map(sample => [
    sample.name, sample.dilution, sample.used.length, format(sample.corrected), format(sample.cv),
    format(sample.concentration), highlight(format(sample.original), "result-primary"),
    highlight([statusText[sample.status], ...groupNotes(sample, settings.cvLimit)].join(" · "), sample.status === "ok" ? "" : "attention"),
  ]));
  const list = byId("warnings");
  list.replaceChildren(...warnings.map(warning => element("li", warning)));
  list.hidden = !warnings.length;
  byId("analysis").hidden = false;
  byId("wb").hidden = false;
  renderLoading();
  try {
    plotCurve(curve, points, unit);
  } catch {
    byId("curve").hidden = true;
    byId("chart-fallback").hidden = false;
  }
}

function chooseDilution(name, candidates) {
  if (!candidates.length) return { display: "—", source: null };
  if (candidates.length === 1) return { display: `${candidates[0].dilution}×`, source: candidates[0] };
  const select = element("select");
  select.setAttribute("aria-label", `${name} 的 BCA 稀释倍数`);
  select.append(new Option("选择稀释倍数", ""));
  for (const option of candidates) {
    select.append(new Option(`${option.dilution}× · ${format(option.original)} ${unitLabel[analysis.settings.unit]}`, option.key));
  }
  const source = candidates.find(option => option.key === wbChoices.get(name)) ?? null;
  select.value = source?.key ?? "";
  select.addEventListener("change", () => {
    wbChoices.set(name, select.value);
    saveDraft();
    renderLoading();
    const next = [...byId("wb-results").querySelectorAll("select")].find(input => input.getAttribute("aria-label") === select.getAttribute("aria-label"));
    next?.focus();
  });
  return { display: select, source };
}

function renderLoading() {
  if (!analysis) return;
  const massInput = byId("wb-mass");
  const volumeInput = byId("wb-volume");
  const bufferInput = byId("wb-buffer");
  const mass = numericValue(massInput);
  const total = numericValue(volumeInput);
  const fold = numericValue(bufferInput);
  const bad = !massInput.validity.valid || !volumeInput.validity.valid || !bufferInput.validity.valid ||
    (mass !== null && mass <= 0) || (total !== null && total <= 0) || (fold !== null && fold <= 1);
  const unit = unitLabel[analysis.settings.unit];
  const scale = unitScale[analysis.settings.unit];
  const groups = new Map();
  for (const sample of analysis.result.samples) {
    if (!groups.has(sample.name)) groups.set(sample.name, []);
    if (sample.status === "ok" && sample.original > 0) groups.get(sample.name).push(sample);
  }
  const rows = [];
  wbRows = [];
  for (const [name, candidates] of groups) {
    const { source, display } = chooseDilution(name, candidates);
    const loading = source && !bad && mass !== null ? calculateLoading(source.original, scale, mass, total, fold) : null;
    let status;
    if (loading) status = loadingStatus[loading.status];
    else if (!candidates.length) status = "无可用 BCA 浓度";
    else if (!source) status = "待选稀释倍数";
    else status = "待填配样条件";
    const stock = source ? source.original * (scale / 1000) : null;
    rows.push([
      name, display, format(stock), highlight(format(loading?.sample), "result-primary"),
      format(loading?.buffer), format(loading?.diluent), format(loading?.finalConcentration),
      highlight(status, loading?.status === "insufficient-volume" || !candidates.length ? "attention" : ""),
    ]);
    wbRows.push([
      name, source?.dilution ?? null, source?.original ?? null, unit, stock, mass, total, fold,
      loading?.sample ?? null, loading?.buffer ?? null, loading?.diluent ?? null,
      loading?.finalConcentration ?? null, status,
    ]);
  }
  renderTable("wb-results", [
    "样品", "所用 BCA 稀释倍数", "原样（µg/µL）", "取样原液（µL）", "上样缓冲液（µL）",
    "补液（µL）", "配样后浓度（µg/µL）", "状态",
  ], rows);
  let message = "";
  if (bad) message = "目标蛋白量和总体积须大于 0，缓冲液原液倍数须大于 1。";
  else if (mass === null) message = "填写每孔目标蛋白量即可计算取样原液体积。";
  else if (fold !== null && total === null) message = "填写总体积后可计算上样缓冲液和补液体积。";
  showMessage("wb-feedback", message, bad);
}

function calculate() {
  const invalid = wellElements.find((well, index) => !wells[index].excluded && well.input.validity.badInput);
  if (invalid) {
    showMessage("analysis-feedback", "有孔位的吸光度格式无效，请修正后再计算。", true);
    invalid.input.focus();
    return;
  }
  const settings = readSettings();
  if (settings.cvLimit === null || settings.cvLimit < 0) {
    showMessage("analysis-feedback", "请填写大于或等于 0 的复孔 CV 提示阈值。", true);
    byId("cv-limit").focus();
    return;
  }
  let result;
  try {
    result = analyzePlate(wells, settings);
  } catch (error) {
    showMessage("analysis-feedback", error.message, true);
    return;
  }
  analysis = { result, settings };
  showMessage("analysis-feedback", "计算完成。");
  showMessage("export-feedback", "");
  renderAnalysis(result, settings);
  byId("analysis-title").focus();
}

function exportWorkbook() {
  if (!analysis) return;
  const xlsx = window.XLSX;
  if (!xlsx) {
    showMessage("export-feedback", "Excel 导出组件未加载。请检查网络后刷新，再重新计算导出。", true);
    return;
  }
  const { result, settings } = analysis;
  const unit = unitLabel[settings.unit];
  const scale = unitScale[settings.unit];
  const book = xlsx.utils.book_new();
  const addSheet = (name, rows) => {
    const worksheet = xlsx.utils.aoa_to_sheet(rows);
    worksheet["!cols"] = rows[0].map(heading => ({ wch: Math.max(15, heading.length * 2) }));
    xlsx.utils.book_append_sheet(book, worksheet, name);
  };
  addSheet("原始孔位", [
    ["孔位", "吸光度 A562", "类型", `BSA 浓度（${unit}）`, "样品", "BCA 稀释倍数", "已排除"],
    ...wells.map(well => [
      well.address, well.od, { blank: "空白", standard: "标准品", sample: "样品" }[well.kind] ?? "",
      well.concentration === undefined ? null : well.concentration / scale, well.name ?? "",
      well.dilution ?? null, well.excluded,
    ]),
  ]);
  const { curve } = result;
  addSheet("曲线参数", [
    ["参数", "数值"],
    ["拟合模型", settings.model === "linear" ? "线性（带截距）" : "二次曲线"],
    ["浓度单位", unit], ["空白处理", settings.blankMode === "raw" ? "扣除空白孔均值" : "已扣空白"],
    ["此处扣除的吸光度", result.blank], ["用于空白校正的孔数", settings.blankMode === "raw" ? result.blankGroup.used.length : 0],
    ["二次项系数", curve.coefficients.a], ["一次项系数", curve.coefficients.b], ["截距", curve.coefficients.c],
    ["R²", curve.r2], ["标准浓度下限", curve.low], ["标准浓度上限", curve.high],
    ["复孔 CV 提示阈值 (%)", settings.cvLimit],
    ...result.warnings.map(warning => ["提示", warning]),
  ]);
  addSheet("标准品", [
    [`BSA 浓度（${unit}）`, "孔位", "使用孔数", "录入读数均值", "校正吸光度均值", "SD", "CV (%)", "备注"],
    ...result.standards.map(group => [
      group.concentration / scale, group.wells.join(", "), group.used.length, group.average, group.corrected,
      group.sd, group.cv, groupNotes(group, settings.cvLimit).join(" · "),
    ]),
  ]);
  addSheet("样品浓度", [
    ["样品", "BCA 稀释倍数", "孔位", "使用孔数", "录入读数均值", "校正吸光度均值", "SD", "CV (%)",
      `测定液浓度（${unit}）`, `原样浓度（${unit}）`, "状态", "备注"],
    ...result.samples.map(sample => [
      sample.name, sample.dilution, sample.wells.join(", "), sample.used.length, sample.average, sample.corrected,
      sample.sd, sample.cv, sample.concentration, sample.original, statusText[sample.status],
      groupNotes(sample, settings.cvLimit).join(" · "),
    ]),
  ]);
  addSheet("WB 配样", [
    ["样品", "所用 BCA 稀释倍数", "原样浓度", "浓度单位", "原样（µg/µL）",
      "目标蛋白量（µg）", "配样总体积（µL）", "上样缓冲液原液倍数", "取样原液（µL）",
      "上样缓冲液（µL）", "补液（µL）", "配样后浓度（µg/µL）", "状态"],
    ...wbRows,
  ]);
  try {
    xlsx.writeFile(book, "BCA_WB_定量结果.xlsx");
    showMessage("export-feedback", "已生成 Excel 文件。");
  } catch {
    showMessage("export-feedback", "导出失败，请检查浏览器下载设置后重试。", true);
  }
}

restoreDraft();
createPlate();
updateAssignmentFields();
byId("role").addEventListener("change", updateAssignmentFields);
byId("clear-selection").addEventListener("click", clearSelection);
byId("apply-role").addEventListener("click", applyRole);
byId("remove-role").addEventListener("click", () => setForSelection(well => {
  delete well.name;
  delete well.dilution;
  delete well.concentration;
  well.kind = null;
}, "已清除分配"));
byId("exclude").addEventListener("click", () => setForSelection(well => { well.excluded = true; }, "已排除"));
byId("include").addEventListener("click", () => setForSelection(well => { well.excluded = false; }, "已恢复"));
byId("example").addEventListener("click", loadExample);
byId("clear-readings").addEventListener("click", () => {
  if (wells.some(well => well.od !== null) && !confirm("清空本次吸光度读数并保留孔位分配？")) return;
  for (const well of wells) {
    well.od = null;
    well.excluded = false;
  }
  syncPlate();
  showMessage("assignment-feedback", "已清空读数，孔位分配已保留。");
  markChanged();
});
byId("reset").addEventListener("click", () => {
  if (wells.some(well => well.kind || well.od !== null || well.excluded) && !confirm("清空全部吸光度读数和孔位分配？")) return;
  wells = blankPlate();
  wbChoices.clear();
  syncPlate();
  clearSelection();
  showMessage("assignment-feedback", "已重置孔板。");
  markChanged();
});
let previousUnit = byId("unit").value;
byId("unit").addEventListener("change", () => {
  const unit = byId("unit").value;
  const input = byId("standard-concentration");
  const value = numericValue(input);
  if (value !== null) input.value = value * (unitScale[previousUnit] / unitScale[unit]);
  previousUnit = unit;
  updateAssignmentFields();
  for (const [index] of wells.entries()) renderWell(index);
  markChanged();
});
for (const id of ["blank-mode", "model", "cv-limit"]) byId(id).addEventListener("input", markChanged);
for (const id of ["wb-mass", "wb-volume", "wb-buffer"]) {
  byId(id).addEventListener("input", () => {
    saveDraft();
    renderLoading();
  });
}
byId("calculate").addEventListener("click", calculate);
byId("export").addEventListener("click", exportWorkbook);
