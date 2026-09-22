"""Regression contracts for recoverable ESP32 BLE provisioning failures."""

from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FIRMWARE = ROOT / "firmware" / "eink_esp32_s3_13in3e6" / "src"


class Esp32ProvisioningRecoveryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.ble_source = (FIRMWARE / "ble_provisioning.cpp").read_text()
        cls.main_source = (FIRMWARE / "main.cpp").read_text()

    def test_wifi_configuration_is_committed_only_after_cloud_bootstrap(self) -> None:
        wifi_connected = re.search(
            r"if \(wifiStatus == WL_CONNECTED\) \{(?P<body>.*?)\n  \}",
            self.ble_source,
            re.DOTALL,
        )
        self.assertIsNotNone(wifi_connected)
        self.assertIn(
            'preferences.putBool("force_setup", true);',
            wifi_connected.group("body"),
        )

        bootstrap_success = re.search(
            r"if \(bootstrapDevice\(\)\) \{(?P<body>.*?)\n    \} else \{",
            self.main_source,
            re.DOTALL,
        )
        self.assertIsNotNone(bootstrap_success)
        self.assertIn(
            "finalizeProvisioningConfiguration();",
            bootstrap_success.group("body"),
        )

    def test_disconnect_restarts_advertising_from_loop(self) -> None:
        disconnected = re.search(
            r"void BleProvisioningService::handleClientDisconnected\(\) \{(?P<body>.*?)\n\}",
            self.ble_source,
            re.DOTALL,
        )
        self.assertIsNotNone(disconnected)
        self.assertIn("advertisingRestartAt_", disconnected.group("body"))
        self.assertNotIn("BLEDevice::startAdvertising()", disconnected.group("body"))
        self.assertIn('Serial.println("BLE provisioning advertising restarted");', self.ble_source)


if __name__ == "__main__":
    unittest.main()