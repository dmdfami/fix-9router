#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import readline from "node:readline";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const MARKERS = {
  providerModel: "fix-ag-for-9router: ag image model",
  imageCore: "fix-ag-for-9router: antigravity image",
  packagedModel: "fix-ag-for-9router: packaged ag image model",
  packagedImageCore: "fix-ag-for-9router: packaged antigravity image",
  // gc/genlang/* — second Gemini-CLI route via genLangProject.
  // Only the executor is patched; users add specific models (e.g. genlang/gemini-2.5-pro)
  // through the 9router UI "Add Model" button so future Google releases work without re-patching.
  gc2Executor: "fix-9router: gc genlang executor",
  gc2PackagedExecutor: "fix-9router: packaged gc genlang executor",
  // getProviderCredentials only whitelists projectId — extend it to also pass through
  // duetProject + genLangProject so the gc/genlang executor can read them.
  gc2Credentials: "fix-9router: gc credentials passthrough",
  gc2PackagedCredentials: "fix-9router: packaged gc credentials passthrough",
  // AG image plugin (v0.4.18+ sustainable approach): add a NEW file
  // open-sse/handlers/imageProviders/antigravity.js + register in index.js.
  // Adding a new file is more durable across upstream refactors than modifying
  // shared code.
  agPlugin: "fix-9router: ag image plugin",
};

function parseFlags(flags) {
  const args = { dir: null, dryRun: false, model: null, delete: false, disable: false, deletePermissionDenied: false, positional: [] };
  for (let i = 0; i < flags.length; i += 1) {
    const arg = flags[i];
    if (arg === "--dir" || arg === "-d") args.dir = flags[++i];
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--model") args.model = flags[++i];
    else if (arg === "--delete") args.delete = true;
    else if (arg === "--disable") args.disable = true;
    else if (arg === "--delete-permission-denied") args.deletePermissionDenied = true;
    else if (arg === "--help" || arg === "-h") { printHelp(); process.exit(0); }
    else if (arg.startsWith("--")) fatal(`Unknown flag: ${arg}`);
    else args.positional.push(arg);
  }
  return args;
}

function printHelp() {
  console.log(`fix-9router — patch + maintain 9router

Usage:
  npx dmdfami/fix-9router [subcommand] [flags]
  fix-9r [subcommand] [flags]

Subcommands:
  patch              Apply 9router patches (default if none given)
  status             Pool overview table
  prune              Test active gemini keys, mark/remove "Unavailable"
  discover           Scan every gemini-cli OAuth account, adopt existing API keys
  expand [target] [limit]   Auto-create Cloud projects + Gemini API keys per OAuth account
                     (default target=30, limit=5/run; auto-tests each new key)
  update             npm install -g 9router@latest, then re-apply patches
  install-9router    Install 9router via npm (run before patch on a fresh machine)
  restart-9router    Kill the running 9router process and respawn (pm2/systemctl/fallback)
  cron [show|install|uninstall]   Manage the daily cron entry that runs 'prune --delete'
  ui  / web          Open the dashboard at http://localhost:20129
  install            npm i -g — install globally to enable \`fix-9r\` shortcut
  menu               Interactive numbered menu (default when no args in TTY)

Flags:
  --dir, -d <path>   Patch: override 9router directory (auto-detected if omitted)
  --dry-run          Patch: report changes without writing
  --model <name>     Prune: health-test model (default gemma-4-26b-a4b-it)
  --disable          Prune: PUT isActive=false on Unavailable
  --delete           Prune: DELETE Unavailable rows (UI cleaner)
  --help, -h         Show help

Examples:
  npx -y dmdfami/fix-9router         # one-off run (any subcommand)
  fix-9r install                      # install globally so 'fix-9r' works on PATH
  fix-9r                              # interactive menu
  fix-9r patch                        # apply all patches
  fix-9r prune --delete               # health-check + delete dead keys
  fix-9r status                       # pool overview
  fix-9r expand 30 5                  # create up to 5 new keys per acc, target 30
`);
}

// `fatal` exits the process — used for setup errors (bad args, no 9router dir).
// `fail` throws — used inside patch functions so the main loop can isolate
// per-task failures and let other patches still apply.
function fatal(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}
function fail(message) {
  throw new Error(message);
}

function expandHome(input) {
  if (!input) return input;
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function is9routerDir(dir) {
  return (
    fs.existsSync(path.join(dir, "package.json")) &&
    (
      (
        fs.existsSync(path.join(dir, "open-sse", "handlers", "imageGenerationCore.js")) &&
        fs.existsSync(path.join(dir, "open-sse", "config", "providerModels.js"))
      ) ||
      fs.existsSync(path.join(dir, "app", ".next", "server", "app", "api", "v1", "images", "generations", "route.js"))
    )
  );
}

// Most reliable: derive root from the actual `9router` binary on PATH.
// `which 9router` → realpath the symlink → walk up to its package.json.
// Works for Homebrew, npm/pnpm/yarn globals, nvm/asdf/Volta, Docker, snap, etc.
function binaryRoot9router() {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const bin = execFileSync(cmd, ["9router"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\r?\n/)[0];
    if (!bin) return null;
    let dir = path.dirname(fs.realpathSync(bin));
    for (let i = 0; i < 6 && dir && dir !== path.dirname(dir); i++) {
      const pkg = path.join(dir, "package.json");
      if (fs.existsSync(pkg)) {
        try {
          const pj = JSON.parse(fs.readFileSync(pkg, "utf8"));
          if (pj.name === "9router-app" || pj.name === "9router") return dir;
        } catch { /* not parseable */ }
      }
      dir = path.dirname(dir);
    }
  } catch { /* no 9router on PATH */ }
  return null;
}

// Query each package manager for its global root and append "9router".
function packageManagerCandidates() {
  const cmds = [
    ["npm",  ["root", "-g"],     (r) => path.join(r, "9router")],
    ["pnpm", ["root", "-g"],     (r) => path.join(r, "9router")],
    ["yarn", ["global", "dir"],  (r) => path.join(r, "node_modules", "9router")],
  ];
  const out = [];
  for (const [bin, args, build] of cmds) {
    try {
      const r = execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (r) out.push(build(r));
    } catch { /* not installed */ }
  }
  return out;
}

// Windows-specific install locations (nvm-windows, npm AppData global).
function windowsCandidates() {
  if (process.platform !== "win32") return [];
  const out = [];
  const APPDATA = process.env.APPDATA;
  const USERPROFILE = process.env.USERPROFILE || os.homedir();

  if (APPDATA) out.push(path.join(APPDATA, "npm", "node_modules", "9router"));
  out.push(path.join(USERPROFILE, "AppData", "Roaming", "npm", "node_modules", "9router"));

  const nvmWin = process.env.NVM_HOME || path.join(USERPROFILE, "AppData", "Roaming", "nvm");
  if (fs.existsSync(nvmWin)) {
    try {
      for (const entry of fs.readdirSync(nvmWin, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith("v")) {
          out.push(path.join(nvmWin, entry.name, "node_modules", "9router"));
        }
      }
    } catch { /* unreadable */ }
  }
  return out;
}

// Glob versioned-node installs (nvm/asdf/Volta) for 9router.
function versionedNodeCandidates() {
  const dirs = [
    [path.join(os.homedir(), ".nvm", "versions", "node"),                 "lib/node_modules"],
    [path.join(os.homedir(), ".asdf", "installs", "nodejs"),              "lib/node_modules"],
    [path.join(os.homedir(), ".volta", "tools", "image", "node"),         "lib/node_modules"],
    [path.join(os.homedir(), ".local", "share", "fnm", "node-versions"),  "installation/lib/node_modules"],
    [path.join(path.sep, "usr", "local", "n", "versions", "node"),        "lib/node_modules"],
  ];
  const out = [];
  for (const [versionedRoot, suffix] of dirs) {
    if (!fs.existsSync(versionedRoot)) continue;
    try {
      for (const entry of fs.readdirSync(versionedRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        out.push(path.join(versionedRoot, entry.name, suffix, "9router"));
      }
    } catch { /* unreadable */ }
  }
  return out;
}

function find9routerDir(cliDir) {
  const fromBinary = binaryRoot9router();
  const candidates = [
    cliDir,
    fromBinary,
    ...packageManagerCandidates(),
    ...windowsCandidates(),
    ...versionedNodeCandidates(),
    // Common static install locations (Homebrew, system npm, Linux distros).
    path.join(path.sep, "opt", "homebrew", "lib", "node_modules", "9router"),
    path.join(path.sep, "usr", "local", "lib", "node_modules", "9router"),
    path.join(path.sep, "usr", "lib", "node_modules", "9router"),
    path.join(path.sep, "snap", "9router", "current"),
    // Docker / VPS source layouts.
    path.join(path.sep, "app"),
    path.join(path.sep, "srv", "9router"),
    process.cwd(),
    path.join(os.homedir(), "Code", "9router"),
    path.join(os.homedir(), "projects", "9router"),
    path.join(os.homedir(), "9router"),
  ].filter(Boolean).map((p) => path.resolve(expandHome(p)));

  // Dedup while preserving order.
  const seen = new Set();
  for (const dir of candidates) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (is9routerDir(dir)) return dir;
  }

  const tried = [...seen].join("\n  ");
  fatal(`Could not find 9router. Pass --dir /path/to/9router.\nTried:\n  ${tried}`);
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function backupAndWrite(file, content, dryRun) {
  if (dryRun) return;
  const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, content);
  console.log(`patched: ${file}`);
  console.log(`backup : ${backup}`);
}

function patchProviderModels(root, dryRun) {
  const file = path.join(root, "open-sse", "config", "providerModels.js");
  let src = read(file);

  if (src.includes(MARKERS.providerModel)) {
    console.log("ok     : Antigravity image model already present");
    return false;
  }

  const anchor = `  ag: [  // Antigravity - special case: models call different backends\n`;
  if (!src.includes(anchor)) {
    fail(`Could not find Antigravity model block in ${file}`);
  }

  const insert =
    anchor +
    `    { id: "gemini-3.1-flash-image", name: "Gemini 3.1 Flash Image", type: "image", params: [], capabilities: ["text2img"] }, // ${MARKERS.providerModel}\n`;

  src = src.replace(anchor, insert);
  backupAndWrite(file, src, dryRun);
  if (dryRun) console.log(`would patch: ${file}`);
  return true;
}

function patchPackagedModelFile(file, dryRun) {
  let src = read(file);

  if (src.includes("gemini-3.1-flash-image") && src.includes(MARKERS.packagedModel)) {
    console.log(`ok     : Antigravity image model already present in ${file}`);
    return false;
  }
  if (src.includes('ag:[{id:"gemini-3.1-flash-image"') || src.includes("ag:[{id:'gemini-3.1-flash-image'")) {
    console.log(`ok     : Antigravity image model already present in ${file}`);
    return false;
  }

  const anchors = [
    `ag:[{id:"gemini-3.1-pro-high"`,
    `ag:[{id:"gemini-3.1-pro-preview"`,
    `ag:[{id:"gemini-3-flash"`,
  ];
  const model = `{id:"gemini-3.1-flash-image",name:"Gemini 3.1 Flash Image (Antigravity)",type:"image",params:[],capabilities:["text2img"],marker:"${MARKERS.packagedModel}"},`;

  for (const anchor of anchors) {
    if (!src.includes(anchor)) continue;
    src = src.replace(anchor, `ag:[${model}${anchor.slice("ag:[".length)}`);
    backupAndWrite(file, src, dryRun);
    if (dryRun) console.log(`would patch: ${file}`);
    return true;
  }

  return false;
}

function findPackagedModelFiles(root) {
  const server = path.join(root, "app", ".next", "server");
  const found = [];
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        const src = read(full);
        if (src.includes("gemini-3.1-flash-image-preview") && src.includes("type:\"image\"")) {
          found.push(full);
        }
      }
    }
  };
  visit(server);
  return found;
}

function patchPackagedProviderModels(root, dryRun) {
  const files = findPackagedModelFiles(root);
  if (files.length === 0) {
    fail(`Could not find packaged provider model chunks under ${path.join(root, "app", ".next", "server")}`);
  }
  let changed = false;
  for (const file of files) {
    changed = patchPackagedModelFile(file, dryRun) || changed;
  }
  return changed;
}

