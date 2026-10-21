import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { workBuddyWindowsDiscoveryTools } from '../src/desktop-credential-protection.ts'

type RegistryFailure = Error & { code: number, killed?: boolean }

function registryFailure(stderr: string, killed = false): void {
  execFileMock.mockImplementation((
    _binary: string,
    _args: string[],
    _options: object,
    callback: (error: RegistryFailure, stdout: string, stderr: string) => void,
  ) => {
    const child = new EventEmitter()
    const error = Object.assign(new Error('reg query failed'), { code: 1, killed })
    queueMicrotask(() => {
      callback(error, '', stderr)
      child.emit('close')
    })
    return child
  })
}

afterEach(() => {
  vi.unstubAllEnvs()
  execFileMock.mockReset()
})

describe('Windows registry query failure classification', () => {
  it.each([
    'ERROR: The system was unable to find the specified registry key or value.',
    '错误: 系统找不到指定的注册表项或值。',
  ])('treats a confirmed missing key as an empty result: %s', async stderr => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    registryFailure(stderr)
    await expect(workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Missing', new AbortController().signal))
      .resolves.toBe('')
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['access denied', 'ERROR: Access is denied.', false],
    ['unknown diagnostic', 'ERROR: registry query failed.', false],
    ['killed query', 'ERROR: The system was unable to find the specified registry key or value.', true],
  ])('keeps %s incomplete even when reg.exe returns code 1', async (_label, stderr, killed) => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    registryFailure(stderr, killed)
    await expect(workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKLM\\Uninstall', new AbortController().signal))
      .rejects.toThrow(/could not complete/)
  })
})
