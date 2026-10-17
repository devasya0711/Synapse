#!/usr/bin/env python3
"""
generate_icons.py — Synapse · ContextRelay Icon Generation Utility

Outputs crisp, modern, production-grade PNG icons across standard
Manifest V3 Chrome Extension resolutions from the official brand design:
  - icons/icon16.png   (16x16  — Toolbar small)
  - icons/icon32.png   (32x32  — Retina display toolbar)
  - icons/icon48.png   (48x48  — Extension management page)
  - icons/icon128.png  (128x128 — Chrome Web Store display)
  - icons/icon512.png  (512x512 — High-resolution master)

Preserves the exact attached brand design (S-shaped synaptic neural connector,
bi-directional electric spark, cyan/purple neural filaments, and dark slate
background) with squircle boundary geometry.
"""

import os
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageEnhance

WORKSPACE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS_DIR = os.path.join(WORKSPACE_DIR, 'icons')
SOURCE_IMG_PATH = os.path.join(ICONS_DIR, 'synapse_master_design.png')
MASTER_PNG_PATH = os.path.join(ICONS_DIR, 'icon512.png')

RESOLUTIONS = {
    16:  'icon16.png',
    32:  'icon32.png',
    48:  'icon48.png',
    128: 'icon128.png',
}

def generate_master_icon():
    """Generates the 512x512 master icon from the brand design."""
    if not os.path.exists(SOURCE_IMG_PATH):
        print(f"[Error] Source brand image not found at: {SOURCE_IMG_PATH}")
        sys.exit(1)

    print(f"[IconGen] Loading brand design from: {SOURCE_IMG_PATH}")
    src = Image.open(SOURCE_IMG_PATH).convert("RGBA")

    # Crop the central 'S' neural emblem with proportional padding (X: 352-672, Y: 90-398)
    # This precisely frames the full emblem, filaments, nodes, and spark, clearing the text below.
    s_emblem = src.crop((352, 90, 672, 398))

    # Detect the brand dark slate background color from margins
    bg_sample = src.crop((50, 50, 150, 150))
    bg_color = tuple(int(c) for c in np.mean(np.array(bg_sample), axis=(0, 1)))

    # Create 512x512 canvas with brand background
    master = Image.new("RGBA", (512, 512), bg_color)

    # Scale the S emblem to fit with balanced breathing room (420x404)
    emblem_w, emblem_h = 420, 404
    s_resized = s_emblem.resize((emblem_w, emblem_h), Image.Resampling.LANCZOS)
    paste_x = (512 - emblem_w) // 2
    paste_y = (512 - emblem_h) // 2
    master.paste(s_resized, (paste_x, paste_y))

    # Apply modern squircle (rounded-rectangle) alpha mask (radius 110 at 512x512)
    mask = Image.new("L", (512, 512), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([(0, 0), (511, 511)], radius=110, fill=255)
    master.putalpha(mask)

    master.save(MASTER_PNG_PATH, format="PNG", optimize=True)
    print(f"[IconGen] Master 512x512 icon generated at: {MASTER_PNG_PATH}")
    return master

def generate_all_resolutions(master):
    """Generates all standard Chrome extension icon resolutions from master."""
    for size, filename in RESOLUTIONS.items():
        out_path = os.path.join(ICONS_DIR, filename)
        resized = master.resize((size, size), Image.Resampling.LANCZOS)

        # Micro-sharpening at tiny toolbar resolutions to keep neural filaments crisp
        if size in (16, 32):
            enhancer = ImageEnhance.Sharpness(resized)
            resized = enhancer.enhance(1.4)

        resized.save(out_path, format="PNG", optimize=True)
        file_size = os.path.getsize(out_path)
        print(f"[IconGen] Generated {size}x{size} icon -> {filename} ({file_size} bytes)")

    print("[IconGen] Complete icon suite successfully built and verified.")

def main():
    os.makedirs(ICONS_DIR, exist_ok=True)
    master = generate_master_icon()
    generate_all_resolutions(master)

if __name__ == '__main__':
    main()
