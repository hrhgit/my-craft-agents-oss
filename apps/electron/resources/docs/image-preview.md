# Image Preview Guide

This guide covers how to display image files inline using `image-preview` code blocks.

## Overview

The `image-preview` block renders local image files inline in chat messages — showing the image in a fixed-height container with an expand button for fullscreen viewing.

| Format | Best For | Rendering |
|--------|----------|-----------|
| **`image-preview` block** | Screenshots, captures, visual diffs | Inline fit-to-container + fullscreen viewer |
| **`pdf-preview` block** | PDF reports and documents | First page inline + full document scroll in fullscreen |
| **`html-preview` block** | Rich HTML content | Sandboxed iframe rendering |

**Key principle:** Images are already files on disk. Reference them directly with an absolute path in `src`.

## When to Use

Use `image-preview` when:
- You have a local screenshot/capture file and want inline visual context
- You want before/after visual comparisons in one response
- A tool result generated or downloaded image files
- The user asks to view an image directly in chat

Do NOT use `image-preview` when:
- The content is a PDF (`pdf-preview`)
- The content is rich HTML (`html-preview`)
- The content is structured table data (`datatable`/`spreadsheet`)
- The file format is unsupported in Chromium (often HEIC/HEIF/TIFF)

## Basic Usage

### Single Item

````
```image-preview
{
  "src": "/absolute/path/to/screenshot.png",
  "title": "Settings screen"
}
```
````

### Multiple Items (Card Stack)

Use `items` to show related images as a swipeable card stack.

````
```image-preview
{
  "title": "Before / After",
  "items": [
    { "src": "/path/to/before.png", "label": "Before" },
    { "src": "/path/to/after.png", "label": "After" }
  ]
}
```
````

All items load in parallel when the block mounts and stay cached afterwards.

### Config Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `src` | Yes* | string | Absolute path to image file (single item mode) |
| `title` | No | string | Header title (defaults to "Image Preview") |
| `items` | Yes* | array | Array of image items with `src` and optional `label` |
| `items[].src` | Yes | string | Absolute path to image file |
| `items[].label` | No | string | Card label (also used as alt text and in the fullscreen item navigator) |

*Either `src` (single) or `items` (multiple) is required. If both are present, `items` takes precedence.

## Supported Formats

In-app preview supports Chromium-decodable formats:
- PNG, JPG, JPEG, GIF, WebP, SVG, BMP, ICO, AVIF

Formats like HEIC/HEIF/TIFF may not render in-app. For those files, use external open.

## Rendering Behavior

### Inline Preview
- Fixed 320px-high preview area
- Image is rendered with `object-contain` (no cropping)
- Expand button opens fullscreen overlay
- Multi-item blocks render as a swipeable card stack (drag to advance, tap the top card to open fullscreen)

### Fullscreen Overlay
- Larger fit-to-container image view
- Item navigation (arrows/label dropdown) for multi-item sets
- Zoom controls in the header (in/out, presets, fit, reset)
- Scroll-wheel zoom, drag to pan, double-click resets the view
- Copy path action in header
- File path badge supports external open/reveal actions

## Troubleshooting

### "Loading..." shown indefinitely
- Verify `src` is an **absolute path**
- Confirm the file exists and is readable
- Check that file extension is one of the supported formats

### "Load Failed" error
- File path may be invalid or access may be denied
- Image may be corrupted
- Format may not be decodable by Chromium

### HEIC/TIFF doesn’t render
- Expected for many environments
- Open externally using the file path badge actions
