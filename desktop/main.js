const path = require("node:path");
const { app, BrowserWindow, screen } = require("electron");

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");

function readArg(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return null;
  return args[idx + 1] ?? null;
}

const targetUrl = readArg("--url") || process.env.PET_COMPANION_URL || "http://127.0.0.1:19821";

let overlayWindow = null;
let lastInteractive = null;

const WINDOW_WIDTH = 560;
const WINDOW_HEIGHT = 640;
const WINDOW_MARGIN = 0;
const DESKTOP_DRAG_CSS = `
  .pet-overlay,
  .pet-sprite,
  .pet-sprite * {
    -webkit-app-region: drag !important;
  }
  .pet-bubble,
  .pet-bubble *,
  button,
  a,
  input,
  textarea,
  select {
    -webkit-app-region: no-drag !important;
  }
`;

function log(...parts) {
  if (!verbose) return;
  console.log("[pet-electron]", ...parts);
}

function setWindowInteractivity(active) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (lastInteractive === active) return;
  lastInteractive = active;
  overlayWindow.setIgnoreMouseEvents(!active, { forward: true });
}

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.workArea;

  overlayWindow = new BrowserWindow({
    x: x + width - WINDOW_WIDTH - WINDOW_MARGIN,
    y: y + height - WINDOW_HEIGHT - WINDOW_MARGIN,
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  setWindowInteractivity(true);
  overlayWindow.loadURL(targetUrl);

  overlayWindow.webContents.on("did-finish-load", () => {
    log("loaded", targetUrl);
    void overlayWindow.webContents.insertCSS(DESKTOP_DRAG_CSS);
  });

  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
