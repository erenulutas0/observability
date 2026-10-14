'use strict'

// Guards the test matrix: `npm test` must exercise Express 4 and `npm run test:express5` must exercise Express 5.
test('the tests load the Express major version this run is meant to cover', () => {
  const expected = process.env.EXPECT_EXPRESS_MAJOR ?? '4'
  const loaded = require('express/package.json').version.split('.')[0]
  expect(loaded).toBe(expected)
})
