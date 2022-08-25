import fs from 'fs'
import path from 'path'
import semver from 'semver'
import zlib from 'zlib'
import tar from 'tar'
import fetch, { Response } from 'node-fetch'

export class Store {
  public storeDir: string
  // package name -> exact versions
  private storePackages = new Map<string, Set<string>>()
  // package name -> registry info
  private packageInfoCache = new Map<string, Promise<PackageInfo>>()
  // package name -> version range -> exact version
  private remotePackageCache = new Map<
    string,
    Map<string, string | Promise<string>>
  >()
  constructor(options: { storeDir: string }) {
    this.storeDir = options.storeDir
    this.init()
  }

  public installPackageDir(
    options: { cwd: string; dev: boolean },
    cb: (err: NodeJS.ErrnoException[] | null) => void,
  ) {
    let packageDir = options.cwd
    this.readPackageJSON(packageDir, (err, json) => {
      if (err) {
        cb([err])
        return
      }
      let { dependencies, devDependencies } = json
      let waitGroup = new WaitGroup<any>()
      let nodeModulesDir = path.join(packageDir, 'node_modules')
      if (options.dev && devDependencies) {
        for (let name in devDependencies) {
          let version = devDependencies[name]
          this.installPackage(
            nodeModulesDir,
            name,
            version,
            waitGroup.addCallback(),
          )
        }
      }
      if (dependencies) {
        for (let name in dependencies) {
          let version = dependencies[name]
          this.installPackage(
            nodeModulesDir,
            name,
            version,
            waitGroup.addCallback(),
          )
        }
      }
      waitGroup.hookCallback(cb)
    })
  }
  private readPackageJSON(
    packageDir: string,
    cb: (err: NodeJS.ErrnoException | null, json: PackageJSON) => void,
  ) {
    let file = path.join(packageDir, 'package.json')
    fs.readFile(file, (err, buffer) => {
      if (err) {
        cb(err, null as any)
      } else {
        let json = JSON.parse(buffer.toString())
        cb(null, json)
      }
    })
  }
  private installPackage(
    nodeModulesDir: string,
    packageName: string,
    versionRange: string,
    cb: (err: NodeJS.ErrnoException[] | NodeJS.ErrnoException | null) => void,
  ) {
    let versionMap = this.getStorePackage(packageName)
    let exactVersions = Array.from(versionMap.keys())

    let exactVersion = findLatestMatch(versionRange, exactVersions)
    if (exactVersion) {
      this.installStorePackage(nodeModulesDir, packageName, exactVersion, cb)
    } else {
      this.installRemotePackage(nodeModulesDir, packageName, versionRange, cb)
    }
  }
  private installStorePackage(
    nodeModulesDir: string,
    packageName: string,
    exactVersion: string,
    cb: (err: NodeJS.ErrnoException[] | NodeJS.ErrnoException | null) => void,
  ) {
    this.linkPackage(nodeModulesDir, packageName, exactVersion, cb)
  }
  private linkPackage(
    nodeModulesDir: string,
    packageName: string,
    exactVersion: string,
    cb: (err: NodeJS.ErrnoException | null) => void,
  ) {
    let dest = path.join(nodeModulesDir, packageName)
    let src = path.join(this.storeDir, `${packageName}/${exactVersion}`)
    if (packageName.includes('/')) {
      let parentDir = path.dirname(dest)
      fs.mkdir(
        parentDir,
        { recursive: true },
        next(cb, () => makeSymbolicLink(src, dest, cb)),
      )
    } else {
      makeSymbolicLink(src, dest, cb)
    }
  }
  private cachedDownloadPackage(
    packageName: string,
    versionRange: string,
    cb: (err: NodeJS.ErrnoException | null, exactVersion: string) => void,
  ) {
    let versions = this.getRemotePackageCache(packageName)
    let exactVersion = versions.get(versionRange)
    if (!exactVersion) {
      exactVersion = this.downloadPackage(packageName, versionRange)
      versions.set(versionRange, exactVersion)
    }
    if (typeof exactVersion === 'string') {
      cb(null, exactVersion)
    } else {
      exactVersion
        .then(exactVersion => cb(null, exactVersion))
        .catch(err => cb(err, null as any))
    }
  }
  private downloadPackage(
    packageName: string,
    versionRange: string,
  ): Promise<string> {
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
      this.getStorePackage(packageName).add(exactVersion)
      return new Promise((resolve, reject) => {
        fs.mkdir(packageDir, { recursive: true }, err => {
          if (err) {
            reject(err)
            return
          }
          let cb = (err: NodeJS.ErrnoException | null, exactVersion: string) =>
            err ? reject(err) : resolve(exactVersion)
          fetch(url)
            .then(res =>
              res.body
                .on('error', cb)
                .pipe(zlib.createGunzip())
                .on('error', cb)
                .pipe(tar.extract({ strip: 1, cwd: packageDir }))
                .on('error', cb)
                .on('end', () => {
                  cb(null, exactVersion)
                }),
            )
            .catch(err => cb(err, null as any))
        })
      })
    })
  }
  private installRemotePackage(
    nodeModulesDir: string,
    packageName: string,
    versionRange: string,
    cb: (err: NodeJS.ErrnoException[] | null) => void,
  ) {
    this.cachedDownloadPackage(
      packageName,
      versionRange,
      (err, exactVersion) => {
        if (err) {
          cb([err])
          return
        }
        let waitGroup = new WaitGroup<NodeJS.ErrnoException>()
        this.linkPackage(
          nodeModulesDir,
          packageName,
          exactVersion,
          waitGroup.addCallback(),
        )
        this.installPackageDir({ cwd: '', dev: false }, waitGroup.addCallback())
        waitGroup.hookCallback(cb)
      },
    )
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
  private getRemotePackageCache(packageName: string) {
    let cache = this.remotePackageCache.get(packageName)
    if (cache) {
      return cache
    }
    cache = new Map()
    this.remotePackageCache.set(packageName, cache)
    return cache
  }

  private init() {
    let storeDir = (this.storeDir = path.resolve(this.storeDir))
    for (let dirname of fs.readdirSync(this.storeDir)) {
      if (dirname[0] === '@') {
        let orgDir = path.join(storeDir, dirname)
        let orgName = dirname
        for (let dirname of fs.readdirSync(orgDir)) {
          let [name, version] = dirname.split('@')
          this.initPackage(`${orgName}/${name}`, version)
        }
      } else {
        let [name, version] = dirname.split('@')
        this.initPackage(name, version)
      }
    }
  }
  private initPackage(packageName: string, exactVersion: string) {
    this.getStorePackage(packageName).add(exactVersion)
  }
  private getStorePackage(packageName: string) {
    let versions = this.storePackages.get(packageName)
    if (versions) {
      return versions
    }
    versions = new Set()
    this.storePackages.set(packageName, versions)
    return versions
  }
}

