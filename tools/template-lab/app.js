const CANVAS_WIDTH = 2000;
const CANVAS_HEIGHT = 2668;
const ASSET_ROOT = "../../assets/templates";
const SIGNATURE_FONT_FAMILY = "MomoZhuanji";
const SIGNATURE_FONT_URL = `${ASSET_ROOT}/template_1/fonts/momo-zhuanji-handwriting-4.0.ttf`;
const MODEL_CANDIDATE_LIMIT = 16;
const MODEL_IMAGE_MAX_SIDE = 768;
const MODEL_REQUEST_TIMEOUT_MS = 90000;
const CUTOUT_IMAGE_MAX_SIDE = 1400;
const CUTOUT_REQUEST_TIMEOUT_MS = 120000;
const MAX_IMPORT_IMAGES = 300;
const TEMPLATE_NAME_STORAGE_KEY = "echooo-template-lab-template-names";
const IMAGE_EXTENSION_PATTERN = /\.(avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i;
const ZIP_EXTENSION_PATTERN = /\.zip$/i;

const TEMPLATES = {
  template_1: {
    id: "template_1",
    shortName: "模板 1",
    title: "Plog Collage Calendar",
    meta: "Template 01 · Canvas 2000 x 2668",
    requiredCount: 8,
    backgroundUrl: `${ASSET_ROOT}/template_1/bg.png`,
    photoSlots: [
      { x: 92, y: 136, w: 500, h: 512 },
      { x: 728, y: 128, w: 500, h: 520 },
      { x: 1364, y: 124, w: 524, h: 536 },
      { x: 64, y: 924, w: 520, h: 536 },
      { x: 1372, y: 920, w: 512, h: 524 },
      { x: 76, y: 1724, w: 532, h: 572 },
      { x: 704, y: 1732, w: 540, h: 532 },
      { x: 1360, y: 1724, w: 544, h: 540 },
    ],
    overlays: [],
    copyLines: [
      { key: "line1", rect: { x: 736, y: 1164, w: 524, h: 53 } },
      { key: "line2", rect: { x: 736, y: 1217, w: 524, h: 53 } },
      { key: "line3", rect: { x: 736, y: 1270, w: 524, h: 53 } },
      { key: "tag", rect: { x: 736, y: 1480, w: 360, h: 53 } },
    ],
    signature: {
      rect: { x: 761, y: 2516, w: 478, h: 70 },
      suffix: "Plog",
      maxCharacters: 18,
      maxSize: 64,
      minSize: 36,
      weight: "500",
      color: "rgba(255,255,255,0.80)",
    },
    defaultCopy: {
      nickname: "Me",
      line1: "Collected softly,",
      line2: "little scenes stay bright,",
      line3: "inside an ordinary day.",
      tag: "Daily Life",
    },
  },
  template_2: {
    id: "template_2",
    shortName: "模板 2",
    title: "模板 2",
    meta: "Template 02 · Canvas 2000 x 2668",
    requiredCount: 8,
    backgroundUrl: `${ASSET_ROOT}/template_2/bg.jpg`,
    photoSlots: [
      { x: 1429.831, y: 359.132, w: 424, h: 462, rotationDegrees: 12.77, cornerRadius: 3.287, useEffects: false },
      { x: 1366.735, y: 1580.229, w: 538, h: 568, rotationDegrees: 12.77, cornerRadius: 3.995, useEffects: false },
      { x: 694.435, y: 936.691, w: 632, h: 664, rotationDegrees: -11.39, cornerRadius: 4.679, useEffects: false },
      { x: 415.763, y: 649.846, w: 282, h: 296, rotationDegrees: -8.54, cornerRadius: 2.086, useEffects: false },
      { x: 733.947, y: 1895.957, w: 400, h: 420, rotationDegrees: 7.19, cornerRadius: 2.96, useEffects: false },
      { x: 1307.81, y: 1065.351, w: 456, h: 306, rotationDegrees: 14.4, cornerRadius: 2.831, useEffects: false },
      { x: 186.003, y: 1837.956, w: 492, h: 352, rotationDegrees: -15.52, cornerRadius: 2.994, useEffects: false },
      { x: 91.654, y: 1128.961, w: 460, h: 580, rotationDegrees: 18.53, cornerRadius: 3.417, useEffects: false },
    ],
    overlays: [
      {
        url: `${ASSET_ROOT}/template_2/sticker.png`,
        frame: { x: 0, y: 0, w: 2000, h: 2668 },
      },
    ],
    copyLines: [],
    signature: {
      rect: { x: 762, y: 2516, w: 478, h: 70 },
      suffix: "’Plog",
      maxCharacters: 18,
      maxSize: 64,
      minSize: 36,
      weight: "400",
      color: "#ffffff",
    },
    defaultCopy: {
      nickname: "chenchen",
      line1: "",
      line2: "",
      line3: "",
      tag: "",
    },
  },
  template_3: {
    id: "template_3",
    shortName: "模板 3",
    title: "模板 3",
    meta: "Template 03 · Canvas 2000 x 2668",
    requiredCount: 15,
    backgroundColor: "#140a12",
    photoSlots: [],
    cutout: {
      endpointPath: "/api/cutout",
      runtime: "rembg",
      modelName: "isnet-general-use",
      provider: "CPUExecutionProvider",
      fallback: "fullImagePreview",
    },
    layers: [
      { id: "image_cutout_01", figmaNodeId: "146:978", type: "image_cutout", index: 0, frame: { x: 0, y: 0, w: 2000, h: 2668 } },
      { id: "image_cutout_02", figmaNodeId: "146:979", type: "image_cutout", index: 1, frame: { x: 0, y: 0, w: 954, h: 1349 }, alignY: "bottom" },
      { id: "image_cutout_03", figmaNodeId: "146:980", type: "image_cutout", index: 2, frame: { x: 0, y: 0, w: 2000, h: 2116 }, alignY: "top" },
      { id: "image_cutout_04", figmaNodeId: "146:981", type: "image_cutout", index: 3, frame: { x: 1406.5, y: 17.5, w: 610.917, h: 575.917 }, rotationDegrees: -90 },
      { id: "image_cutout_05", figmaNodeId: "146:982", type: "image_cutout", index: 4, frame: { x: 0, y: 0, w: 476, h: 708 } },
      { id: "image_cutout_06", figmaNodeId: "146:983", type: "image_cutout", index: 5, frame: { x: -4, y: 568, w: 636, h: 456 } },
      { id: "mock_01_back", figmaNodeId: "146:986", type: "mock", frame: { x: 298.495, y: 831.514, w: 1131.269, h: 750.334 }, rotationDegrees: -13.05, radius: 7.12, color: "#f8f8f8" },
      { id: "mock_01_front", figmaNodeId: "146:987", type: "mock", frame: { x: 288.349, y: 831.214, w: 1129.599, h: 645.91 }, rotationDegrees: -13.05, radius: 7.12, color: "#f2f3ee" },
      { id: "image01", figmaNodeId: "146:988", type: "image", index: 6, frame: { x: 316.624, y: 865.532, w: 1065.05, h: 583.403 }, rotationDegrees: -13.05, radius: 3.56, shadow: true },
      { id: "mock_02_back", figmaNodeId: "146:990", type: "mock", frame: { x: 904.786, y: 168.733, w: 800.909, h: 579.725 }, rotationDegrees: 9.09, radius: 5.501, color: "#f8f8f8" },
      { id: "mock_02_front", figmaNodeId: "146:991", type: "mock", frame: { x: 912.758, y: 168.287, w: 799.727, h: 499.044 }, rotationDegrees: 9.09, radius: 5.501, color: "#f2f3ee" },
      { id: "image02", figmaNodeId: "146:992", type: "image", index: 7, frame: { x: 932.109, y: 193.509, w: 754.028, h: 450.75 }, rotationDegrees: 9.09, radius: 2.751, shadow: true },
      { id: "image_cutout_07", figmaNodeId: "146:993", type: "image_cutout", index: 8, frame: { x: 1134, y: 485, w: 866, h: 1303 } },
      { id: "image_cutout_08", figmaNodeId: "146:994", type: "image_cutout", index: 9, frame: { x: 1424, y: 1273, w: 584, h: 843 }, alignY: "top" },
      { id: "mock_03_back", figmaNodeId: "146:996", type: "mock", frame: { x: 870.232, y: 1754.815, w: 986.643, h: 714.166 }, rotationDegrees: 9.09, radius: 6.777, color: "#f8f8f8" },
      { id: "mock_03_front", figmaNodeId: "146:997", type: "mock", frame: { x: 880.058, y: 1754.264, w: 985.186, h: 614.775 }, rotationDegrees: 9.09, radius: 6.777, color: "#f2f3ee" },
      { id: "image03", figmaNodeId: "146:998", type: "image", index: 10, frame: { x: 903.93, y: 1785.35, w: 928.89, h: 555.281 }, rotationDegrees: 9.09, radius: 3.389, shadow: true },
      { id: "image_cutout_09", figmaNodeId: "146:999", type: "image_cutout", index: 11, frame: { x: 716, y: 2116, w: 1292, h: 552 } },
      { id: "image_cutout_10", figmaNodeId: "146:1000", type: "image_cutout", index: 12, frame: { x: 0, y: 1234, w: 1212, h: 1434 }, rotationDegrees: 180, scaleY: -1 },
      { id: "image_cutout_11", figmaNodeId: "146:1001", type: "image_cutout", index: 13, frame: { x: 0, y: 1879, w: 239, h: 322 } },
      { id: "image_cutout_12", figmaNodeId: "146:1002", type: "image_cutout", index: 14, frame: { x: -36.107, y: 1029.225, w: 550.866, h: 359.408 }, rotationDegrees: 172.15, scaleY: -1, alignY: "bottom" },
    ],
    overlays: [],
    copyLines: [],
    signature: null,
    defaultCopy: {
      nickname: "",
      line1: "",
      line2: "",
      line3: "",
      tag: "",
    },
  },
};

const state = {
  templateId: "template_1",
  photos: [],
  selected: [],
  generated: false,
  importing: false,
  selecting: false,
  templateNames: loadTemplateNames(),
};

const els = {
  canvas: document.querySelector("#templateCanvas"),
  fileInput: document.querySelector("#fileInput"),
  dropZone: document.querySelector("#dropZone"),
  generateButton: document.querySelector("#generateButton"),
  downloadButton: document.querySelector("#downloadButton"),
  clearButton: document.querySelector("#clearButton"),
  resetCopyButton: document.querySelector("#resetCopyButton"),
  selectedList: document.querySelector("#selectedList"),
  selectedCount: document.querySelector("#selectedCount"),
  thumbGrid: document.querySelector("#thumbGrid"),
  statusText: document.querySelector("#statusText"),
  uploadProgress: document.querySelector("#uploadProgress"),
  uploadProgressText: document.querySelector("#uploadProgressText"),
  uploadProgressPercent: document.querySelector("#uploadProgressPercent"),
  uploadProgressBar: document.querySelector("#uploadProgressBar"),
  modelEndpointInput: document.querySelector("#modelEndpointInput"),
  modelStateText: document.querySelector("#modelStateText"),
  activeTemplateName: document.querySelector("#activeTemplateName"),
  templateNameInput: document.querySelector("#templateNameInput"),
  canvasMeta: document.querySelector("#canvasMeta"),
  previewTitle: document.querySelector("#previewTitle"),
  templateButtons: [...document.querySelectorAll(".template-option[data-template-id]")],
  nicknameInput: document.querySelector("#nicknameInput"),
  line1Input: document.querySelector("#line1Input"),
  line2Input: document.querySelector("#line2Input"),
  line3Input: document.querySelector("#line3Input"),
  tagInput: document.querySelector("#tagInput"),
};

const ctx = els.canvas.getContext("2d", { alpha: false });
const assetImages = new Map();
const cutoutRequestCache = new Map();

preloadTemplateAssets();
loadSignatureFont();

els.fileInput.addEventListener("change", async (event) => {
  if (state.importing || state.selecting) return;
  await importFiles([...event.target.files]);
  els.fileInput.value = "";
});

els.dropZone.addEventListener("click", (event) => {
  if (state.importing || state.selecting) return;
  els.fileInput.click();
});

els.generateButton.addEventListener("click", async () => {
  if (state.importing || state.selecting) return;
  await runSelection();
});

els.downloadButton.addEventListener("click", downloadCanvas);
els.clearButton.addEventListener("click", clearPhotos);
els.resetCopyButton.addEventListener("click", resetCopy);
els.templateNameInput.addEventListener("input", () => {
  setCurrentTemplateName(els.templateNameInput.value);
});
els.templateNameInput.addEventListener("blur", () => {
  if (!els.templateNameInput.value.trim()) {
    delete state.templateNames[state.templateId];
    saveTemplateNames();
    updateTemplateUI();
  } else {
    els.templateNameInput.value = getTemplateName(currentTemplate());
  }
});
els.templateButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setTemplate(button.dataset.templateId);
  });
});

