const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("petCompanionDesktop", {
  setOverlayInteractivity(interactive) {
    ipcRenderer.send(
      "pet-companion:set-overlay-interactivity",
      Boolean(interactive),
    );
  },
  updateHoverRegion(region) {
    ipcRenderer.send("pet-companion:update-hover-region", region);
  },
});
