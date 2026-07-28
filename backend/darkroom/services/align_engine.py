"""
align_engine.py — word-level forced alignment via wav2vec2 CTC models.

faster-whisper's word timestamps come from cross-attention weights, which
are noticeably less precise at word boundaries than a dedicated forced-
alignment pass. This re-aligns each transcript segment's words against the
raw audio using a wav2vec2 CTC model, tightening word start/end times — the
part that actually matters for word-level cuts, karaoke subtitles, and
pause detection, as opposed to plain transcription accuracy.

The trellis/backtrack/merge-repeats DP alignment core below is adapted from
WhisperX (https://github.com/m-bain/whisperX)'s alignment.py, itself based
on the PyTorch forced-alignment tutorial
(https://pytorch.org/tutorials/intermediate/forced_alignment_with_torchaudio_tutorial.html).
WhisperX is BSD-2-Clause licensed, Copyright (c) 2024 Max Bain.

Deliberately NOT using the whisperx package directly: it hard-pins
faster-whisper==1.0.0 / ctranslate2==4.4.0 (conflicting with the versions
this project uses) and unconditionally imports its diarization module
(pyannote.audio and friends) at package load, even when only alignment is
needed. Darkroom doesn't diarize — every track is already speaker-tagged by
camera/mic, not guessed from a mixed signal, so that whole dependency chain
is unnecessary here. This module also skips whisperx's nltk/pandas usage
(sentence-splitting and DataFrame bookkeeping) by working directly off
Darkroom's existing per-word list instead of re-deriving word boundaries
from raw segment text.

Requires the `align` extra: torch, torchaudio, transformers.
"""

from dataclasses import dataclass

SAMPLE_RATE = 16000

# wav2vec2 CTC checkpoints per language. torchaudio ships pretrained bundles
# for a handful of languages; everything else falls back to a community
# fine-tune on Hugging Face (same registry WhisperX uses).
_TORCHAUDIO_BUNDLES = {
    "en": "WAV2VEC2_ASR_BASE_960H",
    "fr": "VOXPOPULI_ASR_BASE_10K_FR",
    "de": "VOXPOPULI_ASR_BASE_10K_DE",
    "es": "VOXPOPULI_ASR_BASE_10K_ES",
    "it": "VOXPOPULI_ASR_BASE_10K_IT",
}

_HUGGINGFACE_CHECKPOINTS = {
    "nl": "jonatasgrosman/wav2vec2-large-xlsr-53-dutch",
    "pt": "jonatasgrosman/wav2vec2-large-xlsr-53-portuguese",
    "pl": "jonatasgrosman/wav2vec2-large-xlsr-53-polish",
    "ru": "jonatasgrosman/wav2vec2-large-xlsr-53-russian",
    "zh": "jonatasgrosman/wav2vec2-large-xlsr-53-chinese-zh-cn",
    "ja": "jonatasgrosman/wav2vec2-large-xlsr-53-japanese",
    "ko": "kresnik/wav2vec2-large-xlsr-korean",
    "ar": "jonatasgrosman/wav2vec2-large-xlsr-53-arabic",
    "hi": "theainerd/Wav2Vec2-large-xlsr-hindi",
}

_align_model_cache: dict[str, tuple] = {}


def alignment_available(language: str | None) -> bool:
    """Whether a wav2vec2 checkpoint is registered for this language at all."""
    lang = (language or "en").lower()
    return lang in _TORCHAUDIO_BUNDLES or lang in _HUGGINGFACE_CHECKPOINTS


def default_device() -> str:
    try:
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"
    except ImportError:
        return "cpu"


def _load_align_model(language: str, device: str):
    cache_key = f"{language}:{device}"
    if cache_key in _align_model_cache:
        return _align_model_cache[cache_key]

    import torchaudio

    if language in _TORCHAUDIO_BUNDLES:
        bundle = getattr(torchaudio.pipelines, _TORCHAUDIO_BUNDLES[language])
        model = bundle.get_model().to(device)
        dictionary = {c.lower(): i for i, c in enumerate(bundle.get_labels())}
        model_type = "torchaudio"
    elif language in _HUGGINGFACE_CHECKPOINTS:
        from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor
        checkpoint = _HUGGINGFACE_CHECKPOINTS[language]
        processor = Wav2Vec2Processor.from_pretrained(checkpoint)
        model = Wav2Vec2ForCTC.from_pretrained(checkpoint).to(device)
        dictionary = {c.lower(): i for c, i in processor.tokenizer.get_vocab().items()}
        model_type = "huggingface"
    else:
        raise ValueError(f"No wav2vec2 alignment model available for language '{language}'")

    model.eval()
    result = (model, dictionary, model_type)
    _align_model_cache[cache_key] = result
    return result


# ── DP forced-alignment core (adapted from WhisperX / the PyTorch tutorial) ────

def _get_trellis(emission, tokens, blank_id=0):
    import torch
    num_frame = emission.size(0)
    num_tokens = len(tokens)
    trellis = torch.empty((num_frame + 1, num_tokens + 1))
    trellis[0, 0] = 0
    trellis[1:, 0] = torch.cumsum(emission[:, 0], 0)
    trellis[0, -num_tokens:] = -float("inf")
    trellis[-num_tokens:, 0] = float("inf")
    for t in range(num_frame):
        trellis[t + 1, 1:] = torch.maximum(
            trellis[t, 1:] + emission[t, blank_id],
            trellis[t, :-1] + emission[t, tokens],
        )
    return trellis


