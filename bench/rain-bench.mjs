/* Headless benchmark harness for SimpleRain (js/games/simple-rain.js).
 *
 * Loads the real game script with stubbed window/document/canvas, pumps the
 * game's own requestAnimationFrame loop with deterministic timestamps, and
 * reports:
 *   - the game's built-in "SimpleRain perf" instrumentation (draw/effects/layout/snapshot ms)
 *   - wall-clock JS ms per frame for the measured window
 *   - canvas 2D command counts per frame (gradients, clips, paths, shadow sets, ...)
 *   - snapshot build + JSON serialization microbench
 *
 * Usage: node bench/rain-bench.mjs --label baseline
 * Results are printed and written to bench/results/<label>.json
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const label = (() => {
  const i = process.argv.indexOf("--label");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "run";
})();

const WARMUP_FRAMES = 120;
const MEASURE_FRAMES = 600;
const FRAME_MS = 1000 / 60;
const CSS_W = 390;
const CSS_H = 740;

/* Deterministic PRNG so before/after runs render identical scenes. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
Math.random = mulberry32(0xC0FFEE);

/* Counting 2D context mock. Methods are cheap no-ops that tally calls. */
const counts = {};
function bump(name) { counts[name] = (counts[name] || 0) + 1; }
function resetCounts() { for (const k of Object.keys(counts)) counts[k] = 0; }
const gradientStub = { addColorStop() {} };
const CTX_METHODS = [
  "arc", "arcTo", "beginPath", "bezierCurveTo", "clearRect", "clip", "closePath",
  "ellipse", "fill", "fillRect", "fillText", "lineTo", "moveTo", "quadraticCurveTo",
  "rect", "restore", "rotate", "save", "scale", "setLineDash", "setTransform",
  "stroke", "translate",
];
function makeCtx(canvas) {
  const ctx = { canvas };
  for (const m of CTX_METHODS) ctx[m] = function () { bump(m); };
  ctx.createLinearGradient = function () { bump("createLinearGradient"); return gradientStub; };
  ctx.createRadialGradient = function () { bump("createRadialGradient"); return gradientStub; };
  ctx.measureText = function () { return { width: 10 }; };
  let shadowBlur = 0;
  Object.defineProperty(ctx, "shadowBlur", {
    get() { return shadowBlur; },
    set(v) { if (v) bump("shadowBlurSet"); shadowBlur = v; },
  });
  for (const p of ["fillStyle", "strokeStyle", "globalAlpha", "lineWidth", "font", "textAlign", "textBaseline", "shadowColor", "lineCap", "lineJoin"]) ctx[p] = undefined;
  return ctx;
}

/* Canvas + DOM stubs. */
const canvas = {
  width: 0,
  height: 0,
  clientWidth: CSS_W,
  clientHeight: CSS_H,
  getBoundingClientRect() { bump("getBoundingClientRect"); return { left: 0, top: 0, width: CSS_W, height: CSS_H }; },
  addEventListener() {},
  removeEventListener() {},
  setPointerCapture() {},
  releasePointerCapture() {},
  hasPointerCapture() { return false; },
};
canvas.getContext = () => ctx2d;
const ctx2d = makeCtx(canvas);

let rafQueue = [];
let rafIds = 0;
const visibilityListeners = [];
const sandboxWindow = {
  devicePixelRatio: 2,
  addEventListener() {},
  removeEventListener() {},
};
const sandboxDocument = {
  hidden: false,
  visibilityState: "visible",
  activeElement: null,
  addEventListener(type, fn) { if (type === "visibilitychange") visibilityListeners.push(fn); },
  removeEventListener() {},
};

const perfLogs = [];
const realDebug = console.debug.bind(console);
console.debug = (...args) => {
  if (args[0] === "SimpleRain perf") perfLogs.push(args[1]);
  else realDebug(...args);
};

globalThis.window = sandboxWindow;
globalThis.document = sandboxDocument;
globalThis.requestAnimationFrame = (cb) => { rafQueue.push(cb); return ++rafIds; };
globalThis.cancelAnimationFrame = () => { rafQueue.length = 0; };

/* Load the real game script. */
vm.runInThisContext(readFileSync(join(root, "js", "games", "simple-rain.js"), "utf8"), { filename: "simple-rain.js" });
const game = sandboxWindow.SimpleRainGame;
if (!game) throw new Error("SimpleRainGame did not register on window");

/* Replicate the game's deterministic tile set (mirrors makeTiles()). */
const BLOSSOM_KEYS = ["lotus", "iris", "lily", "mint", "sky", "coral", "violet", "jade"];
const MOTIFS = ["lily", "koi", "turtle", "dragonfly", "pads", "pondlife"];
const EDGE_SETS = [
  [0, 1, 2, 3], [0, 2, 4, 6], [0, 3, 5, 7], [0, 4, 1, 5],
  [1, 2, 3, 4], [1, 3, 5, 7], [1, 4, 6, 0], [1, 5, 2, 6],
  [2, 3, 4, 5], [2, 4, 6, 0], [2, 5, 7, 1], [2, 6, 3, 7],
  [3, 4, 5, 6], [3, 5, 7, 1], [3, 6, 0, 2], [3, 7, 4, 0],
  [4, 5, 6, 7], [4, 6, 0, 2], [4, 7, 1, 3], [4, 0, 5, 1],
  [5, 6, 7, 0], [5, 7, 1, 3], [5, 0, 2, 4], [5, 1, 6, 2],
  [6, 7, 0, 1], [6, 0, 2, 4], [7, 0, 1, 2], [7, 1, 3, 5],
];
const tiles = EDGE_SETS.map((set, i) => ({
  id: `rain-${String(i + 1).padStart(2, "0")}`,
  edges: set.map((n) => BLOSSOM_KEYS[n]),
  motif: MOTIFS[i % MOTIFS.length],
}));

