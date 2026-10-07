#!/usr/bin/env bash
# run-gpu-benchmark.sh — run the transcription benchmark on an EC2 NVIDIA GPU
# instance in your own AWS account, bring the results back, delete everything.
#
#   infra/bench/run-gpu-benchmark.sh                          # g4dn.xlarge (T4), default configs
#   infra/bench/run-gpu-benchmark.sh --instance-type g6.xlarge --spot
#   infra/bench/run-gpu-benchmark.sh --configs "baseline app@turbo"
#
# What it creates, all named darkroom-bench-<run id> and all deleted on exit
# (including on Ctrl-C or failure):
#   - an S3 bucket holding the source (git archive of --ref) and the results
#   - an IAM role + instance profile that can only read the source and write results
#   - one EC2 instance: no inbound access, no SSH, terminates itself when done or
#     after --max-hours, whichever comes first
# The instance downloads the public test set and Whisper models itself; nothing
# from your machine is uploaded except the committed source tree.
#
# Requires: AWS CLI v2 with credentials, a default VPC in the region (or
# --subnet-id), and quota for G instances ("Running On-Demand G and VT
# instances", or the Spot equivalent). Full guide: backend/bench/README.md

set -euo pipefail

INSTANCE_TYPE=g4dn.xlarge
REGION=${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}
REGION=${REGION:-us-east-1}
CONFIGS="baseline app@turbo app@distil-large-v3.5 app@medium app@small app@base app@large-v3 fp16-vad-b1@turbo fp16-vad-b4@turbo fp16-vad-b16@turbo int8-vad-b8@turbo"
MINUTES=10
KINDS=""
MULTILINGUAL=""
MAX_HOURS=3
REF=HEAD
SPOT=false
AMI=""
SUBNET_ID=""
AMI_PARAM=/aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-ubuntu-24.04/latest/ami-id

usage() {
  awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"
  cat <<EOF
Options:
  --instance-type TYPE   EC2 GPU instance (default $INSTANCE_TYPE)
  --region REGION        AWS region (default $REGION)
  --configs "A B ..."    benchmark configurations (default: model sweep + GPU ablations)
  --minutes N            length of the multi-mic excerpts (default $MINUTES)
  --kinds "K ..."        only these items: solo, 2-mic, 4-mic, multilingual (default: all prepared)
  --multilingual         also prepare and run the Spanish, French and German FLEURS items
  --max-hours N          hard limit; the instance shuts down after this (default $MAX_HOURS)
  --ref REF              git commit/branch to benchmark (default HEAD; must be committed)
  --spot                 use a Spot instance (cheaper; may be interrupted)
  --ami AMI_ID           override the Deep Learning Base (Ubuntu 24.04) AMI
  --subnet-id ID         launch into this subnet instead of the default VPC
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance-type) INSTANCE_TYPE=$2; shift 2 ;;
    --region) REGION=$2; shift 2 ;;
    --configs) CONFIGS=$2; shift 2 ;;
    --minutes) MINUTES=$2; shift 2 ;;
    --kinds) KINDS=$2; shift 2 ;;
    --multilingual) MULTILINGUAL=--multilingual; shift ;;
    --max-hours) MAX_HOURS=$2; shift 2 ;;
    --ref) REF=$2; shift 2 ;;
    --spot) SPOT=true; shift ;;
    --ami) AMI=$2; shift 2 ;;
    --subnet-id) SUBNET_ID=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

REPO_ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION
LABEL="aws-${INSTANCE_TYPE}"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
RUN_ID="darkroom-bench-$(date +%Y%m%d-%H%M%S)"
BUCKET="${RUN_ID}-${ACCOUNT}"
ROLE="$RUN_ID"
WORK=$(mktemp -d)
INSTANCE_ID=""

log() { echo "[$(date +%H:%M:%S)] $*"; }

if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" && "$REF" == HEAD ]]; then
  log "Note: uncommitted changes are not included; benchmarking commit $(git -C "$REPO_ROOT" rev-parse --short HEAD)."
fi

