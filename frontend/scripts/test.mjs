// Runs the frontend test suite through tsx with the app tsconfig loaded.
//
// npm scripts cannot set an environment variable portably (Windows cmd has no
// `VAR=value cmd` syntax) and tsx skips the frontend's solution-style
// tsconfig.json, so the launcher points TSX_TSCONFIG_PATH at tsconfig.app.json
// — that is where the `@/*` path alias and the automatic JSX runtime live.
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const child = spawn(
  process.execPath,
  ['--import', 'tsx', '--test', '--test-force-exit', 'src/**/*.test.{ts,tsx}'],
  {
    cwd: root,
    env: { ...process.env, TSX_TSCONFIG_PATH: 'tsconfig.app.json' },
    stdio: 'inherit',
  },
)
child.on('exit', (code) => process.exit(code ?? 0))
