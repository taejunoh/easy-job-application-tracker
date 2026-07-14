/** @type {import("jest").Config} */
const config = {
  preset: "ts-jest",
  testEnvironment: "node",
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    "^server-only$": "<rootDir>/__tests__/mocks/server-only.ts",
  },
  testMatch: ["**/__tests__/**/*.test.ts"],
};

module.exports = config;
