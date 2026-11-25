/**
 * Grouping and filtering for the project grid on Welcome.
 *
 * A group is just a label on a project ("" = ungrouped), so the set of groups
 * is whatever the projects name. Group names are compared case-insensitively —
 * "chaoticcommits" and "ChaoticCommits" are the same group — and the first
 * spelling seen (newest project first) is the one shown.
 */
import type { ProjectGroup, ProjectSummary } from './api/types'

/** Which projects the grid shows. */
export type GroupFilter =
  | { kind: 'all' }
  | { kind: 'ungrouped' }
  | { kind: 'group'; name: string }

export const ALL_PROJECTS: GroupFilter = { kind: 'all' }

export function groupOf(project: ProjectSummary): string {
  return (project.group ?? '').trim()
}

export function sameGroup(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase()
}

/** Every group in use, alphabetical, with how many projects each holds. */
export function groupsOf(projects: ProjectSummary[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>()
  for (const project of projects) {
    const name = groupOf(project)
    if (!name) continue
    const existing = groups.get(name.toLocaleLowerCase())
    if (existing) existing.count += 1
    else groups.set(name.toLocaleLowerCase(), { name, count: 1 })
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

export function ungroupedCount(projects: ProjectSummary[]): number {
  return projects.filter((p) => !groupOf(p)).length
}

export function filterProjects(projects: ProjectSummary[], filter: GroupFilter): ProjectSummary[] {
  if (filter.kind === 'all') return projects
  if (filter.kind === 'ungrouped') return projects.filter((p) => !groupOf(p))
  return projects.filter((p) => groupOf(p) && sameGroup(groupOf(p), filter.name))
}

/** Heading for the grid under the current filter. */
export function filterLabel(filter: GroupFilter): string {
  if (filter.kind === 'all') return 'All projects'
  if (filter.kind === 'ungrouped') return 'Ungrouped'
  return filter.name
}

/**
 * The filter to show after projects change — a group that no longer has any
 * projects (its last one was deleted or moved) falls back to all projects.
 */
export function resolveFilter(projects: ProjectSummary[], filter: GroupFilter): GroupFilter {
  if (filter.kind === 'group' && !filterProjects(projects, filter).length) return ALL_PROJECTS
  if (filter.kind === 'ungrouped' && !ungroupedCount(projects)) return ALL_PROJECTS
  return filter
}
