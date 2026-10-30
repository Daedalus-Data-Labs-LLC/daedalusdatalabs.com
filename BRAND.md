# The ddl mark

Every dimension of the mark comes from one unit, **u**, the stroke width. Nothing in it is
set by eye. `assets/ddl-master-ink.svg` is the source; every other file is rendered from it.

| Element | Size | Why |
|---|---|---|
| Stroke | u | One weight everywhere, so the mark reads as one drawing, not assembled parts. |
| Counter | radius u | A bowl whose ring is exactly one stroke thick needs a counter of u inside an outer radius of 2u. |
| Bowl | radius 2u (x-height 4u) | The ring's thickness, 2u − u, equals the stroke. |
| Stem | u wide | The stem is the bowl's own right-hand stroke carried up, so the bowl and stem share an edge and meet without a seam. |
| Ascender | 6u tall | The stem rises one bowl radius (2u) above the bowl. |
| Letter gap | u/2, all three | One rule for every space, measured at the nearest point. |
| Whole mark | 10u × 6u (5 : 3) | Follows from the above: two 4u d's, one u l, two u/2 gaps. |
| Fill | solid, one ink | Ink `#0B1526` on marble `#F4F3EF`, or reversed. No cut-outs, gradients or outlines, so it holds at any size. |

The SVG has no padding: its edges are the ink's edges. Clear space is supplied by the layout
and is at least **2u** on every side.

## Sizes

- The full mark is used at 24 px tall and above.
- Below that (favicons) it is the single **d**: the first letter, the same geometry, 4u × 6u.
- App tiles are 16u square with the mark centred (`ddl-tile-ink-on-marble-512.png`,
  `apple-touch-icon.png`); favicon tiles are 8u square with the d centred.

## Files

- `ddl-master-ink.svg`, `ddl-master-reversed.svg`: the source, viewBox `0 0 300 180` (u = 30).
- `ddl-master-ink.png`, `ddl-master-reversed.png`: 9000 × 5400, transparent, cropped to the ink.
- `ddl-mark-ink.svg`, `ddl-mark-reversed.svg`, `ddl-d-ink.svg`: for the web.
