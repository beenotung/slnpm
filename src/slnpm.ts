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
  // TODO cache on-going downloads
  private packageInfoCache = new Map<string, Promise<PackageInfo>>()
  constructor(options: { storeDir: string }) {
    this.storeDir = options.storeDir
    this.init()
  }

  public installPackageDir(
    options: { cwd: string; dev: boolean },
    cb: (err: NodeJS.ErrnoException[] | NodeJS.ErrnoException | null) => void,
  ) {
    let packageDir = options.cwd
    this.readPackageJSON(
      packageDir,
      next(cb, ({ dependencies, devDependencies }) => {
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
      }),
    )
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
      /* cached package */
      this.linkPackage(nodeModulesDir, packageName, exactVersion, cb)
    } else {
      /* new package */
      this.downloadPackage(nodeModulesDir, packageName, versionRange, cb)
    }
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
  private downloadPackage(
    nodeModulesDir: string,
    packageName: string,
    versionRange: string,
    cb: (err: NodeJS.ErrnoException[] | NodeJS.ErrnoException | null) => void,
  ) {
    this.getPackageInfo(packageName)
      .then(info => {
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
        fs.mkdir(
          packageDir,
          { recursive: true },
          next(cb, () => {
            fetch(url)
              .then(res =>
                res.body
                  .on('error', cb)
                  .pipe(zlib.createGunzip())
                  .on('error', cb)
                  .pipe(tar.extract({ strip: 1, cwd: packageDir }))
                  .on('error', cb)
                  .on('end', () => {
                    this.getStorePackage(packageName).add(exactVersion)
                    this.installPackageDir(
                      { cwd: '', dev: false },
                      next(cb, () =>
                        this.linkPackage(
                          nodeModulesDir,
                          packageName,
                          exactVersion,
                          cb,
                        ),
                      ),
                    )
                  }),
              )
              .catch(cb)
          }),
        )
      })
      .catch(cb)
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
    return (err: E | null) => {
      this.pending--
      if (err) {
        this.errors.push(err)
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
