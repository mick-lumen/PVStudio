import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

export const protectedShellFilename = 'pvstudio-shell.html'

export function createProtectedShell(indexHtml: string): string {
  if (indexHtml.includes('data-auth-pending') && indexHtml.includes("fetch('/__pvstudio_auth'")) {
    return indexHtml
  }

  const moduleScriptPattern = /<script type="module" crossorigin src="([^"]+)"><\/script>/
  const modulePath = indexHtml.match(moduleScriptPattern)?.[1]
  if (modulePath === undefined) {
    throw new Error('Unable to find the production application module in index.html')
  }

  const pendingStyle = '<style>html[data-auth-pending] body{visibility:hidden}</style>'
  const authenticatedModule = `<script type="module">
const response = await fetch('/__pvstudio_auth', { credentials: 'same-origin', cache: 'no-store' })
if (response.ok) {
  await import(${JSON.stringify(modulePath)})
  document.documentElement.removeAttribute('data-auth-pending')
}
</script>`

  return indexHtml
    .replace('<html lang="en">', '<html lang="en" data-auth-pending>')
    .replace('</head>', `${pendingStyle}</head>`)
    .replace(moduleScriptPattern, authenticatedModule)
}

export function sites(): Plugin {
  let root = process.cwd()

  return {
    name: 'sites',
    apply: 'build',
    configResolved(config) {
      root = config.root
    },
    async closeBundle() {
      const outputDirectory = resolve(root, 'dist', '.openai')
      const hostingConfig = resolve(root, '.openai', 'hosting.json')
      const uncompressedSample = resolve(root, 'dist', 'client', 'test-data', 'synthetic-webodm-house', 'synthetic-webodm-house.obj')
      const clientIndex = resolve(root, 'dist', 'client', 'index.html')
      const protectedShell = resolve(root, 'dist', 'client', protectedShellFilename)

      await rm(outputDirectory, { recursive: true, force: true })
      await rm(uncompressedSample, { force: true })
      await mkdir(outputDirectory, { recursive: true })

      if (await exists(hostingConfig)) {
        await cp(hostingConfig, resolve(outputDirectory, 'hosting.json'))
      }

      if (await exists(clientIndex)) {
        const indexHtml = await readFile(clientIndex, 'utf8')
        const protectedHtml = createProtectedShell(indexHtml)
        await writeFile(clientIndex, protectedHtml, 'utf8')
        await writeFile(protectedShell, protectedHtml, 'utf8')
      }
    },
  }
}
