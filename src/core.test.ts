import { expect } from 'chai'
import semver from 'semver'

describe('VersionFilter', () => {
  function getVersionFilter(versionRange: string) {
    return (exactVersion: string) =>
      semver.satisfies(exactVersion, versionRange)
  }
  it('should only allow patch version update with "~" prefix', () => {
    let filter = getVersionFilter('~7.20.3')
    expect(filter('7.20.9')).to.be.true
    expect(filter('7.21.0')).to.be.false

    filter = getVersionFilter('~7.20')
    expect(filter('7.20.9')).to.be.true
    expect(filter('7.21.0')).to.be.false
  })
  it('should only allow minor version update with "^" prefix', () => {
    let filter = getVersionFilter('^7.20.3')
    expect(filter('7.21.0')).to.be.true
    expect(filter('8.0.0')).to.be.false

    filter = getVersionFilter('^7')
    expect(filter('7.21.0')).to.be.true
    expect(filter('8.0.0')).to.be.false
  })
  it('should allow any version with "*" pattern', () => {
    let filter = getVersionFilter('*')
    expect(filter('8.0.0')).to.be.true
  })
  it('should allow wild-cast version update with "*" suffix', () => {
    let filter = getVersionFilter('7.*')
    expect(filter('7.20.9')).to.be.true
    expect(filter('8.0.0')).to.be.false
  })
  it('should allow wild-cast version update without "*" suffix', () => {
    let filter = getVersionFilter('7')
    expect(filter('7.20.9')).to.be.true
    expect(filter('8.0.0')).to.be.false
  })
  it('should parse version range', () => {
    let filter = getVersionFilter('>=3.0.0 <4.0.0')
    expect(filter('3.2.7')).to.be.true
    expect(filter('4.0.0')).to.be.false
  })
})
