/**
 * PHF Converter — Main Application Logic
 * Pure High-Fidelity Lossless Format Browser Converter
 */

// Global state
let phfMod = null;
let currentSourceFile = null;
let currentConversion = null;
let batchFiles = [];
let batchResults = [];

// DOM Elements
const engineStatusBadge = document.getElementById('engineStatusBadge');
const engineStatusText = document.getElementById('engineStatusText');
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const btnBrowse = document.getElementById('btnBrowse');

const optMode = document.getElementById('optMode');
const optEffort = document.getElementById('optEffort');
const optChannels = document.getElementById('optChannels');
const optExportFormat = document.getElementById('optExportFormat');

const progressBarContainer = document.getElementById('progressBarContainer');
const progressBarFill = document.getElementById('progressBarFill');
const progressText = document.getElementById('progressText');

const comparisonSection = document.getElementById('comparisonSection');
const directionTag = document.getElementById('directionTag');
const valRatio = document.getElementById('valRatio');
const valSavings = document.getElementById('valSavings');
const valSpeed = document.getElementById('valSpeed');
const chipRatio = document.getElementById('chipRatio');
const chipSavings = document.getElementById('chipSavings');

const btnViewSide = document.getElementById('btnViewSide');
const btnViewSplit = document.getElementById('btnViewSplit');
const btnResetView = document.getElementById('btnResetView');
const sideBySideContainer = document.getElementById('sideBySideContainer');
const splitSliderContainer = document.getElementById('splitSliderContainer');
const splitViewport = document.getElementById('splitViewport');
const splitCanvasWrapper = document.getElementById('splitCanvasWrapper');
const sliderDivider = document.getElementById('sliderDivider');

const origCanvas = document.getElementById('origCanvas');
const origFilename = document.getElementById('origFilename');
const origFormat = document.getElementById('origFormat');
const origDimensions = document.getElementById('origDimensions');
const origSize = document.getElementById('origSize');
const origBytes = document.getElementById('origBytes');

const resultCanvas = document.getElementById('resultCanvas');
const resultFilename = document.getElementById('resultFilename');
const resultFormat = document.getElementById('resultFormat');
const resultDimensions = document.getElementById('resultDimensions');
const resultSize = document.getElementById('resultSize');
const resultBytes = document.getElementById('resultBytes');

const splitOrigCanvas = document.getElementById('splitOrigCanvas');
const splitResultCanvas = document.getElementById('splitResultCanvas');

const btnDownload = document.getElementById('btnDownload');
const btnDownloadText = document.getElementById('btnDownloadText');
const btnReconvert = document.getElementById('btnReconvert');

const batchSection = document.getElementById('batchSection');
const batchCount = document.getElementById('batchCount');
const batchSummaryText = document.getElementById('batchSummaryText');
const batchTableBody = document.getElementById('batchTableBody');
const btnDownloadAll = document.getElementById('btnDownloadAll');

const samplePhfBtn = document.getElementById('samplePhfBtn');
const sampleMarioBtn = document.getElementById('sampleMarioBtn');
const samplePixelBtn = document.getElementById('samplePixelBtn');

// Helper: Format bytes to human readable
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatNumber(num) {
  return new Intl.NumberFormat().format(num);
}

// ----------------------------------------------------
// WASM Initialization
// ----------------------------------------------------
async function initPHF() {
  try {
    if (typeof window.PHFModule !== 'function') {
      throw new Error('PHFModule script not found');
    }
    phfMod = await window.PHFModule({
      locateFile: (p) => p
    });
    engineStatusBadge.classList.add('ready');
    engineStatusText.textContent = 'WASM v1.1 SIMD Ready';
  } catch (err) {
    console.error('[PHF WASM Init Error]', err);
    engineStatusText.textContent = 'Failed to load WASM';
    engineStatusBadge.style.borderColor = 'var(--danger)';
  }
}

