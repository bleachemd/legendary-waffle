import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  Tray,
  Menu,
  nativeImage,
  dialog,
} from 'electron'
import path from 'path'
import { spawn, ChildProcess } from 'child_process'
import fs from 'fs'
import WebSocket from 'ws'

// Load .env in dev so engineers don't have to export vars by hand
if (!app.isPackaged) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('dotenv').config({ path: path.join(__dirname, '../.env') })
  } catch {
    // dotenv is a devDependency; if missing, rely on the shell environment
  }
}

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged
const VITE_DEV_SERVER = 'http://localhost:5173'

// When BACKEND_WS_URL is set (e.g. ws://localhost:8765), Electron connects to
// the Python backend running in Docker instead of spawning a local subprocess.
const BACKEND_WS_URL = process.env.BACKEND_WS_URL?.trim() || ''

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let pythonProcess: ChildProcess | null = null
let wsClient: WebSocket | null = null
let isClickThrough = false
let isVisible = true

// ─── Window Creation ─────────────────────────────────────────────────────────

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize

  mainWindow = new BrowserWindow({
    width: 480,
    height: 700,
    x: width - 500,
    y: height - 720,

    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    movable: true,
    hasShadow: false,

    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })

  // THE KEY STEALTH CALL:
  // Windows → SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)
  // macOS   → NSWindowSharingType = NSWindowSharingNone
  mainWindow.setContentProtection(true)
  mainWindow.setAlwaysOnTop(true, 'screen-saver', 1)
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (isDev) {
    mainWindow.loadURL(VITE_DEV_SERVER)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => { mainWindow = null })

  if (process.platform === 'darwin') {
    app.dock.hide()
  }
}

// ─── Click-Through ────────────────────────────────────────────────────────────

function setClickThrough(enabled: boolean) {
  if (!mainWindow) return
  isClickThrough = enabled
  mainWindow.setIgnoreMouseEvents(enabled, { forward: true })
  mainWindow.webContents.send('click-through-changed', enabled)
}

// ─── Visibility ───────────────────────────────────────────────────────────────

function toggleVisibility() {
  if (!mainWindow) return
  if (isVisible) {
    mainWindow.hide()
    isVisible = false
  } else {
    mainWindow.show()
    isVisible = true
  }
}

// ─── Shortcuts ────────────────────────────────────────────────────────────────

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Shift+H', () => toggleVisibility())
  globalShortcut.register('CommandOrControl+Shift+P', () => setClickThrough(!isClickThrough))
  globalShortcut.register('CommandOrControl+Shift+R', () => {
    mainWindow?.webContents.send('toggle-recording')
  })
  globalShortcut.register('CommandOrControl+Shift+C', () => {
    mainWindow?.webContents.send('clear-session')
  })
}

// ─── Tray ─────────────────────────────────────────────────────────────────────

function createTray() {
  const iconPath = path.join(__dirname, '../assets/tray-icon.png')
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty()

  tray = new Tray(icon)
  tray.setToolTip('Interview Copilot')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / Hide  (Ctrl+Shift+H)', click: () => toggleVisibility() },
    { label: 'Toggle Click-Through  (Ctrl+Shift+P)', click: () => setClickThrough(!isClickThrough) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]))
  tray.on('click', () => toggleVisibility())
}

// ─── Backend: stdio subprocess (local dev) ────────────────────────────────────

function startPythonSubprocess() {
  const scriptPath = path.join(__dirname, '../python/main.py')
  if (!fs.existsSync(scriptPath)) {
    console.warn('[backend] python/main.py not found — skipping')
    return
  }

  pythonProcess = spawn('python3', [scriptPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? '',
      GROQ_API_KEY: process.env.GROQ_API_KEY ?? '',
      WS_MODE: 'false',
    },
  })

  pythonProcess.stdout?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      try {
        mainWindow?.webContents.send('python-message', JSON.parse(line))
      } catch {
        console.log('[python]', line)
      }
    }
  })

  pythonProcess.stderr?.on('data', (data: Buffer) => {
    console.error('[python stderr]', data.toString())
  })

  pythonProcess.on('exit', (code) => {
    console.log('[python] exited with code', code)
    pythonProcess = null
  })
}

// ─── Backend: WebSocket client (Docker) ──────────────────────────────────────

function connectWebSocket(url: string) {
  console.log('[ws] connecting to', url)

  const connect = () => {
    wsClient = new WebSocket(url)

    wsClient.on('open', () => {
      console.log('[ws] connected')
      mainWindow?.webContents.send('python-message', {
        type: 'status',
        text: 'Docker-бэкенд подключён',
      })
    })

    wsClient.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        mainWindow?.webContents.send('python-message', msg)
      } catch {
        console.log('[ws raw]', data.toString())
      }
    })

    wsClient.on('close', () => {
      console.log('[ws] disconnected — retrying in 3 s')
      wsClient = null
      // auto-reconnect; the Docker container may just be starting up
      setTimeout(connect, 3000)
    })

    wsClient.on('error', (err) => {
      console.error('[ws error]', err.message)
    })
  }

  connect()
}

// ─── Unified send ─────────────────────────────────────────────────────────────

function sendToBackend(msg: object) {
  const payload = JSON.stringify(msg)

  if (wsClient?.readyState === WebSocket.OPEN) {
    wsClient.send(payload)
    return
  }

  if (pythonProcess?.stdin) {
    pythonProcess.stdin.write(payload + '\n')
  }
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

function registerIpcHandlers() {
  ipcMain.on('set-click-through', (_e, enabled: boolean) => setClickThrough(enabled))
  ipcMain.on('toggle-visibility', () => toggleVisibility())
  ipcMain.on('to-python', (_e, msg: object) => sendToBackend(msg))

  ipcMain.handle('pick-file', async (_e, filters: Electron.FileFilter[]) => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters,
    })
    return result.canceled || result.filePaths.length === 0
      ? null
      : result.filePaths[0]
  })

  ipcMain.handle('read-file', (_e, filePath: string) => {
    try { return fs.readFileSync(filePath, 'utf-8') } catch { return null }
  })
}

// ─── App Lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow()
  createTray()
  registerShortcuts()
  registerIpcHandlers()

  if (BACKEND_WS_URL) {
    connectWebSocket(BACKEND_WS_URL)
  } else {
    startPythonSubprocess()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  pythonProcess?.kill()
  wsClient?.close()
})

app.on('browser-window-created', (_e, win) => {
  win.setContentProtection(true)
})
