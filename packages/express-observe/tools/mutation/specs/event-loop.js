'use strict'

// Optional eventLoopDelayMs (ADR-0009 and addenda).
module.exports = {
  title: 'eventLoopDelayMs sampler',
  tests: ['test/event-loop.test.js'],
  mutations: [
    { name: 'overdue tick not counted', file: 'src/event-loop.js', from: '    let max = nowMs() - expected\n', to: '    let max = 0\n' },
    { name: 'no look-back before middleware entry', file: 'src/index.js', from: 'sampler.maxSince(Number(state.startedAt) / 1e6 - sampler.resolutionMs)', to: 'sampler.maxSince(Number(state.startedAt) / 1e6)' },
    { name: 'sampler never started', file: 'src/index.js', from: '        sampler.start()\n', to: '' },
    { name: 'lateness not recorded', file: 'src/event-loop.js', from: '    lags[head] = lag > 0 ? lag : 0\n', to: '    lags[head] = 0\n' },
    { name: 'no-measurement case reported as 0 instead of null', file: 'src/event-loop.js', from: '    if (count === 0 && max <= 0) return null\n', to: '' },
    { name: 'sampler never stops when idle', file: 'src/event-loop.js', from: '    if (idleStopMs > 0 && active === 0 && t - lastStartAt >= idleStopMs) stop()\n', to: '' },
    { name: 'sampler stops while a request is in flight', file: 'src/event-loop.js', from: 'if (idleStopMs > 0 && active === 0 && t - lastStartAt', to: 'if (idleStopMs > 0 && t - lastStartAt' },
    { name: 'old samples kept after a restart', file: 'src/event-loop.js', from: '    head = 0\n    count = 0\n', to: '' },
    { name: 'requests never released', file: 'src/index.js', from: '      if (state.sampling) sampler.release()\n', to: '' }
  ]
}
