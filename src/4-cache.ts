import child_process from 'child_process'
import fs from 'fs'
import path from 'path'
import semver from 'semver'

export class Store {
  private storeDir: string
  // package name -> exact versions
  private storePackageVersions = new PackageVersions()
  constructor(options: { storeDir: string }) {
    this.storeDir = options.storeDir
    this.init()
  }
  public getPackageDir(packageName: string, exactVersion: string) {
    let key = `${packageName}@${exactVersion}`
    return path.join(this.storeDir, key)
  }
  private init() {
    let storeDir = (this.storeDir = path.resolve(this.storeDir))
    for (let dirname of fs.readdirSync(storeDir)) {
      if (dirname[0] !== '@') {
        let [name, version] = dirname.split('@')
        this.addPackageVersion(name, version)
        continue
      }
      let orgDir = path.join(storeDir, dirname)
      let orgName = dirname
      for (let dirname of fs.readdirSync(orgDir)) {
        let [name, version] = dirname.split('@')
        this.addPackageVersion(`${orgName}/${name}`, version)
      }
    }
  }
  public addPackageVersion(packageName: string, exactVersion: string) {
    this.storePackageVersions.addPackageVersion(packageName, exactVersion)
  }
  public getVersions(packageName: string): string[] {
    return this.storePackageVersions.getPackageVersions(packageName)
  }
}

class PackageVersions {
  // package name -> exact versions
  private packageVersions = new Map<string, Set<string>>()
  public addPackageVersion(packageName: string, exactVersion: string): void {
    let versions = this.packageVersions.get(packageName)
    if (!versions) {
      versions = new Set()
      this.packageVersions.set(packageName, versions)
    }
    versions.add(exactVersion)
  }
  public getPackageVersions(packageName: string): string[] {
    let versions = this.packageVersions.get(packageName)
    return versions ? Array.from(versions) : []
  }
  public forEach(eachFn: (packageName: string, exactVersion: string) => void) {
    this.packageVersions.forEach((versions, packageName) => {
      versions.forEach(exactVersion => {
        eachFn(packageName, exactVersion)
      })
    })
  }
}

class WaitGroup<E = NodeJS.ErrnoException> {
  private pending = 0
  private errors: E[] = []
  private callbacks: Array<(err: E[] | null) => void> = []

  constructor(private mode: 'dev' | 'prod' = 'prod') {}

  addPending() {
    this.pending++
    if (this.mode === 'dev') {
      console.debug('addPending', this)
    }
  }

  addResult = (err: E[] | E | null) => {
    this.pending--
    if (err) {
      if (Array.isArray(err)) {
        this.errors.push(...err)
      } else {
        this.errors.push(err)
      }
    }
    if (this.mode === 'dev') {
      console.debug('addResult', this, err)
    }
    this.checkPending()
  }

  private checkPending() {
    if (this.mode === 'dev') {
      console.debug('checkPending', this)
    }
    if (this.pending === 0) {
      let err = this.errors.length === 0 ? null : this.errors
      for (let cb of this.callbacks) {
        cb(err)
      }
      this.callbacks = []
    }
  }

  hookCallback(cb: (err: E[] | null) => void) {
    if (this.mode === 'dev') {
      console.debug('hookCallback', this)
    }
    if (this.pending === 0) {
      let err = this.errors.length === 0 ? null : this.errors
      cb(err)
    } else {
      this.callbacks.push(cb)
    }
  }
}

