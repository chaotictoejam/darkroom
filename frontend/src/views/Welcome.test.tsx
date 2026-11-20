import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, ProjectSummary } from '../api/types'
import Welcome from './Welcome'

vi.mock('../api/client', () => ({
  api: {
    listProjects: vi.fn(),
    getProject: vi.fn(),
    createProject: vi.fn(),
    patchProject: vi.fn(),
    deleteProject: vi.fn(),
    renameGroup: vi.fn(),
    ungroupGroup: vi.fn(),
  },
}))
const { api } = await import('../api/client')

function summary(name: string, group: string, extra: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: name.toLowerCase().replace(/\W/g, ''), name, group, status: 'ready',
    created_at: '2026-01-02T00:00:00Z', source: 'upload', project_type: 'video', ...extra,
  }
}

const projects = [
  summary('Commits 12', 'chaoticcommits'),
  summary('Commits 11', 'chaoticcommits'),
  summary('Zine chat', 'Zine', { project_type: 'podcast', source: 'record' }),
  summary('Loose end', ''),
]

function renderWelcome(list = projects) {
  vi.mocked(api.listProjects).mockResolvedValue(list)
  const onOpenProject = vi.fn()
  const onNewProject = vi.fn()
  render(<Welcome onNewProject={onNewProject} onOpenProject={onOpenProject} />)
  return { onOpenProject, onNewProject }
}

/** fireEvent wrappers: clicking and typing both trigger async state updates. */
function click(element: Element) {
  fireEvent.click(element)
}

function type(element: Element, value: string) {
  fireEvent.change(element, { target: { value } })
}

beforeEach(() => vi.clearAllMocks())

describe('Welcome project grid', () => {
  it('shows every project with its group, and opens one on click', async () => {
    const { onOpenProject } = renderWelcome()

    await screen.findByText('Commits 12')
    expect(screen.getByRole('heading', { name: 'All projects' })).toBeTruthy()
    expect(screen.getByText('4 projects')).toBeTruthy()
    // Group chips: one per group in use, plus All and Ungrouped
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'All projects 4', 'chaoticcommits 2', 'Zine 1', 'Ungrouped 1',
    ])

    const opened = { id: 'commits12', name: 'Commits 12' } as Project
    vi.mocked(api.getProject).mockResolvedValue(opened)
    click(screen.getByRole('button', { name: 'Open Commits 12' }))
    await waitFor(() => expect(onOpenProject).toHaveBeenCalledWith(opened))
  })

  it('filters the grid to the chosen group', async () => {
    renderWelcome()
    await screen.findByText('Commits 12')

    click(screen.getByRole('tab', { name: /chaoticcommits/ }))
    expect(screen.getByRole('heading', { name: 'chaoticcommits' })).toBeTruthy()
    expect(screen.getByText('2 projects')).toBeTruthy()
    expect(screen.queryByText('Loose end')).toBeNull()

    click(screen.getByRole('tab', { name: /Ungrouped/ }))
    expect(screen.getByText('Loose end')).toBeTruthy()
    expect(screen.queryByText('Commits 12')).toBeNull()
  })

  it('hides the chips when nothing is grouped', async () => {
    renderWelcome([summary('Loose end', '')])
    await screen.findByText('Loose end')
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
  })

  it('says when there are no projects', async () => {
    renderWelcome([])
    expect(await screen.findByText('No projects yet.')).toBeTruthy()
  })
})

describe('moving a project between groups', () => {
  it('files it under an existing group', async () => {
    renderWelcome()
    await screen.findByText('Loose end')
    vi.mocked(api.patchProject).mockResolvedValue({} as Project)

    click(screen.getByRole('button', { name: 'Move Loose end to a group' }))
    const dialog = screen.getByRole('dialog', { name: /Group .*Loose end/ })
    click(within(dialog).getByRole('button', { name: /chaoticcommits/ }))

    expect(api.patchProject).toHaveBeenCalledWith('looseend', { group: 'chaoticcommits' })
    await waitFor(() => expect(screen.getAllByRole('tab')[1].textContent).toBe('chaoticcommits 3'))
  })

  it('creates a new group for it', async () => {
    renderWelcome()
    await screen.findByText('Loose end')
    vi.mocked(api.patchProject).mockResolvedValue({} as Project)

    click(screen.getByRole('button', { name: 'Move Loose end to a group' }))
    type(screen.getByLabelText('New group name'), '  side quests  ')
    click(screen.getByRole('button', { name: 'Create' }))

    expect(api.patchProject).toHaveBeenCalledWith('looseend', { group: 'side quests' })
    await waitFor(() => expect(screen.getByRole('tab', { name: /side quests/ })).toBeTruthy())
  })

  it('takes it out of its group', async () => {
    renderWelcome()
    await screen.findByText('Zine chat')
    vi.mocked(api.patchProject).mockResolvedValue({} as Project)

    click(screen.getByRole('button', { name: 'Move Zine chat to a group' }))
    click(screen.getByRole('button', { name: 'No group' }))

    expect(api.patchProject).toHaveBeenCalledWith('zinechat', { group: '' })
    await waitFor(() => expect(screen.queryByRole('tab', { name: /Zine/ })).toBeNull())
  })

  it('can be cancelled', async () => {
    renderWelcome()
    await screen.findByText('Loose end')

    click(screen.getByRole('button', { name: 'Move Loose end to a group' }))
    click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.patchProject).not.toHaveBeenCalled()
  })
})

