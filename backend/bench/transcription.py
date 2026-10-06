"""
transcription.py — benchmark local transcription: wall time, speed and word error rate

Plan and results: docs/fast-transcription.md (Phase 0). How to run it, the
datasets it downloads, sharing results and running on AWS: bench/README.md.

    cd backend
    ../.venv/bin/pip install -e ".[bench]"
    ../.venv/bin/python bench/transcription.py prepare            # download + cut the test set
    ../.venv/bin/python bench/transcription.py run baseline app@turbo app@distil-large-v3.5
    ../.venv/bin/python bench/transcription.py export             # scores (no transcripts) → bench/results/
    ../.venv/bin/python bench/transcription.py report

Test set (public, with human reference transcripts):
  solo   one complete TED talk (TED-LIUM 3 long-form, via distil-whisper/tedlium-long-form)
  2-mic  the two headset mics of AMI meeting TS3003b, N minutes from 25:00, where
         those two speakers hold a conversation (the other two say little)
  4-mic  all four headset mics of AMI meeting ES2004a, N minutes from 7:00
AMI headsets pick up the other people in the room, so the multi-mic items have
real crosstalk; words bled in from another speaker count as insertions.

Configurations are named ``<settings>@<model>``:
  baseline     the code before Phase 1: medium, float32, no VAD, sequential,
               model reloaded for every track, no_speech_prob filter on its own
  app          the app's own transcribe_file() (whatever the current code does)
  other        dash-separated settings: fp32 | int8 | fp16, vad, b<batch size>
               (batched pipeline; omit for sequential), t<cpu threads>, old
               (pre-Phase 1 no_speech filter), ts (batched with timestamp
               tokens, as first shipped in Phase 1: drops speech), e.g. int8-vad-b8-t6@turbo
Each configuration × item runs in a fresh process, so model loads and peak
memory are measured cleanly.
"""

import argparse
import json
import os
import platform
import re
import resource
import signal
import subprocess
import sys
import time
import urllib.request
import wave
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime
from pathlib import Path

DATA_DIR = Path(os.environ.get("DARKROOM_BENCH_DIR", Path.home() / ".cache" / "darkroom" / "bench"))
RAW_DIR = DATA_DIR / "raw"
RESULTS_DIR = DATA_DIR / "results"  # holds transcripts of the test set, so kept out of the repo
# Committed results: timings and scores only, no transcripts (`export` writes them)
SUMMARY_DIR = Path(__file__).parent / "results"

_AMI_AUDIO = "https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/{meeting}/audio/{meeting}.Headset-{ch}.wav"
_AMI_ANNOTATIONS = "https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/ami_public_manual_1.6.2.zip"
_TEDLIUM = ("https://huggingface.co/datasets/distil-whisper/tedlium-long-form/resolve/main/"
            "data/validation-00000-of-00001-9ed099229d0cbe10.parquet")

SOLO_TALK = "Craig_Venter"
# (kind, meeting, mics, start seconds): windows chosen so the speakers kept talk a lot
AMI_ITEMS = (("2-mic", "TS3003b", 2, 1500), ("4-mic", "ES2004a", 4, 420))

_SAMPLE_RATE = 16000


# ── Test set ──────────────────────────────────────────────────────────────────

def _download(url: str, dest: Path) -> Path:
    if not dest.exists():
        print(f"  downloading {url}")
        tmp = dest.with_suffix(dest.suffix + ".part")
        with urllib.request.urlopen(url) as res, open(tmp, "wb") as f:
            while chunk := res.read(1 << 20):
                f.write(chunk)
        tmp.rename(dest)
    return dest


def _cut(src: Path, dest: Path, seconds: float | None, start: float = 0) -> None:
    """Mono 16 kHz WAV, optionally only ``seconds`` from ``start``."""
    cmd = ["ffmpeg", "-v", "error", "-y", "-ss", str(start), "-i", str(src)]
    if seconds:
        cmd += ["-t", str(seconds)]
    subprocess.run(cmd + ["-ac", "1", "-ar", str(_SAMPLE_RATE), str(dest)], check=True)