// ----------------------------------------------------
// PHF Decoder (ArrayBuffer -> ImageData)
// ----------------------------------------------------
function decodePHFBuffer(arrayBuffer) {
  if (!phfMod) throw new Error('WASM engine not ready');
  const u8 = new Uint8Array(arrayBuffer);
  const n = u8.byteLength;
  if (n < 20) throw new Error('Invalid file: too small for PHF header (< 20 bytes)');

  // Verify Magic 'PHF1' (0x50, 0x48, 0x46, 0x31)
  if (u8[0] !== 0x50 || u8[1] !== 0x48 || u8[2] !== 0x46 || u8[3] !== 0x31) {
    throw new Error('Not a valid PHF file (missing PHF1 magic header)');
  }

  const dv = new DataView(arrayBuffer);
  const version = dv.getUint8(4);
  const channels = dv.getUint8(5);
  const flags = dv.getUint8(6);
  const width = dv.getUint32(8, true);
  const height = dv.getUint32(12, true);
  const payloadSize = dv.getUint32(16, true);

  if (version !== 1) throw new Error(`Unsupported PHF version: ${version}`);
  if (channels !== 3 && channels !== 4) throw new Error(`Unsupported channels: ${channels}`);
  if (width === 0 || height === 0 || width > 65535 || height > 65535) {
    throw new Error(`Invalid dimensions: ${width}x${height}`);
  }

  const outBytes = width * height * 4; // Always decode to 4-channel RGBA for Canvas
  const srcPtr = phfMod._malloc(n);
  const dstPtr = srcPtr ? phfMod._malloc(outBytes) : 0;
  if (!srcPtr || !dstPtr) {
    if (srcPtr) phfMod._free(srcPtr);
    throw new Error('Out of memory allocating WASM decode buffers');
  }

  phfMod.HEAPU8.set(u8, srcPtr);
  const t0 = performance.now();
  // Decode into RGBA with stride = 4
  const rc = phfMod._phf_decode_memory(srcPtr, n, dstPtr, width, height, 4);
  const decodeTimeMs = performance.now() - t0;

  if (rc !== 0) {
    phfMod._free(srcPtr);
    phfMod._free(dstPtr);
    throw new Error(`PHF decoding failed with error code: ${rc}`);
  }

  const decodedU8 = new Uint8Array(phfMod.HEAPU8.buffer, dstPtr, outBytes);
  const clamped = new Uint8ClampedArray(decodedU8);

  phfMod._free(srcPtr);
  phfMod._free(dstPtr);

  const imageData = new ImageData(clamped, width, height);
  return {
    imageData,
    width,
    height,
    channels,
    flags,
    payloadSize,
    decodeTimeMs,
    compressedSize: n
  };
}

