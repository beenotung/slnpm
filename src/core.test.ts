import { expect } from 'chai'
import { getVersionFilter } from './core'

describe('getVersionFilter', () => {
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
})
