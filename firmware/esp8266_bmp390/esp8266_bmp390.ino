/*
 * Library 3D Navigation - ESP8266 + BMP390 sensor node
 * ----------------------------------------------------
 * One firmware, two roles (set NODE_ROLE below):
 *   ROLE_USER      - carried by a visitor; paired with the web app by DEVICE_ID.
 *   ROLE_REFERENCE - fixed at a known floor; provides the barometric baseline
 *                    that cancels weather drift for every user node.
 *
 * Publishes JSON over TLS MQTT (HiveMQ Cloud) at PUBLISH_HZ:
 *   topic  libnav/dev/<DEVICE_ID>/telemetry
 *   payload {"id","role","seq","p"(Pa),"t"(degC),"rssi","up"(ms)}
 * Presence via retained Last Will on libnav/dev/<DEVICE_ID>/status.
 *
 * Wiring (any ESP8266 board - pins given as generic GPIO numbers):
 *   BMP390 VIN -> 3V3, GND -> GND,
 *   BMP390 SDA -> GPIO4, SCL -> GPIO5   (change via I2C_SDA_PIN / I2C_SCL_PIN)
 *   On NodeMCU / Wemos silkscreen those are D2 (GPIO4) and D1 (GPIO5).
 *
 * Libraries (Arduino Library Manager):
 *   - Adafruit BMP3XX Library (+ Adafruit Unified Sensor, Adafruit BusIO)
 *   - PubSubClient by Nick O'Leary
 *
 * Wi-Fi strategy: tries VENUE Wi-Fi first, then the phone HOTSPOT.
 * The phone never connects to the ESP directly, so pairing costs no mobile
 * data; hotspot fallback uses well under 1 KB/s.
 */

#include <ESP8266WiFi.h>
#include <ESP8266WiFiMulti.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <Adafruit_Sensor.h>
#include "Adafruit_BMP3XX.h"
#include <time.h>
// Credentials live in secrets.h and the CA cert in certs.h. Both are
// git-ignored: copy secrets.h.example -> secrets.h and certs.h.example ->
// certs.h, then fill them in. secrets.h defines WIFI_* and MQTT_HOST/USER/PASS.
#include "secrets.h"
#include "certs.h"

// ------------------------- configuration -----------------------------------
#define ROLE_USER      0
#define ROLE_REFERENCE 1

#define NODE_ROLE      ROLE_USER          // ROLE_REFERENCE for the fixed node
#define DEVICE_ID      "NAV-001"          // unique per device; use "NAV-REF" for the reference

#define MQTT_PORT      8883               // HiveMQ Cloud TLS port

// I2C to the BMP390 - generic GPIO numbers so this builds on any ESP8266 board
// (bare ESP-12E modules have no D1/D2 aliases). Defaults are the ESP8266's
// standard I2C pins: GPIO4 = D2 = SDA, GPIO5 = D1 = SCL.
#define I2C_SDA_PIN    4
#define I2C_SCL_PIN    5
#define I2C_CLOCK_HZ   100000UL           // 100 kHz standard mode
#define BMP390_ADDR_A  0x77               // default (SDO high / floating)
#define BMP390_ADDR_B  0x76               // alternate (SDO tied to GND)

#define PUBLISH_HZ     2                  // fused telemetry rate
#define SAMPLE_HZ      10                 // raw sensor sampling (median filtered)
#define STATUS_LED     LED_BUILTIN        // active LOW on most ESP8266 boards

// ------------------------- globals ------------------------------------------
ESP8266WiFiMulti wifiMulti;
WiFiEventHandler wifiDisconnectHandler;   // must stay in scope for the callback
BearSSL::WiFiClientSecure tlsClient;
BearSSL::X509List caCertList;             // broker trust anchor
PubSubClient mqtt(tlsClient);
Adafruit_BMP3XX bmp;

#if NODE_ROLE == ROLE_REFERENCE
const char* kRole = "reference";
#else
const char* kRole = "user";
#endif

#define FW_VERSION __DATE__ " " __TIME__   // build stamp reported at boot

char topicTelemetry[64];
char topicStatus[64];
char topicInit[64];

uint32_t seq = 0;
uint32_t lastSampleMs = 0;
uint32_t lastPublishMs = 0;
uint32_t lastReconnectMs = 0;
uint32_t reconnectBackoffMs = 1000;
bool initSent = false;         // guarantees one init message per power-up

// median-of-5 window over raw pressure samples
float pWindow[5];
uint8_t pCount = 0;
float lastTemp = 0.0f;

// ------------------------- helpers ------------------------------------------
static float median5(float* v, uint8_t n) {
  float s[5];
  memcpy(s, v, n * sizeof(float));
  for (uint8_t i = 1; i < n; i++) {
    float key = s[i];
    int8_t j = i - 1;
    while (j >= 0 && s[j] > key) { s[j + 1] = s[j]; j--; }
    s[j + 1] = key;
  }
  return s[n / 2];
}

