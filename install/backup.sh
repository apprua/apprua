#!/usr/bin/env bash
# Apprua copies on a Linux server (on Windows use install\windows\install-apprua.ps1 -Backup instead).
#
#   sudo bash install/backup.sh                       # a full copy now (apps offline for about a minute)
#   sudo bash install/backup.sh --schedule            # a copy every night at 03:30, keeping the last 7
#   sudo bash install/backup.sh --unschedule          # no more nightly copies
#   sudo bash install/backup.sh --restore <file>      # everything back from a copy (also on a new server)
#
# A copy is one .tar.gz with everything needed to bring Apprua back: its database and code archive, the engine
# (Coolify: its database, settings and keys), the data of the apps, and the settings of the installer.
# It contains secrets (keys, passwords of the apps): it is readable by root only. Keep a second copy elsewhere.
# APPRUA_BACKUP_DIR (default /var/backups/apprua) and APPRUA_BACKUP_KEEP (default 7) choose where and how many.
#
# A Coolify that was on the server before Apprua (COOLIFY_FOREIGN=1, written by install.sh) also holds other projects:
# its database and settings are not Apprua's to copy or bring back (a restore would turn those projects back too).
# There a copy holds only Apprua's part: its data, its settings and the data of the apps published with Apprua; Docker
# keeps running (only Apprua and its apps stop for the copy). The engine itself goes with Coolify's own backups.
set -euo pipefail