[els.nicknameInput, els.line1Input, els.line2Input, els.line3Input, els.tagInput]
  .forEach((input) => input.addEventListener("input", drawTemplate));

els.dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  els.dropZone.classList.add("is-dragging");
});

els.dropZone.addEventListener("dragleave", () => {
  els.dropZone.classList.remove("is-dragging");
});

els.dropZone.addEventListener("drop", async (event) => {
  event.preventDefault();
  els.dropZone.classList.remove("is-dragging");
  if (state.importing || state.selecting) return;
  await importFiles(await collectDroppedFiles(event.dataTransfer));
});

async function importFiles(files) {
  if (!files.length || state.importing || state.selecting) {
    return;
  }

  state.importing = true;
  state.generated = false;
  updateActionState();
  setUploadProgress(0, 0, "准备上传");

  try {
    const sortedFiles = stableSortFiles(files);
    const directImages = sortedFiles.filter(isImageFile);
    const zipFiles = sortedFiles.filter(isZipFile);
    const imageFiles = directImages.slice(0, MAX_IMPORT_IMAGES);
    let discoveredCount = directImages.length;
    let zipErrorCount = 0;

    if (zipFiles.length && imageFiles.length < MAX_IMPORT_IMAGES) {
      setStatus("读取中");
      setUploadProgress(0, 0, "读取中");
      for (const zipFile of zipFiles) {
        if (imageFiles.length >= MAX_IMPORT_IMAGES) break;
        try {
          const zipResult = await extractZipImages(zipFile, MAX_IMPORT_IMAGES - imageFiles.length);
          discoveredCount += zipResult.totalImages;
          imageFiles.push(...zipResult.files);
        } catch (error) {
          zipErrorCount += 1;
          console.warn("Skip unreadable ZIP", zipFile.name, error);
        }
      }
    }

    if (!imageFiles.length) {
      setStatus(zipErrorCount ? "文件读取失败" : "没有图片");
      setUploadProgress(0, 0, zipErrorCount ? "文件读取失败" : "没有图片");
      return;
    }

    const limited = discoveredCount > imageFiles.length;
    setStatus(limited ? `分析前 ${MAX_IMPORT_IMAGES} 张` : "分析中");
    setUploadProgress(0, imageFiles.length, "上传进度");
    const nextPhotos = [];
    for (const [index, file] of imageFiles.entries()) {
      try {
        if (imageFiles.length >= 40 && index % 20 === 0) {
          setStatus(`分析中 ${index + 1}/${imageFiles.length}`);
        }
        nextPhotos.push(await createPhotoRecord(file));
      } catch (error) {
        console.warn("Skip unreadable image", file.name, error);
      }
      setUploadProgress(index + 1, imageFiles.length, "上传进度");
    }

    if (!nextPhotos.length) {
      setStatus("图片读取失败");
      setUploadProgress(0, imageFiles.length, "图片读取失败");
      return;
    }

    state.selected = [];
    state.generated = false;
    state.photos.push(...nextPhotos);
    setUploadProgress(imageFiles.length, imageFiles.length, "上传完成");
    if (limited) {
      setStatus(`已取前 ${MAX_IMPORT_IMAGES} 张`);
    } else if (zipErrorCount) {
      setStatus("部分文件已跳过");
    } else {
      setStatus("上传完成");
    }
    renderLists();
    drawTemplate();
  } finally {
    state.importing = false;
    updateActionState();
  }
}

