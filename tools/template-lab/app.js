const CANVAS_WIDTH = 2000;
const CANVAS_HEIGHT = 2668;
const ASSET_ROOT = "../../assets/templates";
const SIGNATURE_FONT_FAMILY = "MomoZhuanji";
const SIGNATURE_FONT_URL = `${ASSET_ROOT}/template_1/fonts/momo-zhuanji-handwriting-4.0.ttf`;
const MODEL_CANDIDATE_LIMIT = 16;
const MODEL_IMAGE_MAX_SIDE = 768;
const MODEL_REQUEST_TIMEOUT_MS = 90000;
const CUTOUT_IMAGE_MAX_SIDE = 1800;
const CUTOUT_REQUEST_TIMEOUT_MS = 120000;
const MAX_IMPORT_IMAGES = 300;
const TEMPLATE_NAME_STORAGE_KEY = "echooo-template-lab-template-names";
const IMAGE_EXTENSION_PATTERN = /\.(avif|bmp|heic|heif|jpe?g|png|webp)$/i;
const ZIP_EXTENSION_PATTERN = /\.zip$/i;
const DYNAMIC_MEDIA_EXTENSION_PATTERN = /\.(gif|mov|mp4|m4v|avi|webm)$/i;
const SCREEN_CAPTURE_NAME_PATTERN = /(screenshot|screen[ _-]?shot|screen[ _-]?capture|screen[ _-]?record|screenrecording|rp[ _-]?replay|截屏|截图|屏幕截图|屏幕录制|屏幕录像|录屏|螢幕快照|螢幕截圖|螢幕錄影)/i;
const PRIVACY_NAME_PATTERN = /(身份证|证件|护照|银行卡|信用卡|验证码|密码|支付码|收款码|二维码|账单|订单|快递|运单|地址|病历|处方|医保|社保|合同|发票|票据|id[ _-]?card|passport|bank[ _-]?card|credit[ _-]?card|password|verification[ _-]?code|payment|invoice|receipt|bill|order|tracking|address|medical|license[ _-]?plate|qr[ _-]?code)/i;
const DUPLICATE_HASH_DISTANCE = 6;
const NEAR_DUPLICATE_HASH_DISTANCE = 10;
const NEAR_DUPLICATE_COLOR_SIMILARITY = 0.9;

