/*
 * TLS trust anchor for HiveMQ Cloud (Let's Encrypt).
 *
 * HiveMQ Cloud presents a certificate chain rooted at ISRG Root X1.
 * Replace the placeholder below with the real PEM before deployment:
 *
 *   1. Download https://letsencrypt.org/certs/isrgrootx1.pem
 *   2. Paste its full contents between the R"EOF( ... )EOF" markers,
 *      replacing the PLACEHOLDER line (keep the BEGIN/END lines from the file).
 *
 * Until then the firmware falls back to setInsecure() and logs a warning:
 * the connection is still encrypted but the broker is not authenticated.
 */
#pragma once

static const char CA_CERT_PEM[] PROGMEM = R"EOF(
PLACEHOLDER-PASTE-ISRG-ROOT-X1-PEM-HERE
)EOF";

inline bool isCaCertInstalled() {
  return strstr_P(CA_CERT_PEM, PSTR("BEGIN CERTIFICATE")) != nullptr;
}
