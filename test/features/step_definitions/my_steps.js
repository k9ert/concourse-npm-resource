const { Given, Then, When, BeforeAll, Before, After, setDefaultTimeout } = require('cucumber');
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const mktemp = require('mktemp');

const npmUtil = require('./util/npm-registry');

setDefaultTimeout(30000);

const unitUnderTest = process.env['DOCKER_IMAGE'] || 'timotto/concourse-npm-resource:latest';

let testRegistry;
let credentials;
let basePath;

BeforeAll(async () => {
  basePath = path.join(process.env['TEMP'] || '/tmp', 'npm-resource-test-tmp');
  await fs.mkdirs(basePath);
  testRegistry = assertEnv('TEST_REGISTRY');
  credentials = {
    correct: assertEnv('CORRECT_CREDENTIALS'),
    incorrect: assertEnv('INCORRECT_CREDENTIALS'),
    empty: "",
    missing: undefined
  }
});

Before(async () => {
  this.tempDir = await mktemp.createDir(path.join(basePath, 'npm-resource-test-volume-XXXXXXXX'));
  this.testVolume = path.join(this.tempDir, 'test-volume');
  this.testHome = path.join(this.tempDir, 'root');
  await fs.mkdirs(this.testVolume);
  await fs.mkdirs(this.testHome);
  this.input = {};
});

After(async () => (process.env['NORMRF'] || 'false') === 'true' ? Promise.resolve() :
  fs.remove(this.tempDir));

Given(/^a source configuration for package "(.*)"$/, async packageName =>
  this.input.source = sourceDefinition(packageName));

Given(/^a source configuration with additional_registries for package "(.*)" with scope "(.*)" and registry "(.*)"$/, async (packageName, scope, registry) =>
  this.input.source = sourceDefinition(packageName, scope, {uri: registry}, [
    {uri: registry},
    {scope: scope, uri: registry}
  ]))

Given(/^a source configuration for (private|public) package "([^"]*)" with (correct|incorrect|empty|missing) credentials$/, async (privateOrPublic, packageName, credentialSet) =>
  this.input.source = sourceDefinition(packageName, undefined, { uri: privateOrPublic === 'private' ? testRegistry : undefined, token: credentials[credentialSet] }));

Given(/^a source configuration for private package "(.*)" scope "([^@].*)" with (correct|incorrect|empty|missing) credentials$/, async (privatePackageName, scope, credentialSet) =>
  this.input.source = sourceDefinition(privatePackageName, scope, { uri: testRegistry, token: credentials[credentialSet] }));

Given(/^a get step with skip_download: (true|false) params$/, skipDownload =>
  this.input.params = { skip_download: skipDownload === 'true' });

Given(/^a known version "(.*)" for the resource$/, version =>
  this.input.version = { version });

When(/^the resource is checked$/, async () =>
  runResource('check'));

When(/^the resource is fetched$/, async () =>
  runResource('in'));

Then(/^an error is returned$/, () =>
  assert.notEqual(this.result.code, 0, new Error(`expected an error but result code is 0\n${this.result.stdout}${this.result.stderr}`)));

Then(/^version "([^"]*)" is returned$/, expectedVersion => {
  assert.strictEqual(this.result.code, 0, new Error(`expected success but result code is ${this.result.code}\n${this.result.stderr}`));
  const j = JSON.parse(this.result.stdout);

  assert.notEqual(j, undefined, new Error(`expected stdout to contain JSON but is empty\n${this.result.stderr}`));
  const actualVersion = j.version !== undefined ? j.version.version : j[0] !== undefined ? j[0].version : undefined;

  assert.strictEqual(actualVersion, expectedVersion);
});

Then(/^the content of file "(.*)" is "(.*)"$/, async (filename, content) => {
  const expectedContent = `${content}\n`;
  const actualContent = await fs.readFile(path.join(this.testVolume, filename), 'utf-8');
  assert.strictEqual(actualContent, expectedContent);
});

Then(/^the file "(.*)" does exist$/, async filename =>
  assert.strictEqual(await findTempFile(filename), true));

