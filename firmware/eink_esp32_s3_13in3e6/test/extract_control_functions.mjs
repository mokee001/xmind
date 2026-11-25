import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Compile the actual orchestration bodies with native I/O doubles, not a second
// implementation of setup/loop. Fail closed if a selected definition disappears.
const [sourcePath, harnessPath, outputPath] = process.argv.slice(2);
const source = readFileSync(sourcePath, 'utf8');
const functions = [
  'void clearConfigurationIfRequested(',
  'bool hasWifiConfiguration(',
  'bool waitForNetworkRetry(',
  'bool connectWifi(',
  '[[noreturn]] void restartWithIntent(',
  '[[noreturn]] void enterButtonStandby(',
  'bool localFrameBusy(',
  '[[noreturn]] void restartAfterTransaction(',
  'void handleShortPress(',
  'void handleButtonAtIdle(',
  'void restartInProvisioningMode(',
  'void updateCloudClaimSound(',
  'void setup(',
  'void loop(',
];

function maskLiteralsAndComments(text) {
  const masked = text.split('');
  const blank = (start, end) => {
    for (let index = start; index < end; ++index) if (text[index] !== '\n') masked[index] = ' ';
  };
  for (let index = 0; index < text.length; ++index) {
    const start = index;
    if (text.startsWith('//', index)) {
      const end = text.indexOf('\n', index);
      index = end === -1 ? text.length : end;
    } else if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      if (end === -1) throw new Error('Unterminated block comment');
      index = end + 2;
    } else if (text.startsWith('R"', index)) {
      const open = text.indexOf('(', index + 2);
      const delimiter = text.slice(index + 2, open);
      if (open === -1 || delimiter.length > 16) throw new Error('Invalid raw literal');
      const close = `)${delimiter}"`;
      const end = text.indexOf(close, open + 1);
      if (end === -1) throw new Error('Unterminated raw literal');
      index = end + close.length;
    } else if (text[index] === '"' || text[index] === "'") {
      const quote = text[index++];
      for (; index < text.length; ++index) {
        if (text[index] === '\\') ++index;
        else if (text[index] === quote) break;
      }
      if (index >= text.length) throw new Error('Unterminated literal');
      ++index;
    } else continue;
    blank(start, index);
    --index;
  }
  return masked.join('');
}

function definition(text, signature, path) {
  const code = maskLiteralsAndComments(text);
  const name = signature.match(/([\w:]+)\($/)[1];
  const starts = [...code.matchAll(new RegExp(`^(?:\\[\\[noreturn\\]\\]\\s+)?(?:bool|void)\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'gm'))];
  if (starts.length !== 1) throw new Error(`Expected one definition: ${name}`);
  const start = starts[0].index;
  const open = code.indexOf('{', start);
  let conditionalDepth = 0;
  for (const directive of code.slice(0, start).matchAll(/^\s*#\s*(if|ifdef|ifndef|endif)\b/gm)) {
    conditionalDepth += directive[1] === 'endif' ? -1 : 1;
  }
  if (conditionalDepth !== 0) throw new Error(`Conditional definition unsupported: ${name}`);
  let depth = 1;
  for (let index = open + 1; index < code.length; ++index) {
    const char = code[index];
    if (char === '{') ++depth;
    else if (char === '}' && --depth === 0) {
      if (/^\s*#/m.test(code.slice(open, index))) throw new Error(`Preprocessor in body unsupported: ${name}`);
      const line = text.slice(0, start).split('\n').length;
      return `#line ${line} ${JSON.stringify(path)}\n${text.slice(start, index + 1)}\n`;
    }
  }
  throw new Error(`Unterminated definition: ${signature}`);
}

// Guard the test seam itself: never silently select commented/inactive old code.
const fixture = '/* void setup() { old(); } */\nvoid setup(\n) { const char* text = "}"; live(); }';
if (!definition(fixture, 'void setup(', 'fixture').includes('live();')) throw new Error('Extractor self-test failed');
for (const fixture of [
  '#if 0\nvoid setup() { old(); }\n#endif\nvoid setup(\n) { live(); }',
  '#if 0\nvoid setup() { old(); }\n#endif',
  'void setup() {\n#if 0\nold();\n#endif\n}',
]) {
  let refused = false;
  try { definition(fixture, 'void setup(', 'fixture'); } catch { refused = true; }
  if (!refused) throw new Error('Extractor accepted an ambiguous/conditional definition');
}

const code = maskLiteralsAndComments(source);
const bleSuite = sourcePath.endsWith('/ble_provisioning.cpp');
const names = bleSuite ? ['kProofButton', 'kFrameVersion', 'kAdvertisingRestartDelayMs', 'kWifiConnectTimeoutMs', 'kRestartDelayMs'] :
  ['kFirmwareVersion', 'kBootButton', 'kDefaultPollIntervalMs', 'kWifiConnectTimeoutMs'];
const constants = names.map(name => {
  const matches = [...code.matchAll(new RegExp(`^constexpr [^\n]*\\b${name}[^\n]*;`, 'gm'))];
  if (matches.length !== 1) throw new Error(`Expected one constant: ${name}`);
  return source.slice(matches[0].index, matches[0].index + matches[0][0].length);
});
let harness = readFileSync(harnessPath, 'utf8');
function insert(marker, bodies) {
  if (harness.split(marker).length !== 2) throw new Error(`Expected one ${marker}`);
  harness = harness.replace(marker, () => `${bodies}\n#line 1 ${JSON.stringify(harnessPath)}`);
}
if (bleSuite) {
  const names = ['handleClientConnected', 'handleClientDisconnected', 'resetCommandFrame', 'handleCommandWrite',
    'confirmExternalClick', 'processCommand', 'startWifiConnection', 'processWifiConnection', 'completeCloudBootstrap', 'loop'];
  insert('// PHOTOWALL_BLE_BODIES', constants.join('\n') + '\n' + names.map(name =>
    definition(source, `void BleProvisioningService::${name}(`, sourcePath)).join('\n'));
  console.log(`Native BLE: executing ${names.length} production function bodies`);
} else {
  const bodies = `${constants.join('\n')}\n${functions.map(signature => definition(source, signature, sourcePath)).join('\n')}`;
  const powerPath = join(dirname(sourcePath), 'device_power.cpp');
  const power = readFileSync(powerPath, 'utf8');
  const energy = ['disableStandbyWake', 'waitForRelease', 'startButtonSampling', 'pollButtonsIfNeeded', 'waitForStandbyWake'];
  insert('// PHOTOWALL_POWER_BODIES', energy.map(name => definition(power, `void ${name}(`, powerPath)).join('\n'));
  insert('// PHOTOWALL_CONTROL_BODIES', bodies);
  console.log(`Native controls: executing ${functions.length + energy.length} production function bodies`);
}
writeFileSync(outputPath, harness);
