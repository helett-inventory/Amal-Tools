/* ==========================================================
   Amazon FBA PDF Crop Tool - script.js
   100% offline. Uses pdf.js to validate/read the source PDF
   and pdf-lib to crop pages at vector quality (no rasterizing).
   ========================================================== */

"use strict";

/* pdf.js needs to know where its worker script lives. */
if (typeof pdfjsLib !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "libs/pdf.worker.min.js";
}

/* ----------------------------------------------------------
   Default crop templates.
   These are FRACTIONS of each page's own width/height
   (0 = left/bottom edge, 1 = right/top edge), so they scale
   automatically to any page size.

   Derived by analysing real sample PDFs:
     - ATS: FBA15M1MCX7C-1785134131241.pdf vs its cropped version
     - Drop-in: FBA15M2PZV9Y-1785137309168.pdf vs its cropped version
   The drop-in Top-Left rectangle was measured directly from the
   sample crop; Top-Right / Bottom-Left / Bottom-Right were derived
   from the exact label grid pitch found in the page's own content
   stream (286.5pt horizontal / 380pt vertical spacing between the
   4 labels), so the split lines fall in the same place regardless
   of scale.
   ---------------------------------------------------------- */
const DEFAULT_SETTINGS = {
  ats: {
    left: 0.000000,
    right: 1.000000,
    bottom: 0.055346,
    top: 0.497684
  },
  dropin: {
    tl: { left: 0.000000, right: 0.519435, bottom: 0.700111, top: 0.962514 },
    tr: { left: 0.481294, right: 1.000000, bottom: 0.700111, top: 0.962514 },
    bl: { left: 0.000000, right: 0.519435, bottom: 0.248632, top: 0.511036 },
    br: { left: 0.481294, right: 1.000000, bottom: 0.248632, top: 0.511036 }
  }
};

const STORAGE_KEY = "fbaCropSettings.v1";

/* ---------------------------------------------------------- */
/* State                                                       */
/* ---------------------------------------------------------- */
let selectedFile = null;
let isProcessing = false;
let currentSettings = loadSettings();
let generatedBlobUrl = null;

/* ---------------------------------------------------------- */
/* DOM references                                              */
/* ---------------------------------------------------------- */
const fileInput = document.getElementById("fileInput");
const fileNameDisplay = document.getElementById("fileNameDisplay");
const clearFileBtn = document.getElementById("clearFileBtn");
const generateBtn = document.getElementById("generateBtn");
const progressSection = document.getElementById("progressSection");
const progressBarFill = document.getElementById("progressBarFill");
const statusText = document.getElementById("statusText");
const progressPercent = document.getElementById("progressPercent");
const errorBox = document.getElementById("errorBox");
const downloadSection = document.getElementById("downloadSection");
const downloadBtn = document.getElementById("downloadBtn");

const settingsToggleBtn = document.getElementById("settingsToggleBtn");
const settingsCloseBtn = document.getElementById("settingsCloseBtn");
const settingsOverlay = document.getElementById("settingsOverlay");
const settingsSaveBtn = document.getElementById("settingsSaveBtn");
const settingsResetBtn = document.getElementById("settingsResetBtn");

/* ---------------------------------------------------------- */
/* Settings persistence                                        */
/* ---------------------------------------------------------- */

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneSettings(DEFAULT_SETTINGS);
    const parsed = JSON.parse(raw);
    if (!isValidSettingsShape(parsed)) return cloneSettings(DEFAULT_SETTINGS);
    return parsed;
  } catch (e) {
    return cloneSettings(DEFAULT_SETTINGS);
  }
}

function isValidSettingsShape(obj) {
  if (!obj || !obj.ats || !obj.dropin) return false;
  const rectKeys = ["left", "right", "bottom", "top"];
  const hasRect = (r) => r && rectKeys.every((k) => typeof r[k] === "number");
  if (!hasRect(obj.ats)) return false;
  return ["tl", "tr", "bl", "br"].every((q) => hasRect(obj.dropin[q]));
}