async function runSelection() {
  if (state.importing || state.selecting) {
    return;
  }

  const requiredCount = currentTemplate().requiredCount;
  if (!state.photos.length) {
    state.selected = [];
    state.generated = false;
    renderLists();
    drawTemplate();
    setStatus("待上传");
    updateActionState();
    return;
  }

  state.selecting = true;
  updateActionState();
  state.selected = selectBestPhotos(state.photos, requiredCount);
  state.generated = true;
  renderLists();
  drawTemplate();
  setStatus("本地预览");
  await waitForPaint();
  if (currentTemplate().layers) {
    await prepareSelectedCutouts(currentTemplate());
    drawTemplate();
    await waitForPaint();
  }

  try {
    const endpoint = els.modelEndpointInput.value.trim();
    if (!endpoint) {
      throw new Error("No model endpoint configured");
    }
    setModelState(`模型筛选中 ${Math.min(state.photos.length, MODEL_CANDIDATE_LIMIT)} 张`);
    setStatus("视觉模型筛选中");
    const modelResult = await requestModelSelection(endpoint, state.photos, requiredCount);
    state.selected = applyModelSelection(modelResult, requiredCount);
    setStatus("模型已生成");
    setModelState(`${formatModelName(modelResult.model)} 已连接`);
  } catch (error) {
    console.warn("Use local fallback selection", error);
    setStatus("本地已生成");
    setModelState(error.name === "AbortError" ? "模型超时，本地兜底" : "本地兜底");
  }

  state.generated = true;
  renderLists();
  drawTemplate();
  try {
    await prepareSelectedCutouts(currentTemplate());
    drawTemplate();
  } finally {
    state.selecting = false;
    updateActionState();
  }
}

function clearPhotos() {
  for (const photo of state.photos) {
    URL.revokeObjectURL(photo.url);
  }
  cutoutRequestCache.clear();
  state.photos = [];
  state.selected = [];
  state.generated = false;
  state.importing = false;
  state.selecting = false;
  renderLists();
  drawTemplate();
  setStatus("待上传");
  hideUploadProgress();
  updateActionState();
}

function resetCopy() {
  applyTemplateDefaultCopy(currentTemplate());
  drawTemplate();
}

function setTemplate(templateId) {
  if (!TEMPLATES[templateId] || state.templateId === templateId) {
    return;
  }
  const shouldApplyDefaults = copyMatchesDefault(currentTemplate());
  state.templateId = templateId;
  if (shouldApplyDefaults) {
    applyTemplateDefaultCopy(currentTemplate());
  }
  updateTemplateUI();
  if (state.photos.length) {
    runSelection();
  } else {
    drawTemplate();
  }
}

function updateTemplateUI(options = {}) {
  const template = currentTemplate();
  const templateName = getTemplateName(template);
  els.activeTemplateName.textContent = templateName;
  els.canvasMeta.textContent = template.meta;
  els.previewTitle.textContent = templateName;
  if (!options.preserveTemplateNameInput) {
    els.templateNameInput.value = templateName;
  }
  els.templateButtons.forEach((button) => {
    const buttonTemplate = TEMPLATES[button.dataset.templateId];
    const active = button.dataset.templateId === state.templateId;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
    const nameElement = button.querySelector("[data-template-name]");
    if (buttonTemplate && nameElement) {
      nameElement.textContent = getTemplateName(buttonTemplate);
    }
  });
  renderLists();
}

