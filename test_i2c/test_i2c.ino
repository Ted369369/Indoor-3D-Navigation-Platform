#include <Wire.h>

#define SDA_PIN 4
#define SCL_PIN 5

void checkIdleLevels() {
  pinMode(SDA_PIN, INPUT);
  pinMode(SCL_PIN, INPUT);
  delay(10);
  int sda = digitalRead(SDA_PIN);
  int scl = digitalRead(SCL_PIN);
  Serial.printf("閒置電位  SDA=%d  SCL=%d  ", sda, scl);
  if (sda && scl) Serial.println("(正常，有上拉)");
  else            Serial.println("(異常！沒上拉或被短路拉低)");
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n\n=== I2C 診斷 ===");

  checkIdleLevels();

  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(50000);              // 先降到 50kHz，軟體 I2C 比較穩
  Wire.setClockStretchLimit(40000);
}

void loop() {
  byte found = 0;
  Serial.println("掃描中...");
  for (byte addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.printf("  >>> 0x%02X 有回應\n", addr);
      found++;
    }
    delay(2);
  }
  if (found == 0) Serial.println("  匯流排上沒有任何裝置");
  Serial.println();
  delay(3000);
}