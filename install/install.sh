#!/usr/bin/env bash
# Apprua installer for Linux (a server, or the hidden Ubuntu that the Windows installer creates in WSL2).
#
#   sudo bash install/install.sh                       # only this machine: apps on http://<name>.localhost
#   sudo APPRUA_NETWORK=lan APPRUA_DOMAIN=apps.office.lan bash install/install.sh   # the local network: http://<name>.apps.office.lan
#        (apprua.<name> and *.<name> must point to this machine in the DNS of the network: that is up to you)
#        HTTPS there with your own certificate for *.<name>: add APPRUA_CERT=/path/cert.pem APPRUA_CERT_KEY=/path/key.pem
#   sudo APPRUA_PROFILE=team APPRUA_NETWORK=internet APPRUA_DOMAIN=apps.example.com bash install/install.sh
#
# APPRUA_PROFILE (personal | team) says who Apprua is for; APPRUA_NETWORK (local | lan | internet) says where the
# portal and the apps open. Both are remembered: running it again without them keeps the previous choices.
#
# What it does (safe to run again: it upgrades and keeps data):
#   1. picks DNS servers that really answer (also with EDNS: some company servers reject it), kept across restarts
#   2. installs Coolify (the engine) if missing, with its admin account created automatically
#   3. creates a Coolify API token and a project for Apprua, without opening the Coolify panel
#   4. builds and starts the Apprua container on the Coolify network, data in the "apprua-data" volume
# Settings are kept in /root/.apprua/apprua.env (readable by root only).
set -euo pipefail

SRC="${APPRUA_SRC:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# Which Apprua runs: the image of a release, or one built from this copy of the code (so local changes are what runs).
# The release workflow writes the image of the release on the next line, in the archives attached to the release;
# in a copy from git it stays empty and Apprua is built from the source. APPRUA_IMAGE chooses any image;
# APPRUA_BUILD=1 builds from the source even in a release.
RELEASE_IMAGE=""
IMAGE="${APPRUA_IMAGE:-}"
[ -z "$IMAGE" ] && [ -z "${APPRUA_BUILD:-}" ] && IMAGE="$RELEASE_IMAGE"
PORT="${APPRUA_PORT:-3000}"
STATE_DIR=/root/.apprua
ENV_FILE="$STATE_DIR/apprua.env"
COOLIFY_LOCAL=http://127.0.0.1:8000

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[31mERROR: %s\033[0m\n' "$*"; exit 1; }   # stdout: stderr can get lost through wsl.exe
rand() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "${1:-24}"; }
# Messages in Italian when the system (or the Windows installer, with APPRUA_LANG=it) speaks Italian: L 'italiano' 'English'
APPRUA_LANG="${APPRUA_LANG:-${LANG:-en}}"
L() { case "$APPRUA_LANG" in it*) printf '%s' "$1" ;; *) printf '%s' "$2" ;; esac; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo bash $0)"
# In WSL the folders of Windows can be in PATH (/mnt/c/...): with Docker Desktop on the PC, "docker" would be its
# Windows command and the engine installer would skip installing Docker. Only the programs of this Linux count.
PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '^/mnt/' | paste -sd: -)"
export PATH
[ -f "$SRC/Dockerfile" ] || [ -n "$IMAGE" ] || die "Apprua source not found in $SRC (set APPRUA_SRC or APPRUA_IMAGE)"
mkdir -p "$STATE_DIR" && chmod 700 "$STATE_DIR"
touch "$ENV_FILE" && chmod 600 "$ENV_FILE"
getv() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
setv() { grep -vE "^$1=" "$ENV_FILE" > "$ENV_FILE.tmp" || true; echo "$1=$2" >> "$ENV_FILE.tmp"; mv "$ENV_FILE.tmp" "$ENV_FILE"; chmod 600 "$ENV_FILE"; }
# A setting of the running Apprua (installs made before the choices were remembered)
running() { docker inspect apprua --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep -E "^$1=" | cut -d= -f2- || true; }

# Who it is for and where it opens: given now > remembered > the running Apprua > defaults
PROFILE="${APPRUA_PROFILE:-$(getv APPRUA_PROFILE)}"; PROFILE="${PROFILE:-$(running APPRUA_PROFILE)}"; PROFILE="${PROFILE:-personal}"
DOMAIN="${APPRUA_DOMAIN:-$(getv APPRUA_DOMAIN)}"
NETWORK="${APPRUA_NETWORK:-$(getv APPRUA_NETWORK)}"
if [ -z "$NETWORK" ]; then
  old="$(running BASE_DOMAIN)"
  case "$old" in ""|localhost) NETWORK=local ;; *.sslip.io) NETWORK=lan ;; *) NETWORK=internet; DOMAIN="${DOMAIN:-$old}" ;; esac
  # older team installs passed the domain without a network
  if [ "$PROFILE" = team ] && [ -n "$DOMAIN" ] && [ "$DOMAIN" != localhost ]; then NETWORK=internet; fi
fi
case "$PROFILE" in personal|team) ;; *) die "APPRUA_PROFILE must be personal or team" ;; esac
case "$NETWORK" in local|lan|internet) ;; *) die "APPRUA_NETWORK must be local, lan or internet" ;; esac
# the address of this machine on the network (passed by the Windows installer: inside WSL the Linux has its own).
# The names of the local network must point there; the Settings page shows it.
LAN_IP="${APPRUA_LAN_IP:-}"
if [ -z "$LAN_IP" ] && grep -qi microsoft /proc/version 2>/dev/null; then LAN_IP="$(getv APPRUA_LAN_IP)"; fi
[ -n "$LAN_IP" ] || LAN_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)"
[ -n "$LAN_IP" ] && setv APPRUA_LAN_IP "$LAN_IP"
# Names (DNS) and certificates are the user's: Apprua takes the name the network already knows and never sets one up
DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')"
if [ -n "${APPRUA_WINDOWS:-}" ]; then
  how_name="$(L "Aggiungi -Domain app.tuaazienda.it al comando dell'installazione, oppure torna a solo questo PC con -Network local" "Add -Domain apps.example.com to the install command, or go back to this PC only with -Network local")"
else
  how_name="$(L "Aggiungi APPRUA_DOMAIN=app.tuaazienda.it, oppure torna a solo questa macchina con APPRUA_NETWORK=local" "Add APPRUA_DOMAIN=apps.example.com, or go back to this machine only with APPRUA_NETWORK=local")"