// ----------------------------------------------------
// PHF Encoder (ImageData -> Uint8Array)
// ----------------------------------------------------
function encodeToPHF(imageData, modeOption = 0, effortOption = 0, channelPolicy = 'auto') {
  if (!phfMod) throw new Error('WASM engine not ready');
  const width = imageData.width;
  const height = imageData.height;
  const totalPixels = width * height;
  const rgba = imageData.data;

  // Determine channel count
  let useChannels = 4;
  if (channelPolicy === 'rgb') {
    useChannels = 3;
  } else if (channelPolicy === 'rgba') {
    useChannels = 4;
  } else {
    // Auto detection: check if image has any transparent or semi-transparent pixels
    let hasAlpha = false;
    for (let i = 3; i < rgba.length; i += 4) {
      if (rgba[i] < 255) {
        hasAlpha = true;
        break;
      }
    }
    useChannels = hasAlpha ? 4 : 3;
  }

  // Pack pixel buffer
  let packedPixels;
  if (useChannels === 3) {
    packedPixels = new Uint8Array(totalPixels * 3);
    let srcIdx = 0;
    let dstIdx = 0;
    for (let p = 0; p < totalPixels; p++) {
      packedPixels[dstIdx] = rgba[srcIdx];
      packedPixels[dstIdx + 1] = rgba[srcIdx + 1];
      packedPixels[dstIdx + 2] = rgba[srcIdx + 2];
      srcIdx += 4;
      dstIdx += 3;
    }
  } else {
    packedPixels = new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  }

  const pxByteLength = packedPixels.byteLength;
  const pxPtr = phfMod._malloc(pxByteLength);
  if (!pxPtr) throw new Error('Out of memory allocating pixel buffer in WASM');
  phfMod.HEAPU8.set(packedPixels, pxPtr);

  // Allocate out_size (4 bytes)
  const sizePtr = phfMod._malloc(4);
  phfMod.HEAPU32[sizePtr >> 2] = 0;

  // Allocate phf_encode_options_t { int mode; int effort; } (8 bytes)
  const optPtr = phfMod._malloc(8);
  phfMod.HEAPU32[optPtr >> 2] = parseInt(modeOption, 10);
  phfMod.HEAPU32[(optPtr >> 2) + 1] = parseInt(effortOption, 10);

  const t0 = performance.now();
  const outPtr = phfMod._phf_encode_memory(pxPtr, width, height, useChannels, optPtr, sizePtr);
  const encodeTimeMs = performance.now() - t0;
  const outSize = phfMod.HEAPU32[sizePtr >> 2];

  phfMod._free(optPtr);
  phfMod._free(sizePtr);
  phfMod._free(pxPtr);

  if (outPtr === 0 || outSize === 0) {
    throw new Error('PHF encoding failed: null output returned from encoder');
  }

  const phfBytes = new Uint8Array(phfMod.HEAPU8.buffer, outPtr, outSize).slice();
  phfMod._phf_free(outPtr);

  return {
    phfBytes,
    width,
    height,
    channels: useChannels,
    encodeTimeMs,
    fileSize: outSize
  };
}

// ----------------------------------------------------
// Image File Loader (Standard Format -> ImageData)
// ----------------------------------------------------
async function loadStandardImageToImageData(fileOrBlob) {
  let imgBitmap;
  try {
    imgBitmap = await createImageBitmap(fileOrBlob);
  } catch (e) {
    // Fallback via Image element
    imgBitmap = await new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(fileOrBlob);
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = (err) => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to decode image data'));
      };
      img.src = url;
    });
  }

  const width = imgBitmap.width;
  const height = imgBitmap.height;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(imgBitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, width, height);

  return { imageData, width, height };
}

// ----------------------------------------------------
// Canvas to Blob Exporter
// ----------------------------------------------------
function canvasToBlob(canvas, format = 'png', quality = 0.95) {
  let mime = 'image/png';
  if (format === 'webp') mime = 'image/webp';
  else if (format === 'jpeg' || format === 'jpg') mime = 'image/jpeg';

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Failed to convert canvas to blob'));
    }, mime, quality);
  });
}

