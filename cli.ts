import { installFromPackageJSON } from './core'
import path from 'path'
import os from 'os'

let storeDir = path.join(os.homedir(), '.snpm-store')
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
  console.log(`${name} v${version}`)
}

let start = Date.now()
installFromPackageJSON({
  storeDir,
  cwd,
  dev,
})
  .then(() => {
    let end = Date.now()
    let used = end - start
    console.log(`Installation finished, used ${formatDuration(used)}.`)
  })
  .catch(err => console.log('Installation failed:', err))

function formatDuration(time: number): string {
  if (time < 1000) {
    return time + ' ms'
  }
  if (time < 1000 * 60) {
    return (time / 1000).toFixed(1) + ' sec'
  }
  return (time / 1000 / 60).toFixed(1) + ' min'
}
