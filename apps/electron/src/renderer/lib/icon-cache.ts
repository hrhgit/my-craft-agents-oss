/**
 * Unified Icon Cache
 *
 * Single cache for skill and status icons.
 *
 * Icons are stored as data URLs for consistent usage across:
 * - React components (img src)
 * - HTML string generation (inline badges)
 *
 * Cache key format uses type prefixes to avoid collisions:
 * - skill:{workspaceId}:{slug}
 * - status:{workspaceId}:{relativePath}
 *
 * Note: Labels do NOT use icons — they are color-only (colored circles).
 *
 * Canonical API:
 * - loadEntityIcon() — async loader, generic over entity type
 * - getEntityIconSync() — sync cache lookup
 * - clearEntityIconCache() — clear by entity type
 * - useEntityIcon() — React hook (calls loadEntityIcon internally)
 *
 * Legacy skill wrappers are thin shims over the canonical API.
 */

import { useState, useEffect, useMemo } from 'react'
import { isEmoji } from '@mortise/shared/utils/icon-constants'
import type { ResolvedEntityIcon } from '@mortise/shared/icons'

// ============================================================================
// Types
// ============================================================================

interface SkillConfig {
  slug: string
  iconPath?: string
  metadata?: { icon?: string }
}

// ============================================================================
// Generic Entity Icon API (canonical entry point)
// ============================================================================

/**
 * Supported entity types for icon loading.
 * - 'skill' — workspace skills
 * - 'status' — workspace statuses (loaded via useEntityIcon only)
 */
export type IconEntityType = 'skill' | 'status'

/**
 * Cache lookup key for an entity icon.
 * The cache is keyed as `{entityType}:{workspaceId}:{identifier}`.
 */
export interface EntityIconKey {
  entityType: IconEntityType
  workspaceId: string
  identifier: string
}

/**
 * Options for the generic async icon loader.
 * `skillConfig` is required for entityType='skill'.
 */
export interface LoadEntityIconOptions {
  entityType: IconEntityType
  workspaceId: string
  identifier: string
  /** Skill config — required for entityType='skill'. */
  skillConfig?: SkillConfig
}

// ============================================================================
// Unified Cache
// ============================================================================

/**
 * Single unified cache for all icon types.
 * Key format: `{type}:{workspaceId}:{identifier}`
 * - skill:wsId:slug
 * - status:wsId:relativePath
 */
export const iconCache = new Map<string, string>()

// ============================================================================
// Legacy exports (for backward compatibility during migration)
// These are views into the unified cache, not separate maps.
// ============================================================================

// Proxy objects that redirect to the unified cache with appropriate prefixes
// This allows consumers to continue using the old API while we migrate them

/** @deprecated Use iconCache directly with 'skill:' prefix */
const skillIconCache = {
  get: (key: string) => iconCache.get(`skill:${key}`),
  set: (key: string, value: string) => iconCache.set(`skill:${key}`, value),
  has: (key: string) => iconCache.has(`skill:${key}`),
  delete: (key: string) => iconCache.delete(`skill:${key}`),
  clear: () => {
    // Clear only skill entries
    for (const key of iconCache.keys()) {
      if (key.startsWith('skill:')) iconCache.delete(key)
    }
  },
}

// ============================================================================
// Cache Management
// ============================================================================

/**
 * Clear all icon caches (all entity types)
 */
export function clearIconCaches(): void {
  iconCache.clear()
  colorableCache.clear()
  rawSvgCache.clear()
}

// ============================================================================
// Generic Entity Icon API — Canonical Implementation
// ============================================================================

// Special prefix for emoji icons in cache - callers check for this to render emoji
export const EMOJI_ICON_PREFIX = 'emoji:'

/**
 * Get an entity icon synchronously from cache.
 * Returns null if not cached (use loadEntityIcon to populate).
 */
export function getEntityIconSync(key: EntityIconKey): string | null {
  return iconCache.get(`${key.entityType}:${key.workspaceId}:${key.identifier}`) ?? null
}

/**
 * Clear cache for a given entity type (and optionally a specific workspace).
 * Also clears matching entries from colorableCache and rawSvgCache.
 */
export function clearEntityIconCache(opts: {
  entityType: IconEntityType
  workspaceId?: string
}): void {
  const prefix = opts.workspaceId
    ? `${opts.entityType}:${opts.workspaceId}:`
    : `${opts.entityType}:`
  for (const key of iconCache.keys()) {
    if (key.startsWith(prefix)) iconCache.delete(key)
  }
  for (const key of colorableCache) {
    if (key.startsWith(prefix)) colorableCache.delete(key)
  }
  for (const key of rawSvgCache.keys()) {
    if (key.startsWith(prefix)) rawSvgCache.delete(key)
  }
}

