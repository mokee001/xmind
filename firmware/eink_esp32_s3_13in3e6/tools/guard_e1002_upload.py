Import("env")

if env.subst("$PIOENV") == "reterminal_e1002":
    from SCons.Script import COMMAND_LINE_TARGETS
    if any(t in COMMAND_LINE_TARGETS for t in ("upload", "uploadfs", "erase")):
        raise RuntimeError("E1002 factory NVS overlaps PlatformIO's default boot_app0 address. "
                           "Use tools/flash_e1002.py after a full backup.")