fi
case "$NETWORK" in
  local) DOMAIN=localhost ;;
  lan)
    [ -n "$LAN_IP" ] || die "could not find the address of this machine on the network: set APPRUA_LAN_IP"
    if [ -z "$DOMAIN" ] || [ "$DOMAIN" = localhost ]; then
      die "$(L "Per la rete locale serve un nome che la tua rete conosce già (chi gestisce la rete crea apprua.<nome> e *.<nome> verso $LAN_IP): $how_name" "The local network needs a name your network already knows (whoever manages the network points apprua.<name> and *.<name> to $LAN_IP). $how_name")"
    fi
    # earlier versions used sslip.io (a public service): Apprua no longer depends on it, a name is chosen now
    if [ -z "${APPRUA_DOMAIN:-}" ] && [[ "$DOMAIN" == *.sslip.io ]]; then
      die "$(L "Apprua non usa più sslip.io: per la rete locale serve un nome della tua rete (apprua.<nome> e *.<nome> verso $LAN_IP). $how_name" "Apprua no longer uses sslip.io: the local network needs a name of your own network (apprua.<name> and *.<name> pointing to $LAN_IP). $how_name")"
    fi ;;
  internet)
    if [ -z "$DOMAIN" ] || [ "$DOMAIN" = localhost ]; then
      die "APPRUA_NETWORK=internet needs APPRUA_DOMAIN (a domain whose *.domain points to this server)"
    fi ;;
esac
if [ "$NETWORK" != local ] && ! [[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then
  die "$(L "Il nome '$DOMAIN' non è valido: scrivilo come app.tuaazienda.it (senza http:// e senza /)" "The name '$DOMAIN' is not valid: write it like apps.example.com (no http://, no /)")"
fi

# HTTPS: none on this machine (browsers treat localhost as secure), Let's Encrypt on the internet, or the certificate
# the user gives (APPRUA_CERT + APPRUA_CERT_KEY, PEM files: for the local network, or on the internet instead of
# Let's Encrypt). Apprua only checks it and hands it to the proxy: getting and renewing it is up to the user.
HTTPS="${APPRUA_HTTPS:-$(getv APPRUA_HTTPS)}"
CERT_DIR="$STATE_DIR/cert"
cert_names() {   # the certificate must cover the portal and every app: apprua.<name> and *.<name>
  local n
  for n in "apprua.$DOMAIN" "verifica.$DOMAIN"; do
    openssl x509 -in "$1" -noout -checkhost "$n" 2>/dev/null | grep -q 'does match' ||
      die "$(L "Il certificato non vale per $n: serve un certificato per *.$DOMAIN (con -Cert e -CertKey, oppure APPRUA_CERT e APPRUA_CERT_KEY), oppure torna a http con -Https off (APPRUA_HTTPS=off)" "The certificate is not valid for $n: a certificate for *.$DOMAIN is needed (-Cert and -CertKey, or APPRUA_CERT and APPRUA_CERT_KEY), or go back to http with -Https off (APPRUA_HTTPS=off)")"
  done
}
if [ -n "${APPRUA_CERT:-}" ] || [ -n "${APPRUA_CERT_KEY:-}" ]; then
  [ "$NETWORK" != local ] || die "$(L "Su solo questa macchina l'HTTPS non serve: il certificato si usa con la rete locale o internet" "On this machine only HTTPS is not needed: a certificate goes with the local network or the internet")"
  [ -f "${APPRUA_CERT:-}" ] || die "$(L "Certificato non trovato: '${APPRUA_CERT:-}' (APPRUA_CERT)" "Certificate not found: '${APPRUA_CERT:-}' (APPRUA_CERT)")"
  [ -f "${APPRUA_CERT_KEY:-}" ] || die "$(L "Chiave del certificato non trovata: '${APPRUA_CERT_KEY:-}' (APPRUA_CERT_KEY)" "Certificate key not found: '${APPRUA_CERT_KEY:-}' (APPRUA_CERT_KEY)")"
  openssl x509 -in "$APPRUA_CERT" -noout 2>/dev/null || die "$(L "Il file del certificato non è un certificato PEM" "The certificate file is not a PEM certificate")"
  [ "$(openssl x509 -in "$APPRUA_CERT" -noout -pubkey 2>/dev/null)" = "$(openssl pkey -in "$APPRUA_CERT_KEY" -pubout 2>/dev/null)" ] ||
    die "$(L "La chiave non corrisponde al certificato" "The key does not match the certificate")"
  openssl x509 -in "$APPRUA_CERT" -noout -checkend 0 >/dev/null || die "$(L "Il certificato è scaduto" "The certificate has expired")"
  cert_names "$APPRUA_CERT"
  mkdir -p "$CERT_DIR" && chmod 700 "$CERT_DIR"
  install -m 600 "$APPRUA_CERT" "$CERT_DIR/apprua.crt" && install -m 600 "$APPRUA_CERT_KEY" "$CERT_DIR/apprua.key"
  HTTPS=own
fi
case "$NETWORK" in
  local) HTTPS=off ;;
  lan) HTTPS="${HTTPS:-off}"; [ "$HTTPS" = letsencrypt ] && HTTPS=off ;;   # Let's Encrypt cannot reach a local network
  internet) [ "$HTTPS" = own ] || HTTPS=letsencrypt ;;
esac
case "$HTTPS" in off|letsencrypt|own) ;; *) die "APPRUA_HTTPS must be off, own or letsencrypt" ;; esac
if [ "$HTTPS" = own ] && [ ! -f "$CERT_DIR/apprua.crt" ]; then
  die "$(L "Per l'HTTPS con il tuo certificato servono APPRUA_CERT e APPRUA_CERT_KEY (file PEM)" "HTTPS with your certificate needs APPRUA_CERT and APPRUA_CERT_KEY (PEM files)")"
fi
# the certificate kept from an earlier run: still right for the name (which may have changed)? Ended? (only a warning:
# an update must not stop because of it)
if [ "$HTTPS" = own ]; then
  cert_names "$CERT_DIR/apprua.crt"
  openssl x509 -in "$CERT_DIR/apprua.crt" -noout -checkend 0 >/dev/null ||
    info "$(L "Attenzione: il tuo certificato è scaduto, il browser avvisa chi apre le app. Dai quello nuovo con -Cert e -CertKey (APPRUA_CERT e APPRUA_CERT_KEY)" "Note: your certificate has expired, browsers warn whoever opens the apps. Give the new one with -Cert and -CertKey (APPRUA_CERT and APPRUA_CERT_KEY)")"
fi
SCHEME=https; [ "$HTTPS" = off ] && SCHEME=http
setv APPRUA_PROFILE "$PROFILE"; setv APPRUA_NETWORK "$NETWORK"; setv APPRUA_DOMAIN "$DOMAIN"
[ "$NETWORK" = local ] || setv APPRUA_HTTPS "$HTTPS"