/**
 * Load an entity icon into the cache (generic over entity type).
 *
 * Resolution priority (iconValue from entity config is the source of truth):
 * 1. Emoji → Return emoji marker for caller to render as text
 * 2. URL (http/https) → Return URL directly
 * 3. Local path (./...) → Load from {entityDir}/{identifier}/{filename}
 * 4. Known iconPath (skills) → Load from file
 * 5. Auto-discover {entityDir}/{identifier}/icon.{svg,png} (only when iconValue is undefined)
 *
 * @returns Promise resolving to icon URL, emoji marker (emoji:{emoji}), or null
 */
export async function loadEntityIcon(opts: LoadEntityIconOptions): Promise<string | null> {
  const { entityType, workspaceId, identifier } = opts
  const cacheKey = `${entityType}:${workspaceId}:${identifier}`

  // Check cache first
  const cached = iconCache.get(cacheKey)
  if (cached) return cached

  if (entityType === 'skill') {
    return resolveSkillIcon(opts, cacheKey)
  }
  // 'status' icons are loaded via useEntityIcon's loadIconFile/discoverIconFile,
  // not through this function. Return null for direct calls.
  return null
}

// ----------------------------------------------------------------------------
// Skill icon resolution (called by loadEntityIcon)
// ----------------------------------------------------------------------------

/**
 * Resolve a skill icon. Extracted from the legacy loadSkillIcon.
 *
 * Resolution priority:
 * 1. Emoji in metadata.icon → Return emoji marker
 * 2. URL in metadata.icon → Return URL directly
 * 3. Known iconPath → Load from file
 * 4. Auto-discover .pi/skills/{slug}/icon.{svg,png} → Load from file
 */
async function resolveSkillIcon(
  opts: LoadEntityIconOptions,
  cacheKey: string,
): Promise<string | null> {
  const { workspaceId, identifier, skillConfig } = opts
  if (!skillConfig) return null

  const iconValue = skillConfig.metadata?.icon

  // Priority 1: Emoji icon - return marker for caller to render as text
  if (iconValue && isEmoji(iconValue)) {
    const emojiMarker = `${EMOJI_ICON_PREFIX}${iconValue}`
    iconCache.set(cacheKey, emojiMarker)
    return emojiMarker
  }

  // Priority 2: URL in metadata - return URL directly
  if (iconValue && (iconValue.startsWith('http://') || iconValue.startsWith('https://'))) {
    iconCache.set(cacheKey, iconValue)
    return iconValue
  }

  // Priority 3: Known icon path - load file
  if (skillConfig.iconPath) {
    const skillsMatch = skillConfig.iconPath.replace(/\\/g, '/').match(/\.pi\/skills\/([^/]+)\/(.+)$/)
    if (skillsMatch) {
      const relativePath = `.pi/skills/${skillsMatch[1]}/${skillsMatch[2]}`
      const loaded = await loadWorkspaceIcon(workspaceId, relativePath)
      if (loaded) {
        iconCache.set(cacheKey, loaded)
        return loaded
      }
    }
  }

  // Priority 4: Auto-discover icon files (when no explicit icon configured)
  if (!iconValue) {
    const svgIcon = await loadWorkspaceIcon(workspaceId, `.pi/skills/${identifier}/icon.svg`)
    if (svgIcon) {
      iconCache.set(cacheKey, svgIcon)
      return svgIcon
    }

    const pngIcon = await loadWorkspaceIcon(workspaceId, `.pi/skills/${identifier}/icon.png`)
    if (pngIcon) {
      iconCache.set(cacheKey, pngIcon)
      return pngIcon
    }
  }

  return null
}

/**
 * Helper to load a workspace image via IPC.
 * Handles SVG theming and returns data URL or null on failure.
 */
async function loadWorkspaceIcon(workspaceId: string, relativePath: string): Promise<string | null> {
  try {
    const result = await window.electronAPI.readWorkspaceImage(workspaceId, relativePath)
    // IPC returns null for missing files (silent fallback)
    if (!result) {
      return null
    }
    // For SVG, theme and convert to data URL
    // This injects foreground color since currentColor doesn't work in background-image
    if (relativePath.endsWith('.svg')) {
      return svgToThemedDataUrl(result)
    }
    return result
  } catch {
    // Security errors or I/O failures still throw - handle them gracefully
    return null
  }
}

