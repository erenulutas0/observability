'use strict'

// ADR-0005 safety limits and the checks that rely on them.
module.exports = {
  title: 'doctor: safety limits and checks (ADR-0005)',
  tests: ['test/doctor.test.js'],
  mutations: [
    { name: 'remote target allowed without --allow-remote', file: 'src/doctor.js', from: 'if (!isLoopbackHost(target.hostname) && input.allowRemote !== true) {', to: 'if (false) {' },
    { name: 'loopback check accepts any name starting with 127.', file: 'src/doctor.js', from: '/^127\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$/.test(host)', to: '/^127\\./.test(host)' },
    { name: 'probes use POST', file: 'src/doctor.js', from: "{ method: 'GET', headers, agent: false }", to: "{ method: 'POST', headers, agent: false }" },
    { name: 'no identifying User-Agent', file: 'src/doctor.js', from: "    'User-Agent': `express-observe-doctor/${options.version}`,\n", to: '' },
    { name: 'three probes per path', file: 'src/doctor.js', from: "    plan.push({ name: 'path', path })\n    plan.push({ name: 'path', path })\n", to: "    plan.push({ name: 'path', path })\n    plan.push({ name: 'path', path })\n    plan.push({ name: 'path', path })\n" },
    { name: 'no limit on the number of paths', file: 'src/doctor.js', from: 'if (paths.length > MAX_PATHS)', to: 'if (false)' },
    { name: 'credentials in the target URL allowed', file: 'src/doctor.js', from: 'if (target.username || target.password) {', to: 'if (false) {' },
    { name: 'no response body cap', file: 'src/doctor.js', from: 'if (bytes > MAX_BODY_BYTES) res.destroy()', to: 'void 0' },
    { name: 'no hard per-request deadline', file: 'src/doctor.js', from: 'deadline = setTimeout(() => req.destroy(', to: 'deadline = null && setTimeout(() => req.destroy(' },
    { name: 'answered probe with cut body counted as no response', file: 'src/doctor.js', from: '      if (response !== null) finish(true)\n      else done(', to: '      done(' },
    { name: 'vacuous pass when nothing answered', file: 'src/doctor.js', from: '  if (answered.length === 0) {', to: '  if (false) {' },
    { name: 'duplicate log records ignored', file: 'src/doctor.js', from: "    if (n > 1) count.worse('fail'", to: "    if (false) count.worse('fail'" },
    { name: 'leaked markers ignored', file: 'src/doctor.js', from: 'if (log.markerHits > 0) {', to: 'if (false) {' },
    { name: 'raw URL as route ignored', file: 'src/doctor.js', from: 'if (record.route !== null && record.route.includes(p.randomSegment)) {', to: 'if (false) {' },
    { name: 'null route on success ignored', file: 'src/doctor.js', from: 'if (record.route === null && p.status < 400) {', to: 'if (false) {' },
    { name: 'repeated request IDs ignored', file: 'src/doctor.js', from: "if (seen.has(id)) unique.worse('fail'", to: "if (false) unique.worse('fail'" }
  ]
}