def _ami_tracks(meeting: str, zf: zipfile.ZipFile, start: float, seconds: float) -> list[dict]:
    """Every headset of an AMI meeting with that speaker's reference words in the window."""
    meetings = ET.fromstring(zf.read("corpusResources/meetings.xml"))
    tracks = []
    for m in meetings:
        if m.get("observation") != meeting:
            continue
        for spk in m:
            agent, channel = spk.get("nxt_agent"), spk.get("channel")
            words = ET.fromstring(zf.read(f"words/{meeting}.{agent}.words.xml"))
            ref = []  # [start, end, word], seconds from the start of the excerpt
            for w in words:
                if w.tag != "w" or w.get("punc") == "true" or not w.text or not w.get("starttime"):
                    continue
                t0 = float(w.get("starttime"))
                t1 = float(w.get("endtime") or t0)
                if start <= t0 and t1 <= start + seconds:
                    ref.append([round(t0 - start, 2), round(t1 - start, 2), w.text])
            tracks.append({"speaker": agent, "channel": channel,
                           "ref": " ".join(w for *_, w in ref), "ref_words": ref})
    return sorted(tracks, key=lambda t: t["channel"])


def prepare(minutes: float) -> Path:
    seconds = minutes * 60
    out = DATA_DIR / "sets" / f"{minutes:g}min"
    out.mkdir(parents=True, exist_ok=True)
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    items = []

    # Solo: one whole TED talk (references are per talk, so it isn't cut)
    import pyarrow.parquet as pq

    table = pq.read_table(_download(_TEDLIUM, RAW_DIR / "tedlium-validation.parquet"))
    row = next(r for r in table.to_pylist() if r["speaker_id"] == SOLO_TALK)
    if not (out / f"solo_{SOLO_TALK}.wav").exists():
        raw_talk = RAW_DIR / f"{SOLO_TALK}.wav"
        raw_talk.write_bytes(row["audio"]["bytes"])
        _cut(raw_talk, out / f"solo_{SOLO_TALK}.wav", None)
    items.append({"id": f"solo-{SOLO_TALK}", "kind": "solo", "source": "TED-LIUM 3 (CC BY-NC-ND 3.0)",
                  "tracks": [{"path": f"solo_{SOLO_TALK}.wav", "speaker": "A", "ref": row["text"]}]})

    zf = zipfile.ZipFile(_download(_AMI_ANNOTATIONS, RAW_DIR / "ami_public_manual_1.6.2.zip"))
    for kind, meeting, count, start in AMI_ITEMS:
        tracks = _ami_tracks(meeting, zf, start, seconds)
        # The busiest speakers, so a 2-mic item is mostly a conversation between them
        tracks = sorted(tracks, key=lambda t: -len(t["ref"].split()))[:count]
        for t in tracks:
            raw = _download(_AMI_AUDIO.format(meeting=meeting, ch=t["channel"]),
                            RAW_DIR / f"{meeting}.Headset-{t['channel']}.wav")
            t["path"] = f"{kind}_{meeting}_{t['speaker']}.wav"
            if not (out / t["path"]).exists():
                _cut(raw, out / t["path"], seconds, start)
        items.append({"id": f"{kind}-{meeting}", "kind": kind, "source": "AMI Meeting Corpus (CC BY 4.0)", "start_s": start,
                      "tracks": sorted(tracks, key=lambda t: t["speaker"])})

    for item in items:
        item["audio_s"] = round(sum(_wav_seconds(out / t["path"]) for t in item["tracks"]), 1)
    (out / "manifest.json").write_text(json.dumps({"minutes": minutes, "items": items}, indent=2))
    for item in items:
        words = sum(len(t["ref"].split()) for t in item["tracks"])
        print(f"  {item['id']}: {len(item['tracks'])} track(s), {item['audio_s'] / 60:.1f} min audio, {words} ref words")
    return out


def _wav_seconds(path: Path) -> float:
    with wave.open(str(path), "rb") as wf:
        return wf.getnframes() / wf.getframerate()


