const form = document.getElementById("upload-form");
const fileInput = document.getElementById("file-input");
const folderInput = document.getElementById("folder-input");
const pickFilesBtn = document.getElementById("pick-files");
const pickFolderBtn = document.getElementById("pick-folder");
const pickedFiles = document.getElementById("picked-files");
const dropZone = document.getElementById("drop-zone");
const submitButton = document.getElementById("submit-button");
const statusPanel = document.getElementById("status-panel");
const statusText = document.getElementById("status-text");
const resultPanel = document.getElementById("result-panel");
const resultTitle = document.getElementById("result-title");
const resultMeta = document.getElementById("result-meta");
const downloadLink = document.getElementById("download-link");
const schematicPreviews = document.getElementById("schematic-previews");
const pcbPreviews = document.getElementById("pcb-previews");
const drcOutput = document.getElementById("drc-output");
const projectFiles = document.getElementById("project-files");
const cliLog = document.getElementById("cli-log");

let selectedFiles = [];
let currentObjectUrls = [];
let currentZipUrl = null;
let logBuffer = [];
const APP_BUILD_ID = "2026-04-26T16:30:00";
const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();

const PRIMARY_PRIORITY = [
  ".kicad_pro",
  ".epro",
  ".prjpcb",
  ".schdoc",
  ".pcbdoc",
  ".kicad_sch",
  ".kicad_pcb",
  ".json",
  ".sch",
  ".brd"
];

function setStatus(message, tone = "working") {
  statusPanel.hidden = false;
  statusPanel.dataset.tone = tone;
  statusText.textContent = message;
}

function setBusy(isBusy) {
  submitButton.disabled = isBusy;
  fileInput.disabled = isBusy;
  folderInput.disabled = isBusy;
  pickFilesBtn.disabled = isBusy;
  pickFolderBtn.disabled = isBusy;
  dropZone.classList.toggle("busy", isBusy);
}

function clearObjectUrls() {
  currentObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  currentObjectUrls = [];

  if (currentZipUrl) {
    URL.revokeObjectURL(currentZipUrl);
    currentZipUrl = null;
  }
}

function makeObjectUrl(bytes, type) {
  const data = type === "image/svg+xml" ? normalizeSvgBytes(bytes) : bytes;
  const url = URL.createObjectURL(new Blob([data], { type }));
  currentObjectUrls.push(url);
  return url;
}

function normalizeSvgBytes(bytes) {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const text = TEXT_DECODER.decode(source);

  if (!text.includes("<svg")) {
    return source;
  }

  let out = text;

  out = out.replace(
    /<g\b[^>]*style="fill:#FFFFFF;\s*fill-opacity:1\.0000;\s*stroke:#FFFFFF;\s*stroke-width:0\.0001;\s*stroke-opacity:1;\s*stroke-linecap:round;\s*stroke-linejoin:round;"[^>]*>\s*<rect\b[^>]*x="0\.000000"\s+y="0\.000000"[^>]*\/>\s*<\/g>\s*/i,
    ""
  );

  if (/<svg\b[^>]*style="/i.test(out)) {
    out = out.replace(/<svg\b([^>]*?)style="([^"]*)"/i, (match, before, style) => {
      const trimmed = style.trim();
      const prefix = trimmed && !trimmed.endsWith(";") ? `${trimmed}; ` : `${trimmed} `;
      return `<svg${before}style="${prefix}background:#111827;"`;
    });
  } else {
    out = out.replace(/<svg\b/i, '<svg style="background:#111827;"');
  }

  return TEXT_ENCODER.encode(out);
}

function listFiles(files) {
  selectedFiles = Array.from(files || []);

  if (!selectedFiles.length) {
    pickedFiles.hidden = true;
    pickedFiles.textContent = "";
    return;
  }

  pickedFiles.hidden = false;
  pickedFiles.textContent = selectedFiles
    .map((file) => {
      const label = file.webkitRelativePath || file.name;
      return `${label} (${Math.max(1, Math.round(file.size / 1024))} KB)`;
    })
    .join("\n");
}

function setDropFiles(files) {
  listFiles(files);
}