type TaskOptions = {
  cwd: string
  dev: boolean
}
export function installPackageDir(
  store: Store,
  options: TaskOptions,
  cb: (err: NodeJS.ErrnoException[] | null) => void,
) {
  let packageDir = options.cwd
  let waitGroup = new WaitGroup<NodeJS.ErrnoException>()
  let file = path.join(packageDir, 'package.json')
  readPackageFile(waitGroup, file, ({ dependencies, devDependencies }) => {
    let nodeModulesDir = path.join(packageDir, 'node_modules')
    mkdir(waitGroup, nodeModulesDir, () => {
      let remoteDependencies: Dependencies = {}
      let hasRemoteDependencies = false
      function addDependencies(packageName: string, versionRange: string) {
        let versions = store.getVersions(packageName)
        let exactVersion = findLatestMatch(versionRange, versions)
        if (exactVersion) {
          linkPackage(
            store,
            waitGroup,
            nodeModulesDir,
            packageName,
            exactVersion,
            () => console.debug(`linked ${packageName}@${exactVersion}`),
          )
          return
        }
        hasRemoteDependencies = true
        remoteDependencies[packageName] = versionRange
      }
      if (options.dev && devDependencies) {
        for (let name in devDependencies) {
          let version = devDependencies[name]
          addDependencies(name, version)
        }
      }
      if (dependencies) {
        for (let name in dependencies) {
          let version = dependencies[name]
          addDependencies(name, version)
        }
      }
      if (hasRemoteDependencies) {
        console.log('downloading new packages:', remoteDependencies)
        let tmpDir = path.join(nodeModulesDir, '.tmp')
        mkdir(waitGroup, tmpDir, () => {
          console.debug('start npm install')
          npmInstall(waitGroup, tmpDir, remoteDependencies, () => {
            console.debug('finished npm install')
            let tmpNodeModulesDir = path.join(tmpDir, 'node_modules')
            waitGroup.addPending()
            digestNewPackages(store, tmpNodeModulesDir, err => {
              console.debug('finished digest new packages:', err)
              if (!err) {
                waitGroup.addPending()
                installPackageDir(store, options, err => {
                  waitGroup.addResult(err)
                })
              }
              waitGroup.addResult(err)
            })
          })
        })
      }
    })
  })
  waitGroup.hookCallback(cb)
}

function digestNewPackages(
  store: Store,
  nodeModulesDir: string,
  cb: (err: NodeJS.ErrnoException[] | null) => void,
) {
  console.debug('digestNewPackages:', nodeModulesDir)
  let waitGroup = new WaitGroup()
  let newPackages = new PackageVersions()
  waitGroup.addPending()
  collectAllNodeModules(store, nodeModulesDir, newPackages, err => {
    console.log('finished collectAllNodeModules:', {
      nodeModulesDir,
      newPackages,
      err,
    })
    newPackages.forEach((packageName, exactVersion) => {
      let packageDir = store.getPackageDir(packageName, exactVersion)
      waitGroup.addPending()
      console.debug('install new package:', packageDir)
      installPackageDir(store, { cwd: packageDir, dev: false }, err => {
        waitGroup.addResult(err)
      })
    })
    waitGroup.addResult(err)
  })
  waitGroup.hookCallback(cb)
}

function collectAllNodeModules(
  store: Store,
  nodeModulesDir: string,
  newPackages: PackageVersions,
  cb: (err: NodeJS.ErrnoException[] | null) => void,
) {
  console.debug('collectAllNodeModules:', nodeModulesDir)
  let waitGroup = new WaitGroup()
  collectNodeModules(store, waitGroup, newPackages, nodeModulesDir)
  waitGroup.hookCallback(cb)
}

function collectNodeModules(
  store: Store,
  waitGroup: WaitGroup,
  newPackages: PackageVersions,
  nodeModulesDir: string,
) {
  readdir(waitGroup, nodeModulesDir, filenames => {
    filenames.forEach(filename => {
      if (filename[0] === '.') return
      if (filename[0] !== '@') {
        let packageDir = path.join(nodeModulesDir, filename)
        collectPackage(store, waitGroup, newPackages, packageDir)
        return
      }
      let orgDir = path.join(nodeModulesDir, filename)
      readdir(waitGroup, orgDir, filenames => {
        filenames.forEach(filename => {
          let packageDir = path.join(orgDir, filename)
          collectPackage(store, waitGroup, newPackages, packageDir)
        })
      })
    })
  })
}

function collectPackage(
  store: Store,
  waitGroup: WaitGroup,
  newPackages: PackageVersions,
  packageDir: string,
) {
  let file = path.join(packageDir, 'package.json')
  readPackageFile(waitGroup, file, ({ name, version }) => {
    waitGroup.addPending()
    if (!name)
      return waitGroup.addResult(new Error(`missing package name: ${file}`))
    if (!version)
      return waitGroup.addResult(new Error(`missing package version: ${file}`))
    let storePackageDir = store.getPackageDir(name, version)
    let next = () => {
      mv(waitGroup, packageDir, storePackageDir, () => {
        newPackages.addPackageVersion(name, version)
        store.addPackageVersion(name, version)
        let nodeModulesDir = path.join(packageDir, 'node_modules')
        waitGroup.addPending()
        fs.access(nodeModulesDir, cannotAccess => {
          if (!cannotAccess) {
            collectNodeModules(store, waitGroup, newPackages, nodeModulesDir)
          }
          waitGroup.addResult(null)
        })
      })
      waitGroup.addResult(null)
    }
    if (!name.includes('/')) {
      next()
      return
    }
    let parentDir = path.dirname(storePackageDir)
    mkdir(waitGroup, parentDir, next)
  })
}