function currentTemplate() {
  return TEMPLATES[state.templateId];
}

function getTemplateName(template) {
  return state.templateNames[template.id] || template.title || template.shortName;
}

function setCurrentTemplateName(value) {
  const template = currentTemplate();
  const nextName = value.trim();
  if (nextName && nextName !== template.title) {
    state.templateNames[template.id] = nextName;
  } else {
    delete state.templateNames[template.id];
  }
  saveTemplateNames();
  updateTemplateUI({ preserveTemplateNameInput: true });
}

function loadTemplateNames() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TEMPLATE_NAME_STORAGE_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([templateId, name]) => TEMPLATES[templateId] && typeof name === "string" && name.trim())
        .map(([templateId, name]) => [templateId, name.trim()]),
    );
  } catch {
    return {};
  }
}

function saveTemplateNames() {
  try {
    localStorage.setItem(TEMPLATE_NAME_STORAGE_KEY, JSON.stringify(state.templateNames));
  } catch {
    // Local persistence is a convenience; the test bench should keep working without it.
  }
}

function applyTemplateDefaultCopy(template) {
  const copy = template.defaultCopy || TEMPLATES.template_1.defaultCopy;
  els.nicknameInput.value = copy.nickname || "";
  els.line1Input.value = copy.line1 || "";
  els.line2Input.value = copy.line2 || "";
  els.line3Input.value = copy.line3 || "";
  els.tagInput.value = copy.tag || "";
}

function copyMatchesDefault(template) {
  const copy = template.defaultCopy || {};
  return els.nicknameInput.value === (copy.nickname || "") &&
    els.line1Input.value === (copy.line1 || "") &&
    els.line2Input.value === (copy.line2 || "") &&
    els.line3Input.value === (copy.line3 || "") &&
    els.tagInput.value === (copy.tag || "");
}

async function collectDroppedFiles(dataTransfer) {
  const items = [...(dataTransfer.items || [])];
  const entries = items
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry?.())
    .filter(Boolean);

  if (!entries.length) {
    return [...dataTransfer.files];
  }

  const files = [];
  for (const entry of entries) {
    await collectEntryFiles(entry, files);
  }
  return stableSortFiles(files);
}

async function collectEntryFiles(entry, files) {
  if (entry.isFile) {
    files.push(await readFileEntry(entry));
    return;
  }

  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  while (true) {
    const entries = await readDirectoryEntries(reader);
    if (!entries.length) break;
    for (const child of entries) {
      await collectEntryFiles(child, files);
    }
  }
}

function readFileEntry(entry) {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

function readDirectoryEntries(reader) {
  return new Promise((resolve, reject) => {
    reader.readEntries(resolve, reject);
  });
}

function isImageFile(file) {
  return (file.type || "").startsWith("image/") || IMAGE_EXTENSION_PATTERN.test(file.name);
}

function isZipFile(file) {
  return file.type === "application/zip" ||
    file.type === "application/x-zip-compressed" ||
    ZIP_EXTENSION_PATTERN.test(file.name);
}

function stableSortFiles(files) {
  return [...files].sort((left, right) => {
    const leftKey = left.webkitRelativePath || left.name;
    const rightKey = right.webkitRelativePath || right.name;
    return leftKey.localeCompare(rightKey, "zh-Hans-CN", { numeric: true });
  });
}

async function extractZipImages(zipFile, maxFiles) {
  const arrayBuffer = await zipFile.arrayBuffer();
  const entries = readZipEntries(arrayBuffer)
    .filter((entry) => !entry.isDirectory && isImageName(entry.name));
  const files = [];

  for (const entry of entries) {
    if (files.length >= maxFiles) break;
    try {
      files.push(await readZipImageFile(arrayBuffer, entry, zipFile));
    } catch (error) {
      console.warn("Skip ZIP image entry", entry.name, error);
    }
  }

  return {
    files: stableSortFiles(files),
    totalImages: entries.length,
  };
}

function readZipEntries(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const eocdOffset = findEndOfCentralDirectory(view);
  if (eocdOffset < 0) {
    throw new Error("Invalid ZIP: missing central directory");
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  let offset = view.getUint32(eocdOffset + 16, true);
  const entries = [];

  for (let index = 0; index < totalEntries; index++) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("Invalid ZIP: bad central directory entry");
    }

    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const nameBytes = new Uint8Array(arrayBuffer, nameStart, fileNameLength);
    const name = decodeZipName(nameBytes, flags);

    entries.push({
      name,
      method,
      compressedSize,
      localHeaderOffset,
      isDirectory: name.endsWith("/"),
    });
    offset = nameStart + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function findEndOfCentralDirectory(view) {
  const minOffset = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let offset = view.byteLength - 22; offset >= minOffset; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      return offset;
    }
  }
  return -1;
}

