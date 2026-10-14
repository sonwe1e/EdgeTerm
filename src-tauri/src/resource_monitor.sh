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
