#!/usr/bin/env python3
"""Adversarial regression tests for the synthetic WebODM fixture validator."""

from __future__ import annotations

import importlib.util
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GENERATOR_PATH = ROOT / "scripts" / "generate-webodm-sample.py"
FIXTURE_PATH = ROOT / "public" / "test-data" / "synthetic-webodm-house"
MODULE_SPEC = importlib.util.spec_from_file_location("pvstudio_webodm_generator", GENERATOR_PATH)
if MODULE_SPEC is None or MODULE_SPEC.loader is None:
    raise RuntimeError(f"Unable to import fixture generator: {GENERATOR_PATH}")
GENERATOR = importlib.util.module_from_spec(MODULE_SPEC)
sys.modules[MODULE_SPEC.name] = GENERATOR
MODULE_SPEC.loader.exec_module(GENERATOR)


class FixtureValidatorAdversarialTests(unittest.TestCase):
    """Each test mutates an isolated copy, never the checked-in fixture."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(prefix="pvstudio-webodm-test-")
        self.root = Path(self.temp_dir.name) / FIXTURE_PATH.name
        self.root.mkdir()
        # Hard-link the large immutable fixture so map/JPEG tests do not copy
        # ~79 MiB for every case.  A test calls _copy_for_write before mutating
        # a file, preserving both the checked-in fixture and test isolation.
        for source in FIXTURE_PATH.iterdir():
            if source.is_file():
                os.link(source, self.root / source.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def assert_invalid(self) -> None:
        with self.assertRaises(ValueError):
            GENERATOR.validate(self.root)

    def _copy_for_write(self, name: str) -> Path:
        target = self.root / name
        target.unlink()
        shutil.copy2(FIXTURE_PATH / name, target)
        return target

    def test_checked_in_fixture_is_valid(self) -> None:
        self.assertEqual(GENERATOR.validate(self.root), GENERATOR.EXPECTED_COUNTS)

    def test_missing_compressed_delivery_artifact_fails(self) -> None:
        (self.root / "synthetic-webodm-house.obj.gz").unlink()
        with self.assertRaises(FileNotFoundError):
            GENERATOR.validate(self.root)

    def test_missing_map_kd_fails(self) -> None:
        mtl_path = self._copy_for_write("synthetic-webodm-house.mtl")
        mtl = mtl_path.read_text(encoding="utf-8")
        mtl_path.write_text(mtl.replace("map_Kd ground-texture.jpg\n", "", 1), encoding="utf-8")
        self.assert_invalid()

    def test_traversal_and_absolute_map_kd_fail(self) -> None:
        for replacement in ("../ground-texture.jpg", "/tmp/ground-texture.jpg", r"C:\\textures\\ground-texture.jpg"):
            with self.subTest(replacement=replacement):
                mtl_path = self.root / "synthetic-webodm-house.mtl"
                self._copy_for_write("synthetic-webodm-house.mtl")
                mtl = mtl_path.read_text(encoding="utf-8")
                mtl_path.write_text(mtl.replace("map_Kd ground-texture.jpg", f"map_Kd {replacement}", 1), encoding="utf-8")
                self.assert_invalid()
                mtl_path.write_text(mtl, encoding="utf-8")

    def test_all_zero_geometry_fails(self) -> None:
        obj_path = self._copy_for_write("synthetic-webodm-house.obj")
        lines = obj_path.read_text(encoding="utf-8").splitlines(keepends=True)
        zeroed = ["v 0.00000 0.00000 0.00000\n" if line.startswith("v ") else line for line in lines]
        obj_path.write_text("".join(zeroed), encoding="utf-8")
        self.assert_invalid()

    def test_truncated_and_malformed_jpeg_fail(self) -> None:
        texture_path = self._copy_for_write("ground-texture.jpg")
        original = texture_path.read_bytes()
        for malformed in (original[:-2], b"\xff\xd8\xff\xd9"):
            with self.subTest(length=len(malformed)):
                texture_path.write_bytes(malformed)
                self.assert_invalid()
                texture_path.write_bytes(original)

    def test_entropy_corruption_with_eoi_preserved_fails(self) -> None:
        """Marker parsing alone must not accept a bit-flipped scan payload."""

        texture_path = self._copy_for_write("ground-texture.jpg")
        corrupted = bytearray(texture_path.read_bytes())
        sos = corrupted.find(b"\xff\xda")
        self.assertGreaterEqual(sos, 0)
        segment_length = int.from_bytes(corrupted[sos + 2:sos + 4], "big")
        entropy_start = sos + 2 + segment_length
        eoi = corrupted.rfind(b"\xff\xd9")
        self.assertGreater(entropy_start, sos)
        self.assertGreater(eoi, entropy_start)
        for index in range(entropy_start, eoi):
            if corrupted[index] not in (0x00, 0xFF) and (corrupted[index] ^ 0x01) != 0xFF:
                corrupted[index] ^= 0x01
                break
        else:
            self.fail("fixture had no safe entropy byte to flip")
        self.assertEqual(bytes(corrupted[-2:]), b"\xff\xd9")
        texture_path.write_bytes(corrupted)
        self.assert_invalid()

    def test_scan_truncation_with_eoi_preserved_fails(self) -> None:
        """Removing most entropy data while retaining EOI must fail integrity."""

        texture_path = self._copy_for_write("ground-texture.jpg")
        original = texture_path.read_bytes()
        sos = original.find(b"\xff\xda")
        self.assertGreaterEqual(sos, 0)
        segment_length = int.from_bytes(original[sos + 2:sos + 4], "big")
        entropy_start = sos + 2 + segment_length
        eoi = original.rfind(b"\xff\xd9")
        cut = min(entropy_start + 128, eoi)
        while cut > entropy_start and original[cut - 1] == 0xFF:
            cut -= 1
        self.assertGreater(cut, entropy_start)
        texture_path.write_bytes(original[:cut] + b"\xff\xd9")
        self.assert_invalid()


if __name__ == "__main__":
    unittest.main()
