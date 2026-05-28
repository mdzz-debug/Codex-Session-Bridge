const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridgeDesktop', {
  platform: process.platform,
  getPreferences: () => ipcRenderer.invoke('desktop:get-preferences'),
  getRelayState: () => ipcRenderer.invoke('desktop:get-relay-state'),
  setRelayState: (state) => ipcRenderer.invoke('desktop:set-relay-state', state),
  setPreferences: (patch) => ipcRenderer.invoke('desktop:set-preferences', patch),
  getDaemonStatus: () => ipcRenderer.invoke('desktop:get-daemon-status'),
  startDaemon: () => ipcRenderer.invoke('desktop:start-daemon'),
  stopDaemon: () => ipcRenderer.invoke('desktop:stop-daemon'),
  restartDaemon: () => ipcRenderer.invoke('desktop:restart-daemon'),
  resizeWindow: (height) => ipcRenderer.invoke('desktop:resize-window', height),
  getAppInfo: () => ipcRenderer.invoke('desktop:get-app-info'),
  checkUpdates: () => ipcRenderer.invoke('desktop:check-updates'),
  openUpdatePage: (url) => ipcRenderer.invoke('desktop:open-update-page', url),
  openPrivacySettings: () => ipcRenderer.invoke('desktop:open-privacy-settings'),
  chooseProjectFolder: () => ipcRenderer.invoke('desktop:choose-project-folder'),
  restartCodexDesktopIfRunning: () => ipcRenderer.invoke('desktop:restart-codex-desktop-if-running'),
  getModelUnlockStatus: () => ipcRenderer.invoke('desktop:get-model-unlock-status'),
  applyModelUnlock: () => ipcRenderer.invoke('desktop:apply-model-unlock'),
});
