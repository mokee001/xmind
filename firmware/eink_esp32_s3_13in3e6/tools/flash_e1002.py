"""Flash only bootloader and application, after checking E1002 and its backup."""
import argparse
import hashlib
from pathlib import Path
import re
import struct
import subprocess
import sys
import tempfile


def entries(data):
    result = []
    for off in range(0, 0xC00, 32):
        row = data[off:off + 32]
        if row[:2] != b"\xaaP":
            break
        result.append(struct.unpack("<HBBII16sI", row))
    if not result:
        raise ValueError("Missing ESP partition table")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True)
    parser.add_argument("--mac", required=True)
    parser.add_argument("--backup", required=True, type=Path)
    parser.add_argument("--backup-sha256", required=True)
    parser.add_argument("--esptool", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    build = root / ".pio/build/reterminal_e1002"
    backup = args.backup.read_bytes()
    if len(backup) != 32 * 1024 * 1024 or hashlib.sha256(backup).hexdigest() != args.backup_sha256:
        raise ValueError("Full 32MB backup size/checksum mismatch")
    expected = entries((build / "partitions.bin").read_bytes())
    if entries(backup[0x8000:0x9000]) != expected:
        raise ValueError("Backup partition layout differs from E1002 build")
    if (build / "firmware.bin").stat().st_size > 0x400000:
        raise ValueError("Application exceeds factory partition")
    base = [sys.executable, str(args.esptool), "--chip", "esp32s3", "--port", args.port,
            "--baud", "460800"]
    identity = subprocess.check_output(base + ["flash_id"], text=True)
    print(identity, flush=True)
    found = re.search(r"MAC: ([0-9a-f:]+)", identity, re.I)
    if not found or found[1].lower() != args.mac.lower() or "Detected flash size: 32MB" not in identity:
        raise ValueError("Connected device identity/flash size mismatch")
    with tempfile.TemporaryDirectory() as tmp:
        partitions = Path(tmp) / "partitions.bin"
        subprocess.run(base + ["read_flash", "0x8000", "0x1000", str(partitions)], check=True)
        if entries(partitions.read_bytes()) != expected:
            raise ValueError("Live partition layout mismatch; refusing to overwrite")
    # No mass erase, no partition rewrite, and critically no write at 0xe000.
    subprocess.run(base + ["--after", "no_reset", "write_flash", "--flash_mode", "dio",
        "--flash_freq", "80m", "--flash_size", "32MB",
        "0x0", str(build / "bootloader.bin"), "0x10000", str(build / "firmware.bin")], check=True)
    print("Bootloader and application verified. Reset device to start. NVS/storage preserved.")


if __name__ == "__main__":
    main()
