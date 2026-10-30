# The Daedalus mark

Two wings, each laid feather by feather "in due order, from small to large", the way Ovid
describes Daedalus building them (*Metamorphoses* 8). Read in Daedalus's own alphabet, the mark
spells the company: each wing is a **Δ** (delta, D), and the two together form a **Λ** (lambda, L).
**ΔΔΛ** is Daedalus Data Labs.

`assets/daedalus-master-ink.svg` is the source. Every other file is rendered from it.

## Construction

| Element | Rule | Why |
|---|---|---|
| Outline | A Λ: an equilateral triangle (60° sides) with a 30° underside notch | The wings together are the L; the notch turns a static triangle into a craft in flight. |
| Wings | Each half is a triangle: outer tip, apex, notch | Each wing is a Δ, a D. |
| Feathers | Three per wing, shortest outside, longest at the body | Ovid's order: small to large. |
| Feather tops | Follow a gentle arc rather than the straight 60° side | Ovid: he "bent them to the shape of birds". |
| Gaps | One width everywhere, including the body between the wings | One rule for every space. |
| Fill | Solid, one ink: `#0B1526` on marble `#F4F3EF`, or reversed | Holds at every size. Bronze `#B07A2E` is used only in construction drawings. |

The SVG viewBox is cropped to the ink (`0 5.26 200 167.94`): no padding. Clear space is
supplied by the layout and is at least one feather width on every side.

## Lockup

The mark sits to the left of the name, set in two lines: **Daedalus** (Geist SemiBold) over
**Data Labs** (Geist Regular, muted). The mark's height equals the height of that two-line block,
so the mark and the name read as one unit.

## Sizes

- The lockup is used where the name is at least 16 px tall.
- App icons (apple-touch, 512 tile): the mark alone, centred on a marble tile at 62% of the
  tile's width.
- Favicons: the mark alone on a transparent ground, redrawn on the pixel grid so each feather
  and gap lands on whole pixels (16 px: feathers 1-2-2-2-2-1, gaps 1-1-2-1-1; 32 px: feathers 4,
  gaps 1-1-2-1-1). `favicon.svg` uses the 16 px drawing and switches to marble in dark mode.

## Files

- `daedalus-master-ink.svg`, `daedalus-master-reversed.svg`: the source.
- `daedalus-master-ink.png`, `daedalus-master-reversed.png`: 7600 × 6382, transparent, cropped to the ink.
- `daedalus-mark-ink.svg`, `daedalus-mark-reversed.svg`: for the web.
- `daedalus-tile-512.png`, `apple-touch-icon.png`, `favicon-32.png`, `favicon-16.png`, `/favicon.svg`, `/favicon.ico` (16/32/48), `og.png`.
