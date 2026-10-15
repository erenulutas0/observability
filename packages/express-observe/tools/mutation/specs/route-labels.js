'use strict'

// Route labels never contain concrete request data (ADR-0001 decision 2, ADR-0003).
module.exports = {
  title: 'route labels and privacy',
  tests: ['test/route-template.test.js', 'test/privacy.test.js'],
  mutations: [
    { name: 'route and baseUrl read at termination instead of at match time', file: 'src/route-template.js', from: '  return () => captured\n', to: '  return () => snapshot(req.route)\n' },
    { name: 'unmatched mount falls back to the concrete baseUrl', file: 'src/route-template.js', from: '  if (prefix === null) return null\n', to: '  if (prefix === null) return matched.baseUrl + matched.path\n' },
    { name: 'mount literals compared case-sensitively', file: 'src/route-template.js', from: 'expected !== actual[i].toLowerCase()', to: 'expected !== actual[i]' },
    { name: 'explicit label accepted without validation', file: 'src/route-template.js', from: '  if (isLabel(local)) return local', to: "  if (typeof local === 'string') return local" }
  ]
}
