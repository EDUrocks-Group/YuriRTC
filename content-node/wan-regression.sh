#!/usr/bin/env bash
set -euo pipefail

# Reproducible sustained-transfer regression matrix for the real YuriRTC Go
# handler, WebRTC stack, SCTP association, framing, and response-credit path.
# Each case runs in its own unprivileged network namespace, so tc never touches
# the host network. Linux with user namespaces and iproute2 is required.

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mode=${1:---quick}
fixture_mib=${YURIRTC_WAN_BENCH_MIB:-64}

case "$mode" in
  --quick|--full) ;;
  *)
    echo "usage: $0 [--quick|--full]" >&2
    exit 2
    ;;
esac

for command in unshare ip tc go awk; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "missing required command: $command" >&2
    exit 2
  fi
done

run_benchmark_case() {
  local name=$1
  local benchmark=$2
  local protocol=$3
  local minimum_mbps=$4
  shift 4

  echo "WAN_CASE start name=$name protocol=$protocol fixture_mib=$fixture_mib netem=$*"
  local output
  if ! output=$(
    cd "$script_dir"
    unshare -Urn sh -c '
      benchmark=$1
      protocol=$2
      fixture_mib=$3
      shift 3
      ip link set lo up
      tc qdisc add dev lo root netem "$@"
      YURIRTC_WAN_BENCH_MIB=$fixture_mib go test \
        -run "^$" \
        -bench "^$benchmark/$protocol$" \
        -benchtime=1x \
        -count=1 \
        -timeout=240s \
        -benchmem \
        .
    ' wan-regression "$benchmark" "$protocol" "$fixture_mib" "$@" 2>&1
  ); then
    printf '%s\n' "$output"
    echo "WAN_CASE failed name=$name reason=benchmark" >&2
    return 1
  fi
  printf '%s\n' "$output"

  local measured
  measured=$(
    printf '%s\n' "$output" |
      awk -v benchmark="$benchmark" -v protocol="$protocol" '
        index($1, benchmark "/" protocol "-") == 1 {
          for (field = 2; field <= NF; field++) {
            if ($field == "Mbps") {
              print $(field - 1)
              exit
            }
          }
        }
      '
  )
  if [[ -z "$measured" ]]; then
    echo "WAN_CASE failed name=$name reason=missing-throughput" >&2
    return 1
  fi
  if ! awk -v measured="$measured" -v minimum="$minimum_mbps" \
    'BEGIN { exit !(measured + 0 >= minimum + 0) }'; then
    echo "WAN_CASE failed name=$name measured_mbps=$measured minimum_mbps=$minimum_mbps" >&2
    return 1
  fi
  echo "WAN_CASE pass name=$name measured_mbps=$measured minimum_mbps=$minimum_mbps"
}

run_case() {
  local name=$1
  local protocol=$2
  local minimum_mbps=$3
  shift 3
  run_benchmark_case "$name" BenchmarkWANDownload "$protocol" "$minimum_mbps" "$@"
}

run_parallel_case() {
  local name=$1
  local protocol=$2
  local minimum_mbps=$3
  shift 3
  run_benchmark_case "$name" BenchmarkWANParallelDownload "$protocol" "$minimum_mbps" "$@"
}

# 64 ms one-way delay models the ~128 ms RTT observed on the live deployment.
# A 100 Mbit/s ceiling makes results comparable between developer machines.
failures=0
run_checked() {
  if ! "$@"; then
    failures=$((failures + 1))
  fi
}

run_checked run_case udp-clean-128ms udp 35 delay 64ms rate 100mbit
run_checked run_case udp-random-loss-128ms udp 14 delay 64ms loss random 0.01% seed 42 rate 100mbit
run_checked run_case tcp-random-loss-128ms tcp 14 delay 64ms loss random 0.1% seed 42 rate 100mbit

if [[ "$mode" == "--full" ]]; then
  run_checked run_case udp-clean-300ms udp 14 delay 150ms rate 100mbit
  run_checked run_case udp-random-loss-300ms udp 14 delay 150ms loss random 0.01% seed 42 rate 100mbit
  # This deliberately hostile burst model is expected to trigger the browser's
  # <15 Mbit/s adaptive route recommendation. Guard the impaired UDP floor and
  # separately require the TCP route it selects to remain fast.
  run_checked run_case udp-burst-loss-128ms udp 4 delay 64ms loss gemodel 0.05% 90% 80% 0.01% rate 100mbit
  run_checked run_case tcp-burst-loss-128ms tcp 20 delay 64ms loss gemodel 0.05% 90% 80% 0.01% rate 100mbit
  run_checked run_case udp-reorder-128ms udp 14 delay 64ms reorder 0.1% 50% seed 42 rate 100mbit
  run_checked run_parallel_case udp-three-lanes-random-loss-128ms udp 20 delay 64ms loss random 0.01% seed 42 rate 100mbit
fi

if ((failures > 0)); then
  echo "WAN_MATRIX failed cases=$failures" >&2
  exit 1
fi
echo "WAN_MATRIX pass mode=$mode"
