import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HermesReadDirResult } from '@/global'
import { I18nProvider } from '@/i18n'
import type { DesktopFsRemotePicker } from '@/lib/desktop-fs'

import { filterFolderEntries, RemoteFolderPicker } from './remote-picker'

const readDesktopDir = vi.fn<(path: string) => Promise<HermesReadDirResult>>()

let picker: DesktopFsRemotePicker | null = null

vi.mock('@/lib/desktop-fs', () => ({
  readDesktopDir: (path: string) => readDesktopDir(path),
  setDesktopFsRemotePicker: (next: DesktopFsRemotePicker | null) => {
    picker = next
  }
}))

const HOME_ENTRIES = [
  { name: 'project-alpha', path: '/home/user/project-alpha', isDirectory: true },
  { name: 'project-beta', path: '/home/user/project-beta', isDirectory: true },
  { name: '.config', path: '/home/user/.config', isDirectory: true },
  // Files are dropped by the picker — included so the filter never sees them.
  { name: 'project-notes.txt', path: '/home/user/project-notes.txt', isDirectory: false }
]

function renderPicker() {
  render(
    <I18nProvider configClient={null}>
      <RemoteFolderPicker />
    </I18nProvider>
  )
}

async function openPicker() {
  expect(picker).not.toBeNull()

  let selection: Promise<string[]> | undefined

  await act(async () => {
    selection = picker!.selectPaths({ defaultPath: '/home/user' })
    // Let the pending readDesktopDir resolve and paint.
    await Promise.resolve()
  })

  // The picker stays open; the selection promise settles on close/cancel.
  void selection
}

describe('filterFolderEntries', () => {
  const entries = [{ name: 'project-alpha' }, { name: '.config' }, { name: 'Downloads' }]

  it('returns every entry for a blank query', () => {
    expect(filterFolderEntries(entries, '')).toBe(entries)
    expect(filterFolderEntries(entries, '   ')).toBe(entries)
  })

  it('matches case-insensitive substrings of the folder name', () => {
    expect(filterFolderEntries(entries, 'PROJECT').map(e => e.name)).toEqual(['project-alpha'])
    expect(filterFolderEntries(entries, 'o').map(e => e.name)).toEqual(['project-alpha', '.config', 'Downloads'])
  })

  it('trims the query before matching', () => {
    expect(filterFolderEntries(entries, '  config ').map(e => e.name)).toEqual(['.config'])
  })

  it('returns an empty list when nothing matches', () => {
    expect(filterFolderEntries(entries, 'zzz')).toEqual([])
  })
})

describe('RemoteFolderPicker search', () => {
  beforeEach(() => {
    picker = null
    readDesktopDir.mockReset()
    readDesktopDir.mockImplementation((path: string) =>
      Promise.resolve({
        entries:
          path === '/home/user'
            ? HOME_ENTRIES
            : [{ name: 'src', path: '/home/user/project-alpha/src', isDirectory: true }]
      })
    )
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('filters the folder rows as the query is typed', async () => {
    renderPicker()
    await openPicker()

    // Initial listing: the ".." row plus the three directories (file hidden).
    expect(await screen.findByText('project-alpha')).toBeTruthy()
    expect(screen.getByText('.config')).toBeTruthy()
    expect(screen.queryByText('project-notes.txt')).toBeNull()

    fireEvent.change(screen.getByPlaceholderText('Search folders…'), { target: { value: 'beta' } })

    expect(screen.queryByText('project-alpha')).toBeNull()
    expect(screen.getByText('project-beta')).toBeTruthy()
    expect(screen.queryByText('.config')).toBeNull()
    // The parent-navigation row is not filtered away.
    expect(screen.getByText('..')).toBeTruthy()
  })

  it('shows a dedicated empty state when the filter matches nothing', async () => {
    renderPicker()
    await openPicker()

    fireEvent.change(screen.getByPlaceholderText('Search folders…'), { target: { value: 'zzz' } })

    expect(screen.getByText('No folders match your search.')).toBeTruthy()
    expect(screen.queryByText('This folder is empty.')).toBeNull()
  })

  it('clears the query on the first Escape instead of closing the dialog', async () => {
    renderPicker()
    await openPicker()

    const input = screen.getByPlaceholderText('Search folders…')
    fireEvent.change(input, { target: { value: 'beta' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect((input as HTMLInputElement).value).toBe('')
    // All rows are back and the dialog is still open.
    expect(await screen.findByText('project-alpha')).toBeTruthy()
    expect(screen.getByText('Select folder')).toBeTruthy()
  })

  it('resets the query when navigating into a folder', async () => {
    renderPicker()
    await openPicker()

    const input = screen.getByPlaceholderText('Search folders…')
    fireEvent.change(input, { target: { value: 'beta' } })

    fireEvent.click(await screen.findByText('project-beta'))
    await screen.findByText('src')

    expect((input as HTMLInputElement).value).toBe('')
    expect(screen.queryByText('project-alpha')).toBeNull()
  })
})
