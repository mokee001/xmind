# E590 transfer optimization — 2026-10-29

## Baseline
One server-observed sample: cloud-ready → next 21.434 s; downloading → refreshing 30.675 s. Actual PWE6 file: 960,045 bytes, including 45-byte header (not 96 KB). These intervals include status requests and are not pure download durations.

## Cloud
Deployed targeted bootstrap poll_seconds=5 for pwe6-70DFD6B1E590; all other devices remain 15. Existing protocol, authentication and routes preserved. photowall-staging active and public docs HTTP 200 after restart. Applies after next successful bootstrap.
Backup: /opt/photowall/app/backend/server.py.before-fast-poll-1793246493039836837
Reproducible patch: deploy/fast_device_poll.py.

## Firmware candidate
Based on 98d9fc7, Waveshare 13.3 E6. Version 0.3.9-transfer. Temporarily disable Wi-Fi modem sleep during cloud polling/transfer; restore previous setting on every return. Read validated frame length in bounded 4 KB nonblocking chunks; reject disconnected/truncated data and retain idle deadline plus SHA-256 verification. Add ECHO_TRANSFER elapsed timings around task, status requests, download headers/body/close/verification.

Original code already stopped at expected length. A fixed 30-second connection-close wait has NOT been proven. Improvement requires real-device measurement.

## Verification
Portable frame-reader regression tests passed with address and undefined-behavior sanitizers: partial reads, trailing data, buffered data after disconnect, truncation, idle timeout and clock wrap.
Full private 32 MB flash backup saved outside repository. NVS, OTA metadata, partition table and bootloader must not be rewritten. Application-only target offset 0x10000, partition size 0x640000.

Build passed and application-only flash hash verified. User reconnected E590 successfully. 0.3.8-transfer showed repeated connect timeouts after initial requests. Added persistent HTTP/TLS transport reuse for sequential cloud requests; drain JSON responses, close incomplete frames and close when origin changes. No automatic POST retries, auth/security settings unchanged.

0.3.9-transfer boot log confirms device id and bootstrap poll_seconds=5. First post-reboot pending frame: task GET 103 ms; task parsed 104 ms; downloading status completed 228 ms; frame download headers 95 ms, body complete 12710 ms, SHA verified 12738 ms; frame ready at 12967 ms; refreshing status completed at 13082 ms. Download-status-complete → refresh-status-complete = 12854 ms. Baseline 30675 ms was SERVER observed; this new value is DEVICE observed, so comparison is indicative, not an identical timing boundary. Cloud-ready → receipt not measured for this frame because it was queued before reboot. Device reported Displayed revision 1793248581643341829. Subsequent 204 polls: 73, 103, 113, 113, 113, 113 ms. User confirmed the earlier connection failures occurred because the network was accidentally switched off: do NOT attribute those timeouts to firmware or claim reuse fixed the outage. Connection reuse improved successful request latency; total cloud-ready → device receipt still needs a fresh continuously-online test with server timestamps. No credentials stored in this report.
