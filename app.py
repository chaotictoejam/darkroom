"""
app.py — Flask server + API routes for Darkroom
"""

import json
import threading
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory

from editor import build_prompt, generate_edl, generate_skip_edl
from processor import merge_transcripts, transcribe_all
from renderer import check_ffmpeg, render_project, render_short_custom

load_dotenv()

app = Flask(__name__, static_folder="static")

PROJECTS_DIR = Path(__file__).parent / "projects"
PROJECTS_DIR.mkdir(exist_ok=True)

ffmpeg_available = check_ffmpeg()
if not ffmpeg_available:
    print("⚠  WARNING: FFmpeg not found. Rendering will be unavailable.")


# ---------------------------------------------------------------------------
# Project persistence helpers
# ---------------------------------------------------------------------------

def _project_path(project_id: str) -> Path:
    return PROJECTS_DIR / project_id / "project.json"


def get_project(project_id: str) -> dict | None:
    path = _project_path(project_id)
    if not path.exists():
        return None
    with open(path) as f:
        return json.load(f)


def save_project(project: dict) -> None:
    path = _project_path(project["id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(project, f, indent=2)


def _new_project(name: str) -> dict:
    return {
        "id": uuid.uuid4().hex[:8],
        "name": name,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": "created",
        "speakers": [],
        "transcripts": {},
        "merged_transcript": [],
        "edl": None,
        "renders": {},
        "progress": {"step": "", "percent": 0, "message": ""},
    }


# ---------------------------------------------------------------------------
# Static + system routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/api/status")
def api_status():
    return jsonify({
        "ffmpeg_available": ffmpeg_available,
    })


# ---------------------------------------------------------------------------
# Project CRUD
# ---------------------------------------------------------------------------

@app.route("/api/projects", methods=["GET"])
def list_projects():
    projects = []
    for d in sorted(PROJECTS_DIR.iterdir(), reverse=True):
        if d.is_dir():
            proj = get_project(d.name)
            if proj:
                projects.append({
                    "id": proj["id"],
                    "name": proj["name"],
                    "status": proj["status"],
                    "created_at": proj["created_at"],
                })
    return jsonify(projects)


@app.route("/api/projects", methods=["POST"])
def create_project():
    data = request.get_json(force=True) or {}
    project = _new_project(data.get("name", "Untitled Project"))
    save_project(project)
    return jsonify(project), 201


@app.route("/api/projects/<project_id>", methods=["GET"])
def get_project_route(project_id):
    proj = get_project(project_id)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    return jsonify(proj)


@app.route("/api/projects/<project_id>", methods=["DELETE"])
def delete_project(project_id):
    import shutil
    path = PROJECTS_DIR / project_id
    if path.exists():
        shutil.rmtree(str(path))
    return jsonify({"ok": True})


@app.route("/api/projects/<project_id>/reset-edl", methods=["POST"])
def reset_edl(project_id):
    """Clear the EDL and renders, returning the project to transcribed state for re-analysis."""
    proj = get_project(project_id)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    if not proj.get("merged_transcript"):
        return jsonify({"error": "No transcript — transcribe first"}), 400

    import shutil
    output_dir = PROJECTS_DIR / project_id / "output"
    if output_dir.exists():
        shutil.rmtree(str(output_dir))

    proj["edl"] = None
    proj["renders"] = {}
    proj["status"] = "transcribed"
    proj["progress"] = {"step": "done", "percent": 100, "message": "Transcription complete ✓"}
    save_project(proj)
    return jsonify(proj)


@app.route("/api/projects/<project_id>/reset", methods=["POST"])
def reset_project(project_id):
    """Reset a project back to uploaded state — keeps video files, clears everything else."""
    import shutil
    proj = get_project(project_id)
    if not proj:
        return jsonify({"error": "Project not found"}), 404

    # Delete rendered outputs
    output_dir = PROJECTS_DIR / project_id / "output"
    if output_dir.exists():
        shutil.rmtree(str(output_dir))

    proj["status"] = "uploaded"
    proj["transcripts"] = {}
    proj["merged_transcript"] = []
    proj["edl"] = None
    proj["renders"] = {}
    proj["progress"] = {"step": "uploaded", "percent": 0, "message": "Ready to transcribe"}
    save_project(proj)
    return jsonify(proj)


# ---------------------------------------------------------------------------
# File upload
# ---------------------------------------------------------------------------

@app.route("/api/projects/<project_id>/upload", methods=["POST"])
def upload_files(project_id):
    proj = get_project(project_id)
    if not proj:
        return jsonify({"error": "Project not found"}), 404

    project_dir = PROJECTS_DIR / project_id
    project_dir.mkdir(exist_ok=True)

    files = request.files.getlist("files")
    names = request.form.getlist("names")
    language = request.form.get("language", "").strip() or None
    model = request.form.get("model", "").strip() or "medium"
    cam_ids = ["A", "B", "C", "D"]

    speakers = []
    for i, (f, name) in enumerate(zip(files, names)):
        cam_id = cam_ids[i]
        # Sanitise filename
        safe_name = "".join(c for c in f.filename if c.isalnum() or c in "._- ").strip()
        filename = f"cam_{cam_id}_{safe_name}"
        filepath = project_dir / filename
        f.save(str(filepath))
        speakers.append({
            "id": cam_id,
            "name": name.strip() or f"Speaker {cam_id}",
            "file": filename,
            "file_path": str(filepath),
        })

    proj["speakers"] = speakers
    proj["transcribe_language"] = language
    proj["transcribe_model"] = model
    proj["status"] = "uploaded"
    proj["progress"] = {"step": "uploaded", "percent": 0, "message": "Files uploaded"}
    save_project(proj)
    return jsonify(proj)


# ---------------------------------------------------------------------------
# Transcription
# ---------------------------------------------------------------------------

@app.route("/api/projects/<project_id>/transcribe", methods=["POST"])
def start_transcription(project_id):
    proj = get_project(project_id)
    if not proj:
        return jsonify({"error": "Project not found"}), 404

    def _run():
        try:
            p = get_project(project_id)
            # Reset any prior analysis so the project goes back through the pipeline
            p["status"] = "transcribing"
            p["transcripts"] = {}
            p["merged_transcript"] = []
            p["edl"] = None
            p["progress"] = {"step": "transcribing", "percent": 5, "message": "Loading Whisper model..."}
            save_project(p)

            model_name = p.get("transcribe_model") or "medium"
            language = p.get("transcribe_language") or None
            total = len(p["speakers"])

            def _progress(i, total, name):
                pct = int(10 + (i / total) * 55)
                q = get_project(project_id)
                q["progress"] = {
                    "step": "transcribing",
                    "percent": pct,
                    "message": f"Transcribing {name} ({i + 1}/{total})…",
                }
                save_project(q)

            transcripts = transcribe_all(p["speakers"], model_name, _progress, language=language)

            p = get_project(project_id)
            p["transcripts"] = transcripts
            p["progress"] = {"step": "merging", "percent": 70, "message": "Merging transcripts…"}
            save_project(p)

            merged = merge_transcripts(transcripts, p["speakers"])
            p["merged_transcript"] = merged
            p["status"] = "transcribed"
            p["progress"] = {"step": "done", "percent": 100, "message": "Transcription complete ✓"}
            save_project(p)

        except Exception as exc:
            q = get_project(project_id)
            if q:
                q["status"] = "error"
                q["progress"] = {"step": "error", "percent": 0, "message": traceback.format_exc()}
                save_project(q)

    threading.Thread(target=_run, daemon=True).start()
    return jsonify({"message": "Transcription started"})


# ---------------------------------------------------------------------------
# AI Analysis (EDL generation)
# ---------------------------------------------------------------------------

@app.route("/api/projects/<project_id>/analyze", methods=["POST"])
def analyze_project(project_id):
    proj = get_project(project_id)
    if not proj:
        return jsonify({"error": "Project not found"}), 404

    def _run():
        try:
            p = get_project(project_id)
            p["status"] = "analyzing"
            p["progress"] = {"step": "analyzing", "percent": 10, "message": "Sending transcript to Claude…"}
            save_project(p)

            edl = generate_edl(p["merged_transcript"], p["speakers"])

            p = get_project(project_id)
            p["edl"] = edl
            p["status"] = "ready"
            p["progress"] = {"step": "done", "percent": 100, "message": "Analysis complete ✓"}
            save_project(p)

        except Exception as exc:
            q = get_project(project_id)
            if q:
                q["status"] = "error"
                q["progress"] = {"step": "error", "percent": 0, "message": traceback.format_exc()}
                save_project(q)

    threading.Thread(target=_run, daemon=True).start()
    return jsonify({"message": "Analysis started"})


# ---------------------------------------------------------------------------
# Analysis alternatives
# ---------------------------------------------------------------------------

@app.route("/api/projects/<project_id>/prompt", methods=["GET"])
def get_prompt(project_id):
    """Return the Claude prompt so the user can paste it into Claude Code."""
    proj = get_project(project_id)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    if not proj.get("merged_transcript"):
        return jsonify({"error": "No transcript yet"}), 400
    prompt = build_prompt(proj["merged_transcript"], proj["speakers"])
    return jsonify({"prompt": prompt})


@app.route("/api/projects/<project_id>/skip-analysis", methods=["POST"])
def skip_analysis(project_id):
    """Generate a keep-all EDL with no AI edits."""
    proj = get_project(project_id)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    edl = generate_skip_edl(proj["merged_transcript"], proj["speakers"])
    proj["edl"] = edl
    proj["status"] = "ready"
    proj["progress"] = {"step": "done", "percent": 100, "message": "Skipped analysis — all segments kept"}
    save_project(proj)
    return jsonify(proj)


@app.route("/api/projects/<project_id>/import-edl", methods=["POST"])
def import_edl(project_id):
    """Accept a user-supplied EDL JSON (from Claude Code paste) and mark project ready."""
    proj = get_project(project_id)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    data = request.get_json(force=True)
    edl = data.get("edl")
    if not edl:
        return jsonify({"error": "No 'edl' key in request body"}), 400
    # Basic validation
    if "segments" not in edl or "clips" not in edl:
        return jsonify({"error": "EDL must have 'segments' and 'clips' keys"}), 400
    proj["edl"] = edl
    proj["status"] = "ready"
    proj["progress"] = {"step": "done", "percent": 100, "message": "EDL imported ✓"}
    save_project(proj)
    return jsonify(proj)


# ---------------------------------------------------------------------------
# Transcript editing
# ---------------------------------------------------------------------------

@app.route("/api/projects/<project_id>/transcript/<int:seg_index>", methods=["PATCH"])
def update_transcript_segment(project_id, seg_index):
    proj = get_project(project_id)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    mt = proj.get("merged_transcript", [])
    if seg_index < 0 or seg_index >= len(mt):
        return jsonify({"error": "Segment index out of range"}), 400

    data = request.get_json(force=True) or {}
    new_text = data.get("text", "").strip()
    seg = mt[seg_index]
    seg["text"] = new_text

    # Remap word-level timestamps: distribute evenly across segment duration
    words = [w for w in new_text.split() if w]
    if words:
        duration = seg["end"] - seg["start"]
        step = duration / len(words)
        seg["words"] = [
            {"word": " " + w, "start": seg["start"] + i * step, "end": seg["start"] + (i + 1) * step}
            for i, w in enumerate(words)
        ]
    else:
        seg["words"] = []

    proj["merged_transcript"] = mt
    save_project(proj)
    return jsonify({"ok": True, "segment": seg})


# ---------------------------------------------------------------------------
# EDL editing (user modifications)
# ---------------------------------------------------------------------------

@app.route("/api/projects/<project_id>/edl", methods=["PUT"])
def update_edl(project_id):
    proj = get_project(project_id)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    proj["edl"] = request.get_json(force=True)
    save_project(proj)
    return jsonify(proj)


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

@app.route("/api/projects/<project_id>/render", methods=["POST"])
def start_render(project_id):
    proj = get_project(project_id)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    if not ffmpeg_available:
        return jsonify({"error": "FFmpeg not found on this system"}), 503

    data = request.get_json(force=True) or {}
    targets = data.get("targets", ["fullEdit"])
    camera_layout = data.get("camera_layout", "edl")
    cam_order = data.get("cam_order", None)

    def _run():
        try:
            p = get_project(project_id)
            p["status"] = "rendering"
            p["progress"] = {"step": "rendering", "percent": 5, "message": f"Rendering {', '.join(targets)}…"}
            save_project(p)

            results = render_project(p, targets, PROJECTS_DIR,
                                     camera_layout=camera_layout,
                                     cam_order=cam_order)

            p = get_project(project_id)
            p["renders"].update(results)
            errors = [t for t, r in results.items() if r.get("status") == "error"]
            p["status"] = "ready"
            if errors:
                p["progress"] = {
                    "step": "error",
                    "percent": 100,
                    "message": f"Render finished with errors: {', '.join(errors)}",
                }
            else:
                p["progress"] = {"step": "done", "percent": 100, "message": "Render complete ✓"}
            save_project(p)

        except Exception as exc:
            q = get_project(project_id)
            if q:
                q["status"] = "error"
                q["progress"] = {"step": "error", "percent": 0, "message": traceback.format_exc()}
                save_project(q)

    threading.Thread(target=_run, daemon=True).start()
    return jsonify({"message": "Render started"})


# ---------------------------------------------------------------------------
# Custom short rendering (Shorts Builder)
# ---------------------------------------------------------------------------

@app.route("/api/projects/<project_id>/render-short", methods=["POST"])
def start_render_short(project_id):
    proj = get_project(project_id)
    if not proj:
        return jsonify({"error": "Project not found"}), 404
    if not ffmpeg_available:
        return jsonify({"error": "FFmpeg not found — install it and restart Darkroom"}), 503
    if not proj.get("edl"):
        return jsonify({"error": "No EDL — run analysis first"}), 400

    data = request.get_json(force=True) or {}
    clips = data.get("clips", [])
    subtitle_style = data.get("subtitle_style", "chunk")
    camera_layout = data.get("camera_layout", "active")
    selected_cams = data.get("selected_cams", None)
    accent_color = data.get("accent_color", "#FFFF00")
    sub_position = data.get("sub_position", "auto")
    output_name = data.get("output_name", "short_01")
    box_opacity = max(0, min(100, int(data.get("box_opacity", 100))))
    box_alpha = round((100 - box_opacity) / 100 * 255)

    if not clips:
        return jsonify({"error": "No clips provided"}), 400

    # Sanitise output name
    import re as _re
    output_name = _re.sub(r"[^a-z0-9_\-]", "_", output_name.lower()) or "short_01"

    def _run():
        try:
            p = get_project(project_id)
            p["status"] = "rendering"
            p["progress"] = {
                "step": "rendering",
                "percent": 5,
                "message": f"Rendering short '{output_name}' ({subtitle_style} subtitles)…",
            }
            save_project(p)

            project_dir = PROJECTS_DIR / project_id
            output_dir = project_dir / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            out_path = str(output_dir / f"{output_name}.mp4")
            speakers_dict = {s["id"]: s for s in p["speakers"]}

            # Build ordered speakers dict for split-screen, preserving UI order
            if camera_layout == "all" and selected_cams:
                # selected_cams is an ordered list from the UI drag/reorder
                filtered_speakers = {
                    cam_id: speakers_dict[cam_id]
                    for cam_id in selected_cams
                    if cam_id in speakers_dict
                }
            else:
                filtered_speakers = speakers_dict

            render_short_custom(
                clips=clips,
                edl_segments=p["edl"]["segments"],
                speakers_dict=filtered_speakers,
                subtitle_style=subtitle_style,
                camera_layout=camera_layout,
                accent_color=accent_color,
                sub_position=sub_position,
                merged_transcript=p["merged_transcript"],
                output_path=out_path,
                output_dir=output_dir,
                box_alpha=box_alpha,
            )

            p = get_project(project_id)
            p["renders"][output_name] = {
                "status": "done",
                "url": f"/projects/{project_id}/files/output/{output_name}.mp4",
                "filename": f"{output_name}.mp4",
            }
            p["status"] = "ready"
            p["progress"] = {"step": "done", "percent": 100, "message": f"Short '{output_name}' rendered ✓"}
            save_project(p)

        except Exception as exc:
            q = get_project(project_id)
            if q:
                q["status"] = "error"
                q["progress"] = {"step": "error", "percent": 0, "message": traceback.format_exc()}
                save_project(q)

    threading.Thread(target=_run, daemon=True).start()
    return jsonify({"message": "Short render started"})


# ---------------------------------------------------------------------------
# Serve project files (videos + rendered outputs)
# ---------------------------------------------------------------------------

@app.route("/projects/<project_id>/files/<path:filename>")
def serve_project_file(project_id, filename):
    return send_from_directory(str(PROJECTS_DIR / project_id), filename)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("🔴 Darkroom — starting on http://localhost:5000")
    app.run(debug=True, port=5000, use_reloader=False)
