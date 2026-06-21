# FastMarchingTopoPlot

Pen plotter SVG line art generator. Converts a photo to topographic contour lines using the **Fast Marching Method** — bright areas spread contours wide, dark areas compress them, creating dense detail where it matters. No build step, runs entirely in the browser.

## Try it

**[Open in browser →](https://raw.githack.com/rolandblok/FastMarchingTopoPlot/main/index.html)**

No install needed — loads the typewriter demo automatically.

**Everything runs in your browser. Your images are never uploaded anywhere.**

---

## How it works

A wavefront expands outward from a seed point across the image. Pixel brightness controls the wave speed: bright pixels are traversed quickly (contour rings spread apart), dark pixels slow the wave down (rings compress together, adding detail). The result is a travel-time map. Slicing that map at evenly-spaced levels gives topographic iso-lines — the contour plot.

| Input | Output |
|---|---|
| ![Typewriter without background](typewriter_nobg.png) | ![Contour plot](typewriter_contour.png) |

The algorithm is a JavaScript implementation of the **Eikonal equation** solver used by Python's `skfmm` library, with contour extraction via [`d3-contour`](https://github.com/d3/d3-contour) (marching squares).

---

## Usage

1. Open the [live demo](https://raw.githack.com/rolandblok/FastMarchingTopoPlot/main/index.html) — or clone the repo and open `index.html` via any static file server.
2. Browse to an image (PNG with transparency works best).
3. Adjust parameters and click **▶ Start**.
4. Click **⬇ Save SVG** when done — the SVG is sized for A4 and ready to send to a pen plotter.

---

## Controls

| Control | Effect |
|---|---|
| **Blur σ** | Gaussian pre-blur — smooths fine detail before FMM |
| **Gamma** | Darken (`>1`) or lighten (`<1`) midtones, shifting where rings compress |
| **Scale %** | Downscale the working image to speed up computation |
| **Num lines** | Number of contour levels sliced from the travel-time map |
| **Speed offset** | Minimum wave speed — prevents stalling in pure-black areas |
| **Center X / Y** | Seed point the wavefront expands from. Click on the image to set it |
| **Skip transparent** | Clip contour segments that fall in transparent PNG areas |
| **Stroke width** | Line thickness in the SVG output (mm). Updates the preview live |

---

## Files

| File | Role |
|---|---|
| `index.html` | Layout and controls |
| `style.css` | Dark panel + white canvas |
| `script.js` | UI, image loading, contour extraction, SVG export |
| `worker.js` | FMM solver — Gaussian blur → speed field → Eikonal min-heap |

---

## Dependencies

- [`d3-contour`](https://github.com/d3/d3-contour) v4 — loaded from CDN, can be vendored for offline use
- No build step, no npm, no framework
