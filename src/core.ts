import { execSync } from 'child_process'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  rmSync,
  realpathSync,
  statSync,
  accessSync,
  closeSync,
  openSync,
  readSync,
  writeSync,
  chmodSync,
  lstatSync,
} from 'fs'
import fs from 'fs'
import { dirname, join, resolve } from 'path'
import semver from 'semver'
import { EOL } from 'os'

type Options = {
  storeDir: string
  cwd: string
  dev: boolean
  verbose: boolean
  installDeps: string[]
  installDevDeps: string[]
  uninstallDeps: string[]
  recursive: boolean
  legacyPeerDeps: boolean
}

export function main(options: Options) {
  let storeDir = resolve(options.storeDir)
  mkdirSync(storeDir, { recursive: true })

  let storePackageVersions = scanStorePackages(storeDir)
  let collectedNodeModules = new Set<string>()
  let linkedDepPackageDirs = new Set<string>()
  let context: Context = {
    options,
    storeDir,
    storePackageVersions,
    collectedNodeModules,
    linkedDepPackageDirs,
  }

  initPackageFile(options.cwd)

  if (options.recursive) {
    scanPackageRecursively(context, options.cwd, new Set())
    return
  }

  installPackages(context, options.cwd)
}

function scanStorePackages(storeDir: string) {
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

  return storePackageVersions
}

type Context = {
  options: Options
  storeDir: string
  storePackageVersions: Map<string, Set<string>>
  collectedNodeModules: Set<string>
  linkedDepPackageDirs: Set<string>
}

function initPackageFile(packageDir: string) {
  let packageFile = join(packageDir, 'package.json')
  if (!existsSync(packageFile)) {
    writeFileSync(packageFile, '{}')
  }
}