# ── Configurations ────────────────────────────────────────────────────────────

def parse_config(spec: str) -> dict:
    settings, _, model = spec.partition("@")
    if settings == "baseline":
        return {"spec": spec, "kind": "custom", "model": model or "medium", "compute": "default",
                "vad": False, "batch": 0, "threads": 0, "old_filter": True, "reload": True}
    if settings == "app":
        return {"spec": spec, "kind": "app", "model": model or "turbo"}
    cfg = {"spec": spec, "kind": "custom", "model": model or "turbo", "compute": "default",
           "vad": False, "batch": 0, "threads": 0, "old_filter": False, "reload": False}
    for tok in settings.split("-"):
        if tok in ("fp32", "int8", "fp16"):
            cfg["compute"] = {"fp32": "float32", "int8": "int8", "fp16": "float16"}[tok]
        elif tok == "vad":
            cfg["vad"] = True
        elif tok == "old":
            cfg["old_filter"] = True
        elif tok == "ts":
            cfg["timestamps"] = True
        elif re.fullmatch(r"b\d+", tok):
            cfg["batch"] = int(tok[1:])
        elif re.fullmatch(r"t\d+", tok):
            cfg["threads"] = int(tok[1:])
        else:
            raise SystemExit(f"Unknown setting {tok!r} in {spec!r}")
    return cfg


# ── Worker (one configuration × one item, in its own process) ─────────────────

def _custom_transcribe(cfg: dict, path: str, model_holder: dict) -> tuple[list, float]:
    """Transcribe with explicit settings; returns (segments, model load seconds)."""
    from faster_whisper import BatchedInferencePipeline, WhisperModel

    from darkroom.services import transcription as tr

    load_s = 0.0
    if cfg["reload"] or "model" not in model_holder:
        t = time.perf_counter()
        model_holder["model"] = WhisperModel(cfg["model"], device="auto", compute_type=cfg["compute"],
                                             cpu_threads=cfg["threads"])
        load_s = time.perf_counter() - t
    model = model_holder["model"]

    wav = tr._extract_audio(path)
    try:
        audio = tr._wav_to_numpy(wav)
    finally:
        os.unlink(wav)

    opts = dict(language="en", word_timestamps=True, temperature=0, condition_on_previous_text=False,
                no_speech_threshold=0.5, log_prob_threshold=-1.0, compression_ratio_threshold=2.4)
    if cfg["batch"]:
        segs, _ = BatchedInferencePipeline(model).transcribe(
            audio, batch_size=cfg["batch"], vad_filter=cfg["vad"],
            without_timestamps=not cfg.get("timestamps", False), **opts)
    else:
        segs, _ = model.transcribe(audio, vad_filter=cfg["vad"], **opts)

    kept = []
    for s in segs:
        if cfg["old_filter"]:
            if s.no_speech_prob > 0.5:
                continue
        elif s.no_speech_prob > 0.5 and s.avg_logprob < -1.0:
            continue
        if s.compression_ratio > 2.4:
            continue
        kept.append({"start": s.start, "end": s.end, "text": s.text.strip(),
                     "words": [{"word": w.word, "start": w.start, "end": w.end} for w in (s.words or [])]})
    return tr._filter_hallucinations(kept), load_s


