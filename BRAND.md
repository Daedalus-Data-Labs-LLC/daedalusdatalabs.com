# The Daedalus mark

Daedalus built the labyrinth, so the mark is drawn like one: nested strokes with narrow
passages between them. It spells the company. On the outside are an **L** (stem and foot) and a
**D** (bowl and top bar), split by one cut. Inside them sits a second, whole **D**. That gives
Dae**D**a**L**us, and **D**ata **L**abs.

`scripts/mark.py` is the source. Every brand file is rendered from it by `scripts/brand.py`.

## Construction

The mark is built on a grid where the stroke and the gap are the same width, 4 units. The ink box is 42 × 40.

| Element | Rule | Why |
|---|---|---|
| Stroke and gap | Both 4 units, everywhere. Diagonal gaps are 4 units measured square to the cut. | Even spacing makes the nesting read as a single labyrinth, not as three separate letters. |
| L | Stem and foot, the full height and most of the width of the mark | The outer frame. Labs holds the rest. |
| Outer D | Bowl and top bar, sharing the L's stem as its own | The second letter of the outer pair. |
| Inner D | A closed D, 4 units inside everything else | The whole letter at the centre of the labyrinth. |
| Cuts | All at 45° and parallel: the top of the L's stem, the end of the outer D's top bar, and the cut through the foot | One angle throughout, like letters cut in stone. The two openings, top-left and bottom, are the labyrinth's entrances. |
| Fill | Solid, one ink: `#0B1526` on marble `#F4F3EF`, or reversed | Holds at every size. |

The geometry takes four numbers: stroke `s`, gap `g`, inner counter height `c`, and the inner D's
straight run `k`. The master uses `s = g = 4`, `c = 16`, `k = 10`. The SVG viewBox is cropped to
the ink (`0 0 42 40`), with no padding. The layout provides clear space of at least one stroke width on every side.

## Lockup

The mark sits to the left of the name, which is set in two lines: **Daedalus** (Geist SemiBold) over
**Data Labs** (Geist Regular, muted). The mark is the same height as the two-line block.

| Use | Mark | Daedalus | Data Labs | Line gap | Mark to name | Block |
|---|---|---|---|---|---|---|
| Site header | 31.5 × 30 (stroke 3) | 18 px | 11.5 px | 0.5 px | 10 px | 30 px |
| OG image | 42 × 40 (stroke 4) | 24 px | 15 px | 1 px | 14 px | 40 px |

To set a new size, pick a scale that puts the stroke on whole pixels (0.25 per unit gives a
1 px stroke), then size the two lines at about 3:2 so they fill the mark's height.

## Sizes

- The lockup is used where **Daedalus** is at least 16 px. Below that, use the mark alone.
- On the site every mark is drawn at a whole-pixel stroke: header 31.5 × 30 (stroke 3), footer
  21 × 20 (stroke 2, the mark alone beside the copyright line), splash 126 × 120 (stroke 12),
  splash on phones 84 × 80 (stroke 8).
- App icons and favicons wear the treatment Meridian's and Agora's do: the mark in ink on a soft tile
  (white to warm marble `#E9E6DD`, diagonal), about 57% of the tile's width. 180 px: 105 × 100, stroke 10;
  512 px: 294 × 280, stroke 28; both full bleed (the platform rounds them) with a soft shadow under the mark.
- Favicons are the same tile with the app-icon corner (22.37%). 32 px and 48 px use the master drawing at
  0.5 and 0.75 px per unit on a whole-pixel origin. 16 px is redrawn with `s = g = 1`, `c = 4`, `k = 3`
  (11 × 10), so every stroke and gap is one pixel. `favicon.svg` uses the 16 px drawing and turns to an
  ink-blue tile with a marble mark in dark mode.

## Files

- `scripts/mark.py`: the geometry. `scripts/brand.py` renders everything below except `og.png`.
- `daedalus-master-ink.svg`, `daedalus-master-reversed.svg`: the master drawing.
- `daedalus-master-ink.png`, `daedalus-master-reversed.png`: 7560 × 7200, transparent, cropped to the ink (stroke 720).
- `daedalus-mark-ink.svg`, `daedalus-mark-reversed.svg`: for the web.
- `daedalus-tile-512.png`, `apple-touch-icon.png`, `favicon-32.png`, `favicon-16.png`, `/favicon.svg`, `/favicon.ico` (16/32/48).
- `linkedin-logo-400.png`: 400 × 400 Page logo. The app-icon tile, mark at stroke 24 (252 × 240), exactly centred (74 px each side, 80 px top and bottom), full bleed; LinkedIn rounds it.
- `linkedin-banner-1512x256.png`: 1512 × 256 Page cover. Marble ground, headline in Geist SemiBold 44 px with the URL under it,
  starting 400 px in (the Page logo covers the lower left); mark at stroke 16 (168 × 160), 120 px from the right edge.
- `og.png`: 1200 × 630. Lockup top-left, headline, mark at stroke 28 on the right.