function decodeZipName(bytes, flags) {
  try {
    const encoding = flags & 0x0800 ? "utf-8" : "gb18030";
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

async function readZipImageFile(arrayBuffer, entry, zipFile) {
  const view = new DataView(arrayBuffer);
  const localOffset = entry.localHeaderOffset;
  if (view.getUint32(localOffset, true) !== 0x04034b50) {
    throw new Error("Invalid ZIP: bad local header");
  }

  const fileNameLength = view.getUint16(localOffset + 26, true);
  const extraLength = view.getUint16(localOffset + 28, true);
  const dataStart = localOffset + 30 + fileNameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  const compressedData = arrayBuffer.slice(dataStart, dataEnd);
  let blob;

  if (entry.method === 0) {
    blob = new Blob([compressedData], { type: getImageMimeType(entry.name) });
  } else if (entry.method === 8) {
    blob = await inflateRawBlob(compressedData, getImageMimeType(entry.name));
  } else {
    throw new Error(`Unsupported ZIP compression method: ${entry.method}`);
  }

  const cleanZipName = zipFile.name.replace(ZIP_EXTENSION_PATTERN, "");
  const cleanEntryName = entry.name.split("/").filter(Boolean).join("/");
  const fileName = `${cleanZipName}/${cleanEntryName}`;
  return new File([blob], fileName, {
    type: blob.type,
    lastModified: zipFile.lastModified,
  });
}

async function inflateRawBlob(arrayBuffer, mimeType) {
  const DecompressionStreamCtor = globalThis.DecompressionStream;
  if (!DecompressionStreamCtor) {
    throw new Error("Current browser does not support ZIP deflate");
  }

  const stream = new Blob([arrayBuffer]).stream()
    .pipeThrough(new DecompressionStreamCtor("deflate-raw"));
  const blob = await new Response(stream).blob();
  return new Blob([blob], { type: mimeType });
}

function isImageName(name) {
  const normalized = name.split("/").pop() || "";
  return !normalized.startsWith(".") &&
    !name.startsWith("__MACOSX/") &&
    IMAGE_EXTENSION_PATTERN.test(normalized);
}

function getImageMimeType(name) {
  const extension = name.toLowerCase().split(".").pop();
  return {
    avif: "image/avif",
    bmp: "image/bmp",
    gif: "image/gif",
    heic: "image/heic",
    heif: "image/heif",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
  }[extension] || "application/octet-stream";
}

async function createPhotoRecord(file) {
  const url = URL.createObjectURL(file);
  const image = await loadImage(url);
  const metrics = analyzeImage(image);
  const hasTransparency = imageHasTransparency(image);
  const aspect = Math.max(image.naturalWidth, 1) / Math.max(image.naturalHeight, 1);
  const squareFit = clamp(1 - Math.abs(aspect - 1), 0, 1);
  const resolution = clamp((image.naturalWidth * image.naturalHeight) / (1600 * 1600), 0, 1);
  const baseScore =
    resolution * 0.28 +
    squareFit * 0.24 +
    metrics.contrast * 0.18 +
    metrics.sharpness * 0.18 +
    metrics.exposure * 0.12;

  return {
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    file,
    url,
    image,
    metrics,
    width: image.naturalWidth,
    height: image.naturalHeight,
    hasTransparency,
    baseScore,
    finalScore: baseScore,
  };
}

function imageHasTransparency(image) {
  const sample = document.createElement("canvas");
  const scale = Math.min(1, 128 / Math.max(image.naturalWidth, image.naturalHeight));
  sample.width = Math.max(1, Math.round(image.naturalWidth * scale));
  sample.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const sampleCtx = sample.getContext("2d", { willReadFrequently: true });
  sampleCtx.clearRect(0, 0, sample.width, sample.height);
  sampleCtx.drawImage(image, 0, 0, sample.width, sample.height);
  const data = sampleCtx.getImageData(0, 0, sample.width, sample.height).data;
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] < 250) {
      return true;
    }
  }
  return false;
}

function analyzeImage(image) {
  const sample = document.createElement("canvas");
  sample.width = 72;
  sample.height = 72;
  const sampleCtx = sample.getContext("2d", { willReadFrequently: true });
  sampleCtx.drawImage(image, 0, 0, sample.width, sample.height);
  const data = sampleCtx.getImageData(0, 0, sample.width, sample.height).data;

  let lumaSum = 0;
  let saturationSum = 0;
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  const lumas = [];

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lumas.push(luma);
    lumaSum += luma;
    saturationSum += max === 0 ? 0 : (max - min) / max;
    rSum += r;
    gSum += g;
    bSum += b;
  }

  const count = lumas.length;
  const mean = lumaSum / count;
  let variance = 0;
  let gradient = 0;
  for (let y = 1; y < sample.height; y++) {
    for (let x = 1; x < sample.width; x++) {
      const index = y * sample.width + x;
      const current = lumas[index];
      variance += (current - mean) ** 2;
      gradient += Math.abs(current - lumas[index - 1]);
      gradient += Math.abs(current - lumas[index - sample.width]);
    }
  }

  const contrast = clamp(Math.sqrt(variance / count) / 72, 0, 1);
  const sharpness = clamp(gradient / (count * 24), 0, 1);
  const exposure = clamp(1 - Math.abs(mean - 142) / 142, 0, 1);

  return {
    contrast,
    sharpness,
    exposure,
    saturation: clamp(saturationSum / count, 0, 1),
    signature: [rSum / count, gSum / count, bSum / count],
  };
}

function selectBestPhotos(photos, targetCount) {
  const candidates = [...photos].sort((a, b) => b.baseScore - a.baseScore);
  const selected = [];

  while (selected.length < targetCount && candidates.length) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      const duplicatePenalty = selected.reduce((penalty, chosen) => {
        const similarity = colorSimilarity(candidate.metrics.signature, chosen.metrics.signature);
        return Math.max(penalty, similarity * 0.16);
      }, 0);
      const varietyBoost = selected.length % 3 === 0 ? candidate.metrics.saturation * 0.04 : 0;
      const finalScore = candidate.baseScore - duplicatePenalty + varietyBoost;
      if (finalScore > bestScore) {
        bestScore = finalScore;
        bestIndex = index;
      }
    }
    const [picked] = candidates.splice(bestIndex, 1);
    picked.finalScore = bestScore;
    selected.push(picked);
  }

  return selected;
}

async function requestModelSelection(endpoint, photos, targetCount) {
  const candidates = [...photos]
    .sort((a, b) => b.baseScore - a.baseScore)
    .slice(0, MODEL_CANDIDATE_LIMIT);
  const payload = {
    templateId: state.templateId,
    targetCount,
    photos: await Promise.all(candidates.map(photoToModelPayload)),
  };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MODEL_REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
  if (!response.ok) {
    throw new Error(`Model API ${response.status}`);
  }
  const result = await response.json();
  if (!Array.isArray(result.selected)) {
    throw new Error("Model API response missing selected list");
  }
  if (result.modelAvailable === false) {
    throw new Error("Model bridge is reachable but vision model is unavailable");
  }
  return result;
}

async function prepareSelectedCutouts(template) {
  const cutoutPhotos = selectedCutoutPhotos(template);
  if (!cutoutPhotos.length) {
    return;
  }
  const cutoutModelName = template.cutout?.modelName || "本地抠图模型";

  const opaquePhotos = [];
  for (const photo of cutoutPhotos) {
    if (photo.hasTransparency) {
      photo.cutoutImage = photo.image;
      photo.cutoutStatus = "ready";
      photo.cutoutSource = "input-alpha";
    } else {
      opaquePhotos.push(photo);
    }
  }

  if (!opaquePhotos.length) {
    setModelState("透明 PNG 已就绪");
    return;
  }

  const cutoutEndpoint = deriveCutoutEndpoint(els.modelEndpointInput.value.trim());
  if (!cutoutEndpoint) {
    markCutoutFallback(opaquePhotos, "missing_cutout_endpoint");
    setModelState("无抠图服务，完整图预览");
    return;
  }

  let readyCount = cutoutPhotos.length - opaquePhotos.length;
  for (let index = 0; index < opaquePhotos.length; index++) {
    const photo = opaquePhotos[index];
    if (photo.cutoutStatus === "ready" && photo.cutoutEndpoint === cutoutEndpoint) {
      readyCount += 1;
      continue;
    }

    setStatus(`${cutoutModelName} 抠图中 ${index + 1}/${opaquePhotos.length}`);
    try {
      photo.cutoutImage = await requestPhotoCutout(cutoutEndpoint, photo);
      photo.cutoutStatus = "ready";
      photo.cutoutEndpoint = cutoutEndpoint;
      photo.cutoutSource = "service";
      photo.cutoutError = "";
      readyCount += 1;
      drawTemplate();
      await waitForPaint();
    } catch (error) {
      console.warn("Use full image for cutout layer", photo.file.name, error);
      photo.cutoutStatus = "fallback";
      photo.cutoutImage = null;
      photo.cutoutEndpoint = cutoutEndpoint;
      photo.cutoutError = error.message || String(error);

      if (isCutoutServiceUnavailable(error)) {
        markCutoutFallback(opaquePhotos.slice(index + 1), photo.cutoutError);
        setStatus("本地已生成");
        setModelState("抠图服务不可用，完整图预览");
        return;
      }
    }
  }

  setStatus("已生成并抠图");
  setModelState(`已抠图 ${readyCount}/${cutoutPhotos.length}`);
}

