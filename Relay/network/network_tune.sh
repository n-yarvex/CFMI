#!/usr/bin/env bash
set -euo pipefail
KERNEL_MAJOR=$(uname -r | cut -d. -f1)
KERNEL_MINOR=$(uname -r | cut -d. -f2)
if [ "$KERNEL_MAJOR" -lt 4 ] || { [ "$KERNEL_MAJOR" -eq 4 ] && [ "$KERNEL_MINOR" -lt 9 ]; }; then
    echo "<4.9！BBR???" >&2
    exit 1
fi
OS="unknown"
CPU_CORE="1"
BANDWIDTH_MBPS="200"
SWAPPINESS_VAL="10"
BUSY_POLL_VAL="0"
INITCWND_DONE="false"
err() { echo -e "\033[1;31m[ERR]\033[0m $*" >&2; }
detect_os() {
    if [ -f /etc/os-release ]; then . /etc/os-release; ID="${ID:-}"; ID_LIKE="${ID_LIKE:-}"; fi
    if [ -f /etc/alpine-release ]; then OS="alpine"
    elif [ -f /etc/debian_version ]; then OS="debian"
    elif [ -f /etc/redhat-release ]; then OS="redhat"
    else
        local COMBINED="${ID} ${ID_LIKE}"
        case "$COMBINED" in
            *[Aa][Ll][Pp][Ii][Nn][Ee]*) OS="alpine" ;;
            *[Dd][Ee][Bb][Ii][Aa][Nn]*|*[Uu][Bb][Uu][Nn][Tt][Uu]*) OS="debian" ;;
            *[Cc][Ee][Nn][Tt][Oo][Ss]*|*[Rr][Hh][Ee][Ll]*|*[Ff][Ee][Dd][Oo][Rr][Aa]*) OS="redhat" ;;
        esac
    fi
}
get_cpu_core() {
    local n q p c
    n=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo || echo 1)
    if [ -r /sys/fs/cgroup/cpu.max ]; then read -r q p < /sys/fs/cgroup/cpu.max
    else q=$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us 2>/dev/null); p=$(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us 2>/dev/null); fi
    if [[ "${q:-}" =~ ^[0-9]+$ ]] && [ "$q" -gt 0 ]; then p=${p:-100000}; c=$(( q / p )); [ "$c" -le 0 ] && c=1; echo $(( c < n ? c : n ))
    else echo "$n"; fi
}
probe_network_rtt() {
    local rtt_val loss_val="5" real_rtt_factors="130" loss_compensation="100"
    set +e
    local targets=("223.5.5.5" "119.29.29.29" "114.114.114.114" "1.1.1.1" "8.8.8.8" "8.26.56.26" "208.67.222.222")
    local ping_res=""
    for target in "${targets[@]}"; do
        local res=$(ping -c 5 -W 1 "$target" 2>/dev/null)
        if echo "$res" | grep -q "received"; then ping_res="$res"; break; fi
    done
    if [ -n "$ping_res" ]; then
        rtt_val=$(echo "$ping_res" | awk -F'/' 'END{print int($5)}')
        loss_val=$(echo "$ping_res" | grep -oE '[0-9]+% packet loss' | grep -oE '[0-9]+' || echo "5")
    else
        rtt_val="150"
    fi
    set -e
    real_rtt_factors=$(( rtt_val + 100 ))
    loss_compensation=$(( 100 + loss_val * 5 ))
    [ "$loss_compensation" -gt 200 ] && loss_compensation=200
    echo "$rtt_val $real_rtt_factors $loss_compensation"
}
probe_memory_total() {
    local mem_total=64 mem_cgroup=0
    local mem_host_total=$(free -m | awk '/Mem:/ {print $2}' | tr -cd '0-9')
    if [ -f /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
        local m_limit=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes | tr -cd '0-9')
        [ "${#m_limit}" -lt 15 ] && mem_cgroup=$((m_limit / 1024 / 1024))
    elif [ -f /sys/fs/cgroup/memory.max ]; then
        local m_max=$(cat /sys/fs/cgroup/memory.max | tr -cd '0-9')
        [ -n "$m_max" ] && mem_cgroup=$((m_max / 1024 / 1024))
    elif grep -q "MemTotal" /proc/meminfo; then
        mem_cgroup=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
    fi
    [ "$mem_cgroup" -gt 0 ] && [ "$mem_cgroup" -le "$mem_host_total" ] && mem_total=$mem_cgroup || mem_total=$mem_host_total
    [ -f /proc/user_beancounters ] && mem_total=$mem_host_total
    ([ -z "$mem_total" ] || [ "$mem_total" -le 0 ] || [ "$mem_total" -gt 64000 ]) && mem_total=64
    echo "$mem_total"
}
apply_initcwnd_optimization() {
    local silent="${1:-false}"
    command -v ip >/dev/null || return 0
    local current_route=$(ip route show default | head -n1)
    echo "$current_route" | grep -q "initcwnd 15" && { INITCWND_DONE="true"; return 0; }
    local gw dev mtu mss opts
    gw=$(echo "$current_route" | grep -oE 'via [^ ]+' | awk '{print $2}')
    dev=$(echo "$current_route" | grep -oE 'dev [^ ]+' | awk '{print $2}')
    mtu=$(echo "$current_route" | grep -oE 'mtu [0-9]+' | awk '{print $2}' || echo 1500)
    mss=$((mtu - 40))
    opts="initcwnd 15 initrwnd 15 advmss $mss"
    if ip route change default $(echo "$current_route" | cut -d' ' -f2-) 2>/dev/null; then
        if { [ -n "$gw" ] && [ -n "$dev" ] && ip route change default via "$gw" dev "$dev" $opts 2>/dev/null; } || \
           { [ -n "$gw" ] && [ -n "$dev" ] && ip route replace default via "$gw" dev "$dev" $opts 2>/dev/null; } || \
           { [ -n "$dev" ] && ip route replace default dev "$dev" $opts 2>/dev/null; } || \
           ip route change default $opts 2>/dev/null; then
            INITCWND_DONE="true"
        fi
    fi
}
setup_zrm_swap() {
    local mt="$1"
    { [ -z "$mt" ] || [ "$mt" -ge 600 ]; } && return 0
    grep -q "zram0" /proc/swaps && return 0
    if ! modprobe zram 2>/dev/null; then [ "$OS" = "alpine" ] && apk add linux-virt-modules >/dev/null 2>&1 && modprobe zram 2>/dev/null; fi
    if ! modprobe zram 2>/dev/null; then return 0; fi
    [ ! -b /dev/zram0 ] && return 0
    if ! echo 1 > /sys/block/zram0/reset 2>/dev/null; then return 0; fi
    local zs=$(( mt * 15 / 10 )); [ "$zs" -gt 512 ] && zs=512
    local z_bytes=$(( zs * 1024 * 1024 ))
    local algo="lz4"
    [ -f /sys/block/zram0/comp_algorithm ] && { grep -qw lz4 /sys/block/zram0/comp_algorithm && algo="lz4" || algo="lzo"; echo "$algo" > /sys/block/zram0/comp_algorithm 2>/dev/null || true; }
    if echo "$z_bytes" > /sys/block/zram0/disksize 2>/dev/null && mkswap /dev/zram0 >/dev/null 2>&1 && swapon -p 10 /dev/zram0 2>/dev/null; then
        [ "$mt" -le 128 ] && sysctl -w vm.swappiness=80 >/dev/null 2>&1
        return 0
    fi
    [ "$OS" = "alpine" ] && return 0
    local st=$(grep "SwapTotal" /proc/meminfo | awk '{print $2}')
    if [ "${st:-0}" -eq 0 ] && [ ! -d /proc/vz ]; then
        if (fallocate -l 512M /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=512 2>/dev/null) && chmod 600 /swapfile && mkswap /swapfile >/dev/null 2>&1 && swapon -p 5 /swapfile 2>/dev/null; then
            grep -q "/swapfile" /etc/fstab || echo "/swapfile swap swap pri=5 0 0" >> /etc/fstab
        else rm -f /swapfile 2>/dev/null; fi
    fi
}
safe_rtt() {
    local dyn_buf="$1" rtt_val="$2" max_udp_pages="$3" udp_min="$4" udp_pre="$5" udp_max="$6" real_rtt_factors="$7" loss_compensation="$8"
    local dyn_pages=$(( dyn_buf / 4096 ))
    local probe_pages=$(( real_rtt_factors * 1024 * loss_compensation / 100 ))
    rtt_scale_max=$(( probe_pages > dyn_pages ? probe_pages : dyn_pages ))
    if [ "$rtt_val" -ge 150 ]; then
        local factor=15; [ "$max_udp_pages" -le 16384 ] && factor=12
        rtt_scale_max=$(( rtt_scale_max * factor / 10 ))
    fi
    rtt_scale_pressure=$(( rtt_scale_max * 90 / 100 ))
    rtt_scale_min=$(( rtt_scale_max * 75 / 100 ))
    [ "$rtt_scale_max" -gt "$max_udp_pages" ] && { rtt_scale_max=$max_udp_pages; rtt_scale_pressure=$(( max_udp_pages * 95 / 100 )); rtt_scale_min=$(( max_udp_pages * 80 / 100 )); }
    rtt_scale_max=$(( rtt_scale_max < udp_max ? rtt_scale_max : udp_max ))
    rtt_scale_pressure=$(( rtt_scale_pressure < udp_pre ? rtt_scale_pressure : udp_pre ))
    rtt_scale_min=$(( rtt_scale_min < udp_min ? rtt_scale_min : udp_min ))
}
apply_nic_core_boost() {
    local IFACE=$(ip route show default 2>/dev/null | awk '/default/{print $5; exit}')
    [ -z "$IFACE" ] && return 0
    local real_c="$1" bgt="$2" usc="$3" mem_total="$4" target_qlen="$5" t_usc="$6" ring="$7" driver=""
    sysctl -w net.core.netdev_budget="$bgt" net.core.netdev_budget_usecs="$usc" >/dev/null 2>&1 || true
    [ -L "/sys/class/net/$IFACE/device/driver" ] && driver=$(basename "$(readlink "/sys/class/net/$IFACE/device/driver")")
    case "$driver" in virtio_net|veth|"") target_qlen=$((target_qlen / 2)) ;; esac
    if [ -d "/sys/class/net/$IFACE" ]; then
        ip link set dev "$IFACE" txqueuelen "$target_qlen" 2>/dev/null || true
        if command -v ethtool >/dev/null 2>&1; then
            ethtool -K "$IFACE" gro on gso on tso on lro off 2>/dev/null || true
            ethtool -C "$IFACE" rx-usecs "$t_usc" tx-usecs "$t_usc" 2>/dev/null || true
            ethtool -G "$IFACE" rx "$ring" tx "$ring" 2>/dev/null || true
        fi
    fi
    if [ "$real_c" -ge 2 ] && [ -d "/sys/class/net/$IFACE/queues" ]; then
        local MASK=$(printf '%x' $(( (1<<real_c)-1 )))
        for q in /sys/class/net/"$IFACE"/queues/rx-*/rps_cpus; do [ -w "$q" ] && echo "$MASK" > "$q" 2>/dev/null || true; done
        for q in /sys/class/net/"$IFACE"/queues/tx-*/xps_cpus; do [ -w "$q" ] && echo "$MASK" > "$q" 2>/dev/null || true; done
    fi
}
optimize_system() {
    local rtt_res=($(probe_network_rtt))
    local mem_total=$(probe_memory_total)
    local rtt_avg="${rtt_res[0]:-150}" real_rtt_factors="${rtt_res[1]:-130}" loss_compensation="${rtt_res[2]:-100}"
    local real_c="$CPU_CORE"
    setup_zrm_swap "$mem_total"
    local ct_max=16384 ct_udp_to=30 ct_stream_to=30
    local max_udp_mb udp_mem_global_min udp_mem_global_pressure udp_mem_global_max max_udp_pages
    local dyn_buf g_procs g_wnd g_buf net_bgt net_usc tcp_rmem_max target_qlen t_usc ring
    if [ "$mem_total" -ge 450 ]; then
        BANDWIDTH_MBPS="500"; max_udp_mb=$((mem_total * 60 / 100))
        tcp_rmem_max=16777216; g_procs=$real_c; SWAPPINESS_VAL=10; BUSY_POLL_VAL=50
        ct_max=65535; ct_stream_to=60; target_qlen=10000; t_usc=100; ring=2048
    elif [ "$mem_total" -ge 200 ]; then
        BANDWIDTH_MBPS="300"; max_udp_mb=$((mem_total * 55 / 100))
        tcp_rmem_max=8388608; g_procs=$real_c; SWAPPINESS_VAL=10; BUSY_POLL_VAL=20
        ct_max=32768; ct_stream_to=45; target_qlen=8000; t_usc=150; ring=1024
    elif [ "$mem_total" -ge 100 ]; then
        BANDWIDTH_MBPS="200"; max_udp_mb=$((mem_total * 50 / 100))
        tcp_rmem_max=4194304; SWAPPINESS_VAL=10; BUSY_POLL_VAL=0
        ct_max=16384; ct_stream_to=30; target_qlen=5000; t_usc=150; ring=1024
        [ "$real_c" -gt 2 ] && g_procs=2 || g_procs=$real_c
    else
        BANDWIDTH_MBPS="100"; max_udp_mb=$((mem_total * 45 / 100))
        tcp_rmem_max=2097152; g_procs=1; SWAPPINESS_VAL=10; BUSY_POLL_VAL=0
        ct_max=16384; ct_stream_to=30; target_qlen=2000; t_usc=250; ring=512
    fi
    local bdp_min=$(( BANDWIDTH_MBPS * 1024 * 1024 / 8 / 5 * 3 ))
    dyn_buf=$(( (mem_total << 20) >> 3 ))
    [ "$dyn_buf" -lt "$bdp_min" ] && dyn_buf=$bdp_min
    if [ "$mem_total" -lt 100 ]; then
        [ "$dyn_buf" -gt 8388608 ] && dyn_buf=8388608
        [ "$dyn_buf" -lt 4194304 ] && dyn_buf=4194304
    else
        [ "$mem_total" -ge 200 ] && [ "$dyn_buf" -lt 33554432 ] && dyn_buf=33554432
        [ "$dyn_buf" -lt 16777216 ] && dyn_buf=16777216
    fi
    [ "$dyn_buf" -gt 67108864 ] && dyn_buf=67108864
    local udp_rmem="$dyn_buf" udp_wmem="$dyn_buf" def_mem=$(( dyn_buf / 4 ))
    local backlog=$(( BANDWIDTH_MBPS * 50 )); [ "$backlog" -lt 8192 ] && backlog=8192
    g_wnd=$(( BANDWIDTH_MBPS * loss_compensation / 100 / 8 )); [ "$g_wnd" -lt 15 ] && g_wnd=15
    g_buf=$(( dyn_buf / 6 ))
    udp_mem_global_min=$(( dyn_buf >> 12 ))
    udp_mem_global_pressure=$(( (dyn_buf << 1) >> 12 ))
    udp_mem_global_max=$(( ((mem_total << 20) * 75 / 100) >> 12 ))
    max_udp_pages=$(( max_udp_mb << 8 ))
    local base_budget=$(( BANDWIDTH_MBPS * 15 / 10 * 10 ))
    [ "$base_budget" -lt 2000 ] && base_budget=2000
    [ "$base_budget" -gt 6000 ] && base_budget=6000
    if [ "$real_c" -ge 2 ]; then net_bgt=$base_budget; net_usc=2000; else net_bgt=$(( base_budget << 1 )); net_usc=6000; fi
    local min_free_val=$(( mem_total * 1024 * 5 / 100 ))
    [ "$mem_total" -lt 100 ] && min_free_val=$(( min_free_val * 2 ))
    [ "$mem_total" -lt 100 ] && [ "$min_free_val" -lt 8192 ] && min_free_val=8192
    [ "$min_free_val" -lt 4608 ] && min_free_val=4608
    if [ "$mem_total" -gt 100 ]; then [ "$min_free_val" -gt 65536 ] && min_free_val=65536; fi
    safe_rtt "$dyn_buf" "$rtt_avg" "$max_udp_pages" "$udp_mem_global_min" "$udp_mem_global_pressure" "$udp_mem_global_max" "$real_rtt_factors" "$loss_compensation"
    local udp_mem_scale="$rtt_scale_min $rtt_scale_pressure $rtt_scale_max"
    apply_initcwnd_optimization "true"
    apply_nic_core_boost "$real_c" "$net_bgt" "$net_usc" "$mem_total" "$target_qlen" "$t_usc" "$ring"
    if ! lsmod | grep -q "^tcp_bbr" 2>/dev/null; then
        if ! modprobe tcp_bbr 2>/dev/null; then err " slow~ "; exit 1; fi
    fi
    if [ -d /etc/modules-load.d ]; then echo "tcp_bbr" > /etc/modules-load.d/99-bbr.conf
    else grep -q "^tcp_bbr" /etc/modules 2>/dev/null || echo "tcp_bbr" >> /etc/modules; fi
    BACKUP_DIR="/root/sysctl-backup-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$BACKUP_DIR"
    [ -f /etc/sysctl.conf ] && cp /etc/sysctl.conf "$BACKUP_DIR/" 2>/dev/null || true
    [ -d /etc/sysctl.d ] && cp -r /etc/sysctl.d "$BACKUP_DIR/" 2>/dev/null || true
    local tcp_cca="bbr"
    local avail=$(sysctl -n net.ipv4.tcp_available_congestion_control 2>/dev/null || echo "cubic")
    if [[ "$avail" =~ "bbr3" ]]; then tcp_cca="bbr3"
    elif [[ "$avail" =~ "bbr2" ]]; then tcp_cca="bbr2"
    elif [[ "$avail" =~ "bbr" ]]; then tcp_cca="bbr"
    else tcp_cca="cubic"; fi
    if ! echo "$tcp_cca" > /proc/sys/net/ipv4/tcp_congestion_control 2>/dev/null; then
        sysctl -w net.ipv4.tcp_congestion_control="$tcp_cca" >/dev/null 2>&1 || true
    fi
    sysctl -w net.core.default_qdisc=fq >/dev/null 2>&1 || true
    local SYSCTL_FILE="/etc/sysctl.d/99-network-tuning.conf"
    cat > "$SYSCTL_FILE" <<SYSCTL
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1
net.ipv6.conf.all.accept_ra = 2
net.ipv6.conf.default.accept_ra = 2
vm.swappiness = $SWAPPINESS_VAL
vm.min_free_kbytes = $min_free_val
vm.dirty_ratio = 10
vm.dirty_background_ratio = 5
vm.overcommit_memory = 1
vm.panic_on_oom = 0
$(grep -q "^/dev/zram0 " /proc/swaps 2>/dev/null && echo "vm.page-cluster = 0" && echo "vm.vfs_cache_pressure = 1000")
net.core.netdev_max_backlog = $backlog
net.core.dev_weight = 64
net.core.busy_read = $BUSY_POLL_VAL
net.core.busy_poll = $BUSY_POLL_VAL
net.core.somaxconn = 65535
net.core.default_qdisc = fq
net.core.netdev_budget = $net_bgt
net.core.netdev_budget_usecs = $net_usc
net.core.netdev_tstamp_prequeue = 0
net.core.rmem_default = $def_mem
net.core.wmem_default = $def_mem
net.core.rmem_max = $udp_rmem
net.core.wmem_max = $udp_wmem
net.core.optmem_max = 2097152
net.ipv4.udp_mem = $udp_mem_scale
net.ipv4.tcp_rmem = 4096 87380 $tcp_rmem_max
net.ipv4.tcp_wmem = 4096 65536 $tcp_rmem_max
net.ipv4.tcp_congestion_control = $tcp_cca
net.ipv4.tcp_no_metrics_save = 1
net.ipv4.tcp_fastopen = 3
net.ipv4.tcp_notsent_lowat = 16384
net.ipv4.tcp_mtu_probing = 1
net.ipv4.ip_no_pmtu_disc = 0
net.ipv4.tcp_frto = 2
net.ipv4.tcp_slow_start_after_idle = 0
net.ipv4.tcp_limit_output_bytes = $([ "$mem_total" -ge 200 ] && echo "262144" || echo "131072")
net.ipv4.udp_gro_enabled = 1
net.ipv4.udp_early_demux = 1
net.ipv4.udp_l4_early_demux = 1
net.ipv4.tcp_ecn = 1
net.ipv4.tcp_ecn_fallback = 1
$( [[ "$tcp_cca" == "bbr3" ]] && echo "net.ipv4.tcp_ecn = 2" && echo "net.ipv4.tcp_reflect_tos = 1" )
net.netfilter.nf_conntrack_max = $ct_max
net.netfilter.nf_conntrack_udp_timeout = $ct_udp_to
net.netfilter.nf_conntrack_udp_timeout_stream = $ct_stream_to
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_max_orphans = $((mem_total * 1024))
net.ipv4.tcp_window_scaling = 1
net.ipv4.tcp_sack = 1
net.ipv4.tcp_syn_retries = 3
net.ipv4.tcp_synack_retries = 3
net.ipv4.tcp_retries2 = 5
net.ipv4.tcp_max_tw_buckets = 2000000
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_mem = 786432 1048576 26777216
$( [ "$mem_total" -lt 100 ] && cat <<LOWMEM
net.ipv4.tcp_moderate_rcvbuf = 1
net.ipv4.tcp_max_syn_backlog = 512
LOWMEM
)
SYSCTL
    if command -v sysctl >/dev/null 2>&1; then
        sysctl --system >/dev/null 2>&1 || sysctl -p "$SYSCTL_FILE" >/dev/null 2>&1 || true
    fi
}
detect_os
CPU_CORE=$(get_cpu_core)
optimize_system
exit 0