function sanitizeRelativePath(file) {
  const raw = (file.webkitRelativePath || file.name || "").replaceAll("\\", "/");
  const cleaned = raw
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");

  if (!cleaned) {
    throw new Error("One of the selected files does not have a usable filename.");
  }

  return cleaned;
}

function quoteCliArg(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function prettyPrint(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function ensureDir(path) {
  const parts = path.split("/").filter(Boolean);
  let current = "";

  for (const part of parts) {
    current += `/${part}`;

    try {
      Module.FS.mkdir(current);
    } catch {
      // Directory already exists.
    }
  }
}

function removeTree(path) {
  try {
    const stat = Module.FS.stat(path);

    if (Module.FS.isFile(stat.mode)) {
      Module.FS.unlink(path);
      return;
    }

    for (const entry of Module.FS.readdir(path)) {
      if (entry === "." || entry === "..") {
        continue;
      }

      removeTree(`${path}/${entry}`);
    }

    Module.FS.rmdir(path);
  } catch {
    // Ignore missing paths.
  }
}

function readDirEntries(path) {
  try {
    return Module.FS.readdir(path).filter((name) => name !== "." && name !== "..");
  } catch {
    return [];
  }
}

function walkFiles(root, onFile) {
  const stack = [root];

  while (stack.length) {
    const current = stack.pop();
    const entries = readDirEntries(current);

    for (const entry of entries) {
      const full = `${current}/${entry}`;
      const stat = Module.FS.stat(full);

      if (Module.FS.isDir(stat.mode)) {
        stack.push(full);
      } else if (Module.FS.isFile(stat.mode)) {
        onFile(full);
      }
    }
  }
}

function listFilesRecursive(root) {
  const files = [];
  walkFiles(root, (full) => files.push(full));
  files.sort();
  return files;
}

function snapshotTree(root) {
  const entries = [];

  walkFiles(root, (full) => {
    entries.push({
      path: relPath(root, full),
      data: new Uint8Array(Module.FS.readFile(full))
    });
  });

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

function restoreSnapshot(root, entries) {
  ensureDir(root);

  for (const entry of entries) {
    const full = `${root}/${entry.path}`;
    ensureDir(full.slice(0, full.lastIndexOf("/")));
    Module.FS.writeFile(full, entry.data);
  }
}

function relPath(root, full) {
  return full.startsWith(`${root}/`) ? full.slice(root.length + 1) : full;
}

function findFirstByExt(root, extension) {
  return listFilesRecursive(root).find((file) => file.toLowerCase().endsWith(extension)) || null;
}

function findAllByExt(root, extension) {
  return listFilesRecursive(root).filter((file) => file.toLowerCase().endsWith(extension));
}

function relDir(path) {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(0, index) : "";
}

function relStem(path) {
  return path.split("/").pop().replace(/\.[^.]+$/, "");
}

function scoreNativeProject(relPath, relSet) {
  const lower = relPath.toLowerCase();
  const base = relPath.replace(/\.[^.]+$/, "");
  const dir = relDir(relPath);
  const depth = relPath.split("/").length;
  let score = 0;

  if (lower.endsWith(".kicad_pro")) {
    score += 100;
  } else if (lower.endsWith(".kicad_sch")) {
    score += 80;
  } else if (lower.endsWith(".kicad_pcb")) {
    score += 70;
  }

  if (relSet.has(`${base}.kicad_sch`)) {
    score += 10;
  }

  if (relSet.has(`${base}.kicad_pcb`)) {
    score += 10;
  }

  if (relSet.has(`${base}.kicad_pro`)) {
    score += 10;
  }

  if (relStem(relPath) === dir.split("/").pop()) {
    score += 1;
  }

  return score - depth * 2;
}

async function readFileBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

async function serializeSelectedFiles(files) {
  const serialized = await Promise.all(
    files.map(async (file) => ({
      path: sanitizeRelativePath(file),
      bytes: await readFileBytes(file)
    }))
  );

  return KicadZipUtils.expandEntries(serialized);
}

function choosePrimaryInput(relPaths) {
  const lowered = relPaths.map((path) => ({ path, lower: path.toLowerCase() }));
  const relSet = new Set(relPaths);
  const native = lowered
    .filter((entry) => [".kicad_pro", ".kicad_sch", ".kicad_pcb"].some((ext) => entry.lower.endsWith(ext)))
    .sort((a, b) => {
      const scoreDelta = scoreNativeProject(b.path, relSet) - scoreNativeProject(a.path, relSet);
      return scoreDelta || a.path.localeCompare(b.path);
    });

  if (native.length) {
    return native[0].path;
  }

  for (const ext of PRIMARY_PRIORITY) {
    const match = lowered.find((entry) => entry.lower.endsWith(ext));

    if (match) {
      return match.path;
    }
  }

  return lowered[0]?.path || null;
}

function stageFilesToWasm(files, baseDir) {
  ensureDir(baseDir);
  const relPaths = [];

  return Promise.all(
    files.map(async (file) => {
      const rel = sanitizeRelativePath(file);
      const wasmPath = `${baseDir}/${rel}`;
      const bytes = await readFileBytes(file);
      ensureDir(wasmPath.slice(0, wasmPath.lastIndexOf("/")));
      Module.FS.writeFile(wasmPath, bytes);
      relPaths.push(rel);
    })
  ).then(() => relPaths.sort());
}

function startLogCapture() {
  logBuffer = [];
  cliLog.textContent = "";
}

function appendLog(line) {
  if (shouldIgnoreLog(line)) {
    return;
  }

  logBuffer.push(line);
  cliLog.textContent = logBuffer.join("\n");
}

function shouldIgnoreLog(line) {
  const text = String(line || "");

  return (
    text.includes("AsUTF8(): trying to encode undefined Unicode character") ||
    text.includes("Adding duplicate image handler for")
  );
}

function runCommand(command, label = command) {
  appendLog(`$ ${label}`);
  const rc = Module.ccall("kicad_cli_run_command", "number", ["string"], [command]);
  appendLog(`[exit ${rc}] ${label}`);

  if (rc !== 0) {
    throw new Error(`Command failed (${rc}): ${label}`);
  }
}

function findProjectRoot(importRoot, primaryInputPath) {
  const kicadPro = findFirstByExt(importRoot, ".kicad_pro");

  if (kicadPro) {
    return kicadPro.slice(0, kicadPro.lastIndexOf("/"));
  }

  const primaryDir = primaryInputPath.slice(0, primaryInputPath.lastIndexOf("/")) || importRoot;
  return primaryDir;
}

function projectTitleFromPath(projectRoot) {
  const parts = projectRoot.split("/").filter(Boolean);
  return parts[parts.length - 1] || "project";
}

function getExtension(path) {
  const lower = path.toLowerCase();
  const index = lower.lastIndexOf(".");
  return index >= 0 ? lower.slice(index) : "";
}

function buildNativeProject(filesRoot, primaryInputPath, projectRootBase) {
  const ext = getExtension(primaryInputPath);

  if (ext === ".kicad_pro") {
    return primaryInputPath.slice(0, primaryInputPath.lastIndexOf("/"));
  }

  const sourceDir = primaryInputPath.slice(0, primaryInputPath.lastIndexOf("/")) || filesRoot;
  const stem = primaryInputPath.split("/").pop().replace(/\.[^.]+$/, "");
  const projectRoot = `${projectRootBase}/${stem}`;
  ensureDir(projectRoot);

  for (const file of listFilesRecursive(sourceDir)) {
    const target = `${projectRoot}/${relPath(sourceDir, file)}`;
    ensureDir(target.slice(0, target.lastIndexOf("/")));
    Module.FS.writeFile(target, Module.FS.readFile(file));
  }

  return projectRoot;
}

function createCrc32Table() {
  const table = new Uint32Array(256);

  for (let i = 0; i < 256; i += 1) {
    let crc = i;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }

    table[i] = crc >>> 0;
  }

  return table;
}

const CRC32_TABLE = createCrc32Table();

function crc32(bytes) {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function writeU16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeU32(view, offset, value) {
  view.setUint32(offset, value, true);
}

function concatUint8Arrays(chunks) {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }

  return out;
}

function buildZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const data = entry.data;
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const localView = new DataView(local.buffer);
    writeU32(localView, 0, 0x04034b50);
    writeU16(localView, 4, 20);
    writeU16(localView, 6, 0);
    writeU16(localView, 8, 0);
    writeU16(localView, 10, 0);
    writeU16(localView, 12, 0);
    writeU32(localView, 14, crc);
    writeU32(localView, 18, data.length);
    writeU32(localView, 22, data.length);
    writeU16(localView, 26, nameBytes.length);
    writeU16(localView, 28, 0);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    localChunks.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    writeU32(centralView, 0, 0x02014b50);
    writeU16(centralView, 4, 20);
    writeU16(centralView, 6, 20);
    writeU16(centralView, 8, 0);
    writeU16(centralView, 10, 0);
    writeU16(centralView, 12, 0);
    writeU16(centralView, 14, 0);
    writeU32(centralView, 16, crc);
    writeU32(centralView, 20, data.length);
    writeU32(centralView, 24, data.length);
    writeU16(centralView, 28, nameBytes.length);
    writeU16(centralView, 30, 0);
    writeU16(centralView, 32, 0);
    writeU16(centralView, 34, 0);
    writeU16(centralView, 36, 0);
    writeU32(centralView, 38, 0);
    writeU32(centralView, 42, offset);
    central.set(nameBytes, 46);
    centralChunks.push(central);

    offset += local.length;
  }

  const central = concatUint8Arrays(centralChunks);
  const locals = concatUint8Arrays(localChunks);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  writeU32(eocdView, 0, 0x06054b50);
  writeU16(eocdView, 4, 0);
  writeU16(eocdView, 6, 0);
  writeU16(eocdView, 8, entries.length);
  writeU16(eocdView, 10, entries.length);
  writeU32(eocdView, 12, central.length);
  writeU32(eocdView, 16, locals.length);
  writeU16(eocdView, 20, 0);

  return concatUint8Arrays([locals, central, eocd]);
}

