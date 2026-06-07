// Type declarations for the API exposed by the preload script

interface ElectronAPI {
  toPython: (msg: object) => void
  setClickThrough: (enabled: boolean) => void
  pickFile: (filters: { name: string; extensions: string[] }[]) => Promise<string | null>
  readFile: (filePath: string) => Promise<string | null>
  onPythonMessage: (callback: (msg: unknown) => void) => () => void
  onClickThroughChanged: (callback: (enabled: boolean) => void) => () => void
  onToggleRecording: (callback: () => void) => () => void
  onClearSession: (callback: () => void) => () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
