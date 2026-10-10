import { expect, test } from 'claude-code/testing'

test('denies edits to .env files', async ($, on) => {
  let reached = false
  on('tool.call', { tool: 'Edit' }, () => {
    reached = true
    return { result: 'edited' }
  })

  const ran = await $.tool.call({ tool: 'Edit', file_path: 'app/.env', old_string: 'a', new_string: 'b' })

  expect(ran.deny).toContain('.env')
  expect(reached).toBe(false)
})

test('lets other edits through', async ($, on) => {
  on('tool.call', { tool: 'Edit' }, () => ({ result: 'edited' }))

  const ran = await $.tool.call({ tool: 'Edit', file_path: 'src/index.ts', old_string: 'a', new_string: 'b' })

  expect(ran.deny).toBeUndefined()
})
