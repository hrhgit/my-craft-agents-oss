import { describe, expect, it } from 'bun:test'
import { DEBUG_MENU, HELP_LINKS, MENU_SECTIONS, ROOT_MENU, type MenuItem } from '../../../../shared/menu-schema'
import { getMenuIcon } from '../../icons/MenuIcons'

function collectMenuIconNames(): string[] {
  const icons: string[] = []
  const visit = (item: MenuItem): void => {
    if ('icon' in item && typeof item.icon === 'string') icons.push(item.icon)
  }
  for (const section of MENU_SECTIONS) {
    if (section.icon) icons.push(section.icon)
    section.items.forEach(visit)
  }
  icons.push(DEBUG_MENU.icon)
  DEBUG_MENU.items.forEach(visit)
  HELP_LINKS.forEach(visit)
  Object.values(ROOT_MENU).forEach(visit)
  return icons
}

describe('menu icon registry', () => {
  it('covers every icon name referenced by the menu schemas', () => {
    const names = [...new Set(collectMenuIconNames())]
    expect(names.length).toBeGreaterThan(0)
    const missing = names.filter(name => getMenuIcon(name) === null)
    expect(missing).toEqual([])
  })
})