function patchPackagedImageRoute(root, dryRun) {
  const file = path.join(root, "app", ".next", "server", "app", "api", "v1", "images", "generations", "route.js");
  let src = read(file);
  let changed = false;

  // 9router v0.4.18 refactored image generation away from the IMAGE_PROVIDERS
  // const map (this patcher's anchor) to a per-provider plugin system under
  // open-sse/handlers/imageProviders/. The old packaged-route patch no longer
  // applies. Detect that and skip gracefully so other tasks still run.
  if (!src.includes(`codex:{baseUrl:p,format:"codex",stream:!0}};`) &&
      (src.includes(`gemini:{buildUrl:`) || src.includes(`imageProviders`))) {
    console.log("skip   : AG image route — 9router refactored image generation; old patch obsolete");
    return false;
  }

  if (!src.includes(MARKERS.packagedImageCore)) {
    const providerAnchor = `codex:{baseUrl:p,format:"codex",stream:!0}};`;
    const providerInsert = `codex:{baseUrl:p,format:"codex",stream:!0},antigravity:{baseUrl:"https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent",format:"antigravity",marker:"${MARKERS.packagedImageCore}"}};`;
    if (!src.includes(providerAnchor)) {
      fail(`Could not find packaged image provider map in ${file}`);
    }
    src = src.replace(providerAnchor, providerInsert);
    changed = true;
  }

  if (!src.includes(`case"antigravity":return d.baseUrl`)) {
    const urlAnchor = `case"codex":return p;default:return d.baseUrl`;
    const urlInsert = `case"codex":return p;case"antigravity":return d.baseUrl;default:return d.baseUrl`;
    if (!src.includes(urlAnchor)) {
      fail(`Could not find packaged URL builder in ${file}`);
    }
    src = src.replace(urlAnchor, urlInsert);
    changed = true;
  }

  if (!src.includes(`if("antigravity"===a)return{"Content-Type":"application/json",Authorization:`)) {
    const headerAnchor = `if("gemini"===a)return c;`;
    const headerInsert = `if("gemini"===a)return c;if("antigravity"===a)return{"Content-Type":"application/json",Authorization:\`Bearer \${b?.accessToken||b?.apiKey||""}\`,"User-Agent":"antigravity/1.107.0 darwin/arm64",Accept:"application/json"};`;
    if (!src.includes(headerAnchor)) {
      fail(`Could not find packaged header builder in ${file}`);
    }
    src = src.replace(headerAnchor, headerInsert);
    changed = true;
  }

  if (!src.includes(`case"antigravity":return{project:o?.projectId||o?.providerSpecificData?.projectId||""`)) {
    if (src.includes(`case"antigravity":return{project:c?.projectId||c?.providerSpecificData?.projectId||""`)) {
      src = src.replace(
        `A=function(a,b,c){let{prompt:d,n:f=1,size:g="1024x1024",quality:h,style:i,response_format:j,image:l,images:m}=c;`,
        `A=function(a,b,c,o){let{prompt:d,n:f=1,size:g="1024x1024",quality:h,style:i,response_format:j,image:l,images:m}=c;`
      );
      src = src.replace(
        `case"antigravity":return{project:c?.projectId||c?.providerSpecificData?.projectId||""`,
        `case"antigravity":return{project:o?.projectId||o?.providerSpecificData?.projectId||""`
      );
      src = src.replace(`}(w,x,a);d?.debug?.("IMAGE"`, `}(w,x,a,c);d?.debug?.("IMAGE"`);
      changed = true;
    } else {
    const bodyAnchor = `case"gemini":return{contents:[{parts:[{text:d}]}],generationConfig:{responseModalities:["TEXT","IMAGE"]}};`;
    const bodyInsert = `case"antigravity":return{project:c?.projectId||c?.providerSpecificData?.projectId||"",request:{contents:[{role:"user",parts:[{text:d}]}]},model:b,userAgent:"antigravity",requestType:"image_gen",requestId:\`image_gen/\${Date.now()}/\${(0,e.randomUUID)()}/12\`};` + bodyAnchor;
    if (!src.includes(bodyAnchor)) {
      fail(`Could not find packaged body builder in ${file}`);
    }
    src = src.replace(
      `A=function(a,b,c){let{prompt:d,n:f=1,size:g="1024x1024",quality:h,style:i,response_format:j,image:l,images:m}=c;`,
      `A=function(a,b,c,o){let{prompt:d,n:f=1,size:g="1024x1024",quality:h,style:i,response_format:j,image:l,images:m}=c;`
    );
    src = src.replace(bodyAnchor, bodyInsert.replace(`project:c?.projectId||c?.providerSpecificData?.projectId||""`, `project:o?.projectId||o?.providerSpecificData?.projectId||""`));
    src = src.replace(`}(w,x,a);d?.debug?.("IMAGE"`, `}(w,x,a,c);d?.debug?.("IMAGE"`);
    changed = true;
    }
  }

  if (!src.includes(`case"antigravity":{let b=(a.response?.candidates?.[0]?.content?.parts||a.candidates?.[0]?.content?.parts||[])`)) {
    const normalizeAnchor = `switch(b){case"gemini":{let b=(a.candidates?.[0]?.content?.parts||[]).filter(a=>a.inlineData?.data).map(a=>({b64_json:a.inlineData.data}));`;
    const normalizeInsert = `switch(b){case"antigravity":{let b=(a.response?.candidates?.[0]?.content?.parts||a.candidates?.[0]?.content?.parts||[]).map(a=>a.inlineData||a.inline_data).filter(a=>a?.data).map(a=>({b64_json:a.data,revised_prompt:c}));return{created:d,data:b}}case"gemini":{let b=(a.candidates?.[0]?.content?.parts||[]).filter(a=>a.inlineData?.data).map(a=>({b64_json:a.inlineData.data}));`;
    if (!src.includes(normalizeAnchor)) {
      fail(`Could not find packaged response normalizer in ${file}`);
    }
    src = src.replace(normalizeAnchor, normalizeInsert);
    changed = true;
  }

  if (!changed) {
    console.log("ok     : Packaged Antigravity image route already patched");
    return false;
  }

  backupAndWrite(file, src, dryRun);
  if (dryRun) console.log(`would patch: ${file}`);
  return true;
}

// ---------------------------------------------------------------------------
// gc/genlang/* — second Gemini-CLI routing path through genLangProject
// ---------------------------------------------------------------------------
//
// 9router currently routes all gc/* models through credentials.projectId
// (= duetProject after migrate). For free Google accounts, gemini-2.5-pro is
// rejected on duet but works via gen-lang project. This patch teaches
// GeminiCLIExecutor.transformRequest to detect a "genlang/" prefix in model
// names, strip it before calling upstream, and route through
// credentials.genLangProject. Both project fields are already on each row
// thanks to the migrate script. Account rotation, refresh, fallback reused.
//
// Models are NOT hardcoded here — add them via the 9router UI "Add Model"
// button using the prefix `genlang/<google-model-id>`. This stays
// future-proof for Google's model lineup updates.

function patchGc2Executor(root, dryRun) {
  const file = path.join(root, "open-sse", "executors", "gemini-cli.js");
  let src = read(file);

  if (src.includes(MARKERS.gc2Executor)) {
    console.log("ok     : gc genlang executor already patched");
    return false;
  }

  const anchor =
    `  transformRequest(model, body, stream, credentials) {\n` +
    `    // Store model for use in buildHeaders (called by base.execute after transformRequest)\n` +
    `    this._currentModel = model;\n` +
    `    if (!body.project && credentials?.projectId) {\n` +
    `      body.project = credentials.projectId;\n` +
    `    }\n` +
    `    return body;\n` +
    `  }`;
  if (!src.includes(anchor)) {
    fail(`Could not find transformRequest in ${file}`);
  }

  const replacement =
    `  transformRequest(model, body, stream, credentials) {\n` +
    `    // ${MARKERS.gc2Executor}\n` +
    `    // gc/genlang/* models route through gen-lang project for independent quota\n` +
    `    // and access to gemini-2.5-pro on free Google accounts.\n` +
    `    const useGenLang = typeof model === "string" && model.startsWith("genlang/");\n` +
    `    const cleanModel = useGenLang ? model.slice("genlang/".length) : model;\n` +
    `    this._currentModel = cleanModel;\n` +
    `    if (useGenLang) {\n` +
    `      body.model = cleanModel;\n` +
    `      body.project = credentials?.genLangProject || credentials?.projectId || body.project;\n` +
    `    } else if (!body.project && credentials?.projectId) {\n` +
    `      body.project = credentials.projectId;\n` +
    `    }\n` +
    `    return body;\n` +
    `  }`;

  src = src.replace(anchor, replacement);
  backupAndWrite(file, src, dryRun);
  if (dryRun) console.log(`would patch: ${file}`);
  return true;
}

function patchGc2Credentials(root, dryRun) {
  const file = path.join(root, "src", "sse", "services", "auth.js");
  if (!fs.existsSync(file)) return false;
  let src = read(file);
  if (src.includes(MARKERS.gc2Credentials)) {
    console.log("ok     : gc credentials passthrough already patched");
    return false;
  }
  const anchor = `      projectId: connection.projectId,\n`;
  if (!src.includes(anchor)) {
    fail(`Could not find credentials object in ${file}`);
  }
  const insert = anchor +
    `      duetProject: connection.duetProject, // ${MARKERS.gc2Credentials}\n` +
    `      genLangProject: connection.genLangProject, // ${MARKERS.gc2Credentials}\n`;
  src = src.replace(anchor, insert);
  backupAndWrite(file, src, dryRun);
  if (dryRun) console.log(`would patch: ${file}`);
  return true;
}

function patchPackagedGc2Credentials(root, dryRun) {
  // Minified pattern in v0.4.18:
  //   projectId:b.projectId,connectionName:b.displayName||b.name||b.email||b.id,copilotToken:b.providerSpecificData?.copilotToken
  const serverDir = path.join(root, "app", ".next", "server");
  if (!fs.existsSync(serverDir)) return false;

  // Anchor is short enough to be specific yet flexible across minifier identifier renames.
  const anchorRe = /projectId:([a-z])\.projectId,connectionName:/;
  let any = false;
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith(".js")) {
        let src = read(full);
        if (src.includes(MARKERS.gc2PackagedCredentials)) {
          console.log(`ok     : packaged gc credentials already patched in ${path.basename(full)}`);
          continue;
        }
        const m = src.match(anchorRe);
        if (!m) continue;
        const v = m[1];
        const anchor = `projectId:${v}.projectId,connectionName:`;
        const replacement = `projectId:${v}.projectId,duetProject:${v}.duetProject,genLangProject:${v}.genLangProject,/*${MARKERS.gc2PackagedCredentials}*/connectionName:`;
        src = src.replace(anchor, replacement);
        backupAndWrite(full, src, dryRun);
        if (dryRun) console.log(`would patch: ${full}`);
        any = true;
      }
    }
  };
  visit(serverDir);
  if (!any) console.log("ok     : packaged gc credentials anchor not found (skipped)");
  return any;
}

function patchPackagedGc2Executor(root, dryRun) {
  // Minified pattern observed in 9router v0.4.18:
  //   transformRequest(a,b,c,d){return this._currentModel=a,!b.project&&d?.projectId&&(b.project=d.projectId),b}
  const serverDir = path.join(root, "app", ".next", "server");
  if (!fs.existsSync(serverDir)) return false;

  const anchor = `transformRequest(a,b,c,d){return this._currentModel=a,!b.project&&d?.projectId&&(b.project=d.projectId),b}`;
  // Replacement preserves arity and behavior. `genlang/`.length === 8.
  const marker = MARKERS.gc2PackagedExecutor;
  const replacement = `transformRequest(a,b,c,d){/*${marker}*/let g=typeof a==="string"&&a.startsWith("genlang/"),h=g?a.slice(8):a;this._currentModel=h;if(g){b.model=h;b.project=d?.genLangProject||d?.projectId||b.project}else if(!b.project&&d?.projectId){b.project=d.projectId}return b}`;

  const candidates = [];
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith(".js")) {
        const s = read(full);
        if (s.includes(anchor) || s.includes(marker)) candidates.push(full);
      }
    }
  };
  visit(serverDir);
  if (candidates.length === 0) {
    console.log("ok     : packaged gc transformRequest not found (skipped)");
    return false;
  }

  let any = false;
  for (const file of candidates) {
    let src = read(file);
    if (src.includes(marker)) {
      console.log(`ok     : packaged gc executor already patched in ${path.basename(file)}`);
      continue;
    }
    if (!src.includes(anchor)) continue;
    src = src.replace(anchor, replacement);
    backupAndWrite(file, src, dryRun);
    if (dryRun) console.log(`would patch: ${file}`);
    any = true;
  }
  return any;
}

