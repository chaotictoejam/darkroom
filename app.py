"""
This file is a stub. The Flask-based app.py has been superseded by the
FastAPI backend in backend/darkroom/.

To start Darkroom:
    make dev          — backend (port 8000) + frontend dev server (port 5173)
    make backend      — backend only
    make build        — production build (React app bundled into FastAPI)

Then open http://localhost:5173 in your browser.
"""
import sys

print(
    "\n"
    "  Darkroom no longer uses app.py.\n"
    "\n"
    "  Start the app with:\n"
    "    make dev\n"
    "\n"
    "  Then open http://localhost:5173\n",
    file=sys.stderr,
)
sys.exit(1)