static void ledBlink(uint8_t times, uint16_t onMs) {
  for (uint8_t i = 0; i < times; i++) {
    digitalWrite(STATUS_LED, LOW);
    delay(onMs);
    digitalWrite(STATUS_LED, HIGH);
    delay(onMs);
  }
}

static void syncClock() {
  // BearSSL needs real time to validate the broker certificate chain.
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  Serial.print(F("[time] syncing"));
  time_t now = time(nullptr);
  uint32_t t0 = millis();
  while (now < 8 * 3600 * 2 && millis() - t0 < 20000) {
    delay(250);
    Serial.print('.');
    now = time(nullptr);
  }
  Serial.printf_P(PSTR("\n[time] epoch=%ld\n"), (long)now);
}

/* Human-readable Wi-Fi disconnect reasons (ESP8266 WIFI_DISCONNECT_REASON_*). */
static const char *wifiReason(uint8_t r) {
  switch (r) {
    case 1:   return "unspecified";
    case 2:   return "auth expired";
    case 4:   return "assoc expired - AP dropped us (range / power save)";
    case 8:   return "deauthenticated by AP";
    case 15:  return "4-way handshake timeout - wrong password?";
    case 200: return "beacon timeout - AP vanished or signal too weak";
    case 201: return "no AP found";
    case 202: return "auth failed";
    case 203: return "assoc failed";
    case 204: return "handshake timeout";
    default:  return "other";
  }
}

static bool wifiEnsure() {
  if (WiFi.status() == WL_CONNECTED) return true;
  Serial.println(F("[wifi] connecting (venue first, hotspot fallback)..."));
  uint32_t t0 = millis();
  while (wifiMulti.run() != WL_CONNECTED && millis() - t0 < 30000) {
    delay(250);
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf_P(PSTR("[wifi] connected to %s, ip=%s, rssi=%d\n"),
                    WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), WiFi.RSSI());
    return true;
  }
  Serial.println(F("[wifi] failed, will retry"));
  // Diagnostic: list the networks the ESP can actually see. The ESP8266 sees
  // only 2.4 GHz WPA/WPA2 APs - if your hotspot is missing here it is on 5 GHz,
  // WPA3, or has a different name. If it shows but won't join, check the pass.
  int n = WiFi.scanNetworks();
  Serial.printf_P(PSTR("[wifi] %d networks visible (2.4 GHz only):\n"), n);
  for (int i = 0; i < n; i++) {
    Serial.printf_P(PSTR("   %2d) ch%2d %4d dBm  %s%s\n"),
                    i + 1, WiFi.channel(i), WiFi.RSSI(i), WiFi.SSID(i).c_str(),
                    WiFi.encryptionType(i) == ENC_TYPE_NONE ? "  (open)" : "");
  }
  Serial.printf_P(PSTR("[wifi] wanted SSID: \"%s\" - is it listed above?\n"), WIFI_HOTSPOT_SSID);
  WiFi.scanDelete();
  return false;
}

// Retained init message, published once per power-up on the first successful
// MQTT connect. Announces the device and carries boot diagnostics (firmware
// build, IP, MAC, reset reason, signal, free heap) so the engine/web and you
// can confirm the node booted and see why it last restarted.
static void publishInit() {
  char payload[248];
  snprintf(payload, sizeof(payload),
           "{\"id\":\"%s\",\"role\":\"%s\",\"event\":\"boot\",\"fw\":\"%s\","
           "\"ip\":\"%s\",\"mac\":\"%s\",\"rst\":\"%s\",\"rssi\":%d,"
           "\"heap\":%u,\"up\":%lu}",
           DEVICE_ID, kRole, FW_VERSION, WiFi.localIP().toString().c_str(),
           WiFi.macAddress().c_str(), ESP.getResetReason().c_str(),
           WiFi.RSSI(), (unsigned)ESP.getFreeHeap(), (unsigned long)millis());
  mqtt.publish(topicInit, payload, true);   // QoS 0, retained
  Serial.printf_P(PSTR("[init] %s\n"), payload);
}

