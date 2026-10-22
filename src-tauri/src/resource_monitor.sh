export LC_ALL=C
section() { printf '\n__EDGETERM__:%s\n' "$1"; }
read_metric() {
  if [ ! -e "$1" ]; then printf '!unsupported\n'
  elif [ ! -r "$1" ]; then printf '!denied\n'
  else cat "$1"; fi
}
section platform
uname -s
[ "$(uname -s)" = Linux ] || exit 0
section uptime
read_metric /proc/uptime
section cpu
if [ ! -e /proc/stat ]; then printf '!unsupported\n'
elif [ ! -r /proc/stat ]; then printf '!denied\n'
else head -n 1 /proc/stat; fi
section memory
read_metric /proc/meminfo
section capacity
df -Pk / 2>&1
section diskdevices
for device in /sys/block/*; do
  [ -e "$device/device" ] && printf '%s\n' "${device##*/}"
done
section diskio
read_metric /proc/diskstats
section netdevices
for device in /sys/class/net/*; do
  [ -e "$device/device" ] && printf '%s\n' "${device##*/}"
done
section network
read_metric /proc/net/dev
section gpu
gpu=$(command -v nvidia-smi 2>/dev/null)
if [ -z "$gpu" ] && [ -x /usr/lib/wsl/lib/nvidia-smi ]; then gpu=/usr/lib/wsl/lib/nvidia-smi; fi
if [ -z "$gpu" ]; then
  if [ -e /usr/lib/wsl/lib/nvidia-smi ] && [ ! -x /usr/lib/wsl/lib/nvidia-smi ]; then printf '!denied\n'
  else printf '!unsupported\n'; fi
else
  if command -v timeout >/dev/null 2>&1; then
    output=$(timeout 3 "$gpu" --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>&1)
  else
    output=$("$gpu" --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>&1)
  fi
  code=$?
  if [ "$code" -ne 0 ]; then
    case "$output" in
      *[Pp]ermission*|*[Ii]nsufficient*|*[Nn]ot\ permitted*) printf '!denied\n' ;;
      *[Nn]o\ devices*) printf '!unsupported\n' ;;
      *) printf '!error\n' ;;
    esac
  fi
  printf '%s\n' "$output"
fi
# Accelerators are reported only when a source actually answers. The first
# source that exists wins, so an Ascend host is not also enumerated through
# /sys/class/accel and counted twice. A source that exists but refuses to be
# read stays "denied" instead of silently falling through to a weaker one.
section npu
# Runs one probe through timeout where the host has it, so a stuck vendor tool
# cannot hold the whole sample open. The seconds are a per-call bound; a normal
# driver query answers in milliseconds.
probe() {
  probe_seconds=$1
  shift
  if command -v timeout >/dev/null 2>&1; then timeout "$probe_seconds" "$@"; else "$@"; fi
}
npu_found=0
npu_tool=$(command -v npu-smi 2>/dev/null)
if [ -n "$npu_tool" ]; then
  npu_found=1
  output=$(probe 2 "$npu_tool" info 2>&1)
  code=$?
  if [ "$code" -ne 0 ]; then
    case "$output" in
      *[Pp]ermission*|*[Ii]nsufficient*|*[Nn]ot\ permitted*) printf '!denied\n' ;;
      *[Nn]o\ [Nn][Pp][Uu]*|*[Nn]o\ devices*) printf '!unsupported\n' ;;
      *) printf '!error\n' ;;
    esac
  else
    if [ -z "$output" ]; then
      # The tool answered but reported no card.
      printf '!unsupported\n'
    else
      printf '#ascend\n'
      printf '%s\n' "$output" | head -n 200
    fi
  fi
fi
if [ "$npu_found" = 0 ]; then
  xpu_tool=$(command -v xpu-smi 2>/dev/null)
  if [ -n "$xpu_tool" ]; then
    npu_found=1
    discovery=$(probe 2 "$xpu_tool" discovery 2>&1)
    code=$?
    if [ "$code" -ne 0 ]; then
      case "$discovery" in
        *[Pp]ermission*|*[Ii]nsufficient*|*[Nn]ot\ permitted*) printf '!denied\n' ;;
        *) printf '!error\n' ;;
      esac
    else
      # The listed device ids are the only stateful part of discovery; the raw
      # table is kept so the parser can read the names off it.
      devices=$(printf '%s\n' "$discovery" | awk -F'|' '
        $1 == "" && $2 ~ /^[[:space:]]*[0-9]+[[:space:]]*$/ {
          id = $2
          gsub(/[^0-9]/, "", id)
          if (id != "" && !seen[id]++) { print id; found++ }
          if (found >= 4) exit
        }')
      if [ -z "$devices" ]; then
        printf '!unsupported\n'
      else
        printf '#intel-discovery\n'
        printf '%s\n' "$discovery" | head -n 120
        for device in $devices; do
          printf '#intel-stats %s\n' "$device"
          probe 1 "$xpu_tool" stats -d "$device" 2>&1 | head -n 80
        done
      fi
    fi
  fi
fi
if [ "$npu_found" = 0 ]; then
  rockchip=
  if [ -r /sys/kernel/debug/rknpu/load ]; then rockchip=/sys/kernel/debug/rknpu/load; fi
  if [ -z "$rockchip" ]; then
    for device in /sys/class/devfreq/*npu*/load; do
      [ -r "$device" ] || continue
      rockchip=$device
      break
    done
  fi
  if [ -n "$rockchip" ]; then
    npu_found=1
    printf '#rockchip\n'
    head -n 8 "$rockchip"
  elif [ -e /sys/kernel/debug/rknpu/load ] || ls -d /sys/class/devfreq/*npu* >/dev/null 2>&1; then
    # The device is present but its load file is root-only: say so rather than
    # reporting the host as having no accelerator.
    npu_found=1
    printf '!denied\n'
  fi
fi
if [ "$npu_found" = 0 ]; then
  accel_devices=0
  for device in /sys/class/accel/*; do
    [ -e "$device" ] || continue
    accel_devices=$((accel_devices + 1))
  done
  if [ "$accel_devices" -eq 0 ]; then
    printf '!unsupported\n'
  else
    # A generic accel device exposes an identity, not a utilization counter:
    # list it so the host can say "accelerator present, telemetry unavailable".
    printf '#accel\n'
    for device in /sys/class/accel/*; do
      [ -e "$device" ] || continue
      driver=
      [ -e "$device/device/driver" ] && driver=$(readlink -f "$device/device/driver" 2>/dev/null)
      if [ -n "$driver" ]; then printf '%s %s\n' "${device##*/}" "${driver##*/}"
      else printf '%s\n' "${device##*/}"; fi
    done
  fi
fi
exit 0