const TEMPLATE_3_REQUIREMENTS = {
  imageBg: {
    visualLayer: 10,
    referenceRole: "10 background, no cutout",
    intent: "Full background image, not a cutout. It should read like the final reference background: travel, architecture, city street, mountain, or wide landscape scene.",
    requiredSubjects: ["building", "architecture", "landscape"],
    preferredContent: ["travel", "outdoor", "city", "mountain", "wide_scene"],
    template3Roles: ["background_photo"],
    avoidContent: ["closeup_portrait", "screenshot", "text_document"],
    useCompletePhoto: true,
  },
  building: {
    visualLayer: 10,
    referenceRole: "background architecture support",
    intent: "Transparent cutout of a building, tower, landmark, street facade, or architectural foreground that supports the background.",
    requiredSubjects: ["building", "architecture", "landmark"],
    preferredContent: ["travel", "city", "tower", "street", "outdoor"],
    template3Roles: ["building_cutout"],
    avoidContent: ["closeup_portrait", "food_closeup", "screenshot"],
    completeSubject: true,
    minSubjectBboxRatio: 0.28,
    cutoutDisplay: { minFrameCoverage: 0.82, maxAutoScale: 1.22, transparentTrimPadding: 0.015 },
  },
  animalPetBack: {
    visualLayer: 9,
    referenceRole: "9 complete animal cutout",
    intent: "Complete animal or pet cutout for the upper-left reference position, such as sheep, goat, cat, dog, or another clear animal.",
    requiredSubjects: ["animal", "pet"],
    preferredContent: ["cat", "dog", "goat", "sheep", "cute_subject"],
    template3Roles: ["animal_pet_cutout"],
    avoidContent: ["building_only", "food_only", "screenshot"],
    completeSubject: true,
    minSubjectBboxRatio: 0.24,
    cutoutDisplay: { minFrameCoverage: 0.72, maxAutoScale: 1.45, transparentTrimPadding: 0.02 },
  },
  animalPetFront: {
    visualLayer: 2,
    referenceRole: "2 complete animal cutout",
    intent: "Complete animal or pet cutout for the lower-left foreground position. The whole animal should be visible and not clipped by the source photo.",
    requiredSubjects: ["animal", "pet"],
    preferredContent: ["cat", "dog", "goat", "sheep", "cute_subject"],
    template3Roles: ["animal_pet_cutout"],
    avoidContent: ["building_only", "food_only", "screenshot"],
    completeSubject: true,
    minSubjectBboxRatio: 0.24,
    cutoutDisplay: { minFrameCoverage: 0.72, maxAutoScale: 1.4, transparentTrimPadding: 0.02 },
  },
  foodBack: {
    visualLayer: 8,
    referenceRole: "8 complete food cutout",
    intent: "Complete food cutout for back/mid food positions. Prefer a dish, plate, bowl, drink, or restaurant table item with clear full boundary.",
    requiredSubjects: ["food"],
    preferredContent: ["dish", "plate", "bowl", "restaurant", "meal", "dessert", "drink"],
    template3Roles: ["food_cutout"],
    avoidContent: ["portrait_only", "building_only", "screenshot"],
    completeSubject: true,
    minSubjectBboxRatio: 0.32,
    cutoutDisplay: { minFrameCoverage: 0.78, maxAutoScale: 1.35, transparentTrimPadding: 0.012 },
  },
  foodFront: {
    visualLayer: 1,
    referenceRole: "1 complete food cutout, left edge should not be cropped",
    intent: "Complete foreground food cutout. Prefer a wide food/table photo where the food continues naturally and the left side of the source image is not visibly clipped.",
    requiredSubjects: ["food"],
    preferredContent: ["dish", "plate", "bowl", "restaurant", "meal", "wide_food_table"],
    template3Roles: ["food_cutout"],
    avoidContent: ["portrait_only", "building_only", "screenshot"],
    completeSubject: true,
    avoidCroppedEdges: ["left"],
    minSubjectBboxRatio: 0.34,
    cutoutDisplay: { minFrameCoverage: 0.88, maxAutoScale: 1.35, transparentTrimPadding: 0.01, alignY: "bottom" },
  },
  personRight: {
    visualLayer: 5,
    referenceRole: "5 complete person cutout, left edge should not be cropped",
    intent: "Complete person cutout for the right-side portrait position. The person should have a clear face/body and the left side of the source image should not cut through the subject.",
    requiredSubjects: ["person", "portrait"],
    preferredContent: ["selfie", "face", "upper_body", "daily_life"],
    template3Roles: ["person_cutout"],
    avoidContent: ["food_only", "building_only", "landscape_only", "screenshot"],
    completeSubject: true,
    preserveFace: true,
    avoidCroppedEdges: ["left"],
    minSubjectBboxRatio: 0.34,
    cutoutDisplay: { minFrameCoverage: 0.82, maxAutoScale: 1.3, transparentTrimPadding: 0.018, alignX: "right" },
  },
  personLeft: {
    visualLayer: 2,
    referenceRole: "2 complete person cutout, right edge should not be cropped",
    intent: "Complete person cutout for the large lower-left foreground position. Prefer a clear portrait/selfie where the right side of the source image does not cut through the subject.",
    requiredSubjects: ["person", "portrait"],
    preferredContent: ["selfie", "face", "upper_body", "daily_life"],
    template3Roles: ["person_cutout"],
    avoidContent: ["food_only", "building_only", "landscape_only", "screenshot"],
    completeSubject: true,
    preserveFace: true,
    avoidCroppedEdges: ["right"],
    minSubjectBboxRatio: 0.36,
    cutoutDisplay: { minFrameCoverage: 0.86, maxAutoScale: 1.22, transparentTrimPadding: 0.018, alignX: "left" },
  },
  plant: {
    visualLayer: 4,
    referenceRole: "4 complete plant cutout, left edge should not be cropped",
    intent: "Complete plant or flower cutout for the right foreground. Prefer bouquet, flowers, or leaves where the left side of the source image is not visibly clipped.",
    requiredSubjects: ["plant", "flower"],
    preferredContent: ["bouquet", "leaves", "floral", "decorative_object"],
    template3Roles: ["plant_cutout"],
    avoidContent: ["portrait_only", "building_only", "screenshot"],
    completeSubject: true,
    avoidCroppedEdges: ["left"],
    minSubjectBboxRatio: 0.26,
    cutoutDisplay: { minFrameCoverage: 0.8, maxAutoScale: 1.35, transparentTrimPadding: 0.018, alignX: "right", alignY: "bottom" },
  },
  peopleSceneMain: {
    visualLayer: 6,
    referenceRole: "6 polaroid",
    intent: "Complete rectangular polaroid photo. Prefer a strong daily-life people scene, mirror selfie, friends, or indoor moment that looks good inside the tilted frame.",
    requiredSubjects: ["person", "people"],
    preferredContent: ["group_photo", "friends", "indoor", "party", "mirror_selfie", "daily_life"],
    template3Roles: ["polaroid_people"],
    avoidContent: ["isolated_object_only", "screenshot", "text_document"],
    useCompletePhoto: true,
  },
  peopleSceneTop: {
    visualLayer: 7,
    referenceRole: "7 polaroid",
    intent: "Complete rectangular polaroid photo for the upper frame. Prefer a lively group photo, party, or friends scene that remains readable when small.",
    requiredSubjects: ["person", "people"],
    preferredContent: ["group_photo", "friends", "indoor", "party", "daily_life"],
    template3Roles: ["polaroid_people"],
    avoidContent: ["isolated_object_only", "screenshot", "text_document"],
    useCompletePhoto: true,
  },
  storyScene: {
    visualLayer: 3,
    referenceRole: "3 polaroid",
    intent: "Complete rectangular polaroid photo for the lower frame. Prefer travel, landscape, food scene, or story-heavy daily moment that matches the final collage.",
    requiredSubjects: ["scene"],
    preferredContent: ["travel", "landscape", "food_scene", "daily_life", "outdoor"],
    template3Roles: ["polaroid_story"],
    avoidContent: ["screenshot", "text_document", "blank_scene"],
    useCompletePhoto: true,
  },
};

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
    requiredCount: 14,
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
      { id: "image_bg", name: "image_bg", figmaNodeId: "155:119", type: "image", index: 0, frame: { x: 0, y: 0, w: 2000, h: 2668 }, requirements: TEMPLATE_3_REQUIREMENTS.imageBg },
      { id: "image_cutout_building_02", name: "image_cutout_building_02", figmaNodeId: "155:174", type: "image_cutout", index: 1, frame: { x: 0, y: 0, w: 954, h: 1349 }, alignY: "bottom", requirements: TEMPLATE_3_REQUIREMENTS.building },
      { id: "image_cutout_building_01", name: "image_cutout_building_01", figmaNodeId: "155:172", type: "image_cutout", index: 2, frame: { x: 0, y: 0, w: 2000, h: 2116 }, alignY: "top", requirements: TEMPLATE_3_REQUIREMENTS.building },
      { id: "image_cutout_animal_pet_02", name: "image_cutout_animal/pet_02", figmaNodeId: "155:120", type: "image_cutout", index: 3, frame: { x: 0, y: 0, w: 476, h: 708 }, requirements: TEMPLATE_3_REQUIREMENTS.animalPetBack },
      { id: "image_cutout_food_03", name: "image_cutout_food_03", figmaNodeId: "155:121", type: "image_cutout", index: 4, frame: { x: 1406.5, y: 17.5, w: 610.917, h: 575.917 }, rotationDegrees: -90, requirements: TEMPLATE_3_REQUIREMENTS.foodBack },
      { id: "mock_01_back", figmaNodeId: "155:122", type: "mock", frame: { x: 298.495, y: 831.514, w: 1131.269, h: 750.334 }, rotationDegrees: -13.05, radius: 7.12, color: "#f8f8f8" },
      { id: "image_cutout_food_02", name: "image_cutout_food_02", figmaNodeId: "155:123", type: "image_cutout", index: 5, frame: { x: -4, y: 568, w: 636, h: 456 }, requirements: TEMPLATE_3_REQUIREMENTS.foodBack },
      { id: "mock_01_front", figmaNodeId: "155:128", type: "mock", frame: { x: 288.349, y: 831.214, w: 1129.599, h: 645.91 }, rotationDegrees: -13.05, radius: 7.12, color: "#f2f3ee" },
      { id: "image01", name: "image01", figmaNodeId: "155:129", type: "image", index: 6, frame: { x: 316.624, y: 865.532, w: 1065.05, h: 583.403 }, rotationDegrees: -13.05, radius: 3.56, shadow: true, requirements: TEMPLATE_3_REQUIREMENTS.peopleSceneMain },
      { id: "mock_02_back", figmaNodeId: "155:130", type: "mock", frame: { x: 904.786, y: 168.733, w: 800.909, h: 579.725 }, rotationDegrees: 9.09, radius: 5.501, color: "#f8f8f8" },
      { id: "mock_02_front", figmaNodeId: "155:131", type: "mock", frame: { x: 912.758, y: 168.287, w: 799.727, h: 499.044 }, rotationDegrees: 9.09, radius: 5.501, color: "#f2f3ee" },
      { id: "image02", name: "image02", figmaNodeId: "155:132", type: "image", index: 7, frame: { x: 932.109, y: 193.509, w: 754.028, h: 450.75 }, rotationDegrees: 9.09, radius: 2.751, shadow: true, requirements: TEMPLATE_3_REQUIREMENTS.peopleSceneTop },
      { id: "mock_03_back", figmaNodeId: "155:133", type: "mock", frame: { x: 870.232, y: 1754.815, w: 986.643, h: 714.166 }, rotationDegrees: 9.09, radius: 6.777, color: "#f8f8f8" },
      { id: "image_cutout_person_02", name: "image_cutout_person_02", figmaNodeId: "155:134", type: "image_cutout", index: 8, frame: { x: 1134, y: 485, w: 866, h: 1303 }, requirements: TEMPLATE_3_REQUIREMENTS.personRight },
      { id: "image_cutout_plant_01", name: "image_cutout_plant_01", figmaNodeId: "155:135", type: "image_cutout", index: 9, frame: { x: 1424, y: 1273, w: 584, h: 843 }, alignY: "top", requirements: TEMPLATE_3_REQUIREMENTS.plant },
      { id: "mock_03_front", figmaNodeId: "155:136", type: "mock", frame: { x: 880.058, y: 1754.264, w: 985.186, h: 614.775 }, rotationDegrees: 9.09, radius: 6.777, color: "#f2f3ee" },
      { id: "image03", name: "image03", figmaNodeId: "155:143", type: "image", index: 10, frame: { x: 903.93, y: 1785.35, w: 928.89, h: 555.281 }, rotationDegrees: 9.09, radius: 3.389, shadow: true, requirements: TEMPLATE_3_REQUIREMENTS.storyScene },
      { id: "image_cutout_person_01", name: "image_cutout_person_01", figmaNodeId: "155:144", type: "image_cutout", index: 11, frame: { x: 0, y: 1234, w: 1212, h: 1434 }, rotationDegrees: 180, scaleY: -1, requirements: TEMPLATE_3_REQUIREMENTS.personLeft },
      { id: "image_cutout_animal_pet_01", name: "image_cutout_animal/pet_01", figmaNodeId: "155:145", type: "image_cutout", index: 12, frame: { x: -36.107, y: 1029.225, w: 550.866, h: 359.408 }, rotationDegrees: 172.15, scaleY: -1, alignY: "bottom", requirements: TEMPLATE_3_REQUIREMENTS.animalPetFront },
      { id: "image_cutout_food_01", name: "image_cutout_food_01", figmaNodeId: "155:146", type: "image_cutout", index: 13, frame: { x: 716, y: 2116, w: 1292, h: 552 }, requirements: TEMPLATE_3_REQUIREMENTS.foodFront },
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
  nextPhotoIndex: 0,
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
const cutoutBoundsCache = new WeakMap();

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
    const directMedia = sortedFiles.filter(isImportMediaFile);
    const directImages = [];
    let prefilterRejectCount = 0;
    let unreadableCount = 0;

    for (const file of directMedia) {
      const reasons = prefilterFileReasons(file);
      if (reasons.length || !isImageFile(file)) {
        prefilterRejectCount += 1;
      } else {
        directImages.push(file);
      }
    }

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
          prefilterRejectCount += zipResult.prefilterRejectCount;
          imageFiles.push(...zipResult.files);
        } catch (error) {
          zipErrorCount += 1;
          console.warn("Skip unreadable ZIP", zipFile.name, error);
        }
      }
    }

    if (!imageFiles.length) {
      const emptyLabel = prefilterRejectCount ? "已过滤，无可用图片" : (zipErrorCount ? "文件读取失败" : "没有图片");
      setStatus(emptyLabel);
      setUploadProgress(0, 0, emptyLabel);
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
        const photo = await createPhotoRecord(file);
        const reasons = prefilterPhotoReasons(photo);
        if (reasons.length) {
          photo.prefilterReasons = reasons;
          URL.revokeObjectURL(photo.url);
          prefilterRejectCount += 1;
        } else {
          nextPhotos.push(photo);
        }
      } catch (error) {
        unreadableCount += 1;
        console.warn("Skip unreadable image", file.name, error);
      }
      setUploadProgress(index + 1, imageFiles.length, "上传进度");
    }

    if (!nextPhotos.length && !state.photos.length) {
      const emptyLabel = prefilterRejectCount ? "已过滤，无可用图片" : "图片读取失败";
      setStatus(emptyLabel);
      setUploadProgress(imageFiles.length, imageFiles.length, emptyLabel);
      return;
    }

    state.selected = [];
    state.generated = false;
    const deduped = dedupePhotoPool([...state.photos, ...nextPhotos]);
    state.photos = deduped.photos;
    for (const photo of deduped.removed) {
      URL.revokeObjectURL(photo.url);
    }

    setUploadProgress(imageFiles.length, imageFiles.length, "上传完成");
    setStatus(formatImportStatus({
      limited,
      prefilterRejectCount,
      duplicateCount: deduped.removed.length,
      skippedCount: zipErrorCount + unreadableCount,
    }));
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
    const modelResult = await requestModelSelection(endpoint, state.photos, currentTemplate());
    state.selected = applyModelSelection(modelResult, currentTemplate());
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
  state.nextPhotoIndex = 0;
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
  if (isUnsupportedDynamicMedia(file)) {
    return false;
  }
  return (file.type || "").startsWith("image/") || IMAGE_EXTENSION_PATTERN.test(file.name);
}