static bool mqttEnsure() {
  if (mqtt.connected()) return true;
  uint32_t nowMs = millis();
  if (nowMs - lastReconnectMs < reconnectBackoffMs) return false;
  lastReconnectMs = nowMs;

  Serial.printf_P(PSTR("[mqtt] connecting to %s:%d...\n"), MQTT_HOST, MQTT_PORT);
  // Last Will: retained 'offline' so the engine and web app see drops instantly.
  bool ok = mqtt.connect(DEVICE_ID, MQTT_USER, MQTT_PASS,
                         topicStatus, 1, true, "offline");
  if (ok) {
    reconnectBackoffMs = 1000;
    mqtt.publish(topicStatus, "online", true);
    if (!initSent) { publishInit(); initSent = true; }  // always once per boot
    Serial.println(F("[mqtt] connected"));
    ledBlink(2, 60);
  } else {
    Serial.printf_P(PSTR("[mqtt] failed rc=%d (tls err=%d), backoff=%lums\n"),
                    mqtt.state(), tlsClient.getLastSSLError(), (unsigned long)reconnectBackoffMs);
    reconnectBackoffMs = min<uint32_t>(reconnectBackoffMs * 2, 30000);
  }
  return ok;
}

// ------------------------- setup / loop -------------------------------------
void setup() {
  pinMode(STATUS_LED, OUTPUT);
  digitalWrite(STATUS_LED, HIGH);
  Serial.begin(115200);
  delay(200);
  Serial.printf_P(PSTR("\n[boot] libnav node %s role=%s fw=%s\n"),
                  DEVICE_ID, kRole, FW_VERSION);
  // In a reboot loop this line is the diagnosis: "Exception" / "Soft WDT
  // reset" = a crash; "Power on" / "External System" = supply or reset pin.
  Serial.printf_P(PSTR("[boot] reset reason: %s | free heap: %u bytes\n"),
                  ESP.getResetReason().c_str(), (unsigned)ESP.getFreeHeap());

  snprintf(topicTelemetry, sizeof(topicTelemetry), "libnav/dev/%s/telemetry", DEVICE_ID);
  snprintf(topicStatus, sizeof(topicStatus), "libnav/dev/%s/status", DEVICE_ID);
  snprintf(topicInit, sizeof(topicInit), "libnav/dev/%s/init", DEVICE_ID);

  Serial.printf_P(PSTR("[stage] 1 sensor init\n"));
  // --- sensor ---
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  Wire.setClock(I2C_CLOCK_HZ);
  // Adafruit's begin_I2C() only probes the address it is given, so try the
  // default first and then the SDO-to-GND alternate before giving up.
  uint8_t bmpAddr = BMP390_ADDR_A;
  if (!bmp.begin_I2C(bmpAddr)) {
    bmpAddr = BMP390_ADDR_B;
    if (!bmp.begin_I2C(bmpAddr)) {
      Serial.printf_P(PSTR("[bmp390] not found on SDA=GPIO%d SCL=GPIO%d "
                           "(tried 0x%02X and 0x%02X) - check wiring\n"),
                      I2C_SDA_PIN, I2C_SCL_PIN, BMP390_ADDR_A, BMP390_ADDR_B);
      while (true) { ledBlink(1, 500); }
    }
  }
  // High-resolution pressure for 3.8 m floor separation (~46 Pa/floor).
  bmp.setPressureOversampling(BMP3_OVERSAMPLING_8X);
  bmp.setTemperatureOversampling(BMP3_OVERSAMPLING_2X);
  bmp.setIIRFilterCoeff(BMP3_IIR_FILTER_COEFF_3);
  bmp.setOutputDataRate(BMP3_ODR_25_HZ);
  Serial.printf_P(PSTR("[bmp390] ready at 0x%02X (SDA=GPIO%d SCL=GPIO%d)\n"),
                  bmpAddr, I2C_SDA_PIN, I2C_SCL_PIN);

  Serial.printf_P(PSTR("[stage] 2 wifi connect\n"));
  // --- network ---
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  wifiMulti.addAP(WIFI_VENUE_SSID, WIFI_VENUE_PASS);
  wifiMulti.addAP(WIFI_HOTSPOT_SSID, WIFI_HOTSPOT_PASS);
  // Report every drop with a decoded reason - tells apart "AP kicked us" from
  // "we reset" when the node appears to connect/disconnect in a loop.
  wifiDisconnectHandler = WiFi.onStationModeDisconnected(
      [](const WiFiEventStationModeDisconnected &e) {
        Serial.printf_P(PSTR("[wifi] disconnected: reason=%d (%s)\n"),
                        (int)e.reason, wifiReason((uint8_t)e.reason));
      });
  WiFi.setAutoReconnect(true);
  WiFi.setSleepMode(WIFI_NONE_SLEEP);   // modem sleep makes some hotspots drop us
  wifiEnsure();
  Serial.printf_P(PSTR("[stage] 3 ntp sync\n"));
  syncClock();

  Serial.printf_P(PSTR("[stage] 4 tls setup\n"));
  Serial.printf_P(PSTR("[mem] heap=%u  largest free block=%u\n"),
                  (unsigned)ESP.getFreeHeap(),
                  (unsigned)ESP.getMaxFreeBlockSize());
  // --- TLS trust ---
  // CA_CERT_PEM lives in PROGMEM (flash), which on the ESP8266 only tolerates
  // 32-bit aligned reads - but BearSSL parses the PEM with plain byte-wise
  // pointer access, which faults and reboots the node. So copy it to RAM once
  // and do everything on that copy. isCaCertInstalled() is deliberately not
  // used either: strstr_P() expects its first argument in RAM, so handing it
  // the PROGMEM certificate is the same unsafe flash read.
  size_t pemLen = strlen_P(CA_CERT_PEM);
  char *pem = (char *)malloc(pemLen + 1);
  const bool allocOk = (pem != nullptr);
  bool trusted = false, placeholder = true;
  if (pem) {
    memcpy_P(pem, CA_CERT_PEM, pemLen + 1);
    placeholder = (strstr(pem, "BEGIN CERTIFICATE") == nullptr);
    if (!placeholder) trusted = caCertList.append(pem);
    free(pem);                         // X509List keeps its own parsed copy
  }
  if (trusted) {
    tlsClient.setTrustAnchors(&caCertList);
    Serial.println(F("[tls] CA certificate validation enabled"));
  } else {
    // Without a CA the link is still encrypted but the broker is not
    // authenticated. Fine for a first run; install the CA before deployment.
    tlsClient.setInsecure();
    const char *why = !allocOk ? "out of memory"
                    : placeholder ? "certs.h still holds the placeholder"
                                  : "certificate parse failed";
    Serial.printf_P(PSTR("[tls] WARNING: no CA (%s) -> setInsecure()\n"), why);
  }

  // --- TLS memory ---
  // BearSSL defaults to 16 KB receive + 16 KB transmit buffers. The ESP8266 has
  // only ~40 KB of usable heap, so the allocation fails or leaves too little
  // memory and the node resets mid-handshake - which looks exactly like
  // "connects to the hotspot, then drops and reconnects forever".
  // Negotiate a smaller maximum fragment length when the broker supports it.
  // The probe does a real handshake, so only run it when there is room.
  bool mfln = false;
  if (ESP.getFreeHeap() > 20000) {
    mfln = BearSSL::WiFiClientSecure::probeMaxFragmentLength(MQTT_HOST, MQTT_PORT, 1024);
  } else {
    Serial.println(F("[tls] heap low - skipping MFLN probe"));
  }
  Serial.printf_P(PSTR("[tls] MFLN(1024) supported by broker: %s\n"), mfln ? "yes" : "no");
  if (mfln) tlsClient.setBufferSizes(1024, 1024);
  else      tlsClient.setBufferSizes(4096, 1024);
  Serial.printf_P(PSTR("[mem] free heap after TLS setup: %u bytes\n"),
                  (unsigned)ESP.getFreeHeap());

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setKeepAlive(15);
  mqtt.setSocketTimeout(5);
  // PubSubClient defaults to a 256-byte packet; the init payload plus topic
  // exceeds that, so the boot message would silently never be sent.
  mqtt.setBufferSize(512);

  Serial.printf_P(PSTR("[stage] 5 setup done -> loop\n"));
  Serial.printf_P(PSTR("[mem] heap=%u  largest free block=%u\n"),
                  (unsigned)ESP.getFreeHeap(),
                  (unsigned)ESP.getMaxFreeBlockSize());
}