// ----------------------------------------------------
// Single File Conversion Pipeline
// ----------------------------------------------------
async function processSingleFile(file) {
  currentSourceFile = file;
  comparisonSection.hidden = false;
  progressBarContainer.hidden = false;
  progressBarFill.style.width = '30%';
  progressText.textContent = `Reading ${file.name}...`;

  const isPhf = file.name.toLowerCase().endsWith('.phf');

  try {
    const arrayBuffer = await file.arrayBuffer();
    const originalByteCount = file.size;

    progressBarFill.style.width = '60%';

    if (isPhf) {
      // ------------------------------------
      // Direction: PHF -> Standard Image
      // ------------------------------------
      directionTag.textContent = 'PHF \u2192 Image';
      progressText.textContent = 'Decoding PHF lossless stream...';

      const decoded = decodePHFBuffer(arrayBuffer);
      
      // Render to Original Canvas
      origCanvas.width = decoded.width;
      origCanvas.height = decoded.height;
      const ctxOrig = origCanvas.getContext('2d');
      ctxOrig.putImageData(decoded.imageData, 0, 0);

      origFilename.textContent = file.name;
      origFormat.textContent = `PHF v1 (${decoded.channels === 4 ? 'RGBA' : 'RGB'}${decoded.flags & 0x08 ? ' + CRC' : ''})`;
      origDimensions.textContent = `${decoded.width} \u00D7 ${decoded.height} px`;
      origSize.textContent = formatBytes(originalByteCount);
      origBytes.textContent = `${formatNumber(originalByteCount)} bytes`;

      // Export to chosen format (PNG/WebP/JPEG)
      const exportFormat = optExportFormat.value;
      progressText.textContent = `Exporting to ${exportFormat.toUpperCase()}...`;

      resultCanvas.width = decoded.width;
      resultCanvas.height = decoded.height;
      const ctxResult = resultCanvas.getContext('2d');
      ctxResult.putImageData(decoded.imageData, 0, 0);

      const targetBlob = await canvasToBlob(resultCanvas, exportFormat);
      const targetBytes = targetBlob.size;

      const baseName = file.name.replace(/\.[^/.]+$/, '');
      const outExt = exportFormat === 'jpeg' ? 'jpg' : exportFormat;
      const outFilename = `${baseName}.${outExt}`;

      resultFilename.textContent = outFilename;
      resultFormat.textContent = `${exportFormat.toUpperCase()} (${exportFormat === 'png' ? 'Lossless' : 'Export'})`;
      resultDimensions.textContent = `${decoded.width} \u00D7 ${decoded.height} px`;
      resultSize.textContent = formatBytes(targetBytes);
      resultBytes.textContent = `${formatNumber(targetBytes)} bytes`;

      // Sync Split Canvases
      updateSplitCanvases(origCanvas, resultCanvas);

      // Setup Download Link
      const blobUrl = URL.createObjectURL(targetBlob);
      btnDownload.href = blobUrl;
      btnDownload.download = outFilename;
      btnDownloadText.textContent = `Download ${outFilename} (${formatBytes(targetBytes)})`;

      // Metrics
      const deltaBytes = targetBytes - originalByteCount;
      const ratio = (targetBytes / originalByteCount);
      const pct = ((deltaBytes / originalByteCount) * 100);
      
      valRatio.textContent = `${ratio.toFixed(2)}x`;
      valSavings.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
      valSpeed.textContent = `${decoded.decodeTimeMs.toFixed(1)} ms`;

      chipRatio.className = 'chip';
      chipSavings.className = 'chip ' + (pct <= 0 ? 'chip-positive' : 'chip-negative');

      currentConversion = {
        type: 'phf-to-img',
        sourceFile: file,
        outputBlob: targetBlob,
        outputName: outFilename
      };

    } else {
      // ------------------------------------
      // Direction: Standard Image -> PHF
      // ------------------------------------
      directionTag.textContent = `${file.name.split('.').pop().toUpperCase()} \u2192 PHF`;
      progressText.textContent = 'Decoding original image...';

      const { imageData, width, height } = await loadStandardImageToImageData(file);

      // Render Original
      origCanvas.width = width;
      origCanvas.height = height;
      const ctxOrig = origCanvas.getContext('2d');
      ctxOrig.putImageData(imageData, 0, 0);

      origFilename.textContent = file.name;
      origFormat.textContent = file.type || `${file.name.split('.').pop().toUpperCase()} Image`;
      origDimensions.textContent = `${width} \u00D7 ${height} px`;
      origSize.textContent = formatBytes(originalByteCount);
      origBytes.textContent = `${formatNumber(originalByteCount)} bytes`;

      // Encode to PHF
      progressText.textContent = 'Encoding to Pure High-Fidelity (PHF)...';
      const mode = optMode.value;
      const effort = optEffort.value;
      const channelPolicy = optChannels.value;

      const encoded = encodeToPHF(imageData, mode, effort, channelPolicy);

      // Decode the generated PHF to result canvas to prove 100% fidelity & round-trip!
      const decodedResult = decodePHFBuffer(encoded.phfBytes.buffer);
      resultCanvas.width = decodedResult.width;
      resultCanvas.height = decodedResult.height;
      const ctxResult = resultCanvas.getContext('2d');
      ctxResult.putImageData(decodedResult.imageData, 0, 0);

      const baseName = file.name.replace(/\.[^/.]+$/, '');
      const outFilename = `${baseName}.phf`;

      const modeNames = { '0': 'Auto', '1': 'MED', '2': 'Palette' };
      const effortNames = { '0': 'Best', '1': 'Fast' };

      resultFilename.textContent = outFilename;
      resultFormat.textContent = `PHF v1.1 [${modeNames[mode] || 'Auto'}, ${effortNames[effort] || 'Best'}, ${encoded.channels === 4 ? 'RGBA' : 'RGB'}]`;
      resultDimensions.textContent = `${encoded.width} \u00D7 ${encoded.height} px`;
      resultSize.textContent = formatBytes(encoded.fileSize);
      resultBytes.textContent = `${formatNumber(encoded.fileSize)} bytes`;

      // Sync Split Canvases
      updateSplitCanvases(origCanvas, resultCanvas);

      // Setup Download Link
      const phfBlob = new Blob([encoded.phfBytes], { type: 'application/octet-stream' });
      const blobUrl = URL.createObjectURL(phfBlob);
      btnDownload.href = blobUrl;
      btnDownload.download = outFilename;
      btnDownloadText.textContent = `Download ${outFilename} (${formatBytes(encoded.fileSize)})`;

      // Metrics
      const deltaBytes = encoded.fileSize - originalByteCount;
      const pct = ((deltaBytes / originalByteCount) * 100);
      const ratio = (originalByteCount / encoded.fileSize);

      valRatio.textContent = `${ratio.toFixed(2)}x`;
      valSavings.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
      valSpeed.textContent = `${encoded.encodeTimeMs.toFixed(1)} ms`;

      chipRatio.className = 'chip';
      chipSavings.className = 'chip ' + (pct <= 0 ? 'chip-positive' : 'chip-negative');

      currentConversion = {
        type: 'img-to-phf',
        sourceFile: file,
        outputBlob: phfBlob,
        outputName: outFilename
      };
    }

    progressBarFill.style.width = '100%';
    setTimeout(() => {
      progressBarContainer.hidden = true;
    }, 400);

  } catch (err) {
    console.error('[Conversion Error]', err);
    progressBarFill.style.background = 'var(--danger)';
    progressText.textContent = `Error: ${err.message}`;
    alert(`Conversion failed: ${err.message}`);
  }
}

