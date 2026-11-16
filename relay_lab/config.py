"""Locate a matching pair of Bitcoin Core executables for the lab."""

import os
import shutil
from pathlib import Path


def find_bin_dir(directory=None, network="regtest"):
    variable = "TESTNET5_BITCOIN_BIN_DIR" if network == "testnet5" else "BITCOIN_BIN_DIR"
    if directory is None:
        directory = os.environ.get(variable)
    if not directory:
        executable = shutil.which("bitcoind")
        if executable:
            directory = Path(executable).parent
    if not directory:
        raise ValueError(f"Choose the BIP332 build with --bin-dir or {variable}, or put its binaries on PATH.")
    directory = Path(directory).expanduser().resolve()
    for name in ("bitcoind", "bitcoin-cli"):
        binary = directory / name
        if not binary.is_file() or not os.access(binary, os.X_OK):
            raise ValueError(f"Missing executable {name} in {directory}; choose the BIP332 build with --bin-dir or {variable}.")
    return directory
