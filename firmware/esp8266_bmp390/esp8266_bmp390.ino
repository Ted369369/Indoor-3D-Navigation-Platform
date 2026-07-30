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
 * Wiring (ESP8266 NodeMCU / Wemos D1 mini):
 *   BMP390 VIN -> 3V3, GND -> GND, SCL -> D1 (GPIO5), SDA -> D2 (GPIO4)
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

#define PUBLISH_HZ     2                  // fused telemetry rate
#define SAMPLE_HZ      10                 // raw sensor sampling (median filtered)
#define STATUS_LED     LED_BUILTIN        // active LOW on most ESP8266 boards

// ------------------------- globals ------------------------------------------
ESP8266WiFiMulti wifiMulti;
BearSSL::WiFiClientSecure tlsClient;
PubSubClient mqtt(tlsClient);
Adafruit_BMP3XX bmp;

#if NODE_ROLE == ROLE_REFERENCE
const char* kRole = "reference";
#else
const char* kRole = "user";
#endif

char topicTelemetry[64];
char topicStatus[64];

uint32_t seq = 0;
uint32_t lastSampleMs = 0;
uint32_t lastPublishMs = 0;
uint32_t lastReconnectMs = 0;
uint32_t reconnectBackoffMs = 1000;

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
  return false;
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
  Serial.printf_P(PSTR("\n[boot] libnav node %s role=%s\n"), DEVICE_ID, kRole);

  snprintf(topicTelemetry, sizeof(topicTelemetry), "libnav/dev/%s/telemetry", DEVICE_ID);
  snprintf(topicStatus, sizeof(topicStatus), "libnav/dev/%s/status", DEVICE_ID);

  // --- sensor ---
  Wire.begin();                    // SDA=D2/GPIO4, SCL=D1/GPIO5
  if (!bmp.begin_I2C()) {          // tries 0x77 then 0x76
    Serial.println(F("[bmp390] not found - check wiring"));
    while (true) { ledBlink(1, 500); }
  }
  // High-resolution pressure for 3.8 m floor separation (~46 Pa/floor).
  bmp.setPressureOversampling(BMP3_OVERSAMPLING_8X);
  bmp.setTemperatureOversampling(BMP3_OVERSAMPLING_2X);
  bmp.setIIRFilterCoeff(BMP3_IIR_FILTER_COEFF_3);
  bmp.setOutputDataRate(BMP3_ODR_25_HZ);
  Serial.println(F("[bmp390] ready"));

  // --- network ---
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  wifiMulti.addAP(WIFI_VENUE_SSID, WIFI_VENUE_PASS);
  wifiMulti.addAP(WIFI_HOTSPOT_SSID, WIFI_HOTSPOT_PASS);
  wifiEnsure();
  syncClock();

  // --- TLS trust ---
  if (isCaCertInstalled()) {
    static BearSSL::X509List caCert(CA_CERT_PEM);
    tlsClient.setTrustAnchors(&caCert);
    Serial.println(F("[tls] CA certificate validation enabled"));
  } else {
    // First-run convenience only. Install the CA (see docs/SETUP.md) before
    // any real deployment: without it the TLS peer is not authenticated.
    tlsClient.setInsecure();
    Serial.println(F("[tls] WARNING: certs.h placeholder detected -> setInsecure()"));
  }

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setKeepAlive(15);
  mqtt.setSocketTimeout(5);
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
