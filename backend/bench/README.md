# Transcription benchmark

Measures how fast Darkroom transcribes and how accurate the result is, on any machine, so settings and default models can be chosen from numbers rather than guesses. Results so far, and what they mean for the app, are in [docs/fast-transcription.md](../../docs/fast-transcription.md#phase-0-results-cpu).

For each configuration it reports:

- **Speed**, as × real time: audio length ÷ wall time, including model load and audio extraction (4× = a 1-hour track in 15 minutes).
- **WER** (word error rate) against human transcripts, after Whisper's English text normaliser.
- **WER with crosstalk excluded**, for multi-mic recordings: only the words inside each speaker's own speech are scored, so words picked up from another person's mic don't count. This compares models fairly, and is the target for per-mic gating.
- Model load time and peak RAM.

## Test set

Public recordings with human reference transcripts, about 75 minutes of audio in 7 tracks. `prepare` downloads them (about 480 MB) and cuts the excerpts.

| Item | Recording | Tracks | Source | Licence |
|---|---|---|---|---|
| solo | Craig Venter's TED talk, whole talk (15 min) | 1 | [TED-LIUM 3 long-form](https://huggingface.co/datasets/distil-whisper/tedlium-long-form), validation split | [CC BY-NC-ND 3.0](https://creativecommons.org/licenses/by-nc-nd/3.0/) |
| 2-mic | AMI meeting TS3003b, 25:00–35:00: the two speakers in conversation (headsets 0 and 3) | 2 | [AMI Meeting Corpus](https://groups.inf.ed.ac.uk/ami/corpus/) | [CC BY 4.0](https://groups.inf.ed.ac.uk/ami/corpus/license.shtml) |
| 4-mic | AMI meeting ES2004a, 7:00–17:00: all four headsets | 4 | AMI Meeting Corpus | CC BY 4.0 |

AMI headset mics pick up everyone in the room, so the multi-mic items have real crosstalk. The windows were chosen so that every kept speaker talks a lot; the first 10 minutes of most meetings are one person presenting.

### Files `prepare` downloads

Everything goes to `~/.cache/darkroom/bench` (set `DARKROOM_BENCH_DIR` to change it), never into the repo.

| File | URL |
|---|---|
| TED-LIUM long-form, validation (180 MB) | https://huggingface.co/datasets/distil-whisper/tedlium-long-form/resolve/main/data/validation-00000-of-00001-9ed099229d0cbe10.parquet |
| AMI manual annotations 1.6.2 (23 MB): word-level transcripts and the speaker ↔ headset map | https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/ami_public_manual_1.6.2.zip |
| AMI headset audio (34–71 MB each) | `https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/<meeting>/audio/<meeting>.Headset-<n>.wav` for TS3003b headsets 0 and 3, and ES2004a headsets 0–3 |

If `prepare` can't reach these hosts (for example behind a proxy), download them yourself into `~/.cache/darkroom/bench/raw/`, keeping the file names (the parquet as `tedlium-validation.parquet`), and run `prepare` again: it only downloads files that are missing.

```bash
mkdir -p ~/.cache/darkroom/bench/raw && cd ~/.cache/darkroom/bench/raw
curl -L -o tedlium-validation.parquet \
  https://huggingface.co/datasets/distil-whisper/tedlium-long-form/resolve/main/data/validation-00000-of-00001-9ed099229d0cbe10.parquet
curl -LO https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/ami_public_manual_1.6.2.zip
for h in 0 3; do curl -LO https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/TS3003b/audio/TS3003b.Headset-$h.wav; done
for h in 0 1 2 3; do curl -LO https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/ES2004a/audio/ES2004a.Headset-$h.wav; done
```

Whisper models download from Hugging Face on first use (about 140 MB for `base`, 1.6 GB for `turbo`, 3 GB for `large-v3`).

## Run it on your machine

Needs Darkroom's backend installed (`make install`) and FFmpeg on your PATH. From `backend/`:

```bash
../.venv/bin/pip install -e ".[bench]"                  # jiwer, whisper-normalizer, pyarrow
../.venv/bin/python bench/transcription.py prepare      # download + cut the test set
../.venv/bin/python bench/transcription.py run baseline app@turbo app@small --label my-laptop
../.venv/bin/python bench/transcription.py report       # markdown table
```

`--label` names the machine in the results (default: the hostname). Use something others will understand, such as `m2-macbook-air` or `rtx3060-desktop`.

On a 6-core desktop CPU, `baseline` takes about 37 minutes for the whole set, `app@turbo` about 15, `app@small` about 5. Add `--kinds solo 2-mic` to skip the longest item, or `prepare --minutes 20` (then `run --minutes 20`) for longer multi-mic excerpts.

### Configurations

Each configuration × item runs in a fresh process, so model loads and peak memory are measured cleanly. Names are `<settings>@<model>`, where the model is any faster-whisper name (`base`, `small`, `medium`, `large-v3`, `turbo`, `distil-large-v3.5`…).

| Settings | What runs |
|---|---|
| `baseline` | The code before the fast-transcription work: `medium`, default compute type, no VAD, sequential decoding, model reloaded for every track |
| `app` | The app's own `transcribe_file()`, exactly as Darkroom runs it today |
| dash-separated settings | `fp32` / `int8` / `fp16` (compute type), `vad`, `b<N>` (batched pipeline, batch size N; omit for sequential), `t<N>` (CPU threads), `old` (the old no-speech filter), `ts` (batched with timestamp tokens, which drops speech). Example: `int8-vad-b4-t6@turbo` |

## Share your results

```bash
../.venv/bin/python bench/transcription.py export   # → bench/results/<label>.jsonl
```

`export` writes timings, scores and machine details, without the transcripts: the TED talk's licence doesn't allow redistributing derived text. Commit `bench/results/<label>.jsonl` and open a pull request. `report` with no local results reads the committed files, so anyone can compare machines:

```bash
../.venv/bin/python bench/transcription.py report bench/results/*.jsonl
```

The full local results, with transcripts, stay in `~/.cache/darkroom/bench/results/` so they can be rescored if the scoring changes.

## Run it on AWS

For hardware you don't have. These run in **your own AWS account**; nothing else is involved.

### NVIDIA GPU (scripted)

[`infra/bench/run-gpu-benchmark.sh`](../../infra/bench/run-gpu-benchmark.sh) launches one GPU instance, runs the benchmark there, copies the results to `backend/bench/results/aws-<instance type>.jsonl`, and deletes everything it created, including on failure or Ctrl-C.

```bash
infra/bench/run-gpu-benchmark.sh                                  # g4dn.xlarge (T4), default configs
infra/bench/run-gpu-benchmark.sh --instance-type g6.xlarge --spot # L4, Spot price
infra/bench/run-gpu-benchmark.sh --configs "baseline app@turbo app@small"
infra/bench/run-gpu-benchmark.sh --help
```

**Before the first run:**

1. Install the [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) and sign in (`aws configure` or `aws sso login`). Your user needs permission to create and delete S3 buckets, IAM roles and instance profiles, and EC2 instances, and to read SSM parameters and service quotas.
2. **GPU quota.** New accounts usually have 0 vCPUs for G instances, and the script stops with the exact command to fix it:
   ```bash
   aws service-quotas request-service-quota-increase --region us-east-1 \
     --service-code ec2 --quota-code L-DB2E81BA --desired-value 4   # On-Demand; Spot is L-3819A6DF
   ```
   Approval usually takes up to a day. 4 vCPUs is enough for one `*.xlarge` instance.
3. The region needs a default VPC, or pass `--subnet-id` for a subnet with internet access.

**What it creates**, all named `darkroom-bench-<run id>`:

- an S3 bucket holding the source and the results. The source is `git archive` of `--ref` (default `HEAD`), so it works for unpushed branches; uncommitted changes are not included.
- an IAM role that can only read that source and write results
- one EC2 instance (Deep Learning Base AMI, Ubuntu 24.04, with NVIDIA drivers). It has no inbound access and no SSH, and terminates itself when the run ends, or after `--max-hours` (default 3) at the latest.

The instance downloads the test set and models itself. Its log is copied to `~/.cache/darkroom/bench/logs/`.

**Instances and cost** (on-demand, us-east-1, approximate; billed per second; check current [EC2 pricing](https://aws.amazon.com/ec2/pricing/on-demand/)):

| Instance | GPU | Similar to | Price |
|---|---|---|---|
| `g4dn.xlarge` | T4, 16 GB | older or mid-range desktop cards (GTX 1660, RTX 2060) | ~$0.53/h |
| `g6.xlarge` | L4, 24 GB | a recent mid-range card | ~$0.80/h |
| `g5.xlarge` | A10G, 24 GB | an upper-range card (RTX 3080) | ~$1.00/h |

A full run of the default configurations should take well under the 3-hour limit, so a few dollars at most; `--spot` is usually cheaper still.

If a run is interrupted in a way the script can't clean up after (for example the machine running it loses power), find leftovers by name: EC2 instances tagged `darkroom-bench`, S3 buckets and IAM roles starting `darkroom-bench-`.

### Apple Silicon (manual)

EC2 Mac instances are real Mac minis on a **dedicated host with a 24-hour minimum allocation**, so one run costs a full day, roughly $16–25 depending on the chip (check [current pricing](https://aws.amazon.com/ec2/instance-types/mac/)). faster-whisper runs on the CPU on a Mac today, so this measures what Mac users get now. Best done once a Mac GPU engine exists (Phase 5 of the plan), so one allocation covers both.

1. **Allocate a host** in a zone that offers the Mac type you want (`mac2.metal` = M1, `mac2-m2.metal` = M2, `mac2-m2pro.metal` = M2 Pro):
   ```bash
   aws ec2 allocate-hosts --instance-type mac2-m2.metal --availability-zone us-east-1a --quantity 1
   ```
2. **Launch a macOS instance** on that host from the EC2 console (choose a current macOS AMI and the host), with a key pair and a security group allowing SSH from your IP only.
3. **Run the benchmark** over SSH (`ssh ec2-user@<public IP>`):
   ```bash
   brew install ffmpeg python@3.12 git
   git clone https://github.com/chaotictoejam/darkroom.git && cd darkroom/backend
   python3.12 -m venv ../.venv && ../.venv/bin/pip install -e ".[bench]"
   ../.venv/bin/python bench/transcription.py prepare
   ../.venv/bin/python bench/transcription.py run baseline app@turbo app@distil-large-v3.5 app@medium app@small app@base \
     --label aws-mac2-m2.metal
   ../.venv/bin/python bench/transcription.py export
   ```
   Copy `bench/results/aws-mac2-m2.metal.jsonl` back with `scp`.
4. **Terminate the instance**, then **release the host** once 24 hours have passed (it keeps billing until you do):
   ```bash
   aws ec2 release-hosts --host-ids <host id>
   ```