function selectedCutoutPhotos(template) {
  const seen = new Set();
  const photos = [];
  for (const layer of template.layers || []) {
    if (layer.type !== "image_cutout") continue;
    const photo = state.selected[layer.index];
    if (!photo || seen.has(photo.id)) continue;
    seen.add(photo.id);
    photos.push(photo);
  }
  return photos;
}

function deriveCutoutEndpoint(screenEndpoint) {
  if (!screenEndpoint) {
    return "";
  }
  try {
    const url = new URL(screenEndpoint, window.location.href);
    if (url.pathname.endsWith("/api/screen")) {
      url.pathname = url.pathname.replace(/\/api\/screen$/, "/api/cutout");
    } else if (url.pathname.endsWith("/screen")) {
      url.pathname = url.pathname.replace(/\/screen$/, "/cutout");
    } else {
      url.pathname = "/api/cutout";
    }
    return url.toString();
  } catch {
    return "";
  }
}

async function requestPhotoCutout(endpoint, photo) {
  const cacheKey = `${endpoint}:${photo.id}`;
  if (cutoutRequestCache.has(cacheKey)) {
    return cutoutRequestCache.get(cacheKey);
  }

  const request = requestPhotoCutoutUncached(endpoint, photo)
    .catch((error) => {
      cutoutRequestCache.delete(cacheKey);
      throw error;
    });
  cutoutRequestCache.set(cacheKey, request);
  return request;
}

async function requestPhotoCutoutUncached(endpoint, photo) {
  const payload = {
    id: photo.id,
    name: photo.file.name,
    image: imageToDataUrl(photo.image, CUTOUT_IMAGE_MAX_SIDE, "image/jpeg", 0.9),
  };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CUTOUT_REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    error.cutoutServiceUnavailable = true;
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  let result = null;
  try {
    result = await response.json();
  } catch {
    // Leave result empty; the status check below will surface the API failure.
  }

  if (!response.ok || result?.available === false) {
    const error = new Error(result?.error || `Cutout API ${response.status}`);
    error.cutoutServiceUnavailable = response.status === 404 ||
      response.status === 501 ||
      response.status === 503 ||
      response.status >= 500 ||
      result?.available === false;
    throw error;
  }

  if (!result?.image) {
    throw new Error("Cutout API response missing image");
  }

  return loadImage(result.image);
}

function markCutoutFallback(photos, reason) {
  for (const photo of photos) {
    photo.cutoutStatus = "fallback";
    photo.cutoutImage = null;
    photo.cutoutError = reason;
  }
}

function isCutoutServiceUnavailable(error) {
  return Boolean(error?.cutoutServiceUnavailable) ||
    error?.name === "AbortError" ||
    /Failed to fetch|Load failed|NetworkError|rembg_not_installed|not_found/i.test(error?.message || "");
}

async function photoToModelPayload(photo) {
  return {
    id: photo.id,
    name: photo.file.name,
    width: photo.width,
    height: photo.height,
    baseScore: photo.baseScore,
    metrics: photo.metrics,
    image: await imageToDataUrl(photo.image, MODEL_IMAGE_MAX_SIDE),
  };
}

function imageToDataUrl(image, maxSide, mimeType = "image/jpeg", quality = 0.82) {
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvasCtx = canvas.getContext("2d");
  canvasCtx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL(mimeType, quality);
}

function applyModelSelection(modelResult, targetCount) {
  const byId = new Map(state.photos.map((photo) => [photo.id, photo]));
  const resultById = new Map();
  for (const item of modelResult.results || []) {
    resultById.set(item.id, item);
  }
  for (const photo of state.photos) {
    const result = resultById.get(photo.id);
    if (result) {
      photo.modelResult = result;
      photo.finalScore = clamp(Number(result.score || 0) / 100, 0, 1);
      photo.selectionReason = result.reason || result.caption || "";
    }
  }

  const selected = [];
  for (const item of modelResult.selected) {
    const photo = byId.get(item.id);
    if (!photo) continue;
    photo.modelResult = item;
    photo.finalScore = clamp(Number(item.score || 0) / 100, 0, 1);
    photo.selectionReason = item.reason || item.caption || photo.selectionReason || "";
    selected.push(photo);
  }

  if (selected.length < targetCount) {
    const selectedIds = new Set(selected.map((photo) => photo.id));
    const localFill = selectBestPhotos(
      state.photos.filter((photo) => !selectedIds.has(photo.id)),
      targetCount - selected.length,
    );
    selected.push(...localFill);
  }

  return selected.slice(0, targetCount);
}

