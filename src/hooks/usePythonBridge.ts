import { useEffect, useCallback } from 'react'

// Thin wrapper around the Electron IPC bridge to/from Python.
// All inter-process messages are newline-delimited JSON objects with a `type` field.

export type PythonMessage =
  | { type: 'transcript'; speaker: 'mic' | 'speaker'; text: string; final: boolean }
  | { type: 'reasoning_token'; token: string }
  | { type: 'llm_token'; token: string }
  | { type: 'llm_done' }
  | { type: 'status'; text: string }
  | { type: 'error'; message: string }
  | { type: 'rag_ready' }

type MessageHandler = (msg: PythonMessage) => void

export function usePythonBridge(onMessage: MessageHandler) {
  useEffect(() => {
    if (!window.electronAPI) return
    const cleanup = window.electronAPI.onPythonMessage((raw) => {
      onMessage(raw as PythonMessage)
    })
    return cleanup
  }, [onMessage])
}

export function useSendToPython() {
  return useCallback((msg: object) => {
    if (window.electronAPI) {
      window.electronAPI.toPython(msg)
    }
  }, [])
}
