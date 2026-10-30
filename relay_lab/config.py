"""Locate a matching pair of Bitcoin Core executables for the lab."""

import os
import shutil
from pathlib import Path


def find_bin_dir(directory=None):
    if directory is None:
        directory = os.environ.get("BITCOIN_BIN_DIR")
    if not directory:
        executable = shutil.which("bitcoind")
        if executable:
            directory = Path(executable).parent
    if not directory:
        raise ValueError("Choose the BIP332 build with --bin-dir or BITCOIN_BIN_DIR, or put its binaries on PATH.")
    directory = Path(directory).expanduser().resolve()
    for name in ("bitcoind", "bitcoin-cli"):
        binary = directory / name
        if not binary.is_file() or not os.access(binary, os.X_OK):
            raise ValueError("Missing executable %s in %s; choose the BIP332 build with --bin-dir or BITCOIN_BIN_DIR." % (name, directory))
    return directory
