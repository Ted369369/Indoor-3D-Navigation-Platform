/*
 * I2C bus diagnostic for the Library 3D Navigation sensor node
 * ------------------------------------------------------------
 * Standalone troubleshooting sketch - flash this instead of the main firmware
 * when the BMP390 is not detected. It answers three questions in order:
 *
 *   1. Are the pull-ups there?   (idle levels on SDA / SCL)
 *   2. Is the bus stuck?         (attempts a 9-clock recovery if SDA is low)
 *   3. What is on the bus?       (full 0x01..0x7E scan, printed every cycle)
 *
 * Pins are the same generic GPIO numbers the main firmware uses, so a result
 * here applies directly to esp8266_bmp390.ino.
 *
 * Wiring: BMP390 VIN -> 3V3, GND -> GND, SDA -> GPIO4, SCL -> GPIO5
 *         (NodeMCU / Wemos silkscreen: D2 = GPIO4, D1 = GPIO5)
 *
 * Serial Monitor: 115200 baud.
 */

#include <Wire.h>

#define I2C_SDA_PIN     4          // GPIO4  (D2 on NodeMCU / Wemos)
#define I2C_SCL_PIN     5          // GPIO5  (D1 on NodeMCU / Wemos)
#define I2C_CLOCK_HZ    50000UL    // start slow - raise once the bus is proven
#define SCAN_PERIOD_MS  3000

/* Addresses this project cares about, so the scan output is self-explaining. */
static const char *knownDevice(uint8_t addr) {
  switch (addr) {
    case 0x76: return "BMP390 / BMP3xx  (SDO tied to GND)";
    case 0x77: return "BMP390 / BMP3xx  (default address)";
    case 0x68: return "MPU6050 / DS3231 (not used here)";
    case 0x3C: return "SSD1306 OLED     (not used here)";
    default:   return nullptr;
  }
}

/* Both lines must idle HIGH - that is what the pull-up resistors do. */
static bool checkIdleLevels() {
  pinMode(I2C_SDA_PIN, INPUT);
  pinMode(I2C_SCL_PIN, INPUT);
  delay(10);
  int sda = digitalRead(I2C_SDA_PIN);
  int scl = digitalRead(I2C_SCL_PIN);

  Serial.printf("Idle levels : SDA=%d  SCL=%d  -> ", sda, scl);
  if (sda && scl) {
    Serial.println("OK (pull-ups present)");
    return true;
  }
  Serial.println("PROBLEM");
  if (!sda) Serial.println("  SDA is LOW: missing pull-up, shorted to GND, or a stuck slave.");
  if (!scl) Serial.println("  SCL is LOW: missing pull-up or shorted to GND.");
  Serial.println("  Most BMP390 breakouts have on-board pull-ups. If yours does");
  Serial.println("  not, add 4.7k from SDA->3V3 and SCL->3V3.");
  return false;
}

/*
 * Classic bus recovery: if a slave is mid-transfer it can hold SDA low. Nine
 * clock pulses on SCL let it finish the byte, then a manual STOP frees the bus.
 */
static void recoverBus() {
  Serial.println("Attempting bus recovery (9 clock pulses + STOP)...");
  pinMode(I2C_SCL_PIN, OUTPUT);
  pinMode(I2C_SDA_PIN, INPUT_PULLUP);
  for (int i = 0; i < 9; i++) {
    digitalWrite(I2C_SCL_PIN, LOW);  delayMicroseconds(10);
    digitalWrite(I2C_SCL_PIN, HIGH); delayMicroseconds(10);
  }
  // STOP condition: SDA goes low->high while SCL is high
  pinMode(I2C_SDA_PIN, OUTPUT);
  digitalWrite(I2C_SDA_PIN, LOW);  delayMicroseconds(10);
  digitalWrite(I2C_SCL_PIN, HIGH); delayMicroseconds(10);
  digitalWrite(I2C_SDA_PIN, HIGH); delayMicroseconds(10);
  pinMode(I2C_SDA_PIN, INPUT);
  pinMode(I2C_SCL_PIN, INPUT);
  delay(10);
  Serial.printf("After recovery: SDA=%d  SCL=%d\n",
                digitalRead(I2C_SDA_PIN), digitalRead(I2C_SCL_PIN));
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println(F("\n\n=== I2C diagnostic ==="));
  Serial.printf("Pins        : SDA=GPIO%d  SCL=GPIO%d\n", I2C_SDA_PIN, I2C_SCL_PIN);
  Serial.printf("Clock       : %lu Hz\n", (unsigned long)I2C_CLOCK_HZ);

  if (!checkIdleLevels()) {
    recoverBus();
  }

  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  Wire.setClock(I2C_CLOCK_HZ);
  Wire.setClockStretchLimit(40000);   // ESP8266: give slow slaves room
  Serial.println(F("Bus started. Scanning every 3 s.\n"));
}

void loop() {
  Serial.println(F("Scanning 0x01..0x7E ..."));

  uint8_t found = 0, errors = 0;
  bool bmpSeen = false;
  uint8_t bmpAddr = 0;

  for (uint8_t addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    uint8_t err = Wire.endTransmission();

    if (err == 0) {                       // slave ACKed its address
      const char *name = knownDevice(addr);
      Serial.printf("  >>> 0x%02X responded", addr);
      if (name) Serial.printf("   <- %s", name);
      Serial.println();
      found++;
      if (addr == 0x76 || addr == 0x77) { bmpSeen = true; bmpAddr = addr; }
    } else if (err == 4) {                // bus-level fault, not a plain NACK
      Serial.printf("  !!! 0x%02X unknown error (possible bus fault)\n", addr);
      errors++;
    }
    delay(2);
  }

  Serial.printf("Result      : %u device(s) found", found);
  if (errors) Serial.printf(", %u bus error(s)", errors);
  Serial.println();

  if (bmpSeen) {
    Serial.printf("BMP390      : OK at 0x%02X - the main firmware will find it.\n", bmpAddr);
  } else if (found == 0) {
    Serial.println(F("BMP390      : NOT FOUND - nothing at all is on the bus."));
    Serial.println(F("  Check, in order:"));
    Serial.println(F("   1. VIN on 3V3 (NOT 5V) and GND connected"));
    Serial.println(F("   2. SDA/SCL not swapped (SDA=GPIO4, SCL=GPIO5)"));
    Serial.println(F("   3. Solder joints on the breakout header"));
    Serial.println(F("   4. Pull-ups present (see idle levels above)"));
  } else {
    Serial.println(F("BMP390      : not at 0x76/0x77, but other devices replied -"));
    Serial.println(F("              the bus works, so suspect the sensor itself."));
  }
  Serial.println();

  delay(SCAN_PERIOD_MS);
}
