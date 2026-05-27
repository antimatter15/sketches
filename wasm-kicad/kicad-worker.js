/* global KicadCLI */
const WORKER_BUILD_ID = new URL(self.location.href).searchParams.get("v") || "dev";

importScripts(`./zip-utils.js?v=${encodeURIComponent(WORKER_BUILD_ID)}`);
importScripts(`./wasm/kicad_cli.js?v=${encodeURIComponent(WORKER_BUILD_ID)}`);

function postLog(text) {
  if (shouldIgnoreLog(text)) {
    return;
  }

  self.postMessage({ type: "log", text: String(text) });
}

function shouldIgnoreLog(text) {
  const line = String(text || "");

  return (
    line.includes("AsUTF8(): trying to encode undefined Unicode character") ||
    line.includes("Adding duplicate image handler for")
  );
}

function quoteCliArg(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function mkdirp(Module, dir) {
  const parts = dir.split("/").filter(Boolean);
  let current = "";

  for (const part of parts) {
    current += `/${part}`;

    try {
      Module.FS.mkdir(current);
    } catch {
    }
  }
}

function removeTree(Module, target) {
  try {
    const stat = Module.FS.stat(target);

    if (Module.FS.isFile(stat.mode)) {
      Module.FS.unlink(target);
      return;
    }

    for (const entry of Module.FS.readdir(target)) {
      if (entry === "." || entry === "..") {
        continue;
      }

      removeTree(Module, `${target}/${entry}`);
    }

    Module.FS.rmdir(target);
  } catch {
  }
}

function walkFiles(Module, root, out = []) {
  for (const entry of Module.FS.readdir(root)) {
    if (entry === "." || entry === "..") {
      continue;
    }

    const full = `${root}/${entry}`;
    const stat = Module.FS.stat(full);

    if (Module.FS.isDir(stat.mode)) {
      walkFiles(Module, full, out);
    } else if (Module.FS.isFile(stat.mode)) {
      out.push(full);
    }
  }

  return out;
}

function relPath(root, full) {
  return full.startsWith(`${root}/`) ? full.slice(root.length + 1) : full;
}

function findFirstByExt(Module, root, extension) {
  const lowerExt = extension.toLowerCase();

  return walkFiles(Module, root)
    .sort()
    .find((file) => file.toLowerCase().endsWith(lowerExt)) || null;
}

function fileExists(Module, file) {
  try {
    return Module.FS.isFile(Module.FS.stat(file).mode);
  } catch {
    return false;
  }
}

function projectBaseScore(Module, root, proPath) {
  const base = proPath.slice(0, -".kicad_pro".length);
  const dir = proPath.slice(0, proPath.lastIndexOf("/"));
  const stem = proPath.split("/").pop().replace(/\.kicad_pro$/i, "");
  const dirName = dir.split("/").pop();
  const depth = relPath(root, proPath).split("/").length;
  let score = 0;

  if (fileExists(Module, `${base}.kicad_sch`)) {
    score += 10;
  }

  if (fileExists(Module, `${base}.kicad_pcb`)) {
    score += 10;
  }

  if (stem === dirName) {
    score += 1;
  }

  return score - depth * 2;
}

function findProjectBases(Module, root) {
  return walkFiles(Module, root)
    .filter((file) => file.toLowerCase().endsWith(".kicad_pro"))
    .sort((a, b) => {
      const scoreDelta = projectBaseScore(Module, root, b) - projectBaseScore(Module, root, a);
      return scoreDelta || a.localeCompare(b);
    })
    .map((file) => file.slice(0, -".kicad_pro".length));
}

function findPreferredProjectFile(Module, root, extension) {
  for (const base of findProjectBases(Module, root)) {
    const paired = `${base}${extension}`;

    if (fileExists(Module, paired)) {
      return paired;
    }
  }

  const preferred = `${root}/${projectTitleFromPath(root)}${extension}`;

  if (fileExists(Module, preferred)) {
    return preferred;
  }

  return findFirstByExt(Module, root, extension);
}

function writeSyntheticProjectFile(Module, projectRoot, primaryInputPath) {
  if (findFirstByExt(Module, projectRoot, ".kicad_pro")) {
    return;
  }

  const anchor = findFirstByExt(Module, projectRoot, ".kicad_sch") ||
    findFirstByExt(Module, projectRoot, ".kicad_pcb") ||
    primaryInputPath;
  const dir = anchor.slice(0, anchor.lastIndexOf("/")) || projectRoot;
  const stem = anchor.split("/").pop().replace(/\.[^.]+$/, "") || "project";
  const projectPath = `${dir}/${stem}.kicad_pro`;
  const projectJson = `{
  "board": {},
  "meta": {
    "version": 1
  },
  "schematic": {}
}
`;

  Module.FS.writeFile(projectPath, new TextEncoder().encode(projectJson));
}

function getExtension(filePath) {
  const lower = filePath.toLowerCase();
  const index = lower.lastIndexOf(".");
  return index >= 0 ? lower.slice(index) : "";
}

function relDir(filePath) {
  const index = filePath.lastIndexOf("/");
  return index >= 0 ? filePath.slice(0, index) : "";
}

function relStem(filePath) {
  return filePath.split("/").pop().replace(/\.[^.]+$/, "");
}

function scoreNativeRelPath(filePath, relSet) {
  const ext = getExtension(filePath);
  const base = filePath.replace(/\.[^.]+$/, "");
  const dir = relDir(filePath);
  const depth = filePath.split("/").length;
  let score = 0;

  if (ext === ".kicad_pro") {
    score += 100;
  } else if (ext === ".kicad_sch") {
    score += 80;
  } else if (ext === ".kicad_pcb") {
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

  if (relStem(filePath) === dir.split("/").pop()) {
    score += 1;
  }

  return score - depth * 2;
}

function choosePrimaryRelPath(relPaths, requestedRel) {
  const relSet = new Set(relPaths);
  const native = relPaths
    .filter((file) => [".kicad_pro", ".kicad_sch", ".kicad_pcb"].includes(getExtension(file)))
    .sort((a, b) => {
      const scoreDelta = scoreNativeRelPath(b, relSet) - scoreNativeRelPath(a, relSet);
      return scoreDelta || a.localeCompare(b);
    });

  if (native.length) {
    return native[0];
  }

  if (requestedRel && relSet.has(requestedRel)) {
    return requestedRel;
  }

  return relPaths.find((path) => {
    const lower = path.toLowerCase();

    return (
      lower.endsWith(".epro") ||
      lower.endsWith(".prjpcb") ||
      lower.endsWith(".schdoc") ||
      lower.endsWith(".pcbdoc") ||
      lower.endsWith(".json") ||
      lower.endsWith(".sch") ||
      lower.endsWith(".brd")
    );
  }) || relPaths[0];
}

function projectTitleFromPath(projectRoot) {
  const parts = projectRoot.split("/").filter(Boolean);
  return parts[parts.length - 1] || "project";
}

function buildNativeProject(Module, filesRoot, primaryInputPath, projectRootBase) {
  const ext = getExtension(primaryInputPath);

  if (ext === ".kicad_pro") {
    return primaryInputPath.slice(0, primaryInputPath.lastIndexOf("/"));
  }

  const sourceDir = primaryInputPath.slice(0, primaryInputPath.lastIndexOf("/")) || filesRoot;
  const stem = primaryInputPath.split("/").pop().replace(/\.[^.]+$/, "");
  const projectRoot = `${projectRootBase}/${stem}`;
  mkdirp(Module, projectRoot);

  for (const file of walkFiles(Module, sourceDir).sort()) {
    const target = `${projectRoot}/${relPath(sourceDir, file)}`;
    mkdirp(Module, target.slice(0, target.lastIndexOf("/")));
    Module.FS.writeFile(target, Module.FS.readFile(file));
  }

  return projectRoot;
}

function findProjectRoot(Module, importRoot, primaryInputPath) {
  const kicadPro = findFirstByExt(Module, importRoot, ".kicad_pro");

  if (kicadPro) {
    return kicadPro.slice(0, kicadPro.lastIndexOf("/"));
  }

  const primaryDir = primaryInputPath.slice(0, primaryInputPath.lastIndexOf("/")) || importRoot;
  return primaryDir;
}

function snapshotTree(Module, root) {
  return walkFiles(Module, root).sort().map((full) => ({
    path: relPath(root, full),
    bytes: Module.FS.readFile(full)
  }));
}

function restoreSnapshot(Module, root, entries) {
  mkdirp(Module, root);

  for (const entry of entries) {
    const target = `${root}/${entry.path}`;
    mkdirp(Module, target.slice(0, target.lastIndexOf("/")));
    Module.FS.writeFile(target, entry.bytes);
  }
}

function findEntryBySuffix(entries, suffix) {
  const lower = suffix.toLowerCase();
  return entries.find((entry) => entry.path.toLowerCase().endsWith(lower)) || null;
}

function runCommand(Module, command, label = command) {
  postLog(`$ ${label}`);
  const rc = Module.ccall("kicad_cli_run_command", "number", ["string"], [command]);
  postLog(`[exit ${rc}] ${label}`);

  if (rc !== 0) {
    throw new Error(`Command failed (${rc}): ${label}`);
  }
}

function serializeEntries(entries) {
  return entries.map((entry) => ({
    path: entry.path,
    bytes: entry.bytes.buffer.slice(
      entry.bytes.byteOffset,
      entry.bytes.byteOffset + entry.bytes.byteLength
    )
  }));
}

function transferListFromEntries(entries) {
  return entries.map((entry) => entry.bytes);
}

function mergeEntryLists(baseEntries, overlayEntries) {
  const merged = new Map();

  for (const entry of baseEntries) {
    merged.set(entry.path, entry);
  }

  for (const entry of overlayEntries) {
    merged.set(entry.path, entry);
  }

  return Array.from(merged.values()).sort((a, b) => a.path.localeCompare(b.path));
}

async function createModule() {
  return KicadCLI({
    locateFile: (file) => `./wasm/${file}?v=${encodeURIComponent(WORKER_BUILD_ID)}`,
    print: (text) => {
      if (text) {
        postLog(text);
      }
    },
    printErr: (text) => {
      if (text) {
        postLog(text);
      }
    }
  });
}

async function runImportJob(payload) {
  const expandedFiles = await KicadZipUtils.expandEntries(payload.files.map((file) => ({
    path: file.path,
    bytes: new Uint8Array(file.bytes)
  })));

  const expandedRelPaths = expandedFiles.map((file) => file.path).sort();
  const primaryRel = choosePrimaryRelPath(expandedRelPaths, payload.primaryRel);
  const primaryExt = getExtension(primaryRel);
  const nativeInput = [".kicad_pro", ".kicad_sch", ".kicad_pcb"].includes(primaryExt);
  const primaryLeaf = primaryRel.split("/").pop();

  async function runForeignImportPass(modeFlag) {
    const Module = await createModule();
    const root = "/work";
    const inRoot = `${root}/in`;
    const projectBase = `${root}/project`;
    const outRoot = `${root}/out`;

    removeTree(Module, root);
    mkdirp(Module, inRoot);
    mkdirp(Module, projectBase);
    mkdirp(Module, outRoot);

    for (const file of expandedFiles) {
      const wasmPath = `${inRoot}/${file.path}`;
      mkdirp(Module, wasmPath.slice(0, wasmPath.lastIndexOf("/")));
      Module.FS.writeFile(wasmPath, file.bytes);
    }

    const primaryInputPath = `${inRoot}/${primaryRel}`;
    const stem = primaryLeaf.replace(/\.[^.]+$/, "") || "project";
    let projectRoot = `${projectBase}/${stem}`;
    mkdirp(Module, projectRoot);

    const label = `import ${primaryRel} ${modeFlag}`.trim();
    runCommand(
      Module,
      `import ${quoteCliArg(primaryInputPath)} -o ${quoteCliArg(projectRoot)} ${modeFlag}`.trim(),
      label
    );

    projectRoot = findProjectRoot(Module, projectRoot, primaryInputPath);

    return {
      Module,
      outRoot,
      projectRoot,
      projectEntries: snapshotTree(Module, projectRoot),
      schPath: findPreferredProjectFile(Module, projectRoot, ".kicad_sch"),
      pcbPath: findPreferredProjectFile(Module, projectRoot, ".kicad_pcb")
    };
  }

  const Module = nativeInput ? await createModule() : null;
  const root = "/work";
  const inRoot = `${root}/in`;
  const projectBase = `${root}/project`;
  const outRoot = `${root}/out`;

  if (nativeInput) {
    removeTree(Module, root);
    mkdirp(Module, inRoot);
    mkdirp(Module, projectBase);
    mkdirp(Module, outRoot);

    for (const file of expandedFiles) {
      const wasmPath = `${inRoot}/${file.path}`;
      mkdirp(Module, wasmPath.slice(0, wasmPath.lastIndexOf("/")));
      Module.FS.writeFile(wasmPath, file.bytes);
    }
  }

  const primaryInputPath = `${inRoot}/${primaryRel}`;
  let projectRoot;
  let projectEntries = [];

  if (nativeInput) {
    projectRoot = buildNativeProject(Module, inRoot, primaryInputPath, projectBase);
    writeSyntheticProjectFile(Module, projectRoot, primaryInputPath);
  } else {
    const schematicPass = await runForeignImportPass("--schematic-only");
    const boardPass = await runForeignImportPass("--board-only");
    const activePass = schematicPass.schPath ? schematicPass : boardPass;

    projectRoot = schematicPass.projectRoot || boardPass.projectRoot;
    projectEntries = mergeEntryLists(schematicPass.projectEntries, boardPass.projectEntries);
    const projectFiles = projectEntries.map((entry) => entry.path);
    const artifacts = [];

    if (schematicPass.schPath) {
      const schOut = `${schematicPass.outRoot}/sch-svg`;
      mkdirp(schematicPass.Module, schOut);
      runCommand(
        schematicPass.Module,
        `sch export svg ${quoteCliArg(schematicPass.schPath)} -o ${quoteCliArg(schOut)}`,
        `sch export svg ${relPath(schematicPass.projectRoot, schematicPass.schPath)}`
      );

      for (const svgPath of walkFiles(schematicPass.Module, schOut).sort()) {
        artifacts.push({
          path: `sch-svg/${relPath(schOut, svgPath)}`,
          bytes: schematicPass.Module.FS.readFile(svgPath)
        });
      }
    }

    const result = {
      title: projectTitleFromPath(projectRoot),
      primaryRel,
      projectFiles,
      projectEntries: serializeEntries(projectEntries),
      artifacts: serializeEntries(artifacts)
    };

    self.postMessage(
      { type: "result", result },
      transferListFromEntries(result.projectEntries).concat(transferListFromEntries(result.artifacts))
    );

    return;
  }

  projectEntries = projectEntries.length ? projectEntries : snapshotTree(Module, projectRoot);
  const projectFiles = projectEntries.map((entry) => entry.path);
  const schPath = findPreferredProjectFile(Module, projectRoot, ".kicad_sch");
  const artifacts = [];

  if (schPath) {
    const schOut = `${outRoot}/sch-svg`;
    mkdirp(Module, schOut);
    runCommand(Module, `sch export svg ${quoteCliArg(schPath)} -o ${quoteCliArg(schOut)}`, `sch export svg ${relPath(projectRoot, schPath)}`);

    for (const svgPath of walkFiles(Module, schOut).sort()) {
      artifacts.push({
        path: `sch-svg/${relPath(schOut, svgPath)}`,
        bytes: Module.FS.readFile(svgPath)
      });
    }
  }

  const result = {
    title: projectTitleFromPath(projectRoot),
    primaryRel,
    projectFiles,
    projectEntries: serializeEntries(projectEntries),
    artifacts: serializeEntries(artifacts)
  };

  self.postMessage(
    { type: "result", result },
    transferListFromEntries(result.projectEntries).concat(transferListFromEntries(result.artifacts))
  );
}

async function runRenderJob(payload) {
  const Module = await createModule();
  const root = "/work";
  const projectRoot = `${root}/project`;
  const boardRoot = `${root}/board`;
  const outRoot = `${root}/out`;

  removeTree(Module, root);
  mkdirp(Module, projectRoot);
  mkdirp(Module, boardRoot);
  mkdirp(Module, outRoot);
  const projectEntries = payload.projectEntries.map((entry) => ({
    path: entry.path,
    bytes: new Uint8Array(entry.bytes)
  }));
  const boardEntry = findEntryBySuffix(projectEntries, ".kicad_pcb");
  const hasPcb = !!boardEntry;
  const artifacts = [];

  if (boardEntry) {
    const pcbPath = `${boardRoot}/${boardEntry.path.split("/").pop()}`;
    mkdirp(Module, pcbPath.slice(0, pcbPath.lastIndexOf("/")));
    Module.FS.writeFile(pcbPath, boardEntry.bytes);

    const rulesEntry = findEntryBySuffix(
      projectEntries,
      `${boardEntry.path.replace(/\.kicad_pcb$/i, ".kicad_dru")}`
    );

    if (rulesEntry) {
      const rulesPath = `${boardRoot}/${rulesEntry.path.split("/").pop()}`;
      Module.FS.writeFile(rulesPath, rulesEntry.bytes);
    }

    const pcbTop = `${outRoot}/pcb-top.svg`;
    const pcbBottom = `${outRoot}/pcb-bottom.svg`;
    const drcPath = `${outRoot}/drc.json`;

    runCommand(
      Module,
      `pcb export svg --mode-single -l "F.Cu,F.Mask,F.Silkscreen,Edge.Cuts" ${quoteCliArg(pcbPath)} -o ${quoteCliArg(pcbTop)}`,
      `pcb export svg top ${boardEntry.path}`
    );
    runCommand(
      Module,
      `pcb export svg --mode-single -m -l "B.Cu,B.Mask,B.Silkscreen,Edge.Cuts" ${quoteCliArg(pcbPath)} -o ${quoteCliArg(pcbBottom)}`,
      `pcb export svg bottom ${boardEntry.path}`
    );
    runCommand(
      Module,
      `pcb drc ${quoteCliArg(pcbPath)} --format json -o ${quoteCliArg(drcPath)}`,
      `pcb drc ${boardEntry.path}`
    );

    artifacts.push({
      kind: "pcb-svg-top",
      path: "pcb-top.svg",
      bytes: Module.FS.readFile(pcbTop)
    });
    artifacts.push({
      kind: "pcb-svg-bottom",
      path: "pcb-bottom.svg",
      bytes: Module.FS.readFile(pcbBottom)
    });
    artifacts.push({
      kind: "drc-json",
      path: "drc.json",
      bytes: Module.FS.readFile(drcPath)
    });
  }

  const result = {
    artifacts: serializeEntries(artifacts.map((entry) => ({
      path: `${entry.kind}/${entry.path}`,
      bytes: entry.bytes
    }))),
    hasPcb
  };

  self.postMessage(
    { type: "result", result },
    transferListFromEntries(result.artifacts)
  );
}

self.onmessage = async (event) => {
  const { job, payload } = event.data || {};

  try {
    if (job === "import") {
      await runImportJob(payload);
    } else if (job === "render") {
      await runRenderJob(payload);
    } else {
      throw new Error(`Unknown worker job: ${job}`);
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      error: error?.stack || String(error)
    });
  }
};
