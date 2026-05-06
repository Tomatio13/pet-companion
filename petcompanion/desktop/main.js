const path = require("node:path");
const { app, BrowserWindow, ipcMain, screen } = require("electron");

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");

function readArg(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return null;
  return args[idx + 1] ?? null;
}

const targetUrl =
  readArg("--url") || process.env.PET_COMPANION_URL || "http://127.0.0.1:19821";

let overlayWindow = null;
let dragHandleWindow = null;
let lastInteractive = null;
let hoverRegion = null;
let hoverPollTimer = null;
let interactiveUntil = 0;
let handleDragging = false;
let handleDragOrigin = null;

const HOVER_POLL_MS = 120;
const HOVER_REGION_PADDING = 32;
const HOVER_INTERACTIVE_GRACE_MS = 400;
const HANDLE_PADDING = 24;
const DESKTOP_DRAG_CSS = `
  .pet-overlay,
  .pet-sprite,
  .pet-sprite * ,
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
const DRAG_HANDLE_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        background: transparent;
        overflow: hidden;
      }
      body {
        cursor: grab;
      }
      body:active {
        cursor: grabbing;
      }
    </style>
  </head>
  <body></body>
</html>`;

function log(...parts) {
  if (!verbose) return;
  console.log("[pet-electron]", ...parts);
}

function setWindowInteractivity(active) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (lastInteractive === active) return;
  lastInteractive = active;
  log("set-interactive", active);
  overlayWindow.setIgnoreMouseEvents(!active, { forward: true });
}

function stopHoverPolling() {
  if (hoverPollTimer != null) {
    clearInterval(hoverPollTimer);
    hoverPollTimer = null;
  }
}

function pointInHoverRegion() {
  if (!overlayWindow || overlayWindow.isDestroyed() || !hoverRegion) return false;
  const bounds = overlayWindow.getBounds();
  const point = screen.getCursorScreenPoint();
  const localX = point.x - bounds.x;
  const localY = point.y - bounds.y;
  return (
    localX >= hoverRegion.left - HOVER_REGION_PADDING
    && localX <= hoverRegion.right + HOVER_REGION_PADDING
    && localY >= hoverRegion.top - HOVER_REGION_PADDING
    && localY <= hoverRegion.bottom + HOVER_REGION_PADDING
  );
}

function syncHoverInteractivity() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (!hoverRegion) {
    setWindowInteractivity(false);
    return;
  }
  if (pointInHoverRegion()) {
    interactiveUntil = Date.now() + HOVER_INTERACTIVE_GRACE_MS;
    setWindowInteractivity(true);
    return;
  }
  setWindowInteractivity(Date.now() < interactiveUntil);
}

function startHoverPolling() {
  stopHoverPolling();
  hoverPollTimer = setInterval(syncHoverInteractivity, HOVER_POLL_MS);
}

function isValidHoverRegion(region) {
  if (!region || typeof region !== "object") return false;
  return ["left", "top", "right", "bottom"].every(
    (key) => Number.isFinite(region[key]),
  );
}

function dispatchToOverlay(eventName, detail = null) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const payload = detail == null
    ? `window.dispatchEvent(new CustomEvent(${JSON.stringify(eventName)}));`
    : `window.dispatchEvent(new CustomEvent(${JSON.stringify(eventName)}, { detail: ${JSON.stringify(detail)} }));`;
  void overlayWindow.webContents.executeJavaScript(payload).catch(() => {});
}

function updateDragHandleBounds() {
  if (
    !dragHandleWindow
    || dragHandleWindow.isDestroyed()
    || handleDragging
    || !hoverRegion
    || !overlayWindow
    || overlayWindow.isDestroyed()
  ) {
    return;
  }

  const bounds = overlayWindow.getBounds();
  const width = Math.max(
    1,
    Math.round(hoverRegion.right - hoverRegion.left) + HANDLE_PADDING * 2,
  );
  const height = Math.max(
    1,
    Math.round(hoverRegion.bottom - hoverRegion.top) + HANDLE_PADDING * 2,
  );
  dragHandleWindow.setBounds({
    x: bounds.x + Math.round(hoverRegion.left) - HANDLE_PADDING,
    y: bounds.y + Math.round(hoverRegion.top) - HANDLE_PADDING,
    width,
    height,
  });
}

