import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from relay_lab.config import find_bin_dir


class BinaryConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="staletip-config-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def binaries(self, name):
        directory = self.root / name
        directory.mkdir()
        for name in ("bitcoind", "bitcoin-cli"):
            executable = directory / name
            executable.touch()
            executable.chmod(0o700)
        return directory

    def test_explicit_directory_overrides_environment_and_path(self):
        explicit = self.binaries("explicit build")
        environment = self.binaries("environment")
        with patch.dict(os.environ, {"BITCOIN_BIN_DIR": str(environment)}), patch("relay_lab.config.shutil.which") as which:
            self.assertEqual(find_bin_dir(explicit), explicit.resolve())
            which.assert_not_called()

    def test_environment_overrides_path(self):
        directory = self.binaries("environment")
        with patch.dict(os.environ, {"BITCOIN_BIN_DIR": str(directory)}), patch("relay_lab.config.shutil.which") as which:
            self.assertEqual(find_bin_dir(), directory.resolve())
            which.assert_not_called()

    def test_path_requires_both_executables(self):
        directory = self.binaries("path")
        with patch.dict(os.environ, {"BITCOIN_BIN_DIR": ""}), patch("relay_lab.config.shutil.which", return_value=str(directory / "bitcoind")):
            self.assertEqual(find_bin_dir(), directory.resolve())
            (directory / "bitcoin-cli").chmod(0o600)
            with self.assertRaisesRegex(ValueError, "Missing executable bitcoin-cli"):
                find_bin_dir()

    def test_missing_configuration_explains_how_to_choose_a_build(self):
        with patch.dict(os.environ, {"BITCOIN_BIN_DIR": ""}), patch("relay_lab.config.shutil.which", return_value=None):
            with self.assertRaisesRegex(ValueError, "--bin-dir or BITCOIN_BIN_DIR"):
                find_bin_dir()
