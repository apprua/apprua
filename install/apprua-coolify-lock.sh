#!/usr/bin/env bash
# Apprua: on a server the Coolify panel (8000) and its live updates (6001, 6002) answer only on the server itself; from
# elsewhere they are reached through an SSH tunnel (see docs/configuration.md). IPv4 and IPv6.
#
# Two ways in to close: Docker forwards the ports to the container past the usual firewall (chain DOCKER-USER, matched
# on the original port), and on IPv6 Docker often answers with its own listener on the machine (chain INPUT).
# install.sh runs "on" before Coolify is installed (until Apprua creates its administrator anyone who reached the
# panel could register first) and again at every start (service apprua-coolify-lock).
#
#   apprua-coolify-lock on     close the ports to the network
#   apprua-coolify-lock off    open them again (APPRUA_COOLIFY_OPEN=1, uninstall)
#
# "This machine only" (install.sh writes 1 in /var/lib/apprua/local-only): the ports of the apps (80, 443) are closed
# to the network too: there the apps have no sign-in in front, and a name ending in .localhost does not stop a request
# that comes from the network with that name. Otherwise they are opened again (the local network and the internet).
set -uo pipefail
PORTS=(8000 6001 6002)
APP_PORTS=(80 443)
APPRUA_LOCAL_ONLY="${APPRUA_LOCAL_ONLY:-$(cat /var/lib/apprua/local-only 2>/dev/null || echo 0)}"

# The DOCKER-USER rule matches only the traffic Docker forwarded from a published port ("DNAT"), not a container that
# talks to the engine's own ports on the Docker network.
FWD=(-p tcp -m conntrack --ctstate DNAT --ctdir ORIGINAL)
rules() {   # $1 = -I/-D, $2 = iptables or ip6tables, $3 = the port
  case "$1" in
    -I) # the rules of the versions before 1.0 (no DNAT match) go away
        while "$2" -D DOCKER-USER -p tcp -m conntrack --ctorigdstport "$3" --ctdir ORIGINAL -j DROP 2>/dev/null; do :; done
        "$2" -C DOCKER-USER "${FWD[@]}" --ctorigdstport "$3" -j DROP 2>/dev/null || "$2" -I DOCKER-USER "${FWD[@]}" --ctorigdstport "$3" -j DROP || return 1
        "$2" -C INPUT -p tcp --dport "$3" ! -i lo -j DROP 2>/dev/null || "$2" -I INPUT -p tcp --dport "$3" ! -i lo -j DROP || return 1 ;;
    -D) while "$2" -D DOCKER-USER "${FWD[@]}" --ctorigdstport "$3" -j DROP 2>/dev/null; do :; done
        # the rules of the versions before 1.0 (no DNAT match)
        while "$2" -D DOCKER-USER -p tcp -m conntrack --ctorigdstport "$3" --ctdir ORIGINAL -j DROP 2>/dev/null; do :; done
        while "$2" -D INPUT -p tcp --dport "$3" ! -i lo -j DROP 2>/dev/null; do :; done ;;
  esac
  return 0
}

mode="${1:-on}"
status=0
case "$mode" in
  on|off)
    for t in iptables ip6tables; do
      command -v "$t" >/dev/null || continue
      # no IPv6 in this kernel (ipv6.disable=1): nothing to close there
      "$t" -L INPUT -n >/dev/null 2>&1 || continue
      # the chain Docker calls for forwarded traffic; made here if Docker is not there yet (Docker keeps it)
      [ "$mode" = off ] || "$t" -N DOCKER-USER 2>/dev/null || true
      for p in "${PORTS[@]}"; do rules "$([ "$mode" = on ] && echo -I || echo -D)" "$t" "$p" || { status=1; echo "apprua-coolify-lock: could not set the $t rule for port $p" >&2; }; done
      for p in "${APP_PORTS[@]}"; do
        rules "$([ "$mode" = on ] && [ "${APPRUA_LOCAL_ONLY:-0}" = 1 ] && echo -I || echo -D)" "$t" "$p" || { status=1; echo "apprua-coolify-lock: could not set the $t rule for port $p" >&2; }
      done
    done ;;
  *) echo "usage: $0 on|off"; exit 2 ;;
esac
exit $status