function installPackages(context: Context, packageDir: string) {
  let {
    storeDir,
    storePackageVersions,
    options,
    collectedNodeModules,
    linkedDepPackageDirs,
  } = context

  let packageFile = join(packageDir, 'package.json')
  let packageJson = JSON.parse(
    readFileSync(packageFile).toString(),
  ) as PackageJSON
  let { dependencies, devDependencies } = packageJson

  let nodeModulesDir = join(packageDir, 'node_modules')
  mkdirSync(nodeModulesDir, { recursive: true })

  let usedPackageVersions = new Map<string, Set<string>>()

  let newDeps: Dependencies = {}
  let hasNewDeps = false
  let newInstallDeps: Dependencies = {}
  function installDeps(deps: Dependencies, installDeps: string[]) {
    function registerVersion(name: string, version: string) {
      deps[name] = version
      newInstallDeps[name] = version
    }
    installDeps: for (let dep of installDeps) {
      if (isLinkDep(dep)) {
        let name: string | null = null
        name = linkDepPackage(linkedDepPackageDirs, nodeModulesDir, name, dep)
        getVersions(usedPackageVersions, name).add(dep)
        deps[name] = dep
        continue
      }
      let { name, version } = parseDep(dep)

      let storeVersions = getVersions(storePackageVersions, name)
      let exactVersion = semver.maxSatisfying(
        Array.from(storeVersions),
        version || '*',
      )
      if (exactVersion) {
        linkStorePackage(storeDir, nodeModulesDir, name, exactVersion)
        registerVersion(name, `${exactVersion}`)
        continue
      }

      let npmVersions = npmViewVersions(dep)
      if (npmVersions.length === 0) throw new Error('No versions found: ' + dep)
      npmVersions.reverse()
      for (let exactVersion of npmVersions) {
        if (storeVersions.has(exactVersion)) {
          linkStorePackage(storeDir, nodeModulesDir, name, exactVersion)
          registerVersion(name, version || `^${exactVersion}`)
          continue installDeps
        }
      }
      exactVersion = npmVersions[0]
      version = version || `^${exactVersion}`
      newDeps[name] = version
      hasNewDeps = true
      registerVersion(name, version)
    }
  }
  let hasUpdatedPackageJson = false
  if (options.installDeps.length > 0) {
    let deps = dependencies ? { ...dependencies } : {}
    installDeps(deps, options.installDeps)
    packageJson.dependencies = sortDeps(deps)
    hasUpdatedPackageJson = true
  }
  if (options.installDevDeps.length > 0) {
    let deps = devDependencies ? { ...devDependencies } : {}
    installDeps(deps, options.installDevDeps)
    packageJson.devDependencies = sortDeps(deps)
    hasUpdatedPackageJson = true
  }
  if (options.uninstallDeps.length > 0) {
    if (options.verbose) {
      console.log('uninstalling packages:', options.uninstallDeps)
    }
    for (let dep of options.uninstallDeps) {
      let { name } = parseDep(dep)
      uninstallDep(nodeModulesDir, name)
      if (packageJson.dependencies && name in packageJson.dependencies) {
        delete packageJson.dependencies[name]
        hasUpdatedPackageJson = true
        if (dependencies) {
          delete dependencies[name]
        }
      }
      if (packageJson.devDependencies && name in packageJson.devDependencies) {
        delete packageJson.devDependencies[name]
        hasUpdatedPackageJson = true
        if (devDependencies) {
          delete devDependencies[name]
        }
      }
    }
  }
  if (hasUpdatedPackageJson) {
    writeFileSync(packageFile, JSON.stringify(packageJson, null, 2))
  }

  function addPackageDep(name: string, versionRange: string) {
    if (isLinkDep(versionRange)) {
      linkDepPackage(linkedDepPackageDirs, nodeModulesDir, name, versionRange)
      getVersions(usedPackageVersions, name).add(versionRange)
      return
    }
    let versions = Array.from(getVersions(storePackageVersions, name))
    let exactVersion = findLatestMatch(versionRange, versions)
    if (exactVersion) {
      linkStorePackage(storeDir, nodeModulesDir, name, exactVersion)
      return
    }
    newDeps[name] = versionRange
    hasNewDeps = true
  }
  if (devDependencies && options.dev) {
    for (let name in devDependencies) {
      let version = devDependencies[name]
      addPackageDep(name, version)
    }
  }
  if (dependencies) {
    for (let name in dependencies) {
      let version = dependencies[name]
      addPackageDep(name, version)
    }
  }

  function collectNodeModules(nodeModulesDir: string) {
    // detect cyclic dependencies
    let realNodeModulesDir = realpathSync(nodeModulesDir)
    if (collectedNodeModules.has(realNodeModulesDir)) return
    collectedNodeModules.add(realNodeModulesDir)
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
    let stats = lstatSync(packageDir)
    if (stats.isSymbolicLink()) return
    let {
      json: { name, version },
      file,
    } = getPackageJson(packageDir)
    if (!name) throw new Error(`missing package name in ${file}`)
    if (!version) throw new Error(`missing package version in ${file}`)
    getVersions(usedPackageVersions, name).add(version)
    let realPackageDir = realpathSync(packageDir)
    if (linkedDepPackageDirs.has(realPackageDir)) return
    getVersions(storePackageVersions, name).add(version)
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
    npmInstall(context, tmpDir, newDeps)
    let tmpNodeModulesDir = join(tmpDir, 'node_modules')
    collectNodeModules(tmpNodeModulesDir)
  }

  collectNodeModules(nodeModulesDir)

  if (options.verbose && usedPackageVersions.size > 0) {
    console.log('linking packages:', usedPackageVersions)
  }
  let linkedDeps = new Set<string>()
  function linkDeps(packageDir: string, dependencies: Dependencies) {
    // detect cyclic dependencies
    let realPackageDir = realpathSync(packageDir)
    if (linkedDeps.has(realPackageDir)) return
    linkedDeps.add(realPackageDir)
    let nodeModulesDir = join(packageDir, 'node_modules')
    let hasNodeModulesDir = false
    for (let name in dependencies) {
      if (!hasNodeModulesDir) {
        mkdirSync(nodeModulesDir, { recursive: true })
        hasNodeModulesDir = true
      }
      let versionRange = dependencies[name]
      linkDep(nodeModulesDir, name, versionRange)
    }
  }
  // nodeModulesDir -> name -> depPackageDir
  let depPackageDirs = new Map<string, Map<string, string>>()
  function linkDep(nodeModulesDir: string, name: string, versionRange: string) {
    if (isLinkDep(versionRange)) {
      let depPackageDir = parseLinkDepPackageDir(versionRange)
      getMap2(depPackageDirs, nodeModulesDir).set(name, depPackageDir)
      let bin = getPackageJson(depPackageDir).json.bin
      linkBin(nodeModulesDir, depPackageDir, name, bin)
      return
    }
    let versions = Array.from(getVersions(storePackageVersions, name))
    let exactVersion = findLatestMatch(versionRange, versions)
    if (!exactVersion)
      throw new Error(`missing package ${name} ${versionRange}`)
    let depPackageDir = linkStorePackage(
      storeDir,
      nodeModulesDir,
      name,
      exactVersion,
    )
    getMap2(depPackageDirs, nodeModulesDir).set(name, depPackageDir)
    let { dependencies, bin } = getPackageJson(depPackageDir).json
    if (dependencies) {
      linkDeps(depPackageDir, dependencies)
    }
    linkBin(nodeModulesDir, depPackageDir, name, bin)
  }

  for (let name in newInstallDeps) {
    let version = newInstallDeps[name]
    linkDep(nodeModulesDir, name, version)
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

  let linkedPeerDeps = new Set<string>()
  function linkPeerDeps(nodeModulesDir: string) {
    try {
      let realNodeModulesDir = realpathSync(nodeModulesDir)
      if (linkedPeerDeps.has(realNodeModulesDir)) return
      linkedPeerDeps.add(realNodeModulesDir)
    } catch (error) {
      return
    }
    let parentDeps = getMap2(depPackageDirs, nodeModulesDir)
    parentDeps.forEach(depPackageDir => {
      let { json } = getPackageJson(depPackageDir)
      let nodeModulesDir = join(depPackageDir, 'node_modules')
      mkdirSync(nodeModulesDir, { recursive: true })
      let linkedPeerDeps = new Set<string>()
      for (let name in json.peerDependencies) {
        linkPeerDep(parentDeps, nodeModulesDir, name)
        linkedPeerDeps.add(name)
      }
      for (let name in json.peerDependenciesMeta) {
        if (linkedPeerDeps.has(name)) return
        linkPeerDep(parentDeps, nodeModulesDir, name)
      }
      linkPeerDeps(nodeModulesDir)
    })
  }
  linkPeerDeps(nodeModulesDir)
}

function linkPeerDep(
  parentDeps: Map<string, string>,
  nodeModulesDir: string,
  name: string,
) {
  let peerDepDir = parentDeps.get(name)
  if (!peerDepDir) return
  let depDir = join(nodeModulesDir, name)
  if (name.includes('/')) {
    let parentDir = dirname(depDir)
    mkdirSync(parentDir, { recursive: true })
  }
  makeSymbolicLink(peerDepDir, depDir)
}

function getVersions(map: Map<string, Set<string>>, name: string) {
  let set = map.get(name)
  if (!set) {
    set = new Set()
    map.set(name, set)
  }
  return set
}

function getMap2(map: Map<string, Map<string, string>>, key: string) {
  let map2 = map.get(key)
  if (!map2) {
    map2 = new Map()
    map.set(key, map2)
  }
  return map2
}

type PackageJSON = {
  name?: string
  version?: string
  bin?: PackageBin
  dependencies?: Dependencies
  devDependencies?: Dependencies
  peerDependencies?: Dependencies
  peerDependenciesMeta?: {
    // package name -> optional
    [name: string]: {
      optional: boolean
    }
  }
}

type PackageBin = string | Record<string, string>

type Dependencies = {
  // package name -> version range
  [name: string]: string
}

// packageDir -> PackageJSON
let jsonCache = new Map<string, { json: PackageJSON; file: string }>()
function getPackageJson(packageDir: string) {
  let entry = jsonCache.get(packageDir)
  if (entry) return entry
  let file = join(packageDir, 'package.json')
  let json = JSON.parse(readFileSync(file).toString()) as PackageJSON
  entry = { json, file }
  jsonCache.set(packageDir, entry)
  return entry
}

function findLatestMatch(versionRange: string, exactVersions: string[]) {
  if (versionRange === 'latest') {
    versionRange = '*'
  }
  return semver.maxSatisfying(exactVersions, versionRange)
}

function makeSymbolicLink(src: string, dest: string) {
  try {
    symlinkSync(src, dest)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return
    }
    throw err
  }
}

