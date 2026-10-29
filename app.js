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
// RAW Image Parser (Canon .CR2, .NEF, .ARW, .DNG)
// Extracts high-resolution embedded preview from TIFF/RAW container
// ----------------------------------------------------
function inspectJpegHeader(u8, offset, length) {
  let pos = offset + 2;
  const end = Math.min(u8.byteLength, offset + length);
  while (pos < end - 8) {
    if (u8[pos] === 0xFF) {
      const marker = u8[pos + 1];
      if (marker === 0xD9) break; // EOI
      // SOF0 (0xC0 baseline DCT) or SOF2 (0xC2 progressive DCT) - standard viewable JPEG
      if (marker === 0xC0 || marker === 0xC2) {
        const h = (u8[pos + 5] << 8) | u8[pos + 6];
        const w = (u8[pos + 7] << 8) | u8[pos + 8];
        return { valid: true, width: w, height: h };
      }
      // SOF3 (0xC3) - ITU-T81 lossless JPEG (used for raw Bayer sensor data, rejected by browser)
      if (marker === 0xC3) {
        return { valid: false, reason: 'Lossless JPEG sensor stream' };
      }
      if (pos + 3 >= end) break;
      const segLen = (u8[pos + 2] << 8) | u8[pos + 3];
      if (segLen < 2) break;
      pos += 2 + segLen;
    } else {
      pos++;
    }
  }
  return { valid: false, reason: 'No valid SOF found' };
}

function extractImageFromRaw(arrayBuffer) {
  const u8 = new Uint8Array(arrayBuffer);
  if (u8.byteLength < 16) return null;

  // Check TIFF byte order magic ('II' = little-endian, 'MM' = big-endian)
  const isLE = u8[0] === 0x49 && u8[1] === 0x49;
  const isBE = u8[0] === 0x4D && u8[1] === 0x4D;
  if (!isLE && !isBE) return null;

  const dv = new DataView(arrayBuffer);
  let candidates = [];

  // Parse TIFF IFD entries
  try {
    let ifdOffset = dv.getUint32(4, isLE);
    let ifdIndex = 0;
    while (ifdOffset > 0 && ifdOffset < arrayBuffer.byteLength - 2 && ifdIndex < 8) {
      const numEntries = dv.getUint16(ifdOffset, isLE);
      let p = ifdOffset + 2;
      let offset = 0;
      let length = 0;

      for (let i = 0; i < numEntries && p + 12 <= arrayBuffer.byteLength; i++) {
        const tag = dv.getUint16(p, isLE);
        const val = dv.getUint32(p + 8, isLE);
        if (tag === 0x0111 || tag === 0x0201) offset = val; // StripOffsets / JPEGInterchangeFormat
        if (tag === 0x0117 || tag === 0x0202) length = val; // StripByteCounts / JPEGInterchangeFormatLength
        p += 12;
      }

      if (offset > 0 && length > 5000 && offset + length <= arrayBuffer.byteLength) {
        if (u8[offset] === 0xFF && u8[offset + 1] === 0xD8) {
          const info = inspectJpegHeader(u8, offset, length);
          if (info.valid && info.width > 0 && info.height > 0) {
            candidates.push({ offset, length, width: info.width, height: info.height, pixels: info.width * info.height });
          }
        }
      }

      if (p + 4 <= arrayBuffer.byteLength) {
        ifdOffset = dv.getUint32(p, isLE);
      } else {
        break;
      }
      ifdIndex++;
    }
  } catch (e) {
    console.warn('[RAW IFD Parser Warning]', e);
  }

  // Fallback: fast scan for embedded JPEG SOI/EOI
  if (candidates.length === 0) {
    const scanLimit = Math.min(u8.byteLength - 4, 25000000);
    for (let i = 0; i < scanLimit; i++) {
      if (u8[i] === 0xFF && u8[i+1] === 0xD8 && u8[i+2] === 0xFF) {
        for (let j = i + 5000; j < Math.min(u8.byteLength - 1, i + 25000000); j++) {
          if (u8[j] === 0xFF && u8[j+1] === 0xD9) {
            const length = (j + 2) - i;
            const info = inspectJpegHeader(u8, i, length);
            if (info.valid && info.width > 0 && info.height > 0) {
              candidates.push({ offset: i, length, width: info.width, height: info.height, pixels: info.width * info.height });
            }
            i = j + 2;
            break;
          }
        }
      }
    }
  }

  if (candidates.length > 0) {
    // Sort descending by resolution (pixels), then by length
    candidates.sort((a, b) => b.pixels - a.pixels || b.length - a.length);
    const best = candidates[0];
    const jpegBytes = u8.subarray(best.offset, best.offset + best.length);
    return new Blob([jpegBytes], { type: 'image/jpeg' });
  }

  return null;
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
// Windows BMP (24-bit Uncompressed) Encoder
// ----------------------------------------------------
function encodeBmp(imageData) {
  const width = imageData.width;
  const height = imageData.height;
  const data = imageData.data;
  const rowStride = Math.floor((width * 3 + 3) / 4) * 4;
  const padding = rowStride - width * 3;
  const pixelDataSize = rowStride * height;
  const fileSize = 54 + pixelDataSize;
  const buf = new Uint8Array(fileSize);
  const dv = new DataView(buf.buffer);

  // BITMAPFILEHEADER (14 bytes)
  dv.setUint16(0, 0x4D42, false); // 'BM'
  dv.setUint32(2, fileSize, true);
  dv.setUint16(6, 0, true);
  dv.setUint16(8, 0, true);
  dv.setUint32(10, 54, true); // Offset to pixel data

  // BITMAPINFOHEADER (40 bytes)
  dv.setUint32(14, 40, true); // biSize
  dv.setInt32(18, width, true); // biWidth
  dv.setInt32(22, height, true); // biHeight (positive = bottom-up)
  dv.setUint16(26, 1, true); // biPlanes
  dv.setUint16(28, 24, true); // biBitCount (24-bit BGR)
  dv.setUint32(30, 0, true); // biCompression (BI_RGB)
  dv.setUint32(34, pixelDataSize, true); // biSizeImage
  dv.setInt32(38, 2835, true); // biXPelsPerMeter (72 DPI)
  dv.setInt32(42, 2835, true); // biYPelsPerMeter
  dv.setUint32(46, 0, true); // biClrUsed
  dv.setUint32(50, 0, true); // biClrImportant

  let outPos = 54;
  for (let y = height - 1; y >= 0; y--) {
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x++) {
      const idx = rowStart + (x * 4);
      buf[outPos++] = data[idx + 2]; // B
      buf[outPos++] = data[idx + 1]; // G
      buf[outPos++] = data[idx];     // R
    }
    for (let p = 0; p < padding; p++) {
      buf[outPos++] = 0;
    }
  }

  return new Blob([buf], { type: 'image/bmp' });
}

