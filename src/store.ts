import fs from 'fs/promises'
import path from 'path'
import semver from 'semver'
import zlib from 'zlib'
import tar from 'tar'
import fetch, { Response } from 'node-fetch'

export class Store {
  private storeDir: string
  // package name -> versions
  private onDiskPackages = new Map<string, Set<string>>()
  // packageName@versionRange -> exactVersion
  private hotPackages = new Map<string, string | Promise<string>>()
  // packageName -> Info
  private packageInfoCache = new Map<string, Promise<PackageInfo>>()
  constructor(options: { storeDir: string }) {
    this.storeDir = options.storeDir
  }
  public init() {
    this.storeDir = path.resolve(this.storeDir)
    return fs
      .mkdir(this.storeDir, { recursive: true })
      .then(() => fs.readdir(this.storeDir))
      .then(dirnames =>
        Promise.all(dirnames.map(dirname => this.scanStoreDir(dirname))),
      )
  }
  private scanStoreDir(dirname: string) {
    if (dirname[0] == '@') {
      return this.scanStoreOrgDir(dirname)
    }
    let [packageName, version] = dirname.split('@')
    let packageDir = path.join(this.storeDir, dirname)
    return this.scanStorePackageDir(packageDir, packageName, version)
  }
  private scanStoreOrgDir(orgDirname: string) {
    let orgDir = path.join(this.storeDir, orgDirname)
    return fs.readdir(orgDir).then(dirnames =>
      Promise.all(
        dirnames.map(dirname => {
          let [packageName, version] = dirname.split('@')
          packageName = `${orgDirname}/${packageName}`
          let packageDir = path.join(orgDir, dirname)
          return this.scanStorePackageDir(packageDir, packageName, version)
        }),
      ),
    )
  }
  private scanStorePackageDir(
    dir: string,
    packageName: string,
    version: string,
  ) {
    return fs.readdir(dir).then(packageFiles => {
      if (packageFiles.length === 0) {
        return
      }
      let versions = this.getStorePackageVersions(packageName)
      versions.add(version)
    })
  }
  private getStorePackageVersions(packageName: string) {
    let versions = this.onDiskPackages.get(packageName)
    if (!versions) {
      versions = new Set()
      this.onDiskPackages.set(packageName, versions)
    }
    return versions
  }

