# Contributing to Darkroom

Thanks for wanting to help. Darkroom is run by one person, so a short conversation before a big change saves everyone time.

## Before you start

- **Small fixes** (typos, docs, a clear bug with a test): open a pull request.
- **Anything bigger**: open an issue first. Many roadmap items already have a plan in `docs/` with Decisions and Open questions; read it before you start, and follow its Decisions.
- Issues labelled [`good first issue`](https://github.com/chaotictoejam/darkroom/labels/good%20first%20issue) are scoped to be picked up without much context.
- [ROADMAP.md](ROADMAP.md) lists what's done, what's next and unscheduled ideas.

## The one rule

The point of Darkroom is that **nothing leaves the user's control**. Every change follows the principles in [ROADMAP.md](ROADMAP.md#principles):

- **Local by default.** Everything must work with no cloud set up.
- **Cloud is opt-in** and runs in the user's own account. No shared Darkroom service, and no user data sent to a third party by default.
- **Say plainly in the UI** when something will leave the machine, and where it goes.

A pull request that sends audio, video or transcripts somewhere new, without an explicit and labelled opt-in, won't be merged.

## Setup

Requirements: Python 3.11+, Node 20.19+ or 22.12+, and full FFmpeg on your `PATH`. See the [README](README.md#install) for FFmpeg on each OS.

```bash
python -m venv .venv
make install
make dev            # backend :8000 + frontend :5173, open http://localhost:5173
```

You don't need an AI provider key to work on most of Darkroom: skip **Analyse** and edit manually.

## Checks

These are what CI runs, and they must pass:

```bash
make lint                                         # TypeScript (tsc --noEmit)
cd frontend && npm run test:coverage && npm run build
cd backend && ../.venv/bin/python -m pytest -q tests
```

- Frontend tests are Vitest + React Testing Library, next to the code as `*.test.ts(x)`. Coverage thresholds in `frontend/vite.config.ts` only go up, and `components/Timeline/` (except `Timeline.tsx`) stays at 100%.
- Backend tests use `tmp_path` and must never download a Whisper model or call an AI provider. Stub them, as `tests/test_takes.py` does.
- The DarkRelay bundle format belongs to [DarkRelay](https://github.com/chaotictoejam/darkrelay). If you change the exporter, keep `tests/bundle_criteria.py` in step with it.

[CLAUDE.md](CLAUDE.md) has a detailed map of the code, the project lifecycle and the known gotchas. It's written for AI coding agents and is just as useful for people.

## Pull requests

- Work on a branch, one logical change per pull request, with an imperative commit subject.
- Add tests for behaviour changes.
- Tick the TODO boxes in the relevant `docs/` plan, and move finished items to **Done** in `ROADMAP.md`.
- Never commit anything from `projects/`. It's user data.

## Reporting security issues

Please don't open a public issue. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE), the same license as the project.
