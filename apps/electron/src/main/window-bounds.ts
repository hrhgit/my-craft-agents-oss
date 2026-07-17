export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export function clampWindowBounds(bounds: WindowBounds, workArea: WindowBounds): WindowBounds {
  const width = Math.min(Math.max(bounds.width, 800), workArea.width)
  const height = Math.min(Math.max(bounds.height, 600), workArea.height)
  return {
    x: Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height),
    width,
    height,
  }
}