Then(/^the file "(.*)" does not exist$/, async filename =>
  assert.strictEqual(await findTempFile(filename), false));

Then(/^the homedir file "(.*)" token is sanitized$/, async filename => {
  const expectedContent = /_authToken=xxxx[\n$]/;
  const unexpectedContent = new RegExp(`${credentials.correct}|${credentials.incorrect}`);
  const actualContent = await fs.readFile(path.join(this.testHome, filename), 'utf-8');
  console.log(actualContent);
  assert.match(actualContent, expectedContent);
  assert.doesNotMatch(actualContent, unexpectedContent, credentials);
});

Then(/^the homedir file "(.*)" has additional_registries with scope "(.*)" and registry "(.*)"$/, async (filename, scope, registry) => {
  const expectedContent = `registry=${registry}\\b\n@${scope}:registry=${registry}\\b`.replace(/[\.]/g, m => `\\${m}`);
  const actualContent = await fs.readFile(path.join(this.testHome, filename), 'utf-8');
  assert.match(actualContent, new RegExp(expectedContent));
});

Given(/^the registry has (a|no) package "(.*)" available in version "(.*)"$/, async (aOrNo, packageName, version) =>
  aOrNo === 'a'
    ? npmUtil.ensurePackageVersionAvailable(this.testVolume, testRegistry, credentials.correct, packageName, version)
    : npmUtil.ensurePackageVersionNotAvailable(testRegistry, credentials.correct, packageName, version));

Given(/^I have a put step with params package: "([^\"]*)"$/, packageName =>
  this.input.params = {
    path: 'source-code'
  });

Given(/^I have a put step with params package: "([^\"]*)" and delete: (true|false) and version: "(.*)"$/, async (packageName, isDelete, version) =>
  fs.writeFile(path.join(this.testVolume, 'version'), version)
    .then(() =>
      this.input.params = {
        path: 'source-code',
        delete: isDelete === 'true',
        version: 'version'
      }));

Given(/^I have (valid|invalid) npm package source code for package "(.*)" with version "([^"]*)"/, async (validOrInvalid, packageName, version) =>
  validOrInvalid === 'invalid' ? fs.mkdirs(path.join(this.testVolume, 'source-code')) :
    npmUtil.inventPackage(path.join(this.testVolume, 'source-code'), packageName, version,
      this.input.source.registry !== undefined
        ? this.input.source.registry.uri
        : undefined));


When(/^the package is published$/, async () =>
  runResource('out'));

Then(/^there should be (a|no) package "(.*)" available with version "(.*)" in the registry$/, async (aOrNo, packageName, wantedVersion) =>
  assert.strictEqual(
    await (npmUtil.getPackageVersions(testRegistry, credentials.correct, packageName)
      .then(versions => versions.filter(version => version === wantedVersion).length)),
    aOrNo === 'a' ? 1 : 0));

const findTempFile = async filename =>
  fs.pathExists(path.join(this.testVolume, filename));

const findHomeFile = async filename =>
  fs.pathExists(path.join(this.testHome, filename));

const sourceDefinition = (packageName, scope = undefined, registry = undefined, additional_registries = undefined) => ({
  package: packageName,
  scope,
  registry,
  additional_registries
});

const runResource = async command => 
  spawnIn('docker', [
    'run', '--rm', '-i',
    '-v', `${this.testVolume}:/test-volume`,
    '-v', `${this.testHome}:/root`,
    unitUnderTest,
    `/opt/resource/${command}`,
    '/test-volume'
  ], JSON.stringify(this.input))
    .then(result => this.result = result);

const spawnIn = async (command, args, input = undefined) =>
  new Promise(resolve => {
    const result = { stdout: "", stderr: "" };
    const x = spawn(command, args);
    x.stdout.on('data', data => result.stdout += data);
    x.stderr.on('data', data => result.stderr += data);
    x.on('exit', code => resolve(({ code, ...result })));
    if (input) {
      x.stdin.write(input);
      x.stdin.end();
    }
  });

const assertEnv = key => {
  if (process.env[key] === undefined) throw `${key} is undefined`;
  return process.env[key];
}