cleanup() {
  local status=$?
  set +e
  log "Cleaning up…"
  if [[ -n "$INSTANCE_ID" ]]; then
    aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" >/dev/null 2>&1
    aws ec2 wait instance-terminated --instance-ids "$INSTANCE_ID" 2>/dev/null
    log "  instance $INSTANCE_ID terminated"
  fi
  aws iam remove-role-from-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE" 2>/dev/null
  aws iam delete-instance-profile --instance-profile-name "$ROLE" 2>/dev/null
  aws iam delete-role-policy --role-name "$ROLE" --policy-name bench 2>/dev/null
  aws iam delete-role --role-name "$ROLE" 2>/dev/null && log "  IAM role $ROLE deleted"
  aws s3 rb "s3://$BUCKET" --force >/dev/null 2>&1 && log "  bucket $BUCKET deleted"
  rm -rf "$WORK"
  exit $status
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ── Quota check (new accounts usually have 0 vCPUs for GPU instances) ─────────
if [[ $INSTANCE_TYPE == g* ]]; then
  QUOTA_CODE=$([[ $SPOT == true ]] && echo L-3819A6DF || echo L-DB2E81BA)
  VCPUS=$(aws ec2 describe-instance-types --instance-types "$INSTANCE_TYPE" \
          --query 'InstanceTypes[0].VCpuInfo.DefaultVCpus' --output text)
  QUOTA=$(aws service-quotas get-service-quota --service-code ec2 --quota-code "$QUOTA_CODE" \
          --query 'Quota.Value' --output text 2>/dev/null || echo unknown)
  if [[ $QUOTA != unknown ]] && (( ${QUOTA%.*} < VCPUS )); then
    cat >&2 <<EOF
Your $([[ $SPOT == true ]] && echo Spot || echo On-Demand) quota for G instances in $REGION is ${QUOTA%.*} vCPUs; $INSTANCE_TYPE needs $VCPUS.
Request an increase (usually approved within a day), then run this again:

  aws service-quotas request-service-quota-increase --region $REGION \\
    --service-code ec2 --quota-code $QUOTA_CODE --desired-value $VCPUS
EOF
    trap - EXIT; rm -rf "$WORK"; exit 1
  fi
fi

# ── Source + bucket ───────────────────────────────────────────────────────────
log "Run $RUN_ID: $INSTANCE_TYPE in $REGION$([[ $SPOT == true ]] && echo ' (Spot)')"
git -C "$REPO_ROOT" archive --format=tar.gz -o "$WORK/src.tar.gz" "$REF"
if [[ "$REGION" == us-east-1 ]]; then
  aws s3api create-bucket --bucket "$BUCKET" >/dev/null
else
  aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
fi
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3 cp --quiet "$WORK/src.tar.gz" "s3://$BUCKET/src.tar.gz"
log "Uploaded source ($(git -C "$REPO_ROOT" rev-parse --short "$REF")) to s3://$BUCKET"

# ── IAM: read the source, write results, nothing else ─────────────────────────
aws iam create-role --role-name "$ROLE" --assume-role-policy-document '{
  "Version": "2012-10-17",
  "Statement": [{"Effect": "Allow", "Principal": {"Service": "ec2.amazonaws.com"}, "Action": "sts:AssumeRole"}]
}' >/dev/null
aws iam put-role-policy --role-name "$ROLE" --policy-name bench --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [
    {\"Effect\": \"Allow\", \"Action\": \"s3:GetObject\", \"Resource\": \"arn:aws:s3:::$BUCKET/src.tar.gz\"},
    {\"Effect\": \"Allow\", \"Action\": \"s3:PutObject\", \"Resource\": \"arn:aws:s3:::$BUCKET/results/*\"}
  ]
}"
aws iam create-instance-profile --instance-profile-name "$ROLE" >/dev/null
aws iam add-role-to-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE"
log "Created IAM role $ROLE; waiting for it to propagate…"
sleep 15

# ── What the instance runs ────────────────────────────────────────────────────
cat > "$WORK/user-data.sh" <<EOF
#!/bin/bash
exec > /var/log/darkroom-bench.log 2>&1
# Hard limit: shutdown terminates the instance (instance-initiated-shutdown-behavior)
shutdown -h +$((MAX_HOURS * 60))
set -euxo pipefail
finish() {
  status=\$?
  if [[ \$status -eq 0 ]]; then echo ok > /tmp/status; else echo "failed (exit \$status)" > /tmp/status; fi
  /opt/venv/bin/aws s3 cp /var/log/darkroom-bench.log s3://$BUCKET/results/log.txt || true
  /opt/venv/bin/aws s3 cp /tmp/status s3://$BUCKET/results/status || true
  shutdown -h now
}
trap finish EXIT
export DEBIAN_FRONTEND=noninteractive HOME=/root
apt-get update
apt-get install -y ffmpeg python3-venv
python3 -m venv /opt/venv
/opt/venv/bin/pip install --quiet awscli
mkdir -p /opt/darkroom
/opt/venv/bin/aws s3 cp s3://$BUCKET/src.tar.gz - | tar xz -C /opt/darkroom
# CUDA 12 cuBLAS + cuDNN 9 for CTranslate2, as faster-whisper's README describes
/opt/venv/bin/pip install --quiet -e "/opt/darkroom/backend[bench]" nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"
export LD_LIBRARY_PATH=\$(/opt/venv/bin/python -c 'import os, nvidia.cublas.lib, nvidia.cudnn.lib; print(os.path.dirname(nvidia.cublas.lib.__file__) + ":" + os.path.dirname(nvidia.cudnn.lib.__file__))')
nvidia-smi
/opt/venv/bin/python -c 'import ctranslate2; n = ctranslate2.get_cuda_device_count(); print("CUDA devices:", n); assert n > 0'
cd /opt/darkroom/backend
/opt/venv/bin/python bench/transcription.py prepare --minutes $MINUTES $MULTILINGUAL
# Warm-up, not recorded: a new instance's disk loads lazily from its snapshot, so
# the first process to touch the CUDA libraries would otherwise be slower
/opt/venv/bin/python bench/transcription.py run app@tiny --kinds solo --minutes $MINUTES --label warmup --out /tmp/warmup.jsonl
/opt/venv/bin/python bench/transcription.py run $CONFIGS --minutes $MINUTES --label $LABEL ${KINDS:+--kinds $KINDS}
/opt/venv/bin/python bench/transcription.py export
/opt/venv/bin/aws s3 cp bench/results/$LABEL.jsonl s3://$BUCKET/results/$LABEL.jsonl
/opt/venv/bin/python bench/transcription.py report bench/results/$LABEL.jsonl
EOF

# ── Launch ────────────────────────────────────────────────────────────────────
AMI=${AMI:-$(aws ssm get-parameter --name "$AMI_PARAM" --query Parameter.Value --output text)}
launch=(aws ec2 run-instances
  --image-id "$AMI" --instance-type "$INSTANCE_TYPE" --count 1
  --iam-instance-profile "Name=$ROLE"
  --user-data "file://$WORK/user-data.sh"
  --instance-initiated-shutdown-behavior terminate
  --metadata-options HttpTokens=required
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=100,VolumeType=gp3,DeleteOnTermination=true}'
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$RUN_ID},{Key=darkroom-bench,Value=$RUN_ID}]"
  --query 'Instances[0].InstanceId' --output text)