// ----------------------------------------------------
// Split Comparison Slider Logic
// ----------------------------------------------------
function updateSplitCanvases(srcCanvas1, srcCanvas2) {
  splitOrigCanvas.width = srcCanvas1.width;
  splitOrigCanvas.height = srcCanvas1.height;
  const ctx1 = splitOrigCanvas.getContext('2d');
  ctx1.drawImage(srcCanvas1, 0, 0);

  splitResultCanvas.width = srcCanvas2.width;
  splitResultCanvas.height = srcCanvas2.height;
  const ctx2 = splitResultCanvas.getContext('2d');
  ctx2.drawImage(srcCanvas2, 0, 0);

  if (splitCanvasWrapper) {
    splitCanvasWrapper.style.setProperty('--split-pct', '50%');
  }
}

let isDraggingSlider = false;

function setSliderPosition(clientX) {
  if (!splitCanvasWrapper) return;
  const rect = splitCanvasWrapper.getBoundingClientRect();
  if (rect.width <= 0) return;
  let x = clientX - rect.left;
  let pct = (x / rect.width) * 100;
  pct = Math.max(0, Math.min(100, pct));
  splitCanvasWrapper.style.setProperty('--split-pct', `${pct}%`);
}

splitViewport.addEventListener('pointerdown', (e) => {
  isDraggingSlider = true;
  splitViewport.setPointerCapture(e.pointerId);
  setSliderPosition(e.clientX);
});

