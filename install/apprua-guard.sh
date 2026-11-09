#!/usr/bin/env bash
# Apprua guard: the published apps run code written by AI, so each one is kept in its own lane.
#
# Every app container (label coolify.type=application) may answer visits and reach the internet, and may reach the
# other apps only through their public address (the proxy, ports 80 and 443, where the sign-in stands). It may not
# open connections to anything else on the Docker networks of this machine (other apps directly, Apprua, the engine,
# its database and Redis) nor to the machine itself (SSH and other services).
#
# The rules live in the chain APPRUA-APPS (IPv4 and IPv6), called from DOCKER-USER (traffic between containers, also
# on the same network: Docker enables bridge netfilter) and from INPUT (traffic to the machine). They are replaced in
# one step (iptables-restore) at start and every time a container starts or stops; install.sh installs the service
# apprua-guard, which runs "watch". A second chain, APPRUA-HOST (from OUTPUT), keeps the machine itself, and so the
# builds of the engine, from opening the apps directly; apps also cannot reach the cloud metadata service.
#
#   apprua-guard apply    rebuild the rules once
#   apprua-guard watch    rebuild now, then after every container start or stop
#   apprua-guard off      remove the rules
#   apprua-guard status   show the rules
set -uo pipefail
# Which containers are Apprua's apps. With a Coolify of its own every application of the engine is one; with a Coolify
# that was there before Apprua (COOLIFY_FOREIGN=1) only those with Apprua's label (apprua.app, set on every
# publication): the other projects of that Coolify are left alone, their network and their containers.
APP_LABEL=coolify.type=application
grep -qx 'COOLIFY_FOREIGN=1' "${APPRUA_ENV:-/root/.apprua/apprua.env}" 2>/dev/null && APP_LABEL=apprua.app
is_app() {   # $1 = container id
  if [ "$APP_LABEL" = apprua.app ]; then [ -n "$(docker inspect "$1" --format '{{index .Config.Labels "apprua.app"}}' 2>/dev/null)" ]
  else [ "$(docker inspect "$1" --format '{{index .Config.Labels "coolify.type"}}' 2>/dev/null)" = application ]; fi
}
CHAIN=APPRUA-APPS
HOST_CHAIN=APPRUA-HOST   # from this machine to the apps (see apply)
NL=$'\n'
# The apps that ran out of memory, read by Apprua (mounted read-only into its container as /apprua-host)
OOM_FILE=/var/lib/apprua/oom.log

note_oom() {   # $1 = the engine id of the app (label coolify.applicationUuid)
  [[ "${1:-}" =~ ^[A-Za-z0-9_-]+$ ]] || return 0
  mkdir -p "${OOM_FILE%/*}"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $1" >> "$OOM_FILE"
  if [ "$(wc -l < "$OOM_FILE")" -gt 1000 ]; then tail -n 500 "$OOM_FILE" > "$OOM_FILE.tmp" && mv "$OOM_FILE.tmp" "$OOM_FILE"; fi
  return 0
}

# A published app may not bring its own instructions for the proxy: labels traefik.* or caddy* in its image (also
# inherited from the image it starts FROM) could take the portal's address or skip the sign-in. Apprua refuses them in
# the Dockerfile; here such a container is removed as soon as it is created or started (new publications only: an app
# published before this check existed keeps running until it is published again).
REFUSED_FILE=/var/lib/apprua/refused.log
check_image() {   # $1 = container id
  local img bad
  is_app "$1" || return 0
  img=$(docker inspect "$1" --format '{{.Image}}' 2>/dev/null) || return 0
  bad=$(docker image inspect "$img" --format '{{range $k, $v := .Config.Labels}}{{$k}}{{println}}{{end}}' 2>/dev/null \
        | grep -Ei '^(traefik|caddy)' | head -3 | tr '\n' ' ')
  [ -z "$bad" ] && return 0
  local name
  name=$(docker inspect "$1" --format '{{index .Config.Labels "apprua.app"}}' 2>/dev/null)
  docker rm -f "$1" >/dev/null 2>&1
  mkdir -p "${REFUSED_FILE%/*}"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ${name:-?} $bad" >> "$REFUSED_FILE"
  echo "apprua-guard: removed the app ${name:-$1}: its image has labels for the proxy ($bad)" >&2
}

