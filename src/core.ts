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
} from 'fs'
import { dirname, join, resolve } from 'path'
import semver from 'semver'

type Options = {
  storeDir: string
  cwd: string
  dev: boolean
  verbose: boolean
  installDeps: string[]
  installDevDeps: string[]
  uninstallDeps: string[]
  recursive: boolean
}

export function main(options: Options) {
  let storeDir = resolve(options.storeDir)
  mkdirSync(storeDir, { recursive: true })

  let storePackageVersions = scanStorePackages(storeDir)
  let collectedNodeModules = new Set<string>()
  let context: Context = {
    options,
    storeDir,
    storePackageVersions,
    collectedNodeModules,
  }

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
}

function installPackages(context: Context, packageDir: string) {
  let { storeDir, storePackageVersions, options, collectedNodeModules } =
    context

  let packageFile = join(packageDir, 'package.json')
  let packageJson = JSON.parse(
    readFileSync(packageFile).toString(),
  ) as PackageJSON
  let { dependencies, devDependencies } = packageJson

  let nodeModulesDir = join(packageDir, 'node_modules')
  mkdirSync(nodeModulesDir, { recursive: true })

  let newDeps: Dependencies = {}
  let hasNewDeps = false
  let newInstallDeps: Dependencies = {}
  function addInstallDep(dep: string): { name: string; version: string } {
    let { name, version } = parseDep(dep)
    let storeVersions = getVersions(storePackageVersions, name)
    let exactVersion = semver.maxSatisfying(
      Array.from(storeVersions),
      version || '*',
    )
    if (exactVersion) {
      linkPackage(storeDir, nodeModulesDir, name, exactVersion)
      return { name, version: version || `^${exactVersion}` }
    }

    let npmVersions = npmViewVersions(dep)
    if (npmVersions.length === 0) throw new Error('No versions found: ' + dep)
    npmVersions.reverse()
    for (let exactVersion of npmVersions) {
      if (storeVersions.has(exactVersion)) {
        linkPackage(storeDir, nodeModulesDir, name, exactVersion)
        return { name, version: version || `^${exactVersion}` }
      }
    }
    exactVersion = npmVersions[0]
    version = version || `^${exactVersion}`
    newDeps[name] = version
    hasNewDeps = true
    return { name, version: version }
  }
  let hasUpdatedPackageJson = false
  if (options.installDeps.length > 0) {
    let deps = dependencies ? { ...dependencies } : {}
    for (let dep of options.installDeps) {
      let { name, version } = addInstallDep(dep)
      deps[name] = version
      newInstallDeps[name] = version
    }
    packageJson.dependencies = sortDeps(deps)
    hasUpdatedPackageJson = true
  }
  if (options.installDevDeps.length > 0) {
    let deps = devDependencies ? { ...devDependencies } : {}
    for (let dep of options.installDevDeps) {
      let { name, version } = addInstallDep(dep)
      deps[name] = version
      newInstallDeps[name] = version
    }
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
      addPackageDep(name, version)
    }
  }
  if (dependencies) {
    for (let name in dependencies) {
      let version = dependencies[name]
      addPackageDep(name, version)
    }
  }

  let usedPackageVersions = new Map<string, Set<string>>()
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
    let {
      json: { name, version },
      file,
    } = getPackageJson(packageDir)
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
  let hasBinDir = false
  let binDir = join(nodeModulesDir, '.bin')
  let linkedDeps = new Set<string>()
  function linkDeps(packageDir: string) {
    // detect cyclic dependencies
    let realPackageDir = realpathSync(packageDir)
    if (linkedDeps.has(realPackageDir)) return
    linkedDeps.add(realPackageDir)
    let {
      json: { dependencies, bin },
    } = getPackageJson(packageDir)
    if (!dependencies) return
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
    return bin
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
    let bin = linkDeps(depPackageDir)
    if (bin) {
      if (!hasBinDir) {
        mkdirSync(binDir, { recursive: true })
        hasBinDir = true
      }
      linkBin(binDir, depPackageDir, name, bin)
    }
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
  bin?: PackageBin
  dependencies?: Dependencies
  devDependencies?: Dependencies
  peerDependencies?: Dependencies
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

function linkBin(
  binDir: string,
  packageDir: string,
  name: string,
  bin: PackageBin,
) {
  if (!bin) return
  if (typeof bin === 'string') {
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
  makeSymbolicLink(src, dest)
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
  console.debug('uninstall', { name, dir })
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