function cloneSettings(s) {
  return JSON.parse(JSON.stringify(s));
}

function saveSettingsToStorage(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/* ---------------------------------------------------------- */
/* Settings panel <-> form binding                             */
/* ---------------------------------------------------------- */

function populateSettingsForm(settings) {
  document.getElementById("ats-left").value = settings.ats.left;
  document.getElementById("ats-right").value = settings.ats.right;
  document.getElementById("ats-bottom").value = settings.ats.bottom;
  document.getElementById("ats-top").value = settings.ats.top;

  ["tl", "tr", "bl", "br"].forEach((q) => {
    document.getElementById(`dropin-${q}-left`).value = settings.dropin[q].left;
    document.getElementById(`dropin-${q}-right`).value = settings.dropin[q].right;
    document.getElementById(`dropin-${q}-bottom`).value = settings.dropin[q].bottom;
    document.getElementById(`dropin-${q}-top`).value = settings.dropin[q].top;
  });
}

function readSettingsForm() {
  const num = (id) => {
    const v = parseFloat(document.getElementById(id).value);
    return isNaN(v) ? 0 : Math.min(1, Math.max(0, v));
  };

  const settings = {
    ats: {
      left: num("ats-left"),
      right: num("ats-right"),
      bottom: num("ats-bottom"),
      top: num("ats-top")
    },
    dropin: {}
  };

  ["tl", "tr", "bl", "br"].forEach((q) => {
    settings.dropin[q] = {
      left: num(`dropin-${q}-left`),
      right: num(`dropin-${q}-right`),
      bottom: num(`dropin-${q}-bottom`),
      top: num(`dropin-${q}-top`)
    };
  });

  return settings;
}

/* ---------------------------------------------------------- */
/* UI helpers                                                  */
/* ---------------------------------------------------------- */

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function clearError() {
  errorBox.hidden = true;
  errorBox.textContent = "";
}

function resetOutputUI() {
  downloadSection.hidden = true;
  if (generatedBlobUrl) {
    URL.revokeObjectURL(generatedBlobUrl);
    generatedBlobUrl = null;
  }
  downloadBtn.removeAttribute("href");
}

function setProgress(percent, status) {
  progressSection.hidden = false;
  progressBarFill.style.width = `${percent}%`;
  progressPercent.textContent = `${Math.round(percent)}%`;
  if (status !== undefined) statusText.textContent = status;
}

function setProcessingState(processing) {
  isProcessing = processing;
  generateBtn.disabled = processing || !selectedFile;
  fileInput.disabled = processing;
  clearFileBtn.disabled = processing;
  document.querySelectorAll('input[name="mode"]').forEach((el) => {
    el.disabled = processing;
  });
  settingsToggleBtn.disabled = processing;
}

/* Yield to the browser so the progress bar / UI stay responsive
   during long loops over hundreds of pages. */
function yieldToUI() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/* ---------------------------------------------------------- */
/* File selection                                              */
/* ---------------------------------------------------------- */

fileInput.addEventListener("change", () => {
  clearError();
  resetOutputUI();
  progressSection.hidden = true;

  const file = fileInput.files && fileInput.files[0];

  if (!file) {
    selectedFile = null;
    fileNameDisplay.textContent = "No file selected";
    generateBtn.disabled = true;
    clearFileBtn.hidden = true;
    return;
  }

  const looksLikePdf =
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

  if (!looksLikePdf) {
    selectedFile = null;
    fileNameDisplay.textContent = "No file selected";
    generateBtn.disabled = true;
    clearFileBtn.hidden = true;
    showError("Unsupported file type. Please select a .pdf file.");
    return;
  }

  selectedFile = file;
  fileNameDisplay.textContent = `${file.name} (${formatBytes(file.size)})`;
  generateBtn.disabled = false;
  clearFileBtn.hidden = false;
});

clearFileBtn.addEventListener("click", () => {
  if (isProcessing) return; // don't allow clearing mid-run

  selectedFile = null;
  fileInput.value = "";
  fileNameDisplay.textContent = "No file selected";
  generateBtn.disabled = true;
  clearFileBtn.hidden = true;

  clearError();
  resetOutputUI();
  progressSection.hidden = true;
});

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ---------------------------------------------------------- */
/* Settings panel open/close/save/reset                        */
/* ---------------------------------------------------------- */

settingsToggleBtn.addEventListener("click", () => {
  populateSettingsForm(currentSettings);
  settingsOverlay.hidden = false;
});

settingsCloseBtn.addEventListener("click", () => {
  settingsOverlay.hidden = true;
});

settingsOverlay.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) settingsOverlay.hidden = true;
});

