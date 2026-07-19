export interface MortiseRuntimeModeInput {
  search: string
  viteTestMode?: string | boolean
}

/** Shared product-feature test mode used by quick launchers. */
export function resolveCraftTestMode({ search, viteTestMode }: MortiseRuntimeModeInput): boolean {
  const queryValue = new URLSearchParams(search).get('mortiseTestMode')
  if (queryValue === '0' || queryValue === 'false') return false
  if (queryValue === '1' || queryValue === 'true') return true
  return viteTestMode === true || viteTestMode === '1' || viteTestMode === 'true'
}

export function isCraftTestMode(): boolean {
  return resolveCraftTestMode({
    search: window.location.search,
    viteTestMode: import.meta.env.VITE_MORTISE_TEST_MODE,
  })
}
