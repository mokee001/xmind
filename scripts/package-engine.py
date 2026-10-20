"""Create a reproducible, source-only delivery ZIP without local test data."""
import argparse
import hashlib
import pathlib
import stat
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
DIRECTORIES = ("Sources", "Tests", "gateway", "scripts", "docs", "templates")
FILES = (".gitignore", "AGENTS.md", "Package.swift", "README.md")
EXCLUDED = {".git", ".build", ".swiftpm", ".venv", "__pycache__", "local-data", "dist", "reports", "node_modules", "xcuserdata"}


def source_files():
    candidates = [ROOT / name for name in FILES]
    candidates += list(ROOT.glob("*.command"))
    for name in DIRECTORIES:
        candidates += [p for p in (ROOT / name).rglob("*") if p.is_file()]
    included = []
    for path in candidates:
        relative = path.relative_to(ROOT)
        if any(part in EXCLUDED for part in relative.parts):
            continue
        if path.name == ".DS_Store" or path.suffix in (".pyc", ".xcuserstate"):
            continue
        if path.name.startswith(".env") and path.name != ".env.example":
            continue
        if path.is_symlink():
            raise ValueError("Symlink is not a source artifact: " + str(relative))
        included.append(path)
    return sorted(set(included), key=lambda p: p.relative_to(ROOT).as_posix())


def package(destination):
    destination = destination.resolve()
    checksum = destination.with_suffix(destination.suffix + ".sha256")
    if destination.suffix.lower() != ".zip":
        raise ValueError("Output must be a new ZIP file")
    if destination.exists() or checksum.exists():
        raise FileExistsError("Delivery output already exists")
    # Keep generated archives outside their own source input directories.
    if any(destination.is_relative_to(ROOT / name) for name in DIRECTORIES):
        raise ValueError("Output cannot be inside a source directory")
    paths = source_files()
    destination.parent.mkdir(parents=True, exist_ok=True)
    digests = []
    with zipfile.ZipFile(destination, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in paths:
            name = path.relative_to(ROOT).as_posix()
            data = path.read_bytes()
            digests.append(hashlib.sha256(data).hexdigest() + "  " + name)
            info = zipfile.ZipInfo("echoo-engine/" + name, date_time=(2026, 10, 20, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            mode = 0o755 if path.stat().st_mode & stat.S_IXUSR else 0o644
            info.external_attr = (stat.S_IFREG | mode) << 16
            archive.writestr(info, data)
        info = zipfile.ZipInfo("echoo-engine/SHA256SUMS", date_time=(2026, 10, 20, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = (stat.S_IFREG | 0o644) << 16
        archive.writestr(info, "\n".join(digests) + "\n")
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    with checksum.open("x") as stream:
        stream.write(digest + "  " + destination.name + "\n")
    print(f"Packaged {len(paths)} source files: {destination.name}\nSHA256 {digest}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    package(parser.parse_args().output)