function linkStorePackage(
  storeDir: string,
  nodeModulesDir: string,
  packageName: string,
  exactVersion: string,
) {
  let src = join(storeDir, `${packageName}@${exactVersion}`)
  let dest = join(nodeModulesDir, packageName)
  linkPackage(packageName, src, dest)
  return src
}

function linkDepPackage(
  linkedDepPackageDirs: Set<string>,
  nodeModulesDir: string,
  packageName: string | null,
  dep: string,
): string {
  let src = parseLinkDepPackageDir(dep)
  if (!packageName) {
    let { json, file } = getPackageJson(src)
    if (!json.name) throw new Error(`missing package name in ${file}`)
    packageName = json.name
  }
  let dest = join(nodeModulesDir, packageName)
  linkPackage(packageName, src, dest)
  let packageDir = realpathSync(dest)
  linkedDepPackageDirs.add(packageDir)
  return packageName
}

function linkPackage(packageName: string, src: string, dest: string) {
  if (packageName.includes('/')) {
    let parentDir = dirname(dest)
    mkdirSync(parentDir, { recursive: true })
  }
  makeSymbolicLink(src, dest)
}

function linkBin(
  nodeModulesDir: string,
  packageDir: string,
  name: string,
  bin: PackageBin | undefined,
) {
  if (!bin) return
  let binDir = join(nodeModulesDir, '.bin')
  mkdirSync(binDir, { recursive: true })
  if (typeof bin === 'string') {
    if (name[0] === '@') {
      name = name.split('/')[1]
    }
    linkBinFile(binDir, packageDir, name, bin)
    return
  }
  for (let name in bin) {
    let filename = bin[name]
    linkBinFile(binDir, packageDir, name, filename)
  }
}
function linkBinFile(
  binDir: string,
  packageDir: string,
  name: string,
  filename: string,
) {
  let src = join(packageDir, filename)
  let dest = join(binDir, name)
  setBinPermission(src)
  makeSymbolicLink(src, dest)
}

