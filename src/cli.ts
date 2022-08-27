#!/usr/bin/env node

import path from 'path'
import os from 'os'
import { installPackageDir, Store } from './cache'

let storeDir = path.join(os.homedir(), '.slnpm-store')
let cwd = '.'
let dev = true

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
    case '--help':
      printHelp()
      process.exit(0)
    default:
      console.error('Error: unknown argument:', arg)
      process.exit(1)
  }
}

function printHelp() {
  let { name, version } = require('./package.json')
  console.log(
    `
${name} v${version}

Usage: ${name} [options]

Available options:

  --prod
    only install packages in dependencies of package.json

  --dev
    install packages in both dependencies and devDependencies of package.json

  --store-dir <path-to-cache-store>
    customize location of cache store, default to ~/.snpm-store

  --help
    show ${name} version and help message
`.trim(),
  )
}

let start = Date.now()
let store = new Store({
  storeDir,
})
installPackageDir(
  store,
  {
    cwd,
    dev,
  },
  err => {
    if (err) {
      console.log()
      console.error('Installation failed:', err)
      process.exit(1)
    }
    let end = Date.now()
    let used = end - start
    console.log()
    console.log(`Installation finished, used ${formatDuration(used)}.`)
  },
)

function formatDuration(time: number): string {
  if (time < 1000) {
    return time + ' ms'
  }
  if (time < 1000 * 60) {
    return (time / 1000).toFixed(1) + ' sec'
  }
  return (time / 1000 / 60).toFixed(1) + ' min'
}