// ============================================================================
// Legacy Skill Icon Wrappers (@deprecated — use loadEntityIcon)
// ============================================================================

/**
 * Load a skill icon into the cache.
 * @deprecated Use `loadEntityIcon({ entityType: 'skill', ... })`.
 */
export async function loadSkillIcon(
  skill: SkillConfig,
  workspaceId: string,
): Promise<string | null> {
  return loadEntityIcon({
    entityType: 'skill',
    workspaceId,
    identifier: skill.slug,
    skillConfig: skill,
  })
}

/**
 * Get a skill icon synchronously from cache.
 * @deprecated Use `getEntityIconSync({ entityType: 'skill', ... })`.
 */
export function getSkillIconSync(workspaceId: string, slug: string): string | null {
  return getEntityIconSync({ entityType: 'skill', workspaceId, identifier: slug })
}

// ============================================================================
// SVG Theming
// ============================================================================

/**
 * Get the current foreground color from CSS custom properties.
 * Returns the computed value of --foreground or a fallback.
 */
export function getForegroundColor(): string {
  if (typeof document === 'undefined') {
    // SSR/Node fallback - dark theme default
    return '#e3e2e5'
  }

  const computedColor = getComputedStyle(document.documentElement)
    .getPropertyValue('--foreground')
    .trim()

  // If we got an oklch value, return it as-is (browsers handle it)
  // If empty, return a sensible default
  return computedColor || '#e3e2e5'
}

/**
 * Process SVG content to inject theme foreground color.
 *
 * This fixes SVGs that use currentColor or have no fill specified,
 * which would otherwise render as black when used as background-image
 * (since CSS color inheritance doesn't work for background images).
 *
 * @param svgContent - Raw SVG string content
 * @param foregroundColor - Color to inject (defaults to current theme foreground)
 * @returns Processed SVG string with colors injected
 */
export function themeSvgContent(
  svgContent: string,
  foregroundColor?: string
): string {
  const color = foregroundColor ?? getForegroundColor()

  let processed = svgContent

  // Replace all currentColor references with the actual color
  processed = processed.replace(/currentColor/gi, color)

  // For SVGs with no fill attribute on the root element, add one
  // This catches SVGs that rely on default black fill
  processed = processed.replace(
    /<svg([^>]*)>/i,
    (match, attrs) => {
      // Don't add fill if already has fill attribute (even fill="none")
      if (/\bfill\s*=/i.test(attrs)) {
        return match
      }
      // Add fill attribute to SVG root
      return `<svg${attrs} fill="${color}">`
    }
  )

  return processed
}

/**
 * Convert SVG content to a themed data URL.
 * Injects foreground color and encodes as base64.
 */
export function svgToThemedDataUrl(svgContent: string, foregroundColor?: string): string {
  const themedSvg = themeSvgContent(svgContent, foregroundColor)
  return `data:image/svg+xml;base64,${btoa(themedSvg)}`
}

// ============================================================================
// Helpers
// ============================================================================

// ============================================================================
// Unified Entity Icon Hook
// ============================================================================

/** Supported icon file extensions for auto-discovery */
const ICON_FILE_EXTENSIONS = ['.svg', '.png', '.jpg', '.jpeg']

/**
 * Pre-compiled regex for extracting workspace-relative icon paths from absolute paths.
 * Matches any known entity directory prefix (.pi/skills/ or statuses/)
 * followed by the rest of the path.
 */
const ICON_PATH_PATTERN = /(?:\.pi\/skills|statuses)\/.+$/

/**
 * Options for the useEntityIcon hook.
 */
export interface UseEntityIconOptions {
  /** Workspace context for IPC calls */
  workspaceId: string
  /** Cache namespace (e.g. 'skill', 'status', 'label') */
  entityType: string
  /** Unique identifier within the entity type (slug, statusId, etc.) */
  identifier: string
  /**
   * Known relative path to icon file (for entities with pre-resolved paths).
   * e.g. '.pi/skills/my-skill/icon.svg'
   * If provided, only this exact path is attempted (no auto-discovery).
   */
  iconPath?: string
  /**
   * Directory to auto-discover icon files in (relative to workspace).
   * e.g. '.pi/skills/review' → tries icon.svg, icon.png, etc.
   * Ignored if iconPath is provided.
   */
  iconDir?: string
  /**
   * Icon value from entity config. Can be:
   * - Emoji string (e.g. "🔧") → resolved as emoji
   * - URL (ignored here, assumed already downloaded to local file)
   * - undefined → auto-discover from iconDir
   */
  iconValue?: string
  /**
   * Override the filename used for auto-discovery (default: 'icon').
   * e.g. for statuses, set to the statusId so it discovers '{statusId}.svg'
   * instead of 'icon.svg'.
   */
  iconFileName?: string
}

