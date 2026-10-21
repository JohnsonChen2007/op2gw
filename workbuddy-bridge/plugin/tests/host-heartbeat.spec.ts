import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * `processStartTimeMs` imports `execFileSync` from `node:child_process`, whose
 * ESM namespace cannot be spied on. Hoisted module mock: the real module is
 * used everywhere except where a test installs fake output via
 * {@link setWmicOutput}.
 */
const wmic = vi.hoisted(() => ({ output: undefined as string | undefined }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => {
      if (wmic.output !== undefined) return wmic.output
      return (actual.execFileSync as (...a: unknown[]) => unknown)(...args)
    },
  }
})

import {
  clearHostHeartbeat,
  isHeartbeatProcessAlive,
  parseWmiCreationDate,
  processStartTimeMs,
  readHostHeartbeat,
  workbuddyHostHeartbeatPath,
  writeHostHeartbeat,
  WORKBUDDY_HOST_HEARTBEAT_FILENAME,
} from '../src/host-heartbeat.ts'
import { WORKBUDDY_CONNECT_VERSION } from '../src/version.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  wmic.output = undefined
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('host heartbeat', () => {
  it('writes, reads, and clears a heartbeat under $DSH_HOME', async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-heartbeat-'))
    vi.stubEnv('DSH_HOME', root)

    // Before write: absent.
    expect(await readHostHeartbeat()).toBeUndefined()

    await writeHostHeartbeat()

    // After write: present and well-formed.
    const heartbeat = await readHostHeartbeat()
    expect(heartbeat).toBeDefined()
    expect(heartbeat!.package).toBe('dsh-workbuddy-connect')
    expect(heartbeat!.pid).toBe(process.pid)
    expect(typeof heartbeat!.registeredAt).toBe('number')
    expect(heartbeat!.pluginVersion).toBe(WORKBUDDY_CONNECT_VERSION)

    // The file lives at the expected path.
    expect(workbuddyHostHeartbeatPath()).toBe(join(root, WORKBUDDY_HOST_HEARTBEAT_FILENAME))

    // Live PID is detectable.
    expect(isHeartbeatProcessAlive(heartbeat!)).toBe(true)

    // A fake PID that cannot exist is detected as dead.
    const fakeHeartbeat = { ...heartbeat!, pid: 999_999 }
    expect(isHeartbeatProcessAlive(fakeHeartbeat)).toBe(false)

    // Clear removes the file.
    await clearHostHeartbeat()
    expect(await readHostHeartbeat()).toBeUndefined()
  })

  it('detects a recycled PID as dead (registeredAt after this process started)', async () => {
    // The current process started at some point in the past. If a stale
    // heartbeat claims a `registeredAt` that is *older* than this process's
    // own start time, the PID cannot be the original host — it has been
    // recycled by an unrelated process. Even though `kill(pid, 0)` says the
    // PID is alive, the age check must report dead.
    const startAtMs = processStartTimeMs(process.pid)
    expect(startAtMs).toBeDefined()

    // A heartbeat registered *before* this process began (the recycled-PID case).
    const recycled = {
      version: 1 as const,
      package: 'dsh-workbuddy-connect' as const,
      pluginVersion: '0.0.0-test',
      registeredAt: (startAtMs as number) - 60_000, // 1 min before this process started
      pid: process.pid,
    }
    expect(isHeartbeatProcessAlive(recycled)).toBe(false)

    // A heartbeat registered *after* this process started (a genuine host on
    // this very PID) is alive.
    const genuine = { ...recycled, registeredAt: Date.now() }
    expect(isHeartbeatProcessAlive(genuine)).toBe(true)
  })

  it('treats a malformed heartbeat file as absent', async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-heartbeat-malformed-'))
    vi.stubEnv('DSH_HOME', root)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(workbuddyHostHeartbeatPath(), '{ not json', 'utf8')
    expect(await readHostHeartbeat()).toBeUndefined()
  })

  it('rejects a heartbeat with the wrong format version', async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-heartbeat-wrongver-'))
    vi.stubEnv('DSH_HOME', root)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      workbuddyHostHeartbeatPath(),
      JSON.stringify({ version: 99, package: 'dsh-workbuddy-connect', registeredAt: Date.now(), pid: process.pid }),
      'utf8',
    )
    expect(await readHostHeartbeat()).toBeUndefined()
  })
})