DIR="${APPRUA_BACKUP_DIR:-/var/backups/apprua}"
KEEP="${APPRUA_BACKUP_KEEP:-7}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FOREIGN=""
grep -qx 'COOLIFY_FOREIGN=1' /root/.apprua/apprua.env 2>/dev/null && FOREIGN=1
if [ -n "$FOREIGN" ]; then PARTS=(/root/.apprua); else PARTS=(/data/coolify /root/.apprua); fi
# plus the Docker volumes of Apprua, of the engine (its own Coolify only) and of the apps (apprua_volumes)

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[31mERROR: %s\033[0m\n' "$*"; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run as root (sudo bash $0)"

# The Docker volumes that belong to Apprua: its own, the engine's, and the apps' (also of the apps that are paused, with
# no container: the engine knows them). Volumes of other programs on the same machine stay out of the copy.
apprua_volumes() {
  local ctrs vols project
  if [ -n "$FOREIGN" ]; then
    # only the volumes of the apps in Apprua's project of the engine, and Apprua's own
    project=$(grep -E '^COOLIFY_PROJECT_UUID=' /root/.apprua/apprua.env | tail -1 | cut -d= -f2)
    [[ "$project" =~ ^[A-Za-z0-9]+$ ]] || die "Apprua's project in the engine is not known (COOLIFY_PROJECT_UUID): run the installer again"
    vols=$(docker exec coolify-db psql -U coolify -d coolify -At -c "select v.name from local_persistent_volumes v
      join applications a on a.id = v.resource_id and v.resource_type like '%Application'
      join environments e on e.id = a.environment_id join projects p on p.id = e.project_id where p.uuid = '$project'" 2>/dev/null) \
      || die "the engine's database does not answer, so it is not clear which volumes are Apprua's: start Apprua and try again"
    printf '%s\n' $vols apprua-data | grep -E '^[A-Za-z0-9][A-Za-z0-9_.-]*$' | sort -u | while read -r v; do if [ -d "/var/lib/docker/volumes/$v" ]; then echo "$v"; fi; done
    return 0
  fi
  vols=$(docker exec coolify-db psql -U coolify -d coolify -At -c 'select name from local_persistent_volumes' 2>/dev/null) \
    || die "the engine's database does not answer, so it is not clear which volumes are Apprua's: start Apprua and try again"
  ctrs=$( (docker ps -aq --filter label=coolify.managed=true
           docker ps -aq --filter name='^/(apprua|coolify|coolify-db|coolify-redis|coolify-realtime|coolify-proxy|coolify-sentinel)$') | sort -u)
  { printf '%s\n' $vols apprua-data coolify-db coolify-redis
    [ -z "$ctrs" ] || docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{"\n"}}{{end}}{{end}}' $ctrs 2>/dev/null
  } | grep -E '^[A-Za-z0-9][A-Za-z0-9_.-]*$' | sort -u | while read -r v; do if [ -d "/var/lib/docker/volumes/$v" ]; then echo "$v"; fi; done
  # a volume the engine knows but Docker never made (an app whose first build failed) is simply not in the copy;
  # without this, a last name with no folder would end the whole script with no message
  return 0
}

docker_stop()  { systemctl stop docker.socket docker.service 2>/dev/null || systemctl stop docker; }
# Docker back on, and with it the services that stop with Docker: the lanes of the apps and the lock of the engine panel
docker_start() { systemctl start docker; local u; for u in apprua-guard apprua-coolify-lock; do systemctl start "$u.service" 2>/dev/null || true; done; }
# With a shared Coolify only Apprua and its apps stop (the other projects keep running): the containers running now
STOPPED=""
apprua_stop()  { STOPPED=$(docker ps -q --filter name='^/apprua$'; docker ps -q --filter label=apprua.app); [ -z "$STOPPED" ] || docker stop $STOPPED >/dev/null; }
apprua_start() { [ -z "$STOPPED" ] || docker start $STOPPED >/dev/null 2>&1 || true; }

backup() {
  command -v docker >/dev/null || die "Docker is not installed: nothing to copy"
  mkdir -p "$DIR" && chmod 700 "$DIR"
  # shellcheck disable=SC2155  # date cannot fail here
  local file="$DIR/apprua-$(date +%Y-%m-%d-%H%M).tar.gz"
  local need free vols v
  vols=$(apprua_volumes)
  [ -n "$vols" ] || die "no Docker volumes of Apprua found: is Apprua installed on this machine?"
  local paths=("${PARTS[@]}")
  for v in $vols; do paths+=("/var/lib/docker/volumes/$v"); done
  need=$(du -sk "${paths[@]}" 2>/dev/null | awk '{s+=$1} END {print int(s/1024)}')
  free=$(df -Pm "$DIR" | awk 'NR==2 {print $4}')
  say "Saving a full copy of Apprua"
  info "File: $file (up to $need MB, $free MB free)"
  [ "$need" -lt "$free" ] || die "not enough free space in $DIR"
  [ -z "$FOREIGN" ] || info "Coolify here also holds other projects: the copy has only Apprua's part (the engine goes with Coolify's own backups)"
  # Docker (or, with a shared Coolify, Apprua and its apps) stops for the copy, so the databases are copied whole; the
  # apps are offline meanwhile. Everything that was running starts again by itself, also if the copy fails.
  if [ -n "$FOREIGN" ]; then trap apprua_start EXIT; apprua_stop; else trap docker_start EXIT; docker_stop; fi
  local parts=()
  for p in "${paths[@]}"; do [ -e "$p" ] && parts+=("${p#/}"); done
  info "Docker volumes in the copy: $(echo $vols)"
  # --warning=no-file-ignored: the sockets of the engine are skipped on purpose; the message only worried people
  tar -C / --warning=no-file-ignored -czf "$file.part" "${parts[@]}"
  if [ -n "$FOREIGN" ]; then apprua_start; else docker_start; fi
  trap - EXIT
  mv "$file.part" "$file" && chmod 600 "$file"
  # its fingerprint: --restore checks it, so a copy changed while it was kept elsewhere is not brought back
  (cd "$DIR" && sha256sum "${file##*/}" > "${file##*/}.sha256") && chmod 600 "$file.sha256"
  info "Copy saved ($(du -h "$file" | cut -f1)). Apps back online in about a minute."
  info "Fingerprint (SHA-256): $(cut -d' ' -f1 "$file.sha256"). Keep it with the second copy elsewhere."
  # keep the newest $KEEP copies
  ls -1t "$DIR"/apprua-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do rm -f "$old" "$old.sha256"; done
  info "Copies kept in $DIR: $(ls -1 "$DIR"/apprua-*.tar.gz 2>/dev/null | wc -l) (the newest $KEEP)"
}

restore() {
  local file="$1"
  [ -f "$file" ] || die "file not found: $file"
  list=$(mktemp); trap 'rm -f "$list"' EXIT   # not local: the EXIT trap still needs it after this function returns
  tar -tzf "$file" > "$list" 2>/dev/null || die "$file cannot be read (not a .tar.gz)"
  grep -q "^var/lib/docker/volumes/" "$list" || die "$file is not a copy made by Apprua"
  local vols; vols=$(awk -F/ '$1 "/" $2 "/" $3 "/" $4 == "var/lib/docker/volumes" && NF >= 5 && $5 != "" && $5 != "metadata.db" {print $5}' "$list" | grep -E '^[A-Za-z0-9][A-Za-z0-9_.-]*$' | sort -u || true)
  # The copy runs as root on this server (it holds the engine, which manages the server): it must be the one Apprua
  # made. Its fingerprint, from the .sha256 file next to it or from APPRUA_RESTORE_SHA256, must match.
  local sum want
  sum=$(sha256sum "$file" | cut -d' ' -f1)
  want="${APPRUA_RESTORE_SHA256:-}"
  [ -z "$want" ] && [ -f "$file.sha256" ] && want=$(cut -d' ' -f1 "$file.sha256")
  if [ -n "$want" ]; then
    [ "$sum" = "$want" ] || die "the fingerprint of $file does not match ($sum instead of $want): the copy changed, not using it"
    info "Fingerprint checked: $sum"
  else
    info "Fingerprint of this copy: $sum. Compare it with the one printed when the copy was made."
    [ -t 0 ] || die "no fingerprint to check: put the .sha256 file next to the copy, or set APPRUA_RESTORE_SHA256"
  fi
  # Docker volumes that are not in the copy belong to other programs on this server: they are left alone, but say so
  local others
  # shellcheck disable=SC2010  # names of Docker volumes: no spaces or odd characters
  others=$(comm -23 <(ls -1 /var/lib/docker/volumes 2>/dev/null | grep -vxE 'metadata.db|backingFsBlockDev' | sort) \
                    <(printf '%s\n' "$vols") | tr '\n' ' ')
  # a copy made on a Coolify shared with other projects has no engine in it (no data/coolify)
  local part_only=""
  grep -q "^data/coolify/" "$list" || part_only=1
  say "Bringing Apprua back from $file"
  if [ -n "$part_only" ]; then
    info "This copy has only Apprua's part (Coolify was shared with other projects): Apprua, its settings and the data of its apps are replaced; the engine and its other projects are left as they are."
    docker ps --format '{{.Names}}' 2>/dev/null | grep -qx coolify-db \
      || die "Coolify is not running on this server, and this copy does not contain it: bring Coolify back first (from its own backup), then run this again"
  else
    # Coolify here also holds other projects: a full copy (engine included) would replace them
    [ -z "$FOREIGN" ] || die "this copy holds the whole engine, but Coolify on this server also holds other projects and they would be replaced: use a copy made on this server"
    info "The engine, the apps and their data now on this server are replaced by the copy."
  fi
  [ -n "$others" ] && info "Docker volumes not in the copy, left as they are: $others"
  if [ -t 0 ]; then
    read -r -p "    Type RESTORE to go on: " typed
    [ "$typed" = RESTORE ] || die "nothing changed"
  fi
  [ -z "$part_only" ] || { restore_part "$file" "$vols"; return; }
  if ! command -v docker >/dev/null; then
    say "Installing Docker"
    curl -fsSL https://get.docker.com | sh >/dev/null
  fi
  # Docker starts again also if something below fails (a broken copy, a full disk): never a server left without it
  trap 'rm -f "$list"; docker_start' EXIT
  docker_stop
  # only the volumes in the copy are replaced; only the three parts of a copy are taken from it (nothing else on /)
  local v parts=()
  while read -r v; do [ -n "$v" ] && rm -rf "/var/lib/docker/volumes/$v"; done <<<"$vols"
  # shellcheck disable=SC2115  # v comes from the two fixed names of this line, never empty
  for v in data/coolify root/.apprua; do if grep -q "^$v/" "$list"; then rm -rf "/$v"; parts+=("$v"); fi; done
  parts+=(var/lib/docker/volumes)
  tar -C / -xzf "$file" "${parts[@]}"
  docker_start
  trap 'rm -f "$list"' EXIT
  # The containers of the engine keep the passwords they were created with. On a server installed after the copy was
  # made (a new server, or after uninstall.sh) those are not the passwords of the copied database, and the engine
  # cannot open it (seen on a test server). Create them again from the copied settings.
  if [ -f /data/coolify/source/docker-compose.yml ]; then
    ( cd /data/coolify/source && docker compose --env-file .env -f docker-compose.yml -f docker-compose.prod.yml \
        up -d --force-recreate >/dev/null 2>&1 ) || info "Could not recreate the engine containers: install.sh will try to go on"
  fi
  # The engine reaches this server over SSH with the key in the copy; on a new server root does not know it yet
  # ("Permission denied (publickey)", every app failed to publish again): add it to root's authorized keys
  mkdir -p /root/.ssh && chmod 700 /root/.ssh && touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys
  for k in /data/coolify/ssh/keys/*; do
    case "$k" in *.lock) continue ;; esac
    [ -f "$k" ] || continue
    t=$(mktemp); install -m 600 "$k" "$t"
    pub=$(ssh-keygen -y -f "$t" 2>/dev/null | awk '{print $1" "$2}'); rm -f "$t"
    [ -n "$pub" ] && ! grep -qF "$pub" /root/.ssh/authorized_keys && echo "$pub coolify" >> /root/.ssh/authorized_keys
  done
  info "Files back. Now the engine and Apprua start again from them, and the apps are published again."
  # install.sh finds the settings of the copy (/root/.apprua), starts the engine on its own data, and with
  # APPRUA_REPUBLISH=1 Apprua publishes again every app that was online (their containers are not in the copy).
  APPRUA_REPUBLISH=1 bash "$SRC/install/install.sh"
}

# Only Apprua's part, with a shared Coolify: Docker keeps running, only Apprua and its apps stop; each volume of the
# copy is emptied and filled again (created first if missing), then the installer starts Apprua and publishes the apps.
restore_part() {   # $1 = the copy, $2 = its volumes
  local v
  trap 'rm -f "$list"; apprua_start' EXIT
  apprua_stop
  while read -r v; do
    [ -n "$v" ] || continue
    docker volume create "$v" >/dev/null
    rm -rf "/var/lib/docker/volumes/$v/_data"
    tar -C / -xzf "$1" "var/lib/docker/volumes/$v"
  done <<<"$2"
  rm -rf /root/.apprua && tar -C / -xzf "$1" root/.apprua
  apprua_start
  trap 'rm -f "$list"' EXIT
  info "Files back. Now Apprua starts again from them, and the apps are published again."
  APPRUA_REPUBLISH=1 bash "$SRC/install/install.sh"
}

schedule() {
  # root runs it every night: from a copy only root can change, not from the folder where Apprua was downloaded
  install -d -m 755 /usr/local/lib/apprua && install -m 755 "$SRC/install/backup.sh" /usr/local/lib/apprua/backup.sh
  cat > /etc/systemd/system/apprua-backup.service <<UNIT
[Unit]
Description=Apprua: nightly full copy
[Service]
Type=oneshot
Environment=APPRUA_BACKUP_DIR=$DIR APPRUA_BACKUP_KEEP=$KEEP
ExecStart=/bin/bash /usr/local/lib/apprua/backup.sh
UNIT
  cat > /etc/systemd/system/apprua-backup.timer <<'UNIT'
[Unit]
Description=Apprua: nightly full copy at 03:30
[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload && systemctl enable --now apprua-backup.timer >/dev/null
  say "A full copy every night at 03:30 in $DIR (the newest $KEEP are kept)"
  info "Next: $(systemctl list-timers apprua-backup.timer --no-legend | awk '{print $1, $2, $3}')"
}

case "${1:-}" in
  "") backup ;;
  --schedule) schedule ;;
  --unschedule) systemctl disable --now apprua-backup.timer >/dev/null 2>&1 || true; rm -f /etc/systemd/system/apprua-backup.{service,timer} /usr/local/lib/apprua/backup.sh; systemctl daemon-reload; say "No more nightly copies" ;;
  --restore) [ -n "${2:-}" ] || die "which copy? sudo bash $0 --restore <file>"; restore "$2" ;;
  *) die "unknown option $1 (none, --schedule, --unschedule, --restore <file>)" ;;
esac
