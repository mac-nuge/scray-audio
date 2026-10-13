#!/usr/bin/env node
// SideStore source for Scray Native's IPAs (native 15.101).
//
// The build workflows upload each IPA to a folder on macnguyen.com and run
// this to add it to source.json there - the "source" SideStore is pointed at
// once, after which every build shows up as an update to tap. Both apps (the
// dev build and the release build) live in the one source, each with its
// own list of versions, newest first.
//
// Run on the build machine, no dependencies:
//   node scripts/sidestore-publish.js <current source.json or ""> <out.json> <out-keep.txt>
// with the build's details in the environment (see `need` below). Prints
// nothing on success but a summary line. `out-keep.txt` lists every IPA the
// new source still refers to - the workflow deletes the rest from the server.

const fs = require("fs");

const need = (k) => {
  const v = process.env[k];
  if (v == null || v === "") { console.error(`sidestore-publish: ${k} is not set`); process.exit(1); }
  return v;
};

const [, , currentPath, outPath, keepPath] = process.argv;
if (!outPath || !keepPath) {
  console.error("usage: sidestore-publish.js <current.json|''> <out.json> <keep.txt>");
  process.exit(1);
}

const BASE_URL  = need("SS_BASE_URL").replace(/\/+$/, "");   // https://macnguyen.com/sideload/<token>
const BUNDLE_ID = need("SS_BUNDLE_ID");                       // com.mac.scraynative(.dev)
const APP_NAME  = need("SS_APP_NAME");
const VERSION   = need("SS_VERSION");                         // CFBundleShortVersionString, 1.0.<run>
const BUILD     = need("SS_BUILD");                           // CFBundleVersion, the run number
const IPA_NAME  = need("SS_IPA_NAME");                        // file name in the folder
const IPA_SIZE  = Number(need("SS_IPA_SIZE"));
const ICON_NAME = need("SS_ICON_NAME");
const NOTES     = process.env.SS_NOTES || "";
// ⚙️ Versions kept per app - older IPAs are deleted from the server.
const KEEP      = Math.max(1, Number(process.env.SS_KEEP || 3));

let source = null;
if (currentPath) {
  try {
    const text = fs.readFileSync(currentPath, "utf8").trim();
    if (text) source = JSON.parse(text);
  } catch (err) {
    // A broken or missing file starts a fresh source rather than failing the build.
    console.error(`sidestore-publish: couldn't read the current source (${err.message}) - starting a new one`);
  }
}
if (!source || typeof source !== "object") source = {};

source.name = source.name || "Scray";
source.identifier = source.identifier || "com.mac.scray.source";
source.sourceURL = `${BASE_URL}/source.json`;
if (!Array.isArray(source.apps)) source.apps = [];
if (!Array.isArray(source.news)) source.news = [];

let app = source.apps.find(a => a && a.bundleIdentifier === BUNDLE_ID);
if (!app) {
  app = { bundleIdentifier: BUNDLE_ID, versions: [] };
  source.apps.push(app);
}
app.name = APP_NAME;
app.developerName = "Mac";
app.localizedDescription = app.localizedDescription || `${APP_NAME} - built by GitHub Actions from scray-audio.`;
app.iconURL = `${BASE_URL}/${ICON_NAME}`;
if (!Array.isArray(app.versions)) app.versions = [];

const entry = {
  version: VERSION,
  buildVersion: BUILD,
  date: new Date().toISOString(),
  localizedDescription: NOTES,
  downloadURL: `${BASE_URL}/${IPA_NAME}`,
  size: IPA_SIZE,
};
// A re-run of the same build replaces its entry rather than listing it twice.
app.versions = [entry, ...app.versions.filter(v => v && String(v.buildVersion) !== BUILD)].slice(0, KEEP);

// The pre-2.0 fields, for older SideStore releases that read only these.
app.version = entry.version;
app.versionDate = entry.date;
app.versionDescription = entry.localizedDescription;
app.downloadURL = entry.downloadURL;
app.size = entry.size;

fs.writeFileSync(outPath, JSON.stringify(source, null, 2) + "\n");

const keep = new Set();
for (const a of source.apps) {
  for (const v of (a && a.versions) || []) {
    const name = String(v.downloadURL || "").split("/").pop();
    if (name) keep.add(decodeURIComponent(name));
  }
}
fs.writeFileSync(keepPath, [...keep].join("\n") + "\n");

console.log(`sidestore-publish: ${APP_NAME} ${VERSION} (${BUILD}) added; ` +
            `${app.versions.length} version(s) listed, ${keep.size} IPA(s) kept across ${source.apps.length} app(s)`);
