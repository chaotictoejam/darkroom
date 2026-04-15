# Darkroom — dev & build tasks
# Usage:
#   make install   — first-time setup (Python venv + npm)
#   make dev       — start backend + frontend in parallel
#   make backend   — backend only (port 8000)
#   make frontend  — frontend only (port 5173)
#   make build     — production build (frontend dist bundled into backend)

.PHONY: install dev backend frontend build lint

# Use the project .venv if it exists, otherwise fall back to whatever python is on PATH
VENV_PYTHON := $(if $(wildcard .venv/Scripts/python.exe),.venv/Scripts/python.exe,\
               $(if $(wildcard .venv/bin/python),.venv/bin/python,python))

# ── Setup ─────────────────────────────────────────────────────────────────────

install:
	@echo "→ Installing Python backend..."
	$(VENV_PYTHON) -m pip install -e "backend/[dev]"
	@echo "→ Installing frontend dependencies..."
	cd frontend && npm install
	@echo ""
	@echo "✓  Done. Copy .env.example to .env and add your ANTHROPIC_API_KEY."

# ── Development ───────────────────────────────────────────────────────────────

dev:
	@echo "Starting Darkroom (backend :8000, frontend :5173)"
	$(MAKE) -j2 backend frontend

backend:
	cd backend && $(abspath $(VENV_PYTHON)) -m uvicorn darkroom.main:app --reload --port 8000

frontend:
	cd frontend && npm run dev

# ── Production build ──────────────────────────────────────────────────────────
# After `make build`, run `darkroom` (or uvicorn) and visit localhost:8000 —
# FastAPI serves the bundled React app directly, no Vite needed.

build:
	cd frontend && npm run build
	@echo "✓  Frontend built to frontend/dist — FastAPI will serve it at :8000"

# ── Code quality ──────────────────────────────────────────────────────────────

lint:
	cd frontend && npx tsc --noEmit
	@echo "TypeScript check passed"