/**
 * Unified icon loading hook - single entry point for all entity types.
 *
 * Handles cache lookup, IPC file loading, SVG theming, colorability detection,
 * and emoji detection. Returns a ResolvedEntityIcon ready for EntityIcon rendering.
 *
 * Resolution priority (config iconValue is the source of truth):
 * 1. Emoji in iconValue → { kind: 'emoji', value: emoji, colorable: false }
 * 2. URL in iconValue → { kind: 'file', value: url, colorable: false }
 * 3. Local file (iconPath) → { kind: 'file', value: dataUrl, colorable }
 * 4. Auto-discover in iconDir (only when iconValue is undefined) → { kind: 'file', value: dataUrl, colorable }
 * 5. Fallback → { kind: 'fallback', colorable: false }
 *
 * Config takes precedence over auto-discovered local files.
 *
 * Usage:
 *   const icon = useEntityIcon({ workspaceId, entityType: 'skill', identifier: slug, iconPath })
 *   return <EntityIcon icon={icon} fallbackIcon={Zap} />
 */
export function useEntityIcon(opts: UseEntityIconOptions): ResolvedEntityIcon {
  const { workspaceId, entityType, identifier, iconPath, iconDir, iconValue, iconFileName } = opts

  // Stable cache key for this entity's icon
  const cacheKey = `${entityType}:${workspaceId}:${identifier}`

  // Check if iconValue is an emoji or URL (synchronous, no loading needed)
  const immediateValue = useMemo(() => {
    // Guard against non-string values (can happen with malformed config data)
    if (!iconValue || typeof iconValue !== 'string') return null
    if (isEmoji(iconValue)) return { type: 'emoji' as const, value: iconValue }
    if (iconValue.startsWith('http://') || iconValue.startsWith('https://')) {
      return { type: 'url' as const, value: iconValue }
    }
    return null
  }, [iconValue])

  // Initial state: check cache synchronously or return emoji/url/fallback
  const [resolved, setResolved] = useState<ResolvedEntityIcon>(() => {
    if (immediateValue?.type === 'emoji') {
      return { kind: 'emoji', value: immediateValue.value, colorable: false }
    }
    if (immediateValue?.type === 'url') {
      // URLs are returned directly as 'file' kind (works in img src)
      return { kind: 'file', value: immediateValue.value, colorable: false }
    }
    // Check unified cache for a previously loaded file icon
    const cached = iconCache.get(cacheKey)
    if (cached) {
      const colorable = colorableCache.has(cacheKey)
      return {
        kind: 'file',
        value: cached,
        colorable,
        rawSvg: colorable ? rawSvgCache.get(cacheKey) : undefined,
      }
    }
    return { kind: 'fallback', colorable: false }
  })

  useEffect(() => {
    // If emoji, no file loading needed - just update state
    if (immediateValue?.type === 'emoji') {
      setResolved({ kind: 'emoji', value: immediateValue.value, colorable: false })
      return
    }

    // If URL from config, use it directly (no file loading needed)
    // Config URL takes precedence over auto-discovered local files
    if (immediateValue?.type === 'url') {
      setResolved({ kind: 'file', value: immediateValue.value, colorable: false })
      return
    }

    // Check cache first
    const cached = iconCache.get(cacheKey)
    if (cached) {
      const colorable = colorableCache.has(cacheKey)
      setResolved({
        kind: 'file',
        value: cached,
        colorable,
        rawSvg: colorable ? rawSvgCache.get(cacheKey) : undefined,
      })
      return
    }

    // No cache hit - load from filesystem via IPC
    let cancelled = false

    async function loadIcon() {
      let result: { dataUrl: string; colorable: boolean; rawSvg?: string } | null = null

      if (iconPath) {
        // Known path - extract relative portion and load directly
        // iconPath may be absolute; extract the workspace-relative part
        const normalizedIconPath = iconPath.replace(/\\/g, '/')
        const relativeMatch = normalizedIconPath.match(ICON_PATH_PATTERN)
        const relativePath = relativeMatch ? relativeMatch[0] : normalizedIconPath

        result = await loadIconFile(workspaceId, relativePath)
      } else if (iconDir && !iconValue) {
        // Auto-discover icon files in directory
        // Only do auto-discovery when iconValue is undefined (config takes precedence)
        // iconFileName overrides the default 'icon' prefix (e.g. statuses use statusId)
        result = await discoverIconFile(workspaceId, iconDir, iconFileName)
      }

      if (cancelled) return

      if (result) {
        // Cache the loaded icon and its colorability/rawSvg
        iconCache.set(cacheKey, result.dataUrl)
        if (result.colorable) {
          colorableCache.add(cacheKey)
        }
        if (result.rawSvg) {
          rawSvgCache.set(cacheKey, result.rawSvg)
        }
        setResolved({
          kind: 'file',
          value: result.dataUrl,
          colorable: result.colorable,
          rawSvg: result.rawSvg,
        })
      } else {
        setResolved({ kind: 'fallback', colorable: false })
      }
    }

    loadIcon()

    return () => { cancelled = true }
  }, [workspaceId, entityType, identifier, iconPath, iconDir, iconFileName, immediateValue, cacheKey, iconValue])

  return resolved
}