# ---------------------------------------------------------------- 1. DNS
# Two things seen on company networks: the DNS bridge of WSL can stop answering, and some DNS servers reject EDNS
# queries (image downloads during builds then fail). So every candidate is asked one EDNS query, and only the servers
# that answer are kept. On Ubuntu with systemd the choice lives in systemd-resolved, so it survives a restart of Linux.
say "$(L 'Controllo la connessione a internet e i DNS' 'Checking the internet connection and DNS')"
dns_works() {   # one A query for ghcr.io with EDNS, 3 s timeout
  python3 - "$1" <<'PY' >/dev/null 2>&1
import socket, struct, sys
q = struct.pack(">HHHHHH", 0x5A17, 0x0100, 1, 0, 0, 1) + b"\x04ghcr\x02io\x00" + struct.pack(">HH", 1, 1)
q += b"\x00" + struct.pack(">HHIH", 41, 1232, 0, 0)
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(3); s.sendto(q, (sys.argv[1], 53))
r = s.recv(1500)
sys.exit(0 if r[3] & 15 == 0 and struct.unpack(">H", r[6:8])[0] > 0 else 1)
PY
}
set_dns() {
  if grep -qi microsoft /proc/version && ! grep -q 'generateResolvConf=false' /etc/wsl.conf 2>/dev/null; then
    printf '\n[network]\ngenerateResolvConf=false\n' >> /etc/wsl.conf
  fi
  if systemctl is-active -q systemd-resolved 2>/dev/null; then
    mkdir -p /etc/systemd/resolved.conf.d
    printf '# managed by apprua (install.sh): DNS servers that answer\n[Resolve]\nDNS=%s\nDomains=~.\n' "$*" > /etc/systemd/resolved.conf.d/apprua.conf
    systemctl restart systemd-resolved
    ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf
  else
    rm -f /etc/resolv.conf
    { echo "# managed by apprua (install.sh): DNS servers that answer"; for s in "$@"; do echo "nameserver $s"; done; } > /etc/resolv.conf
  fi
}
if command -v python3 >/dev/null; then
  # the servers in use now (behind the systemd stub, if any), then the ones of the PC (passed by the Windows installer), then public ones
  active=$(awk '/^nameserver/{print $2}' "$(readlink -f /etc/resolv.conf | grep -q stub-resolv && echo /run/systemd/resolve/resolv.conf || echo /etc/resolv.conf)" 2>/dev/null | grep -v '^127\.' || true)
  cands=(); host_dns="${HOST_DNS:-}"
  for s in $active $(awk '/^nameserver/{print $2}' /mnt/wsl/resolv.conf 2>/dev/null) ${host_dns//,/ } 1.1.1.1 8.8.8.8; do
    case " ${cands[*]} " in *" $s "*) ;; *) [[ $s == 127.* ]] || cands+=("$s") ;; esac
  done
  good=(); bad=()
  for s in "${cands[@]}"; do if dns_works "$s"; then good+=("$s"); else bad+=("$s"); fi; done
  [ "${#good[@]}" -gt 0 ] || die "no internet connection or DNS: check the network and retry"
  all_ok=1; [ -n "$active" ] || all_ok=0
  for s in $active; do case " ${good[*]} " in *" $s "*) ;; *) all_ok=0 ;; esac; done
  if [ "$all_ok" = 1 ]; then info "ok"
  else info "DNS servers that do not answer: ${bad[*]:-none}. Using: ${good[*]}"; set_dns "${good[@]}"; fi
elif ! getent hosts cdn.coollabs.io >/dev/null; then
  info "DNS does not answer: using public DNS servers (1.1.1.1, 8.8.8.8)"
  set_dns 1.1.1.1 8.8.8.8
fi
getent hosts cdn.coollabs.io >/dev/null || die "no internet connection or DNS: check the network and retry"

# ---------------------------------------------------------------- 2. Coolify
# On a server the Coolify panel is closed to the network before Coolify exists: until Apprua has created its
# administrator (below, "Securing the Coolify panel") anyone who reached it could register first.
# Not in WSL: there Windows forwards only to its own localhost (except with networkingMode=mirrored in .wslconfig,
# where the ports of the Linux open on the PC's network too). APPRUA_COOLIFY_OPEN=1 leaves the ports open.
ON_NETWORK=1
grep -qi microsoft /proc/version 2>/dev/null && [ "$(wslinfo --networking-mode 2>/dev/null)" != mirrored ] && ON_NETWORK=0
[ -n "${APPRUA_TEST_COOLIFY_LOCK:-}" ] && ON_NETWORK=1
# "This machine only": the ports of the apps (80, 443) are closed to the network too (no sign-in in front of the apps)
APPRUA_LOCAL_ONLY=0
[ "$NETWORK" = local ] && APPRUA_LOCAL_ONLY=1
mkdir -p /var/lib/apprua && echo "$APPRUA_LOCAL_ONLY" > /var/lib/apprua/local-only   # read by apprua-coolify-lock
install_lock() {
  install -m 755 "$SRC/install/apprua-coolify-lock.sh" /usr/local/sbin/apprua-coolify-lock 2>/dev/null \
    || install -m 755 "$(dirname "${BASH_SOURCE[0]}")/apprua-coolify-lock.sh" /usr/local/sbin/apprua-coolify-lock
}
# A minimal server (Debian) may have no iptables yet: Docker would bring it only after Coolify is up, with its panel
# open to the network meanwhile. Install it first where the system has apt-get (otherwise the lock is applied below,
# once Docker has brought it).
if [ "$ON_NETWORK" = 1 ] && [ "${APPRUA_COOLIFY_OPEN:-}" != 1 ] && ! command -v iptables >/dev/null && command -v apt-get >/dev/null; then
  info "$(L 'Installo iptables, per chiudere il pannello di Coolify prima che esista' 'Installing iptables, to close the Coolify panel before it exists')"
  { DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables >/dev/null 2>&1 \
    || { apt-get update -qq >/dev/null 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables >/dev/null 2>&1; }; } \
    || info "could not install iptables now: the panel is closed after the installation of Docker"
fi
if [ "$ON_NETWORK" = 1 ] && [ "${APPRUA_COOLIFY_OPEN:-}" != 1 ] && command -v iptables >/dev/null; then
  install_lock && /usr/local/sbin/apprua-coolify-lock on || info "could not close the Coolify panel yet: done again after the installation of Docker"