function makePreviewCards(container, items, emptyText) {
  container.innerHTML = "";

  if (!items.length) {
    container.classList.add("empty-state");
    container.textContent = emptyText;
    return;
  }

  container.classList.remove("empty-state");

  for (const item of items) {
    const card = document.createElement("article");
    card.className = "svg-card";

    const head = document.createElement("div");
    head.className = "svg-card-head";

    const title = document.createElement("h4");
    title.textContent = item.label;

    const open = document.createElement("a");
    open.href = item.url;
    open.target = "_blank";
    open.rel = "noreferrer";
    open.textContent = "Open";

    head.append(title, open);

    const frame = document.createElement("div");
    frame.className = "svg-frame";

    const image = document.createElement("img");
    image.src = item.url;
    image.alt = item.label;
    image.loading = "lazy";
    frame.append(image);

    card.append(head, frame);
    container.append(card);
  }
}

function buildZipForProject(projectRoot, title) {
  const entries = [];

  for (const file of listFilesRecursive(projectRoot)) {
    const rel = relPath(projectRoot, file);

    if (rel.endsWith(".lck")) {
      continue;
    }

    entries.push({
      name: `${title}/${rel}`,
      data: Module.FS.readFile(file)
    });
  }

  return buildZip(entries);
}

function buildZipForSnapshot(entries, title) {
  return buildZip(
    entries
      .filter((entry) => !entry.path.endsWith(".lck"))
      .map((entry) => ({
        name: `${title}/${entry.path}`,
        data: entry.data
      }))
  );
}

