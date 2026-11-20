import { describe, expect, it } from 'vitest'
import type { ProjectSummary } from './api/types'
import {
  ALL_PROJECTS, filterLabel, filterProjects, groupOf, groupsOf, resolveFilter, sameGroup, ungroupedCount,
} from './projectGroups'

function project(name: string, group: string): ProjectSummary {
  return {
    id: name, name, group, status: 'ready', created_at: '2026-01-01T00:00:00Z',
    source: 'upload', project_type: 'video',
  }
}

const projects = [
  project('Ep 2', 'chaoticcommits'),
  project('Ep 1', 'ChaoticCommits'), // same group, different spelling
  project('Zine talk', 'Zine'),
  project('Loose end', ''),
  project('Whitespace', '  '),
]

describe('groupOf', () => {
  it('trims and treats blank as ungrouped', () => {
    expect(groupOf(project('a', '  chaoticcommits '))).toBe('chaoticcommits')
    expect(groupOf(project('a', '  '))).toBe('')
    expect(groupOf({ ...project('a', ''), group: undefined as unknown as string })).toBe('')
  })
})

describe('sameGroup', () => {
  it('ignores case and surrounding space', () => {
    expect(sameGroup('ChaoticCommits', ' chaoticcommits ')).toBe(true)
    expect(sameGroup('Zine', 'Zines')).toBe(false)
  })
})

describe('groupsOf', () => {
  it('lists each group once, alphabetically, with counts', () => {
    expect(groupsOf(projects)).toEqual([
      { name: 'chaoticcommits', count: 2 },
      { name: 'Zine', count: 1 },
    ])
  })

  it('is empty when nothing is grouped', () => {
    expect(groupsOf([project('a', ''), project('b', ' ')])).toEqual([])
  })
})

describe('ungroupedCount', () => {
  it('counts projects with no group', () => {
    expect(ungroupedCount(projects)).toBe(2)
  })
})

describe('filterProjects', () => {
  it('returns everything for all', () => {
    expect(filterProjects(projects, ALL_PROJECTS)).toHaveLength(5)
  })

  it('matches a group regardless of case', () => {
    expect(filterProjects(projects, { kind: 'group', name: 'CHAOTICCOMMITS' }).map((p) => p.name))
      .toEqual(['Ep 2', 'Ep 1'])
  })

  it('returns only ungrouped projects for ungrouped', () => {
    expect(filterProjects(projects, { kind: 'ungrouped' }).map((p) => p.name)).toEqual(['Loose end', 'Whitespace'])
  })
})

describe('filterLabel', () => {
  it('names the current view', () => {
    expect(filterLabel(ALL_PROJECTS)).toBe('All projects')
    expect(filterLabel({ kind: 'ungrouped' })).toBe('Ungrouped')
    expect(filterLabel({ kind: 'group', name: 'Zine' })).toBe('Zine')
  })
})

describe('resolveFilter', () => {
  it('keeps a filter that still has projects', () => {
    const filter = { kind: 'group', name: 'Zine' } as const
    expect(resolveFilter(projects, filter)).toBe(filter)
    expect(resolveFilter(projects, { kind: 'ungrouped' })).toEqual({ kind: 'ungrouped' })
    expect(resolveFilter([], ALL_PROJECTS)).toBe(ALL_PROJECTS)
  })

  it('falls back to all projects when the group or ungrouped view empties', () => {
    expect(resolveFilter([project('a', 'Other')], { kind: 'group', name: 'Zine' })).toEqual(ALL_PROJECTS)
    expect(resolveFilter([project('a', 'Other')], { kind: 'ungrouped' })).toEqual(ALL_PROJECTS)
  })
})
