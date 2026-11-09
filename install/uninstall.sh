#!/usr/bin/env bash
# Removes Apprua from a Linux server (on Windows: Settings > Apps > Apprua > Uninstall, or
# install\windows\install-apprua.ps1 -Uninstall).
#
#   sudo bash install/uninstall.sh                 # asks for a copy first, then to type a word
#   sudo bash install/uninstall.sh --no-backup     # no copy offered
#   sudo bash install/uninstall.sh --yes           # no questions (scripts): takes a copy unless --no-backup
#
# Removed: Apprua, the engine (Coolify) with every app and its data, and what install.sh set up on the server
# (the services apprua-guard and apprua-coolify-lock, the nightly copies, their firewall rules, the DNS setting,
# the key the engine adds for root).
# Kept: Docker (other programs may use it) and the copies in /var/backups/apprua (they contain secrets: delete them
# yourself when you no longer need them). A copy brings everything back: install, then install/backup.sh --restore.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="${APPRUA_BACKUP_DIR:-/var/backups/apprua}"
YES=""; NO_BACKUP=""
for a in "$@"; do
  case "$a" in
    --yes) YES=1 ;;
    --no-backup) NO_BACKUP=1 ;;
    *) echo "unknown option: $a (use --yes, --no-backup)"; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[31mERROR: %s\033[0m\n' "$*"; exit 1; }
APPRUA_LANG="${APPRUA_LANG:-${LANG:-en}}"
L() { case "$APPRUA_LANG" in it*) printf '%s' "$1" ;; *) printf '%s' "$2" ;; esac; }
ask() { local a; read -r -p "    $1 " a </dev/tty || a=""; printf '%s' "$a"; }

[ "$(id -u)" -eq 0 ] || die "$(L "serve root (sudo bash $0)" "run as root (sudo bash $0)")"
has_docker() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }

found=""
[ -d /data/coolify ] || [ -d /root/.apprua ] && found=1
has_docker && docker ps -a --format '{{.Names}}' | grep -qxE 'apprua|coolify' && found=1
[ -n "$found" ] || { say "$(L "Apprua non è installato su questo server: niente da togliere." "Apprua is not installed on this server: nothing to remove.")"; exit 0; }

# A Coolify that was on this server before Apprua (install.sh found its own administrator) has projects that are not
# Apprua's: then only Apprua goes, Coolify stays with everything in it.
FOREIGN=""
grep -qx 'COOLIFY_FOREIGN=1' /root/.apprua/apprua.env 2>/dev/null && FOREIGN=1

say "$(L "Tolgo Apprua da questo server" "Removing Apprua from this server")"
if [ -n "$FOREIGN" ]; then
  printf '\n\033[33m    %s\033[0m\n' "$(L "Coolify c'era già prima di Apprua: resta, con i suoi progetti. Si toglie solo Apprua (le app pubblicate con Apprua restano in Coolify, nel progetto "Apprua apps")." \
    "Coolify was here before Apprua: it stays, with its projects. Only Apprua is removed (the apps published with Apprua stay in Coolify, in the project apprua-apps).")"
else
  printf '\n\033[33m    %s\033[0m\n' "$(L "ATTENZIONE: si cancellano Apprua, il motore e TUTTE le app con i loro dati. Non si può annullare." \
    "WARNING: this deletes Apprua, the engine and ALL the apps with their data. It cannot be undone.")"
fi
info "$(L "Restano: Docker e le copie in $BACKUP_DIR." "Kept: Docker and the copies in $BACKUP_DIR.")"

if [ -z "$YES" ] && [ ! -r /dev/tty ]; then die "$(L "nessun terminale per le domande: usa --yes (e --no-backup se non vuoi la copia)" "no terminal for the questions: use --yes (and --no-backup to skip the copy)")"; fi
if [ -z "$NO_BACKUP" ] && has_docker; then
  q=""; [ -z "$YES" ] && q=$(ask "$(L "Salvo prima una copia completa, da cui potrai ripristinare tutto? [S/n]" "Save a full copy first, to bring everything back one day? [Y/n]")")
  if ! printf '%s' "$q" | grep -qiE '^(n|no)$'; then
    bash "$HERE/backup.sh" || die "$(L "la copia non è riuscita: non ho tolto niente" "the copy failed: nothing was removed")"
  fi