hook() {   # $1 = iptables or ip6tables: the chain exists and is called from DOCKER-USER and INPUT
  local t=$1
  "$t" -N "$CHAIN" 2>/dev/null || true
  "$t" -N DOCKER-USER 2>/dev/null || true
  "$t" -C DOCKER-USER -j "$CHAIN" 2>/dev/null || "$t" -I DOCKER-USER 1 -j "$CHAIN"
  "$t" -C INPUT -j "$CHAIN" 2>/dev/null || "$t" -I INPUT 1 -j "$CHAIN"
  "$t" -N "$HOST_CHAIN" 2>/dev/null || true
  "$t" -C OUTPUT -j "$HOST_CHAIN" 2>/dev/null || "$t" -I OUTPUT 1 -j "$HOST_CHAIN"
}

unhook() {
  local t=$1
  while "$t" -D DOCKER-USER -j "$CHAIN" 2>/dev/null; do :; done
  while "$t" -D INPUT -j "$CHAIN" 2>/dev/null; do :; done
  "$t" -F "$CHAIN" 2>/dev/null; "$t" -X "$CHAIN" 2>/dev/null
  while "$t" -D OUTPUT -j "$HOST_CHAIN" 2>/dev/null; do :; done
  "$t" -F "$HOST_CHAIN" 2>/dev/null; "$t" -X "$HOST_CHAIN" 2>/dev/null
  return 0
}

# Adds to two arrays (IPv4, IPv6) the addresses that docker prints as "ipv4 ipv6" lines.
read_pairs() {   # $1 $2 = names of the arrays; stdin = lines
  local -n v4=$1 v6=$2
  local a b
  # only real addresses: a container that is starting or stopping has none, and Docker 29 then prints "invalid IP"
  while read -r a b; do
    [[ "${a:-}" =~ ^[0-9]+(\.[0-9]+){3}$ ]] && v4+=("$a")
    [[ "${b:-}" =~ ^[0-9a-fA-F:]+$ && "$b" == *:* ]] && v6+=("$b")
  done
  return 0
}