function isImportMediaFile(file) {
  const type = file.type || "";
  return type.startsWith("image/") ||
    type.startsWith("video/") ||
    IMAGE_EXTENSION_PATTERN.test(file.name) ||
    DYNAMIC_MEDIA_EXTENSION_PATTERN.test(file.name);
}

function isUnsupportedDynamicMedia(file) {
  const type = file.type || "";
  return type === "image/gif" ||
    type.startsWith("video/") ||
    DYNAMIC_MEDIA_EXTENSION_PATTERN.test(file.name);
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
  const eligibleEntries = entries.filter((entry) => !prefilterNameReasons(entry.name).length);
  const files = [];

  for (const entry of eligibleEntries) {
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
    prefilterRejectCount: entries.length - eligibleEntries.length,
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
  const exactHash = await hashFile(file);
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
    exactHash,
    width: image.naturalWidth,
    height: image.naturalHeight,
    hasTransparency,
    baseScore,
    finalScore: baseScore,
    importIndex: state.nextPhotoIndex++,
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
  const fingerprint = averageHashFromLumas(lumas, sample.width, sample.height);

  return {
    contrast,
    sharpness,
    exposure,
    saturation: clamp(saturationSum / count, 0, 1),
    signature: [rSum / count, gSum / count, bSum / count],
    centerSignature: averageRgbRegion(data, sample.width, sample.height, 0.24, 0.24, 0.76, 0.76),
    fingerprint,
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
      if (selected.some((chosen) => isNearDuplicatePhoto(candidate, chosen))) {
        continue;
      }
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
    if (bestScore === -Infinity) {
      break;
    }
    const [picked] = candidates.splice(bestIndex, 1);
    picked.finalScore = bestScore;
    selected.push(picked);
  }

  return selected;
}

async function requestModelSelection(endpoint, photos, template) {
  const targetCount = template.requiredCount;
  const candidates = [...photos]
    .sort((a, b) => b.baseScore - a.baseScore)
    .slice(0, MODEL_CANDIDATE_LIMIT);
  const payload = {
    templateId: state.templateId,
    targetCount,
    slots: buildModelSelectionSlots(template),
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

function buildModelSelectionSlots(template) {
  if (template.layers) {
    return template.layers
      .filter((layer) => layer.type === "image" || layer.type === "image_cutout")
      .map((layer) => ({
        slotId: layer.id,
        slotIndex: layer.index,
        layerType: layer.type,
        name: layer.name || layer.id,
        intent: layer.requirements?.intent || "",
        cutoutRequired: layer.type === "image_cutout",
        requirements: layer.requirements || {},
      }))
      .sort((left, right) => left.slotIndex - right.slotIndex);
  }

  return template.photoSlots.map((slot, index) => ({
    slotId: `photo_${String(index + 1).padStart(2, "0")}`,
    slotIndex: index,
    layerType: "image",
    name: `image_${String(index + 1).padStart(2, "0")}`,
    intent: "Complete rectangular photo slot.",
    cutoutRequired: false,
    requirements: slot.requirements || {},
  }));
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
    exactHash: photo.exactHash,
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

function applyModelSelection(modelResult, template) {
  const targetCount = template.requiredCount;
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

  const selected = new Array(targetCount);
  const selectedIds = new Set();
  const slots = buildModelSelectionSlots(template);
  const slotIndexById = new Map(slots.map((slot) => [slot.slotId, slot.slotIndex]));
  const assignPhoto = (item, preferredIndex) => {
    const photo = byId.get(item.photoId || item.id);
    if (!photo || selectedIds.has(photo.id)) {
      return false;
    }
    if (selected.some((chosen) => chosen && isNearDuplicatePhoto(photo, chosen))) {
      return false;
    }

    let slotIndex = Number.isInteger(preferredIndex) ? preferredIndex : Number(item.slotIndex);
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= targetCount || selected[slotIndex]) {
      slotIndex = selected.findIndex((entry) => !entry);
    }
    if (slotIndex < 0) {
      return false;
    }

    photo.modelResult = item;
    photo.finalScore = clamp(Number(item.score || item.matchScore || 0) / 100, 0, 1);
    photo.selectionReason = item.reason || item.caption || photo.selectionReason || "";
    selected[slotIndex] = photo;
    selectedIds.add(photo.id);
    return true;
  };

  for (const assignment of modelResult.slotAssignments || []) {
    assignPhoto(assignment, slotIndexById.get(assignment.slotId));
  }

  for (const item of modelResult.selected) {
    assignPhoto(item, Number(item.slotIndex));
  }

  if (selected.some((photo) => !photo)) {
    const localFill = selectBestPhotos(
      state.photos.filter((photo) => !selectedIds.has(photo.id)),
      targetCount - selected.filter(Boolean).length,
    );
    let fillIndex = 0;
    for (let index = 0; index < targetCount; index++) {
      if (selected[index]) continue;
      const photo = localFill[fillIndex];
      if (!photo) break;
      selected[index] = photo;
      selectedIds.add(photo.id);
      fillIndex += 1;
    }
  }

  return selected.filter(Boolean).slice(0, targetCount);
}

function colorSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length < 3 || b.length < 3) {
    return 0;
  }
  const distance = Math.sqrt(
    (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2,
  );
  return clamp(1 - distance / 210, 0, 1);
}

function prefilterFileReasons(file) {
  return prefilterNameReasons(file.webkitRelativePath || file.name)
    .concat(isUnsupportedDynamicMedia(file) ? ["dynamic_media"] : [])
    .filter((reason, index, reasons) => reasons.indexOf(reason) === index);
}

function prefilterNameReasons(name) {
  const normalized = name || "";
  const reasons = [];
  if (DYNAMIC_MEDIA_EXTENSION_PATTERN.test(normalized)) {
    reasons.push("dynamic_media");
  }
  if (SCREEN_CAPTURE_NAME_PATTERN.test(normalized)) {
    reasons.push("screen_or_video_capture");
  }
  if (PRIVACY_NAME_PATTERN.test(normalized)) {
    reasons.push("privacy_sensitive");
  }
  return reasons;
}

function prefilterPhotoReasons(photo) {
  const reasons = prefilterFileReasons(photo.file);
  if (isLikelyBlankPhoto(photo)) {
    reasons.push("blank_scene");
  }
  if (isLikelyScreenCapturePhoto(photo)) {
    reasons.push("screen_or_video_capture");
  }
  return reasons.filter((reason, index, values) => values.indexOf(reason) === index);
}

function isLikelyBlankPhoto(photo) {
  return photo.metrics.contrast < 0.035 && photo.metrics.saturation < 0.06;
}

function isLikelyScreenCapturePhoto(photo) {
  const name = photo.file.name || "";
  const longAspect = Math.max(photo.width / Math.max(photo.height, 1), photo.height / Math.max(photo.width, 1));
  return /\.png$/i.test(name) &&
    longAspect >= 1.75 &&
    longAspect <= 2.45 &&
    photo.metrics.sharpness >= 0.46 &&
    photo.metrics.contrast >= 0.18 &&
    photo.metrics.saturation <= 0.42;
}

function dedupePhotoPool(photos) {
  const accepted = [];
  const removed = [];
  const byQuality = [...photos].sort((left, right) => photoQualityScore(right) - photoQualityScore(left));

  for (const photo of byQuality) {
    if (accepted.some((chosen) => isNearDuplicatePhoto(photo, chosen))) {
      removed.push(photo);
    } else {
      accepted.push(photo);
    }
  }

  return {
    photos: accepted.sort((left, right) => (left.importIndex ?? 0) - (right.importIndex ?? 0)),
    removed,
  };
}

function photoQualityScore(photo) {
  const megapixelScore = clamp((photo.width * photo.height) / (3000 * 3000), 0, 1) * 0.12;
  return photo.baseScore + megapixelScore;
}

function isNearDuplicatePhoto(left, right) {
  if (!left || !right || left.id === right.id) {
    return false;
  }
  if (left.exactHash && right.exactHash && left.exactHash === right.exactHash) {
    return true;
  }

  const hashDistance = hammingDistance(left.metrics?.fingerprint, right.metrics?.fingerprint);
  if (hashDistance <= DUPLICATE_HASH_DISTANCE) {
    return true;
  }
  if (hashDistance > NEAR_DUPLICATE_HASH_DISTANCE) {
    return false;
  }

  const leftAspect = left.width / Math.max(left.height, 1);
  const rightAspect = right.width / Math.max(right.height, 1);
  const aspectDelta = Math.abs(leftAspect - rightAspect);
  const centerSimilarity = colorSimilarity(
    left.metrics?.centerSignature || left.metrics?.signature,
    right.metrics?.centerSignature || right.metrics?.signature,
  );
  const fullSimilarity = colorSimilarity(left.metrics?.signature, right.metrics?.signature);

  return aspectDelta <= 0.08 &&
    centerSimilarity >= NEAR_DUPLICATE_COLOR_SIMILARITY &&
    fullSimilarity >= 0.84;
}

function hammingDistance(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) {
    return Infinity;
  }
  let distance = 0;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      distance += 1;
    }
  }
  return distance;
}