fi
if [ -z "$YES" ]; then
  word=$(L ELIMINA DELETE)
  typed=$(ask "$(L "Per togliere Apprua scrivi $word" "To remove Apprua type $word")")
  if [ "$(printf '%s' "$typed" | tr '[:lower:]' '[:upper:]' | tr -d ' ')" != "$word" ]; then
    say "$(L "Non ho tolto niente: Apprua resta in funzione." "Nothing removed: Apprua stays on.")"; exit 0
  fi
fi

# 1. The services of install.sh and backup.sh, and their firewall rules
for u in apprua-guard apprua-coolify-lock; do systemctl disable --now "$u.service" >/dev/null 2>&1 || true; done
systemctl disable --now apprua-backup.timer >/dev/null 2>&1 || true
if [ -x /usr/local/sbin/apprua-guard ]; then /usr/local/sbin/apprua-guard off >/dev/null 2>&1 || true; fi
for t in iptables ip6tables; do
  command -v "$t" >/dev/null || continue
  while "$t" -D DOCKER-USER -j APPRUA-APPS 2>/dev/null; do :; done
  while "$t" -D INPUT -j APPRUA-APPS 2>/dev/null; do :; done
  "$t" -F APPRUA-APPS 2>/dev/null; "$t" -X APPRUA-APPS 2>/dev/null
  while "$t" -D OUTPUT -j APPRUA-HOST 2>/dev/null; do :; done
  "$t" -F APPRUA-HOST 2>/dev/null; "$t" -X APPRUA-HOST 2>/dev/null
done
if [ -x /usr/local/sbin/apprua-coolify-lock ]; then /usr/local/sbin/apprua-coolify-lock off >/dev/null 2>&1 || true; fi
if command -v iptables >/dev/null; then   # the rules of the versions before 1.0
  for p in 8000 6001 6002; do while iptables -D DOCKER-USER -p tcp -m conntrack --ctorigdstport "$p" --ctdir ORIGINAL -j DROP 2>/dev/null; do :; done; done
fi
rm -f /etc/systemd/system/apprua-guard.service /etc/systemd/system/apprua-coolify-lock.service \
  /etc/systemd/system/apprua-backup.service /etc/systemd/system/apprua-backup.timer /usr/local/sbin/apprua-guard \
  /usr/local/sbin/apprua-coolify-lock /usr/local/lib/apprua/backup.sh
systemctl daemon-reload 2>/dev/null || true
info "$(L "Servizi e regole del firewall di Apprua tolti" "Apprua services and firewall rules removed")"

# 2. Containers, data, networks and images of Apprua, of the engine and of the apps
if [ -n "$FOREIGN" ]; then
  if has_docker; then
    docker rm -f apprua >/dev/null 2>&1 || true
    docker volume rm -f apprua-data >/dev/null 2>&1 || true
    for i in $(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^(apprua:|ghcr\.io/apprua/)'); do docker rmi -f "$i" >/dev/null 2>&1 || true; done
  fi
  rm -rf /root/.apprua /var/lib/apprua /opt/apprua-src
  # what the installer put in the engine's proxy (the sign-in in front of the apps, the page for apps that are not on,
  # the certificate): with Apprua gone they would point at nothing
  rm -f /data/coolify/proxy/dynamic/apprua-auth.yaml /data/coolify/proxy/dynamic/apprua-signpost.yaml \
    /data/coolify/proxy/dynamic/apprua-cert.yaml /data/coolify/proxy/certs/apprua.crt /data/coolify/proxy/certs/apprua.key
  if [ -f /etc/systemd/resolved.conf.d/apprua.conf ]; then rm -f /etc/systemd/resolved.conf.d/apprua.conf; systemctl restart systemd-resolved 2>/dev/null || true; fi
  say "$(L "Fatto: ho tolto Apprua; Coolify è rimasto com'era." "Done: Apprua was removed; Coolify stays as it was.")"
  info "$(L "In Coolify restano il progetto \"Apprua apps\" con le app e la chiave API \"apprua\": toglili dal pannello se non servono più. Le app pubblicate in rete locale o su internet avevano davanti il login di Apprua: per tenerle, togli dalle loro etichette in Coolify il middleware apprua-auth e pubblicale di nuovo." \
    "In Coolify the project \"Apprua apps\" with the apps and the API token \"apprua\" remain: remove them from its panel if no longer needed. Apps published on the local network or the internet had Apprua's sign-in in front: to keep them, remove the apprua-auth middleware from their labels in Coolify and deploy them again.")"
  exit 0