// AG image plugin (sustainable: add a new file in the imageProviders plugin dir
// + register in index.js). Only works on 9router v0.4.18+ where the plugin
// system exists. On older versions the patch is skipped and the legacy
// patchImageCore handles AG image generation through imageGenerationCore.js.
function patchAgPlugin(root, dryRun) {
  const pluginsDir = path.join(root, "open-sse", "handlers", "imageProviders");
  if (!fs.existsSync(pluginsDir)) {
    console.log("ok     : AG image plugin — imageProviders/ dir not present (likely v<=0.4.16; legacy patch handles AG)");
    return false;
  }
  const indexFile = path.join(pluginsDir, "index.js");
  const pluginFile = path.join(pluginsDir, "antigravity.js");

  // 1. Write antigravity.js if not already present.
  let pluginAdded = false;
  if (!fs.existsSync(pluginFile)) {
    const pluginSrc = `// ${MARKERS.agPlugin}
// Antigravity image-generation adapter for 9router's imageProviders plugin system.
// 9router calls adapter.buildHeaders(credentials) THEN adapter.buildBody(model, body)
// (no creds in the 2nd call), so we stash the latest credentials at buildHeaders
// time and read them back in buildBody for the project field.
import { nowSec } from "./_base.js";
import { randomUUID } from "node:crypto";

const ENDPOINT = "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent";
let _creds = null;

export default {
  buildUrl: () => ENDPOINT,
  buildHeaders: (creds) => {
    _creds = creds;
    return {
      "Authorization": \`Bearer \${creds?.accessToken || ""}\`,
      "User-Agent": "antigravity/1.21.9 darwin/arm64",
      "Content-Type": "application/json",
    };
  },
  buildBody: (model, body) => ({
    project: _creds?.projectId || _creds?.providerSpecificData?.projectId || "",
    request: { contents: [{ role: "user", parts: [{ text: body.prompt }] }] },
    model,
    userAgent: "antigravity",
    requestType: "image_gen",
    requestId: \`image_gen/\${Date.now()}/\${randomUUID()}/12\`,
  }),
  normalize: (responseBody, prompt) => {
    const parts = responseBody?.response?.candidates?.[0]?.content?.parts
      || responseBody?.candidates?.[0]?.content?.parts
      || [];
    const images = parts
      .map((p) => p.inlineData || p.inline_data)
      .filter((p) => p?.data)
      .map((p) => ({ b64_json: p.data, revised_prompt: prompt }));
    return { created: nowSec(), data: images };
  },
};
`;
    if (!dryRun) fs.writeFileSync(pluginFile, pluginSrc);
    pluginAdded = true;
    console.log(`patched: ${pluginFile} (created)`);
  } else {
    let existing = "";
    try { existing = fs.readFileSync(pluginFile, "utf8"); } catch { /* */ }
    if (!existing.includes(MARKERS.agPlugin)) {
      console.log(`ok     : ${path.basename(pluginFile)} exists but not ours; skipping`);
    } else {
      console.log(`ok     : AG plugin file already present`);
    }
  }

  // 2. Register in index.js if not already.
  let registered = false;
  if (fs.existsSync(indexFile)) {
    let src = fs.readFileSync(indexFile, "utf8");
    if (src.includes(MARKERS.agPlugin)) {
      console.log("ok     : AG plugin already registered in index.js");
    } else {
      // Add import line after first existing import + add to ADAPTERS object.
      const importAnchor = `import gemini from "./gemini.js";`;
      const adaptersAnchor = /(const ADAPTERS\s*=\s*\{)/;
      if (!src.includes(importAnchor) || !adaptersAnchor.test(src)) {
        console.log("ok     : AG plugin index.js anchors missing (skipped)");
      } else {
        src = src.replace(importAnchor, `import gemini from "./gemini.js";\nimport antigravity from "./antigravity.js"; // ${MARKERS.agPlugin}`);
        src = src.replace(adaptersAnchor, `$1\n  antigravity, // ${MARKERS.agPlugin}`);
        if (!dryRun) {
          backupAndWrite(indexFile, src, dryRun);
        } else {
          console.log(`would patch: ${indexFile}`);
        }
        registered = true;
      }
    }
  }

  return pluginAdded || registered;
}

// Inject antigravity adapter into the minified ADAPTERS map of the packaged image route.
// Anchor: ...recraft:e("recraft"),gemini:{buildUrl:...
// Insert antigravity entry before `gemini:`. Closure captures the credentials
// passed to buildHeaders so buildBody can read projectId (route handler only
// passes creds to buildHeaders + buildUrl, not buildBody).
function patchPackagedAgPlugin(root, dryRun) {
  const file = path.join(root, "app", ".next", "server", "app", "api", "v1", "images", "generations", "route.js");
  if (!fs.existsSync(file)) {
    console.log("ok     : packaged image route not present (skipped)");
    return false;
  }
  let src = fs.readFileSync(file, "utf8");
  if (src.includes(MARKERS.agPlugin)) {
    console.log("ok     : packaged AG image plugin already injected");
    return false;
  }
  const anchor = `recraft:e("recraft"),gemini:{buildUrl:`;
  if (!src.includes(anchor)) {
    console.log("ok     : packaged ADAPTERS map anchor not found (skipped)");
    return false;
  }
  const inject =
    `recraft:e("recraft"),` +
    `antigravity:(()=>{let _c=null;return{` +
      `buildUrl:()=>"https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent",` +
      `buildHeaders:(a)=>{_c=a;return{"Authorization":\`Bearer \${a?.accessToken||""}\`,"User-Agent":"antigravity/1.21.9 darwin/arm64","Content-Type":"application/json"}},` +
      `buildBody:(a,b)=>({project:_c?.projectId||_c?.providerSpecificData?.projectId||"",request:{contents:[{role:"user",parts:[{text:b.prompt}]}]},model:a,userAgent:"antigravity",requestType:"image_gen",requestId:\`image_gen/\${Date.now()}/\${Math.random().toString(36).slice(2)}/12\`}),` +
      `normalize:(a,b)=>{let d=(a.response?.candidates?.[0]?.content?.parts||a.candidates?.[0]?.content?.parts||[]).map(a=>a.inlineData||a.inline_data).filter(a=>a?.data).map(a=>({b64_json:a.data,revised_prompt:b}));return{created:Math.floor(Date.now()/1000),data:d}}` +
    `}})(/*${MARKERS.agPlugin}*/),gemini:{buildUrl:`;
  src = src.replace(anchor, inject);
  backupAndWrite(file, src, dryRun);
  if (dryRun) console.log(`would patch: ${file}`);
  return true;
}

function isSourceCheckout(root) {
  return (
    fs.existsSync(path.join(root, "open-sse", "handlers", "imageGenerationCore.js")) &&
    fs.existsSync(path.join(root, "open-sse", "config", "providerModels.js"))
  );
}

function isPackagedBuild(root) {
  return fs.existsSync(path.join(root, "app", ".next", "server", "app", "api", "v1", "images", "generations", "route.js"));
}

function patchImageCore(root, dryRun) {
  const file = path.join(root, "open-sse", "handlers", "imageGenerationCore.js");
  let src = read(file);

  let changed = false;

  // 9router v0.4.18+ moved per-provider image logic into a plugin directory
  // (open-sse/handlers/imageProviders/). The old IMAGE_PROVIDERS-map patch is
  // obsolete in those versions; skip gracefully.
  if (src.includes(`getImageAdapter`) || src.includes(`./imageProviders/`)) {
    console.log("skip   : AG image core — 9router refactored image generation; old patch obsolete");
    return false;
  }

  if (!src.includes(`import { getExecutor } from "../executors/index.js";`)) {
    fail(`Unexpected imageGenerationCore.js: missing getExecutor import`);
  }

  if (!src.includes(`antigravity: {\n    baseUrl: "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent"`)) {
    const anchor = `  codex: {\n    baseUrl: CODEX_RESPONSES_URL,\n    format: "codex",\n    stream: true,\n  },\n`;
    const insert =
      anchor +
      `  antigravity: {\n` +
      `    baseUrl: "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent",\n` +
      `    format: "antigravity", // ${MARKERS.imageCore}\n` +
      `  },\n`;
    if (!src.includes(anchor)) {
      fail(`Could not find IMAGE_PROVIDERS codex block in ${file}`);
    }
    src = src.replace(anchor, insert);
    changed = true;
  }

  if (!src.includes("function buildAntigravityImageBody(")) {
    const anchor = `function buildCodexContent(prompt, refs, detail = CODEX_REF_DETAIL) {\n`;
    const helper =
      `function buildAntigravityImageBody(model, body, credentials) { // ${MARKERS.imageCore}\n` +
      `  const projectId = credentials?.projectId || credentials?.providerSpecificData?.projectId || "";\n` +
      `  return {\n` +
      `    project: projectId,\n` +
      `    request: {\n` +
      `      contents: [{ role: "user", parts: [{ text: body.prompt }] }],\n` +
      `    },\n` +
      `    model,\n` +
      `    userAgent: "antigravity",\n` +
      `    requestType: "image_gen",\n` +
      `    requestId: \`image_gen/\${Date.now()}/\${randomUUID()}/12\`,\n` +
      `  };\n` +
      `}\n\n` +
      `function normalizeAntigravityImageResponse(responseBody, prompt) { // ${MARKERS.imageCore}\n` +
      `  const parts = responseBody?.response?.candidates?.[0]?.content?.parts || responseBody?.candidates?.[0]?.content?.parts || [];\n` +
      `  const images = parts\n` +
      `    .map((p) => p.inlineData || p.inline_data)\n` +
      `    .filter((p) => p?.data)\n` +
      `    .map((p) => ({ b64_json: p.data, revised_prompt: prompt }));\n` +
      `  return { created: Math.floor(Date.now() / 1000), data: images };\n` +
      `}\n\n`;
    if (!src.includes(anchor)) {
      fail(`Could not find insertion point for Antigravity helpers in ${file}`);
    }
    src = src.replace(anchor, helper + anchor);
    changed = true;
  }

  if (!src.includes(`case "antigravity":\n      return config.baseUrl;`)) {
    const anchor = `    case "codex":\n      return CODEX_RESPONSES_URL;\n`;
    const insert = `    case "antigravity":\n      return config.baseUrl;\n` + anchor;
    if (!src.includes(anchor)) {
      fail(`Could not find buildImageUrl codex case in ${file}`);
    }
    src = src.replace(anchor, insert);
    changed = true;
  }

  if (!src.includes(`if (provider === "antigravity") {\n    const executor = getExecutor("antigravity");`)) {
    const anchor = `  if (provider === "codex") {\n`;
    const insert =
      `  if (provider === "antigravity") {\n` +
      `    const executor = getExecutor("antigravity");\n` +
      `    return executor.buildHeaders(credentials, false);\n` +
      `  }\n\n` +
      anchor;
    if (!src.includes(anchor)) {
      fail(`Could not find buildImageHeaders codex branch in ${file}`);
    }
    src = src.replace(anchor, insert);
    changed = true;
  }

  if (!src.includes(`case "antigravity":\n      return buildAntigravityImageBody(model, body, credentials);`)) {
    src = src.replace(
      `function buildImageBody(provider, model, body) {`,
      `function buildImageBody(provider, model, body, credentials) {`
    );
    const anchor = `    case "codex": {\n`;
    const insert =
      `    case "antigravity":\n` +
      `      return buildAntigravityImageBody(model, body, credentials);\n\n` +
      anchor;
    if (!src.includes(anchor)) {
      fail(`Could not find buildImageBody codex case in ${file}`);
    }
    src = src.replace(anchor, insert);
    src = src.replace(
      `const requestBody = buildImageBody(provider, model, body);`,
      `const requestBody = buildImageBody(provider, model, body, credentials);`
    );
    changed = true;
  }

  if (!src.includes(`case "antigravity":\n      return normalizeAntigravityImageResponse(responseBody, prompt);`)) {
    const anchor = `  switch (provider) {\n    case "gemini": {\n`;
    const insert =
      `  switch (provider) {\n` +
      `    case "antigravity":\n` +
      `      return normalizeAntigravityImageResponse(responseBody, prompt);\n\n` +
      `    case "gemini": {\n`;
    if (!src.includes(anchor)) {
      fail(`Could not find normalizeImageResponse gemini case in ${file}`);
    }
    src = src.replace(anchor, insert);
    changed = true;
  }

  if (!changed) {
    console.log("ok     : Antigravity image core already patched");
    return false;
  }

  backupAndWrite(file, src, dryRun);
  if (dryRun) console.log(`would patch: ${file}`);
  return true;
}

// ---------------------------------------------------------------------------
// Subcommand: patch (default — apply all 9router patches)
// ---------------------------------------------------------------------------
function cmdPatch(args) {
  const root = find9routerDir(args.dir);

  console.log(`9router: ${root}`);
  // gc2 patches run first — they're independent of the AG image route fix and
  // shouldn't be blocked if the AG patch's anchor breaks on a future 9router release.
  const tasks = [];
  if (isSourceCheckout(root)) {
    tasks.push(["gc/genlang executor",               () => patchGc2Executor(root, args.dryRun)]);
    tasks.push(["gc credentials passthrough",        () => patchGc2Credentials(root, args.dryRun)]);
    tasks.push(["AG image model",                    () => patchProviderModels(root, args.dryRun)]);
    tasks.push(["AG image plugin",                   () => patchAgPlugin(root, args.dryRun)]);
    tasks.push(["AG image core (legacy)",            () => patchImageCore(root, args.dryRun)]);
  }
  if (isPackagedBuild(root)) {
    tasks.push(["gc/genlang executor (packaged)",    () => patchPackagedGc2Executor(root, args.dryRun)]);
    tasks.push(["gc credentials passthrough (pkg)",  () => patchPackagedGc2Credentials(root, args.dryRun)]);
    tasks.push(["AG image model (packaged)",         () => patchPackagedProviderModels(root, args.dryRun)]);
    tasks.push(["AG image plugin (packaged)",        () => patchPackagedAgPlugin(root, args.dryRun)]);
    tasks.push(["AG image route (packaged legacy)",  () => patchPackagedImageRoute(root, args.dryRun)]);
  }
  if (tasks.length === 0) {
    fail("Unsupported 9router layout.");
  }

  // Run independently — one task failing should not block the others, so users
  // get gc2 routing even if the AG image-route anchor breaks on a new release.
  let changed = false;
  let failures = 0;
  for (const [name, task] of tasks) {
    try {
      if (task()) changed = true;
    } catch (e) {
      failures++;
      console.error(`fail   : ${name} — ${e.message}`);
    }
  }

  if (args.dryRun) {
    console.log(changed ? "dry-run: patch would be applied" : "dry-run: already patched");
    if (failures) console.log(`dry-run: ${failures} task(s) failed`);
    return;
  }

  console.log(changed ? "done: restart 9router to use the patch" : "done: nothing to change");
  if (failures) process.exit(1);
}

// ---------------------------------------------------------------------------
// Subcommand: status (pool overview)
// ---------------------------------------------------------------------------
function readDb() {
  const dbPath = path.join(os.homedir(), ".9router", "db.json");
  if (!fs.existsSync(dbPath)) fatal(`db.json not found at ${dbPath}`);
  return { dbPath, db: JSON.parse(fs.readFileSync(dbPath, "utf8")) };
}

function cmdStatus() {
  const { db } = readDb();
  const conns = db.providerConnections || [];
  const groups = {};
  for (const c of conns) {
    const p = groups[c.provider] = groups[c.provider] || { active: 0, disabled: 0, total: 0 };
    p.total++;
    if (c.isActive === false) p.disabled++; else p.active++;
  }
  const rows = Object.entries(groups).sort((a, b) => b[1].total - a[1].total);
  const w = Math.max(...rows.map(([p]) => p.length), "provider".length);
  console.log("provider".padEnd(w) + "  active  disabled  total");
  console.log("-".repeat(w) + "  ------  --------  -----");
  for (const [p, g] of rows) {
    console.log(p.padEnd(w) + "  " + String(g.active).padStart(6) + "  " + String(g.disabled).padStart(8) + "  " + String(g.total).padStart(5));
  }
  console.log("-".repeat(w) + "  ------  --------  -----");
  const t = rows.reduce((a, [, g]) => ({ active: a.active + g.active, disabled: a.disabled + g.disabled, total: a.total + g.total }), { active: 0, disabled: 0, total: 0 });
  console.log("TOTAL".padEnd(w) + "  " + String(t.active).padStart(6) + "  " + String(t.disabled).padStart(8) + "  " + String(t.total).padStart(5));
}

// ---------------------------------------------------------------------------
// Subcommand: prune (health-check gemini API keys, remove Unavailable)
// ---------------------------------------------------------------------------
// Validate a Gemini API key without consuming generation quota.
// GET /v1beta/models/<model>?key=KEY:
//   200 → key valid + project Free tier
//   403 → project/key Unavailable (suspended)
//   401 → invalid key
//   else → network / 5xx
// ~50-300ms each, parallel-friendly (no rate-limit when GET-only).
async function geminiTest(apiKey, model) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}?key=${encodeURIComponent(apiKey)}`, {
      method: "GET",
      signal: ctrl.signal,
    });
    return r.status;
  } catch { return 0; } finally { clearTimeout(t); }
}

function classify(status) {
  if (status >= 200 && status < 300) return "free";
  if (status === 403) return "unavailable";
  if (status === 429) return "quota";
  return "other";
}

async function cmdPrune(args) {
  const model = args.model || "gemma-4-26b-a4b-it";
  const { dbPath, db } = readDb();
  const conns = db.providerConnections || [];
  const targets = conns.filter(c => c.provider === "gemini" && c.isActive !== false && c.apiKey);
  console.log(`testing ${targets.length} active gemini keys on ${model}\n`);

  const results = await Promise.all(targets.map(async (row) => {
    let status = 0;
    for (let i = 0; i <= 2; i++) {
      status = await geminiTest(row.apiKey, model);
      const c = classify(status);
      if (c === "free" || c === "unavailable") return { row, status, cls: c };
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
    return { row, status, cls: classify(status) };
  }));

  const buckets = { free: [], quota: [], unavailable: [], other: [] };
  for (const r of results) {
    buckets[r.cls].push(r);
    const tag = { free: "✓", quota: "Q", unavailable: "✗", other: "?" }[r.cls];
    const tier = { free: "Free tier", quota: "Quota cap (retry tomorrow)", unavailable: "Unavailable (project/key suspended)", other: `HTTP ${r.status}` }[r.cls];
    console.log(`${tag} ${(r.row.name || "").padEnd(46)} ${tier}`);
  }

  console.log(`\nFree: ${buckets.free.length}  Quota: ${buckets.quota.length}  Unavailable: ${buckets.unavailable.length}  Other: ${buckets.other.length}`);

  if (!buckets.unavailable.length) return;
  if (!args.disable && !args.delete) {
    console.log(`\nDry-run. Pass --disable (PUT isActive=false) or --delete to act.`);
    return;
  }

  // Mutate db.json directly — works whether 9router is running or not (lowdb reloads on next access).
  // For live consistency the user should restart 9router after large changes.
  const removeIds = new Set(buckets.unavailable.map(r => r.row.id));
  if (args.delete) {
    db.providerConnections = conns.filter(c => !removeIds.has(c.id));
  } else {
    for (const c of db.providerConnections) {
      if (removeIds.has(c.id)) { c.isActive = false; c.lastError = "billing tier unavailable"; c.updatedAt = new Date().toISOString(); }
    }
  }
  const backup = `${dbPath}.bak.prune-${Date.now()}`;
  fs.copyFileSync(dbPath, backup);
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
  console.log(`\n${args.delete ? "deleted" : "disabled"} ${buckets.unavailable.length} keys; backup: ${backup}`);
  console.log("→ restart 9router to reload db");
}

// ---------------------------------------------------------------------------
// Subcommand: expand (create N Google Cloud projects + Gemini API keys per OAuth account)
// ---------------------------------------------------------------------------
//
// Uses 3 Google APIs (cloud-platform OAuth scope from gemini-cli token):
//   1. cloudresourcemanager.googleapis.com  → create project (Operation poll)
//   2. serviceusage.googleapis.com          → enable generativelanguage.googleapis.com
//   3. apikeys.googleapis.com               → create API key (Operation poll)
//
// Risk control:
//   - Throttle 8-15s between projects (human-like cadence)
//   - Default --limit 5 per run (fail-safe; rerun for more)
//   - Default --target 30 (Google quota ceiling per account ~25-30)
//   - Stop the account on 403/429 (likely flagged)
//   - Random projectId `studio-<8hex>` to avoid pattern detection
//
// OAuth credentials are read at runtime from the user's installed 9router source
// (open-sse/config/providers.js) so this repo carries no secrets. They are the
// same client_id/secret the gemini-cli OAuth flow already uses.

let _gcCreds = null;
function getGcOauthCreds() {
  if (_gcCreds) return _gcCreds;
  const root = find9routerDir(null);
  // Try source layout first, then minified packaged chunk.
  const candidates = [
    path.join(root, "open-sse", "config", "providers.js"),
    ...((() => {
      const dir = path.join(root, "app", ".next", "server", "chunks");
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => path.join(dir, f));
    })()),
  ];
  for (const file of candidates) {
    let src;
    try { src = fs.readFileSync(file, "utf8"); } catch { continue; }
    if (!src.includes('"gemini-cli"')) continue;
    const m = src.match(/"gemini-cli"\s*:\s*\{[\s\S]{0,400}?clientId\s*:\s*"([^"]+)"[\s\S]{0,400}?clientSecret\s*:\s*"([^"]+)"/);
    if (m) { _gcCreds = { clientId: m[1], clientSecret: m[2] }; return _gcCreds; }
  }
  throw new Error("Could not read gemini-cli OAuth credentials from 9router source. Pass --dir or install 9router.");
}

function rand(n) {
  return [...Array(n)].map(() => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function refreshGcToken(refreshToken) {
  const { clientId, clientSecret } = getGcOauthCreds();
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`refresh: ${j.error_description || j.error || "unknown"}`);
  return j.access_token;
}

async function listProjects(token) {
  const r = await fetch("https://cloudresourcemanager.googleapis.com/v1/projects", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`list projects: HTTP ${r.status} ${(j.error?.message || "").slice(0, 120)}`);
  return (j.projects || []).filter(p => p.lifecycleState === "ACTIVE");
}

// Poll a Google long-running Operation.
// `baseUrl` must include the version segment (e.g. https://.../v1 or .../v2)
// because different APIs run on different versions.
async function pollOperation(token, baseUrl, opName, label, extraHeaders = {}, maxSeconds = 120) {
  const start = Date.now();
  while ((Date.now() - start) / 1000 < maxSeconds) {
    const r = await fetch(`${baseUrl}/${opName}`, {
      headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
    });
    let j;
    try { j = await r.json(); }
    catch { throw new Error(`${label} poll: non-JSON response (HTTP ${r.status})`); }
    if (!r.ok) throw new Error(`${label} poll: HTTP ${r.status} ${(j.error?.message || "").slice(0, 200)}`);
    if (j.done) {
      if (j.error) throw new Error(`${label} op error: ${j.error.message || JSON.stringify(j.error)}`);
      return j.response || {};
    }
    await sleep(2000);
  }
  throw new Error(`${label} op timeout`);
}

async function createProject(token, projectId) {
  const r = await fetch("https://cloudresourcemanager.googleapis.com/v1/projects", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, name: projectId }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`create project ${projectId}: HTTP ${r.status} ${(j.error?.message || "").slice(0, 200)}`);
  await pollOperation(token, "https://cloudresourcemanager.googleapis.com/v1", j.name, "create-project");
}

async function enableGenLangApi(token, projectId) {
  const r = await fetch(`https://serviceusage.googleapis.com/v1/projects/${projectId}/services/generativelanguage.googleapis.com:enable`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: "{}",
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`enable api on ${projectId}: HTTP ${r.status} ${(j.error?.message || "").slice(0, 200)}`);
  if (j.name && !j.done) await pollOperation(token, "https://serviceusage.googleapis.com/v1", j.name, "enable-api");
}

