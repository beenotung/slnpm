import fetch, { Response } from 'node-fetch'
import fs from 'fs/promises'
import path from 'path'
import zlib from 'zlib'
import tar from 'tar'

type PackageInfo = {
  _id: string // same as name
  _rev: string // revision (version id)
  name: string
  'dist-tags': {
    [tag: string]: string // version, e.g. { latest: "2.4.0" }
  }
  versions: {
    [version: string]: {
      dist: {
        tarball: string // download url
      }
    }
  }
}

type Dependencies = {
  // package name -> version
  [name: string]: string
}

type PackageJSON = {
  dependencies: Dependencies
  devDependencies: Dependencies
}

function getPackageInfo(packageName: string): Promise<PackageInfo> {
  let url = `https://registry.npmjs.org/${packageName}`
  // deepcode ignore PromiseNotCaughtGeneral: should be handled by the caller
  return fetch(url).then(getJSON)
}

function getJSON(res: Response) {
  return res.json()
}

type Context = {
  storeDir: string
  dev: boolean
  // package name -> versions
  onDiskPackages: Map<string, Set<string>>
  // packageName@versionRange
  hotPackages: Set<string>
}

function getContextPackageVersions(
  packages: Context['onDiskPackages'],
  packageName: string,
) {
  let versions = packages.get(packageName)
  if (versions) {
    return versions
  }
  versions = new Set()
  packages.set(packageName, versions)
  return versions
}

function installPackage(
  context: Context,
  packageDir: string,
  packageName: string,
  versionRange: string,
) {
  let nodeModulesDir = path.join(packageDir, 'node_modules')
  return fs
    .mkdir(nodeModulesDir, { recursive: true })
    .then(() =>
      installPackageToNodeModule(
        context,
        nodeModulesDir,
        packageName,
        versionRange,
      ),
    )
}

function installPackageToNodeModule(
  context: Context,
  nodeModulesDir: string,
  packageName: string,
  versionRange: string,
) {
  let key = `${packageName}@${versionRange}`
  if (context.hotPackages.has(key)) {
    return
  }
  context.hotPackages.add(key)
  console.debug('[load package]', packageName, versionRange)
  return getPackageInfo(packageName).then(info => {
    if (!info['dist-tags']) {
      console.error('missing dist-tags field in package info:', info)
    }
    versionRange = info['dist-tags'][versionRange] || versionRange
    let { exactVersion, skip } = resolvePackageVersionRange(
      context,
      info,
      packageName,
      versionRange,
    )
    if (skip) {
      console.debug('[skip package]', packageName, versionRange)
      return linkPackage(context, nodeModulesDir, packageName, exactVersion)
    }
    let versions = getContextPackageVersions(
      context.onDiskPackages,
      packageName,
    )
    versions.add(exactVersion)
    let versionInfo = info['versions'][exactVersion]
    if (!versionInfo) {
      throw new Error(`version not found: ${packageName}@${exactVersion}`)
    }
    let url = versionInfo.dist.tarball
    return downloadPackage(context, packageName, exactVersion, url).then(() =>
      linkPackage(context, nodeModulesDir, packageName, exactVersion),
    )
  })
}

function linkPackage(
  context: Context,
  nodeModulesDir: string,
  packageName: string,
  version: string,
) {
  let src = path.join(context.storeDir, `${packageName}@${version}`)
  let dest = path.join(nodeModulesDir, packageName)
  if (packageName.includes('/')) {
    let parentDir = path.dirname(dest)
    return fs
      .mkdir(parentDir, { recursive: true })
      .then(() => fs.symlink(src, dest))
  }
  return fs.symlink(src, dest)
}

type VersionFilter = (version: string) => boolean

let majorVersionRegex = /\^(.*?\.)/
let minorVersionRegex = /\~(.*?\..*?\.)/
let wildCastVersionRegex = /(.*?)\*/

export function getVersionFilter(versionRange: string): VersionFilter {
  if (versionRange === '*') {
    return () => true
  }
  if (isSemverVersion(versionRange)) {
    return v => v == versionRange
  }
  switch (versionRange[0]) {
    case '^': {
      let match = versionRange.match(majorVersionRegex)
      if (!match) {
        throw new Error('failed to parse major version prefix')
      }
      let prefix = match[1]
      return v => v.startsWith(prefix)
    }
    case '~': {
      let match = versionRange.match(minorVersionRegex)
      if (!match) {
        throw new Error('failed to parse minor version prefix')
      }
      let prefix = match[1]
      return v => v.startsWith(prefix)
    }
    default: {
      let parts = versionRange.split('.')
      // handle implicit wild-cast range, e.g. convert "2" to "2.*"
      let versionPattern = parts.length < 3 ? versionRange + '.*' : versionRange
      let match = versionPattern.match(wildCastVersionRegex)
      if (!match) {
        throw new Error(
          'failed to parse wild-cast version prefix: ' + versionRange,
        )
      }
      let prefix = match[1]
      return v => v.startsWith(prefix)
    }
  }
}