apply() {
  local nets4=() nets6=() proxy4=() proxy6=() app4=() app6=() n s c
  # the subnets of every Docker network on this machine
  for n in $(docker network ls -q 2>/dev/null); do
    while read -r s; do
      [ -z "$s" ] && continue
      case "$s" in *:*) nets6+=("$s") ;; *) nets4+=("$s") ;; esac
    done < <(docker network inspect "$n" --format '{{range .IPAM.Config}}{{.Subnet}}{{"\n"}}{{end}}' 2>/dev/null)
  done
  # the proxy, the only way from an app to another one (through the sign-in)
  read_pairs proxy4 proxy6 < <(docker inspect coolify-proxy --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{.GlobalIPv6Address}}{{"\n"}}{{end}}' 2>/dev/null)
  # the published apps
  for c in $(docker ps -q --filter "label=$APP_LABEL" 2>/dev/null); do
    read_pairs app4 app6 < <(docker inspect "$c" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{.GlobalIPv6Address}}{{"\n"}}{{end}}' 2>/dev/null)
  done

  local fam t ip p rules
  local -a nets proxies apps
  for fam in 4 6; do
    if [ "$fam" = 4 ]; then t=iptables; nets=("${nets4[@]}"); proxies=("${proxy4[@]}"); apps=("${app4[@]}")
    else t=ip6tables; nets=("${nets6[@]}"); proxies=("${proxy6[@]}"); apps=("${app6[@]}"); fi
    command -v "$t" >/dev/null || continue
    hook "$t"
    # the whole chain replaced in one step: never a moment without the rules
    # The rules match the direction in which a connection was opened ("ORIGINAL") and come BEFORE the one that lets
    # established connections through: a connection an app opened in the second after it started, before its lane
    # existed, is cut as soon as the lane is there (it does not live on as "established"). Answers to visits are the
    # other direction ("REPLY") and go on.
    local O="-m conntrack --ctdir ORIGINAL"
    rules=":$CHAIN - [0:0]${NL}"
    for ip in "${apps[@]}"; do
      for p in "${proxies[@]}"; do rules+="-A $CHAIN -s $ip -d $p -p tcp -m multiport --dports 80,443 -j RETURN${NL}"; done
      for s in "${nets[@]}"; do rules+="-A $CHAIN -s $ip -d $s $O -j DROP${NL}"; done
      rules+="-A $CHAIN -s $ip -m addrtype --dst-type LOCAL $O -j DROP${NL}"   # the machine itself
      # the cloud provider's metadata service (it can hand out the server's own credentials)
      if [ "$fam" = 4 ]; then rules+="-A $CHAIN -s $ip -d 169.254.0.0/16 $O -j DROP${NL}"
      else rules+="-A $CHAIN -s $ip -d fd00:ec2::254/128 $O -j DROP${NL}"; fi
    done
    rules+="-A $CHAIN -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN${NL}"
    # From this machine to the apps directly: nothing does it (visits go through the proxy, a container), except the
    # engine's builds, which run the app's Dockerfile on the machine's own network ("docker build --network host"):
    # without this they could open other apps without the sign-in.
    rules+=":$HOST_CHAIN - [0:0]${NL}"
    for ip in "${apps[@]}"; do rules+="-A $HOST_CHAIN -d $ip $O -j DROP${NL}"; done
    rules+="-A $HOST_CHAIN -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN${NL}"
    printf '*filter\n%sCOMMIT\n' "$rules" | "$t-restore" -w --noflush || echo "apprua-guard: could not apply the $t rules" >&2
  done
  echo "apprua-guard: ${#app4[@]} app address(es) in their lane (IPv4), ${#app6[@]} (IPv6)"
}

case "${1:-apply}" in
  apply) apply ;;
  watch)
    # events from just before the first pass: containers that Docker starts meanwhile (at boot, all of them) are seen
    since=$(date +%s)
    apply
    # and every minute: a firewall reloaded by hand (ufw reload, iptables-restore) can drop the rules, also the ones
    # of the engine panel (apprua-coolify-lock, a service that runs once)
    ( while sleep 60; do apply >/dev/null 2>&1; [ -x /usr/local/sbin/apprua-coolify-lock ] && /usr/local/sbin/apprua-coolify-lock on >/dev/null 2>&1; done ) &
    # rebuild after every container start or stop (a burst of events is rebuilt once); an app over its memory
    # ("oom") is written down for the portal, which says so and offers more memory; a new container is checked
    # for labels for the proxy when it is created (and again at start: the engine starts it right after)
    docker events --since "$since" --filter type=container --filter event=create --filter event=start --filter event=die --filter event=oom \
      --format '{{.Action}} {{.Actor.ID}} {{index .Actor.Attributes "coolify.applicationUuid"}}' | while read -r action id app; do
      [ "$action" = create ] && { check_image "$id"; continue; }
      [ "$action" = oom ] && { note_oom "$app"; continue; }
      [ "$action" = start ] && check_image "$id"
      while read -r -t 1 action id app; do
        [ "$action" = oom ] && note_oom "$app"
        [ "$action" = create ] || [ "$action" = start ] && check_image "$id"
      done
      apply >/dev/null
    done
    ;;
  off) unhook iptables; unhook ip6tables; echo "apprua-guard: rules removed" ;;
  status) for t in iptables ip6tables; do "$t" -S "$CHAIN" 2>/dev/null; "$t" -S "$HOST_CHAIN" 2>/dev/null; done; true ;;
  *) echo "usage: $0 apply|watch|off|status"; exit 2 ;;
esac