  public installFromPackageJSON(options: { cwd: string; dev: boolean }) {
    let packageDir = options.cwd
    let nodeModulesDir = path.join(packageDir, 'node_modules')
    return fs
      .mkdir(nodeModulesDir, { recursive: true })
      .then(() => this.readPackageJSON(packageDir))
      .then(({ dependencies, devDependencies }) => {
        let ps: Promise<void>[] = []
        if (options.dev && devDependencies) {
          for (let name in devDependencies) {
            let version = devDependencies[name]
            ps.push(this.installPackage(nodeModulesDir, name, version))
          }
        }
        if (dependencies) {
          for (let name in dependencies) {
            let version = dependencies[name]
            ps.push(this.installPackage(nodeModulesDir, name, version))
          }
        }
        return Promise.all(ps)
      })
  }
  private installPackageDependencies(packageDir: string) {
    return this.installFromPackageJSON({ cwd: packageDir, dev: false })
  }
  private readPackageJSON(packageDir: string) {
    let file = path.join(packageDir, 'package.json')
    return fs
      .readFile(file)
      .then(buffer => JSON.parse(buffer.toString()) as PackageJSON)
      .catch(err => {
        throw new Error(
          'Failed to read package.json: ' + file + ', error: ' + err,
        )
      })
  }
  private installPackage(
    nodeModulesDir: string,
    packageName: string,
    versionRange: string,
  ) {
    let exactVersion = this.getPackageVersion(packageName, versionRange)
    if (typeof exactVersion === 'string') {
      return this.linkPackage(nodeModulesDir, packageName, exactVersion)
    }
    return exactVersion.then(exactVersion =>
      this.linkPackage(nodeModulesDir, packageName, exactVersion),
    )
  }
  private linkPackage(
    nodeModulesDir: string,
    packageName: string,
    exactVersion: string,
  ) {
    let src = path.join(this.storeDir, `${packageName}@${exactVersion}`)
    let dest = path.join(nodeModulesDir, packageName)
    if (packageName.includes('/')) {
      let parentDir = path.dirname(dest)
      return fs
        .mkdir(parentDir, { recursive: true })
        .then(() => makeSymbolicLink(src, dest))
    }
    return makeSymbolicLink(src, dest)
  }
  private getPackageVersion(packageName: string, versionRange: string) {
    let key = `${packageName}@${versionRange}`
    let version = this.hotPackages.get(key)
    if (version) {
      return version
    }
    version = this.matchLocalPackageVersion(packageName, versionRange)
    if (version) {
      return version
    }
    return this.matchRemotePackageVersion(packageName, versionRange)
  }
  private matchLocalPackageVersion(packageName: string, versionRange: string) {
    let versions = this.onDiskPackages.get(packageName)
    if (!versions) {
      return
    }
    return findLatestMatch(versionRange, Array.from(versions))
  }
  private matchRemotePackageVersion(packageName: string, versionRange: string) {
    return this.getPackageInfo(packageName).then(info => {
      if (info['dist-tags']) {
        versionRange = info['dist-tags'][versionRange] || versionRange
      }
      const exactVersion = findLatestMatch(
        versionRange,
        Object.keys(info.versions),
      )
      if (!exactVersion) {
        throw new Error(
          `Failed to match package version: ${packageName}@${versionRange}`,
        )
      }
      let versionInfo = info.versions[exactVersion]
      if (!versionInfo) {
        throw new Error(
          `Package version not found, packageName: ${packageName}, versionRange: ${versionRange}, exactVersion: ${exactVersion}`,
        )
      }
      let url = versionInfo.dist.tarball
      let packageDir = path.join(
        this.storeDir,
        `${packageName}@${exactVersion}`,
      )
      return this.downloadPackage(packageDir, url)
        .then(() => this.installPackageDependencies(packageDir))
        .then(() => exactVersion)
    })
  }
  private getPackageInfo(packageName: string) {
    let info = this.packageInfoCache.get(packageName)
    if (info) {
      return info
    }
    let url = `https://registry.npmjs.org/${packageName}`
    info = fetch(url).then(getJSON)
    this.packageInfoCache.set(packageName, info)
    return info
  }
  private downloadPackage(packageDir: string, url: string) {
    return fs.mkdir(packageDir, { recursive: true }).then(() =>
      fetch(url).then(
        res =>
          new Promise((resolve, reject) =>
            res.body
              .on('error', reject)
              .pipe(zlib.createGunzip())
              .on('error', reject)
              .pipe(tar.extract({ strip: 1, cwd: packageDir }))
              .on('error', reject)
              .on('end', resolve),
          ),
      ),
    )
  }
}

type PackageJSON = {
  dependencies: Dependencies
  devDependencies: Dependencies
}

type Dependencies = {
  // package name -> version range
  [name: string]: string
}

type PackageInfo = {
  _id: string // same as name
  _rev: string // revision (version id)
  name: string
  'dist-tags'?: {
    [tag: string]: Maybe<string> // version, e.g. { latest: "2.4.0" }
  }
  versions: {
    [version: string]: Maybe<{
      dist: {
        tarball: string // download url
      }
    }>
  }
}

type Maybe<T> = undefined | T

function findLatestMatch(versionRange: string, versions: string[]) {
  return versions
    .filter(version => semver.satisfies(version, versionRange))
    .sort((a, b) => (semver.lt(a, b) ? -1 : semver.gt(a, b) ? 1 : 0))
    .pop()
}

function getJSON(res: Response) {
  return res.json()
}

function makeSymbolicLink(src: string, dest: string) {
  return fs.symlink(src, dest).catch(err => {
    if (err.code !== 'EEXIST') {
      throw err
    }
  })
}
