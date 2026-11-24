#include "device_power.h"

#include "device_buttons.h"
#include <atomic>
#include <driver/gpio.h>
#include <esp_sleep.h>

namespace photowall {
namespace {

TaskHandle_t sampler = nullptr;
std::atomic<bool> stopped{false};
constexpr auto wakePin = static_cast<gpio_num_t>(kExternalButtonPin);

void sampleTask(void*) {
  for (;;) {
    pollDeviceButtons();
    if (ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(5))) break;
  }
  stopped.store(true);
  vTaskDelete(nullptr);
}

void disableStandbyWake() {
  gpio_wakeup_disable(wakePin);
  esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_ALL);
  gpio_sleep_sel_dis(wakePin);
}

void waitForRelease() {
  uint32_t since = 0;
  bool seenHigh = false;
  for (;;) {
    if (digitalRead(kExternalButtonPin) == LOW) seenHigh = false;
    else if (!seenHigh) {
      seenHigh = true;
      since = millis();
    } else if (millis() - since >= kButtonDebounceMs) return;
    delay(5);
  }
}

}  // namespace

void startButtonSampling() {
  beginDeviceButtons(true);
  setDeviceButtonsPoweredOn(true);
  if (xTaskCreate(sampleTask, "pw-buttons", 3072, nullptr, 2, &sampler) != pdPASS) {
    sampler = nullptr;
    Serial.println("Button sampler unavailable: cooperative sampling only");
  }
}

void pollButtonsIfNeeded() {
  if (!sampler) pollDeviceButtons();
}

void waitForStandbyWake() {
  if (sampler) {
    xTaskNotifyGive(sampler);
    while (!stopped.load()) delay(1);
    sampler = nullptr;
  }
  waitForRelease();
  beginDeviceButtons(false);
  esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_ALL);
  bool sleepReady = gpio_sleep_set_direction(wakePin, GPIO_MODE_INPUT) == ESP_OK &&
      gpio_sleep_set_pull_mode(wakePin, GPIO_PULLUP_ONLY) == ESP_OK &&
      gpio_sleep_sel_en(wakePin) == ESP_OK &&
      gpio_wakeup_enable(wakePin, GPIO_INTR_LOW_LEVEL) == ESP_OK &&
      esp_sleep_enable_gpio_wakeup() == ESP_OK;
  if (!sleepReady) disableStandbyWake();
  Serial.printf("Power standby: GPIO40 %s; hold 2 s to wake\n", sleepReady ? "light sleep" : "polling");
  Serial.flush();
  for (;;) {
    if (digitalRead(kExternalButtonPin) == HIGH) {
      if (sleepReady && esp_light_sleep_start() != ESP_OK) {
        disableStandbyWake();
        sleepReady = false;
        Serial.println("Light sleep unavailable; using software standby");
      }
      if (!sleepReady) delay(5);
      if (digitalRead(kExternalButtonPin) == HIGH) continue;
    }
    uint32_t lastLow = millis();
    do {
      pollDeviceButtons();
      if (takeDeviceButtonEvent() == DeviceButtonEvent::PowerOn) {
        disableStandbyWake();
        return;
      }
      if (digitalRead(kExternalButtonPin) == LOW) lastLow = millis();
      delay(5);
    } while (millis() - lastLow <= kButtonDebounceMs + 5);
    beginDeviceButtons(false);
  }
}

}  // namespace photowall