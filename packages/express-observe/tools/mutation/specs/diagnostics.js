'use strict'

// getDiagnostics() counters (ADR-0010).
module.exports = {
  title: 'diagnostics counters',
  tests: ['test/diagnostics.test.js'],
  mutations: [
    { name: 'started not counted', file: 'src/index.js', from: '      counters.started++\n', to: '' },
    { name: 'interrupted counted as finished', file: 'src/index.js', from: '    else counters.interrupted++\n', to: '    else counters.finished++\n' },
    {
      name: 'terminations not counted when logging is disabled',
      file: 'src/index.js',
      from: '    if (finished) counters.finished++\n    else counters.interrupted++\n    if (deliver === null) return\n',
      to: '    if (deliver === null) return\n    if (finished) counters.finished++\n    else counters.interrupted++\n'
    },
    { name: 'second instance on the same request counted again', file: 'src/index.js', from: '    if (res[kState] !== undefined) return next()\n', to: '' },
    { name: 'emitted not counted', file: 'src/logger.js', from: '    counters.emitted++\n', to: '' },
    { name: 'dropped not counted', file: 'src/index.js', from: '      counters.dropped++\n', to: '' },
    { name: 'sink errors not counted', file: 'src/logger.js', from: '    counters.sinkErrors++\n', to: '' },
    { name: 'sink promises never leave pending', file: 'src/logger.js', from: '      counters.sinkPending--\n', to: '' },
    { name: 'thenable settled more than once', file: 'src/logger.js', from: '      if (settled) return false\n', to: '' },
    {
      name: 'rate-limited warnings not counted',
      file: 'src/logger.js',
      from: '    counters.warnings++\n    try {\n      const t = now()\n      if (t - lastAt < intervalMs) {\n        suppressed++\n        return\n      }\n',
      to: '    try {\n      const t = now()\n      if (t - lastAt < intervalMs) {\n        suppressed++\n        return\n      }\n      counters.warnings++\n'
    },
    { name: 'inFlight ignores interrupted requests', file: 'src/diagnostics.js', from: 'inFlight: c.started - c.finished - c.interrupted', to: 'inFlight: c.started - c.finished' }
  ]
}