fi
# The engine stays on the version this Apprua was tested with ("apprua.coolify" in package.json): Coolify never updates
# by itself (a new Coolify could change its API under Apprua); a new release of Apprua moves it to a newer tested one.
# APPRUA_COOLIFY_VERSION chooses another version ("latest": the newest, at your own risk).
COOLIFY_VERSION="${APPRUA_COOLIFY_VERSION:-$(grep -o '"coolify": *"[^"]*"' "$SRC/package.json" 2>/dev/null | grep -o '[0-9][0-9.]*[^"]*' | head -1 || true)}"
COOLIFY_VERSION="${COOLIFY_VERSION:-4.6.0}"
[ "$COOLIFY_VERSION" = latest ] && COOLIFY_VERSION=""
coolify_install() {   # also upgrades an existing Coolify, keeping its data
  CP="$(getv COOLIFY_ADMIN_PASSWORD)"; [ -n "$CP" ] || { CP="$(rand 20)Aa1-"; setv COOLIFY_ADMIN_PASSWORD "$CP"; }
  # Coolify only accepts a root password with upper and lower case, numbers and a symbol
  curl -fsSL https://cdn.coollabs.io/coolify/install.sh | \
    env AUTOUPDATE=false ROOT_USERNAME=admin ROOT_USER_EMAIL=admin@apprua.local ROOT_USER_PASSWORD="$CP" bash -s $COOLIFY_VERSION
}
# Coolify already here, also when it is stopped right now (its settings or its container are there)
if [ -f /data/coolify/source/.env ] || docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx coolify; then
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx coolify && [ -f /data/coolify/source/docker-compose.yml ]; then
    info "$(L 'Coolify è fermo: lo avvio' 'Coolify is stopped: starting it')"
    ( cd /data/coolify/source && docker compose --env-file .env -f docker-compose.yml -f docker-compose.prod.yml up -d >/dev/null 2>&1 ) || true
  fi
  have=$(docker inspect coolify --format '{{.Config.Image}}' 2>/dev/null | sed 's/.*://')
  if [ -n "$COOLIFY_VERSION" ] && [ -n "$have" ] && [ "$have" != "$COOLIFY_VERSION" ] \
     && [ "$(printf '%s\n%s\n' "$have" "$COOLIFY_VERSION" | sort -V | head -1)" = "$have" ]; then
    say "$(L "Aggiorno Coolify dalla $have alla $COOLIFY_VERSION (la versione provata con Apprua). Le app restano accese." "Updating Coolify from $have to $COOLIFY_VERSION (the version tested with this Apprua). The apps keep running.")"
    coolify_install
  else
    say "$(L "Coolify $have è già installato: lo uso" "Coolify $have is already installed: using it")"
    if [ -n "$COOLIFY_VERSION" ] && [ "$have" != "$COOLIFY_VERSION" ]; then
      info "Note: this Apprua was tested with Coolify $COOLIFY_VERSION; $have is newer and is left as it is."
    fi
  fi
else
  say "$(L "Installo Coolify ${COOLIFY_VERSION:-(ultima versione)}, il motore che costruisce e fa girare le app. Ci vuole qualche minuto." "Installing Coolify ${COOLIFY_VERSION:-(newest)} (the engine that builds and runs the apps). It takes a few minutes.")"
  # A machine below what the guide asks for still installs, but says so first (apps that stop for no clear reason
  # are usually this). Not in WSL: there the Windows installer has its own checks.
  if ! grep -qi microsoft /proc/version 2>/dev/null; then
    mem_mb=$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
    disk_gb=$(df -Pk / 2>/dev/null | awk 'NR==2 {print int($4/1048576)}' || echo 0)
    if [ "${mem_mb:-0}" -gt 0 ] && [ "$mem_mb" -lt 3500 ]; then
      info "$(L "Attenzione: questa macchina ha circa $mem_mb MB di memoria; la guida ne chiede almeno 4 GB. L'installazione continua, ma le app potrebbero fermarsi." "Note: this machine has about $mem_mb MB of memory; the guide asks for at least 4 GB. The installation goes on, but apps may stop.")"
    fi
    if [ "${disk_gb:-0}" -gt 0 ] && [ "$disk_gb" -lt 15 ]; then
      info "$(L "Attenzione: su questa macchina restano circa $disk_gb GB di disco; la guida ne chiede 30. L'installazione continua, ma lo spazio può finire presto." "Note: this machine has about $disk_gb GB of free disk; the guide asks for 30. The installation goes on, but the space may run out soon.")"
    fi
  fi
  # remembered before installing: this Coolify is Apprua's own, so its first user must be Apprua's, also when the
  # installation stops halfway and the installer is run again (a stranger could have registered in between)
  setv COOLIFY_BY_APPRUA 1
  coolify_install
fi

# WSL only: all the Linux of the PC share one network. A Docker in another Linux can leave bridges with the same
# addresses as ours, and remove our network rules when it stops: the portal answers but the apps do not.
# Remove those leftovers (bridges our Docker does not know) and restart Docker, which writes its rules again.
if grep -qi microsoft /proc/version 2>/dev/null && command -v ip >/dev/null; then
  known=$(docker network ls -q 2>/dev/null | cut -c1-12)
  ghosts=""
  for b in $(ip -br link | awk '$1 ~ /^br-[0-9a-f]+$/ {print $1}'); do
    echo "$known" | grep -qx "${b#br-}" || ghosts="$ghosts $b"
  done
  rules_gone=false
  if command -v iptables >/dev/null && docker ps --format '{{.Names}}' | grep -qx coolify-proxy \
     && ! iptables -t nat -S DOCKER 2>/dev/null | grep -q DNAT; then rules_gone=true; fi
  # rules left by that other Docker for its own bridges (e.g. "drop traffic to 10.0.1.9 unless it comes from br-x"):
  # when one of our containers gets the same address, nobody can reach it any more
  if command -v iptables >/dev/null; then
    for table in raw nat filter; do
      iptables -t "$table" -S 2>/dev/null | grep -E '^-A .*br-[0-9a-f]+' | while read -r rule; do
        for b in $(grep -oE 'br-[0-9a-f]+' <<<"$rule" | sort -u); do
          if ! ip link show "$b" >/dev/null 2>&1 && ! grep -q "^$b\$" <<<"$(printf 'br-%s\n' $known)"; then
            # shellcheck disable=SC2086
            iptables -t "$table" ${rule/-A/-D} 2>/dev/null && info "removed a leftover network rule ($table: $b)"
            break
          fi
        done
      done
    done
  fi
  if [ -n "$ghosts" ] || $rules_gone; then
    say "$(L 'Riparo la rete di Docker (un altro Docker su questo PC l'"'"'aveva cambiata)' 'Repairing the network of Docker (another Docker on this PC had changed it)')"
    for b in $ghosts; do ip link delete "$b" 2>/dev/null && info "removed leftover $b"; done
    systemctl restart docker
  fi
fi
say "$(L 'Aspetto che Coolify sia pronto' 'Waiting for Coolify')"
for _ in $(seq 1 120); do curl -fs -m 5 "$COOLIFY_LOCAL/api/health" >/dev/null 2>&1 && break; sleep 2; done
curl -fs -m 5 "$COOLIFY_LOCAL/api/health" >/dev/null || die "Coolify does not answer on $COOLIFY_LOCAL"
info "Coolify $(curl -fs -m 5 "$COOLIFY_LOCAL/api/v1/version" -H 'Accept: application/json' 2>/dev/null || echo ready)"

# Coolify creates its administrator from ROOT_USER_* only if the email domain has DNS records and the
# password passes its rules; otherwise it silently skips it and leaves the panel open to anyone who
# registers first. Make sure the administrator exists and registration is closed.
# Coolify answers /api/health before its own setup (settings, root team) is finished: wait and retry.
# Safe to run again: an administrator that Apprua created (admin@apprua.local) is completed, any other is left alone.
say "$(L 'Metto in sicurezza il pannello di Coolify' 'Securing the Coolify panel')"
CP="$(getv COOLIFY_ADMIN_PASSWORD)"; [ -n "$CP" ] || { CP="$(rand 20)Aa1-"; setv COOLIFY_ADMIN_PASSWORD "$CP"; }
secure_coolify() {
  docker exec -e "AP_PASS=$CP" coolify php artisan tinker --execute='
    $s = App\Models\InstanceSettings::find(0);
    $t = App\Models\Team::find(0);
    if (!$s || !$t) { echo "notready"; }
    else {
      $u = App\Models\User::find(0); $new = false;
      if (!$u) {
        $u = (new App\Models\User)->forceFill(["id" => 0, "name" => "admin", "email" => "admin@apprua.local",
               "password" => Illuminate\Support\Facades\Hash::make(getenv("AP_PASS"))]);
        $u->save(); $new = true;
      }
      if ($u->email === "admin@apprua.local") {
        if (!$u->teams()->where("team_id", 0)->exists()) { $u->teams()->attach($t, ["role" => "owner"]); }
        $s->is_registration_enabled = false;
        $r = $new ? "created" : "secured";
      } else { $r = "foreign"; }
      $s->is_api_enabled = true;   # off by default in a new Coolify; Apprua drives Coolify through its API
      $s->is_auto_update_enabled = false;   # Coolify moves to a new version only with a new release of Apprua
      $s->save();
      echo $r;
    }' 2>&1 | tail -1
}
R=""
for _ in $(seq 1 45); do
  R=$(secure_coolify)
  case "$R" in *created|*secured|*foreign) break ;; esac
  sleep 2
