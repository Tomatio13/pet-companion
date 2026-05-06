const { ipcRenderer } = require("electron");

function relay(name, event) {
  ipcRenderer.send(name, {
    button: event.button,
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
  });
}

window.addEventListener("DOMContentLoaded", () => {
  const root = document.body;
  if (!root) return;

  root.addEventListener("mouseenter", () => {
    ipcRenderer.send("pet-companion:drag-handle-enter");
  });
  root.addEventListener("mouseleave", () => {
    ipcRenderer.send("pet-companion:drag-handle-leave");
  });
  root.addEventListener("mousedown", (event) => {
    relay("pet-companion:drag-handle-down", event);
  });
  window.addEventListener("mousemove", (event) => {
    relay("pet-companion:drag-handle-move", event);
  });
  window.addEventListener("mouseup", (event) => {
    relay("pet-companion:drag-handle-up", event);
  });
});