def worker(cfg: dict, item: dict, set_dir: Path) -> dict:
    from darkroom.services import transcription as tr

    model_holder: dict = {}
    tracks = []
    load_total = 0.0
    if cfg["kind"] == "app":
        t = time.perf_counter()
        tr.get_model(cfg["model"])
        load_total = time.perf_counter() - t
    t_item = time.perf_counter()
    for track in item["tracks"]:
        path = str(set_dir / track["path"])
        t = time.perf_counter()
        if cfg["kind"] == "app":
            segs = tr.transcribe_file(path, track["speaker"], track["speaker"], cfg["model"], language="en")
            load_s = 0.0
        else:
            segs, load_s = _custom_transcribe(cfg, path, model_holder)
        load_total += load_s
        tracks.append({"speaker": track["speaker"], "audio_s": round(_wav_seconds(Path(path)), 2),
                       "wall_s": round(time.perf_counter() - t, 2),
                       "hyp": " ".join(s["text"] for s in segs),
                       "hyp_words": [[round(w["start"], 2), round(w["end"], 2), w["word"]]
                                     for s in segs for w in s["words"]]})
    transcribe_s = time.perf_counter() - t_item
    if cfg["kind"] == "app":
        transcribe_s += load_total  # load timed separately above; include it in the total
        m = tr.get_model(cfg["model"]).model
        device = (m.device, m.compute_type)
    else:
        m = model_holder["model"].model
        device = (m.device, m.compute_type)

    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    peak_gb = rss / 1e9 if sys.platform == "darwin" else rss / 1e6  # bytes on macOS, KiB on Linux
    return {"device": device[0], "compute_type": device[1], "load_s": round(load_total, 2),
            "wall_s": round(transcribe_s, 2), "peak_ram_gb": round(peak_gb, 2), "tracks": tracks}


# ── Scoring ───────────────────────────────────────────────────────────────────

# Gating: a speaker's regions are their reference words, joined across gaps
# shorter than _GATE_JOIN_S and padded by _GATE_PAD_S
_GATE_JOIN_S = 1.0
_GATE_PAD_S = 0.5


def _speech_regions(ref_words: list) -> list[tuple[float, float]]:
    regions: list[list[float]] = []
    for t0, t1, _ in sorted(ref_words):
        if regions and t0 - regions[-1][1] < _GATE_JOIN_S:
            regions[-1][1] = max(regions[-1][1], t1)
        else:
            regions.append([t0, t1])
    return [(a - _GATE_PAD_S, b + _GATE_PAD_S) for a, b in regions]


def _gated(hyp_words: list, regions: list[tuple[float, float]]) -> str:
    """Only the transcribed words whose midpoint falls in the speaker's own speech."""
    return " ".join(w for t0, t1, w in hyp_words if any(a <= (t0 + t1) / 2 <= b for a, b in regions))


def _wer(pairs: list[tuple[str, str]]) -> dict:
    import jiwer

    pairs = [(r, h) for r, h in pairs if r.strip()]
    out = jiwer.process_words([r for r, _ in pairs], [h for _, h in pairs])
    n = out.hits + out.substitutions + out.deletions
    return {"wer": round(out.wer, 4), "ref_words": n,
            "sub": out.substitutions, "del": out.deletions, "ins": out.insertions}


def score(item: dict, tracks: list[dict]) -> dict:
    """Corpus WER over the item's tracks, after Whisper's English normaliser.

    ``wer`` scores everything transcribed on each mic, so on multi-mic items
    words bled in from other speakers count as insertions. ``gated_wer`` keeps
    only words inside the speaker's own (reference) speech: the best a per-mic
    gate could do (Phase 2). Solo items have no word times, so it equals ``wer``.
    """
    from whisper_normalizer.english import EnglishTextNormalizer

    norm = EnglishTextNormalizer()
    refs = {t["speaker"]: t for t in item["tracks"]}
    res = _wer([(norm(refs[t["speaker"]]["ref"]), norm(t["hyp"])) for t in tracks])
    gated = []
    for t in tracks:
        ref = refs[t["speaker"]]
        if ref.get("ref_words") is None or "hyp_words" not in t:
            gated = None
            break
        gated.append((norm(ref["ref"]), norm(_gated(t["hyp_words"], _speech_regions(ref["ref_words"])))))
    g = _wer(gated) if gated is not None else res
    res.update(gated_wer=g["wer"], gated_errors=g["sub"] + g["del"] + g["ins"])
    return res


# ── Commands ──────────────────────────────────────────────────────────────────

def _gpu_name() -> str | None:
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
                             capture_output=True, text=True, timeout=10).stdout.strip()
        return out.splitlines()[0] if out else None
    except (OSError, subprocess.SubprocessError):
        return None


