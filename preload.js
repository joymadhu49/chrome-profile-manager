const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getProfiles: () => ipcRenderer.invoke('get-profiles'),
  getWorkspaces: () => ipcRenderer.invoke('get-workspaces'),
  saveWorkspaces: (workspaces) => ipcRenderer.invoke('save-workspaces', workspaces),

  launchWorkspace: (profileDirs, gridCols, url) => ipcRenderer.invoke('launch-workspace', profileDirs, gridCols, url),
  closeWorkspace: () => ipcRenderer.invoke('close-workspace'),
  getRunningStatuses: () => ipcRenderer.invoke('get-running-statuses'),
  closeProfile: (profileDir) => ipcRenderer.invoke('close-profile', profileDir),
  retileWindows: (gridCols) => ipcRenderer.invoke('retile-windows', gridCols),
  getLinks: () => ipcRenderer.invoke('get-links'),
  saveLinks: (links) => ipcRenderer.invoke('save-links', links),

  onRunningStatusChanged: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('running-status-changed', handler);
    return () => ipcRenderer.removeListener('running-status-changed', handler);
  },
  onProfilesChanged: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('profiles-changed', handler);
    return () => ipcRenderer.removeListener('profiles-changed', handler);
  },
});
