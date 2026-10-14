'use strict'

// Runs the whole test suite against Express 5: require('express') (and its package.json) in the tests resolve
// to the express5 dev dependency, an npm alias for express@5. Tests that depend on Express 4-only behaviour
// branch on the version they actually loaded; test/express-version.test.js fails if the mapping stops working.
process.env.EXPECT_EXPRESS_MAJOR = '5'

module.exports = {
  testEnvironment: 'node',
  moduleNameMapper: {
    '^express$': 'express5',
    '^express/package\.json$': 'express5/package.json'
  }
}
