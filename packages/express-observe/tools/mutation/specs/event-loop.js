'use strict'

// Optional eventLoopDelayMs (ADR-0009 and addendum).
module.exports = {
  title: 'eventLoopDelayMs sampler',
  tests: ['test/event-loop.test.js'],
  mutations: [
    { name: 'overdue tick not counted', file: 'src/event-loop.js', from: '    let max = nowMs() - expected\n', to: '    let max = 0\n' },
    { name: 'no look-back before middleware entry', file: 'src/index.js', from: 'sampler.maxSince(Number(state.startedAt) / 1e6 - sampler.resolutionMs)', to: 'sampler.maxSince(Number(state.startedAt) / 1e6)' },
    { name: 'sampler never started', file: 'src/index.js', from: '      if (sampler !== null) sampler.start()\n', to: '' },
    { name: 'lateness not recorded', file: 'src/event-loop.js', from: '    lags[head] = lag > 0 ? lag : 0\n', to: '    lags[head] = 0\n' },
    { name: 'no-measurement case reported as 0 instead of null', file: 'src/event-loop.js', from: '    if (count === 0 && max <= 0) return null\n', to: '' }
  ]
}
