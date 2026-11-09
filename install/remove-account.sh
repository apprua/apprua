#!/usr/bin/env bash
# Removes an account of Apprua on this server when the person asks for it (for example under the GDPR).
#
#   sudo bash install/remove-account.sh person@example.com
#
# The account goes, and its email is replaced in the history of Apprua by a random label. The apps that still
# belong to the account must first get another owner, or be deleted. See docs/guide/privacy.md.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run it as root: sudo bash $0 $*"; exit 1; }
[ -n "${1:-}" ] || { echo "Which account? sudo bash $0 person@example.com"; exit 2; }
docker inspect apprua >/dev/null 2>&1 || { echo "Apprua is not installed on this machine (no container \"apprua\")."; exit 1; }
exec docker exec apprua node dist/src/cli/admin.js forget "$1"