function averageHashFromLumas(lumas, width, height) {
  const size = 8;
  const values = [];
  for (let gridY = 0; gridY < size; gridY++) {
    for (let gridX = 0; gridX < size; gridX++) {
      const xStart = Math.floor((gridX * width) / size);
      const xEnd = Math.floor(((gridX + 1) * width) / size);
      const yStart = Math.floor((gridY * height) / size);
      const yEnd = Math.floor(((gridY + 1) * height) / size);
      let sum = 0;
      let count = 0;
      for (let y = yStart; y < yEnd; y++) {
        for (let x = xStart; x < xEnd; x++) {
          sum += lumas[y * width + x];
          count += 1;
        }
      }
      values.push(count ? sum / count : 0);
    }
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.map((value) => value >= mean ? "1" : "0").join("");
}

function averageRgbRegion(data, width, height, left, top, right, bottom) {
  const xStart = Math.floor(width * left);
  const xEnd = Math.max(xStart + 1, Math.floor(width * right));
  const yStart = Math.floor(height * top);
  const yEnd = Math.max(yStart + 1, Math.floor(height * bottom));
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let count = 0;
  for (let y = yStart; y < yEnd; y++) {
    for (let x = xStart; x < xEnd; x++) {
      const index = (y * width + x) * 4;
      rSum += data[index];
      gSum += data[index + 1];
      bSum += data[index + 2];
      count += 1;
    }
  }
  return count ? [rSum / count, gSum / count, bSum / count] : [0, 0, 0];
}

async function hashFile(file) {
  if (!globalThis.crypto?.subtle) {
    return "";
  }
  try {
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return "";
  }
}

function formatImportStatus({ limited, prefilterRejectCount, duplicateCount, skippedCount }) {
  const parts = [];
  if (prefilterRejectCount) {
    parts.push(`已过滤 ${prefilterRejectCount} 张`);
  }
  if (duplicateCount) {
    parts.push(`已去重 ${duplicateCount} 张`);
  }
  if (limited) {
    parts.push(`已取前 ${MAX_IMPORT_IMAGES} 张`);
  }
  if (skippedCount) {
    parts.push("部分文件已跳过");
  }
  return parts.length ? parts.join("，") : "上传完成";
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
    const cutoutImage = photo.cutoutImage || photo.image;
    if (photo.cutoutImage || photo.hasTransparency) {
      drawCutoutImageToContext(
        ctx,
        cutoutImage,
        { x: -frame.w / 2, y: -frame.h / 2, w: frame.w, h: frame.h },
        layer,
      );
    } else {
      drawImageCoverToContext(
        ctx,
        cutoutImage,
        { x: -frame.w / 2, y: -frame.h / 2, w: frame.w, h: frame.h },
        layer,
      );
    }
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

function drawCutoutImageToContext(targetCtx, image, frame, layer = {}) {
  const alphaBounds = getImageAlphaBounds(image);
  if (!alphaBounds.hasAlphaBounds) {
    drawImageCoverToContext(targetCtx, image, frame, layer);
    return;
  }

  const display = layer.requirements?.cutoutDisplay || layer.cutoutDisplay || {};
  const source = expandAlphaBounds(
    alphaBounds,
    image,
    optionNumber(display.transparentTrimPadding, 0.018),
  );
  const containScale = Math.min(frame.w / source.w, frame.h / source.h);
  const coverScale = Math.max(frame.w / source.w, frame.h / source.h);
  const minFrameCoverage = optionNumber(display.minFrameCoverage, 0.76);
  const maxAutoScale = optionNumber(display.maxAutoScale, 1.32);
  const maxCoverScale = optionNumber(display.maxCoverScale, 1.06);
  const coverageScale = Math.sqrt((minFrameCoverage * frame.w * frame.h) / (source.w * source.h));
  const scale = Math.min(
    Math.max(containScale, coverageScale),
    containScale * maxAutoScale,
    coverScale * maxCoverScale,
  );
  const drawWidth = source.w * scale;
  const drawHeight = source.h * scale;
  const alignX = alignmentFactor(display.alignX || layer.cutoutAlignX || layer.alignX);
  const alignY = alignmentFactor(display.alignY || layer.cutoutAlignY || layer.alignY);
  const dx = frame.x + (frame.w - drawWidth) * alignX;
  const dy = frame.y + (frame.h - drawHeight) * alignY;

  targetCtx.drawImage(image, source.x, source.y, source.w, source.h, dx, dy, drawWidth, drawHeight);
}

function getImageAlphaBounds(image) {
  if (cutoutBoundsCache.has(image)) {
    return cutoutBoundsCache.get(image);
  }

  const fallback = {
    x: 0,
    y: 0,
    w: image.naturalWidth || 1,
    h: image.naturalHeight || 1,
    hasAlphaBounds: false,
    alphaCoverage: 1,
    bboxCoverage: 1,
  };

  if (!image.naturalWidth || !image.naturalHeight) {
    cutoutBoundsCache.set(image, fallback);
    return fallback;
  }

  const maxScanSide = 900;
  const scanScale = Math.min(1, maxScanSide / Math.max(image.naturalWidth, image.naturalHeight));
  const scanWidth = Math.max(1, Math.round(image.naturalWidth * scanScale));
  const scanHeight = Math.max(1, Math.round(image.naturalHeight * scanScale));
  const scanCanvas = document.createElement("canvas");
  scanCanvas.width = scanWidth;
  scanCanvas.height = scanHeight;
  const scanCtx = scanCanvas.getContext("2d", { willReadFrequently: true });

  try {
    scanCtx.drawImage(image, 0, 0, scanWidth, scanHeight);
    const { data } = scanCtx.getImageData(0, 0, scanWidth, scanHeight);
    let minX = scanWidth;
    let minY = scanHeight;
    let maxX = -1;
    let maxY = -1;
    let opaqueCount = 0;
    const alphaThreshold = 12;

    for (let y = 0; y < scanHeight; y++) {
      for (let x = 0; x < scanWidth; x++) {
        const alpha = data[(y * scanWidth + x) * 4 + 3];
        if (alpha <= alphaThreshold) continue;
        opaqueCount += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    if (!opaqueCount) {
      cutoutBoundsCache.set(image, fallback);
      return fallback;
    }

    const sampleBoundsWidth = Math.max(1, maxX - minX + 1);
    const sampleBoundsHeight = Math.max(1, maxY - minY + 1);
    const edgeMargin = Math.max(2, Math.round(Math.max(scanWidth, scanHeight) * 0.004));
    const hasAlphaBounds = (
      minX > edgeMargin ||
      minY > edgeMargin ||
      maxX < scanWidth - edgeMargin - 1 ||
      maxY < scanHeight - edgeMargin - 1
    );
    const result = {
      x: minX / scanScale,
      y: minY / scanScale,
      w: sampleBoundsWidth / scanScale,
      h: sampleBoundsHeight / scanScale,
      hasAlphaBounds,
      alphaCoverage: opaqueCount / (scanWidth * scanHeight),
      bboxCoverage: (sampleBoundsWidth * sampleBoundsHeight) / (scanWidth * scanHeight),
    };
    cutoutBoundsCache.set(image, result);
    return result;
  } catch (error) {
    console.warn("Unable to measure cutout alpha bounds", error);
    cutoutBoundsCache.set(image, fallback);
    return fallback;
  }
}

function expandAlphaBounds(bounds, image, paddingRatio) {
  const padding = Math.max(bounds.w, bounds.h) * Math.max(0, paddingRatio);
  const x = Math.max(0, bounds.x - padding);
  const y = Math.max(0, bounds.y - padding);
  const right = Math.min(image.naturalWidth, bounds.x + bounds.w + padding);
  const bottom = Math.min(image.naturalHeight, bounds.y + bounds.h + padding);
  return {
    x,
    y,
    w: Math.max(1, right - x),
    h: Math.max(1, bottom - y),
  };
}

function optionNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
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
