import { execSync } from 'child_process'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  rmSync,
} from 'fs'
import { dirname, join, resolve } from 'path'
import semver from 'semver'

export function main(options: {
  storeDir: string
  cwd: string
  dev: boolean
  verbose: boolean
}) {
  let storeDir = resolve(options.storeDir)
  mkdirSync(storeDir, { recursive: true })

  // package name -> exact versions
  let storePackageVersions = new Map<string, Set<string>>()

  for (let dirname of readdirSync(storeDir)) {
    if (dirname[0] !== '@') {
      let [name, version] = dirname.split('@')
      getVersions(storePackageVersions, name).add(version)
      continue
    }
    let orgName = dirname
    let orgDir = join(storeDir, dirname)
    for (let dirname of readdirSync(orgDir)) {
      let [name, version] = dirname.split('@')
      name = `${orgName}/${name}`
      getVersions(storePackageVersions, name).add(version)
    }
  }

  let file = join(options.cwd, 'package.json')
  let { dependencies, devDependencies } = JSON.parse(
    readFileSync(file).toString(),
  ) as PackageJSON

  let nodeModulesDir = join(options.cwd, 'node_modules')
  mkdirSync(nodeModulesDir, { recursive: true })

  let newDeps: Dependencies = {}
  let hasNewDeps = false
  function addDep(name: string, versionRange: string) {
    let versions = Array.from(getVersions(storePackageVersions, name))
    let exactVersion = findLatestMatch(versionRange, versions)
    if (exactVersion) {
      linkPackage(storeDir, nodeModulesDir, name, exactVersion)
      return
    }
    newDeps[name] = versionRange
    hasNewDeps = true
  }
  if (devDependencies && options.dev) {
    for (let name in devDependencies) {
      let version = devDependencies[name]
      addDep(name, version)
    }
  }
  if (dependencies) {
    for (let name in dependencies) {
      let version = dependencies[name]
      addDep(name, version)
    }
  }

  let usedPackageVersions = new Map<string, Set<string>>()
  function collectNodeModules(nodeModulesDir: string) {
    for (let dirname of readdirSync(nodeModulesDir)) {
      if (dirname[0] === '.') continue
      if (dirname[0] !== '@') {
        let packageDir = join(nodeModulesDir, dirname)
        collectPackage(packageDir)
        continue
      }
      let orgName = dirname
      let orgDir = join(nodeModulesDir, orgName)
      for (let dirname of readdirSync(orgDir)) {
        let packageDir = join(orgDir, dirname)
        collectPackage(packageDir)
      }
    }
  }
  function collectPackage(packageDir: string) {
    let file = join(packageDir, 'package.json')
    let { name, version } = JSON.parse(
      readFileSync(file).toString(),
    ) as PackageJSON
    if (!name) throw new Error(`missing package name in ${file}`)
    if (!version) throw new Error(`missing package version in ${file}`)
    getVersions(storePackageVersions, name).add(version)
    getVersions(usedPackageVersions, name).add(version)
    let nodeModulesDir = join(packageDir, 'node_modules')
    if (existsSync(nodeModulesDir)) {
      collectNodeModules(nodeModulesDir)
    }
    let key = `${name}@${version}`
    let storePackageDir = join(storeDir, key)
    if (existsSync(storePackageDir)) {
      rmSync(packageDir, { recursive: true })
      return
    }
    if (name.includes('/')) {
      let parentDir = dirname(storePackageDir)
      mkdirSync(parentDir, { recursive: true })
    }
    mv(packageDir, storePackageDir)
  }

  if (hasNewDeps) {
    if (options.verbose) {
      console.log('installing new packages:', newDeps)
    }
    let tmpDir = join(nodeModulesDir, '.tmp')
    mkdirSync(tmpDir, { recursive: true })
    npmInstall(tmpDir, newDeps)
    let tmpNodeModulesDir = join(tmpDir, 'node_modules')
    collectNodeModules(tmpNodeModulesDir)
  }

  collectNodeModules(nodeModulesDir)

  if (options.verbose && usedPackageVersions.size > 0) {
    console.log('linking packages:', usedPackageVersions)
  }
  function linkDeps(packageDir: string) {
    let file = join(packageDir, 'package.json')
    let { dependencies } = JSON.parse(
      readFileSync(file).toString(),
    ) as PackageJSON
    if (!dependencies) return
    let nodeModulesDir = join(packageDir, 'node_modules')
    let hasDir = false
    for (let name in dependencies) {
      if (!hasDir) {
        mkdirSync(nodeModulesDir, { recursive: true })
        hasDir = true
      }
      let versionRange = dependencies[name]
      linkDep(nodeModulesDir, name, versionRange)
    }
  }
  function linkDep(nodeModulesDir: string, name: string, versionRange: string) {
    let versions = Array.from(getVersions(storePackageVersions, name))
    let exactVersion = findLatestMatch(versionRange, versions)
    if (!exactVersion)
      throw new Error(`missing package ${name} ${versionRange}`)
    let depPackageDir = linkPackage(
      storeDir,
      nodeModulesDir,
      name,
      exactVersion,
    )
    linkDeps(depPackageDir)
  }

  if (devDependencies && options.dev) {
    for (let name in devDependencies) {
      let version = devDependencies[name]
      linkDep(nodeModulesDir, name, version)
    }
  }
  if (dependencies) {
    for (let name in dependencies) {
      let version = dependencies[name]
      linkDep(nodeModulesDir, name, version)
    }
  }
}

function getVersions(map: Map<string, Set<string>>, name: string) {
  let set = map.get(name)
  if (!set) {
    set = new Set()
    map.set(name, set)
  }
  return set
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

function makeSymbolicLink(src: string, dest: string) {
  try {
    symlinkSync(src, dest)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return
    }
    console.debug(err)
    throw err
  }
}

function linkPackage(
  storeDir: string,
  nodeModulesDir: string,
  packageName: string,
  exactVersion: string,
) {
  let src = join(storeDir, `${packageName}@${exactVersion}`)
  let dest = join(nodeModulesDir, packageName)
  if (packageName.includes('/')) {
    let parentDir = dirname(dest)
    mkdirSync(parentDir, { recursive: true })
  }
  makeSymbolicLink(src, dest)
  return src
}

function npmInstall(cwd: string, dependencies: Dependencies) {
  let cmd = 'npx npm i'
  let file = join(cwd, 'package.json')
  let json: PackageJSON = { dependencies }
  let text = JSON.stringify(json)
  writeFileSync(file, text)
  execSync(cmd, { cwd })
}

function mv(src: string, dest: string) {
  let cmd = `mv ${JSON.stringify(src)} ${JSON.stringify(dest)}`
  execSync(cmd)
}