function colorSimilarity(a, b) {
  const distance = Math.sqrt(
    (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2,
  );
  return clamp(1 - distance / 210, 0, 1);
}

function drawTemplate() {
  const template = currentTemplate();
  ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  ctx.fillStyle = template.backgroundColor || "#140d12";
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  if (template.layers) {
    drawTemplateLayers(template);
    drawCopy(template);
    return;
  }

  if (template.backgroundUrl) {
    const background = getAssetImage(template.backgroundUrl);
    if (background.complete && background.naturalWidth) {
      drawImageCover(background, { x: 0, y: 0, w: CANVAS_WIDTH, h: CANVAS_HEIGHT });
    } else {
      drawFallbackBackground(template);
    }
  }

  for (let index = 0; index < template.photoSlots.length; index++) {
    const photo = state.selected[index];
    if (!photo) continue;
    drawPhotoSlot(photo.image, template.photoSlots[index]);
  }

  for (const overlay of template.overlays || []) {
    const overlayImage = getAssetImage(overlay.url);
    if (overlayImage.complete && overlayImage.naturalWidth) {
      drawImageCover(overlayImage, overlay.frame);
    }
  }

  drawCopy(template);
}

function drawTemplateLayers(template) {
  for (const layer of template.layers) {
    if (layer.type === "mock") {
      drawMockLayer(layer);
      continue;
    }

    if (layer.type !== "image" && layer.type !== "image_cutout") {
      continue;
    }

    const photo = state.selected[layer.index];
    if (!photo) {
      continue;
    }

    drawImageLayer(photo, layer);
  }
}

function drawMockLayer(layer) {
  const frame = layer.frame;
  ctx.save();
  applyLayerTransform(layer);
  ctx.beginPath();
  drawRoundedRectPath(-frame.w / 2, -frame.h / 2, frame.w, frame.h, layer.radius || 0);
  ctx.fillStyle = layer.color || "#f8f8f8";
  ctx.fill();
  ctx.restore();
}

function drawImageLayer(photo, layer) {
  const frame = layer.frame;
  ctx.save();
  applyLayerTransform(layer);
  ctx.beginPath();
  drawRoundedRectPath(-frame.w / 2, -frame.h / 2, frame.w, frame.h, layer.radius || 0);
  ctx.clip();

  if (layer.type === "image_cutout") {
    drawImageCoverToContext(
      ctx,
      photo.cutoutImage || photo.image,
      { x: -frame.w / 2, y: -frame.h / 2, w: frame.w, h: frame.h },
      layer,
    );
  } else {
    drawImageCoverToContext(
      ctx,
      photo.image,
      { x: -frame.w / 2, y: -frame.h / 2, w: frame.w, h: frame.h },
      layer,
    );
    if (layer.shadow) {
      drawImageLayerShadow(frame);
    }
  }

  ctx.restore();
}

function applyLayerTransform(layer) {
  const frame = layer.frame;
  ctx.translate(frame.x + frame.w / 2, frame.y + frame.h / 2);
  ctx.rotate(((layer.rotationDegrees || 0) * Math.PI) / 180);
  ctx.scale(layer.scaleX || 1, layer.scaleY || 1);
}

function drawImageLayerShadow(frame) {
  const vignette = ctx.createRadialGradient(
    0,
    0,
    frame.w * 0.12,
    0,
    0,
    frame.w * 0.78,
  );
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.32)");
  ctx.fillStyle = vignette;
  ctx.fillRect(-frame.w / 2, -frame.h / 2, frame.w, frame.h);
}

function drawFallbackBackground(template) {
  ctx.fillStyle = "#130d11";
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  for (const slot of template.photoSlots) {
    ctx.fillStyle = "#f6f5f0";
    drawSlotRect(slot, () => ctx.fillRect(-slot.w / 2, -slot.h / 2, slot.w, slot.h));
    const gradient = ctx.createRadialGradient(
      0,
      0,
      slot.w * 0.18,
      0,
      0,
      slot.w * 0.68,
    );
    gradient.addColorStop(0, "rgba(255,255,255,0)");
    gradient.addColorStop(1, "rgba(0,0,0,0.18)");
    ctx.fillStyle = gradient;
    drawSlotRect(slot, () => ctx.fillRect(-slot.w / 2, -slot.h / 2, slot.w, slot.h));
  }
}

function drawPhotoSlot(image, slot) {
  ctx.save();
  const radius = Math.max(0, slot.cornerRadius || 0);
  const x = -slot.w / 2;
  const y = -slot.h / 2;
  ctx.translate(slot.x + slot.w / 2, slot.y + slot.h / 2);
  ctx.rotate(((slot.rotationDegrees || 0) * Math.PI) / 180);
  ctx.beginPath();
  drawRoundedRectPath(x, y, slot.w, slot.h, radius);
  ctx.clip();

  let sx = 0;
  let sy = 0;
  let sw = image.naturalWidth;
  let sh = image.naturalHeight;
  const sourceAspect = sw / sh;
  const destAspect = slot.w / slot.h;
  if (sourceAspect > destAspect) {
    const nextWidth = sh * destAspect;
    sx += (sw - nextWidth) / 2;
    sw = nextWidth;
  } else if (sourceAspect < destAspect) {
    const nextHeight = sw / destAspect;
    sy += (sh - nextHeight) / 2;
    sh = nextHeight;
  }

  ctx.drawImage(image, sx, sy, sw, sh, x, y, slot.w, slot.h);

  if (slot.useEffects !== false) {
    const vignette = ctx.createRadialGradient(0, 0, slot.w * 0.18, 0, 0, slot.w * 0.72);
    vignette.addColorStop(0, "rgba(0,0,0,0)");
    vignette.addColorStop(1, "rgba(0,0,0,0.28)");
    ctx.fillStyle = vignette;
    ctx.fillRect(x, y, slot.w, slot.h);
    ctx.strokeStyle = "rgba(0,0,0,0.40)";
    ctx.lineWidth = 4;
    ctx.strokeRect(x + 2, y + 2, slot.w - 4, slot.h - 4);
  }

  ctx.restore();
}

function drawCopy(template) {
  ctx.save();
  ctx.textBaseline = "top";
  ctx.fillStyle = "#c4ced1";
  ctx.font = "800 44px -apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif";
  for (const line of template.copyLines || []) {
    drawFittedText(getCopyValue(line.key), line.rect, 44, 28, "800");
  }

  if (template.signature) {
    const fallbackName = template.defaultCopy?.nickname || "Me";
    const nickname = (els.nicknameInput.value || fallbackName).slice(
      0,
      template.signature.maxCharacters || 18,
    );
    drawCenteredText(
      `${nickname}${template.signature.suffix || ""}`,
      template.signature.rect,
      template.signature.maxSize || 64,
      template.signature.minSize || 36,
      template.signature.weight || "500",
      template.signature.color || "rgba(255,255,255,0.80)",
      signatureFontStack(),
    );
  }
  ctx.restore();
}

function drawImageCover(image, frame) {
  drawImageCoverToContext(ctx, image, frame);
}

function drawImageCoverToContext(targetCtx, image, frame, options = {}) {
  const sourceAspect = image.naturalWidth / image.naturalHeight;
  const destAspect = frame.w / frame.h;
  const alignX = alignmentFactor(options.alignX);
  const alignY = alignmentFactor(options.alignY);
  let sx = 0;
  let sy = 0;
  let sw = image.naturalWidth;
  let sh = image.naturalHeight;

  if (sourceAspect > destAspect) {
    sw = sh * destAspect;
    sx = (image.naturalWidth - sw) * alignX;
  } else if (sourceAspect < destAspect) {
    sh = sw / destAspect;
    sy = (image.naturalHeight - sh) * alignY;
  }

  targetCtx.drawImage(image, sx, sy, sw, sh, frame.x, frame.y, frame.w, frame.h);
}

