#!/usr/bin/env node

import path from 'path'
import os from 'os'
import { main } from './core'

let storeDir = path.join(os.homedir(), '.slnpm-store')
let cwd = '.'
let dev = true
let verbose = false

for (let i = 2; i < process.argv.length; i++) {
  let arg = process.argv[i]
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
    case '--version':
      showVersion()
      process.exit(0)
    case '--help':
      printHelp()
      process.exit(0)
    default:
      console.error('Error: unknown argument:', arg)
      process.exit(1)
  }
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
Usage: ${name} [options]

Available options:

  --prod
    only install packages in dependencies of package.json
    (default false)

  --dev
    install packages in both dependencies and devDependencies of package.json
    (default true)

  --store-dir <path-to-cache-store>
    customize location of cache store, default to ~/.snpm-store

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
`.trim(),
  )
}

let start = Date.now()
try {
  main({ storeDir, cwd, dev, verbose })
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
