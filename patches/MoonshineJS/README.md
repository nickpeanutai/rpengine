# Moonshine JS RPEngine Web Patch

`moonshine-js` is pinned to upstream commit `59c9c83669e464d3e3f00d85c850d4327bef9009`.
RPEngine uses the upstream `MoonshineModel.generate()` implementation, while the
small parent-owned patch makes model loading compatible with the app's existing
OPFS model store and shared ONNX Runtime Web installation.

## Apply after a fresh clone

From `rpengine`:

```sh
git submodule update --init --recursive moonshine-js
git -C moonshine-js apply ../patches/MoonshineJS/rp-engine-web.patch
npm run moonshine:verify
```

The patch changes only `moonshine-js/src/model.ts`. It selects the host's
`onnxruntime-web/wasm` package and permits the encoder and decoder to be supplied
as `Uint8Array` values read from OPFS. The upstream `generate()` method remains
byte-for-byte unchanged.

If the patch is already applied, `git apply` will fail. Confirm the expected
state with:

```sh
npm run moonshine:verify
```

To restore the pinned upstream file before reapplying:

```sh
git -C moonshine-js restore src/model.ts
git -C moonshine-js apply ../patches/MoonshineJS/rp-engine-web.patch
```

Do not commit inside the submodule. The patch is owned and versioned by the
parent repository.