[[ $SPOT == true ]] && launch+=(--instance-market-options 'MarketType=spot,SpotOptions={SpotInstanceType=one-time,InstanceInterruptionBehavior=terminate}')
[[ -n $SUBNET_ID ]] && launch+=(--subnet-id "$SUBNET_ID")
# IAM propagation can still lag; retry the launch a few times
for attempt in 1 2 3 4; do
  if INSTANCE_ID=$("${launch[@]}" 2>"$WORK/launch.err"); then break; fi
  if grep -q "Invalid IAM Instance Profile" "$WORK/launch.err" && [[ $attempt -lt 4 ]]; then
    sleep 15; continue
  fi
  cat "$WORK/launch.err" >&2; INSTANCE_ID=""; exit 1
done
log "Launched $INSTANCE_ID (AMI $AMI). Typical run: 30–90 min. Ctrl-C stops and cleans up."

# ── Wait for results ──────────────────────────────────────────────────────────
start=$(date +%s)
while true; do
  sleep 60
  if aws s3 cp --quiet "s3://$BUCKET/results/status" "$WORK/status" 2>/dev/null; then break; fi
  state=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" \
          --query 'Reservations[0].Instances[0].State.Name' --output text)
  if [[ $state == terminated || $state == shutting-down ]]; then
    sleep 30  # the status upload may land just before shutdown
    aws s3 cp --quiet "s3://$BUCKET/results/status" "$WORK/status" 2>/dev/null && break
    log "Instance $state without reporting results (Spot interruption, or the time limit)."
    exit 1
  fi
  log "  running… $(( ($(date +%s) - start) / 60 )) min, instance $state"
done

LOG_DIR="${DARKROOM_BENCH_DIR:-$HOME/.cache/darkroom/bench}/logs"
mkdir -p "$LOG_DIR"
aws s3 cp --quiet "s3://$BUCKET/results/log.txt" "$LOG_DIR/$RUN_ID.log" || true
if [[ "$(cat "$WORK/status")" != ok ]]; then
  log "Benchmark $(cat "$WORK/status"). Log: $LOG_DIR/$RUN_ID.log"
  tail -40 "$LOG_DIR/$RUN_ID.log" || true
  exit 1
fi
OUT="$REPO_ROOT/backend/bench/results/$LABEL.jsonl"
# Append, so earlier runs on the same instance type are kept (report uses the latest row of each)
aws s3 cp --quiet "s3://$BUCKET/results/$LABEL.jsonl" "$WORK/results.jsonl"
cat "$WORK/results.jsonl" >> "$OUT"
log "Done in $(( ($(date +%s) - start) / 60 )) min. Results: $OUT (log: $LOG_DIR/$RUN_ID.log)"
grep -A20 '^| Machine' "$LOG_DIR/$RUN_ID.log" | grep '^|' || true