fi
if has_docker; then
  # the data of the apps: the volumes the engine knows (also of the apps that are paused, with no container)
  vols=$(docker exec coolify-db psql -U coolify -d coolify -At -c 'select name from local_persistent_volumes' 2>/dev/null || true)
  ctrs=$(docker ps -aq --filter label=coolify.managed=true; docker ps -aq --filter name='^/(apprua|coolify|coolify-db|coolify-redis|coolify-realtime|coolify-proxy|coolify-sentinel|coolify-proxy-error-pages)$')
  ctrs=$(printf '%s\n' $ctrs | sort -u)
  imgs=""; mounted=""
  if [ -n "$ctrs" ]; then
    imgs=$(docker inspect --format '{{.Config.Image}}' $ctrs 2>/dev/null | sort -u)
    mounted=$(docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{"\n"}}{{end}}{{end}}' $ctrs 2>/dev/null | sort -u)
    docker rm -f $ctrs >/dev/null 2>&1 || true
  fi
  n=$(printf '%s\n' $ctrs | grep -c . || true)
  info "$(L "Fermati e tolti $n container (Apprua, motore, app)" "Stopped and removed $n containers (Apprua, engine, apps)")"
  for v in $vols $mounted apprua-data coolify-db coolify-redis; do docker volume rm -f "$v" >/dev/null 2>&1 || true; done
  for net in coolify source_default; do docker network rm "$net" >/dev/null 2>&1 || true; done
  # the images Apprua and the engine downloaded or built (others are left: Docker may need them for something else)
  for i in $imgs $(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^(apprua:|ghcr\.io/apprua/|coollabsio/|ghcr\.io/coollabsio/)'); do
    docker rmi -f "$i" >/dev/null 2>&1 || true
  done
  docker image prune -f >/dev/null 2>&1 || true
  info "$(L "Dati delle app, del motore e di Apprua cancellati; immagini tolte" "Data of the apps, the engine and Apprua deleted; images removed")"
fi

# 3. Files and settings
rm -rf /data/coolify /root/.apprua /var/lib/apprua /opt/apprua-src
if [ -f /root/.ssh/authorized_keys ] && grep -qE ' coolify$' /root/.ssh/authorized_keys; then
  sed -i '/ coolify$/d' /root/.ssh/authorized_keys
  info "$(L "Tolta la chiave SSH del motore da /root/.ssh/authorized_keys" "Removed the engine SSH key from /root/.ssh/authorized_keys")"
fi
if [ -f /etc/systemd/resolved.conf.d/apprua.conf ]; then
  rm -f /etc/systemd/resolved.conf.d/apprua.conf
  systemctl restart systemd-resolved 2>/dev/null || true
  info "$(L "Tolta l'impostazione DNS di Apprua" "Removed the Apprua DNS setting")"
fi

say "$(L "Fatto: ho tolto Apprua da questo server." "Done: Apprua was removed from this server.")"
info "$(L "Docker resta installato. Se non serve più: sudo apt remove docker-ce docker-ce-cli containerd.io docker-compose-plugin" \
  "Docker is still installed. If you no longer need it: sudo apt remove docker-ce docker-ce-cli containerd.io docker-compose-plugin")"
if ls "$BACKUP_DIR"/apprua-*.tar.gz >/dev/null 2>&1; then
  info "$(L "Copie in $BACKUP_DIR (contengono segreti: cancellale quando non servono più):" "Copies in $BACKUP_DIR (they contain secrets: delete them when you no longer need them):")"
  ls -1t "$BACKUP_DIR"/apprua-*.tar.gz | head -3 | sed 's/^/      /'
  info "$(L "Per rimettere tutto: reinstalla Apprua, poi sudo bash install/backup.sh --restore <copia>" "To bring everything back: install Apprua, then sudo bash install/backup.sh --restore <copy>")"
fi
