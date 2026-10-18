# Agent Note: Bound the frames2d decode cache and release one-shot tracks

Status: implemented

## Problem

The frames2d decode cache memoized every decoded frame for the life of the page,
justified by the assumption that "frames are tiny same-origin webp files". That
assumption does not hold for a real frames2d pack. A 256x256 RGBA frame is
~262 KB decoded, so a pack with 372 frames across 10 tracks retains roughly
93 MB of bitmaps that nothing ever releases: `decoding` is deleted from only on
failure, and its single `clear()` runs in `dispose`.

The user-visible symptom is progressive frame loss. Once decoded-frame memory
outgrows what the compositor can hold, every further decode has to wait, but the
per-frame `setTimeout` chain keeps firing on its own schedule. The tail of each
animation is therefore dropped — playback looks correct for the first few
animations and degrades the longer the page runs.

A second defect sat in the same code. `lastDrawnUrl` is the value that pins "the
frame currently on screen" so eviction can never blank the canvas, but it was
assigned only inside the `<img>` fallback branch. On the canvas path it stayed
`undefined`, so the pin protected nothing and every finished one-shot track kept
its final frame for the rest of the session — one leaked frame per animation
played.

## Decision

Three changes, all inside the renderer:

1. **Bound the cache by decoded bytes.** A budget of 150 frames of 256x256 RGBA
   (~39 MB) with LRU eviction; each dropped `ImageBitmap` is released with
   `close()`. The frame being painted is never evicted, and the playing track
   keeps the window playback actually needs (a few frames behind plus the
   prefetch window). Protecting a whole track instead would make an idle pet's
   own frames un-evictable and the budget could never be honoured.

2. **Release a finished non-loop track outright.** A one-shot track is over
   until the user asks for it again, so its bitmaps are dead weight the moment it
   settles into its fallback.

3. **Pin the requested frame synchronously.** `show()` records `lastDrawnUrl`
   before painting, so the pin tracks what playback asked for on both the canvas
   and `<img>` paths. The canvas draw callback only runs for the newest token, so
   a frame superseded before it resolved never recorded itself.

An eviction generation guards the in-flight case: a decode that started before an
eviction must not resolve afterwards and re-adopt a bitmap callers were told is
gone. `cachedFrameCount()` and `cachedFrameBytes()` are exposed on the handle for
diagnostics.

Measured on the reported pack: five animations in a row decode 60 bitmaps, 50 are
released, and 10 are retained (the idle track). The retained count is flat rather
than rising by one per animation.

## Alternatives considered

- **Keep the unbounded memoization and document a frame-size budget for pet
  authors.** Rejected: it makes a rendering contract the pet author's problem, and
  the defect is in the renderer either way. It also leaves the one-frame-per-track
  leak in place.
- **LRU only, without releasing finished one-shot tracks.** Rejected as the sole
  mechanism. It bounds memory, but it keeps frames that provably cannot be needed
  again and pushes the budget into evicting frames the playing track does want.
  Release-on-finish is both cheaper and more precise; the budget remains as the
  backstop for long looping tracks and many-track pets.
- **Drop the custom decode cache and let the `<img>` element own decoding.**
  Rejected for now: the canvas path exists precisely to control decode and paint
  timing, and the `<img>` fallback already covers runtimes without
  `createImageBitmap`. Revisiting this is a larger change than the defect needs.
- **Reduce `PREFETCH_AHEAD` or raise the pool limit.** Rejected: neither bounds
  retained memory, which is the actual constraint; both only change how fast the
  backlog grows.

## Consequences

- Decoded-frame memory is bounded by the budget plus whatever the playing track
  and the painted frame hold, instead of growing with every animation watched.
- A frame that was evicted is decoded again when playback returns to it. Long
  looping tracks stay warm; replayed one-shots pay one decode pass, which is the
  intended trade for not retaining them.
- The `<img>` fallback path shares the bookkeeping but not the release benefit:
  `HTMLImageElement` has no `close()`, so its frames remain the browser's to
  manage.
- Pet authors no longer need to size tracks against an implied memory ceiling,
  though `FRAME_CACHE_BUDGET` is now the number to revisit if a pack's tracks are
  much larger than 256x256.
