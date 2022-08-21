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

type PackageJson = {
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
  packages: Map<string, Set<string>>
}

function getContextPackageVersions(
  packages: Context['packages'],
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
  return getPackageInfo(packageName).then(info => {
    if (!info['dist-tags']) {
      console.error('missing dist-tags field in package info:', info)
    }
    versionRange = info['dist-tags'][versionRange] || versionRange
    console.debug('[get package]', packageName, versionRange)
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
    let versions = getContextPackageVersions(context.packages, packageName)
    versions.add(exactVersion)
    let versionInfo = info['versions'][exactVersion]
    if (!versionInfo) {
      throw new Error('version not found: ' + exactVersion)
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
  return fs.symlink(src, dest)
}

let isExactVersion = parseInt

type VersionFilter = (version: string) => boolean

let majorVersionRegex = /\^(.*?\.)/
let minorVersionRegex = /\~(.*?\.)/
let wildCastVersionRegex = /(.*?)\*/

function getVersionFilter(versionRange: string): VersionFilter {
  if (versionRange === '*') {
    return () => true
  }
  if (isExactVersion(versionRange)) {
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
      let match = versionRange.match(wildCastVersionRegex)
      if (!match) {
        throw new Error('failed to parse wild-cast version prefix')
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

  let existingVersions = context.packages.get(packageName)
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
  let version = versions.map(parseExactSemver).sort(compareSemver)[0]
  if (version) {
    return version.join('.')
  }
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
  let packageJsonFile = path.join(packageDir, 'package.json')
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
    .then(() => fs.readFile(packageJsonFile))
    .then(buffer => {
      let json = JSON.parse(buffer.toString()) as PackageJson
      let dependencies = json.dependencies

      let ps: Promise<unknown>[] = []

      if (dependencies) {
        for (let name in dependencies) {
          let version = dependencies[name]
          ps.push(installPackage(context, packageDir, name, version))
        }
      }

      dependencies = json.devDependencies
      if (dependencies && context.dev) {
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
    .then(packages => {
      let packageMap = context.packages
      return Promise.all(
        packages.map(dirname => {
          return fs
            .readdir(path.join(context.storeDir, dirname))
            .then(packageFiles => {
              if (packageFiles.length === 0) {
                return
              }
              let parts = dirname.split('@')
              let packageName: string
              let version: string
              switch (parts.length) {
                case 2:
                  // unscoped package
                  packageName = parts[0]
                  version = parts[1]
                  break
                case 3:
                  // org-scoped package
                  packageName = parts[0] + '@' + parts[1]
                  version = parts[2]
                  break
                default:
                  // skip invalid dir name
                  return
              }
              let versions = getContextPackageVersions(packageMap, packageName)
              versions.add(version)
            })
        }),
      )
    })
}

function test() {
  let context: Context = {
    storeDir: 'snpm-store',
    dev: false,
    packages: new Map(),
  }
  let packageDir = 'examples'
  let packageName = 'tar'
  let versionRange = 'latest'
  populateContext(context)
    .then(() => installPackage(context, packageDir, packageName, versionRange))
    .then(() => console.log('done'))
    .catch(err => console.error(err))
}
test()