settingsSaveBtn.addEventListener("click", () => {
  const settings = readSettingsForm();
  currentSettings = settings;
  saveSettingsToStorage(settings);
  settingsOverlay.hidden = true;
});

settingsResetBtn.addEventListener("click", () => {
  currentSettings = cloneSettings(DEFAULT_SETTINGS);
  saveSettingsToStorage(currentSettings);
  populateSettingsForm(currentSettings);
});

/* ---------------------------------------------------------- */
/* Crop math                                                    */
/* ---------------------------------------------------------- */

/* Convert a fractional rect {left,right,bottom,top} (0..1) into
   absolute PDF points for a page of the given width/height.
   Returns {x, y, width, height} suitable for setMediaBox/setCropBox. */
function fractionalRectToAbsolute(frac, pageWidth, pageHeight) {
  const left = Math.max(0, Math.min(pageWidth, frac.left * pageWidth));
  const right = Math.max(0, Math.min(pageWidth, frac.right * pageWidth));
  const bottom = Math.max(0, Math.min(pageHeight, frac.bottom * pageHeight));
  const top = Math.max(0, Math.min(pageHeight, frac.top * pageHeight));

  const x = Math.min(left, right);
  const y = Math.min(bottom, top);
  const width = Math.max(1, Math.abs(right - left));
  const height = Math.max(1, Math.abs(top - bottom));

  return { x, y, width, height };
}

function applyCropToPage(page, frac) {
  const pageWidth = page.getWidth();
  const pageHeight = page.getHeight();
  const rect = fractionalRectToAbsolute(frac, pageWidth, pageHeight);

  page.setMediaBox(rect.x, rect.y, rect.width, rect.height);
  page.setCropBox(rect.x, rect.y, rect.width, rect.height);
}

/* ---------------------------------------------------------- */
/* Main processing pipeline                                    */
/* ---------------------------------------------------------- */

generateBtn.addEventListener("click", async () => {
  if (isProcessing) return; // prevent double-click / re-entry

  clearError();
  resetOutputUI();

  if (!selectedFile) {
    showError("No file selected. Please choose a PDF first.");
    return;
  }

  const mode = document.querySelector('input[name="mode"]:checked').value;

  setProcessingState(true);
  setProgress(2, "Uploading...");

  try {
    const arrayBuffer = await readFileAsArrayBuffer(selectedFile);

    setProgress(8, "Reading PDF...");
    await yieldToUI();

    // Validate the PDF using pdf.js first, so we can surface a
    // clear "corrupted / invalid PDF" error before touching pdf-lib.
    const pageCount = await validateAndCountPages(arrayBuffer);

    setProgress(15, "Cropping...");
    await yieldToUI();

    const outputBytes = await cropPdf(arrayBuffer, mode, pageCount, (percent, label) => {
      setProgress(percent, label);
    });

    setProgress(96, "Generating PDF...");
    await yieldToUI();

    const blob = new Blob([outputBytes], { type: "application/pdf" });
    generatedBlobUrl = URL.createObjectURL(blob);

    const outputName = buildOutputFilename(selectedFile.name);
    downloadBtn.href = generatedBlobUrl;
    downloadBtn.setAttribute("download", outputName);
    downloadSection.hidden = false;

    setProgress(100, "Completed");
  } catch (err) {
    console.error(err);
    showError(describeError(err));
    progressSection.hidden = true;
  } finally {
    setProcessingState(false);
  }
});

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("FILE_READ_ERROR"));
    reader.readAsArrayBuffer(file);
  });
}

