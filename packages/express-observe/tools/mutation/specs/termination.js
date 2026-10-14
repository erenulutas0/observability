'use strict'

// One record per request, finished vs interrupted, status only when headers were sent (ADR-0007).
module.exports = {
  title: 'access log: termination and status',
  tests: ['test/lifecycle.test.js', 'test/sink.test.js'],
  mutations: [
    { name: 'no check for a response already destroyed at entry', file: 'src/index.js', from: '  if (res.destroyed) {\n    setImmediate(listener, false)\n    return\n  }\n', to: '' },
    { name: 'no close listener', file: 'src/index.js', from: "  res.once('close', () => {\n    if (done) return\n    done = true\n    listener(false)\n  })\n", to: '' },
    { name: 'close without finish reported as finished', file: 'src/index.js', from: '    done = true\n    listener(false)\n  })', to: '    done = true\n    listener(true)\n  })' },
    { name: 'already-destroyed response reported as finished', file: 'src/index.js', from: 'setImmediate(listener, false)', to: 'setImmediate(listener, true)' },
    { name: 'status reported even when headers were never sent', file: 'src/index.js', from: 'status: headersSent ? res.statusCode : null', to: 'status: res.statusCode' },
    {
      name: 'per-response logged flag removed',
      file: 'src/index.js',
      from: '    if (state.logged) return\n',
      to: '',
      equivalent: 'onResponseEnd already calls the listener at most once (its own done flag); the logged flag is belt-and-braces'
    }
  ]
}
