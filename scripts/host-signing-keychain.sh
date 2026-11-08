# Builds the keychain the Host installer is signed with, and proves codesign can use it.
#
# Source this, never execute it: the caller needs the exported identities, and the cleanup trap has
# to belong to the caller's shell so the keychain outlives this file but not the step.
#
#   source scripts/host-signing-keychain.sh
#
# Requires CSC_LINK, CSC_KEY_PASSWORD, CSC_INSTALLER_LINK and CSC_INSTALLER_KEY_PASSWORD. Exports
# HOST_SIGNING_KEYCHAIN, HOST_APPLICATION_IDENTITY, HOST_INSTALLER_IDENTITY and host_signing_dir.
#
# This fork signs with its own self-signed certificate, so the identity is found by the pinned leaf
# hash in `scripts/host-installation.ts` and not by an Apple team. The keychain is new and holds
# exactly the two imports below, so the installer identity is the other one.

umask 077
# The SHA-1 of the DER of `.fork/openbot-fork-code-signing.crt`. Keep it equal to
# HOST_CERTIFICATE_SHA1 in scripts/host-installation.ts.
: "${HOST_APPLICATION_CERTIFICATE_SHA1:=5bb823022153892b63908d9c054a9c61319d872c}"
host_signing_dir="$(mktemp -d "$RUNNER_TEMP/openbot-host-signing.XXXXXX")"
export HOST_SIGNING_KEYCHAIN="$host_signing_dir/host.keychain-db"
# `codesign --keychain` restricts which keychain is searched, it does not open one outside the
# session search list. An electron-builder run replaces that list with its own temporary keychain
# and deletes it, so this list has to be set here or `codesign` reports "The specified item could
# not be found in the keychain" for an identity `security find-identity` can see through an
# explicit path.
host_previous_keychains=()
while IFS= read -r line; do
  entry="${line#*\"}"
  entry="${entry%\"*}"
  if [ -n "$entry" ]; then host_previous_keychains+=("$entry"); fi
done < <(security list-keychains -d user)
restore_host_keychains() {
  if [ "${#host_previous_keychains[@]}" -gt 0 ]; then
    security list-keychains -d user -s "${host_previous_keychains[@]}" >/dev/null 2>&1 || true
  fi
}
trap 'restore_host_keychains; security delete-keychain "$HOST_SIGNING_KEYCHAIN" >/dev/null 2>&1 || true; rm -rf "$host_signing_dir"' EXIT
host_keychain_password="$(openssl rand -hex 32)"
echo "::add-mask::$host_keychain_password"
security create-keychain -p "$host_keychain_password" "$HOST_SIGNING_KEYCHAIN"
security unlock-keychain -p "$host_keychain_password" "$HOST_SIGNING_KEYCHAIN"
security set-keychain-settings -lut 3600 "$HOST_SIGNING_KEYCHAIN"
printf '%s' "$CSC_LINK" | base64 -D > "$host_signing_dir/application.p12"
printf '%s' "$CSC_INSTALLER_LINK" | base64 -D > "$host_signing_dir/installer.p12"
security import "$host_signing_dir/application.p12" -k "$HOST_SIGNING_KEYCHAIN" -P "$CSC_KEY_PASSWORD" -T /usr/bin/codesign >/dev/null
security import "$host_signing_dir/installer.p12" -k "$HOST_SIGNING_KEYCHAIN" -P "$CSC_INSTALLER_KEY_PASSWORD" -T /usr/bin/productsign -T /usr/bin/pkgbuild >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$host_keychain_password" "$HOST_SIGNING_KEYCHAIN" >/dev/null
security list-keychains -d user -s "$HOST_SIGNING_KEYCHAIN" ${host_previous_keychains[@]+"${host_previous_keychains[@]}"} >/dev/null
# The quoted name of the identity that holds the pinned certificate, from `security find-identity`,
# whose lines are `<number>) <SHA-1> "<name>"`.
export HOST_APPLICATION_IDENTITY="$(security find-identity -v -p codesigning "$HOST_SIGNING_KEYCHAIN" |
  awk -v h="$HOST_APPLICATION_CERTIFICATE_SHA1" 'index($0, h) && match($0, /"[^"]*"/) { print substr($0, RSTART + 1, RLENGTH - 2); exit }')"
export HOST_INSTALLER_IDENTITY="$(security find-identity -v -p basic "$HOST_SIGNING_KEYCHAIN" |
  awk -v h="$HOST_APPLICATION_CERTIFICATE_SHA1" '!index($0, h) && match($0, /"[^"]*"/) { print substr($0, RSTART + 1, RLENGTH - 2); exit }')"
test -n "$HOST_APPLICATION_IDENTITY" || { echo "No identity with the pinned certificate $HOST_APPLICATION_CERTIFICATE_SHA1." >&2; exit 1; }
test -n "$HOST_INSTALLER_IDENTITY" || { echo 'Installer identity missing.' >&2; exit 1; }
# Prove codesign can reach the identity before a caller spends minutes building binaries it cannot
# sign, and say what the keychain state was when it cannot.
cp /usr/bin/true "$host_signing_dir/probe"
if ! /usr/bin/codesign --force --sign "$HOST_APPLICATION_IDENTITY" \
  --keychain "$HOST_SIGNING_KEYCHAIN" --timestamp=none "$host_signing_dir/probe"; then
  echo "codesign cannot use $HOST_APPLICATION_IDENTITY from $HOST_SIGNING_KEYCHAIN." >&2
  security list-keychains -d user >&2
  security find-identity -v -p codesigning >&2
  exit 1
fi
/usr/bin/codesign --verify --strict "$host_signing_dir/probe"