class WaitGroup<E> {
  private pending = 0
  private errors: E[] = []
  private callbacks: Array<(err: E[] | null) => void> = []

  addCallback() {
    this.pending++
    return (err: E[] | E | null) => {
      this.pending--
      if (err) {
        if (Array.isArray(err)) {
          this.errors.push(...err)
        } else {
          this.errors.push(err)
        }
      }
      if (this.pending === 0) {
        let err = this.errors.length === 0 ? null : this.errors
        for (let cb of this.callbacks) {
          cb(err)
        }
        this.callbacks = []
      }
    }
  }

  hookCallback(cb: (err: E[] | null) => void) {
    if (this.pending === 0) {
      let err = this.errors.length === 0 ? null : this.errors
      cb(err)
    } else {
      this.callbacks.push(cb)
    }
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

function next<E, T = void>(
  cb: (err: E | null) => void,
  next: (data: T) => void,
) {
  return (err: E | null, data: T) => {
    if (err) {
      cb(err)
    } else {
      try {
        next(data)
      } catch (error) {
        cb(err)
      }
    }
  }
}

function findLatestMatch(versionRange: string, exactVersions: string[]) {
  if (versionRange === 'latest') {
    versionRange = '*'
  }
  return exactVersions
    .filter(exactVersion => semver.satisfies(exactVersion, versionRange))
    .sort((a, b) => (semver.lt(a, b) ? -1 : semver.gt(a, b) ? 1 : 0))
    .pop()
}

function getJSON(res: Response) {
  return res.json()
}

function makeSymbolicLink(
  src: string,
  dest: string,
  cb: (err: NodeJS.ErrnoException | null) => void,
) {
  fs.symlink(src, dest, err => {
    if (err && err.code !== 'EEXIST') {
      cb(err)
    } else {
      cb(null)
    }
  })
}