function runWorkerJob(job, payload) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`./kicad-worker.js?v=${encodeURIComponent(APP_BUILD_ID)}`);

    worker.onmessage = (event) => {
      const { type, text, result, error } = event.data || {};

      if (type === "log" && text) {
        appendLog(text);
        return;
      }

      if (type === "result") {
        worker.terminate();
        resolve(result);
        return;
      }

      if (type === "error") {
        worker.terminate();
        reject(new Error(error || "Worker job failed."));
      }
    };

    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "Worker crashed."));
    };

    const transfer = [];

    if (payload.files) {
      for (const file of payload.files) {
        transfer.push(file.bytes.buffer);
      }
    }

    if (payload.projectEntries) {
      for (const entry of payload.projectEntries) {
        transfer.push(entry.bytes.buffer);
      }
    }

    worker.postMessage({ job, payload }, transfer);
  });
}

async function runPipeline() {
  if (!selectedFiles.length) {
    throw new Error("Pick at least one project file before running the pipeline.");
  }

  clearObjectUrls();
  startLogCapture();
  resultPanel.hidden = true;
  drcOutput.textContent = "No DRC report yet.";

  setStatus("Reading files in the browser...", "working");
  const files = await serializeSelectedFiles(selectedFiles);
  const relPaths = files.map((file) => file.path).sort();
  const primaryRel = choosePrimaryInput(relPaths);

  if (!primaryRel) {
    throw new Error("Could not determine a primary input file.");
  }

  setStatus("Importing and normalizing the project...", "working");
  const importResult = await runWorkerJob("import", {
    files,
    primaryRel
  });

  const projectSnapshot = importResult.projectEntries.map((entry) => ({
    path: entry.path,
    data: new Uint8Array(entry.bytes)
  }));
  const title = importResult.title;
  const zipBytes = buildZipForSnapshot(projectSnapshot, title);

  if (!projectSnapshot.length || !title) {
    throw new Error("The conversion step did not produce any KiCad project files.");
  }

  setStatus("Rendering SVG previews and running DRC...", "working");
  const renderResult = await runWorkerJob("render", {
    projectEntries: projectSnapshot.map((entry) => ({
      path: entry.path,
      bytes: entry.data
    }))
  });

  const schematicItems = [];
  const pcbItems = [];
  const importArtifacts = (importResult.artifacts || []).map((entry) => ({
    path: entry.path,
    data: new Uint8Array(entry.bytes)
  }));
  const artifactEntries = renderResult.artifacts.map((entry) => ({
    path: entry.path,
    data: new Uint8Array(entry.bytes)
  }));

  for (const entry of importArtifacts) {
    if (entry.path.startsWith("sch-svg/") && entry.path.endsWith(".svg")) {
      schematicItems.push({
        label: entry.path.slice("sch-svg/".length),
        url: makeObjectUrl(entry.data, "image/svg+xml")
      });
    }
  }

  for (const entry of artifactEntries) {
    if (entry.path === "pcb-svg-top/pcb-top.svg") {
      pcbItems.push({
        label: "Top View",
        url: makeObjectUrl(entry.data, "image/svg+xml")
      });
    } else if (entry.path === "pcb-svg-bottom/pcb-bottom.svg") {
      pcbItems.push({
        label: "Bottom View",
        url: makeObjectUrl(entry.data, "image/svg+xml")
      });
    } else if (entry.path === "drc-json/drc.json") {
      drcOutput.textContent = prettyPrint(new TextDecoder().decode(entry.data));
    }
  }

  currentZipUrl = URL.createObjectURL(new Blob([zipBytes], { type: "application/zip" }));

  resultTitle.textContent = title;
  resultMeta.textContent = `Primary input: ${primaryRel}`;
  downloadLink.href = currentZipUrl;
  downloadLink.download = `${title}.zip`;
  projectFiles.textContent = importResult.projectFiles.join("\n");
  makePreviewCards(
    schematicPreviews,
    schematicItems,
    "No schematic preview was produced for this input."
  );
  makePreviewCards(
    pcbPreviews,
    pcbItems,
    "No PCB preview was produced for this input."
  );

  resultPanel.hidden = false;
  setStatus("Import, preview, DRC, and zip export completed in the browser.", "success");
}

function onFilesPicked(files) {
  listFiles(files);
}

pickFilesBtn.addEventListener("click", () => fileInput.click());
pickFolderBtn.addEventListener("click", () => folderInput.click());

fileInput.addEventListener("change", () => {
  onFilesPicked(fileInput.files);
  folderInput.value = "";
});

folderInput.addEventListener("change", () => {
  onFilesPicked(folderInput.files);
  fileInput.value = "";
});

["dragenter", "dragover"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
  });
});

dropZone.addEventListener("drop", (event) => {
  setDropFiles(event.dataTransfer.files);
  fileInput.value = "";
  folderInput.value = "";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  setBusy(true);

  try {
    await runPipeline();
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    setBusy(false);
  }
});

submitButton.textContent = "Convert, Render, And Run DRC";
setBusy(false);
setStatus("Ready. Choose files to start the client-side pipeline.", "success");
