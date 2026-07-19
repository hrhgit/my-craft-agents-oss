export type RecentDirScenario = 'none' | 'few' | 'many'

const RECENT_DIR_SCENARIO_DATA: Record<RecentDirScenario, string[]> = {
  none: [],
  few: [
    '/Users/demo/projects/mortise',
    '/Users/demo/projects/mortise/apps/electron',
    '/Users/demo/projects/mortise/packages/shared',
  ],
  many: [
    '/Users/demo/projects/mortise',
    '/Users/demo/projects/mortise/apps/electron',
    '/Users/demo/projects/mortise/apps/viewer',
    '/Users/demo/projects/mortise/apps/cli',
    '/Users/demo/projects/mortise/packages/shared',
    '/Users/demo/projects/mortise/packages/server-core',
    '/Users/demo/projects/mortise/packages/shared',
    '/Users/demo/projects/mortise/packages/ui',
    '/Users/demo/projects/mortise/scripts',
  ],
}

/** Return a copy of the fixture list for the selected scenario. */
export function getRecentDirsForScenario(scenario: RecentDirScenario): string[] {
  return [...RECENT_DIR_SCENARIO_DATA[scenario]]
}
