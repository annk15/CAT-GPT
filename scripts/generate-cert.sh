#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CERT_DIR="${CERT_DIR:-$ROOT/certs}"
DAYS="${CERT_DAYS:-825}"
CN="${CERT_CN:-cat-gpt.local}"

mkdir -p "$CERT_DIR"

detect_ips_raw() {
  ip -4 -o addr show scope global 2>/dev/null \
    | awk '!/docker|br-|veth|virbr|tailscale|wg/ {print $4}' \
    | cut -d/ -f1 \
    | grep -E '^192\.168\.|^10\.' \
    | head -3
}

detect_ips() {
  local ips
  ips=$(detect_ips_raw)
  if [ -n "$ips" ]; then
    echo "$ips"
    return
  fi
  hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^192\.168\.' | head -1
}

LAN_IPS=($(detect_ips))
if [ ${#LAN_IPS[@]} -eq 0 ]; then
  echo "Warning: no LAN IPv4 address found; cert will only cover localhost." >&2
fi

SAN="DNS:localhost,DNS:${CN},DNS:*.local,IP:127.0.0.1,IP:::1"
for ip in "${LAN_IPS[@]}"; do
  SAN="${SAN},IP:${ip}"
done

echo "Generating local CA and server certificate..."
echo "Subject Alternative Names: ${SAN}"

if [ ! -f "$CERT_DIR/ca-key.pem" ]; then
  openssl genrsa -out "$CERT_DIR/ca-key.pem" 4096 2>/dev/null
  openssl req -x509 -new -nodes -key "$CERT_DIR/ca-key.pem" \
    -sha256 -days "$DAYS" -out "$CERT_DIR/ca-cert.pem" \
    -subj "/CN=CAT-GPT Local CA/O=CAT-GPT/C=SE"
fi

openssl genrsa -out "$CERT_DIR/key.pem" 2048 2>/dev/null

cat > "$CERT_DIR/openssl.cnf" <<EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
req_extensions = req_ext

[dn]
CN = ${CN}

[req_ext]
subjectAltName = ${SAN}

[v3_ca]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = ${SAN}
EOF

openssl req -new -key "$CERT_DIR/key.pem" \
  -out "$CERT_DIR/csr.pem" \
  -config "$CERT_DIR/openssl.cnf"

openssl x509 -req -in "$CERT_DIR/csr.pem" \
  -CA "$CERT_DIR/ca-cert.pem" -CAkey "$CERT_DIR/ca-key.pem" \
  -CAcreateserial -out "$CERT_DIR/cert.pem" \
  -days "$DAYS" -sha256 \
  -extensions v3_ca -extfile "$CERT_DIR/openssl.cnf"

cp "$CERT_DIR/ca-cert.pem" "$CERT_DIR/rootCA.pem"

rm -f "$CERT_DIR/csr.pem" "$CERT_DIR/ca-cert.srl"

cat <<EOF

Certificates written to: ${CERT_DIR}
  cert.pem   — server certificate
  key.pem    — server private key
  rootCA.pem — install this on your iPhone to trust HTTPS

On iPhone (same Wi‑Fi as this machine):
  1. Start the server: npm run start:https
  2. Open Safari on your phone and go to one of:
EOF

for ip in "${LAN_IPS[@]}"; do
  echo "       https://${ip}:3456/rootCA.pem"
done
echo "       (or AirDrop/email ${CERT_DIR}/rootCA.pem to the phone)"
cat <<EOF
  3. Install the profile, then go to
     Settings → General → About → Certificate Trust Settings
     and enable full trust for "CAT-GPT Local CA".
  4. Open the app at:
EOF

for ip in "${LAN_IPS[@]}"; do
  echo "       https://${ip}:3456"
done

echo
