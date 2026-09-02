#!/usr/bin/env python3
"""
Derive each provincial land-use class's real colour from DPT's legend swatch.

Why this is not just `renderer.symbol.color`
--------------------------------------------
The layer's `drawingInfo.renderer` claims 7180 อนุรักษ์ป่าไม้ and 8700
อนุรักษ์ชนบทและเกษตรกรรม are `esriSFSSolid` **white**. DPT's own `export`
renders them as green hatches. So the renderer is not what the map paints, and
a palette built from it would show two of the commonest rural classes as blank
white chips.

The `legend` endpoint returns the swatch the service actually rasterises, which
is ground truth. Their byte sizes give the game away before you even decode
them: solid classes are ~200 B, the two "white" ones are 264 B and 288 B,
because a hatch has more to compress.

So this reads the stored swatch and takes the most common non-white,
non-transparent pixel — for a solid fill that is the fill; for a hatch it is the
hatch line, which is the colour a reader actually perceives the class as.

No third-party imaging library is used: Pillow is not installed here, and one
land-use palette is not worth a dependency. PNG is a simple enough format to
read directly for the four colour types ArcGIS emits.

Run after collect_dpt_provincial.py; it only touches the local SQLite.
"""

from __future__ import annotations

import argparse
import base64
import collections
import sqlite3
import struct
import sys
import zlib
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DB_PATH = REPO / "server" / "data" / "dpt_provincial.db"


def png_pixels(data: bytes) -> list[tuple[int, int, int, int]]:
    """
    Decode a non-interlaced PNG to RGBA pixels.

    Supports colour types 0 (grey), 2 (RGB), 3 (palette) and 6 (RGBA) at 8 bits,
    which covers everything ArcGIS produces for legend swatches. Anything else
    raises rather than guessing — a wrong palette is worse than no palette.
    """
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")

    pos = 8
    width = height = depth = ctype = interlace = None
    idat = bytearray()
    palette: list[tuple[int, int, int]] = []
    trns: bytes = b""

    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        tag = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        pos += 12 + length  # length + tag + body + crc

        if tag == b"IHDR":
            width, height, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", body)
        elif tag == b"PLTE":
            palette = [tuple(body[i : i + 3]) for i in range(0, len(body), 3)]
        elif tag == b"tRNS":
            trns = body
        elif tag == b"IDAT":
            idat += body
        elif tag == b"IEND":
            break

    if depth != 8 or interlace:
        raise ValueError(f"unsupported PNG: depth={depth} interlace={interlace}")

    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ctype]
    stride = width * channels
    raw = zlib.decompress(bytes(idat))

    # Undo the per-scanline filters. Each row is prefixed with its filter type.
    out = bytearray()
    prev = bytearray(stride)
    at = 0
    for _ in range(height):
        ftype = raw[at]
        at += 1
        line = bytearray(raw[at : at + stride])
        at += stride
        for i in range(stride):
            a = line[i - channels] if i >= channels else 0
            b = prev[i]
            c = prev[i - channels] if i >= channels else 0
            x = line[i]
            if ftype == 1:
                x += a
            elif ftype == 2:
                x += b
            elif ftype == 3:
                x += (a + b) // 2
            elif ftype == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                x += a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
            line[i] = x & 0xFF
        out += line
        prev = line

    pixels: list[tuple[int, int, int, int]] = []
    for i in range(0, len(out), channels):
        px = out[i : i + channels]
        if ctype == 6:
            pixels.append((px[0], px[1], px[2], px[3]))
        elif ctype == 2:
            pixels.append((px[0], px[1], px[2], 255))
        elif ctype == 0:
            pixels.append((px[0], px[0], px[0], 255))
        elif ctype == 4:
            pixels.append((px[0], px[0], px[0], px[1]))
        else:  # palette
            idx = px[0]
            r, g, b = palette[idx] if idx < len(palette) else (0, 0, 0)
            alpha = trns[idx] if idx < len(trns) else 255
            pixels.append((r, g, b, alpha))
    return pixels


def representative_colour(pixels) -> tuple[str | None, str | None, bool]:
    """
    (fill, ink, is_patterned).

    `fill` is the most common opaque colour, `ink` the most common opaque
    colour that is neither the fill nor near-white/near-black outline. A class
    whose fill is white but which carries a substantial second colour is a
    hatch, and `ink` is what a reader sees it as.
    """
    opaque = [p[:3] for p in pixels if p[3] > 128]
    if not opaque:
        return (None, None, False)

    counts = collections.Counter(opaque)
    fill = counts.most_common(1)[0][0]

    def is_neutral(c):
        r, g, b = c
        return (r > 240 and g > 240 and b > 240) or (r < 25 and g < 25 and b < 25)

    # The swatch is bordered in black, so ignore that as well as the fill.
    others = [(c, n) for c, n in counts.items() if c != fill and not is_neutral(c)]
    others.sort(key=lambda kv: -kv[1])
    ink = others[0][0] if others else None

    total = len(opaque)
    fill_share = counts[fill] / total
    patterned = bool(ink and is_neutral(fill) and (others[0][1] / total) > 0.05)
    # Also treat a non-white fill with a big second colour as patterned.
    if ink and not patterned and fill_share < 0.75 and (others[0][1] / total) > 0.2:
        patterned = True

    def hexof(c):
        return "#{:02X}{:02X}{:02X}".format(*c)

    return (hexof(fill), hexof(ink) if ink else None, patterned)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--db", type=Path, default=DB_PATH)
    args = ap.parse_args()

    if not args.db.exists():
        print(f"{args.db} not found — run collect_dpt_provincial.py first", file=sys.stderr)
        return 2

    conn = sqlite3.connect(args.db)
    conn.execute("alter table provincial_symbology add column render_color text"
                 if not _has_column(conn, "provincial_symbology", "render_color") else "select 1")
    conn.execute("alter table provincial_symbology add column render_ink text"
                 if not _has_column(conn, "provincial_symbology", "render_ink") else "select 1")
    conn.execute("alter table provincial_symbology add column patterned integer"
                 if not _has_column(conn, "provincial_symbology", "patterned") else "select 1")
    conn.commit()

    rows = conn.execute(
        "select pl_use, label, color, swatch from provincial_symbology order by pl_use"
    ).fetchall()

    changed = failed = 0
    for code, label, renderer_colour, swatch in rows:
        if not swatch:
            continue
        try:
            fill, ink, patterned = representative_colour(png_pixels(base64.b64decode(swatch)))
        except Exception as e:  # noqa: BLE001 — reported per class, never fatal
            print(f"  ! {code} {label}: {e}", file=sys.stderr)
            failed += 1
            continue
        shown = ink if (patterned and ink) else fill
        conn.execute(
            "update provincial_symbology set render_color=?, render_ink=?, patterned=? where pl_use=?",
            (shown, ink, 1 if patterned else 0, code),
        )
        changed += 1
        flag = ""
        if renderer_colour and shown and renderer_colour.upper() != shown.upper():
            flag = f"   (renderer said {renderer_colour})"
        print(f"  {code:<6} {shown or '-':<9} {'hatch' if patterned else 'solid':<6} {label or ''}{flag}")
    conn.commit()
    conn.close()
    print(f"\n{changed} classes coloured from DPT's own swatches" +
          (f", {failed} failed" if failed else ""))
    return 0


def _has_column(conn: sqlite3.Connection, table: str, column: str) -> bool:
    return any(r[1] == column for r in conn.execute(f"pragma table_info({table})"))


if __name__ == "__main__":
    sys.exit(main())
