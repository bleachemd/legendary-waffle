import { contextBridge, ipcRenderer } from 'electron'

// Expose a safe, narrow API to the renderer process.
// The renderer can't touch Node or Electron APIs directly.
contextBridge.exposeInMainWorld('electronAPI', {
  // send a message to the Python backend
  toPython: (msg: object) => ipcRenderer.send('to-python', msg),

  // toggle stealth click-through mode
  setClickThrough: (enabled: boolean) =>
    ipcRenderer.send('set-click-through', enabled),

  // open file picker and return the file path
  pickFile: (filters: Electron.FileFilter[]) =>
    ipcRenderer.invoke('pick-file', filters),

  // read a file from disk (used after pick-file returns a path)
  readFile: (filePath: string) => ipcRenderer.invoke('read-file', filePath),

  // listen for messages pushed from the main process / python backend
  onPythonMessage: (callback: (msg: unknown) => void) => {
    ipcRenderer.on('python-message', (_event, msg) => callback(msg))
    return () => ipcRenderer.removeAllListeners('python-message')
  },

  onClickThroughChanged: (callback: (enabled: boolean) => void) => {
    ipcRenderer.on('click-through-changed', (_event, enabled) =>
      callback(enabled)
    )
    return () => ipcRenderer.removeAllListeners('click-through-changed')
  },

  onToggleRecording: (callback: () => void) => {
    ipcRenderer.on('toggle-recording', () => callback())
    return () => ipcRenderer.removeAllListeners('toggle-recording')
  },

  onClearSession: (callback: () => void) => {
    ipcRenderer.on('clear-session', () => callback())
    return () => ipcRenderer.removeAllListeners('clear-session')
  },
})