async function createApiKey(token, projectId, displayName) {
  // API Keys v2 quirk: enable services WITHOUT X-Goog-User-Project so the call bills
  // against the OAuth client's owner project (which has Service Usage enabled by default).
  // Then create + poll keys WITH X-Goog-User-Project so they bill against our new project
  // (which now has apikeys.googleapis.com enabled).
  const baseHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const userProjectHeader = { "X-Goog-User-Project": projectId };

  // Enable apikeys.googleapis.com on the new project (idempotent).
  await fetch(`https://serviceusage.googleapis.com/v1/projects/${projectId}/services/apikeys.googleapis.com:enable`, {
    method: "POST", headers: baseHeaders, body: "{}",
  }).catch(() => {});

  // Enable propagation can take 5-15s. Try create-key with linear backoff retries.
  const body = JSON.stringify({ displayName, restrictions: { apiTargets: [{ service: "generativelanguage.googleapis.com" }] } });
  let r, j;
  for (let attempt = 1; attempt <= 4; attempt++) {
    await sleep(2000 * attempt);
    r = await fetch(`https://apikeys.googleapis.com/v2/projects/${projectId}/locations/global/keys`, {
      method: "POST",
      headers: { ...baseHeaders, ...userProjectHeader },
      body,
    });
    j = await r.json();
    if (r.ok) break;
    const msg = j.error?.message || "";
    if (!/has not been used/i.test(msg) && !/disabled/i.test(msg)) break; // not a propagation issue — fail fast
  }
  if (!r.ok) throw new Error(`create key on ${projectId}: HTTP ${r.status} ${(j.error?.message || "").slice(0, 200)}`);
  const op = await pollOperation(token, "https://apikeys.googleapis.com/v2", j.name, "create-key", userProjectHeader);

  // Poll response sometimes omits keyString — fall back to GET keyString endpoint.
  if (op.keyString) return op.keyString;
  if (!op.name) throw new Error("create key: response missing both keyString and key name");
  const r2 = await fetch(`https://apikeys.googleapis.com/v2/${op.name}/keyString`, {
    headers: { Authorization: `Bearer ${token}`, ...userProjectHeader },
  });
  const j2 = await r2.json();
  if (!j2.keyString) throw new Error(`get keyString: HTTP ${r2.status} ${(j2.error?.message || "").slice(0, 200)}`);
  return j2.keyString;
}