let setBinPermissionCache = new Set<string>()
let binPrefix = Buffer.from('#!/usr/bin/env node' + EOL)
let binPrefixCode = binPrefix[0]
let binBuffer = Buffer.alloc(1)
let binFlag = fs.constants.X_OK
function setBinPermission(file: string) {
  if (setBinPermissionCache.has(file)) return
  setBinPermissionCache.add(file)
  try {
    accessSync(file, binFlag)
    return
  } catch (error) {
    /* read first byte */
    binBuffer[0] = 0
    let fd = openSync(file, 'r')
    readSync(fd, binBuffer)
    closeSync(fd)

    /* insert executable line if not already present */
    if (binBuffer[0] !== binPrefixCode) {
      let content = readFileSync(file)
      let tmpFile = file + '.tmp'
      fd = openSync(tmpFile, 'w+')
      writeSync(fd, binPrefix)
      writeSync(fd, content)
      closeSync(fd)
      mv(tmpFile, file)
    }

    /* set executable permission */
    chmodSync(file, 0o755)
  }
}

function npmInstall(context: Context, cwd: string, dependencies: Dependencies) {
  let cmd = 'npx npm i'
  if (context.options.legacyPeerDeps) {
    cmd += ' --legacy-peer-deps'
  }
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

function parseDep(dep: string): { name: string; version: string | null } {
  if (dep.length === 0) {
    throw new Error('Invalid dependency format (empty string)')
  }
  let parts = dep.split('@')
  switch (parts.length) {
    case 1:
      // e.g. semver
      return { name: parts[0], version: null }
    case 2:
      if (parts[0].length === 0) {
        // e.g. @types/semver
        return { name: '@' + parts[1], version: null }
      }
      // e.g. semver@^7.3.7
      return {
        name: parts[0],
        version: parts[1] || null,
      }
    case 3:
      if (parts[0].length > 0)
        throw new Error('Invalid dependency format: ' + JSON.stringify(dep))
      // e.g. @types/semver@^7.3.9
      return {
        name: '@' + parts[1],
        version: parts[2] || null,
      }
    default:
      throw new Error('Invalid dependency format: ' + JSON.stringify(dep))
  }
}

function npmViewVersions(dep: string): string[] {
  let cmd = `npm view ${JSON.stringify(dep)} version`
  let stdout = execSync(cmd)
  let versions: string[] = []
  stdout
    .toString()
    .split('\n')
    .forEach(line => {
      // e.g. `semver@1.0.8 '1.0.8'`
      let version = line.trim().split(' ').pop()
      if (!version) return
      versions.push(version.replace(/'/g, ''))
    })
  return versions
}

function uninstallDep(nodeModulesDir: string, name: string) {
  let dir = join(nodeModulesDir, name)
  rmSync(dir, { recursive: true, force: true })
}

function sortDeps(deps: Dependencies) {
  let newDeps: Dependencies = {}
  Object.keys(deps)
    .sort()
    .forEach(name => {
      let version = deps[name]
      newDeps[name] = version
    })
  return newDeps
}

function scanPackageRecursively(
  context: Context,
  dir: string,
  visited: Set<string>,
) {
  let realDir = realpathSync(dir)
  if (visited.has(realDir)) return
  visited.add(realDir)
  for (let filename of readdirSync(dir)) {
    if (filename[0] === '.' || filename === 'node_modules') continue
    let file = join(dir, filename)
    let stat = statSync(file)
    if (filename === 'package.json' && stat.isFile()) {
      if (context.options.verbose) {
        console.log('installing packages in:', dir)
      }
      installPackages(context, dir)
      continue
    }
    if (stat.isDirectory()) {
      scanPackageRecursively(context, file, visited)
      continue
    }
  }
}

function isLinkDep(dep: string): boolean {
  return dep.startsWith('link:') || dep.startsWith('file:')
}

function parseLinkDepPackageDir(dep: string): string {
  return dep.slice('link:'.length)
}
