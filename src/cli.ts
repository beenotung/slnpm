#!/usr/bin/env node

import path from 'path'
import os from 'os'
import { main } from './core'

let storeDir = path.join(os.homedir(), '.slnpm-store')
let cwd = '.'
let dev = true
let verbose = false
let installDeps: string[] = []
let installDevDeps: string[] = []
let uninstallDeps: string[] = []

let mode: 'install' | 'uninstall' | 'default' | null = null
let installTarget: 'deps' | 'devDeps' = 'deps'

for (let i = 2; i < process.argv.length; i++) {
  let arg = process.argv[i]
  if (!mode) {
    switch (arg) {
      case 'install':
      case 'i':
      case 'add':
      case 'a':
        mode = 'install'
        continue
      case 'uninstall':
      case 'u':
      case 'remove':
      case 'r':
        mode = 'uninstall'
        continue
      default:
        mode = 'default'
    }
  }
  switch (arg) {
    case '--dev':
      dev = true
      break
    case '--prod':
      dev = false
      break
    case '--store-dir':
      i++
      storeDir = process.argv[i]
      if (!storeDir) {
        console.error('Error: missing directory after "--store-dir" argument')
        process.exit(1)
      }
      break
    case '--verbose':
      verbose = true
      break
    case '--quiet':
      verbose = false
      break
    case '-D':
    case '--save-dev':
      installTarget = 'devDeps'
      dev = true
      break
    case '--version':
      showVersion()
      process.exit(0)
    case '--help':
      printHelp()
      process.exit(0)
    default: {
      if (mode === 'default' || arg[0] === '-') {
        let name = showVersion()
        console.error('Error: unknown argument:', arg)
        console.error(`You can run '${name} --help' to see help messages.`)
        process.exit(1)
      }
      switch (mode) {
        default:
          console.error('Error: unknown mode:', mode)
          process.exit(1)
        case 'uninstall':
          uninstallDeps.push(arg)
          break
        case 'install':
          switch (installTarget) {
            case 'deps':
              installDeps.push(arg)
              break
            case 'devDeps':
              installDevDeps.push(arg)
              break
            default:
              console.error('Error: unknown install target:', mode)
              process.exit(1)
          }
      }
    }
  }
}

// fallback handle for tailing -D flag
if (installTarget === 'devDeps' && installDevDeps.length === 0) {
  installDevDeps = installDeps
  installDeps = []
}

function showVersion() {
  let { name, version } = require('../package.json')
  console.log(`${name} ${version}`)
  return name
}

function printHelp() {
  let name = showVersion()
  console.log()
  console.log(
    `
## Default Mode

This mode installs existing dependencies (and devDependencies) specified in the package.json

Usage: ${name} [options]

Example: ${name}
Example: ${name} --verbose
Example: ${name} --store-dir /data/.slnpm-store --prod

Available options:

  --prod
    only install packages in dependencies of package.json
    (default false)

  --dev
    install packages in both dependencies and devDependencies of package.json
    (default true)

  --store-dir <path-to-cache-store>
    customize location of cache store
    (default to ~/.slnpm-store)

  --recursive | -r
    run installation recursively in every package found in sub-directories
    (default false)

  --verbose
    print installed package name and versions
    (default false)

  --quiet
    do not print install package name and versions
    (default true)

  --help
    show ${name} version and help message

  --version
    show ${name} version


## Install Mode

This mode installs specified packages and save to dependencies or devDependencies

Usage: ${name} install [options] [...packages]

Alias for install: add, i, a

Example: ${name} install tar
Example: ${name} i node-fetch@2 -D @types/node-fetch@2
Example: ${name} i -D typescript @types/node ts-node

Available options:

  --save-dev | -D
    install the packages as devDependencies


## Uninstall Mode

This mode uninstalls specified packages and remove from dependencies and devDependencies

Usage: ${name} uninstall [...packages]

Alias for uninstall: remove, u, r

Example: ${name} uninstall tar
Example: ${name} u ts-node node-fetch @types/node-fetch

`.trim(),
  )
}

let start = Date.now()
try {
  main({
    storeDir,
    cwd,
    dev,
    verbose,
    installDeps,
    installDevDeps,
    uninstallDeps,
  })
  let end = Date.now()
  let used = end - start
  console.log()
  console.log(`Installation finished, used ${formatDuration(used)}.`)
} catch (error) {
  console.log()
  console.error('Installation failed:', error)
  process.exit(1)
}

function formatDuration(time: number): string {
  if (time < 1000) {
    return time + ' ms'
  }
  if (time < 1000 * 60) {
    return (time / 1000).toFixed(1) + ' sec'
  }
  return (time / 1000 / 60).toFixed(1) + ' min'
}
