import { installFromPackageJSON } from './core'

let storeDir = 'snpm-store'
let cwd = 'example'
let dev = true

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