def machine(label: str) -> dict:
    import ctranslate2
    import faster_whisper

    cpu = platform.processor()
    try:
        cpu = next(line.split(":", 1)[1].strip() for line in open("/proc/cpuinfo") if line.startswith("model name"))
    except (OSError, StopIteration):
        if sys.platform == "darwin":
            cpu = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True).stdout.strip()
    try:
        ram = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1e9
    except (AttributeError, ValueError, OSError):
        ram = None
    return {"host": label, "os": f"{platform.system()} {platform.release()}", "cpu": cpu,
            "logical_cpus": os.cpu_count(), "ram_gb": round(ram, 1) if ram else None,
            "cuda_devices": ctranslate2.get_cuda_device_count(), "gpu": _gpu_name(),
            "faster_whisper": faster_whisper.__version__, "ctranslate2": ctranslate2.__version__}


def _load_set(minutes: float) -> tuple[Path, dict]:
    set_dir = DATA_DIR / "sets" / f"{minutes:g}min"
    manifest = set_dir / "manifest.json"
    if not manifest.exists():
        raise SystemExit(f"No test set at {set_dir}; run `prepare --minutes {minutes:g}` first")
    return set_dir, json.loads(manifest.read_text())


def run(specs: list[str], minutes: float, kinds: list[str] | None, label: str, out: Path | None) -> None:
    set_dir, manifest = _load_set(minutes)
    items = [i for i in manifest["items"] if not kinds or i["kind"] in kinds]
    info = machine(label)
    out = out or RESULTS_DIR / f"{label}.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    for spec in specs:
        cfg = parse_config(spec)
        for item in items:
            print(f"{spec:28} {item['id']:20} ", end="", flush=True)
            # faulthandler prints a traceback if the worker crashes in native code
            proc = subprocess.run([sys.executable, "-X", "faulthandler", __file__, "_worker",
                                   json.dumps(cfg), json.dumps(item), str(set_dir)],
                                  capture_output=True, text=True)
            if proc.returncode != 0:
                rc = proc.returncode
                how = f"signal {signal.Signals(-rc).name}" if rc < 0 else f"exit {rc}"
                tail = (proc.stderr.strip() or proc.stdout.strip() or "(no output)")[-3000:]
                print(f"FAILED ({how})\n{tail}")
                continue
            res = json.loads(proc.stdout.strip().splitlines()[-1])
            res.update(score(item, res["tracks"]))
            row = {"time": datetime.now().isoformat(timespec="seconds"), "machine": info, "config": cfg,
                   "minutes": minutes, "item": item["id"], "kind": item["kind"], "audio_s": item["audio_s"], **res}
            with open(out, "a") as f:
                f.write(json.dumps(row) + "\n")
            print(f"{res['wall_s']:7.1f} s  {item['audio_s'] / res['wall_s']:5.2f}× real time  "
                  f"WER {res['wer'] * 100:5.1f}%  load {res['load_s']:.1f} s  RAM {res['peak_ram_gb']:.1f} GB")


def _rescored(paths: list[Path]) -> list[dict]:
    """Result rows, rescored from their transcripts (when they have them) with the current scoring."""
    rows = [json.loads(line) for p in paths for line in p.read_text().splitlines() if line.strip()]
    manifests: dict[float, dict] = {}
    for r in rows:
        if "hyp" not in r["tracks"][0]:
            continue  # an exported summary: already scored
        if r["minutes"] not in manifests:
            manifests[r["minutes"]] = {i["id"]: i for i in _load_set(r["minutes"])[1]["items"]}
        r.update(score(manifests[r["minutes"]][r["item"]], r["tracks"]))
    return rows