function resolvePackageVersionRange(
  context: Context,
  info: PackageInfo,
  packageName: string,
  versionRange: string,
): { exactVersion: string; skip: boolean } {
  let versionFilter = getVersionFilter(versionRange)

  let existingVersions = context.onDiskPackages.get(packageName)
  if (existingVersions) {
    let matchedVersion = findLatestVersion(
      Array.from(existingVersions).filter(versionFilter),
    )
    if (matchedVersion) {
      return { exactVersion: matchedVersion, skip: true }
    }
  }

  let matchedVersion = findLatestVersion(
    Object.keys(info.versions).filter(versionFilter),
  )
  if (matchedVersion) {
    return { exactVersion: matchedVersion, skip: false }
  }

  throw new Error('version not matched: ' + versionRange)
}

type Semver = (string | number)[]
function parseExactSemver(version: string): Semver {
  return version.split('.').map(part => parseInt(part) || part)
}

function compareSemver(aVersion: Semver, bVersion: Semver) {
  let n = Math.max(aVersion.length, bVersion.length)
  for (let i = 0; i < n; i++) {
    let a = aVersion[i]
    let b = bVersion[i]
    if (a < b) {
      return 1
    }
    if (a > b) {
      return -1
    }
  }
  return 0
}

function findLatestVersion(versions: Array<string>) {
  let semverVersions = versions.filter(isSemverVersion)
  if (semverVersions.length > 1) {
    versions = semverVersions
  }
  let version = versions.map(parseExactSemver).sort(compareSemver)[0]
  if (version) {
    return version.join('.')
  }
}

function isSemverVersion(version: string) {
  let parts = version.split('.')
  if (parts.length !== 3) {
    return false
  }
  return parts.every(part => String(+part) == part)
}

function downloadPackage(
  context: Context,
  packageName: string,
  version: string,
  url: string,
) {
  let dirName = `${packageName}@${version}`
  let packageDir = path.join(context.storeDir, dirName)
  let mkdirP = fs.mkdir(packageDir, { recursive: true })
  let resP = fetch(url)
  return Promise.all([resP, mkdirP])
    .then(([res]) => {
      return new Promise((resolve, reject) => {
        res.body
          .on('error', reject)
          .pipe(zlib.createGunzip())
          .on('error', reject)
          .pipe(
            tar.extract({
              strip: 1,
              cwd: packageDir,
            }),
          )
          .on('error', reject)
          .on('end', resolve)
      })
    })
    .then(() => installPackageDir(context, packageDir))
}

function installPackageDir(context: any, packageDir: string) {
  let packageJSONFile = path.join(packageDir, 'package.json')
  return fs.readFile(packageJSONFile).then(buffer => {
    let json = JSON.parse(buffer.toString()) as PackageJSON

    let ps: Promise<unknown>[] = []

    let { dependencies, devDependencies } = json

    if (devDependencies && context.dev && context.hotPackages.size == 0) {
      for (let name in devDependencies) {
        let version = devDependencies[name]
        ps.push(installPackage(context, packageDir, name, version))
      }
    }

    if (dependencies) {
      for (let name in dependencies) {
        let version = dependencies[name]
        ps.push(installPackage(context, packageDir, name, version))
      }
    }

    return Promise.all(ps)
  })
}

function populateContext(context: Context) {
  context.storeDir = path.resolve(context.storeDir)
  return fs
    .mkdir(context.storeDir, { recursive: true })
    .then(() => fs.readdir(context.storeDir))
    .then(dirnames => {
      return Promise.all(
        dirnames.map(dirname => scanStoreDir(context, dirname)),
      )
    })
}

function scanStoreDir(context: Context, dirname: string) {
  let dir = path.join(context.storeDir, dirname)
  if (dirname[0] !== '@') {
    // unscoped package
    let [packageName, version] = dirname.split('@')
    return scanStorePackage(context, dir, packageName, version)
  }
  // org-scoped package
  let org = dirname
  return fs.readdir(dir).then(dirnames =>
    Promise.all(
      dirnames.map(dirname => {
        let [packageName, version] = dirname.split('@')
        packageName = `${org}/${packageName}`
        let packageDir = path.join(dir, dirname)
        return scanStorePackage(context, packageDir, packageName, version)
      }),
    ),
  )
}

function scanStorePackage(
  context: Context,
  dir: string,
  packageName: string,
  version: string,
) {
  return fs.readdir(dir).then(packageFiles => {
    if (packageFiles.length === 0) {
      return
    }
    let versions = getContextPackageVersions(
      context.onDiskPackages,
      packageName,
    )
    versions.add(version)
  })
}

export function installFromPackageJSON(options: {
  cwd: string
  dev: boolean
  storeDir: string
}) {
  let context: Context = {
    storeDir: options.storeDir,
    dev: options.dev,
    onDiskPackages: new Map(),
    hotPackages: new Set(),
  }
  return populateContext(context).then(() =>
    installPackageDir(context, options.cwd),
  )
}

function test() {
  let context: Context = {
    storeDir: 'snpm-store',
    dev: true,
    onDiskPackages: new Map(),
    hotPackages: new Set(),
  }
  let packageDir = 'examples'
  let packageName = '@stencil/core'
  let versionRange = 'latest'
  populateContext(context)
    .then(() => installPackage(context, packageDir, packageName, versionRange))
    .then(() => console.log('done'))
    .catch(err => console.error(err))
}
// test()