// ============================================================================
// useEntityIcon Internal Helpers
// ============================================================================

/**
 * Tracks which cached icons are colorable (use currentColor).
 * Kept as a Set of cache keys for O(1) lookup.
 */
const colorableCache = new Set<string>()

/**
 * Stores sanitized raw SVG content for colorable icons.
 * Used for inline rendering so CSS color classes can cascade into SVG fills.
 */
const rawSvgCache = new Map<string, string>()

/**
 * Load a single icon file by relative path.
 * Handles SVG theming, colorability detection, and sanitization.
 *
 * For colorable SVGs (those using currentColor), returns rawSvg for inline rendering
 * so CSS color classes can cascade into SVG fills/strokes.
 */
async function loadIconFile(
  workspaceId: string,
  relativePath: string
): Promise<{ dataUrl: string; colorable: boolean; rawSvg?: string } | null> {
  try {
    const content = await window.electronAPI.readWorkspaceImage(workspaceId, relativePath)
    // IPC returns null for missing files (silent fallback)
    if (!content) {
      return null
    }

    if (relativePath.endsWith('.svg')) {
      // Detect if SVG uses currentColor (colorable)
      const colorable = content.includes('currentColor')
      // Theme SVG: inject foreground color for data URL usage
      const dataUrl = svgToThemedDataUrl(content)

      if (colorable) {
        // Sanitize SVG for inline rendering (XSS prevention)
        const rawSvg = sanitizeSvgForInline(content)
        return { dataUrl, colorable, rawSvg }
      }

      return { dataUrl, colorable }
    }

    // Raster image (PNG, JPG) - not colorable
    return { dataUrl: content, colorable: false }
  } catch {
    // File doesn't exist or failed to load
    return null
  }
}

/**
 * Sanitize SVG content for safe inline rendering via dangerouslySetInnerHTML.
 * Removes script tags, event handlers, and JavaScript URLs.
 * Also strips width/height attributes so SVG fills its container.
 */
function sanitizeSvgForInline(svg: string): string {
  return svg
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/on\w+="[^"]*"/gi, '')
    .replace(/on\w+='[^']*'/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/\s+width="[^"]*"/gi, '')
    .replace(/\s+height="[^"]*"/gi, '')
}

/**
 * Auto-discover an icon file in a workspace directory.
 * Probes all extensions (.svg, .png, .jpg, .jpeg) in parallel via IPC,
 * then returns the first successful result by priority order.
 * Default fileName is 'icon' (e.g. icon.svg). Override for entities
 * that use identifier-based naming (e.g. statuses use '{statusId}.svg').
 */
async function discoverIconFile(
  workspaceId: string,
  iconDir: string,
  fileName?: string
): Promise<{ dataUrl: string; colorable: boolean; rawSvg?: string } | null> {
  const name = fileName ?? 'icon'

  // Probe all extensions in parallel — reduces round-trips from N to 1
  const results = await Promise.allSettled(
    ICON_FILE_EXTENSIONS.map(ext =>
      loadIconFile(workspaceId, `${iconDir}/${name}${ext}`)
    )
  )

  // Return first successful result in priority order (svg > png > jpg > jpeg)
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) return result.value
  }
  return null
}