function readdir(
  waitGroup: WaitGroup,
  dir: string,
  cb: (filenames: string[]) => void,
) {
  waitGroup.addPending()
  fs.readdir(dir, (err, filenames) => {
    if (!err) {
      cb(filenames)
    }
    waitGroup.addResult(err)
  })
}

function mkdir(waitGroup: WaitGroup, dir: string, cb: () => void) {
  waitGroup.addPending()
  fs.mkdir(dir, { recursive: true }, err => {
    if (!err) cb()
    waitGroup.addResult(err)
  })
}

class InstallPackageError extends Error {
  constructor(
    error: Error,
    public tmpDir: string,
    public dependencies: Dependencies,
    public stdout: string,
    public stderr: string,
  ) {
    super(error.message)
  }
}

function npmInstall(
  waitGroup: WaitGroup,
  dir: string,
  dependencies: Dependencies,
  cb: () => void,
) {
  let file = path.join(dir, 'package.json')
  writePackageFile(waitGroup, file, { dependencies }, () => {
    waitGroup.addPending()
    child_process.exec('npx npm i', { cwd: dir }, (err, stdout, stderr) => {
      if (!err) cb()
      waitGroup.addResult(
        err
          ? new InstallPackageError(err, dir, dependencies, stdout, stderr)
          : null,
      )
    })
  })
}

function readPackageFile(
  waitGroup: WaitGroup,
  file: string,
  cb: (json: PackageJSON) => void,
) {
  waitGroup.addPending()
  fs.readFile(file, (err, data) => {
    if (!err) {
      let json: PackageJSON
      try {
        json = JSON.parse(data.toString())
        cb(json)
      } catch (error) {
        err = new Error(`Failed to parse json: ${file}`)
      }
    }
    waitGroup.addResult(err)
  })
}

function writePackageFile(
  waitGroup: WaitGroup,
  file: string,
  json: PackageJSON,
  cb: () => void,
) {
  let text = JSON.stringify(json)
  waitGroup.addPending()
  fs.writeFile(file, text, err => {
    if (!err) cb()
    waitGroup.addResult(err)
  })
}

class MvError extends Error {
  constructor(
    error: Error,
    public src: string,
    public dest: string,
    public stdout: string,
    public stderr: string,
  ) {
    super(error.message)
  }
}

function mv(waitGroup: WaitGroup, src: string, dest: string, cb: () => void) {
  waitGroup.addPending()
  let cmd = `mv ${JSON.stringify(src)} ${JSON.stringify(dest)}`
  child_process.exec(cmd, (err, stdout, stderr) => {
    if (err && err.message.includes('Directory not empty')) {
      err = null
    }
    if (!err) cb()
    waitGroup.addResult(
      err ? new MvError(err, src, dest, stdout, stderr) : null,
    )
  })
}

function makeSymbolicLink(
  waitGroup: WaitGroup,
  src: string,
  dest: string,
  cb: () => void,
) {
  waitGroup.addPending()
  fs.symlink(src, dest, err => {
    if (err && err.code === 'EEXIST') {
      err = null
    }
    if (!err) cb()
    waitGroup.addResult(err)
  })
}

function linkPackage(
  store: Store,
  waitGroup: WaitGroup,
  nodeModulesDir: string,
  packageName: string,
  exactVersion: string,
  cb: () => void,
) {
  let src = store.getPackageDir(packageName, exactVersion)
  let dest = path.join(nodeModulesDir, packageName)
  let next = () => {
    makeSymbolicLink(waitGroup, src, dest, cb)
  }
  if (!packageName.includes('/')) {
    next()
    return
  }
  let parentDir = path.dirname(dest)
  mkdir(waitGroup, parentDir, next)
}

type PackageJSON = {
  name?: string
  version?: string
  dependencies?: Dependencies
  devDependencies?: Dependencies
}

type Dependencies = {
  // package name -> version range
  [name: string]: string
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
