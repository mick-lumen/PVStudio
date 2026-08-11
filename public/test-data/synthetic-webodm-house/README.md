# Synthetic WebODM house fixture

This directory contains a deterministic, browser-loadable **synthetic stand-in**
for a textured WebODM export. It is **not a real photogrammetry capture and was
not produced by WebODM**; the scene is generated in-repo to make viewer tests
repeatable and redistributable:

- `synthetic-webodm-house.obj` — 79,009,505 bytes, 545,871 vertices, 1,086,560
  triangular polygons, seven explicit normals, and UV coordinates. The file is
  above the 50,000,000-byte / 500,000-triangle large-model acceptance target
  while remaining below GitHub's 100 MiB per-file limit.
- `synthetic-webodm-house.obj.gz` — 11,706,029-byte deterministic gzip delivery
  artifact used by the public sample flow. It expands byte-for-byte to the OBJ
  above and is tracked so a clean checkout exercises the same model as a local
  workspace.
- `synthetic-webodm-house.mtl` — `Ground`, `Roof`, and `Wall` material groups
  linked to local JPEG maps.
- `ground-texture.jpg`, `roof-texture.jpg`, `wall-texture.jpg` — valid 512 ×
  512 JPEG textures.

The model is a lightly noisy, photogrammetry-*shaped* scene with a pitched roof,
four walls, and surrounding ground. It is intended to exercise OBJ/MTL loading,
surface picking, roof-normal placement, texture loading, and large-model
progress reporting. Load the `.obj` file in PV Studio and select the adjacent
`.mtl` and JPEG files when using the local-file picker; when testing from the
deployed app, use the fixture's documented URL on the progress page.

## Provenance and licence

The OpenDroneMap project publishes an [ODMData catalogue](https://opendronemap.org/odm/datasets/)
of source image sets, but those downloads are aerial photographs that must be
processed locally and are not a small, redistributable OBJ/MTL bundle. ODM's
[output documentation](https://docs.opendronemap.org/sw/outputs/) confirms the
`odm_texturing/odm_textured_model.obj` + texture-map contract. After checking
those authoritative sources, this fixture was generated in-repo instead of
redistributing third-party imagery or a model with unclear rights.

The geometry, material file, and textures in this directory are original
synthetic test content released under [CC0 1.0](LICENSE.txt). The generator is
`scripts/generate-webodm-sample.py`; it uses only Python's standard library
and `ffmpeg` (with a valid tiny-JPEG fallback when `ffmpeg` is unavailable).

## Rebuild and validate

From the repository root:

```sh
python3 scripts/generate-webodm-sample.py
python3 scripts/generate-webodm-sample.py --validate
```

Validation checks canonical SHA-256 hashes for the checked-in OBJ, compressed
OBJ, MTL, and all three JPEG maps in addition to the exact file-size floor
(50,000,000 bytes), polygon floor (500,000), OBJ-to-MTL link, required material
groups, and complete JPEG marker/scan structure with dimensions. This catches
byte-level texture corruption even when a damaged JPEG still has an EOI marker.

The adversarial regression suite can be run with:

```sh
python3 scripts/test-webodm-sample.py
```