done
case "$R" in
  *created) info "administrator created, registration closed, API on" ;;
  *secured) info "administrator present, registration closed, API on" ;;
  *foreign)
    if [ "$(getv COOLIFY_BY_APPRUA)" = 1 ]; then
      # Apprua's own Coolify whose administrator now has another email (changed in the Coolify panel): the key Apprua
      # saved still opens it, so it is still Apprua's
      T0="$(getv COOLIFY_TOKEN)"
      if [ -n "$T0" ] && curl -fs -m 10 -H "Authorization: Bearer $T0" "$COOLIFY_LOCAL/api/v1/version" >/dev/null; then
        info "the Coolify administrator has another email now (changed in the panel): still Apprua's Coolify; API on"
      else
        # a Coolify installed by Apprua with someone else as its first user: somebody registered before Apprua
        die "$(L "Coolify, installato da Apprua, ha un altro primo utente: forse qualcuno si è registrato prima di Apprua. Non lo uso. Controlla chi è l'utente nel pannello di Coolify; se non lo conosci, togli tutto con 'sudo bash install/uninstall.sh' (offre una copia prima) e reinstalla." "Coolify, installed by Apprua, has another first user: maybe somebody registered before Apprua. Not using it. Check who that user is in the Coolify panel; if you do not know them, remove everything with 'sudo bash install/uninstall.sh' (it offers a copy first) and install again.")"
      fi
    else
      # a Coolify that was here before Apprua, with projects of its own: uninstall.sh then removes only Apprua
      setv COOLIFY_FOREIGN 1
      info "Coolify already has its own administrator (left as it is); API on"
    fi ;;
  *)        die "could not set up the Coolify administrator (last answer: ${R:-none})" ;;
esac

