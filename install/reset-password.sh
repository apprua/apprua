#!/usr/bin/env bash
# A new password for an account of Apprua on this server, when it was forgotten and Apprua cannot send emails.
#
#   sudo bash install/reset-password.sh                    the only administrator (or the list of accounts)
#   sudo bash install/reset-password.sh you@example.com    that account
#
# It prints a new random password once: sign in with it, then change it in "Your account".
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run it as root: sudo bash $0 $*"; exit 1; }
docker inspect apprua >/dev/null 2>&1 || { echo "Apprua is not installed on this machine (no container \"apprua\")."; exit 1; }
exec docker exec apprua node dist/src/cli/admin.js new-password "$@"
