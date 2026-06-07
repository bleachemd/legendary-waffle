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

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged
const VITE_DEV_SERVER = 'http://localhost:5173'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let pythonProcess: ChildProcess | null = null
let isClickThrough = false
let isVisible = true

// ─── Window Creation ─────────────────────────────────────────────────────────

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize

  mainWindow = new BrowserWindow({
    // position in the bottom-right corner by default, easy to move
    width: 480,
    height: 700,
    x: width - 500,
    y: height - 720,

    // stealth properties
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

  // ── THE KEY STEALTH CALL ─────────────────────────────────────────────────
  // On Windows: calls SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)
  // On macOS:   sets NSWindowSharingType to NSWindowSharingNone
  // This makes the window invisible to ALL screen-capture software —
  // Zoom, Teams, Meet, OBS, Discord — at the OS level, not application level.
  mainWindow.setContentProtection(true)

  // Keep it above fullscreen apps (screen-saver level is the highest)
  mainWindow.setAlwaysOnTop(true, 'screen-saver', 1)

  // Prevent it from showing in Mission Control / Task View / Alt+Tab
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (isDev) {
    mainWindow.loadURL(VITE_DEV_SERVER)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Don't show the window in the system dock on macOS
  if (process.platform === 'darwin') {
    app.dock.hide()
  }
}

// ─── Click-Through Toggle ─────────────────────────────────────────────────────
// When click-through is on, all mouse events fall through to whatever is behind
// the overlay — you can interact with your browser, IDE, etc. normally.
// Toggle it back off when you need to scroll the answer or click a button.

function setClickThrough(enabled: boolean) {
  if (!mainWindow) return
  isClickThrough = enabled
  mainWindow.setIgnoreMouseEvents(enabled, { forward: true })
  mainWindow.webContents.send('click-through-changed', enabled)
}

// ─── Visibility Toggle ────────────────────────────────────────────────────────

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

// ─── Global Shortcuts ─────────────────────────────────────────────────────────

function registerShortcuts() {
  // Ctrl+Shift+H — show/hide the overlay completely
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    toggleVisibility()
  })

  // Ctrl+Shift+P — toggle click-through (pass-through mouse events)
  globalShortcut.register('CommandOrControl+Shift+P', () => {
    setClickThrough(!isClickThrough)
  })

  // Ctrl+Shift+R — trigger manual recording start/stop
  globalShortcut.register('CommandOrControl+Shift+R', () => {
    if (!mainWindow) return
    mainWindow.webContents.send('toggle-recording')
  })

  // Ctrl+Shift+C — clear the current transcript and answer
  globalShortcut.register('CommandOrControl+Shift+C', () => {
    if (!mainWindow) return
    mainWindow.webContents.send('clear-session')
  })
}

// ─── System Tray ─────────────────────────────────────────────────────────────

function createTray() {
  // use a simple 16x16 empty icon if no asset exists yet
  const iconPath = path.join(__dirname, '../assets/tray-icon.png')
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty()

  tray = new Tray(icon)
  tray.setToolTip('Interview Copilot')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show / Hide  (Ctrl+Shift+H)',
      click: () => toggleVisibility(),
    },
    {
      label: 'Toggle Click-Through  (Ctrl+Shift+P)',
      click: () => setClickThrough(!isClickThrough),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit()
      },
    },
  ])

  tray.setContextMenu(contextMenu)
  tray.on('click', () => toggleVisibility())
}

// ─── Python Backend Subprocess ────────────────────────────────────────────────
// The Python process handles audio capture + STT + RAG + LLM calls.
// We communicate over stdio (newline-delimited JSON) so no HTTP server needed.

function startPythonBackend() {
  const scriptPath = path.join(__dirname, '../python/main.py')
  if (!fs.existsSync(scriptPath)) {
    console.warn('Python backend not found at', scriptPath, '— skipping')
    return
  }

  pythonProcess = spawn('python3', [scriptPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? '',
    },
  })

  pythonProcess.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        const msg = JSON.parse(line)
        if (mainWindow) {
          mainWindow.webContents.send('python-message', msg)
        }
      } catch {
        // raw log line — just print it
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

function sendToPython(msg: object) {
  if (!pythonProcess?.stdin) return
  pythonProcess.stdin.write(JSON.stringify(msg) + '\n')
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

function registerIpcHandlers() {
  ipcMain.on('set-click-through', (_event, enabled: boolean) => {
    setClickThrough(enabled)
  })

  ipcMain.on('toggle-visibility', () => {
    toggleVisibility()
  })

  ipcMain.on('to-python', (_event, msg: object) => {
    sendToPython(msg)
  })

  // File picker for resume / job description upload
  ipcMain.handle('pick-file', async (_event, filters: Electron.FileFilter[]) => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters,
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('read-file', (_event, filePath: string) => {
    try {
      return fs.readFileSync(filePath, 'utf-8')
    } catch {
      return null
    }
  })
}

// ─── App Lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow()
  createTray()
  registerShortcuts()
  registerIpcHandlers()
  startPythonBackend()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()

  if (pythonProcess) {
    pythonProcess.kill()
    pythonProcess = null
  }
})

// Prevent the app from being captured in screen recordings even if
// setContentProtection was somehow bypassed — belt and suspenders.
app.on('browser-window-created', (_event, win) => {
  win.setContentProtection(true)
})
