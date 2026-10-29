# PHF Converter ⚡

**PHF Converter** is a high-performance, 100% client-side web application for converting common image formats to the **Pure High-Fidelity Format (PHF)** and vice-versa in real time using **WebAssembly (SIMD128)**.

---

## ✨ Features

- **Bi-Directional Conversion**:
  - **Images &rarr; PHF**: Converts PNG, JPEG, WebP, AVIF, GIF, BMP, ICO, and **Canon RAW (.CR2)** into bit-exact lossless `.phf` files.
  - **PHF &rarr; Images**: Decompresses `.phf` containers and exports to lossless PNG, WebP (lossless or lossy), BMP (24-bit), or high-quality JPEG.
- **100% Client-Side & Private**:
  - All compression and decompression executes directly in your browser through `phf.wasm`. No image data ever leaves your device.
- **Detailed Metadata & Size Analysis**:
  - Displays original vs. converted dimensions, file sizes (human-readable and exact byte count), compression ratio (`X.XXx`), space saved (`-%`), and processing latency (`ms`).
- **Visual Fidelity Comparison**:
  - **Side-by-Side View**: Dual-canvas layout comparing input and output.
  - **Interactive Split Slider**: Draggable before-and-after curtain overlay to verify 100% bit-exact fidelity.
- **Codec Encoding Options**:
  - **Mode**: `Auto` (adaptive best mode), `MED` (JPEG-LS spatial predictor for continuous-tone photos and videos), and `Palette` (pixel art, screenshots, graphics, UI).
  - **Effort**: `Best` (dual-trial encoding for minimum file size) or `Fast` (single-pass encode).
  - **Color Channels**: `Auto` (automatically strips unused alpha when images are 100% opaque to save up to 25% bandwidth), `Force RGBA`, or `Force RGB`.
- **Drag & Drop & Clipboard**:
  - Drag and drop single or multiple files.
  - Paste directly from your clipboard (`Ctrl+V`).
- **Batch Processing**:
  - Process multiple files simultaneously with individual status, metrics, and sequential download.
- **Built-in Test Samples**:
  - One-click testing with included `.phf`, pixel art, and graphic samples.

---

## 🚀 Quick Start

Because browsers block WebAssembly streaming and cross-origin resource requests on `file://` URLs, serve the folder over HTTP:

### Using the Included Python Runner
```bash
python run.py
```
This automatically starts a local server on `http://localhost:8080` and opens your default browser.

### Alternative Local Servers
```bash
# Node.js
npx serve .

# Python 3 built-in
python -m http.server 8080
```

---

## 📂 Project Structure

```
phf-converter/
├── index.html       # Main application interface
├── style.css        # Responsive dark-mode styling and UI components
├── app.js           # Conversion pipeline, WASM glue, and UI controller
├── phf.js           # Emscripten module loader
├── phf.wasm         # Compiled libphf v1.1 WebAssembly engine (SIMD128)
├── run.py           # Zero-dependency local dev server
├── samples/         # Bundled sample images and PHF files for quick testing
└── README.md        # Documentation
```

---

## 🔗 Related Repositories

- [libphf/phf](https://github.com/libphf/phf) — C library, CLI tool, specification, and test suite.
- [libphf/phf-stream-webcam](https://github.com/libphf/phf-stream-webcam) — Real-time live camera streaming over WebSockets.
- [libphf/phf-stream-video](https://github.com/libphf/phf-stream-video) — Video file streaming server.
- [libphf/phf-stream-pi](https://github.com/libphf/phf-stream-pi) — Raspberry Pi native camera streaming server.
- [libphf/shared_memory](https://github.com/libphf/shared_memory) — Collaborative agent notebook and project status.
