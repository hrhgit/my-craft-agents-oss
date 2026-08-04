import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { DiscoveredSkill } from '../../../shared/types'

interface SkillImportDialogProps {
  open: boolean
  candidates: DiscoveredSkill[]
  importing: boolean
  onOpenChange: (open: boolean) => void
  onImport: (sourcePaths: string[]) => Promise<void>
}

interface SkillImportGroup {
  skillsRoot: string
  candidates: DiscoveredSkill[]
}

export function groupSkillImportCandidates(candidates: DiscoveredSkill[]): SkillImportGroup[] {
  const groups = new Map<string, DiscoveredSkill[]>()
  for (const candidate of candidates) {
    const group = groups.get(candidate.skillsRoot)
    if (group) group.push(candidate)
    else groups.set(candidate.skillsRoot, [candidate])
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([skillsRoot, groupCandidates]) => ({
      skillsRoot,
      candidates: groupCandidates.sort((left, right) =>
        left.slug.localeCompare(right.slug) || left.sourcePath.localeCompare(right.sourcePath)),
    }))
}

export function toggleSkillImportGroup(
  selectedPaths: ReadonlySet<string>,
  candidates: DiscoveredSkill[],
): Set<string> {
  const next = new Set(selectedPaths)
  const allSelected = candidates.every(candidate => next.has(candidate.sourcePath))
  for (const candidate of candidates) {
    if (allSelected) next.delete(candidate.sourcePath)
    else next.add(candidate.sourcePath)
  }
  return next
}

export function SkillImportDialog({
  open,
  candidates,
  importing,
  onOpenChange,
  onImport,
}: SkillImportDialogProps) {
  const { t } = useTranslation()
  const [selectedPaths, setSelectedPaths] = React.useState<Set<string>>(
    () => new Set(candidates.map(candidate => candidate.sourcePath)),
  )

  React.useEffect(() => {
    if (open) setSelectedPaths(new Set(candidates.map(candidate => candidate.sourcePath)))
  }, [candidates, open])

  const groups = React.useMemo(() => groupSkillImportCandidates(candidates), [candidates])
  const allSelected = candidates.length > 0 && selectedPaths.size === candidates.length
  const toggleAll = () => {
    setSelectedPaths(allSelected
      ? new Set()
      : new Set(candidates.map(candidate => candidate.sourcePath)))
  }
  const toggleCandidate = (sourcePath: string) => {
    setSelectedPaths(previous => {
      const next = new Set(previous)
      if (next.has(sourcePath)) next.delete(sourcePath)
      else next.add(sourcePath)
      return next
    })
  }
  const toggleGroup = (groupCandidates: DiscoveredSkill[]) => {
    setSelectedPaths(previous => toggleSkillImportGroup(previous, groupCandidates))
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !importing && onOpenChange(nextOpen)}>
      <DialogContent
        className="sm:max-w-xl"
        semanticId="skills.import.dialog"
        showCloseButton={!importing}
      >
        <DialogHeader>
          <DialogTitle>{t('skillsImport.title')}</DialogTitle>
          <DialogDescription>
            {t('skillsImport.foundCount', { count: candidates.length })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between min-h-8 border-b border-foreground/10 pb-2">
          <span className="text-xs text-muted-foreground">
            {t('skillsImport.selectedCount', { count: selectedPaths.size })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            semanticId="skills.import.toggle-all"
            onClick={toggleAll}
            disabled={importing}
          >
            {allSelected ? t('skillsImport.deselectAll') : t('skillsImport.selectAll')}
          </Button>
        </div>

        <ScrollArea className="max-h-[min(50vh,420px)] -mx-2 px-2">
          <div className="space-y-3" role="list" aria-label={t('skillsImport.title')}>
            {groups.map(group => {
              const groupSelected = group.candidates.every(candidate => selectedPaths.has(candidate.sourcePath))
              return (
                <section
                  key={group.skillsRoot}
                  className="overflow-hidden rounded-md border border-foreground/10"
                  data-mortise-semantic-kind="skill-import-source"
                  aria-label={`${t('skillsImport.sourceDirectory')}: ${group.skillsRoot}`}
                >
                  <div className="flex min-h-11 items-center gap-3 border-b border-foreground/10 bg-foreground/3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] font-medium text-muted-foreground">
                        {t('skillsImport.sourceDirectory')} · {group.candidates.length}
                      </div>
                      <div className="truncate text-xs font-mono" title={group.skillsRoot}>
                        {group.skillsRoot}
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => toggleGroup(group.candidates)}
                      disabled={importing}
                      aria-label={`${groupSelected ? t('skillsImport.deselectSource') : t('skillsImport.selectSource')}: ${group.skillsRoot}`}
                      data-mortise-semantic-kind="skill-import-source-toggle"
                    >
                      {groupSelected ? t('skillsImport.deselectSource') : t('skillsImport.selectSource')}
                    </Button>
                  </div>

                  <div className="divide-y divide-foreground/8">
                    {group.candidates.map(candidate => {
                      const checked = selectedPaths.has(candidate.sourcePath)
                      return (
                        <label
                          key={candidate.sourcePath}
                          className="flex min-h-14 items-center gap-3 px-3 py-2 cursor-pointer hover:bg-foreground/3"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={importing}
                            onChange={() => toggleCandidate(candidate.sourcePath)}
                            className="size-4 shrink-0 accent-foreground"
                            aria-label={`${candidate.slug}: ${candidate.sourcePath}`}
                            data-mortise-semantic-kind="skill-import-candidate"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">{candidate.slug}</span>
                            <span className="block truncate text-xs text-muted-foreground" title={candidate.sourcePath}>
                              {candidate.sourcePath}
                            </span>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </section>
              )
            })}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            semanticId="skills.import.cancel"
            onClick={() => onOpenChange(false)}
            disabled={importing}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            semanticId="skills.import.confirm"
            disabled={importing || selectedPaths.size === 0}
            onClick={() => void onImport([...selectedPaths])}
          >
            {importing && <Loader2 className="animate-spin" />}
            {t('skillsImport.importSelected', { count: selectedPaths.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