async function validateAndCountPages(arrayBuffer) {
  try {
    // pdf.js needs its own copy of the buffer (it may transfer/detach it).
    const copy = arrayBuffer.slice(0);
    const loadingTask = pdfjsLib.getDocument({ data: copy });
    const doc = await loadingTask.promise;
    const numPages = doc.numPages;
    await doc.destroy();
    if (!numPages || numPages < 1) {
      throw new Error("EMPTY_PDF");
    }
    return numPages;
  } catch (err) {
    if (err && err.message === "EMPTY_PDF") throw err;
    throw new Error("INVALID_PDF");
  }
}

/* Crops the PDF according to mode and returns the output bytes (Uint8Array). */
async function cropPdf(arrayBuffer, mode, pageCount, onProgress) {
  const { PDFDocument } = PDFLib;

  const srcDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true }).catch(() => {
    throw new Error("INVALID_PDF");
  });

  const outDoc = await PDFDocument.create();

  const totalUnits = mode === "dropin" ? pageCount * 4 : pageCount;
  let processedUnits = 0;

  const progressFloor = 15;
  const progressCeil = 90;

  const bumpProgress = () => {
    processedUnits += 1;
    const ratio = processedUnits / totalUnits;
    const percent = progressFloor + ratio * (progressCeil - progressFloor);
    onProgress(percent, "Cropping...");
  };

  if (mode === "ats") {
    for (let i = 0; i < pageCount; i++) {
      const [page] = await outDoc.copyPages(srcDoc, [i]);
      applyCropToPage(page, currentSettings.ats);
      outDoc.addPage(page);
      bumpProgress();
      if (i % 15 === 0) await yieldToUI();
    }
  } else if (mode === "dropin") {
    const quadrants = ["tl", "tr", "bl", "br"];
    for (let i = 0; i < pageCount; i++) {
      // Copy the same source page 4 times so each quadrant gets an
      // independent page object (independent MediaBox/CropBox) while
      // sharing the underlying vector content -> no rasterizing,
      // no quality loss, labels are never resized or stretched.
      const copies = await outDoc.copyPages(srcDoc, [i, i, i, i]);
      for (let q = 0; q < 4; q++) {
        const page = copies[q];
        applyCropToPage(page, currentSettings.dropin[quadrants[q]]);
        outDoc.addPage(page);
        bumpProgress();
      }
      if (i % 8 === 0) await yieldToUI();
    }
  } else {
    throw new Error("UNKNOWN_MODE");
  }

  return await outDoc.save();
}

function buildOutputFilename(originalName) {
  const dotIndex = originalName.lastIndexOf(".");
  const base = dotIndex > 0 ? originalName.slice(0, dotIndex) : originalName;
  return `${base}_Cropped.pdf`;
}

function describeError(err) {
  const message = err && err.message ? err.message : "";

  switch (message) {
    case "FILE_READ_ERROR":
      return "Could not read the selected file. It may be locked or corrupted.";
    case "INVALID_PDF":
      return "This file could not be opened as a PDF. It may be corrupted or invalid.";
    case "EMPTY_PDF":
      return "This PDF has no pages.";
    case "UNKNOWN_MODE":
      return "Unknown shipment mode selected.";
    default:
      return "Something went wrong while processing the PDF. Please try again.";
  }
}

/* ---------------------------------------------------------- */
/* Startup                                                      */
/* ---------------------------------------------------------- */

(function init() {
  if (!isValidSettingsShape(currentSettings)) {
    currentSettings = cloneSettings(DEFAULT_SETTINGS);
    saveSettingsToStorage(currentSettings);
  }
  populateSettingsForm(currentSettings);
})();