// ----------------------------------------------------
// Export Format Resolver
// ----------------------------------------------------
function getExportDetails(format) {
  switch (format) {
    case 'webp-lossless':
      return { ext: 'webp', label: 'WebP (Lossless \u2022 Bit-Exact)', isLossy: false };
    case 'bmp':
      return { ext: 'bmp', label: 'BMP (Lossless \u2022 24-bit)', isLossy: false };
    case 'jpeg':
      return { ext: 'jpg', label: 'JPEG (Lossy Q=95)', isLossy: true };
    case 'webp':
      return { ext: 'webp', label: 'WebP (Lossy Q=95)', isLossy: true };
    case 'png':
    default:
      return { ext: 'png', label: 'PNG (Lossless \u2022 Bit-Exact)', isLossy: false };
  }
}

// ----------------------------------------------------
// Canvas to Blob Exporter
// ----------------------------------------------------
async function canvasToBlob(canvas, format = 'png') {
  if (format === 'bmp') {
    const ctx = canvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return encodeBmp(imgData);
  }

  let mime = 'image/png';
  let quality = 0.95;

  if (format === 'webp-lossless') {
    mime = 'image/webp';
    quality = 1.0; // 1.0 instructs Chromium / Skia to encode in Lossless WebP mode
  } else if (format === 'webp') {
    mime = 'image/webp';
    quality = 0.95;
  } else if (format === 'jpeg' || format === 'jpg') {
    mime = 'image/jpeg';
    quality = 0.95;
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error(`Failed to convert canvas to ${mime}`));
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

      // Export to chosen format (PNG/WebP/BMP/JPEG)
      const exportFormat = optExportFormat.value;
      const exportDetails = getExportDetails(exportFormat);
      progressText.textContent = `Exporting to ${exportDetails.ext.toUpperCase()}...`;

      resultCanvas.width = decoded.width;
      resultCanvas.height = decoded.height;
      const ctxResult = resultCanvas.getContext('2d');
      ctxResult.putImageData(decoded.imageData, 0, 0);

      const targetBlob = await canvasToBlob(resultCanvas, exportFormat);
      const targetBytes = targetBlob.size;

      const baseName = file.name.replace(/\.[^/.]+$/, '');
      const outFilename = `${baseName}.${exportDetails.ext}`;

      resultFilename.textContent = outFilename;
      resultFormat.textContent = exportDetails.label;
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
      // Direction: Standard Image or RAW -> PHF
      // ------------------------------------
      const ext = file.name.split('.').pop().toLowerCase();
      const isRaw = ['cr2', 'raw', 'nef', 'arw', 'dng'].includes(ext);

      directionTag.textContent = `${ext.toUpperCase()} \u2192 PHF`;
      progressText.textContent = isRaw ? 'Parsing RAW container & extracting preview...' : 'Decoding original image...';

      let inputBlob = file;
      let formatLabel = file.type || `${ext.toUpperCase()} Image`;

      if (isRaw) {
        const extracted = extractImageFromRaw(arrayBuffer);
        if (!extracted) {
          throw new Error(`Failed to extract preview from ${ext.toUpperCase()} file`);
        }
        inputBlob = extracted;
        formatLabel = `Canon RAW (${ext.toUpperCase()} \u2022 Full Preview)`;
      }

      const { imageData, width, height } = await loadStandardImageToImageData(inputBlob);

      // Render Original
      origCanvas.width = width;
      origCanvas.height = height;
      const ctxOrig = origCanvas.getContext('2d');
      ctxOrig.putImageData(imageData, 0, 0);

      origFilename.textContent = file.name;
      origFormat.textContent = formatLabel;
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
        const exportDetails = getExportDetails(exportFormat);
        outBlob = await canvasToBlob(tempCanvas, exportFormat);
        outSize = outBlob.size;
        const base = file.name.replace(/\.[^/.]+$/, '');
        outName = `${base}.${exportDetails.ext}`;
      } else {
        const ext = file.name.split('.').pop().toLowerCase();
        const isRaw = ['cr2', 'raw', 'nef', 'arw', 'dng'].includes(ext);
        let inputBlob = file;
        if (isRaw) {
          const extracted = extractImageFromRaw(arrayBuffer);
          if (extracted) inputBlob = extracted;
        }

        const { imageData, width, height } = await loadStandardImageToImageData(inputBlob);
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