describe('group actions', () => {
  it('renames a group and keeps it selected', async () => {
    renderWelcome()
    await screen.findByText('Zine chat')

    click(screen.getByRole('tab', { name: /Zine/ }))
    vi.mocked(api.renameGroup).mockResolvedValue({ moved: 1, groups: [] })
    vi.mocked(api.listProjects).mockResolvedValue([
      summary('Zine chat', 'Zine Club'), ...projects.filter((p) => p.name !== 'Zine chat'),
    ])

    click(screen.getByRole('button', { name: 'Rename group' }))
    const input = screen.getByLabelText('Group name')
        type(input, 'Zine Club')
    click(screen.getByRole('button', { name: 'Rename' }))

    expect(api.renameGroup).toHaveBeenCalledWith('Zine', 'Zine Club')
    expect(await screen.findByRole('heading', { name: 'Zine Club' })).toBeTruthy()
  })

  it('empties a group after confirming, keeping the projects', async () => {
    renderWelcome()
    await screen.findByText('Zine chat')

    click(screen.getByRole('tab', { name: /Zine/ }))
    vi.mocked(api.ungroupGroup).mockResolvedValue({ moved: 1, groups: [] })
    vi.mocked(api.listProjects).mockResolvedValue([
      summary('Zine chat', ''), ...projects.filter((p) => p.name !== 'Zine chat'),
    ])

    click(screen.getByRole('button', { name: 'Empty group' }))
    click(within(screen.getByRole('dialog', { name: 'Empty group?' })).getByRole('button', { name: 'Empty group' }))

    expect(api.ungroupGroup).toHaveBeenCalledWith('Zine')
    expect(await screen.findByRole('heading', { name: 'All projects' })).toBeTruthy()
    expect(screen.getByText('Zine chat')).toBeTruthy()
  })

  it('falls back to all projects when the open group is emptied by a delete', async () => {
    renderWelcome()
    await screen.findByText('Zine chat')
    vi.mocked(api.deleteProject).mockResolvedValue({ ok: true })

    click(screen.getByRole('tab', { name: /Zine/ }))
    click(screen.getByRole('button', { name: 'Delete Zine chat' }))
    click(within(screen.getByRole('dialog', { name: 'Delete project?' })).getByRole('button', { name: 'Delete' }))

    expect(api.deleteProject).toHaveBeenCalledWith('zinechat')
    expect(await screen.findByRole('heading', { name: 'All projects' })).toBeTruthy()
  })
})

describe('new project', () => {
  it('creates it in the group that is open', async () => {
    const { onNewProject } = renderWelcome()
    await screen.findByText('Commits 12')

    click(screen.getByRole('tab', { name: /chaoticcommits/ }))
    click(screen.getByRole('button', { name: '+ New Project' }))
    const created = { id: 'new', name: 'Commits 13' } as Project
    vi.mocked(api.createProject).mockResolvedValue(created)

    type(screen.getByLabelText(/^Name/), 'Commits 13')
    click(screen.getByRole('button', { name: /Upload/ }))

    expect(api.createProject).toHaveBeenCalledWith('Commits 13', 'video', 'upload', 'chaoticcommits')
    await waitFor(() => expect(onNewProject).toHaveBeenCalledWith(created))
  })

  it('lets the group be changed or left blank', async () => {
    renderWelcome()
    await screen.findByText('Commits 12')

    click(screen.getByRole('button', { name: '+ New Project' }))
    vi.mocked(api.createProject).mockResolvedValue({ id: 'new' } as Project)
    type(screen.getByLabelText(/^Group/), 'Zine')
    click(screen.getByRole('button', { name: /Record/ }))
    click(screen.getByRole('button', { name: /Audio only/ }))

    expect(api.createProject).toHaveBeenCalledWith('Untitled Project', 'podcast', 'record', 'Zine')
  })
})
