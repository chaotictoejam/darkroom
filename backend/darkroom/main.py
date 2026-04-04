"""
Darkroom backend — FastAPI application entry point.

Dev:  uvicorn darkroom.main:app --reload --port 8000
Prod: uvicorn darkroom.main:app --port 8000 --workers 1
      (single worker — Whisper model lives in process memory)
"""
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from .api import jobs, media, projects
from .services.renderer import check_ffmpeg
from .storage import PROJECTS_DIR

load_dotenv()

PROJECTS_DIR.mkdir(parents=True, exist_ok=True)

# Built frontend lives here when `npm run build` has been run
FRONTEND_DIST = Path(__file__).parent.parent.parent / "frontend" / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Hand the running event loop to the jobs module so background threads
    # can push WebSocket progress events.
    from .api.jobs import _set_loop
    _set_loop(asyncio.get_running_loop())

    if not check_ffmpeg():
        print("WARNING: ffmpeg not found — rendering will be unavailable.")

    yield


app = FastAPI(
    title="Darkroom",
    version="0.1.0",
    description="Local open-source video editor",
    lifespan=lifespan,
)

# ── API routers ───────────────────────────────────────────────────────────────
app.include_router(projects.router, prefix="/api")
app.include_router(media.router,    prefix="/api")
app.include_router(jobs.router,     prefix="/api")

# ── Project file serving ──────────────────────────────────────────────────────
@app.get("/projects/{project_id}/files/{filename:path}")
async def serve_project_file(project_id: str, filename: str):
    return FileResponse(str(PROJECTS_DIR / project_id / filename))

# ── Frontend serving ──────────────────────────────────────────────────────────
# In dev, Vite runs on :5173 and proxies /api/* here.
# In production `npm run build` populates frontend/dist and we serve it.

if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="assets")

@app.get("/{full_path:path}", include_in_schema=False)
async def spa_fallback(full_path: str):
    """Catch-all: serve the SPA index for any non-API path."""
    index = FRONTEND_DIST / "index.html"
    if index.exists():
        return HTMLResponse(index.read_text(encoding="utf-8"))
    return HTMLResponse(
        "<h2>Darkroom API is running.</h2>"
        "<p>Start the frontend dev server: <code>cd frontend && npm run dev</code></p>"
    )


def run():
    """Entry point for `darkroom` CLI command."""
    import uvicorn
    uvicorn.run("darkroom.main:app", host="127.0.0.1", port=8000, reload=False, workers=1)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("darkroom.main:app", host="127.0.0.1", port=8000, reload=True, workers=1)