/* Synthetic mid-game snapshot: 25 placed tiles (5x5), 4 blossoms, live hands. */
const HOST_ID = "host-1";
const PEER_ID = "peer-2";
const board = {};
let turn = 0;
for (let y = -2; y <= 2; y++) {
  for (let x = -2; x <= 2; x++) {
    const t = tiles[turn];
    board[`${x},${y}`] = { tile: t, rot: turn % 4, owner: turn === 0 ? "system" : (turn % 2 ? HOST_ID : PEER_ID), turn };
    turn++;
  }
}
const snapshot = {
  full: true,
  board,
  deck: [],
  hands: { [HOST_ID]: [tiles[27]], [PEER_ID]: [] },
  currentByPlayer: { [HOST_ID]: { tile: tiles[25], rot: 0 }, [PEER_ID]: { tile: tiles[26], rot: 0 } },
  blossoms: [
    { x: -0.5, y: -0.5, color: "lotus" },
    { x: 0.5, y: -0.5, color: "iris" },
    { x: -0.5, y: 0.5, color: "lily" },
    { x: 0.5, y: 0.5, color: "mint" },
  ],
  used: { lotus: true, iris: true, lily: true, mint: true },
  completed: { "-1,-1": true, "0,-1": true, "-1,0": true, "0,0": true },
  turn,
  over: false,
  won: false,
  message: "Listen to the rain and place the next tile.",
  events: [],
};

let broadcastCount = 0;
const host = {
  canvas,
  myId: HOST_ID,
  isHost: () => true,
  getPlayers: () => [
    { id: HOST_ID, name: "Host", color: "#8ce8bc", icon: "A" },
    { id: PEER_ID, name: "Peer", color: "#8ed8ff", icon: "B" },
  ],
  getProfile: (id) => ({ id, name: id, color: "#8ce8bc", icon: "A" }),
  broadcastState: () => { broadcastCount++; },
  sendInput: () => {},
  sendEvent: () => {},
  getSelectedMusicTracks: () => [],
  isMusicMuted: () => true,
};

const instance = game.create(host, snapshot);
instance.start();

let ts = 0;
function pump(frames) {
  let executed = 0;
  for (let i = 0; i < frames; i++) {
    const cb = rafQueue.shift();
    if (!cb) break;
    ts += FRAME_MS;
    cb(ts);
    executed++;
  }
  return executed;
}

/* Warmup, then measure. */
pump(WARMUP_FRAMES);
resetCounts();
perfLogs.length = 0;
broadcastCount = 0;
const wallStart = performance.now();
const framesRun = pump(MEASURE_FRAMES);
const wallMs = performance.now() - wallStart;

/* Snapshot microbench. */
const SNAP_ITERS = 200;
let snap = null;
const snapStart = performance.now();
for (let i = 0; i < SNAP_ITERS; i++) snap = instance.getSnapshot();
const snapBuildMs = (performance.now() - snapStart) / SNAP_ITERS;
const jsonStart = performance.now();
let jsonBytes = 0;
for (let i = 0; i < SNAP_ITERS; i++) jsonBytes = JSON.stringify(snap).length;
const snapJsonMs = (performance.now() - jsonStart) / SNAP_ITERS;

instance.destroy();

const opsPerFrame = {};
for (const [k, v] of Object.entries(counts).sort()) opsPerFrame[k] = +(v / Math.max(1, framesRun)).toFixed(2);
const lastPerf = perfLogs[perfLogs.length - 1] || null;

const result = {
  label,
  timestamp: new Date().toISOString(),
  node: process.version,
  scenario: { cssSize: `${CSS_W}x${CSS_H}`, dpr: 2, placedTiles: 25, blossoms: 4, warmupFrames: WARMUP_FRAMES, measuredFrames: framesRun, simulatedSeconds: +(framesRun * FRAME_MS / 1000).toFixed(1) },
  frameLoop: {
    framesExecuted: framesRun,
    wallMsTotal: +wallMs.toFixed(1),
    wallMsPerFrame: +(wallMs / Math.max(1, framesRun)).toFixed(3),
    broadcastsDuringMeasure: broadcastCount,
  },
  gamePerfLog: lastPerf,
  allPerfLogs: perfLogs,
  snapshot: {
    buildMsPerSnapshot: +snapBuildMs.toFixed(4),
    jsonStringifyMsPerSnapshot: +snapJsonMs.toFixed(4),
    jsonBytes,
  },
  canvasOpsPerFrame: opsPerFrame,
};

const outDir = join(__dirname, "results");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `${label}.json`);
writeFileSync(outPath, JSON.stringify(result, null, 2));

console.log(`\n=== SimpleRain bench [${label}] ===`);
console.log(`frames: ${framesRun} | wall ms/frame (JS): ${result.frameLoop.wallMsPerFrame}`);
if (lastPerf) console.log(`game perf log (last 5s window):`, lastPerf);
console.log(`snapshot: build ${result.snapshot.buildMsPerSnapshot} ms | stringify ${result.snapshot.jsonStringifyMsPerSnapshot} ms | ${jsonBytes} bytes`);
console.log(`broadcasts during measure: ${broadcastCount}`);
console.log(`canvas ops/frame:`, opsPerFrame);
console.log(`written: ${outPath}`);