splitViewport.addEventListener('pointermove', (e) => {
  if (isDraggingSlider) {
    setSliderPosition(e.clientX);
  }
});

splitViewport.addEventListener('pointerup', (e) => {
  isDraggingSlider = false;
  splitViewport.releasePointerCapture(e.pointerId);
});

splitViewport.addEventListener('pointercancel', () => {
  isDraggingSlider = false;
});

// View mode toggling
btnViewSide.addEventListener('click', () => {
  btnViewSide.classList.add('active');
  btnViewSplit.classList.remove('active');
  sideBySideContainer.hidden = false;
  splitSliderContainer.hidden = true;
});

btnViewSplit.addEventListener('click', () => {
  btnViewSplit.classList.add('active');
  btnViewSide.classList.remove('active');
  sideBySideContainer.hidden = true;
  splitSliderContainer.hidden = false;
  if (splitCanvasWrapper) {
    splitCanvasWrapper.style.setProperty('--split-pct', '50%');
  }
});

btnResetView.addEventListener('click', () => {
  origCanvas.style.transform = 'none';
  resultCanvas.style.transform = 'none';
  if (splitCanvasWrapper) {
    splitCanvasWrapper.style.setProperty('--split-pct', '50%');
  }
});

// ----------------------------------------------------
// Batch Processing
// ----------------------------------------------------
async function processBatch(files) {
  batchFiles = Array.from(files);
  if (batchFiles.length === 0) return;

  if (batchFiles.length === 1) {
    batchSection.hidden = true;
    await processSingleFile(batchFiles[0]);
    return;
  }

  // Multi-file batch mode
  batchSection.hidden = false;
  comparisonSection.hidden = true;
  progressBarContainer.hidden = false;
  batchTableBody.innerHTML = '';
  batchResults = [];
  batchCount.textContent = batchFiles.length;

  let totalInBytes = 0;
  let totalOutBytes = 0;
  let completed = 0;

  for (let i = 0; i < batchFiles.length; i++) {
    const file = batchFiles[i];
    progressText.textContent = `Converting ${i + 1}/${batchFiles.length}: ${file.name}...`;
    progressBarFill.style.width = `${Math.round(((i) / batchFiles.length) * 100)}%`;

    try {
      const isPhf = file.name.toLowerCase().endsWith('.phf');
      const arrayBuffer = await file.arrayBuffer();
      const inSize = file.size;
      totalInBytes += inSize;

      let outBlob;
      let outName;
      let outSize;
      let durationMs = 0;
      let thumbUrl = '';

      if (isPhf) {
        const decoded = decodePHFBuffer(arrayBuffer);
        durationMs = decoded.decodeTimeMs;
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = decoded.width;
        tempCanvas.height = decoded.height;
        tempCanvas.getContext('2d').putImageData(decoded.imageData, 0, 0);

        thumbUrl = tempCanvas.toDataURL('image/jpeg', 0.6);
        const exportFormat = optExportFormat.value;
        outBlob = await canvasToBlob(tempCanvas, exportFormat);
        outSize = outBlob.size;
        const base = file.name.replace(/\.[^/.]+$/, '');
        outName = `${base}.${exportFormat === 'jpeg' ? 'jpg' : exportFormat}`;
      } else {
        const { imageData, width, height } = await loadStandardImageToImageData(file);
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = width;
        tempCanvas.height = height;
        tempCanvas.getContext('2d').putImageData(imageData, 0, 0);
        thumbUrl = tempCanvas.toDataURL('image/jpeg', 0.6);

        const encoded = encodeToPHF(imageData, optMode.value, optEffort.value, optChannels.value);
        durationMs = encoded.encodeTimeMs;
        outBlob = new Blob([encoded.phfBytes], { type: 'application/octet-stream' });
        outSize = outBlob.size;
        const base = file.name.replace(/\.[^/.]+$/, '');
        outName = `${base}.phf`;
      }

      totalOutBytes += outSize;
      completed++;

      const delta = outSize - inSize;
      const pct = (delta / inSize) * 100;
      const blobUrl = URL.createObjectURL(outBlob);

      batchResults.push({ file, outBlob, outName, inSize, outSize, blobUrl });

      // Append row
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><img src="${thumbUrl}" class="table-thumb" alt="thumb"></td>
        <td><span class="table-filename">${outName}</span></td>
        <td>${formatBytes(inSize)}</td>
        <td><strong>${formatBytes(outSize)}</strong></td>
        <td>
          <span class="table-badge-savings ${pct <= 0 ? 'savings-good' : 'savings-mod'}">
            ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%
          </span>
        </td>
        <td>${durationMs.toFixed(1)} ms</td>
        <td>
          <a href="${blobUrl}" download="${outName}" class="btn-table-dl">Download</a>
        </td>
      `;
      batchTableBody.appendChild(tr);

    } catch (err) {
      console.error('[Batch item error]', file.name, err);
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>-</td>
        <td><span class="table-filename">${file.name}</span></td>
        <td>${formatBytes(file.size)}</td>
        <td colspan="4" style="color: var(--danger)">Error: ${err.message}</td>
      `;
      batchTableBody.appendChild(tr);
    }
  }

  progressBarFill.style.width = '100%';
  setTimeout(() => { progressBarContainer.hidden = true; }, 400);

  const totalDelta = totalOutBytes - totalInBytes;
  const totalPct = (totalDelta / totalInBytes) * 100;
  batchSummaryText.textContent = `Completed ${completed} files. Input: ${formatBytes(totalInBytes)} \u2192 Output: ${formatBytes(totalOutBytes)} (${totalPct >= 0 ? '+' : ''}${totalPct.toFixed(1)}%)`;
}

