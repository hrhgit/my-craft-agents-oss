/**
 * Automations Atom
 *
 * Simple atom for storing parsed workspace automations.
 * AppShell populates this from the canonical Automations V3 command surface.
 * MainContentPanel reads from it for automation detail display.
 */

import { atom } from 'jotai'
import type { AutomationListItem } from '../components/automations/types'

/**
 * Atom to store the current workspace's parsed automations.
 * AppShell lists versioned definitions and sets this atom.
 */
export const automationsAtom = atom<AutomationListItem[]>([])