function alignmentFactor(value) {
  return {
    left: 0,
    top: 0,
    center: 0.5,
    right: 1,
    bottom: 1,
  }[value || "center"] ?? 0.5;
}

function drawSlotRect(slot, draw) {
  ctx.save();
  ctx.translate(slot.x + slot.w / 2, slot.y + slot.h / 2);
  ctx.rotate(((slot.rotationDegrees || 0) * Math.PI) / 180);
  draw();
  ctx.restore();
}

function drawRoundedRectPath(x, y, width, height, radius, targetCtx = ctx) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  if (safeRadius <= 0) {
    targetCtx.rect(x, y, width, height);
    return;
  }
  targetCtx.moveTo(x + safeRadius, y);
  targetCtx.lineTo(x + width - safeRadius, y);
  targetCtx.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  targetCtx.lineTo(x + width, y + height - safeRadius);
  targetCtx.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  targetCtx.lineTo(x + safeRadius, y + height);
  targetCtx.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  targetCtx.lineTo(x, y + safeRadius);
  targetCtx.quadraticCurveTo(x, y, x + safeRadius, y);
}

function drawFittedText(text, rect, maxSize, minSize, weight) {
  const value = text || "";
  let size = maxSize;
  do {
    ctx.font = `${weight} ${size}px -apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif`;
    if (ctx.measureText(value).width <= rect.w || size <= minSize) break;
    size -= 2;
  } while (size >= minSize);
  ctx.fillStyle = "#c4ced1";
  ctx.fillText(value, rect.x, rect.y + Math.max(0, (rect.h - size) / 2));
}

function getCopyValue(key) {
  return {
    line1: els.line1Input.value,
    line2: els.line2Input.value,
    line3: els.line3Input.value,
    tag: els.tagInput.value,
  }[key] || "";
}

function drawCenteredText(text, rect, maxSize, minSize, weight, color, fontStack = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif") {
  let size = maxSize;
  do {
    ctx.font = `${weight} ${size}px ${fontStack}`;
    if (ctx.measureText(text).width <= rect.w || size <= minSize) break;
    size -= 2;
  } while (size >= minSize);
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.fillText(text, rect.x + rect.w / 2, rect.y + Math.max(0, (rect.h - size) / 2));
  ctx.textAlign = "left";
}

function renderLists() {
  const requiredCount = currentTemplate().requiredCount;
  els.selectedCount.textContent = `${state.selected.length}/${requiredCount}`;

  if (!state.selected.length) {
    const emptyText = state.photos.length ? "已导入图片，等待筛选" : "等待筛选结果";
    els.selectedList.innerHTML = `<div class="selected-empty">${emptyText}</div>`;
  } else {
    els.selectedList.innerHTML = state.selected
      .map((photo, index) => {
        return `
          <div class="selected-item">
            <img src="${photo.url}" alt="入选图片 ${index + 1}" />
            <div class="selected-meta">
              <strong>${index + 1}. ${escapeHtml(photo.file.name)}</strong>
              <small>${escapeHtml(photo.selectionReason || `${photo.width}x${photo.height}`)}</small>
            </div>
            <span class="score-badge">${Math.round(photo.finalScore * 100)}</span>
          </div>
        `;
      })
      .join("");
  }

  els.thumbGrid.innerHTML = "";
}

function downloadCanvas() {
  drawTemplate();
  els.canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `echooo-${currentTemplate().id}-${new Date().toISOString().slice(0, 10)}.png`;
    link.click();
    URL.revokeObjectURL(url);
  }, "image/png");
}

function preloadTemplateAssets() {
  for (const template of Object.values(TEMPLATES)) {
    if (template.backgroundUrl) {
      getAssetImage(template.backgroundUrl);
    }
    for (const overlay of template.overlays || []) {
      getAssetImage(overlay.url);
    }
  }
}

function getAssetImage(url) {
  if (assetImages.has(url)) {
    return assetImages.get(url);
  }

  const image = new Image();
  image.onload = drawTemplate;
  image.onerror = () => {
    if (url === currentTemplate().backgroundUrl) {
      setStatus("素材加载失败");
    }
    drawTemplate();
  };
  image.src = url;
  assetImages.set(url, image);
  return image;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

async function loadSignatureFont() {
  if (!globalThis.FontFace || !document.fonts) {
    return;
  }

  try {
    const signatureFont = new FontFace(
      SIGNATURE_FONT_FAMILY,
      `url("${SIGNATURE_FONT_URL}")`,
      { style: "normal", weight: "500" },
    );
    document.fonts.add(await signatureFont.load());
    drawTemplate();
  } catch (error) {
    console.warn("Signature font failed to load", error);
  }
}

function signatureFontStack() {
  return `"${SIGNATURE_FONT_FAMILY}", -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif`;
}

function waitForPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function setStatus(text) {
  els.statusText.textContent = text;
}

function setUploadProgress(current, total, label) {
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;
  els.uploadProgress.hidden = false;
  els.uploadProgress.setAttribute("aria-valuenow", String(percent));
  els.uploadProgressText.textContent = total > 0 ? `${label} ${current}/${total}` : label;
  els.uploadProgressPercent.textContent = `${percent}%`;
  els.uploadProgressBar.style.width = `${percent}%`;
}

function hideUploadProgress() {
  els.uploadProgress.hidden = true;
  els.uploadProgress.setAttribute("aria-valuenow", "0");
  els.uploadProgressText.textContent = "上传进度 0/0";
  els.uploadProgressPercent.textContent = "0%";
  els.uploadProgressBar.style.width = "0%";
}

function updateActionState() {
  const busy = state.importing || state.selecting;
  els.generateButton.disabled = busy || !state.photos.length;
  els.downloadButton.disabled = busy || !state.selected.length;
  els.clearButton.disabled = busy || !state.photos.length;
  els.fileInput.disabled = busy;
  els.dropZone.classList.toggle("is-busy", busy);
}

function setModelState(text) {
  els.modelStateText.textContent = text;
}

function formatModelName(model) {
  if (!model) return "视觉模型";
  return model
    .replace(":4b-instruct", "")
    .replace(":4b", "")
    .replace("-instruct", "");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    }[char];
  });
}

renderLists();
updateTemplateUI();
hideUploadProgress();
updateActionState();
drawTemplate();
