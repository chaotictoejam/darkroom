/**
 * Darkroom desktop — Electron main process.
 *
 * Production (`npm start`): spawns the FastAPI backend on a free localhost port
 * and loads the built React app it serves (requires `make build`).
 * Dev (`npm run dev`): loads the Vite dev server and assumes `make dev` is
 * already running the backend, so hot reload keeps working.
 *
 * Env overrides:
 *   DARKROOM_PYTHON   python executable with the backend installed (default: repo .venv)
 *   DARKROOM_DEV_URL  dev server URL (default: http://localhost:5173)
 */
const { app, BrowserWindow, dialog, ipcMain, session, shell, systemPreferences } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')
const IS_DEV = process.argv.includes('--dev')
const DEV_URL = process.env.DARKROOM_DEV_URL || 'http://localhost:5173'
const BACKEND_START_TIMEOUT_MS = 90_000

let backend = null
let backendLog = []
let mainWindow = null

// ── Backend process ───────────────────────────────────────────────────────────

function findPython() {
  if (process.env.DARKROOM_PYTHON) return process.env.DARKROOM_PYTHON
  const venv = process.platform === 'win32'
    ? path.join(REPO_ROOT, '.venv', 'Scripts', 'python.exe')
    : path.join(REPO_ROOT, '.venv', 'bin', 'python')
  if (fs.existsSync(venv)) return venv
  return process.platform === 'win32' ? 'python' : 'python3'
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function startBackend(port) {
  const python = findPython()
  backendLog = []
  backend = spawn(python, ['-m', 'darkroom'], {
    cwd: path.join(REPO_ROOT, 'backend'),
    env: { ...process.env, DARKROOM_PORT: String(port), PYTHONUNBUFFERED: '1' },
    windowsHide: true,
  })
  const capture = (stream, out) => stream.on('data', (chunk) => {
    out.write(chunk)
    backendLog.push(chunk.toString())
    if (backendLog.length > 200) backendLog.shift()
  })
  capture(backend.stdout, process.stdout)
  capture(backend.stderr, process.stderr)
  backend.on('error', (err) => {
    // e.g. python not found; 'exit' may never fire, so fail startup now.
    backendLog.push(`Failed to start ${python}: ${err.message}\n`)
    backend = null
  })
  backend.on('exit', (code) => {
    const crashed = backend !== null && !app.isQuitting
    backend = null
    if (crashed) {
      dialog.showErrorBox('Darkroom backend stopped', `The backend exited with code ${code}.\n\n${tail()}`)
      app.quit()
    }
  })
}

function stopBackend() {
  if (!backend) return
  const proc = backend
  backend = null
  proc.kill()
}

function tail() {
  return backendLog.join('').split('\n').slice(-25).join('\n')
}

/** Poll until `url` answers, failing early if the backend process died. */
async function waitForServer(url, { requireBackend }) {
  const deadline = Date.now() + BACKEND_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (requireBackend && !backend) throw new Error(`The backend exited during startup.\n\n${tail()}`)
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`Timed out waiting for ${url}.\n\n${tail()}`)
}

// ── Permissions ───────────────────────────────────────────────────────────────

function lockDownSession(appOrigin) {
  const fromApp = (url) => {
    try { return new URL(url).origin === appOrigin } catch { return false }
  }
  const allowed = (permission, details, url) => {
    if (!fromApp(url)) return false
    if (permission === 'clipboard-sanitized-write') return true
    if (permission === 'media') {
      // Microphone only; the app never asks for the camera or screen.
      const types = details.mediaTypes ?? (details.mediaType ? [details.mediaType] : [])
      return types.length > 0 && types.every((t) => t === 'audio')
    }
    return false
  }
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(allowed(permission, details, details.requestingUrl))
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    return allowed(permission, details, requestingOrigin)
  })
}

/** Production only: Vite's dev server relies on inline scripts for hot reload. */
function applyContentSecurityPolicy(appOrigin) {
  const host = new URL(appOrigin).host
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // React inline style attributes
    "img-src 'self' data: blob:",
    "media-src 'self' blob:", // recording playback uses object URLs
    `connect-src 'self' ws://${host}`,
    "font-src 'self' data:",
  ].join('; ')
  session.defaultSession.webRequest.onHeadersReceived({ urls: [`${appOrigin}/*`] }, (details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
  })
}

ipcMain.handle('darkroom:request-mic-access', async () => {
  // Only macOS gates the microphone per app at the OS level.
  if (process.platform !== 'darwin') return true
  if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true
  return systemPreferences.askForMediaAccess('microphone')
})

// ── Window ────────────────────────────────────────────────────────────────────

const LOADING_PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(`
  <body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
               background:#0f0f0f;color:#888;font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    Starting Darkroom…
  </body>`)

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'Darkroom',
    backgroundColor: '#0f0f0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  mainWindow.on('closed', () => { mainWindow = null })
  return mainWindow
}

function keepNavigationInApp(win, appOrigin) {
  const isApp = (url) => {
    try { return new URL(url).origin === appOrigin } catch { return false }
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isApp(url) && /^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isApp(url)) return
    event.preventDefault()
    if (/^https?:/.test(url)) void shell.openExternal(url)
  })
}

async function launch() {
  const win = createWindow()
  void win.loadURL(LOADING_PAGE)

  let appUrl
  if (IS_DEV) {
    appUrl = DEV_URL
    await waitForServer(appUrl, { requireBackend: false })
  } else {
    if (!fs.existsSync(path.join(REPO_ROOT, 'frontend', 'dist', 'index.html'))) {
      throw new Error('The frontend has not been built. Run `make build` first, or use `make desktop-dev`.')
    }
    const port = await freePort()
    appUrl = `http://127.0.0.1:${port}`
    startBackend(port)
    await waitForServer(`${appUrl}/api/status`, { requireBackend: true })
  }

  const appOrigin = new URL(appUrl).origin
  lockDownSession(appOrigin)
  if (!IS_DEV) applyContentSecurityPolicy(appOrigin)
  keepNavigationInApp(win, appOrigin)
  await win.loadURL(appUrl)
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

// One instance only: two backends would write the same projects directory.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => launch()).catch((err) => {
    dialog.showErrorBox('Darkroom could not start', err.message)
    app.isQuitting = true
    stopBackend()
    app.quit()
  })

  app.on('before-quit', () => {
    app.isQuitting = true
    stopBackend()
  })
  // The backend is tied to the window's lifetime, macOS included.
  app.on('window-all-closed', () => app.quit())
}
