import { mkdirSync, writeFileSync, rmSync } from "fs"

export async function createFixtureRepo(): Promise<string> {
  const dir = `/tmp/code-stroll-fixture-${Date.now()}`
  mkdirSync(dir, { recursive: true })

  // Init repo
  await Bun.spawn(["git", "init"], { cwd: dir }).exited
  await Bun.spawn(["git", "config", "user.email", "test@test.com"], { cwd: dir }).exited
  await Bun.spawn(["git", "config", "user.name", "Test"], { cwd: dir }).exited

  // Initial commit on main
  writeFileSync(`${dir}/auth.ts`, `export function login(user: string) {\n  return user\n}\n`)
  await Bun.spawn(["git", "add", "."], { cwd: dir }).exited
  await Bun.spawn(["git", "commit", "-m", "initial"], { cwd: dir }).exited

  // Feature branch with changes
  await Bun.spawn(["git", "checkout", "-b", "feat/auth-update"], { cwd: dir }).exited
  writeFileSync(
    `${dir}/auth.ts`,
    `import jwt from 'jsonwebtoken'\n\nexport function login(user: string) {\n  return jwt.sign({ user }, process.env.SECRET!, { expiresIn: '15m' })\n}\n`
  )
  await Bun.spawn(["git", "add", "."], { cwd: dir }).exited
  await Bun.spawn(["git", "commit", "-m", "use jwt"], { cwd: dir }).exited

  // Switch back to main (plugin will create worktree from here)
  await Bun.spawn(["git", "checkout", "main"], { cwd: dir }).exited

  return dir
}

export async function cleanFixtureRepo(dir: string) {
  rmSync(dir, { recursive: true, force: true })
}