void loop() {
  if (!wifiEnsure()) { delay(1000); return; }
  mqttEnsure();
  mqtt.loop();

  uint32_t nowMs = millis();

  // 10 Hz raw sampling into the median window
  if (nowMs - lastSampleMs >= 1000 / SAMPLE_HZ) {
    lastSampleMs = nowMs;
    if (bmp.performReading()) {
      pWindow[pCount % 5] = bmp.pressure;   // Pa
      pCount++;
      lastTemp = bmp.temperature;           // degC
    }
  }

  // 2 Hz publish of the median-filtered value
  if (nowMs - lastPublishMs >= 1000 / PUBLISH_HZ && pCount >= 5) {
    lastPublishMs = nowMs;
    if (mqtt.connected()) {
      float pMed = median5(pWindow, 5);
      char payload[176];
      snprintf(payload, sizeof(payload),
               "{\"id\":\"%s\",\"role\":\"%s\",\"seq\":%lu,\"p\":%.2f,"
               "\"t\":%.2f,\"rssi\":%d,\"up\":%lu}",
               DEVICE_ID, kRole, (unsigned long)seq++, pMed,
               lastTemp, WiFi.RSSI(), (unsigned long)nowMs);
      if (mqtt.publish(topicTelemetry, payload)) {
        digitalWrite(STATUS_LED, LOW);      // brief flash per publish
        delay(4);
        digitalWrite(STATUS_LED, HIGH);
      }
    }
  }
}
