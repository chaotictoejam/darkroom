/**
 * Exposes a small, explicit bridge as window.darkroom (typed in frontend/src/desktop.ts).
 * The renderer gets no Node access.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('darkroom', {
  isDesktop: true,
  platform: process.platform,
  requestMicrophoneAccess: () => ipcRenderer.invoke('darkroom:request-mic-access'),
})