describe('parseWmiCreationDate (CIM_DATETIME)', () => {
  /**
   * Windows `wmic` prints `CreationDate` as CIM_DATETIME
   * `yyyymmddHHMMSS.mmmmmmsUUU`: local wall-clock fields plus a 3-digit
   * signed UTC offset **in minutes**. The epoch is the UTC-shifted fields —
   * `+480` (UTC+8) must subtract 480 minutes, which is what the old
   * 4-digit-offset regex never matched and never applied (issue #47).
   */

  it('parses the listed offsets into the correct epoch', () => {
    // Zero offset: fields are already UTC.
    expect(new Date(parseWmiCreationDate('20260923104314.239907+000')!).toISOString())
      .toBe('2026-09-23T10:43:14.000Z')
    // UTC+8: local 10:43:14 is 02:43:14Z.
    expect(new Date(parseWmiCreationDate('20260923104314.239907+480')!).toISOString())
      .toBe('2026-09-23T02:43:14.000Z')
    // UTC+5:30 (India): 10:43:14 − 5h30m.
    expect(new Date(parseWmiCreationDate('20260923104314.239907+330')!).toISOString())
      .toBe('2026-09-23T05:13:14.000Z')
    // UTC−5: 10:43:14 + 5h.
    expect(new Date(parseWmiCreationDate('20260923104314.239907-300')!).toISOString())
      .toBe('2026-09-23T15:43:14.000Z')
    // Extreme offsets cross the day boundary and stay finite.
    expect(new Date(parseWmiCreationDate('20260923104314.239907+840')!).toISOString())
      .toBe('2026-09-22T20:43:14.000Z')
    expect(new Date(parseWmiCreationDate('20260923104314.239907-720')!).toISOString())
      .toBe('2026-09-23T22:43:14.000Z')
  })

  it('rejects malformed input and 4-digit offsets instead of partially matching', () => {
    expect(parseWmiCreationDate('')).toBeUndefined()
    expect(parseWmiCreationDate('garbage')).toBeUndefined()
    expect(parseWmiCreationDate('20260923104314')).toBeUndefined()
    expect(parseWmiCreationDate('20260923104314.239907')).toBeUndefined()
    expect(parseWmiCreationDate('20260923104314.239907+48')).toBeUndefined()
    // A 4-digit offset is not the CIM format; matching its first three digits
    // would silently compute a wrong epoch.
    expect(parseWmiCreationDate('20260923104314.239907+4800')).toBeUndefined()
    expect(parseWmiCreationDate('20260923104314.239907-3000')).toBeUndefined()
    // Date parts that Date.UTC would silently roll over are malformed too.
    expect(parseWmiCreationDate('20261323104314.239907+000')).toBeUndefined()
    expect(parseWmiCreationDate('20260932104314.239907+000')).toBeUndefined()
    expect(parseWmiCreationDate('20260923254314.239907+000')).toBeUndefined()
  })
})

describe('processStartTimeMs wmic token extraction (production path)', () => {
  /**
   * The production branch looks up its own datetime token in `wmic` output
   * before handing it to {@link parseWmiCreationDate}. That extraction step is
   * a second, independent chance to partially match: a bare
   * `(\d{14})\.(\d+)([+-]\d{3})` would cut `...+4800` down to `...+480`, which
   * then sails through the strict parser as a *valid* token and produces a
   * wrong epoch. The parser-level tests above cannot catch that, because they
   * never see the truncated string. These tests drive the real win32 branch
   * with stubbed `wmic` output.
   */

  /** Real wmic output: a `CreationDate` header, the value, then a blank line. */
  const wmicOutput = (value: string): string => `CreationDate\n${value}\n\n`

  /**
   * Drive the real win32 branch: fake the platform, and let the hoisted
   * `node:child_process` mock hand `processStartTimeMs` this output.
   */
  function withWindowsWmic(output: string, run: () => void): void {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    wmic.output = output
    run()
  }

  it('parses the real UTC+8 wmic value into the correct epoch', () => {
    withWindowsWmic(wmicOutput('20260923104314.239907+480'), () => {
      // 10:43:14 local at UTC+8 is 02:43:14Z; the offset must be subtracted.
      expect(new Date(processStartTimeMs(1234)!).toISOString()).toBe('2026-09-23T02:43:14.000Z')
    })
  })

  it('returns undefined for a 4-digit offset instead of matching its first 3 digits', () => {
    withWindowsWmic(wmicOutput('20260923104314.239907+4800'), () => {
      // Must degrade to the PID-only fallback, not report a truncated `+480`
      // epoch that would look trustworthy to the recycled-PID guard.
      expect(processStartTimeMs(1234)).toBeUndefined()
    })
  })

  it('returns undefined when wmic prints no datetime token at all', () => {
    withWindowsWmic('CreationDate\n\n\n', () => {
      expect(processStartTimeMs(1234)).toBeUndefined()
    })
  })
})