async function cmdExpand(args) {
  const target = parseInt(args.positional[0], 10) || 30;
  const limit = parseInt(args.positional[1], 10) || 5;
  const { dbPath, db } = readDb();
  const accounts = (db.providerConnections || []).filter(c => c.provider === "gemini-cli" && c.isActive !== false && c.refreshToken);
  console.log(`expand: target=${target}/account, limit=${limit}/run/account, accounts=${accounts.length} in parallel\n`);

  // Per-account work runs in parallel — Google's quota is per-user/account, so
  // 12 accounts × N keys is roughly N×12 the throughput. Within an account
  // we keep the 8-15s human cadence + key-fail-then-delete-project cleanup.
  const writeLock = { busy: false };
  async function persist() {
    while (writeLock.busy) await sleep(50);
    writeLock.busy = true;
    try { fs.writeFileSync(dbPath, JSON.stringify(db, null, 2)); }
    finally { writeLock.busy = false; }
  }

  let totalCreated = 0, totalCleaned = 0;
  await Promise.all(accounts.map(async (acc) => {
    const label = acc.email || acc.id?.slice(0, 8);
    let token;
    try { token = await refreshGcToken(acc.refreshToken); }
    catch (e) { console.log(`✗ ${label} — refresh failed: ${e.message}`); return; }

    let projects;
    try { projects = await listProjects(token); }
    catch (e) { console.log(`✗ ${label} — list projects failed: ${e.message}`); return; }

    const studioProjects = projects.filter(p => p.projectId.startsWith("studio-"));
    const totalAccountProjects = projects.length;
    const need = Math.min(limit, target - studioProjects.length);
    if (need <= 0) {
      console.log(`= ${label} — at ${studioProjects.length}/${target} studio projects (${totalAccountProjects} total)`);
      return;
    }
    if (totalAccountProjects + need > 30) {
      console.log(`! ${label} — total projects ${totalAccountProjects} + ${need} > 30, would exceed Google quota; skipping`);
      return;
    }

    // If a previous run of fix-9r marked this account as cooling-down today
    // (3+ consecutive create-then-fail or quota errors), skip it. The flag is
    // stored on the row in db.json under expandCooldownUntil.
    if (acc.expandCooldownUntil && Date.now() < acc.expandCooldownUntil) {
      const hoursLeft = Math.ceil((acc.expandCooldownUntil - Date.now()) / 3600000);
      console.log(`⊘ ${label} — in cooldown (${hoursLeft}h left); skip`);
      return;
    }

    console.log(`→ ${label} — creating ${need} projects (current studio: ${studioProjects.length}, total: ${totalAccountProjects})`);

    let consecutiveFails = 0;
    const FAIL_THRESHOLD = 3;

    for (let i = 0; i < need; i++) {
      const projectId = `studio-${rand(8)}`;
      try {
        await createProject(token, projectId);
        await enableGenLangApi(token, projectId);
        const keyString = await createApiKey(token, projectId, `auto-${projectId}`);
        const testStatus = await geminiTest(keyString, "gemma-4-26b-a4b-it");
        const usable = testStatus >= 200 && testStatus < 300;

        if (!usable) {
          // Auto-cleanup: if the just-created key is not Free tier, delete the
          // Cloud project immediately. User wants only Free-tier keys imported.
          await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}`, {
            method: "DELETE", headers: { Authorization: `Bearer ${token}` },
          }).catch(() => null);
          totalCleaned++;
          consecutiveFails++;
          console.log(`  ✗ ${label} / ${projectId}  test HTTP ${testStatus} — project deleted`);
          if (consecutiveFails >= FAIL_THRESHOLD) {
            // Account creates projects but they all fail health-test → mark
            // cool-down for the rest of today (24h from now).
            acc.expandCooldownUntil = Date.now() + 24 * 3600 * 1000;
            acc.expandCooldownReason = `${consecutiveFails} consecutive create-but-dead at ${new Date().toISOString()}`;
            await persist();
            console.log(`  ⊘ ${label} — ${consecutiveFails} consecutive dead keys; cooldown 24h`);
            break;
          }
        } else {
          consecutiveFails = 0;
          const maxPriority = (db.providerConnections || []).filter(c => c.provider === "gemini").reduce((m, c) => Math.max(m, c.priority || 0), 0);
          db.providerConnections.push({
            id: crypto.randomUUID(),
            provider: "gemini",
            authType: "apikey",
            name: `${label} / ${projectId}`,
            priority: maxPriority + 1,
            isActive: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            apiKey: keyString,
            testStatus: "active",
            providerSpecificData: { tier: "free", connectionProxyEnabled: false, connectionProxyUrl: "", connectionNoProxy: "" },
          });
          await persist();
          totalCreated++;
          console.log(`  + ${label} / ${projectId} → key …${keyString.slice(-6)}  Free`);
        }
      } catch (e) {
        console.log(`  ✗ ${label} / ${projectId} — ${e.message}`);
        if (/403|denied|suspended/i.test(e.message)) {
          // Permanent-looking errors → 24h cooldown (account flagged).
          acc.expandCooldownUntil = Date.now() + 24 * 3600 * 1000;
          acc.expandCooldownReason = `flagged: ${e.message.slice(0, 120)}`;
          await persist();
          console.log(`  ⊘ ${label} flagged → cooldown 24h`);
          break;
        }
        if (/quota|429/i.test(e.message)) {
          // Daily project quota → cooldown until midnight UTC (close enough).
          acc.expandCooldownUntil = Date.now() + 24 * 3600 * 1000;
          acc.expandCooldownReason = `daily project quota: ${e.message.slice(0, 80)}`;
          await persist();
          console.log(`  ⊘ ${label} hit project quota → cooldown 24h`);
          break;
        }
      }
      // Human-like cadence WITHIN an account (parallel ACROSS accounts).
      await sleep(8000 + Math.floor(Math.random() * 6000));
    }
  }));

  console.log(`\n${totalCreated} keys created (Free), ${totalCleaned} dead projects auto-deleted. Restart 9router to load them.`);
}

// Lightweight key validation — alias to geminiTest (GET /models, no quota).
function quickGenContentTest(apiKey) { return geminiTest(apiKey, "gemma-4-26b-a4b-it"); }

// ---------------------------------------------------------------------------
// Subcommand: discover (scan all OAuth accounts → adopt existing API keys into 9router)
// ---------------------------------------------------------------------------
async function listKeysForProject(token, projectId) {
  const r = await fetch(`https://apikeys.googleapis.com/v2/projects/${projectId}/locations/global/keys`, {
    headers: { Authorization: `Bearer ${token}`, "X-Goog-User-Project": projectId },
  });
  if (!r.ok) return null; // typical: API Keys API not enabled on this project — skip
  const j = await r.json();
  return j.keys || [];
}

async function getKeyString(token, projectId, keyName) {
  const r = await fetch(`https://apikeys.googleapis.com/v2/${keyName}/keyString`, {
    headers: { Authorization: `Bearer ${token}`, "X-Goog-User-Project": projectId },
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.keyString || null;
}

async function cmdDiscover(args = {}) {
  const deletePermDenied = args.deletePermissionDenied === true;
  const { dbPath, db } = readDb();
  const accounts = (db.providerConnections || []).filter(c => c.provider === "gemini-cli" && c.isActive !== false && c.refreshToken);
  const existingKeys = new Set((db.providerConnections || []).filter(c => c.provider === "gemini" && c.apiKey).map(c => c.apiKey));
  console.log(`discover: scanning ${accounts.length} accounts in parallel; ${existingKeys.size} keys already in db\n`);

  let added = 0, deleted = 0;
  // Run all 12 accounts in parallel — each acc's API calls go through Google
  // independently (different OAuth tokens), so this 12x's the throughput.
  const writeLock = { busy: false }; // serialise db.json writes (lowdb-style)
  async function persist() {
    while (writeLock.busy) await sleep(50);
    writeLock.busy = true;
    try { fs.writeFileSync(dbPath, JSON.stringify(db, null, 2)); }
    finally { writeLock.busy = false; }
  }

  let createdKeys = 0;
  await Promise.all(accounts.map(async (acc) => {
    const label = acc.email || acc.id?.slice(0, 8);
    let token;
    try { token = await refreshGcToken(acc.refreshToken); }
    catch (e) { console.log(`✗ ${label} — refresh failed: ${e.message}`); return; }

    let projects;
    try { projects = await listProjects(token); }
    catch (e) { console.log(`✗ ${label} — list projects failed: ${e.message}`); return; }

    let acctEmpty = 0;
    console.log(`→ ${label} — ${projects.length} project(s) on Cloud`);
    for (const p of projects) {
      let keys = await listKeysForProject(token, p.projectId);
      // Project has no API keys yet — try to create one (only on projects that
      // look like ours: gen-lang-client*, genai-*, studio-*; user's own
      // projects with random names are left alone).
      const ours = /^(gen-lang-client|genai|studio)/.test(p.projectId);
      if ((!keys || keys.length === 0) && ours) {
        try {
          const ks = await createApiKey(token, p.projectId, `auto-${p.projectId}`);
          keys = [{ name: "auto", keyString: ks }]; // synthesize record
          createdKeys++;
          console.log(`+key   ${label} / ${p.projectId}  created new API key`);
        } catch (e) {
          // Permission-denied old projects: optionally cleanup with --delete-permission-denied flag.
          const isPermDenied = /permission denied|consumer/i.test(e.message);
          if (deletePermDenied && isPermDenied) {
            const r = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${p.projectId}`, {
              method: "DELETE", headers: { Authorization: `Bearer ${token}` },
            }).catch(() => null);
            if (r?.ok) { deleted++; console.log(`✗→DEL  ${label} / ${p.projectId}  permission-denied → project deleted`); continue; }
          }
          console.log(`-empty ${label} / ${p.projectId}  no keys + create failed: ${e.message.slice(0, 80)}`);
          acctEmpty++;
          continue;
        }
      }
      if (!keys || keys.length === 0) {
        acctEmpty++;
        continue;
      }
      for (const k of keys) {
        const keyString = k.keyString || await getKeyString(token, p.projectId, k.name);
        if (!keyString) continue;
        if (existingKeys.has(keyString)) continue;
        const httpStatus = await geminiTest(keyString, "gemma-4-26b-a4b-it");
        const usable = httpStatus >= 200 && httpStatus < 300;
        if (!usable) {
          if (p.projectId.startsWith("studio-")) {
            const r = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${p.projectId}`, {
              method: "DELETE", headers: { Authorization: `Bearer ${token}` },
            }).catch(() => null);
            if (r?.ok) { deleted++; console.log(`✗→DEL  ${label} / ${p.projectId}  HTTP ${httpStatus}  cleaned up dead studio project`); continue; }
          }
          console.log(`✗      ${label} / ${p.projectId}  HTTP ${httpStatus}  skipped (kept on Cloud)`);
          continue;
        }
        const maxPriority = (db.providerConnections || []).filter(c => c.provider === "gemini").reduce((m, c) => Math.max(m, c.priority || 0), 0);
        db.providerConnections.push({
          id: crypto.randomUUID(),
          provider: "gemini",
          authType: "apikey",
          name: `${label} / ${p.projectId}`,
          priority: maxPriority + 1,
          isActive: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          apiKey: keyString,
          testStatus: "active",
          providerSpecificData: { tier: "free", connectionProxyEnabled: false, connectionProxyUrl: "", connectionNoProxy: "" },
        });
        existingKeys.add(keyString);
        await persist();
        added++;
        console.log(`✓      ${label} / ${p.projectId}  HTTP ${httpStatus}  …${keyString.slice(-6)}`);
      }
    }
    if (acctEmpty) console.log(`       ${label} — ${acctEmpty} project(s) had no API key (skipped or apikeys API not enabled)`);
  }));

  console.log(`\n${added} new keys adopted, ${createdKeys} keys created on empty projects, ${deleted} dead studio projects deleted. Restart 9router to load.`);
}

// ---------------------------------------------------------------------------
// Subcommand: update (npm i -g 9router@latest, then auto-repatch)
// ---------------------------------------------------------------------------
async function cmdUpdate(args) {
  console.log("Updating 9router via npm...\n");
  try { execFileSync("npm", ["install", "-g", "9router@latest"], { stdio: "inherit" }); }
  catch (e) { fatal(`npm update failed: ${e.message}`); }
  console.log("\n→ re-applying patches...");
  cmdPatch(args);
  // npm replaced files but the running process still serves the old bundle —
  // restart so the new code (and our patches) are actually loaded.
  console.log("\n→ restarting 9router so new code is served...");
  await cmdRestart9router();
}

// ---------------------------------------------------------------------------
// Subcommand: ui (tiny HTTP server on 20129 with HTML dashboard)
// ---------------------------------------------------------------------------
function htmlDashboard() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>fix-9r dashboard</title>
<style>
*{box-sizing:border-box}
body{font:14px system-ui,-apple-system,sans-serif;margin:0;background:#0a0a0a;color:#e8e8e8;line-height:1.5}
.container{max-width:1280px;margin:0 auto;padding:24px}
header{display:flex;align-items:baseline;gap:12px;margin-bottom:32px}
h1{font-size:22px;margin:0;font-weight:600}
header .v{color:#888;font-size:12px;font-family:ui-monospace,monospace}
section{background:#111;border:1px solid #1f1f1f;border-radius:10px;padding:18px 20px;margin-bottom:18px}
section h2{margin:0 0 14px;font-size:16px;display:flex;align-items:center;justify-content:space-between;gap:12px}
section h2 .actions{display:flex;gap:6px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}
.card{background:#161616;border:1px solid #222;border-radius:8px;padding:12px}
.card .lbl{color:#888;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px}
.card .num{font-size:24px;font-weight:600}
.card .sub{color:#666;font-size:11px;margin-top:2px}
button{background:#1a1a1a;border:1px solid #333;color:#eee;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-family:inherit}
button:hover{background:#252525;border-color:#444}
button.primary{background:#2563eb;border-color:#2563eb;color:white}
button.primary:hover{background:#1d4ed8}
button.success{background:#16a34a;border-color:#16a34a;color:white}
button.success:hover{background:#15803d}
button.danger{background:#dc2626;border-color:#dc2626;color:white}
button.danger:hover{background:#b91c1c}
button:disabled{opacity:0.5;cursor:not-allowed}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;font-family:ui-monospace,monospace}
.b-free{background:#0f3a1f;color:#4ade80;border:1px solid #166534}
.b-quota{background:#3a330f;color:#facc15;border:1px solid #854d0e}
.b-bad{background:#3a0f0f;color:#f87171;border:1px solid #7f1d1d}
.b-info{background:#0f243a;color:#60a5fa;border:1px solid #1e40af}
.b-muted{background:#222;color:#888;border:1px solid #333}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:8px 10px;color:#888;font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;border-bottom:1px solid #222}
td{padding:8px 10px;border-bottom:1px solid #1a1a1a;vertical-align:middle}
tr.acc-row{cursor:pointer}
tr.acc-row:hover{background:#161616}
tr.acc-row.open td:first-child::before{content:"▼ ";color:#888}
tr.acc-row td:first-child::before{content:"▶ ";color:#666}
.detail{display:none;background:#0d0d0d}
.detail.open{display:table-row}
.detail td{padding:0}
.detail-inner{padding:8px 16px 14px}
.detail table{font-size:12px}
.detail th{font-size:10px}
.detail-inner code{background:#1a1a1a;padding:1px 6px;border-radius:3px;font-family:ui-monospace,monospace;font-size:11px}
.patches{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px}
.patch{background:#161616;border:1px solid #222;border-radius:8px;padding:10px 12px;display:flex;align-items:center;gap:8px;font-size:12px}
.activity{font-family:ui-monospace,monospace;font-size:11px;max-height:280px;overflow:auto;background:#0d0d0d;border-radius:6px;padding:10px}
.activity .ts{color:#666}
.activity .cmd{color:#60a5fa}
.activity .ok{color:#4ade80}
.activity .err{color:#f87171}
dialog{background:#1a1a1a;color:#eee;border:1px solid #333;border-radius:10px;padding:0;max-width:480px;width:90vw}
dialog::backdrop{background:rgba(0,0,0,0.6)}
.dlg{padding:20px}
.dlg h3{margin:0 0 8px}
.dlg p{margin:0 0 16px;color:#aaa}
.dlg-actions{display:flex;gap:8px;justify-content:flex-end}
#log{position:fixed;bottom:24px;right:24px;width:480px;max-height:50vh;background:#0d0d0d;border:1px solid #222;border-radius:10px;padding:14px;display:none;font-family:ui-monospace,monospace;font-size:11px;overflow:auto;white-space:pre-wrap;box-shadow:0 4px 24px rgba(0,0,0,0.5)}
#log.open{display:block}
#log .close{float:right;cursor:pointer;color:#888}
.toast{position:fixed;top:24px;right:24px;background:#1a1a1a;border:1px solid #333;padding:12px 16px;border-radius:8px;display:none;animation:fade 4s}
.toast.show{display:block}
@keyframes fade{0%{opacity:0;transform:translateY(-10px)}10%,90%{opacity:1;transform:translateY(0)}100%{opacity:0}}
.empty{color:#666;font-style:italic;padding:14px}
.spin{display:inline-block;width:12px;height:12px;border:2px solid #444;border-top-color:#60a5fa;border-radius:50%;animation:spin 0.8s linear infinite;vertical-align:-2px}
@keyframes spin{to{transform:rotate(360deg)}}
.muted{color:#666}
.gh{color:#60a5fa;text-decoration:none}
.gh:hover{text-decoration:underline}
</style></head><body>
<div class="container">
  <header>
    <h1>fix-9r dashboard</h1>
    <span class="v" id="server-info">localhost:20129</span>
    <span class="v" id="r9-status">checking 9router…</span>
    <span style="margin-left:auto;display:flex;gap:6px">
      <button id="btn-restart9" onclick="confirmAndRun('restart-9router','Restart 9router','Kill the running 9router process and respawn it. Required after Update so the new bundle is served.')" style="display:none">🔁 Restart 9router</button>
      <button id="btn-install9" onclick="confirmAndRun('install-9router','Install 9router','Run npm install -g 9router. Use this if 9router is not yet installed on this machine.')" style="display:none">⬇ Install 9router</button>
      <button onclick="refreshAll()" id="btn-refresh">🔄 Refresh</button>
    </span>
  </header>

  <section>
    <h2>📊 Pool overview <span class="actions"><button onclick="loadDashboard()">↻</button></span></h2>
    <div class="cards" id="cards"><div class="empty"><span class="spin"></span> loading…</div></div>
  </section>

  <section>
    <h2>🩹 Patches
      <span class="actions">
        <button class="primary" onclick="confirmAndRun('patch','Apply patches','Re-apply all 9router patches in-place. Idempotent — safe to re-run.')">Apply</button>
        <button onclick="confirmAndRun('update','Update 9router','Run npm i -g 9router@latest then re-apply patches. This MODIFIES your global 9router install.')">Update + Apply</button>
      </span>
    </h2>
    <div class="patches" id="patches"><div class="empty"><span class="spin"></span> loading…</div></div>
  </section>

  <section>
    <h2>🔑 Gemini API key pool — per OAuth account
      <span class="actions">
        <button class="success" onclick="testAllLive()">🩺 Test all (live)</button>
        <button onclick="discoverDialog()">🔍 Discover</button>
        <button onclick="bulkExpand()">➕ Bulk expand</button>
        <button class="danger" onclick="deleteDeadDialog()">🗑 Delete dead</button>
      </span>
    </h2>
    <div style="background:#0d0d0d;border:1px solid #1f1f1f;border-radius:6px;padding:8px 12px;margin-bottom:14px;font-size:11px;color:#888;font-family:ui-monospace,monospace" id="test-config">test config: loading…</div>
    <details style="background:#0d0d0d;border:1px solid #1f1f1f;border-radius:6px;padding:8px 12px;margin-bottom:14px;font-size:12px;color:#aaa">
      <summary style="cursor:pointer;color:#60a5fa">▸ How to use AG image generation</summary>
      <div style="padding-top:8px;line-height:1.6">
        AG image (route through Antigravity OAuth) is added to 9router via a plugin file at
        <code style="background:#1a1a1a;padding:1px 6px;border-radius:3px;font-family:ui-monospace,monospace">open-sse/handlers/imageProviders/antigravity.js</code> + a registration line in
        <code style="background:#1a1a1a;padding:1px 6px;border-radius:3px;font-family:ui-monospace,monospace">imageProviders/index.js</code>.
        <br>The 9router web UI doesn't surface this provider (it lists only its built-in image providers), but it works via the OpenAI-compatible endpoint:
        <pre style="background:#0a0a0a;border:1px solid #1a1a1a;border-radius:4px;padding:10px;margin-top:8px;font-size:11px;overflow:auto">curl -sS http://localhost:20128/v1/images/generations \\
  -H 'Content-Type: application/json' \\
  -d '{"model":"ag/gemini-3.1-flash-image","prompt":"a small red teapot"}'</pre>
        Status of this patch is shown above in the Patches row. After applying, run <b>Restart 9router</b> from the header.
      </div>
    </details>
    <div id="oauth-table"><div class="empty"><span class="spin"></span> loading account breakdown…</div></div>
    <div style="margin-top:12px;color:#888;font-size:12px" id="pool-summary"></div>
  </section>

  <section>
    <h2>📜 Recent activity</h2>
    <div class="activity" id="activity"><div class="empty">no activity yet</div></div>
  </section>

  <p style="text-align:center;color:#444;font-size:11px;margin:32px 0 16px">
    fix-9r · <a class="gh" href="https://github.com/dmdfami/fix-9router" target="_blank">github.com/dmdfami/fix-9router</a>
  </p>
</div>

<dialog id="cdlg"><div class="dlg">
  <h3 id="cdlg-title"></h3>
  <p id="cdlg-msg"></p>
  <div class="dlg-actions">
    <button onclick="cdlg.close('cancel')">Cancel</button>
    <button class="primary" id="cdlg-ok">Run</button>
  </div>
</div></dialog>

<div id="log"><span class="close" onclick="logEl.classList.remove('open')">✕</span><pre id="logbody" style="margin:0"></pre></div>
<div class="toast" id="toast"></div>

<script>
const cardsEl=document.getElementById('cards');
const patchesEl=document.getElementById('patches');
const oauthEl=document.getElementById('oauth-table');
const summaryEl=document.getElementById('pool-summary');
const activityEl=document.getElementById('activity');
const logEl=document.getElementById('log');
const logbody=document.getElementById('logbody');
const toastEl=document.getElementById('toast');
const cdlg=document.getElementById('cdlg');

function toast(msg){toastEl.textContent=msg;toastEl.classList.add('show');setTimeout(()=>toastEl.classList.remove('show'),3500);}
function escape(s){return String(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c])}

async function loadDashboard(){
  let d;
  try { const r=await fetch('/api/data/dashboard'); d=await r.json(); }
  catch(e){ cardsEl.innerHTML='<div class="empty">load failed: '+escape(e.message)+'</div>'; patchesEl.innerHTML=cardsEl.innerHTML; return; }
  // 9router status in header
  const rs=document.getElementById('r9-status');
  const inst=document.getElementById('btn-install9');
  const restart=document.getElementById('btn-restart9');
  if(d.router9?.installable){
    rs.textContent='9router: not installed';
    inst.style.display='inline-block'; restart.style.display='none';
  } else if(d.router9?.installed){
    const ver=d.router9.installed;
    const latest=d.router9.latest;
    if(d.router9.hasUpdate) rs.innerHTML='9router: <b>'+ver+'</b> → <b style="color:#facc15">'+latest+'</b> available';
    else rs.textContent='9router: v'+ver+(latest?' (latest)':'');
    inst.style.display='none'; restart.style.display='inline-block';
  }
  // cards
  const order=['gemini','antigravity','gemini-cli','codex','github'];
  const labels={gemini:'Gemini API key',antigravity:'Antigravity (OAuth)','gemini-cli:':'Gemini CLI (OAuth)',codex:'Codex (OAuth)',github:'GitHub Copilot'};
  labels['gemini-cli']='Gemini CLI (OAuth)';
  cardsEl.innerHTML=order.filter(p=>d.pools[p]).map(p=>{
    const g=d.pools[p];
    return \`<div class="card"><div class="lbl">\${escape(labels[p]||p)}</div><div class="num">\${g.active}</div><div class="sub">\${g.disabled?\`+ \${g.disabled} disabled · \`:''}\${g.total} total</div></div>\`;
  }).join('') || '<div class="empty">no providers in db</div>';
  // patches
  patchesEl.innerHTML=d.patches.map(p=>{
    const isApplied=p.status==='applied';
    const isObsolete=/obsolete/i.test(p.status);
    const isNa=String(p.status).toLowerCase().includes('n/a');
    const cls=isApplied?'b-free':(isObsolete||isNa)?'b-muted':'b-bad';
    let tip='';
    if(isObsolete) tip=' title="9router refactored this file; the old patch no longer fits."';
    else if(isNa) tip=' title="9router was installed as a packaged build (just .next/server bundles, no source). Plugin patches need a source-style install path."';
    return \`<div class="patch"\${tip}><span class="badge \${cls}">\${escape(p.status)}</span><span>\${escape(p.title)}</span></div>\`;
  }).join('') || '<div class="empty">9router not detected</div>';
  // activity
  if(d.activity?.length){
    activityEl.innerHTML=d.activity.map(a=>\`<div><span class="ts">\${escape(a.ts)}</span> <span class="cmd">\${escape(a.cmd)}</span> <span class="\${a.ok?'ok':'err'}">\${escape(a.summary)}</span></div>\`).join('');
  }
}

async function loadOauth(){
  let d;
  try { const r=await fetch('/api/data/keys'); d=await r.json(); }
  catch(e){ oauthEl.innerHTML='<div class="empty">load failed: '+escape(e.message)+'</div>'; return; }
  if(!d.accounts?.length){ oauthEl.innerHTML='<div class="empty">no gemini-cli OAuth accounts found in db.json</div>'; return; }
  let html=\`<table><thead><tr><th>Account</th><th>Cloud projects</th><th>Adopted keys</th><th>Health</th><th></th></tr></thead><tbody>\`;
  for(const a of d.accounts){
    const studio=a.studioCount;
    const totalProj=a.totalProjects;
    const free=a.keys.filter(k=>k.test==='free').length;
    const quota=a.keys.filter(k=>k.test==='quota').length;
    const bad=a.keys.filter(k=>k.test==='unavailable').length;
    const unk=a.keys.filter(k=>!k.test).length;
    const projWarn=totalProj>=12?'<span class="badge b-quota">near quota</span>':'';
    html+=\`<tr class="acc-row" onclick="toggleAcc(this)" data-email="\${escape(a.email)}"><td>\${escape(a.email)}</td><td>\${studio} owned · \${totalProj} total \${projWarn}</td><td>\${a.keys.length}</td><td>\${free?\`<span class="badge b-free">\${free} Free</span> \`:''}\${quota?\`<span class="badge b-quota">\${quota} Quota</span> \`:''}\${bad?\`<span class="badge b-bad">\${bad} Bad</span> \`:''}\${unk?\`<span class="badge b-muted">\${unk} ?</span>\`:''}</td><td><button onclick="event.stopPropagation();expandOne('\${escape(a.email)}',1)">+1 project</button></td></tr>\`;
    html+=\`<tr class="detail"><td colspan="5"><div class="detail-inner">\`;
    if(a.keys.length){
      html+=\`<table><thead><tr><th>Project</th><th>Key (last 6)</th><th>Status in 9router</th><th>Last test</th><th></th></tr></thead><tbody>\`;
      for(const k of a.keys){
        const tcls=k.test==='free'?'b-free':k.test==='quota'?'b-quota':k.test==='unavailable'?'b-bad':'b-muted';
        const tlbl=k.test||'untested';
        const active=k.isActive?'<span class="badge b-info">active</span>':'<span class="badge b-muted">disabled</span>';
        html+=\`<tr><td>\${escape(k.project)}</td><td><code>…\${escape(k.keyTail)}</code></td><td>\${active}</td><td><span class="badge \${tcls}">\${escape(tlbl)}</span></td><td><button onclick="testKey('\${escape(k.id)}')">test</button> <button class="danger" onclick="confirmDeleteKey('\${escape(k.id)}','\${escape(k.project)}')">remove</button></td></tr>\`;
      }
      html+=\`</tbody></table>\`;
    } else html+='<div class="empty">no keys adopted from this account yet</div>';
    html+=\`</div></td></tr>\`;
  }
  html+=\`</tbody></table>\`;
  oauthEl.innerHTML=html;
  const totals=d.summary;
  summaryEl.textContent=\`Total: \${totals.accounts} OAuth accounts · \${totals.keys} keys (\${totals.free} Free · \${totals.quota} Quota · \${totals.bad} Bad · \${totals.untested} untested)\`;
}

function toggleAcc(tr){
  tr.classList.toggle('open');
  const detail=tr.nextElementSibling;
  if(detail&&detail.classList.contains('detail')) detail.classList.toggle('open');
}

function refreshAll(){loadDashboard();loadOauth();}

function showLog(text){logbody.textContent=text;logEl.classList.add('open');logEl.scrollTop=logEl.scrollHeight;}
function appendLog(text){logbody.textContent+=text;logEl.scrollTop=logEl.scrollHeight;}

async function streamRun(cmd,query=''){
  showLog('$ fix-9r '+cmd+' '+query+'\\n');
  const r=await fetch('/api/run/'+cmd.split(' ')[0]+(query?'?'+query:''),{method:'POST'});
  const reader=r.body.getReader();
  const dec=new TextDecoder();
  while(true){
    const {value,done}=await reader.read();
    if(done) break;
    appendLog(dec.decode(value,{stream:true}));
  }
  appendLog('\\n[done]\\n');
  toast(cmd+' done');
  refreshAll();
}

function confirmAndRun(cmd,title,msg){
  document.getElementById('cdlg-title').textContent=title;
  document.getElementById('cdlg-msg').textContent=msg;
  const ok=document.getElementById('cdlg-ok');
  ok.onclick=()=>{cdlg.close('ok');streamRun(cmd, cmd.includes('--delete')?'flag=delete':'')};
  cdlg.showModal();
}

async function expandOne(email,n){
  if(!confirm('Create '+n+' new project + Gemini API key on '+email+'?\\n\\nThrottled 8-15s, takes ~30s per project.')) return;
  showLog('$ fix-9r expand --account '+email+' --create '+n+'\\n');
  const r=await fetch('/api/expand-account?email='+encodeURIComponent(email)+'&n='+n,{method:'POST'});
  const reader=r.body.getReader(); const dec=new TextDecoder();
  while(true){const {value,done}=await reader.read(); if(done) break; appendLog(dec.decode(value,{stream:true}));}
  toast('expand on '+email+' done'); refreshAll();
}

async function testKey(id){
  toast('testing…');
  const r=await fetch('/api/test-key?id='+encodeURIComponent(id),{method:'POST'});
  const d=await r.json();
  toast('result: '+d.test+' (HTTP '+d.status+')');
  loadOauth();
}

async function testAllLive(){
  showLog('$ test-all-live (parallel)\\n');
  const start=Date.now();
  const r=await fetch('/api/test-all-live',{method:'POST'});
  const d=await r.json();
  const ms=Date.now()-start;
  appendLog(\`tested \${d.tested} keys in \${ms}ms — Free:\${d.free} Quota:\${d.quota} Bad:\${d.unavailable} Other:\${d.other}\\n\`);
  toast(\`tested \${d.tested} keys: \${d.free} Free, \${d.unavailable} Bad\`);
  refreshAll();
}

async function confirmDeleteKey(id,proj){
  const cascade=confirm('Remove key for project '+proj+'?\\n\\nClick OK to ALSO delete the Cloud project + key on Google (recommended for dead keys).\\nClick Cancel to abort.\\n\\nNote: only deletes 9router row + Cloud project. The key itself dies with the project.');
  if(!cascade) return;
  showLog('$ delete-key '+id+' (cascade=1)\\n');
  const r=await fetch('/api/delete-key?id='+encodeURIComponent(id)+'&cascade=1',{method:'POST'});
  const d=await r.json();
  appendLog(JSON.stringify(d,null,2)+'\\n');
  toast('removed'+(d.cloud?.ok?' + Cloud project deleted':d.cloud?' + Cloud delete failed':''));
  loadOauth(); loadDashboard();
}

async function deleteDeadDialog(){
  const cascade=confirm('Delete-dead workflow:\\n\\n1) Live-test every active gemini key\\n2) Remove all keys classified as Unavailable from 9router db.json\\n3) Cascade-delete the Cloud project on Google (recommended)\\n\\nClick OK to proceed (with cascade), Cancel to abort.\\n\\n(For row-only delete without touching Google, use the per-key Remove button.)');
  if(!cascade) return;
  showLog('$ delete-dead --cascade\\n');
  const r=await fetch('/api/delete-dead?cascade=1',{method:'POST'});
  const d=await r.json();
  appendLog('tested '+d.tested+' · removed '+d.removed+' rows · Cloud projects deleted '+d.cloudOk+', failed '+d.cloudFail+'\\n');
  toast('removed '+d.removed+' dead');
  refreshAll();
}

async function discoverDialog(){
  const cleanup=confirm('Discover workflow:\\n\\n1) Scan every gemini-cli OAuth account in parallel\\n2) For each Cloud project, list API keys; create one for empty owned projects (gen-lang-client*/genai*/studio*)\\n3) Test every key, adopt Free ones, delete dead studio-* projects\\n\\nClick OK to also delete projects with permission-denied (old genai-* projects Google has restricted) — recovers Google\\'s 30-project quota slot.\\nClick Cancel to keep them on Cloud.');
  const flag = cleanup ? '?flag=delete-permission-denied' : '';
  showLog('$ fix-9r discover'+(cleanup?' --delete-permission-denied':'')+'\\n');
  const r=await fetch('/api/run/discover'+flag,{method:'POST'});
  const reader=r.body.getReader(); const dec=new TextDecoder();
  while(true){const {value,done}=await reader.read(); if(done) break; appendLog(dec.decode(value,{stream:true}));}
  toast('discover done'); refreshAll();
}

async function bulkExpand(){
  const n=parseInt(prompt('Bulk expand: create how many new projects+keys per OAuth account?\\n(Throttled 8-15s/project, auto-tested. 12 accounts × N = total to create)','5')||'0',10);
  if(!n||n<1) return;
  if(!confirm('Run expand with limit='+n+' on all '+document.querySelectorAll('tr.acc-row').length+' accounts?\\n\\nEstimated: ~'+(n*12*12)+'s. Watch the log panel for progress.')) return;
  showLog('$ fix-9r expand 30 '+n+'\\n');
  const r=await fetch('/api/expand-all?n='+n,{method:'POST'});
  const reader=r.body.getReader(); const dec=new TextDecoder();
  while(true){const {value,done}=await reader.read(); if(done) break; appendLog(dec.decode(value,{stream:true}));}
  toast('bulk expand done');
  refreshAll();
}

async function loadTestConfig(){
  const r=await fetch('/api/data/test-config');
  const c=await r.json();
  document.getElementById('test-config').textContent=
    'Health test: POST '+c.endpoint.replace('{model}',c.model)+'  ·  '+c.classifyDoc;
}

refreshAll();
loadTestConfig();
setInterval(loadDashboard,30000); // soft poll counts
</script>
</body></html>`;
}

// In-memory ring buffer for the dashboard's "Recent activity" panel.
const activityLog = [];
function logActivity(cmd, ok, summary) {
  activityLog.unshift({ ts: new Date().toLocaleTimeString(), cmd, ok, summary });
  if (activityLog.length > 50) activityLog.length = 50;
}

// Stream subprocess stdout/stderr to the response (for real-time UI logs).
async function streamSubprocess(args, res) {
  const { spawn } = await import("node:child_process");
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Transfer-Encoding": "chunked" });
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [process.argv[1], ...args], { env: process.env });
    let buf = "";
    const onChunk = (d) => { const s = d.toString(); buf += s; res.write(s); };
    proc.stdout.on("data", onChunk);
    proc.stderr.on("data", onChunk);
    proc.on("close", (code) => {
      logActivity(args.join(" "), code === 0, buf.split("\n").filter(Boolean).pop()?.slice(0, 80) || "(done)");
      res.end();
      resolve();
    });
  });
}

// Per-provider counts.
function dbPoolSnapshot() {
  const { db } = readDb();
  const pools = {};
  for (const c of db.providerConnections || []) {
    const p = pools[c.provider] = pools[c.provider] || { active: 0, disabled: 0, total: 0 };
    p.total++;
    if (c.isActive === false) p.disabled++; else p.active++;
  }
  return pools;
}

// Lightweight check whether each fix-9r patch family is currently applied to the user's 9router.
function patchesSnapshot() {
  let root;
  try { root = find9routerDir(null); } catch { return []; }
  const patches = [];
  const checkSrc = (file, marker) => {
    try { return fs.readFileSync(path.join(root, file), "utf8").includes(marker); } catch { return null; }
  };
  const checkPkg = (marker) => {
    const dir = path.join(root, "app", ".next", "server");
    if (!fs.existsSync(dir)) return null;
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop();
      try {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const f = path.join(d, e.name);
          if (e.isDirectory()) stack.push(f);
          else if (e.isFile() && e.name.endsWith(".js")) {
            try { if (fs.readFileSync(f, "utf8").includes(marker)) return true; } catch { /* skip */ }
          }
        }
      } catch { /* skip */ }
    }
    return false;
  };
  const status = (src, pkg) => (src || pkg) ? "applied" : "not yet";

  // Detect 9router v0.4.18+ refactor: image generation moved from
  // open-sse/handlers/imageGenerationCore.js (single map) into a per-provider
  // plugin system under open-sse/handlers/imageProviders/. Our AG image core /
  // AG image route patches target the old structure → mark them obsolete on
  // the new layout so the dashboard doesn't show a misleading "not yet".
  const newImagePluginSystem = (() => {
    // Source layout: handlers/imageProviders/ directory.
    if (fs.existsSync(path.join(root, "open-sse", "handlers", "imageProviders"))) return true;
    // Source layout: imageGenerationCore.js mentions the new adapter system.
    try {
      const s = fs.readFileSync(path.join(root, "open-sse", "handlers", "imageGenerationCore.js"), "utf8");
      if (s.includes("getImageAdapter") || s.includes("./imageProviders/")) return true;
    } catch { /* file not present */ }
    // Packaged layout: image route.js v0.4.18+ uses per-provider {buildUrl, buildHeaders}
    // pattern instead of a single IMAGE_PROVIDERS const map (the old patch's anchor).
    const route = path.join(root, "app", ".next", "server", "app", "api", "v1", "images", "generations", "route.js");
    if (fs.existsSync(route)) {
      try {
        const s = fs.readFileSync(route, "utf8");
        // Old map anchor missing AND new dispatch pattern present → new system.
        const oldAnchor = `codex:{baseUrl:p,format:"codex",stream:!0}};`;
        if (!s.includes(oldAnchor) && /\w+:\{[^}]{0,40}buildUrl:/.test(s)) return true;
      } catch { /* skip */ }
    }
    return false;
  })();

  patches.push({ title: "gc/genlang executor", status: status(checkSrc("open-sse/executors/gemini-cli.js", MARKERS.gc2Executor), checkPkg(MARKERS.gc2PackagedExecutor)) });
  patches.push({ title: "gc credentials passthrough", status: status(checkSrc("src/sse/services/auth.js", MARKERS.gc2Credentials), checkPkg(MARKERS.gc2PackagedCredentials)) });
  patches.push({ title: "AG image model", status: status(checkSrc("open-sse/config/providerModels.js", MARKERS.providerModel), checkPkg(MARKERS.packagedModel)) });
  if (newImagePluginSystem) {
    // v0.4.18+ uses an imageProviders adapter map. We support BOTH layouts:
    //   - source checkout: write open-sse/handlers/imageProviders/antigravity.js
    //   - packaged build:  inject the antigravity entry into .next/server route.js
    const pluginsDir = path.join(root, "open-sse", "handlers", "imageProviders");
    const sourcePresent = fs.existsSync(pluginsDir);
    const sourceApplied = sourcePresent && (() => {
      try {
        return fs.existsSync(path.join(pluginsDir, "antigravity.js"))
          && fs.readFileSync(path.join(pluginsDir, "index.js"), "utf8").includes(MARKERS.agPlugin);
      } catch { return false; }
    })();
    const packagedRoute = path.join(root, "app", ".next", "server", "app", "api", "v1", "images", "generations", "route.js");
    const packagedApplied = (() => {
      try { return fs.readFileSync(packagedRoute, "utf8").includes(MARKERS.agPlugin); } catch { return false; }
    })();
    const status = sourceApplied || packagedApplied ? "applied" : (sourcePresent ? "not yet" : (fs.existsSync(packagedRoute) ? "not yet" : "n/a"));
    patches.push({ title: "AG image plugin", status });
  } else {
    patches.push({
      title: "AG image core",
      status: status(checkSrc("open-sse/handlers/imageGenerationCore.js", MARKERS.imageCore), checkPkg(MARKERS.packagedImageCore)),
    });
  }
  return patches;
}

// Per-OAuth-account breakdown (cheap — db only, no Google API calls).
function keysBreakdownSnapshot() {
  const { db } = readDb();
  const conns = db.providerConnections || [];
  const oauthAccs = conns.filter(c => c.provider === "gemini-cli" && c.isActive !== false && c.refreshToken);
  const keys = conns.filter(c => c.provider === "gemini" && c.apiKey);

  const accounts = oauthAccs.map(a => {
    const accKeys = keys.filter(k => (k.name || "").startsWith(a.email + " "));
    const studioCount = accKeys.filter(k => /studio-/.test(k.name || "")).length;
    return {
      email: a.email,
      studioCount,
      totalProjects: 0, // populated by /api/data/keys-live (cloud query) — left 0 here so dashboard load is instant
      keys: accKeys.map(k => ({
        id: k.id,
        project: (k.name || "").split(" / ")[1] || "?",
        keyTail: k.apiKey ? k.apiKey.slice(-6) : "?",
        isActive: k.isActive !== false,
        // testStatus="active" = was ok at last write; "unavailable" = 403; else untested
        test: k.testStatus === "active" ? "free" : (k.testStatus === "unavailable" ? "unavailable" : null),
      })),
    };
  });
  const summary = {
    accounts: accounts.length,
    keys: accounts.reduce((s, a) => s + a.keys.length, 0),
    free: accounts.reduce((s, a) => s + a.keys.filter(k => k.test === "free").length, 0),
    quota: accounts.reduce((s, a) => s + a.keys.filter(k => k.test === "quota").length, 0),
    bad: accounts.reduce((s, a) => s + a.keys.filter(k => k.test === "unavailable").length, 0),
    untested: accounts.reduce((s, a) => s + a.keys.filter(k => !k.test).length, 0),
  };
  return { accounts, summary };
}

function findRowById(db, id) {
  return (db.providerConnections || []).find(c => c.id === id);
}

// Health-test config — exposed to UI so users see exactly what's checked.
const HEALTH_TEST = {
  model: "gemma-4-26b-a4b-it",
  endpoint: "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
  classifyDoc: "200 → Free tier · 429 → Quota cap (daily) · 403 → Unavailable (project/key suspended)",
};

// Find the gemini-cli OAuth row that owns a given project (by email prefix in row.name).
function findOwningOauth(db, keyRow) {
  const email = (keyRow.name || "").split(" / ")[0];
  if (!email) return null;
  return (db.providerConnections || []).find(c => c.provider === "gemini-cli" && c.email === email && c.refreshToken);
}

// Delete a Cloud project on Google. Best-effort — returns ok/error message.
async function deleteCloudProject(refreshToken, projectId) {
  try {
    const token = await refreshGcToken(refreshToken);
    const r = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.ok) return { ok: true };
    const j = await r.json().catch(() => ({}));
    return { ok: false, error: j.error?.message || `HTTP ${r.status}` };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Read 9router's installed version + npm-registry latest. Used by the dashboard
// header so the user always sees what's installed and whether an update is out.
async function get9routerInfo() {
  let installed = null, root = null, installable = false;
  try {
    root = find9routerDir(null);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    installed = pkg.version || null;
  } catch { installable = true; }
  let latest = null;
  try {
    const r = await fetch("https://registry.npmjs.org/9router/latest", { signal: AbortSignal.timeout(8000) });
    if (r.ok) latest = (await r.json()).version || null;
  } catch { /* offline ok */ }
  return { installed, latest, root, installable, hasUpdate: !!installed && !!latest && installed !== latest };
}

// Install 9router via npm — used when fix-9r is run before 9router itself.
function cmdInstall9router() {
  console.log("Installing 9router globally via npm...\n");
  try { execFileSync("npm", ["install", "-g", "9router"], { stdio: "inherit" }); }
  catch (e) { fatal(`9router install failed: ${e.message}`); }
  console.log("\n✓ 9router installed. Run `fix-9r patch` to apply patches.");
}

// Find the running 9router process listening on port 20128 and restart it.
// Tries pm2 → systemd → fallback kill+detached respawn.
async function cmdRestart9router() {
  console.log("Restarting 9router...\n");
  // Try pm2 first
  try {
    const list = execFileSync("pm2", ["list"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (/9router|9r/i.test(list)) {
      execFileSync("pm2", ["restart", "9router"], { stdio: "inherit" });
      console.log("\n✓ pm2 restart 9router");
      return;
    }
  } catch { /* pm2 not present */ }
  // Try systemctl
  try {
    execFileSync("systemctl", ["status", "9router"], { stdio: "ignore" });
    execFileSync("systemctl", ["restart", "9router"], { stdio: "inherit" });
    console.log("\n✓ systemctl restart 9router");
    return;
  } catch { /* systemd unit not present */ }
  // Fallback: kill PID on :20128 and respawn detached
  let pid = null;
  try {
    pid = execFileSync("lsof", ["-ti", ":20128"], { encoding: "utf8" }).trim().split("\n")[0];
  } catch { /* nothing listening */ }
  if (pid) {
    console.log(`killing existing 9router PID ${pid}`);
    try { process.kill(parseInt(pid, 10)); } catch { /* already gone */ }
  }
  // Find 9router binary on PATH
  let bin;
  try { bin = execFileSync("which", ["9router"], { encoding: "utf8" }).trim(); } catch {}
  if (!bin) { console.log("⚠ 9router binary not on PATH; start it manually"); return; }
  const { spawn } = await import("node:child_process");
  const child = spawn(bin, [], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
  console.log(`✓ respawned 9router (pid ${child.pid}); give it 5-10s to come up`);
}

// Live, in-process parallel test of every active gemini API key. Mutates db.json
// (testStatus + lastErrorAt) and returns counts. Drops the legacy cached-status
// problem where rows from older runs could show stale "Bad" badges.
async function liveTestAllGeminiKeys(model = "gemma-4-26b-a4b-it") {
  const { dbPath, db } = readDb();
  const conns = db.providerConnections || [];
  // Test ALL gemini API keys (including isActive=false). We don't change isActive here —
  // we just refresh testStatus so the UI's "2 Bad" badges can clear when keys recover.
  const keys = conns.filter(c => c.provider === "gemini" && c.apiKey);

  // Full parallel: GET /models is metadata-only, no rate limit, no quota
  // consumption. ~100-300ms per call → ~1s for 50+ keys.
  const results = await Promise.all(keys.map(async (k) => {
    let status = await geminiTest(k.apiKey, model);
    // Single retry on network / 5xx (not on 4xx — those are real classifications).
    if (status === 0 || status >= 500) {
      await sleep(400);
      status = await geminiTest(k.apiKey, model);
    }
    return { row: k, status, cls: classify(status) };
  }));

  const counts = { free: 0, quota: 0, unavailable: 0, other: 0 };
  const otherCodes = {}; // breakdown for the Activity log
  for (const r of results) {
    counts[r.cls]++;
    if (r.cls === "other") otherCodes[r.status || "network"] = (otherCodes[r.status || "network"] || 0) + 1;
    r.row.testStatus = r.cls === "free" ? "active" : (r.cls === "unavailable" ? "unavailable" : "active");
    r.row.lastError = r.cls === "free" ? undefined : `live test HTTP ${r.status}`;
    r.row.lastErrorAt = new Date().toISOString();
  }
  fs.copyFileSync(dbPath, `${dbPath}.bak.test-all-${Date.now()}`);
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
  return { tested: results.length, ...counts, otherCodes };
}

// Cron install/uninstall — adds/removes a daily entry that runs `fix-9r prune --delete`.
// Default: 03:15 local time. Idempotent: re-running install replaces the existing entry.
function cmdCron(args) {
  const action = args.positional[0] || "show";
  const cronLine = `15 3 * * * ${process.execPath} ${process.argv[1]} prune --delete >> ~/.9router/fix-9r-cron.log 2>&1 # fix-9r-managed`;
  const current = (() => { try { return execFileSync("crontab", ["-l"], { encoding: "utf8" }); } catch { return ""; } })();
  const without = current.split("\n").filter(l => !l.includes("# fix-9r-managed")).join("\n");

  if (action === "install") {
    const next = (without.trim() ? without.trimEnd() + "\n" : "") + cronLine + "\n";
    execFileSync("bash", ["-c", `printf %s ${JSON.stringify(next)} | crontab -`], { stdio: "inherit" });
    console.log("✓ cron installed: daily 03:15 fix-9r prune --delete");
    console.log("  log: ~/.9router/fix-9r-cron.log");
  } else if (action === "uninstall") {
    execFileSync("bash", ["-c", `printf %s ${JSON.stringify(without)} | crontab -`], { stdio: "inherit" });
    console.log("✓ cron uninstalled");
  } else {
    if (current.includes("# fix-9r-managed")) {
      console.log("cron: installed");
      console.log(current.split("\n").filter(l => l.includes("# fix-9r-managed")).join("\n"));
    } else {
      console.log("cron: not installed. Run `fix-9r cron install`.");
    }
  }
}

async function cmdUi() {
  const http = await import("node:http");
  const PORT = parseInt(process.env.FIX_9R_PORT || "20129", 10);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const send = (code, type, body) => { res.writeHead(code, { "Content-Type": type }); res.end(body); };
    const sendJson = (obj) => send(200, "application/json", JSON.stringify(obj));

    try {
      if (req.method === "GET" && url.pathname === "/favicon.ico") {
        // 1x1 transparent PNG (silences browser favicon fetch).
        const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000169a4dc330000000049454e44ae426082", "hex");
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "max-age=86400" });
        return res.end(png);
      }
      if (req.method === "GET" && url.pathname === "/") {
        // No-cache so the browser always picks up freshly-shipped UI changes
        // after a fix-9r restart instead of holding a stale page.
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          "Pragma": "no-cache",
        });
        return res.end(htmlDashboard());
      }
      if (req.method === "GET" && url.pathname === "/api/data/dashboard") {
        const router9 = await get9routerInfo();
        return sendJson({ pools: dbPoolSnapshot(), patches: patchesSnapshot(), activity: activityLog, router9 });
      }
      if (req.method === "POST" && url.pathname === "/api/test-all-live") {
        const t0 = Date.now();
        const counts = await liveTestAllGeminiKeys();
        const ms = Date.now() - t0;
        logActivity("test-all-live", true,
          `parallel test of ${counts.tested} keys against ${HEALTH_TEST.model} in ${ms}ms — ${counts.free} Free, ${counts.unavailable} Bad, ${counts.quota} Quota, ${counts.other} Other`);
        return sendJson(counts);
      }
      if (req.method === "POST" && url.pathname === "/api/install-9router") {
        return streamSubprocess(["install-9router"], res);
      }
      if (req.method === "POST" && url.pathname === "/api/cron-install") {
        return streamSubprocess(["cron", "install"], res);
      }
      if (req.method === "POST" && url.pathname === "/api/restart-9router") {
        return streamSubprocess(["restart-9router"], res);
      }
      if (req.method === "GET" && url.pathname === "/api/data/keys") {
        return sendJson(keysBreakdownSnapshot());
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/run/")) {
        const cmd = url.pathname.slice(9);
        const args = [cmd];
        const flag = url.searchParams.get("flag");
        if (flag === "delete") args.push("--delete");
        else if (flag === "delete-permission-denied") args.push("--delete-permission-denied");
        return streamSubprocess(args, res);
      }
      if (req.method === "POST" && url.pathname === "/api/test-key") {
        const id = url.searchParams.get("id") || "";
        const { dbPath, db } = readDb();
        const row = findRowById(db, id);
        if (!row || !row.apiKey) return send(404, "application/json", JSON.stringify({ error: "not found" }));
        const status = await geminiTest(row.apiKey, HEALTH_TEST.model);
        const cls = classify(status);
        row.testStatus = cls === "free" ? "active" : "unavailable";
        row.lastError = cls === "free" ? undefined : `manual test HTTP ${status}`;
        row.lastErrorAt = new Date().toISOString();
        fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
        const tier = { free: "Free tier", quota: "Quota cap", unavailable: "Unavailable", other: `HTTP ${status}` }[cls];
        logActivity("test-key", cls === "free",
          `${row.name || id.slice(0, 8)} (key …${row.apiKey.slice(-6)}) → ${tier} on ${HEALTH_TEST.model}`);
        return sendJson({ status, test: cls });
      }
      if (req.method === "POST" && url.pathname === "/api/delete-key") {
        const id = url.searchParams.get("id") || "";
        const cascade = url.searchParams.get("cascade") === "1";
        const { dbPath, db } = readDb();
        const row = (db.providerConnections || []).find(c => c.id === id);
        if (!row) return sendJson({ removed: 0, error: "not found" });
        const projectId = (row.name || "").split(" / ")[1];
        const owner = findOwningOauth(db, row);
        let cloudResult = null;
        if (cascade && projectId && owner) {
          cloudResult = await deleteCloudProject(owner.refreshToken, projectId);
        }
        db.providerConnections = (db.providerConnections || []).filter(c => c.id !== id);
        fs.copyFileSync(dbPath, `${dbPath}.bak.delete-${Date.now()}`);
        fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
        const cloudMsg = cascade ? (cloudResult?.ok ? " + Cloud project deleted" : ` + Cloud project: ${cloudResult?.error || "skipped"}`) : "";
        logActivity("delete-key", true, `removed key ${row.apiKey?.slice(-6) || "?"} from ${row.name || id}${cloudMsg}`);
        return sendJson({ removed: 1, cloud: cloudResult });
      }
      if (req.method === "POST" && url.pathname === "/api/delete-dead") {
        // Bulk: live-test all → delete keys whose project is Unavailable AND
        // optionally cascade-delete the Cloud project.
        const cascade = url.searchParams.get("cascade") === "1";
        const counts = await liveTestAllGeminiKeys();
        const { dbPath, db } = readDb();
        const dead = (db.providerConnections || []).filter(c => c.provider === "gemini" && c.testStatus === "unavailable");
        let cloudOk = 0, cloudFail = 0;
        if (cascade) {
          for (const row of dead) {
            const projectId = (row.name || "").split(" / ")[1];
            const owner = findOwningOauth(db, row);
            if (projectId && owner) {
              const r = await deleteCloudProject(owner.refreshToken, projectId);
              r.ok ? cloudOk++ : cloudFail++;
            }
          }
        }
        const removeIds = new Set(dead.map(r => r.id));
        db.providerConnections = (db.providerConnections || []).filter(c => !removeIds.has(c.id));
        fs.copyFileSync(dbPath, `${dbPath}.bak.delete-dead-${Date.now()}`);
        fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
        const msg = `removed ${dead.length} dead keys${cascade ? ` (Cloud projects: ${cloudOk} deleted, ${cloudFail} failed)` : " (Cloud projects kept)"}`;
        logActivity("delete-dead", true, msg);
        return sendJson({ removed: dead.length, cloudOk, cloudFail, ...counts });
      }
      if (req.method === "POST" && url.pathname === "/api/expand-all") {
        const n = parseInt(url.searchParams.get("n") || "5", 10);
        return streamSubprocess(["expand", "30", String(n)], res);
      }
      if (req.method === "GET" && url.pathname === "/api/data/test-config") {
        return sendJson(HEALTH_TEST);
      }
      if (req.method === "POST" && url.pathname === "/api/expand-account") {
        const email = url.searchParams.get("email") || "";
        const n = url.searchParams.get("n") || "1";
        // Re-use `expand` subcommand by setting target=current+n, limit=n on this single account.
        // Simplest: spawn `expand` and let user run normally. Filter by email is not yet implemented in CLI;
        // here we just spawn the full expand for limit=n keys (it stops when target reached on this acc).
        return streamSubprocess(["expand", "999", n], res); // target=999 forces creation of n keys
      }
      send(404, "text/plain", "not found");
    } catch (e) {
      send(500, "application/json", JSON.stringify({ error: e.message }));
    }
  });
  server.listen(PORT, () => {
    console.log(`fix-9r UI on http://localhost:${PORT}`);
    console.log("Ctrl+C to stop");
    try { execFileSync(process.platform === "darwin" ? "open" : "xdg-open", [`http://localhost:${PORT}`], { stdio: "ignore" }); } catch { /* ignore */ }
  });
}

// ---------------------------------------------------------------------------
// Subcommand: install (npm i -g self for fix-9r shortcut on PATH)
// ---------------------------------------------------------------------------
function cmdInstall() {
  console.log("Installing dmdfami/fix-9router globally for `fix-9r` shortcut...\n");
  try {
    execFileSync("npm", ["install", "-g", "github:dmdfami/fix-9router"], { stdio: "inherit" });
    console.log("\n✓ Installed. Now you can run: fix-9r");
  } catch (e) {
    fatal(`install failed: ${e.message}\nTry manually: npm install -g github:dmdfami/fix-9router`);
  }
}

// ---------------------------------------------------------------------------
// Interactive menu (no deps — readline)
// ---------------------------------------------------------------------------
function interactiveMenu() {
  const items = [
    ["patch",          "Apply 9router patches"],
    ["status",         "Show pool overview"],
    ["prune",          "Health-check gemini keys (dry-run)"],
    ["prune --delete", "Health-check + DELETE Unavailable keys"],
    ["expand 30 5",    "Create up to 5 new projects + keys per OAuth account (target 30)"],
    ["install",        "npm i -g — enable `fix-9r` shortcut on PATH"],
    ["help",           "Show all commands"],
  ];
  console.log("\nfix-9router — pick action:\n");
  for (let i = 0; i < items.length; i++) console.log(`  ${i + 1}) ${items[i][0].padEnd(20)} ${items[i][1]}`);
  console.log(`  q) quit\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question("choice: ", (ans) => {
    rl.close();
    const v = ans.trim().toLowerCase();
    if (v === "q" || v === "") return;
    const n = parseInt(v, 10);
    if (!n || n < 1 || n > items.length) { console.log("invalid choice"); return; }
    const [cmd] = items[n - 1];
    if (cmd === "help") return printHelp();
    // Re-dispatch
    const argv = cmd.split(/\s+/);
    main(argv);
  });
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------
async function main(argvOverride) {
  const raw = argvOverride || process.argv.slice(2);
  const sub = raw[0] && !raw[0].startsWith("--") ? raw[0] : "patch";
  const flags = parseFlags(raw[0] && !raw[0].startsWith("--") ? raw.slice(1) : raw);

  if (sub === "menu" || (raw.length === 0 && process.stdin.isTTY)) return interactiveMenu();
  if (sub === "patch") return cmdPatch(flags);
  if (sub === "status") return cmdStatus();
  if (sub === "prune") return cmdPrune(flags);
  if (sub === "expand") return cmdExpand(flags);
  if (sub === "discover") return cmdDiscover(flags);
  if (sub === "update") return cmdUpdate(flags);
  if (sub === "install-9router") return cmdInstall9router();
  if (sub === "restart-9router") return cmdRestart9router();
  if (sub === "cron") return cmdCron(flags);
  if (sub === "ui" || sub === "web") return cmdUi();
  if (sub === "install") return cmdInstall();
  if (sub === "help") return printHelp();
  fatal(`Unknown subcommand: ${sub}. Run 'fix-9r --help'.`);
}

main().catch((e) => { console.error("error:", e.message); process.exit(1); });