def export(paths: list[Path]) -> None:
    """Write each machine's results without transcripts to bench/results/<host>.jsonl.

    The test set's transcripts can't be redistributed (TED-LIUM is CC BY-NC-ND),
    so only timings, scores and machine details are committed.
    """
    by_host: dict[str, list[dict]] = {}
    for r in _rescored(paths):
        r["tracks"] = [{k: v for k, v in t.items() if k not in ("hyp", "hyp_words")} for t in r["tracks"]]
        by_host.setdefault(r["machine"]["host"], []).append(r)
    SUMMARY_DIR.mkdir(exist_ok=True)
    for host, rows in by_host.items():
        out = SUMMARY_DIR / f"{host}.jsonl"
        out.write_text("".join(json.dumps(r) + "\n" for r in rows))
        print(f"  {len(rows)} results → {out}")


def report(paths: list[Path]) -> None:
    rows = _rescored(paths)
    by_cfg: dict[tuple, dict] = {}
    for r in rows:  # latest run of each (machine, config, item) wins
        by_cfg.setdefault((r["machine"]["host"], r["config"]["spec"], r["minutes"]), {})[r["item"]] = r
    kinds = ["solo", "2-mic", "4-mic"]
    header = (["Machine", "Config", "Device"] + [f"{k}: × real time · WER (gated)" for k in kinds]
              + ["Total wall", "Overall × real time", "Pooled gated WER", "Load", "Peak RAM"])
    print("| " + " | ".join(header) + " |")
    print("|" + "---|" * len(header))
    for (host, spec, _minutes), items in by_cfg.items():
        cells = []
        for k in kinds:
            r = next((r for r in items.values() if r["kind"] == k), None)
            if not r:
                cells.append("–")
            elif k == "solo":
                cells.append(f"{r['audio_s'] / r['wall_s']:.2f}× · {r['wer'] * 100:.1f}%")
            else:
                cells.append(f"{r['audio_s'] / r['wall_s']:.2f}× · {r['wer'] * 100:.1f}% ({r['gated_wer'] * 100:.1f}%)")
        rs = list(items.values())
        audio, wall = sum(r["audio_s"] for r in rs), sum(r["wall_s"] for r in rs)
        errs = sum(r["gated_errors"] for r in rs)
        words = sum(r["ref_words"] for r in rs)
        load = max(r["load_s"] for r in rs)
        ram = max(r["peak_ram_gb"] for r in rs)
        print(f"| {host} | `{spec}` | {rs[0]['device']} {rs[0]['compute_type']} | " + " | ".join(cells)
              + f" | {wall / 60:.1f} min | {audio / wall:.2f}× | {errs / max(words, 1) * 100:.1f}% | {load:.1f} s | {ram:.1f} GB |")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prepare", help="download and cut the test set")
    p.add_argument("--minutes", type=float, default=10, help="length of the multi-mic excerpts")
    p = sub.add_parser("run", help="benchmark configurations")
    p.add_argument("configs", nargs="+")
    p.add_argument("--minutes", type=float, default=10)
    p.add_argument("--kinds", nargs="*", choices=["solo", "2-mic", "4-mic"])
    p.add_argument("--label", default=platform.node(),
                   help="machine name in the results and their file name (default: hostname)")
    p.add_argument("--out", type=Path, help="results file (default: <cache>/results/<label>.jsonl)")
    p = sub.add_parser("export", help="write results without transcripts to bench/results/")
    p.add_argument("files", nargs="*", type=Path)
    p = sub.add_parser("report", help="markdown table of results (local, else committed)")
    p.add_argument("files", nargs="*", type=Path)
    p = sub.add_parser("_worker")
    p.add_argument("cfg")
    p.add_argument("item")
    p.add_argument("set_dir", type=Path)
    a = ap.parse_args()

    if a.cmd == "prepare":
        print(f"Test set in {prepare(a.minutes)}")
    elif a.cmd == "run":
        run(a.configs, a.minutes, a.kinds, a.label, a.out)
    elif a.cmd == "export":
        export(a.files or sorted(RESULTS_DIR.glob("*.jsonl")))
    elif a.cmd == "report":
        report(a.files or sorted(RESULTS_DIR.glob("*.jsonl")) or sorted(SUMMARY_DIR.glob("*.jsonl")))
    else:
        print(json.dumps(worker(json.loads(a.cfg), json.loads(a.item), a.set_dir)))


if __name__ == "__main__":
    main()