# ---------------------------------------------------------------- 3. Coolify token, server, project
say "$(L 'Collego Apprua a Coolify' 'Connecting Apprua to Coolify')"
TOKEN="$(getv COOLIFY_TOKEN)"
if [ -z "$TOKEN" ] || ! curl -fs -m 10 -H "Authorization: Bearer $TOKEN" "$COOLIFY_LOCAL/api/v1/version" >/dev/null; then
  TOKEN=$(docker exec coolify php artisan tinker --execute='
    $u = App\Models\User::find(0);
    session(["currentTeam" => $u->teams()->first()]);
    echo $u->createToken("apprua", ["root"])->plainTextToken;' 2>/dev/null | tail -1)
  [[ "$TOKEN" == *"|"* ]] || die "could not create the Coolify API token"
  setv COOLIFY_TOKEN "$TOKEN"
fi
api() { curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Accept: application/json' -H 'Content-Type: application/json' "$@"; }
# (the Coolify API itself was switched on in "Securing the Coolify panel")
SERVER_UUID=$(api "$COOLIFY_LOCAL/api/v1/servers" | grep -o '"uuid":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
[ -n "$SERVER_UUID" ] || die "no server found in Coolify"
PROJECT_UUID="$(getv COOLIFY_PROJECT_UUID)"
if [ -z "$PROJECT_UUID" ] || ! api "$COOLIFY_LOCAL/api/v1/projects/$PROJECT_UUID" >/dev/null 2>&1; then
  # a project of an earlier Apprua on this Coolify (after uninstall.sh on a Coolify that was here before): use it.
  # "|| true": on a new Coolify there is none, and grep finding nothing must not end the script (set -e, pipefail)
  PROJECT_UUID=$(api "$COOLIFY_LOCAL/api/v1/projects" | grep -o '{[^{}]*}' | grep '"name":"Apprua apps"' | grep -o '"uuid":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
  [ -n "$PROJECT_UUID" ] || PROJECT_UUID=$(api -X POST "$COOLIFY_LOCAL/api/v1/projects" -d '{"name":"Apprua apps","description":"Apps published with Apprua"}' | grep -o '"uuid":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
  [ -n "$PROJECT_UUID" ] || die "could not create the Coolify project"
  setv COOLIFY_PROJECT_UUID "$PROJECT_UUID"
fi
info "server $SERVER_UUID, project $PROJECT_UUID"

# ---------------------------------------------------------------- 4. Apprua
if [ -n "$IMAGE" ]; then
  say "$(L "Scarico $IMAGE" "Downloading $IMAGE")"
  if ! docker pull "$IMAGE"; then
    # no internet to the registry, or the image is not public yet: the code is here, so build it instead
    [ -f "$SRC/Dockerfile" ] || die "could not download $IMAGE: check the connection and retry"
    info "Could not download $IMAGE: building it from $SRC instead"
    IMAGE=""
  fi
fi
if [ -z "$IMAGE" ]; then
  say "$(L "Preparo Apprua da $SRC (qualche minuto)" "Building Apprua from $SRC (a few minutes)")"
  docker build -q -t apprua:local "$SRC" >/dev/null
  IMAGE=apprua:local
fi

case "$NETWORK" in
  local) PUBLIC_URL="http://localhost:$PORT" ;;
  *) PUBLIC_URL="$SCHEME://apprua.$DOMAIN" ;;
esac
if [ "$NETWORK" != local ]; then
  # The portal is reachable from the network: the first-run setup asks for a one-time code printed here,
  # so nobody else can take over a fresh install. (Older installs keep their INITIAL_ADMIN_* settings.)
  if [ -z "$(getv INITIAL_ADMIN_PASSWORD)" ] && [ -z "$(getv SETUP_CODE)" ]; then
    setv SETUP_CODE "$(rand 12 | tr '[:lower:]' '[:upper:]' | sed 's/.\{4\}/&-/g; s/-$//')"
  fi
fi

# Sign-in in front of the apps (local network and internet): the proxy asks Apprua's gate before every request to an
# app, so each app opens only to its owner, to everyone with an account, or to anyone (chosen per app in the portal).
PROXY_DYNAMIC=/data/coolify/proxy/dynamic
# Your certificate: the proxy serves it for the portal and every app (it sees /data/coolify/proxy as /traefik)
if [ -d "$PROXY_DYNAMIC" ]; then
  if [ "$HTTPS" = own ]; then
    mkdir -p /data/coolify/proxy/certs && chmod 700 /data/coolify/proxy/certs
    install -m 600 "$CERT_DIR/apprua.crt" /data/coolify/proxy/certs/apprua.crt
    install -m 600 "$CERT_DIR/apprua.key" /data/coolify/proxy/certs/apprua.key
    cat > "$PROXY_DYNAMIC/apprua-cert.yaml" <<'YAML'
# managed by apprua (install.sh): the certificate given to the installer, for the portal and every app
tls:
  certificates:
    - certFile: /traefik/certs/apprua.crt
      keyFile: /traefik/certs/apprua.key
  stores:
    default:
      defaultCertificate:
        certFile: /traefik/certs/apprua.crt
        keyFile: /traefik/certs/apprua.key
YAML
    CERT_END="$(openssl x509 -in "$CERT_DIR/apprua.crt" -noout -enddate | cut -d= -f2)"
    info "$(L "HTTPS con il tuo certificato (valido fino al $CERT_END): rinnovarlo tocca a te" "HTTPS with your certificate (valid until $CERT_END): renewing it is up to you")"
  else
    rm -f "$PROXY_DYNAMIC/apprua-cert.yaml" /data/coolify/proxy/certs/apprua.crt /data/coolify/proxy/certs/apprua.key
  fi
fi
GATE=0
if [ -d "$PROXY_DYNAMIC" ]; then
  if [ "$NETWORK" != local ]; then
    cat > "$PROXY_DYNAMIC/apprua-auth.yaml" <<'YAML'
# managed by apprua (install.sh): the sign-in in front of the apps asks Apprua who can open each app
http:
  middlewares:
    apprua-auth:
      forwardAuth:
        address: 'http://apprua:3000/_apprua/gate'
YAML
    GATE=1
  else
    rm -f "$PROXY_DYNAMIC/apprua-auth.yaml"
  fi
fi

# On a server, the Coolify panel (8000) and its live updates (6001, 6002) answer only on the server itself: from
# elsewhere they are reached through an SSH tunnel (see docs/configuration.md). Docker publishes ports past the usual
# firewall: install/apprua-coolify-lock.sh closes them (IPv4 and IPv6), applied again at every start by a small service.
# Not in WSL: there Windows forwards only to its own localhost. APPRUA_COOLIFY_OPEN=1 leaves the ports open.
if [ "$ON_NETWORK" = 1 ]; then
  if [ "${APPRUA_COOLIFY_OPEN:-}" = 1 ]; then
    systemctl disable --now apprua-coolify-lock.service >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/apprua-coolify-lock.service
    [ -x /usr/local/sbin/apprua-coolify-lock ] && /usr/local/sbin/apprua-coolify-lock off
    rm -f /usr/local/sbin/apprua-coolify-lock
    # the rules of the versions before 1.0 (IPv4 only)
    for p in 8000 6001 6002; do while iptables -D DOCKER-USER -p tcp -m conntrack --ctorigdstport "$p" --ctdir ORIGINAL -j DROP 2>/dev/null; do :; done; done
    info "Coolify panel left open to the network (APPRUA_COOLIFY_OPEN=1)"
  elif command -v iptables >/dev/null; then
    install_lock
    /usr/local/sbin/apprua-coolify-lock on || die "could not close the Coolify panel to the network (iptables): fix the firewall, or run again with APPRUA_COOLIFY_OPEN=1 to leave it open on purpose"
    cat > /etc/systemd/system/apprua-coolify-lock.service <<'UNIT'
[Unit]
Description=Apprua: Coolify panel reachable only from this server (IPv4 and IPv6)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/apprua-coolify-lock on

[Install]
# also every time Docker starts again (a copy stops it): a service that "Requires" Docker stops with it
WantedBy=multi-user.target docker.service
UNIT
    systemctl daemon-reload && systemctl reenable apprua-coolify-lock.service >/dev/null 2>&1 && systemctl restart apprua-coolify-lock.service
    info "Coolify panel reachable only from this server (ports 8000, 6001, 6002 closed to the network)"
    [ "$APPRUA_LOCAL_ONLY" = 1 ] && info "$(L "Solo questa macchina: anche le porte delle app (80, 443) sono chiuse alla rete" "This machine only: the ports of the apps (80, 443) are closed to the network too")"
  else
    die "iptables is missing: the Coolify panel cannot be closed to the network. Install iptables, or run again with APPRUA_COOLIFY_OPEN=1 to leave it open on purpose"
  fi
fi

# Nightly copies (backup.sh --schedule): root runs a copy of the script that only root can change, kept up to date
# here. Before 1.0 the service ran it from the folder where Apprua was downloaded: moved.
if [ -f /etc/systemd/system/apprua-backup.service ]; then
  install -d -m 755 /usr/local/lib/apprua && install -m 755 "$SRC/install/backup.sh" /usr/local/lib/apprua/backup.sh
  sed -i 's|^ExecStart=.*|ExecStart=/bin/bash /usr/local/lib/apprua/backup.sh|' /etc/systemd/system/apprua-backup.service
  systemctl daemon-reload
fi

# Every published app in its own lane (install/apprua-guard.sh): it answers visits and reaches the internet, and the
# other apps only through their public address and sign-in; never Apprua, the engine, its database or this machine.
# A small service keeps the rules up to date as apps start and stop. APPRUA_GUARD=0 turns it off (experts only).
if [ "${APPRUA_GUARD:-1}" = 0 ]; then
  systemctl disable --now apprua-guard.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/apprua-guard.service
  [ -x /usr/local/sbin/apprua-guard ] && /usr/local/sbin/apprua-guard off >/dev/null
  info "Apps not kept apart (APPRUA_GUARD=0)"
elif command -v iptables >/dev/null; then
  say "$(L 'Metto ogni app nella sua corsia' 'Keeping every app in its own lane')"
  install -m 755 "$SRC/install/apprua-guard.sh" /usr/local/sbin/apprua-guard 2>/dev/null || {
    # a release without the source next to the installer: the copy that came with it is in the same folder
    install -m 755 "$(dirname "${BASH_SOURCE[0]}")/apprua-guard.sh" /usr/local/sbin/apprua-guard
  }
  cat > /etc/systemd/system/apprua-guard.service <<'UNIT'
[Unit]
Description=Apprua: every published app in its own lane
After=docker.service
Requires=docker.service

[Service]
ExecStart=/usr/local/sbin/apprua-guard watch
Restart=always
RestartSec=3

[Install]
# also every time Docker starts again (a copy stops it): a service that "Requires" Docker stops with it
WantedBy=multi-user.target docker.service
UNIT
  systemctl daemon-reload && systemctl reenable apprua-guard.service >/dev/null 2>&1 && systemctl restart apprua-guard.service
  info "$(/usr/local/sbin/apprua-guard apply)"
fi

say "$(L 'Avvio Apprua' 'Starting Apprua')"
docker rm -f apprua >/dev/null 2>&1 || true
# What opens something (the token of the engine, the setup code, the first password) goes to Docker in a file only
# root can read, not on the command line, where every user of the machine could read it while the command runs.
RUN_ENV="$STATE_DIR/apprua-run.env"
( umask 077; printf 'COOLIFY_TOKEN=%s\n' "$TOKEN" > "$RUN_ENV" )
# Apprua needs no special power of the system: it runs with none, and cannot gain any
args=(-d --name apprua --restart unless-stopped --network coolify -v apprua-data:/data
  --cap-drop ALL --security-opt no-new-privileges --env-file "$RUN_ENV"
  -e "APPRUA_PROFILE=$PROFILE" -e "APPRUA_NETWORK=$NETWORK" -e "BASE_DOMAIN=$DOMAIN" -e "PUBLIC_URL=$PUBLIC_URL"
  -e "APPRUA_HTTPS=$HTTPS" -e "APP_SCHEME=$SCHEME" -e "APPRUA_LAN_IP=$LAN_IP"
  -e COOLIFY_API_URL=http://coolify:8080
  -e "COOLIFY_PROJECT_UUID=$PROJECT_UUID" -e "COOLIFY_SERVER_UUID=$SERVER_UUID"
  -e GIT_INTERNAL_URL=http://apprua:3001 -e "APPRUA_GATE=$GATE" -e "APPRUA_COOLIFY_TESTED=$COOLIFY_VERSION")
# after install/backup.sh --restore: publish again the apps that were online (once: a new value each restore)
if [ -n "${APPRUA_REPUBLISH:-}" ]; then args+=(-e "APPRUA_REPUBLISH=$(date +%s)"); fi
# RAM of the whole PC (passed by the Windows installer): the Settings page shows how much Apprua can still get
[ -n "${HOST_MEMORY_GB:-}" ] && setv HOST_MEMORY_GB "$HOST_MEMORY_GB"
[ -n "$(getv HOST_MEMORY_GB)" ] && args+=(-e "HOST_MEMORY_GB=$(getv HOST_MEMORY_GB)")
# An empty folder on the Windows drive (read-only): it lets the Settings page measure the real free space there
[ -n "${HOST_DISK_DIR:-}" ] && setv HOST_DISK_DIR "$HOST_DISK_DIR"
[ -n "$(getv HOST_DISK_DIR)" ] && mkdir -p "$(getv HOST_DISK_DIR)" 2>/dev/null || true
if [ -n "$(getv HOST_DISK_DIR)" ] && [ -d "$(getv HOST_DISK_DIR)" ]; then
  args+=(-v "$(getv HOST_DISK_DIR):/host-disk:ro" -e HOST_DISK_PATH=/host-disk)
fi
# What apprua-guard writes for the portal (the apps that ran out of memory), read-only
mkdir -p /var/lib/apprua && args+=(-v /var/lib/apprua:/apprua-host:ro)
if [ -n "$(getv INITIAL_ADMIN_PASSWORD)" ]; then
  args+=(-e "INITIAL_ADMIN_EMAIL=$(getv INITIAL_ADMIN_EMAIL)")
  printf 'INITIAL_ADMIN_PASSWORD=%s\n' "$(getv INITIAL_ADMIN_PASSWORD)" >> "$RUN_ENV"
elif [ -n "$(getv SETUP_CODE)" ]; then
  printf 'SETUP_CODE=%s\n' "$(getv SETUP_CODE)" >> "$RUN_ENV"
fi
if [ "$NETWORK" != local ]; then
  # the portal at apprua.<domain>, through the same proxy as the apps
  args+=(-l traefik.enable=true -l "traefik.http.routers.apprua.rule=Host(\`apprua.$DOMAIN\`)"
    -l traefik.http.routers.apprua.service=apprua -l traefik.http.services.apprua.loadbalancer.server.port=3000)
  if [ "$HTTPS" != off ]; then
    # https, and http:// sent on to https://
    args+=(-l traefik.http.routers.apprua.entrypoints=https -l traefik.http.routers.apprua.tls=true
      -l "traefik.http.routers.apprua-http.rule=Host(\`apprua.$DOMAIN\`)" -l traefik.http.routers.apprua-http.entrypoints=http
      -l traefik.http.routers.apprua-http.service=apprua -l traefik.http.routers.apprua-http.middlewares=apprua-to-https
      -l traefik.http.middlewares.apprua-to-https.redirectscheme.scheme=https)
    if [ "$HTTPS" = letsencrypt ]; then args+=(-l traefik.http.routers.apprua.tls.certresolver=letsencrypt); fi
  else
    args+=(-l traefik.http.routers.apprua.entrypoints=http)
  fi
fi
# on this machine the portal is also at http://localhost:<port>
if [ "$NETWORK" != internet ]; then args+=(-p "127.0.0.1:$PORT:3000"); fi
# built from the source: its version of the connector is not on npm, the AI apps take it from the portal
if [ "$IMAGE" = apprua:local ]; then args+=(-e APPRUA_CONNECTOR_SOURCE=server); fi
# the request log of the portal (with the addresses of the visitors) is kept small: at most 5 files of 10 MB
[ "$(docker info --format '{{.LoggingDriver}}' 2>/dev/null)" = json-file ] && args+=(--log-opt max-size=10m --log-opt max-file=5)
docker run "${args[@]}" "$IMAGE" >/dev/null
for _ in $(seq 1 30); do docker exec apprua node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && break; sleep 1; done
# The proxy shows the portal at apprua.<domain> only once the container is "healthy" (30-40 s after it starts):
# wait for it, so "Apprua is ready" is true when it is printed (seen on a test server: "No app here" meanwhile)
if [ "$NETWORK" != local ]; then
  if [ "$HTTPS" != off ]; then pp=443; ps=https; else pp=80; ps=http; fi
  for _ in $(seq 1 60); do
    c=$(curl -sk -o /dev/null -m 5 -w '%{http_code}' --resolve "apprua.$DOMAIN:$pp:127.0.0.1" "$ps://apprua.$DOMAIN/healthz" || true)
    [ "$c" = 200 ] && break
    sleep 2
  done
fi

# App addresses where no app answers (paused, missing, still publishing) show Apprua's own page instead of the
# engine's generic one: a route with the lowest priority that any running app beats, keeping the original address.
if [ -d "$PROXY_DYNAMIC" ]; then
  cat > "$PROXY_DYNAMIC/apprua-signpost.yaml" <<'YAML'
# managed by apprua (install.sh): app addresses without a running app show the Apprua page
http:
  routers:
    apprua-signpost-http:
      entryPoints: [http]
      rule: PathPrefix(`/`)
      priority: 1
      service: apprua-signpost
    apprua-signpost-https:
      entryPoints: [https]
      rule: PathPrefix(`/`)
      priority: 1
      service: apprua-signpost
      tls:
        certResolver: letsencrypt   # with your certificate this line is removed below
  services:
    apprua-signpost:
      loadBalancer:
        servers:
          - url: 'http://apprua:3002'
YAML
  if [ "$HTTPS" = own ]; then sed -i 's/^      tls:$/      tls: {}/; /certResolver: letsencrypt/d' "$PROXY_DYNAMIC/apprua-signpost.yaml"; fi
  info "page for apps that are not on: ready"
fi

# Nobody has an account yet: the first-run setup is still to do (the setup code is needed only then)
FIRST_RUN=$(docker exec apprua node -e "const {DatabaseSync}=require('node:sqlite');console.log(new DatabaseSync('/data/apprua.db').prepare('SELECT COUNT(*) AS n FROM users').get().n ? 0 : 1)" 2>/dev/null || echo 1)
if [ -n "${APPRUA_WINDOWS:-}" ]; then
  # under the Windows installer, which ends with its own summary: only what is needed now
  if [ "$FIRST_RUN" = 1 ] && [ -n "$(getv SETUP_CODE)" ]; then
    info "$(L "Codice di configurazione (lo chiede la prima pagina): $(getv SETUP_CODE)" "Setup code (the first page asks for it): $(getv SETUP_CODE)")"
  fi
else
  say "$(L 'Tutto pronto: Apprua è in funzione' 'Apprua is ready')"
  info "$(L "Apri: $PUBLIC_URL" "Open: $PUBLIC_URL")"
  if [ "$NETWORK" = lan ]; then info "$(L "Su questa macchina anche: http://localhost:$PORT" "On this machine also: http://localhost:$PORT")"; fi
  # "local network" on a machine whose address is a public one (a rented server): portal and apps answer from the internet
  if [ "$NETWORK" = lan ] && [ -n "$LAN_IP" ]; then
    case "$LAN_IP" in
      10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|169.254.*|100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*|127.*) ;;
      *) info "$(L "Attenzione: l'indirizzo di questa macchina ($LAN_IP) è pubblico. Con \"rete locale\" il portale e le app rispondono a chiunque raggiunga quell'indirizzo, anche da internet$([ "$HTTPS" = off ] && printf ', e senza HTTPS'). Su un server in affitto usa APPRUA_NETWORK=internet con un dominio, oppure chiudi le porte 80 e 443 nel firewall del fornitore." "Note: the address of this machine ($LAN_IP) is a public one. With \"local network\" the portal and the apps answer to whoever reaches that address, also from the internet$([ "$HTTPS" = off ] && printf ', and without HTTPS'). On a rented server use APPRUA_NETWORK=internet with a domain, or close ports 80 and 443 in the firewall of the provider.")" ;;
    esac
  fi
  if [ "$FIRST_RUN" = 1 ] && [ -n "$(getv INITIAL_ADMIN_PASSWORD)" ]; then
    info "Administrator: $(getv INITIAL_ADMIN_EMAIL)   password: $(getv INITIAL_ADMIN_PASSWORD)"
    info "(also saved in $ENV_FILE; change it after the first sign-in)"
  elif [ "$FIRST_RUN" = 1 ] && [ -n "$(getv SETUP_CODE)" ]; then
    info "$(L "La prima volta la pagina chiede per chi è Apprua e crea l'amministratore." "The first time, the page asks who Apprua is for and creates the administrator.")"
    info "$(L "Codice di configurazione (lo chiede quella pagina, solo la prima volta): $(getv SETUP_CODE)   (salvato anche in $ENV_FILE)" "Setup code (asked on that page, only for a new install): $(getv SETUP_CODE)   (also saved in $ENV_FILE)")"
  elif [ "$FIRST_RUN" = 1 ]; then
    info "$(L "La prima volta la pagina chiede per chi è Apprua e crea il tuo account." "The first time, the page asks who Apprua is for and creates your account.")"
  fi
  case "$NETWORK" in
    local) info "$(L "Le app avranno indirizzi http://<nome>.localhost (si aprono solo da questa macchina)" "Apps will be published at http://<name>.localhost (only this machine can open them)")" ;;
    lan) info "$(L "Le app avranno indirizzi $SCHEME://<nome>.$DOMAIN (dalla rete locale, dopo l'accesso; ogni app si può aprire a tutti dal portale)" "Apps will be published at $SCHEME://<name>.$DOMAIN (the local network, after signing in; each app can be opened to anyone from the portal)")"
      info "$(L "Nel DNS della rete apprua.$DOMAIN e *.$DOMAIN devono portare a $LAN_IP. Per controllare: Impostazioni > Da dove si aprono le app > Verifica" "In the DNS of the network apprua.$DOMAIN and *.$DOMAIN must point to $LAN_IP. To check: Settings > Where the apps open > Check")" ;;
    internet) info "$(L "Le app avranno indirizzi https://<nome>.$DOMAIN (dopo l'accesso; ogni app si può aprire a tutti dal portale)" "Apps will be published at https://<name>.$DOMAIN (after signing in; each app can be opened to anyone from the portal)")" ;;
  esac
fi