function ensureDragHandleWindow() {
  if (dragHandleWindow && !dragHandleWindow.isDestroyed()) return;

  dragHandleWindow = new BrowserWindow({
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "drag-handle-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  dragHandleWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
  });
  dragHandleWindow.setAlwaysOnTop(true, "screen-saver");
  dragHandleWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(DRAG_HANDLE_HTML)}`,
  );
  dragHandleWindow.on("closed", () => {
    dragHandleWindow = null;
    handleDragging = false;
    handleDragOrigin = null;
  });
}

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.workArea;

  overlayWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
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
  overlayWindow.setContentBounds({ x, y, width, height });
  setWindowInteractivity(false);
  overlayWindow.loadURL(targetUrl);

  overlayWindow.webContents.on("did-finish-load", () => {
    log("loaded", targetUrl);
    void overlayWindow.webContents.insertCSS(DESKTOP_DRAG_CSS);
  });

  overlayWindow.on("closed", () => {
    stopHoverPolling();
    if (dragHandleWindow && !dragHandleWindow.isDestroyed()) {
      dragHandleWindow.close();
    }
    overlayWindow = null;
    hoverRegion = null;
    lastInteractive = null;
  });
}

app.whenReady().then(() => {
  ipcMain.on("pet-companion:set-overlay-interactivity", (_event, interactive) => {
    if (interactive) {
      interactiveUntil = Date.now() + HOVER_INTERACTIVE_GRACE_MS;
    }
    setWindowInteractivity(Boolean(interactive));
  });
  ipcMain.on("pet-companion:update-hover-region", (_event, region) => {
    hoverRegion = isValidHoverRegion(region)
      ? {
          left: Math.round(region.left),
          top: Math.round(region.top),
          right: Math.round(region.right),
          bottom: Math.round(region.bottom),
        }
      : null;
    updateDragHandleBounds();
    syncHoverInteractivity();
  });
  ipcMain.on("pet-companion:drag-handle-enter", () => {
    dispatchToOverlay("petcompanion-pointer-enter");
  });
  ipcMain.on("pet-companion:drag-handle-leave", () => {
    if (!handleDragging) {
      dispatchToOverlay("petcompanion-pointer-leave");
    }
  });
  ipcMain.on("pet-companion:drag-handle-down", (_event, detail) => {
    if (!dragHandleWindow || dragHandleWindow.isDestroyed()) return;
    const bounds = dragHandleWindow.getBounds();
    handleDragging = true;
    handleDragOrigin = {
      bounds,
      screenX: Number(detail?.screenX ?? 0),
      screenY: Number(detail?.screenY ?? 0),
      offsetX: Number(detail?.clientX ?? 0),
      offsetY: Number(detail?.clientY ?? 0),
    };
    dispatchToOverlay("petcompanion-drag-start", {
      button: Number(detail?.button ?? 0),
      clientX: bounds.x + handleDragOrigin.offsetX - overlayWindow.getBounds().x,
      clientY: bounds.y + handleDragOrigin.offsetY - overlayWindow.getBounds().y,
    });
  });
  ipcMain.on("pet-companion:drag-handle-move", (_event, detail) => {
    if (
      !handleDragging
      || !handleDragOrigin
      || !dragHandleWindow
      || dragHandleWindow.isDestroyed()
      || !overlayWindow
      || overlayWindow.isDestroyed()
    ) {
      return;
    }
    const dx = Number(detail?.screenX ?? 0) - handleDragOrigin.screenX;
    const dy = Number(detail?.screenY ?? 0) - handleDragOrigin.screenY;
    dragHandleWindow.setBounds({
      x: handleDragOrigin.bounds.x + dx,
      y: handleDragOrigin.bounds.y + dy,
      width: handleDragOrigin.bounds.width,
      height: handleDragOrigin.bounds.height,
    });
    const overlayBounds = overlayWindow.getBounds();
    dispatchToOverlay("petcompanion-drag-move", {
      button: Number(detail?.button ?? 0),
      clientX: Number(detail?.screenX ?? 0) - overlayBounds.x,
      clientY: Number(detail?.screenY ?? 0) - overlayBounds.y,
    });
  });
  ipcMain.on("pet-companion:drag-handle-up", () => {
    if (!handleDragging) return;
    handleDragging = false;
    handleDragOrigin = null;
    dispatchToOverlay("petcompanion-drag-end");
    updateDragHandleBounds();
  });

  createWindow();
  ensureDragHandleWindow();
  startHoverPolling();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      ensureDragHandleWindow();
    }
  });
});

app.on("window-all-closed", () => {
  stopHoverPolling();
  app.quit();
});
