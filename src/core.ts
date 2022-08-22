import fetch, { Response } from 'node-fetch'
import fs from 'fs/promises'
import path from 'path'
import zlib from 'zlib'
import tar from 'tar'
import semver from 'semver'

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
  // packageName@versionRange -> exactVersion
  hotPackages: Map<string, Promise<string>>
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
): Promise<ExactVersion> {
  let key = `${packageName}@${versionRange}`
  let next = (exactVersion: string) =>
    postDownloadPackage(
      context,
      nodeModulesDir,
      packageName,
      exactVersion,
    ).then(() => exactVersion)
  let exactVersionP = context.hotPackages.get(key)
  if (exactVersionP) {
    return exactVersionP.then(next)
  }
  console.debug(`  load package: ${packageName} ${versionRange}`)
  let exactVersion = resolveLocalPackageVersionRange(
    context,
    packageName,
    versionRange,
  )
  if (exactVersion) {
    context.hotPackages.set(key, Promise.resolve(exactVersion))
    console.debug(` reuse package: ${packageName} ${versionRange}`)
    return next(exactVersion)
  }
  exactVersionP = getPackageInfo(packageName).then(
    (info): Promise<ExactVersion> => {
      if (!info['dist-tags']) {
        console.error('missing dist-tags field in package info:', info)
      }
      versionRange = info['dist-tags'][versionRange] || versionRange
      let exactVersion = resolveRemotePackageVersionRange(info, versionRange)

      let versions = getContextPackageVersions(
        context.onDiskPackages,
        packageName,
      )
      versions.add(exactVersion)
      let versionInfo = info['versions'][exactVersion]
      if (!versionInfo) {
        throw new Error(
          `version not found: ${packageName}@${exactVersion}, versionRange: ${versionRange}`,
        )
      }
      let url = versionInfo.dist.tarball
      return downloadPackage(context, packageName, exactVersion, url)
        .then(() => next(exactVersion))
        .then(() => exactVersion)
    },
  )
  context.hotPackages.set(key, exactVersionP)
  return exactVersionP
}

function linkPackage(packageName: string, src: string, dest: string) {
  // setup symbolic link, ignore if already existing
  let next = () =>
    fs.symlink(src, dest).catch(err => {
      if (err.code === 'EEXIST') {
        return
      }
      throw err
    })
  // create org directory for scoped package
  if (packageName.includes('/')) {
    let parentDir = path.dirname(dest)
    return fs.mkdir(parentDir, { recursive: true }).then(next)
  }
  return next()
}

type VersionFilter = (version: string) => boolean

export function getVersionFilter(versionRange: string): VersionFilter {
  return version => semver.satisfies(version, versionRange)
}

type ExactVersion = string

function resolveLocalPackageVersionRange(
  context: Context,
  packageName: string,
  versionRange: string,
): ExactVersion | undefined {
  let versionFilter = getVersionFilter(versionRange)

  let existingVersions = context.onDiskPackages.get(packageName)
  if (existingVersions) {
    let matchedVersion = findLatestVersion(
      Array.from(existingVersions).filter(versionFilter),
    )
    if (matchedVersion) {
      return matchedVersion
    }
  }
}

function resolveRemotePackageVersionRange(
  info: PackageInfo,
  versionRange: string,
): ExactVersion {
  let versionFilter = getVersionFilter(versionRange)

  let matchedVersion = findLatestVersion(
    Object.keys(info.versions).filter(versionFilter),
  )
  if (matchedVersion) {
    return matchedVersion
  }

  throw new Error('version not matched: ' + versionRange)
}

function findLatestVersion(versions: Array<string>) {
  return versions
    .slice()
    .sort((a, b) => (semver.lt(a, b) ? -1 : semver.gt(a, b) ? 1 : 0))
    .pop()
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
  return Promise.all([resP, mkdirP]).then(([res]) => {
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
}

function postDownloadPackage(
  context: Context,
  nodeModulesDir: string,
  packageName: string,
  version: string,
) {
  let dirname = `${packageName}@${version}`
  let src = path.join(context.storeDir, dirname)
  let dest = path.join(nodeModulesDir, packageName)
  let packageDir = path.join(context.storeDir, dirname)
  return Promise.all([
    linkPackage(packageName, src, dest),
    installPackageDir(context, packageDir),
  ])
}

function installPackageDir(context: any, packageDir: string) {
  let packageJSONFile = path.join(packageDir, 'package.json')
  return fs
    .readFile(packageJSONFile)
    .catch(err => {
      // probably still downloading, will be handled by another caller
      if (err.code === 'ENOENT') {
        return 'skip' as const
      }
      throw err
    })
    .then(buffer => {
      if (buffer == 'skip') {
        return
      }

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
    hotPackages: new Map(),
  }
  return populateContext(context).then(() =>
    installPackageDir(context, options.cwd),
  )
}