btnDownloadAll.addEventListener('click', () => {
  if (batchResults.length === 0) return;
  batchResults.forEach((item, idx) => {
    setTimeout(() => {
      const a = document.createElement('a');
      a.href = item.blobUrl;
      a.download = item.outName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }, idx * 250);
  });
});

// ----------------------------------------------------
// User Interactions & Event Handlers
// ----------------------------------------------------
btnBrowse.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('click', (e) => {
  if (e.target.closest('.btn-sample') || e.target.closest('.samples-bar')) return;
  fileInput.click();
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files.length > 0) {
    processBatch(e.target.files);
  }
});

// Drag and drop handlers
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('dragover');
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    processBatch(e.dataTransfer.files);
  }
});

// Clipboard Paste (Ctrl+V)
window.addEventListener('paste', async (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;

  const files = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind === 'file' && items[i].type.startsWith('image/')) {
      const file = items[i].getAsFile();
      if (file) files.push(file);
    }
  }

  if (files.length > 0) {
    processBatch(files);
  }
});

// Re-convert on settings change
btnReconvert.addEventListener('click', () => {
  if (currentSourceFile) {
    processSingleFile(currentSourceFile);
  }
});

[optMode, optEffort, optChannels, optExportFormat].forEach((ctrl) => {
  ctrl.addEventListener('change', () => {
    if (currentSourceFile && !comparisonSection.hidden) {
      processSingleFile(currentSourceFile);
    }
  });
});

// Sample File Loaders
async function loadSampleUrl(url, filename) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const file = new File([blob], filename, { type: blob.type });
    processSingleFile(file);
  } catch (err) {
    alert(`Could not load sample file: ${err.message}`);
  }
}

samplePhfBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  loadSampleUrl('samples/sample.phf', 'sample.phf');
});

sampleMarioBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  loadSampleUrl('samples/mario_sheet.png', 'mario_sheet.png');
});

samplePixelBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  loadSampleUrl('samples/pixel_art.png', 'pixel_art.png');
});

// Boot
window.addEventListener('DOMContentLoaded', () => {
  initPHF();
});