@dataclass
class _Point:
    token_index: int
    time_index: int
    score: float


def _backtrack(trellis, emission, tokens, blank_id=0):
    j = trellis.size(1) - 1
    t_start = int(trellis[:, j].argmax().item())

    path = []
    for t in range(t_start, 0, -1):
        stayed = trellis[t - 1, j] + emission[t - 1, blank_id]
        changed = trellis[t - 1, j - 1] + emission[t - 1, tokens[j - 1]]
        prob = emission[t - 1, tokens[j - 1] if changed > stayed else 0].exp().item()
        path.append(_Point(j - 1, t - 1, prob))
        if changed > stayed:
            j -= 1
            if j == 0:
                break
    else:
        return None
    return path[::-1]


@dataclass
class _Segment:
    label: str
    start: int
    end: int
    score: float

    @property
    def length(self):
        return self.end - self.start


def _merge_repeats(path, tokens_str):
    i1, i2 = 0, 0
    segments = []
    while i1 < len(path):
        while i2 < len(path) and path[i1].token_index == path[i2].token_index:
            i2 += 1
        score = sum(path[k].score for k in range(i1, i2)) / (i2 - i1)
        segments.append(_Segment(tokens_str[path[i1].token_index], path[i1].time_index, path[i2 - 1].time_index + 1, score))
        i1 = i2
    return segments


# ── Segment/word-level orchestration ────────────────────────────────────────

def align_segment_words(
    words: list[dict],
    seg_start: float,
    seg_end: float,
    audio,
    language: str,
    device: str = "cpu",
) -> list[dict]:
    """
    Re-align one transcript segment's words against the raw 16kHz audio.

    words              — this segment's word list [{"word","start","end"}, ...]
                          (word text may include a leading space, matching
                          faster-whisper's convention — used as-is)
    seg_start/seg_end  — this segment's original (coarse) time bounds, seconds
    audio              — full-track mono float32 waveform at SAMPLE_RATE (16kHz)
    language           — ISO code with an entry in _TORCHAUDIO_BUNDLES or
                          _HUGGINGFACE_CHECKPOINTS — check alignment_available()
                          before calling

    Returns a new word list with tightened start/end times. Any word that
    can't be aligned (no dictionary-recognized characters, or the DP
    backtrack fails for the whole segment) keeps its original faster-whisper
    timestamp rather than being dropped.
    """
    import torch

    model, dictionary, model_type = _load_align_model(language, device)

    # Build the dictionary-filtered character stream directly from Darkroom's
    # existing per-word list, tracking which original word each surviving
    # character belongs to. This sidesteps re-deriving word boundaries from
    # a flat text string (WhisperX's approach) since we already have them.
    clean_chars: list[str] = []
    char_word_idx: list[int] = []
    for wdx, w in enumerate(words):
        for ch in w["word"].lower():
            ch2 = "|" if ch == " " else ch
            if ch2 in dictionary:
                clean_chars.append(ch2)
                char_word_idx.append(wdx)

    if not clean_chars:
        return words

    max_duration = len(audio) / SAMPLE_RATE
    if seg_start >= max_duration:
        return words

    tokens = [dictionary[c] for c in clean_chars]
    f1, f2 = int(seg_start * SAMPLE_RATE), int(seg_end * SAMPLE_RATE)
    waveform = torch.from_numpy(audio[f1:f2]).unsqueeze(0)
    lengths = None
    if waveform.shape[-1] < 400:
        lengths = torch.as_tensor([waveform.shape[-1]])
        waveform = torch.nn.functional.pad(waveform, (0, 400 - waveform.shape[-1]))

    with torch.inference_mode():
        if model_type == "torchaudio":
            emissions, _ = model(waveform.to(device), lengths=lengths.to(device) if lengths is not None else None)
        else:
            emissions = model(waveform.to(device)).logits
        emissions = torch.log_softmax(emissions, dim=-1)
    emission = emissions[0].cpu().detach()

    blank_id = 0
    for char, code in dictionary.items():
        if char in ("[pad]", "<pad>"):
            blank_id = code

    trellis = _get_trellis(emission, tokens, blank_id)
    path = _backtrack(trellis, emission, tokens, blank_id)
    if path is None:
        return words  # DP failed to find a valid path — keep original timestamps

    char_segments = _merge_repeats(path, clean_chars)
    num_frame = trellis.size(0) - 1
    ratio = (seg_end - seg_start) / num_frame

    # Bucket aligned character spans back into per-original-word min/max bounds.
    word_bounds: dict[int, list[float]] = {}
    for cdx, seg in enumerate(char_segments):
        if seg.label == "|":
            continue
        wdx = char_word_idx[cdx]
        start = seg.start * ratio + seg_start
        end = seg.end * ratio + seg_start
        bounds = word_bounds.setdefault(wdx, [start, end])
        bounds[0] = min(bounds[0], start)
        bounds[1] = max(bounds[1], end)

    aligned = []
    for i, w in enumerate(words):
        if i in word_bounds:
            start, end = word_bounds[i]
            aligned.append({"word": w["word"], "start": round(start, 3), "end": round(end, 3)})
        else:
            aligned.append(w)  # unaligned — keep faster-whisper's original timestamp
    return aligned
