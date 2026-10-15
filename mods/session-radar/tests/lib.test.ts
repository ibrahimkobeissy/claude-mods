import { expect, test } from 'claude-code/testing'

import { exitTrailer, findPid, parsePs, parseTails, testSummary } from '../hooks/lib'

test('the exit line is read only when it is the whole line', () => {
  expect(exitTrailer('[exited with code 0]')).toBe(0)
  expect(exitTrailer('[exited with code 144]\n')).toBe(144)
  expect(exitTrailer('echo [exited with code 0]')).toBeUndefined()
  expect(exitTrailer(undefined)).toBeUndefined()
})

test('tail output splits by file once there are several', () => {
  expect(parseTails('[exited with code 0]\n', ['/a'])).toEqual(new Map([['/a', '[exited with code 0]']]))
  const two = parseTails('==> /a <==\nstill going\n\n==> /b <==\n[exited with code 2]\n', ['/a', '/b'])
  expect(two.get('/a')).toBe('still going')
  expect(two.get('/b')).toBe('[exited with code 2]')
})

test('the engine-started process is preferred over a lookalike', () => {
  const procs = parsePs(" 10   1 zsh -c eval 'make' < /dev/null\n 20  900 zsh -c eval 'make' < /dev/null\n")
  expect(findPid(procs, 'make', 900, new Set())).toBe(20)
  expect(findPid(procs, 'make', 900, new Set([20]))).toBe(10)
  expect(findPid(procs, 'make test', 900, new Set())).toBeUndefined()
})

test('test runner summaries', () => {
  expect(testSummary([' Test Files  321 passed (321)', '      Tests  3931 passed (3931)'])).toBe('3931 passed · 321 files')
  expect(testSummary(['      Tests  2 failed | 40 passed (42)'])).toBe('2 failed · 40 passed')
  expect(testSummary(['Tests:       1 failed, 9 passed, 10 total'])).toBe('1 failed · 9 passed')
  expect(testSummary(['ℹ tests 31', 'ℹ pass 31', 'ℹ fail 0'])).toBe('31 passed')
  expect(testSummary(['===== 5 passed, 1 skipped in 1.20s =====' ])).toBe('5 passed · 1 skipped')
  expect(testSummary(['hello'])).toBeUndefined()
})
