/* eslint-env node */

/*come sense testing*/

/*update from master*/
module.exports = {
  testURL: 'http://localhost:4000/api',
  testMatch: ['**/@pollyjs/*/build/jest/*.js'],
  roots: ['<rootDir>/packages/@pollyjs'],
  reporters: ['jest-tap-reporter']
};
